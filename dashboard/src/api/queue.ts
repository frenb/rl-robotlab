// Run lifecycle and the shared job queue.
//
// Statuses are the protocol between the dashboard and the workers:
//   NOT_STARTED      queued; the oldest one across robots runs next
//   IN_PROGRESS      a worker claimed it
//   PAUSE_REQUESTED  the worker checkpoints at the next iteration and sets PAUSED
//   PAUSED           resumable: back to NOT_STARTED resumes from the checkpoint
//   DONE / FAILED / CANCELLED   terminal; NOT_STARTED re-queues them
// The workers poll their job's status every iteration, so cancel and pause
// are just status writes (rl_agent/robotaxi.py _get_job_lifecycle_state,
// rl_agent/mjlab_core/worker.py).
import { summarize, Context } from './runs';

export interface ActionDef {
  label: string;
  /** Statuses the action applies to. */
  from: string[];
  to: string;
}

export const ACTIONS: { [name: string]: ActionDef } = {
  pause: { label: 'Pause', from: ['IN_PROGRESS'], to: 'PAUSE_REQUESTED' },
  resume: { label: 'Resume', from: ['PAUSED'], to: 'NOT_STARTED' },
  cancel: { label: 'Cancel', from: ['NOT_STARTED', 'IN_PROGRESS', 'PAUSE_REQUESTED'], to: 'CANCELLED' },
  restart: { label: 'Restart', from: ['DONE', 'FAILED', 'CANCELLED'], to: 'NOT_STARTED' },
  mark_done: { label: 'Mark done', from: ['NOT_STARTED', 'IN_PROGRESS', 'PAUSE_REQUESTED', 'PAUSED', 'FAILED', 'CANCELLED'], to: 'DONE' },
};

/** Running jobs can't be deleted; cancel them first so the worker lets go. */
export const DELETABLE = ['NOT_STARTED', 'DONE', 'FAILED', 'CANCELLED', 'PAUSED'];

export function actionsFor(status: string | null): string[] {
  return Object.keys(ACTIONS).filter((a) => ACTIONS[a].from.indexOf(String(status)) >= 0);
}

const HEARTBEAT_TTL_MS = 120 * 1000; // rl_agent/job_queue.py HEARTBEAT_TTL_S

/** When a job was queued, as rl_agent/job_queue.py created_at orders it. */
export function queuedAt(job: any): number {
  const v = job && job.create_date;
  const t = v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!isNaN(t)) return t;
  const id = String(job && job._id);
  return /^[0-9a-f]{24}$/i.test(id) ? parseInt(id.slice(0, 8), 16) * 1000 : 0;
}

export async function queuePaused(db: any): Promise<boolean> {
  const doc = await db.collection('queue_control').findOne({ _id: 'singleton' });
  return !!(doc && doc.paused);
}

/**
 * The global queue switch. Pausing also pauses running jobs (tagged
 * queue_auto_paused), and resuming re-queues only those, so jobs paused by
 * hand stay paused.
 */
export async function setQueuePaused(db: any, paused: boolean): Promise<{ paused?: number; resumed?: number }> {
  await db.collection('queue_control').updateOne(
    { _id: 'singleton' }, { $set: { paused, updated_at: new Date() } }, { upsert: true });
  const jobs = db.collection('jobs');
  if (paused) {
    const r = await jobs.updateMany(
      { status: 'IN_PROGRESS' }, { $set: { status: 'PAUSE_REQUESTED', queue_auto_paused: true } });
    return { paused: r ? r.modifiedCount : 0 };
  }
  const r = await jobs.updateMany(
    { queue_auto_paused: true }, { $set: { status: 'NOT_STARTED' }, $unset: { queue_auto_paused: '' } });
  return { resumed: r ? r.modifiedCount : 0 };
}

/** The shared queue in the order the workers will drain it, plus who is running and which workers are up. */
export async function queueState(ctx: Context) {
  const db = ctx.db();
  const [paused, active, workers] = await Promise.all([
    queuePaused(db),
    db.collection('jobs').find(
      { status: { $in: ['NOT_STARTED', 'IN_PROGRESS', 'PAUSE_REQUESTED'] } },
      { projection: { reward_design_code: 0, eval_results: 0, videos: 0, experiment_design_fields: 0 } },
    ).toArray(),
    db.collection('workers').find({}).toArray(),
  ]);
  const queued = active.filter((j: any) => j.status === 'NOT_STARTED')
    .sort((a: any, b: any) => queuedAt(a) - queuedAt(b));
  const now = Date.now();
  return {
    paused,
    running: active.filter((j: any) => j.status !== 'NOT_STARTED').map((j: any) => summarize(ctx, j)),
    queued: queued.map((j: any, i: number) => ({ position: i + 1, ...summarize(ctx, j) })),
    workers: ctx.robots().map((r) => {
      const w = workers.find((x: any) => x._id === r.id);
      const seen = w && w.last_seen ? new Date(w.last_seen).getTime() : null;
      return {
        robot: r.id,
        online: seen != null && now - seen < HEARTBEAT_TTL_MS,
        last_seen: seen != null ? new Date(seen).toISOString() : null,
      };
    }),
  };
}

/** Queue position (1 = next) of each queued job id. */
export function positions(queued: any[]): { [id: string]: number } {
  const out: { [id: string]: number } = {};
  queued.slice().sort((a, b) => queuedAt(a) - queuedAt(b)).forEach((j, i) => { out[String(j._id)] = i + 1; });
  return out;
}