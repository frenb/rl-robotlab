// Models for the app: list rows, eval summaries, spec compatibility, the
// leaderboard and curriculum gates. Pure functions except deleteModel.
import * as fs from 'fs';
import * as path from 'path';
import { evalSample, EvalSample } from './compare';
import { CAR } from './runs';

export type Better = 'higher' | 'lower' | null;

/** Car per-trial metrics (leaderboard_scores), in ranking-menu order. */
export const CAR_METRICS: { [key: string]: { label: string; better: Better } } = {
  avg_goals_per_episode: { label: 'Goals per episode', better: 'higher' },
  steps_per_goal: { label: 'Steps per goal', better: 'lower' },
  episode_counts: { label: 'Crashes per trial', better: 'lower' },
  returns: { label: 'Return', better: 'higher' },
  episode_lengths: { label: 'Episode length', better: 'higher' },
  avg_speeds: { label: 'Speed (m/s)', better: null },
};

/** mjlab EVAL aggregates (models.eval_results). */
export const MJLAB_METRICS: { [key: string]: { label: string; better: Better } } = {
  fall_rate: { label: 'Fall rate', better: 'lower' },
  mean_return: { label: 'Mean return', better: 'higher' },
  mean_episode_length: { label: 'Episode length', better: 'higher' },
  mean_reward_per_step: { label: 'Reward per step', better: 'higher' },
};

export const DEFAULT_METRIC = { car: 'avg_goals_per_episode', mjlab: 'fall_rate' };

// ---- spec compatibility (mirror of robotaxi.py _specs_compatible) ----

/** Observation width per course (collect_training_data.COURSE_OBSERVATION_SIZES). */
const COURSE_OBS_SIZES: { [course: string]: number } = { donut: 32, donut_no_hint: 31, fly_donut: 1314, fly_donut_flow: 1314 };
const COURSE_OBS_DICT: { [course: string]: any } = {
  donut_camera: { vector: { shape: [31], dtype: 'float32' }, image: { shape: [84, 84, 3], dtype: 'float32' } },
  donut_camera_no_rays: { vector: { shape: [2], dtype: 'float32' }, image: { shape: [84, 84, 3], dtype: 'float32' } },
};

export interface Compat {
  status: 'compatible' | 'incompatible' | 'unknown';
  reason: string;
}

function normalizeDtype(s: any): string {
  if (!s) return '';
  let t = String(s).trim().toLowerCase();
  if (t.indexOf("'") >= 0) {
    const m = t.split("'");
    if (m.length >= 2) t = m[1];
  }
  return t.replace(/^tf\./, '').replace(/^numpy\./, '').replace(/^np\./, '');
}

function isLeaf(s: any): boolean {
  return !!s && typeof s === 'object' && Object.prototype.hasOwnProperty.call(s, 'shape');
}

/** true / false, or null when either side is missing a piece. */
export function specsCompatible(a: any, b: any): boolean | null {
  if (!a || !b) return null;
  if (isLeaf(a) !== isLeaf(b)) return false;
  if (!isLeaf(a)) {
    const ak = Object.keys(a);
    if (ak.length !== Object.keys(b).length) return false;
    let unknown = false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      const r = specsCompatible(a[k], b[k]);
      if (r === false) return false;
      if (r === null) unknown = true;
    }
    return unknown ? null : true;
  }
  const as = a.shape || [];
  const bs = b.shape || [];
  if (as.length !== bs.length) return false;
  for (let i = 0; i < as.length; i++) {
    if (as[i] != null && bs[i] != null && as[i] !== bs[i]) return false;
  }
  const at = normalizeDtype(a.dtype);
  const bt = normalizeDtype(b.dtype);
  return !(at && bt && at !== bt);
}

export function formatSpec(s: any): string {
  if (!s) return 'unknown';
  if (!isLeaf(s)) return '{' + Object.keys(s).sort().map((k) => `${k}: ${formatSpec(s[k])}`).join(', ') + '}';
  const shape = s.shape == null ? '?' : `[${s.shape.join(', ')}]`;
  return `${shape} ${normalizeDtype(s.dtype) || '?'}`;
}

export function carCourse(model: any): string {
  return model.course_type && model.course_type !== 'trainer default' ? String(model.course_type) : 'donut';
}

/**
 * Whether an EVAL of this model can start: car checkpoints against the
 * observation of their own course (do_job builds the env from it); mjlab
 * checkpoints always load on their task, so it's whether an ONNX was exported.
 */
export function compat(model: any, mjlab: boolean, envSpecs: { [robotType: string]: any }): Compat {
  if (mjlab) {
    if (!model.onnx_location) return { status: 'unknown', reason: 'No ONNX export yet; TRAIN jobs export when they finish, or run Export.' };
    if (model.obs_dim == null || model.act_dim == null) {
      return { status: 'unknown', reason: `ONNX at ${model.onnx_location}, but no observation or action sizes were recorded.` };
    }
    return { status: 'compatible', reason: `ONNX exported and validated: observation [${model.obs_dim}] to action [${model.act_dim}].` };
  }
  if (!model.observation_spec || !model.action_spec) {
    return { status: 'unknown', reason: `The checkpoint record has no ${model.observation_spec ? 'action' : 'observation'} spec (an older model).` };
  }
  const env = envSpecs[String(model.robot_type || '')];
  const course = carCourse(model);
  const width = COURSE_OBS_SIZES[course];
  const dict = COURSE_OBS_DICT[course];
  if (width == null && !dict) {
    if (!env) return { status: 'unknown', reason: `Unknown course ${course} and no published env spec to check against.` };
    const o = specsCompatible(model.observation_spec, env.observation_spec);
    const a = specsCompatible(model.action_spec, env.action_spec);
    if (o === false || a === false) {
      return { status: 'incompatible', reason: `An EVAL would fail with EvalSpecMismatchError: model ${formatSpec(model.observation_spec)}, env ${formatSpec(env.observation_spec)}.` };
    }
    if (o === null || a === null) return { status: 'unknown', reason: 'Partial spec; cannot verify.' };
    return { status: 'compatible', reason: `Matches the live env (course ${course} has no recorded width).` };
  }
  const expectedObs = dict || { shape: [width], dtype: (model.observation_spec && model.observation_spec.dtype) || 'float32' };
  const expectedAct = env && env.action_spec ? env.action_spec : { shape: [2], dtype: (model.action_spec && model.action_spec.dtype) || 'float32' };
  const o = specsCompatible(model.observation_spec, expectedObs);
  const a = specsCompatible(model.action_spec, expectedAct);
  if (o === false || a === false) {
    const why: string[] = [];
    if (o === false) why.push(`observation ${formatSpec(model.observation_spec)}, course ${course} expects ${formatSpec(expectedObs)}`);
    if (a === false) why.push(`action ${formatSpec(model.action_spec)}, env expects ${formatSpec(expectedAct)}`);
    return { status: 'incompatible', reason: `An EVAL would fail with EvalSpecMismatchError: ${why.join('; ')}.` };
  }
  if (o === null || a === null) return { status: 'unknown', reason: 'Partial spec; cannot verify.' };
  return { status: 'compatible', reason: `Observation and action match course ${course}.` };
}

// ---- eval summaries ----

export interface Stats {
  n: number;
  mean: number;
  sd: number;
  median: number;
  min: number;
  max: number;
}

export function stats(xs: number[]): Stats | null {
  const n = xs.length;
  if (!n) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)) : 0;
  const s = xs.slice().sort((a, b) => a - b);
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { n, mean, sd, median, min: s[0], max: s[n - 1] };
}

/** Which car evals to pool: ordinary ones (main), one sweep stage, or all of them. */
export type StageFilter = 'main' | 'all' | number;

export function stageFilter(v: any): StageFilter {
  if (v === 'all') return 'all';
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 'main' : n;
}

function keep(sample: EvalSample, stage: StageFilter): boolean {
  if (stage === 'all') return true;
  if (stage === 'main') return sample.stage == null;
  return sample.stage === stage;
}

export function pooled(samples: EvalSample[], metric: string, stage: StageFilter): number[] {
  return samples.filter((s) => keep(s, stage)).flatMap((s) => s.trials[metric] || []);
}

export interface EvalSummary {
  /** Car: eval runs (one per sweep stage); mjlab: 1 once evaluated. */
  count: number;
  /** Car: pooled trials; mjlab: episodes. */
  trials: number;
  last_at: string | null;
  /** Car: pooled means over ordinary evals (sweep stages when there are none); mjlab: the aggregate. */
  metrics: { [key: string]: number };
  /** Car: sweep stages that were evaluated. */
  stages: number[];
}

function iso(v: any): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function evalSummary(model: any, mjlab: boolean, rows: any[]): EvalSummary | null {
  if (mjlab) {
    const r = model.eval_results;
    if (!r || typeof r !== 'object') return null;
    const metrics: { [key: string]: number } = {};
    for (const k of Object.keys(MJLAB_METRICS)) {
      const v = Number(r[k]);
      if (r[k] != null && isFinite(v)) metrics[k] = v;
    }
    return { count: 1, trials: Number(r.episodes) || 0, last_at: iso(model.eval_at), metrics, stages: [] };
  }
  if (!rows.length) return null;
  const samples = rows.map(evalSample);
  const stage: StageFilter = samples.some((s) => s.stage == null) ? 'main' : 'all';
  const metrics: { [key: string]: number } = {};
  for (const k of Object.keys(CAR_METRICS)) {
    const s = stats(pooled(samples, k, stage));
    if (s) metrics[k] = s.mean;
  }
  const last = rows.map((r) => iso(r.create_date)).filter(Boolean).sort().pop() || null;
  const stages = Array.from(new Set(samples.map((s) => s.stage).filter((s): s is number => s != null))).sort((a, b) => a - b);
  return {
    count: rows.length,
    trials: samples.filter((s) => keep(s, stage)).reduce((a, s) => a + (s.trials.returns || []).length, 0),
    last_at: last,
    metrics,
    stages,
  };
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
}

export interface ModelSummary {
  id: string;
  robot: string;
  label: string;
  location: string | null;
  run_id: string | null;
  created_at: string | null;
  iteration: number | null;
  model_type: string | null;
  /** Car course (donut when unset) or mjlab task. */
  course: string | null;
  task_id: string | null;
  avg_return: number | null;
  reward_design: { id: string | null; name: string | null; version: number | null } | null;
  experiment_design: { id: string | null; name: string | null; version: number | null } | null;
  onnx_location: string | null;
  obs_dim: number | null;
  act_dim: number | null;
  notes: string | null;
  promoted_at: string | null;
  /** The newest checkpoint of its run (models.is_global_best). */
  latest_of_run: boolean;
  eval: EvalSummary | null;
  compat: Compat;
}

function design(m: any, kind: 'reward' | 'experiment') {
  const id = m[`${kind}_design_id`];
  const name = m[`${kind}_design_name`];
  if (!id && !name) return null;
  const v = m[`${kind}_design_version`];
  return { id: id ? String(id) : null, name: name || null, version: typeof v === 'number' ? v : null };
}

const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : null);

/**
 * The training step a checkpoint was saved at. Car records carry the run's
 * budget in training_iterations; the step is in the path (<job>_step_<n>).
 */
export function checkpointIteration(m: any): number | null {
  const step = typeof m.location === 'string' ? /_step_(\d+)$/.exec(m.location) : null;
  return step ? Number(step[1]) : num(m.training_iterations);
}

export function modelSummary(m: any, mjlab: boolean, rows: any[], envSpecs: { [robotType: string]: any }): ModelSummary {
  const location = typeof m.location === 'string' ? m.location : null;
  // mjlab run folders are long timestamps; the task says more.
  const file = location ? location.split(/[\\/]/).filter(Boolean).pop() : '';
  const label = !location ? String(m._id) : mjlab && m.task_id ? `${m.task_id}/${file}` : basename(location);
  return {
    id: String(m._id),
    robot: m.robot || CAR,
    label,
    location,
    run_id: m.job_id ? String(m.job_id) : null,
    created_at: iso(m.create_date),
    iteration: checkpointIteration(m),
    model_type: m.model_type || null,
    course: mjlab ? m.task_id || null : carCourse(m),
    task_id: m.task_id || null,
    avg_return: num(m.avg_return),
    reward_design: design(m, 'reward'),
    experiment_design: design(m, 'experiment'),
    onnx_location: m.onnx_location || null,
    obs_dim: num(m.obs_dim),
    act_dim: num(m.act_dim),
    notes: m.notes && m.notes !== 'NA' ? String(m.notes) : null,
    promoted_at: iso(m.promoted_at),
    latest_of_run: !!m.is_global_best,
    eval: evalSummary(m, mjlab, rows),
    compat: compat(m, mjlab, envSpecs),
  };
}

/** leaderboard_scores rows that belong to a car model: by model_id, or by path for older rows. */
export function scoresByModel(models: any[], scores: any[]): { [id: string]: any[] } {
  const out: { [id: string]: any[] } = {};
  const byLocation: { [loc: string]: string } = {};
  for (const m of models) {
    out[String(m._id)] = [];
    if (typeof m.location === 'string') byLocation[m.location] = String(m._id);
  }
  for (const s of scores) {
    const id = s.model_id ? String(s.model_id) : s.path ? byLocation[s.path] : undefined;
    if (id && out[id]) out[id].push(s);
  }
  return out;
}

// ---- leaderboard ----

export interface Ranked {
  rank: number;
  model_id: string;
  stats: Stats;
  evals: number;
  last_at: string | null;
}

/** Ranks car models by a pooled per-trial metric. */
export function rankCar(models: any[], rowsById: { [id: string]: any[] }, metric: string, stage: StageFilter, minTrials: number): Ranked[] {
  const better = CAR_METRICS[metric] ? CAR_METRICS[metric].better : 'higher';
  const out: Ranked[] = [];
  for (const m of models) {
    const rows = rowsById[String(m._id)] || [];
    const samples = rows.map(evalSample);
    const s = stats(pooled(samples, metric, stage));
    if (!s || s.n < minTrials) continue;
    const used = rows.filter((_r, i) => keep(samples[i], stage));
    out.push({
      rank: 0, model_id: String(m._id), stats: s, evals: used.length,
      last_at: used.map((r) => iso(r.create_date)).filter(Boolean).sort().pop() || null,
    });
  }
  return finish(out, better);
}

/** Ranks mjlab models by an EVAL aggregate; n is the episode count. */
export function rankMjlab(models: any[], metric: string): Ranked[] {
  const better = MJLAB_METRICS[metric] ? MJLAB_METRICS[metric].better : 'higher';
  const out: Ranked[] = [];
  for (const m of models) {
    const r = m.eval_results;
    const v = r ? Number(r[metric]) : NaN;
    if (!r || r[metric] == null || !isFinite(v)) continue;
    out.push({
      rank: 0, model_id: String(m._id),
      stats: { n: Number(r.episodes) || 1, mean: v, sd: 0, median: v, min: v, max: v },
      evals: 1, last_at: iso(m.eval_at),
    });
  }
  return finish(out, better);
}

function finish(rows: Ranked[], better: Better): Ranked[] {
  const sign = better === 'lower' ? 1 : -1;
  rows.sort((a, b) => sign * (a.stats.mean - b.stats.mean) || b.stats.n - a.stats.n);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

// ---- curriculum gates ----

export interface GateResult {
  curriculum_run_id: string;
  curriculum_name: string | null;
  stage_index: number | null;
  stage_name: string | null;
  attempt: number | null;
  passed: boolean;
  checks: Array<{ metric: string; op: string; value: number; actual: number | null; passed: boolean }>;
  eval_job_id: string | null;
  train_job_id: string | null;
  at: string | null;
}

/** Gate outcomes of curriculum stages that trained this model or evaluated its checkpoint. */
export function gatesFor(model: any, curriculumRuns: any[]): GateResult[] {
  const out: GateResult[] = [];
  const runId = model.job_id ? String(model.job_id) : '';
  for (const cr of curriculumRuns) {
    for (const r of Array.isArray(cr.results) ? cr.results : []) {
      const mine = (runId && String(r.train_job_id || '') === runId) || (model.location && r.checkpoint === model.location);
      if (!mine || !Array.isArray(r.gate)) continue;
      out.push({
        curriculum_run_id: String(cr._id),
        curriculum_name: cr.curriculum_name || null,
        stage_index: typeof r.stage_index === 'number' ? r.stage_index : null,
        stage_name: r.stage_name || r.stage_id || null,
        attempt: typeof r.attempt === 'number' ? r.attempt : null,
        passed: !!r.passed,
        checks: r.gate.map((g: any) => ({
          metric: String(g.metric), op: String(g.op), value: Number(g.value),
          actual: g.actual == null ? null : Number(g.actual), passed: !!g.passed,
        })),
        eval_job_id: r.eval_job_id ? String(r.eval_job_id) : null,
        train_job_id: r.train_job_id ? String(r.train_job_id) : null,
        at: iso(r.at),
      });
    }
  }
  return out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

// ---- deletion ----

const SAVED_ROOT = '/saved_models';

/**
 * Removes a model's files (only under /saved_models; mjlab checkpoints in the
 * workers' trees stay), its leaderboard_scores, then the record itself.
 */
export async function deleteModel(db: any, model: any) {
  const location = typeof model.location === 'string' ? model.location.trim() : '';
  const out: { files_deleted: boolean; scores_deleted: number; file_error?: string } = { files_deleted: false, scores_deleted: 0 };
  if (location.startsWith(SAVED_ROOT + '/')) {
    const resolved = path.resolve(location);
    if (resolved.startsWith(SAVED_ROOT + path.sep) && resolved !== SAVED_ROOT) {
      try {
        if (fs.existsSync(resolved)) {
          fs.rmSync(resolved, { recursive: true, force: true });
          out.files_deleted = true;
        }
      } catch (e) {
        out.file_error = String((e as Error).message || e);
      }
    }
  }
  const or: any[] = [{ model_id: String(model._id) }, { model_id: model._id }];
  if (location) or.push({ path: location });
  const r = await db.collection('leaderboard_scores').deleteMany({ $or: or });
  out.scores_deleted = (r && r.deletedCount) || 0;
  await db.collection('models').deleteOne({ _id: model._id });
  return out;
}
