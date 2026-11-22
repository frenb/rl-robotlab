// Curricula and curriculum runs for the app. Writes that need the Python
// validator (create, update, start) stay on the classic routes in server.ts;
// run transitions live here and are shared with those routes.
import * as express from 'express';
import { HttpError, idFilter, intParam, iso, route } from './http';
import { CAR, Context, robotFilter, summarize, SUMMARY_PROJECTION } from './runs';

export const ACTIVE_RUN = ['RUNNING', 'CANCEL_REQUESTED'];
const RETRYABLE = ['FAILED_GATE', 'FAILED', 'CANCELLED'];
const ACTIVE_JOB = ['NOT_STARTED', 'IN_PROGRESS', 'PAUSE_REQUESTED', 'PAUSED'];
export const RUN_ACTIONS = ['cancel', 'retry', 'skip', 'delete'];
const CARRY_ITEMS = ['weights', 'optimizer', 'entropy', 'normalizer', 'replay', 'jsrl_guide'];
const GATE_OPS = ['>=', '>', '<=', '<', '=='];
const CURRICULUM_DEFAULTS = {
  enabled: false, budget_field: null, checkpoint_field: null, carry: [], carry_atomic: false,
  carry_same_task: false, early_stop: false, gate_metrics: [], stage_settings: {},
};
const MAX_RUNS_PAGE = 200;

/** The stage of a run's last result that a Skip would wave through, or why it can't. */
function skippable(run: any): { index: number } | { reason: string } {
  if (run.status !== 'FAILED_GATE') return { reason: 'only a run that missed a gate can skip it' };
  const stages = Array.isArray(run.stages) ? run.stages : [];
  if (run.stage_index + 1 >= stages.length) return { reason: 'the last stage has no next stage to move on to' };
  const results: any[] = Array.isArray(run.results) ? run.results : [];
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].stage_index === run.stage_index) {
      return results[i].checkpoint ? { index: i } : { reason: 'the missed attempt left no checkpoint to continue from' };
    }
  }
  return { reason: 'this stage has no finished attempt' };
}

export function runActions(run: any): string[] {
  const out: string[] = [];
  if (ACTIVE_RUN.indexOf(run.status) >= 0) out.push('cancel');
  if (RETRYABLE.indexOf(run.status) >= 0) out.push('retry');
  if ('index' in skippable(run)) out.push('skip');
  if (ACTIVE_RUN.indexOf(run.status) < 0) out.push('delete');
  return out;
}

/**
 * Cancel, retry, skip a missed gate, or delete a run. The runner picks up the
 * new status on its next tick (cancel also cancels the pending job here so
 * the GPU frees up at once).
 */
export async function applyRunAction(db: any, id: string, action: string, opts: { deleteJobs?: boolean } = {}) {
  const runs = db.collection('curriculum_runs');
  const run = await runs.findOne(idFilter(id));
  if (!run) throw new HttpError(404, `curriculum run ${id} not found`);
  const guard = { _id: run._id, status: run.status };
  const now = new Date();
  if (action === 'cancel') {
    if (ACTIVE_RUN.indexOf(run.status) < 0) throw new HttpError(409, `run is ${run.status}; only a running run can be cancelled`);
    await runs.updateOne({ _id: run._id, status: { $in: ACTIVE_RUN } }, { $set: { status: 'CANCEL_REQUESTED', updated_at: now } });
    if (run.pending && run.pending.job_id) {
      await db.collection('jobs').updateOne(
        { ...idFilter(String(run.pending.job_id)), status: { $in: ACTIVE_JOB } }, { $set: { status: 'CANCELLED' } });
    }
    return { ok: true, status: 'CANCEL_REQUESTED' };
  }
  if (action === 'retry') {
    // FAILED_GATE: one more attempt from the last attempt's checkpoint.
    // FAILED / CANCELLED: the same attempt again, as new jobs.
    const set: any = { status: 'RUNNING', pending: null, error: null, ended_at: null, updated_at: now };
    const update: any = { $set: set };
    if (run.status === 'FAILED_GATE') set.attempt = (run.attempt || 0) + 1;
    else if (run.status === 'FAILED' || run.status === 'CANCELLED') update.$inc = { generation: 1 };
    else throw new HttpError(409, `run is ${run.status}; only FAILED_GATE, FAILED or CANCELLED runs can be retried`);
    const r = await runs.updateOne(guard, update);
    if (!r.matchedCount) throw new HttpError(409, 'The run changed meanwhile; refresh and try again');
    return { ok: true, status: 'RUNNING' };
  }
  if (action === 'skip') {
    const s = skippable(run);
    if ('reason' in s) throw new HttpError(409, `Can't skip: ${s.reason}`);
    const r = await runs.updateOne(guard, { $set: {
      [`results.${s.index}.skipped`]: true, [`results.${s.index}.skipped_at`]: now,
      status: 'RUNNING', stage_index: run.stage_index + 1, attempt: 0, pending: null, error: null, ended_at: null, updated_at: now,
    } });
    if (!r.matchedCount) throw new HttpError(409, 'The run changed meanwhile; refresh and try again');
    return { ok: true, status: 'RUNNING' };
  }
  if (action === 'delete') {
    if (ACTIVE_RUN.indexOf(run.status) >= 0) throw new HttpError(409, 'cancel the run before deleting it');
    let jobsDeleted = 0;
    if (opts.deleteJobs) {
      jobsDeleted = (await db.collection('jobs').deleteMany({ curriculum_run_id: String(run._id) })).deletedCount || 0;
    }
    await runs.deleteOne({ _id: run._id });
    return { ok: true, jobs_deleted: jobsDeleted };
  }
  throw new HttpError(400, `action must be one of ${RUN_ACTIONS.join(', ')}`);
}

function capabilities(robot: any) {
  const block = (robot && robot.curriculum) || {};
  const out: any = { ...CURRICULUM_DEFAULTS, ...block };
  // Specs that aren't objects come from a manifest the parser misread; drop them rather than mislabel.
  const settings: any = {};
  for (const k of Object.keys(out.stage_settings || {})) {
    if (out.stage_settings[k] && typeof out.stage_settings[k] === 'object') settings[k] = out.stage_settings[k];
  }
  out.stage_settings = settings;
  return out;
}

function stageBrief(s: any) {
  return { id: s.id || null, name: s.name || null, gym: s.gym || null, budget: typeof s.budget === 'number' ? s.budget : null, gated: !!(s.gate && s.gate.conditions && s.gate.conditions.length) };
}

function curriculumSummary(c: any) {
  const stages = Array.isArray(c.resolved_stages) ? c.resolved_stages : Array.isArray(c.stages) ? c.stages : [];
  return {
    id: String(c._id),
    robot: c.robot || CAR,
    name: c.name || null,
    description: c.description || '',
    version: typeof c.version === 'number' ? c.version : 1,
    archived: !!c.archived,
    author: c.author || null,
    stage_count: stages.length,
    stages: stages.map(stageBrief),
    created_at: iso(c.created_at),
    updated_at: iso(c.updated_at),
  };
}

/** Stages that have a passed (or skipped) result; a stage passes at most once per run. */
function doneStages(run: any): number {
  const seen: { [i: number]: boolean } = {};
  for (const r of run.results || []) if (r.passed || r.skipped) seen[r.stage_index] = true;
  return Object.keys(seen).length;
}

function runSummary(ctx: Context, run: any, pendingJob: any) {
  const stages = Array.isArray(run.stages) ? run.stages : [];
  const n = stages.length || 1;
  const index = typeof run.stage_index === 'number' ? run.stage_index : 0;
  const done = doneStages(run);
  let current = 0;
  if (run.status === 'RUNNING' && pendingJob) {
    const gated = !!(stages[index] && stages[index].gate);
    const pct = typeof pendingJob.percent_complete === 'number' ? pendingJob.percent_complete / 100 : 0;
    current = run.pending && run.pending.role === 'eval' ? 0.95 : pct * (gated ? 0.9 : 1);
  }
  const results: any[] = run.results || [];
  const last = results.length ? results[results.length - 1] : null;
  return {
    id: String(run._id),
    curriculum_id: run.curriculum_id ? String(run.curriculum_id) : null,
    curriculum_name: run.curriculum_name || null,
    curriculum_version: typeof run.curriculum_version === 'number' ? run.curriculum_version : null,
    robot: run.robot || CAR,
    status: run.status || null,
    stage_index: index,
    stage_count: stages.length,
    stage_name: stages[index] ? stages[index].name || stages[index].id : null,
    attempt: run.attempt || 0,
    generation: run.generation || 0,
    error: run.error || null,
    created_at: iso(run.created_at),
    updated_at: iso(run.updated_at),
    ended_at: iso(run.ended_at),
    stages_done: done,
    progress: run.status === 'PASSED' ? 1 : Math.min(1, (done + current) / n),
    pending: run.pending ? { role: run.pending.role || null, job_id: run.pending.job_id ? String(run.pending.job_id) : null } : null,
    current_job: pendingJob ? summarize(ctx, pendingJob) : null,
    last_gate: last && Array.isArray(last.gate) && last.gate.length
      ? { stage_index: last.stage_index, passed: !!last.passed, skipped: !!last.skipped, checks: last.gate } : null,
    actions: runActions(run),
  };
}

function resultView(r: any) {
  return {
    stage_index: r.stage_index,
    stage_id: r.stage_id || null,
    stage_name: r.stage_name || null,
    attempt: r.attempt || 0,
    train_job_id: r.train_job_id ? String(r.train_job_id) : null,
    eval_job_id: r.eval_job_id ? String(r.eval_job_id) : null,
    checkpoint: r.checkpoint || null,
    metrics: r.metrics && typeof r.metrics === 'object' ? r.metrics : null,
    gate: Array.isArray(r.gate) ? r.gate : [],
    passed: !!r.passed,
    skipped: !!r.skipped,
    at: iso(r.at),
  };
}

export function mountCurricula(api: express.Router, ctx: Context, db: () => any) {
  const robots = () => ctx.robots();

  const pendingJobs = async (runs: any[]) => {
    const ids = runs.map((r) => r.pending && r.pending.job_id).filter(Boolean).map(String);
    if (!ids.length) return {} as { [id: string]: any };
    const rows = await db().collection('jobs').find({ $or: ids.map((id) => idFilter(id)) }, { projection: SUMMARY_PROJECTION }).toArray();
    const out: { [id: string]: any } = {};
    rows.forEach((j: any) => { out[String(j._id)] = j; });
    return out;
  };

  const summaries = async (runs: any[]) => {
    const jobs = await pendingJobs(runs);
    return runs.map((r) => runSummary(ctx, r, r.pending && r.pending.job_id ? jobs[String(r.pending.job_id)] : null));
  };

  // What each robot's curricula may use: budget unit, carry rules, gate metrics, stage settings.
  api.get('/curricula/capabilities', route(async () => {
    const out: any = {};
    robots().forEach((r) => { out[r.id] = capabilities(r); });
    return { robots: out, carry_items: CARRY_ITEMS, ops: GATE_OPS };
  }));

  api.get('/curricula', route(async (req) => {
    const robotId = String(req.query.robot || '');
    const and: any[] = [];
    if (robotId) and.push(robotFilter(robotId));
    if (req.query.archived !== '1') and.push({ archived: { $ne: true } });
    const rows = await db().collection('curricula').find(and.length ? { $and: and } : {}).sort({ updated_at: -1, _id: -1 }).toArray();
    const ids = rows.map((c: any) => String(c._id));
    const runs = ids.length
      ? await db().collection('curriculum_runs').find({ curriculum_id: { $in: ids } }, { projection: { stages: 0, results: 0 } })
        .sort({ created_at: -1, _id: -1 }).toArray()
      : [];
    const byCurriculum: { [id: string]: any[] } = {};
    runs.forEach((r: any) => { (byCurriculum[String(r.curriculum_id)] = byCurriculum[String(r.curriculum_id)] || []).push(r); });
    return {
      items: rows.map((c: any) => {
        const mine = byCurriculum[String(c._id)] || [];
        const last = mine[0];
        return {
          ...curriculumSummary(c),
          runs: { total: mine.length, active: mine.filter((r) => ACTIVE_RUN.indexOf(r.status) >= 0).length },
          last_run: last ? { id: String(last._id), status: last.status || null, created_at: iso(last.created_at), stage_index: last.stage_index || 0 } : null,
        };
      }),
    };
  }));

  api.get('/curricula/:id', route(async (req) => {
    const c = await db().collection('curricula').findOne(idFilter(req.params.id));
    if (!c) throw new HttpError(404, `no curriculum ${req.params.id}`);
    const runs = await db().collection('curriculum_runs').find({ curriculum_id: String(c._id) })
      .sort({ created_at: -1, _id: -1 }).limit(50).toArray();
    return {
      curriculum: { ...curriculumSummary(c), authored: Array.isArray(c.stages) ? c.stages : [], resolved: Array.isArray(c.resolved_stages) ? c.resolved_stages : [] },
      runs: await summaries(runs),
    };
  }));

  api.get('/curriculum-runs', route(async (req) => {
    const and: any[] = [];
    const robotId = String(req.query.robot || '');
    if (robotId) and.push(robotFilter(robotId));
    if (req.query.curriculum) and.push({ curriculum_id: String(req.query.curriculum) });
    if (req.query.active === '1') and.push({ status: { $in: ACTIVE_RUN } });
    const filter = and.length ? { $and: and } : {};
    const limit = intParam(req.query.limit, 20, 1, MAX_RUNS_PAGE);
    const coll = db().collection('curriculum_runs');
    const [rows, total] = await Promise.all([
      coll.find(filter).sort({ created_at: -1, _id: -1 }).limit(limit).toArray(),
      coll.countDocuments(filter),
    ]);
    return { items: await summaries(rows), total };
  }));

  api.get('/curriculum-runs/:id', route(async (req) => {
    const run = await db().collection('curriculum_runs').findOne(idFilter(req.params.id));
    if (!run) throw new HttpError(404, `no curriculum run ${req.params.id}`);
    const [jobs, curriculum] = await Promise.all([
      db().collection('jobs').find({ curriculum_run_id: String(run._id) }, { projection: SUMMARY_PROJECTION })
        .sort({ create_date: 1, _id: 1 }).toArray(),
      run.curriculum_id ? db().collection('curricula').findOne(idFilter(String(run.curriculum_id)), { projection: { version: 1, archived: 1, name: 1 } }) : null,
    ]);
    const pending = run.pending && run.pending.job_id ? jobs.find((j: any) => String(j._id) === String(run.pending.job_id)) : null;
    const skip = skippable(run);
    return {
      run: {
        ...runSummary(ctx, run, pending || null),
        stages: Array.isArray(run.stages) ? run.stages : [],
        options: run.options || {},
        results: (run.results || []).map(resultView),
        skip_reason: 'reason' in skip ? skip.reason : null,
      },
      jobs: jobs.map((j: any) => ({
        ...summarize(ctx, j),
        stage_index: typeof j.curriculum_stage_index === 'number' ? j.curriculum_stage_index : null,
        attempt: typeof j.curriculum_attempt === 'number' ? j.curriculum_attempt : 0,
        // Manual retries of a failed or cancelled run requeue the attempt as a new generation (runner.job_key).
        generation: Number((/:g(\d+)$/.exec(String(j.curriculum_key || '')) || [])[1] || 0),
        role: j.curriculum_role || (j.job_type === 'EVAL' ? 'eval' : 'train'),
        handoff: j.handoff || null,
      })),
      curriculum: curriculum ? { id: String(curriculum._id), name: curriculum.name || null, version: curriculum.version || 1, archived: !!curriculum.archived } : null,
    };
  }));

  api.post('/curriculum-runs/:id/actions', route(async (req) => {
    const body = req.body || {};
    return applyRunAction(db(), req.params.id, String(body.action || ''), { deleteJobs: !!body.delete_jobs });
  }));
}
