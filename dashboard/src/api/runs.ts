// Maps a job document to what the app shows for it: a summary row, its event
// files, its log and its media. Works off the robots registry, so a newly
// registered mjlab robot needs no code here.
import * as fs from 'fs';
import * as path from 'path';
import { archivedLogPath, CAR_TRAINER_LOG, openSpan } from './carlogs';
import { EventSource } from './metrics';
import { actionsFor, DELETABLE } from './queue';

export interface Robot {
  id: string;
  display_name?: string;
  engine?: string;
  badge_color?: string;
  iter_label?: string;
  media_prefix?: string;
  saved_models_subdir?: string;
  supports?: { [k: string]: boolean };
  default_job_types?: string[];
  course_label?: string;
  curriculum?: { checkpoint_field?: string | null; budget_field?: string };
}

export interface Context {
  db(): any;
  robots(): Robot[];
  /** [stored path prefix, local dir] pairs, as used by /media. */
  mediaRoots(): Array<[string, string]>;
  /** The gym each Unity client supervisor should run, by actor index ('*' = all). */
  desiredGyms?(): { [index: string]: any };
}

export const CAR = 'roboracer';
const CAR_ACTIVE = '/tmp/active';
const CAR_ARCHIVE = '/tmp/jobsdata';
/** Car run subfolders that hold checkpoints and buffers, never event files we want. */
const CAR_SKIP_DIRS: { [name: string]: boolean } = { policies: true, reverb_checkpoint: true, checkpoints: true };
const EVENT_FILE = /^events\.out\.tfevents\./;

export function robotOf(job: any): string {
  return (job && job.robot) || CAR;
}

export function robotFilter(robot: string): any {
  return robot === CAR ? { $or: [{ robot: { $exists: false } }, { robot: CAR }] } : { robot };
}

function robotInfo(ctx: Context, id: string): Robot | undefined {
  return ctx.robots().find((r) => r && r.id === id);
}

export function isMjlab(ctx: Context, id: string): boolean {
  const r = robotInfo(ctx, id);
  return r ? r.engine === 'mjlab_rsl_rl' : id !== CAR;
}

/** Prefix of an mjlab robot's per-job fields: openbeni_checkpoint -> "openbeni". */
function fieldPrefix(ctx: Context, robot: string): string {
  const field = robotInfo(ctx, robot)?.curriculum?.checkpoint_field;
  return field ? field.replace(/_checkpoint$/, '') : robot === 'microduck' ? 'duck' : robot;
}

function runDirs(ctx: Context, job: any): string[] {
  const own = job[`${fieldPrefix(ctx, robotOf(job))}_run_dirs`];
  if (Array.isArray(own)) return own;
  const key = Object.keys(job).find((k) => /_run_dirs$/.test(k) && Array.isArray(job[k]));
  return key ? job[key] : [];
}

/** A trainer-side path (e.g. /openbeni_rl/logs/...) as this container sees it, or null. */
export function localPath(ctx: Context, stored: string): string | null {
  if (!stored) return null;
  const match = ctx.mediaRoots().find(([prefix]) => stored.startsWith(prefix));
  if (!match) return null;
  const [prefix, root] = match;
  const resolved = path.resolve(root, stored.slice(prefix.length));
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

function iteration(ctx: Context, job: any): number | null {
  const v = job[`${fieldPrefix(ctx, robotOf(job))}_iteration`];
  if (typeof v === 'number') return v;
  return typeof job.training_steps === 'number' ? job.training_steps : null;
}

function budget(job: any): number | null {
  const v = job.max_iterations != null ? job.max_iterations : job.num_iterations;
  return typeof v === 'number' ? v : null;
}

function iso(v: any): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function summarize(ctx: Context, job: any) {
  return {
    id: String(job._id),
    robot: robotOf(job),
    name: job.name || null,
    job_type: job.job_type || null,
    status: job.status || null,
    created_at: iso(job.create_date),
    started_at: iso(job.started_at),
    ended_at: iso(job.ended_at),
    percent_complete: typeof job.percent_complete === 'number' ? job.percent_complete : null,
    iteration: iteration(ctx, job),
    budget: budget(job),
    gym_name: job.gym_name || null,
    task_id: job.task_id || null,
    reward_design_name: job.reward_design_name || null,
    experiment_design_name: job.experiment_design_name || null,
    curriculum_name: job.curriculum_name || null,
    curriculum_stage_name: job.curriculum_stage_name || null,
    mean_reward: typeof job.mean_reward === 'number' ? job.mean_reward : null,
    mean_episode_length: typeof job.mean_episode_length === 'number' ? job.mean_episode_length : null,
    error: lastLine(job.error || job.eval_error),
    curriculum_run_id: job.curriculum_run_id ? String(job.curriculum_run_id) : null,
    cloned_from: job.cloned_from ? String(job.cloned_from) : null,
    actions: actionsFor(job.status || null),
    deletable: DELETABLE.indexOf(job.status) >= 0,
  };
}

/** A traceback's last line ("ValueError: ...") is what a list row has room for. */
function lastLine(text: any): string | null {
  if (!text) return null;
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  return last.length > 300 ? last.slice(0, 297) + '...' : last;
}

/** Fields the runs list needs; keeps big ones (reward code, eval results) off the wire. */
export const SUMMARY_PROJECTION = {
  reward_design_code: 0, eval_results: 0, videos: 0, experiment_design_fields: 0, stage_settings: 0,
};

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch (e) {
    return false;
  }
}

async function eventFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(dir)).filter((f) => EVENT_FILE.test(f)).sort();
  } catch (e) {
    return [];
  }
}

/** Where a car job's folder is now: live in /tmp/active, then archived to /tmp/jobsdata. */
async function carBase(id: string): Promise<string | null> {
  for (const dir of [path.join(CAR_ACTIVE, id), path.join(CAR_ARCHIVE, id, id), path.join(CAR_ARCHIVE, id)]) {
    if (await isDir(dir)) return dir;
  }
  return null;
}

async function carSources(id: string): Promise<EventSource[]> {
  const base = await carBase(id);
  if (!base) return [];
  const out: EventSource[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    const dir = rel ? path.join(base, rel) : base;
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch (e) {
      return;
    }
    for (const name of names.sort()) {
      const child = rel ? `${rel}/${name}` : name;
      if (EVENT_FILE.test(name)) {
        out.push({ key: `${id}:${child}`, path: path.join(base, child), prefix: rel ? `${rel}/` : '' });
      } else if (depth < 3 && !CAR_SKIP_DIRS[name] && await isDir(path.join(dir, name))) {
        await walk(child, depth + 1);
      }
    }
  };
  await walk('', 0);
  return out;
}

const sourceCache: { [id: string]: { at: number; sources: EventSource[] } } = Object.create(null);
const SOURCE_TTL_MS = 10000;

/** The event files behind a run's curves. */
export async function eventSources(ctx: Context, job: any): Promise<EventSource[]> {
  const id = String(job._id);
  const hit = sourceCache[id];
  if (hit && Date.now() - hit.at < SOURCE_TTL_MS) return hit.sources;
  let sources: EventSource[] = [];
  if (isMjlab(ctx, robotOf(job))) {
    for (const stored of runDirs(ctx, job)) {
      const dir = localPath(ctx, String(stored));
      if (!dir) continue;
      for (const f of await eventFiles(dir)) {
        sources.push({ key: `${id}:${path.basename(dir)}/${f}`, path: path.join(dir, f), prefix: '' });
      }
    }
  } else {
    sources = await carSources(id);
  }
  sourceCache[id] = { at: Date.now(), sources };
  return sources;
}

export interface LogFile {
  path: string | null;
  /** The run's output starts at this offset of `path` (the car's shared trainer log). */
  floor: number;
  /** Shown next to the log, e.g. that the car log is shared by every car job. */
  note: string | null;
}

export async function logFile(ctx: Context, job: any): Promise<LogFile> {
  if (isMjlab(ctx, robotOf(job))) {
    const p = localPath(ctx, String(job.log_path || ''));
    return p ? { path: p, floor: 0, note: null } : { path: null, floor: 0, note: 'This job has no log file.' };
  }
  const id = String(job._id);
  const running = job.status === 'IN_PROGRESS' || job.status === 'PAUSE_REQUESTED';
  const span = await openSpan(ctx, id);
  if (running && span && span.start != null) {
    return {
      path: CAR_TRAINER_LOG,
      floor: span.start,
      note: span.partial ? 'The start of this run\u2019s output is no longer in the trainer log.' : null,
    };
  }
  if (running) return { path: CAR_TRAINER_LOG, floor: 0, note: 'Car trainer log (shared by all car jobs).' };
  if (await fileExists(archivedLogPath(id))) return { path: archivedLogPath(id), floor: 0, note: null };
  return { path: null, floor: 0, note: 'This car run finished before the dashboard kept per-run logs.' };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch (e) {
    return false;
  }
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether OpenBeni's trainer has turned jump training on for this run, from the
 * files it writes in the run folder: jump_transition.json once jumps are on, and
 * curriculum/recovery_<update>.json for each recovery check before that. Null
 * for runs without either (other robots and tasks).
 */
export function jumpStatus(ctx: Context, job: any) {
  const dirs = runDirs(ctx, job).map((d) => localPath(ctx, d)).filter((d): d is string => !!d);
  for (const dir of [...dirs].reverse()) {
    const t = readJson(path.join(dir, 'jump_transition.json'));
    if (t && typeof t.start_iteration === 'number') {
      return { enabled: true, since_update: t.start_iteration, reason: t.transition_reason || null, last_check: null };
    }
  }
  let latest: { update: number; file: string } | null = null;
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(dir, 'curriculum'));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^recovery_(\d+)\.json$/.exec(name);
      if (m && (!latest || Number(m[1]) >= latest.update)) latest = { update: Number(m[1]), file: path.join(dir, 'curriculum', name) };
    }
  }
  if (!latest) return null;
  const check = readJson(latest.file);
  if (!check) return null;
  const failing = Object.entries(check.scenarios || {})
    .filter(([name, row]: [string, any]) => !name.includes('/') && row && row.passed === false)
    .map(([name, row]: [string, any]) => ({ name, success_rate: typeof row.success_rate === 'number' ? row.success_rate : null }))
    .sort((a, b) => (a.success_rate ?? 0) - (b.success_rate ?? 0));
  return {
    enabled: false, since_update: null, reason: null,
    last_check: {
      update: latest.update, passed: !!check.passed,
      consecutive_passes: typeof check.consecutive_passes === 'number' ? check.consecutive_passes : null,
      failing,
    },
  };
}

export function mediaUrl(stored: string): string {
  return '/media?path=' + encodeURIComponent(stored);
}

export function media(job: any) {
  const clips = (Array.isArray(job.videos) ? job.videos : [])
    .filter((v: any) => v && typeof v.path === 'string')
    .map((v: any) => ({
      iteration: typeof v.iteration === 'number' ? v.iteration : null,
      url: mediaUrl(v.path),
      gif_url: typeof v.gif === 'string' ? mediaUrl(v.gif) : null,
    }))
    .sort((a: any, b: any) => (a.iteration || 0) - (b.iteration || 0));
  const progress = typeof job.progress_video === 'string' ? job.progress_video : null;
  return {
    progress_video: progress ? mediaUrl(progress) : null,
    progress_gif: typeof job.progress_gif === 'string' ? mediaUrl(job.progress_gif) : null,
    clips,
  };
}
