// What the Compare page needs beyond curves: each run's settings, flattened so
// two runs can be diffed key by key, and the eval results of the models they trained.

export type ConfigValue = string | number | boolean | null;

export interface ConfigSection {
  title: string;
  values: { [key: string]: ConfigValue };
}

/** Per-trial arrays a car EVAL writes to leaderboard_scores (robotaxi.py save_results_to_db). */
export const TRIAL_METRICS = [
  'returns', 'episode_lengths', 'avg_goals_per_episode', 'avg_speeds', 'avg_steering_angle_ratios', 'episode_counts',
];

/** Aggregates an mjlab EVAL writes to models.eval_results; it keeps no per-trial samples. */
export const AGGREGATE_METRICS = ['mean_return', 'mean_episode_length', 'fall_rate', 'mean_reward_per_step', 'episodes'];

export interface EvalSample {
  stage: number | null;
  created_at: string | null;
  trials: { [metric: string]: number[] };
}

export interface ModelEval {
  id: string;
  run_id: string | null;
  robot: string;
  label: string;
  location: string | null;
  iteration: number | null;
  created_at: string | null;
  /** The training-time return the trainer stamped on the checkpoint. */
  avg_return: number | null;
  samples: EvalSample[];
  aggregate: { [metric: string]: number } | null;
}

/** Fields that describe what a run did or produced rather than how it was set up. */
const RUN_STATE = [
  '_id', 'status', 'create_date', 'started_at', 'ended_at', 'percent_complete', 'training_steps', 'mean_reward',
  'mean_episode_length', 'error', 'eval_error', 'log_path', 'paused_at_step', 'progress_gif', 'videos', 'eval_results',
  'queue_auto_paused', 'cloned_from', 'curriculum_key', 'curriculum_run_id', 'curriculum_id', 'curriculum_stage_id',
  'curriculum_attempt', 'curriculum_role', 'curriculum_stage_index', 'gym_id', 'gym_file_path', 'reward_design_id',
  'experiment_design_id', 'demo_id', 'demo_job_id', 'demo_job_ids', 'demo_tfrecords_paths', 'default_demo_job_id',
  'robot_type', 'pass_through_actions', 'percent_complete_eval',
];
/** Per-robot outputs: openbeni_checkpoint, duck_iteration, openbeni_run_dirs... (init_checkpoint is an input). */
const OUTPUT_FIELD = /^(?!init_)[a-z]+_(checkpoint|iteration|run_dirs)$/;
const DESIGN_META = ['_id', 'name', 'description', 'author', 'archived', 'version', 'created_at', 'updated_at', 'robot'];

const RUN_KEYS: Array<[string, string]> = [
  ['robot', 'robot'], ['job_type', 'job type'], ['name', 'name'], ['gym_name', 'gym'], ['task_id', 'task'],
  ['course_type', 'course'], ['model_type', 'model type'], ['num_iterations', 'budget'], ['max_iterations', 'budget'],
  ['seed', 'seed'], ['num_envs', 'environments'], ['save_interval', 'checkpoint every'],
  ['init_checkpoint', 'warm start'], ['demo_label', 'demos'], ['curriculum_name', 'curriculum'],
  ['curriculum_stage_name', 'curriculum stage'], ['trainer_git_branch', 'trainer branch'],
  ['trainer_git_sha', 'trainer commit'], ['notes', 'notes'],
];

function value(v: any): ConfigValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && v._bsontype === 'ObjectID') return String(v);
  return JSON.stringify(v);
}

/** Short, stable fingerprint so two reward codes can be told apart in a table cell. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function isPlainObject(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && v._bsontype !== 'ObjectID';
}

/**
 * A job's settings in sections. The experiment design's fields come from the job's
 * snapshot when it has one, else from the design document as it is now.
 */
export function runConfig(job: any, experimentDesign: any): ConfigSection[] {
  const used: { [key: string]: boolean } = {};
  RUN_STATE.forEach((k) => { used[k] = true; });

  const run: ConfigSection = { title: 'Run', values: { robot: job.robot || 'roboracer' } };
  for (const [key, label] of RUN_KEYS) {
    used[key] = true;
    if (job[key] === undefined || (label in run.values && run.values[label] !== null)) continue;
    run.values[label] = value(job[key]);
  }
  if (job.handoff && job.handoff.checkpoint) run.values['warm start'] = value(job.handoff.checkpoint);
  used.handoff = true;

  const reward: ConfigSection = { title: 'Reward design', values: {} };
  reward.values.name = value(job.reward_design_name);
  reward.values.version = value(job.reward_design_version);
  if (typeof job.reward_design_code === 'string') {
    const code = job.reward_design_code;
    reward.values.code = `${fingerprint(code)} · ${code.split('\n').length} lines`;
  }
  ['reward_design_name', 'reward_design_version', 'reward_design_code'].forEach((k) => { used[k] = true; });

  const experiment: ConfigSection = { title: 'Experiment design', values: {} };
  experiment.values.name = value(job.experiment_design_name);
  experiment.values.version = value(job.experiment_design_version);
  const snapshot = isPlainObject(job.experiment_design_fields) && Object.keys(job.experiment_design_fields).length
    ? job.experiment_design_fields : null;
  const fields = snapshot || (experimentDesign ? omit(experimentDesign, DESIGN_META) : {});
  for (const k of Object.keys(fields).sort()) experiment.values[k] = value(fields[k]);
  ['experiment_design_name', 'experiment_design_version', 'experiment_design_fields'].forEach((k) => { used[k] = true; });

  const stage: ConfigSection = { title: 'Stage settings', values: {} };
  const settings = isPlainObject(job.stage_settings) ? job.stage_settings : {};
  for (const k of Object.keys(settings).sort()) {
    stage.values[k] = value(settings[k]);
    // Curriculum stages also copy their settings onto the job itself.
    if (value(job[k]) === value(settings[k])) used[k] = true;
  }
  if (job.train_args !== undefined) stage.values.train_args = value(job.train_args);
  used.stage_settings = true;
  used.train_args = true;

  const other: ConfigSection = { title: 'Other', values: {} };
  for (const k of Object.keys(job).sort()) {
    if (used[k] || OUTPUT_FIELD.test(k)) continue;
    other.values[k] = value(job[k]);
  }
  return [run, reward, experiment, stage, other].filter((s) => Object.keys(s.values).length);
}

function omit(doc: any, keys: string[]): any {
  const out: any = {};
  Object.keys(doc).forEach((k) => { if (keys.indexOf(k) < 0) out[k] = doc[k]; });
  return out;
}

function finite(arr: any): number[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter((x) => x !== null && x !== undefined).map(Number).filter((x) => isFinite(x));
}

function iso(v: any): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** One leaderboard_scores row as per-trial samples; older rows keep returns under `scores`. */
export function evalSample(row: any): EvalSample {
  const trials: { [metric: string]: number[] } = {};
  trials.returns = finite(Array.isArray(row.returns) ? row.returns : row.scores);
  for (const k of TRIAL_METRICS.slice(1)) {
    const xs = finite(row[k]);
    if (xs.length) trials[k] = xs;
  }
  // Steps per goal, per trial; trials that reached no goal have none.
  const lengths = Array.isArray(row.episode_lengths) ? row.episode_lengths : [];
  const goals = Array.isArray(row.avg_goals_per_episode) ? row.avg_goals_per_episode : [];
  const spg: number[] = [];
  for (let i = 0; i < Math.min(lengths.length, goals.length); i++) {
    const l = Number(lengths[i]);
    const g = Number(goals[i]);
    if (lengths[i] != null && goals[i] != null && isFinite(l) && isFinite(g) && g > 0) spg.push(l / g);
  }
  if (spg.length) trials.steps_per_goal = spg;
  return { stage: typeof row.stage_idx === 'number' ? row.stage_idx : null, created_at: iso(row.create_date), trials };
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

/** A model's evals; null when it was never evaluated. */
export function modelEval(model: any, scoreRows: any[]): ModelEval | null {
  const samples = scoreRows.map(evalSample).filter((s) => Object.keys(s.trials).some((k) => s.trials[k].length));
  let aggregate: { [metric: string]: number } | null = null;
  if (model.eval_results && typeof model.eval_results === 'object') {
    aggregate = {};
    for (const k of AGGREGATE_METRICS) {
      const v = Number(model.eval_results[k]);
      if (model.eval_results[k] != null && isFinite(v)) aggregate[k] = v;
    }
    if (!Object.keys(aggregate).length) aggregate = null;
  }
  if (!samples.length && !aggregate) return null;
  const location = typeof model.location === 'string' ? model.location : null;
  return {
    id: String(model._id),
    run_id: model.job_id ? String(model.job_id) : null,
    robot: model.robot || 'roboracer',
    label: location ? basename(location) : String(model._id),
    location,
    iteration: typeof model.training_iterations === 'number' ? model.training_iterations : null,
    created_at: iso(model.create_date),
    avg_return: typeof model.avg_return === 'number' ? model.avg_return : null,
    samples,
    aggregate,
  };
}
