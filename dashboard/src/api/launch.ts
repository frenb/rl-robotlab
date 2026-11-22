// Launching runs from the app: a typed spec in, a job document out.
//
// The classic Jobs tab built job documents in the browser (components.js
// buildJobPayload for the car, jobs.html buildDuckPayload for mjlab robots)
// and /add_job inserted whatever it was sent. Here the server validates the
// spec against the robot, gyms, designs, demos and models first, so a bad
// field is a form error rather than a job that fails on pickup.
//
// Conventions kept from buildJobPayload: blank numbers are omitted rather than
// sent as 0 (the workers apply their own defaults to missing fields), and car
// jobs carry no `robot` field, like every car job before multi-robot support.
import { CAR, Robot } from './runs';

export const CAR_JOB_TYPES = ['TRAIN', 'DEMO', 'EVAL', 'BC_TRAINING_ONLY'];
export const MJLAB_JOB_TYPES = ['TRAIN', 'EVAL', 'EXPORT', 'VIDEO'];
export const CAR_MODEL_TYPES = ['SacAgent', 'GreedyPolicy', 'RandomPyPolicy', 'FlyPyPolicy'];
export const CAR_COURSES = [
  { value: '', label: 'Trainer default (donut, 32-D)' },
  { value: 'donut', label: 'donut (32-D)' },
  { value: 'donut_no_hint', label: 'donut_no_hint (31-D, no angle-to-goal)' },
  { value: 'donut_camera', label: 'donut_camera (31-D + 84x84 camera)' },
  { value: 'donut_camera_no_rays', label: 'donut_camera_no_rays (2-D + 84x84 camera)' },
  { value: 'fly_donut', label: 'fly_donut (1314-D fly connectome trace)' },
  { value: 'fly_donut_flow', label: 'fly_donut_flow (fly trace + optic flow)' },
];
const CAMERA_COURSES = ['donut_camera', 'donut_camera_no_rays'];
const FLY_COURSES = ['fly_donut', 'fly_donut_flow'];
// COURSE_DEFAULT_DEMO_JOB_IDS maps these to None in robotaxi.py.
const COURSES_WITHOUT_DEFAULT_DEMOS = CAMERA_COURSES.concat(FLY_COURSES);
const DEMO_FEATURES: Array<[string, string]> = [
  ['bc_pretrain_steps', 'BC pretrain'],
  ['critic_warmup_steps', 'critic warm-up'],
  ['awac_lambda', 'AWAC'],
  ['demo_prefill_count', 'demo prefill'],
];

/** Seeded designs listed first, and what a blank form starts on. */
export const PINNED_DESIGNS: { [robot: string]: { reward: string; experiment: string } } = {
  roboracer: { reward: 'passthrough-course-default', experiment: 'experiment-default' },
  microduck: { reward: 'microduck-passthrough', experiment: 'microduck-experiment-default' },
  openbeni: { reward: 'openbeni-passthrough', experiment: 'openbeni-experiment-default' },
};
/** The task a blank mjlab form starts on: the robot's first curriculum stage. */
export const DEFAULT_GYM: { [robot: string]: string } = {
  microduck: 'microduck:Mjlab-Velocity-Flat-MicroDuck',
  openbeni: 'openbeni:Beni-Velocity-Flat',
};

// Fields the workers read that the launch form has no control for. A clone
// copies them from its source unchanged (rl_agent/robotaxi.py do_job,
// rl_agent/mjlab_core/launch.py).
const CAR_CARRY = [
  'chicanes_north_val', 'chicanes_east_val', 'chicanes_south_val', 'chicanes_west_val',
  'max_goals_per_episode', 'max_steps_per_episode', 'nn_size_x', 'nn_size_y', 'headless',
  'bc_pretrain_steps', 'default_demo_job_id', 'demo_source_counts',
];
// Only when the source names no demo_id: older jobs set the demo paths directly.
const CAR_DEMO_CARRY = ['demo_tfrecords_paths', 'demo_job_ids', 'skip_default_demo', 'demo_label'];
const MJLAB_CARRY = [
  'stage_settings', 'train_args', 'num_steps_per_env', 'seconds_per_checkpoint', 'eval_fallen_probability',
];

export interface LaunchSpec {
  robot: string;
  job_type: string;
  name?: string;
  notes?: string;
  gym_id?: string;
  reward_design_id?: string;
  experiment_design_id?: string;
  /** Car num_iterations, mjlab max_iterations. */
  budget?: number | null;
  seed?: number | null;
  video?: boolean;
  progress_video?: boolean;
  // mjlab
  num_envs?: number | null;
  save_interval?: number | null;
  /** Warm start: a model_<N>.pt path. */
  init_checkpoint?: string;
  /** EVAL / EXPORT / VIDEO: the models row to act on. */
  model_id?: string;
  eval_num_envs?: number | null;
  eval_steps?: number | null;
  // car
  course_type?: string;
  model_type?: string;
  demo_id?: string;
  demo_job_id?: string;
  skip_first_eval?: boolean;
  training_steps?: number | null;
  demo_step_budget?: number | null;
  location?: string;
  num_trials?: number | null;
  num_eval_episodes?: number | null;
  corner_radius_val?: number | null;
  curvature_difficulty_val?: number | null;
  /** Car EVAL: sweep every curriculum stage of the experiment design (or start..end). */
  eval_all_stages?: boolean;
  eval_stage_start?: number | null;
  eval_stage_end?: number | null;
  allow_no_demos?: boolean;
  /** Worker fields the form has no control for, copied from a cloned run. */
  carry?: { [key: string]: any };
  cloned_from?: string;
}

export interface Catalog {
  robot(id: string): Robot | undefined;
  gym(id: string): Promise<any>;
  rewardDesign(id: string): Promise<any>;
  experimentDesign(id: string): Promise<any>;
  demo(id: string): Promise<any>;
  model(id: string): Promise<any>;
}

export interface BuildResult {
  ok: boolean;
  doc: any;
  /** Field name -> what is wrong with it. */
  errors: { [field: string]: string };
  warnings: string[];
  /** Set when the run can launch only after the user agrees, by resending with the named flag. */
  confirm?: { flag: string; message: string };
}

export function isMjlabRobot(robot: Robot | undefined, id: string): boolean {
  return robot ? robot.engine === 'mjlab_rsl_rl' : id !== CAR;
}

export function jobTypes(robot: Robot | undefined, id: string): string[] {
  const own = robot && Array.isArray((robot as any).default_job_types) ? (robot as any).default_job_types : null;
  return own && own.length ? own : isMjlabRobot(robot, id) ? MJLAB_JOB_TYPES : CAR_JOB_TYPES;
}

function blank(v: any): boolean {
  return v === undefined || v === null || v === '';
}

function str(v: any): string {
  return blank(v) ? '' : String(v).trim();
}

function ownerOf(row: any): string {
  return (row && row.robot) || CAR;
}

class Checker {
  errors: { [field: string]: string } = {};
  warnings: string[] = [];

  fail(field: string, message: string): void {
    if (!this.errors[field]) this.errors[field] = message;
  }

  /** A whole number >= min, or undefined when left blank. */
  int(spec: any, field: string, label: string, min = 1, max = Infinity): number | undefined {
    const v = spec[field];
    if (blank(v)) return undefined;
    const n = Number(v);
    if (!isFinite(n) || Math.floor(n) !== n) return this.fail(field, `${label} must be a whole number`), undefined;
    if (n < min) return this.fail(field, `${label} must be at least ${min}`), undefined;
    if (n > max) return this.fail(field, `${label} must be at most ${max}`), undefined;
    return n;
  }

  num(spec: any, field: string, label: string): number | undefined {
    const v = spec[field];
    if (blank(v)) return undefined;
    const n = Number(v);
    if (!isFinite(n)) return this.fail(field, `${label} must be a number`), undefined;
    return n;
  }

  /** Looks up a gym / design owned by `robot`; archived rows pass with a warning. */
  async owned(field: string, label: string, id: string, robot: string,
              find: (id: string) => Promise<any>): Promise<any> {
    if (!id) return null;
    const row = await find(id);
    if (!row) return this.fail(field, `${label} ${id} not found`), null;
    if (ownerOf(row) !== robot) {
      return this.fail(field, `${label} "${row.name || id}" belongs to ${ownerOf(row)}, not ${robot}`), null;
    }
    if (row.archived) this.warnings.push(`${label} "${row.name || id}" is archived.`);
    return row;
  }
}

function designFields(doc: any, kind: 'reward' | 'experiment', row: any): void {
  if (!row) return;
  doc[`${kind}_design_id`] = String(row._id);
  if (row.name) doc[`${kind}_design_name`] = row.name;
}

function copyCarry(doc: any, carry: any, keys: string[]): void {
  if (!carry) return;
  for (const k of keys) {
    if (carry[k] !== undefined && doc[k] === undefined) doc[k] = carry[k];
  }
}

/** Validates a spec and builds the job document it describes. */
export async function buildJob(spec: LaunchSpec, cat: Catalog, now: Date = new Date()): Promise<BuildResult> {
  const c = new Checker();
  const robotId = str(spec && spec.robot);
  const robot = robotId ? cat.robot(robotId) : undefined;
  if (!robotId) c.fail('robot', 'Pick a robot');
  else if (!robot) c.fail('robot', `Unknown robot ${robotId}`);
  const jobType = str(spec && spec.job_type).toUpperCase();
  if (robot && jobTypes(robot, robotId).indexOf(jobType) < 0) {
    c.fail('job_type', `${robot.display_name || robotId} runs ${jobTypes(robot, robotId).join(', ')} jobs`);
  }
  if (Object.keys(c.errors).length) return { ok: false, doc: null, errors: c.errors, warnings: [] };

  const doc: any = { status: 'NOT_STARTED', job_type: jobType, create_date: now.toISOString() };
  const name = str(spec.name);
  if (name) doc.name = name.slice(0, 200);
  const notes = str(spec.notes);
  if (notes) doc.notes = notes;
  if (str(spec.cloned_from)) doc.cloned_from = str(spec.cloned_from);

  const out: { confirm?: BuildResult['confirm'] } = isMjlabRobot(robot, robotId)
    ? await buildMjlab(spec, robotId, doc, cat, c)
    : await buildCar(spec, doc, cat, c);
  const ok = !Object.keys(c.errors).length;
  return { ok: ok && !out.confirm, doc: ok ? doc : null, errors: c.errors, warnings: c.warnings, confirm: ok ? out.confirm : undefined };
}

async function buildMjlab(spec: LaunchSpec, robot: string, doc: any, cat: Catalog, c: Checker) {
  doc.robot = robot;
  const jt = doc.job_type;
  const rd = await c.owned('reward_design_id', 'Reward design', str(spec.reward_design_id), robot, (id) => cat.rewardDesign(id));
  const ed = await c.owned('experiment_design_id', 'Experiment design', str(spec.experiment_design_id), robot, (id) => cat.experimentDesign(id));
  if (jt === 'TRAIN') {
    const gymId = str(spec.gym_id);
    if (!gymId) c.fail('gym_id', 'Pick a task');
    const gym = await c.owned('gym_id', 'Task', gymId, robot, (id) => cat.gym(id));
    if (gym) {
      doc.gym_id = String(gym._id);
      doc.gym_name = gym.name || '';
      doc.task_id = gym.task_id || (gymId.indexOf(robot + ':') === 0 ? gymId.slice(robot.length + 1) : gymId);
    }
    designFields(doc, 'reward', rd);
    designFields(doc, 'experiment', ed);
    const init = str(spec.init_checkpoint);
    if (init) {
      if (!/model_\d+\.pt$/.test(init)) c.fail('init_checkpoint', 'Warm start must be a model_<N>.pt checkpoint');
      else doc.init_checkpoint = init;
    }
    const ints: Array<[string, string, string]> = [
      ['max_iterations', 'budget', 'Iterations'],
      ['num_envs', 'num_envs', 'Robots in parallel'],
      ['save_interval', 'save_interval', 'Checkpoint every'],
    ];
    for (const [key, field, label] of ints) {
      const v = c.int(spec, field, label);
      if (v !== undefined) doc[key] = v;
    }
    const seed = c.int(spec, 'seed', 'Seed', -2147483648, 2147483647);
    if (seed !== undefined) doc.seed = seed;
    doc.video = spec.video !== false;
    doc.progress_video = spec.progress_video !== false;
    copyCarry(doc, spec.carry, MJLAB_CARRY);
    return {};
  }
  const modelId = str(spec.model_id);
  if (!modelId) return c.fail('model_id', 'Pick a model'), {};
  const model = await cat.model(modelId);
  if (!model) return c.fail('model_id', `Model ${modelId} not found`), {};
  if (ownerOf(model) !== robot) return c.fail('model_id', `That model belongs to ${ownerOf(model)}`), {};
  doc.task_id = model.task_id;
  if (model.job_id) doc.source_job_id = String(model.job_id);
  if (jt !== 'VIDEO') doc.checkpoint = model.location;
  const gym = model.task_id ? await cat.gym(`${robot}:${model.task_id}`) : null;
  if (gym && gym.name) doc.gym_name = gym.name;
  if (jt === 'EVAL') {
    const envs = c.int(spec, 'eval_num_envs', 'Robots in parallel');
    if (envs !== undefined) doc.eval_num_envs = envs;
    const steps = c.int(spec, 'eval_steps', 'Steps');
    if (steps !== undefined) doc.eval_steps = steps;
    copyCarry(doc, spec.carry, ['eval_fallen_probability']);
  }
  return {};
}

async function buildCar(spec: LaunchSpec, doc: any, cat: Catalog, c: Checker): Promise<{ confirm?: BuildResult['confirm'] }> {
  const jt = doc.job_type;
  // An EVAL of a models row starts from that checkpoint's own settings.
  let model: any = null;
  if (jt === 'EVAL' && str(spec.model_id)) {
    model = await cat.model(str(spec.model_id));
    if (!model) c.fail('model_id', `Model ${str(spec.model_id)} not found`);
    else if (ownerOf(model) !== CAR) c.fail('model_id', `That model belongs to ${ownerOf(model)}`);
    if (c.errors.model_id) model = null;
  }
  const modelType = str(spec.model_type) || (model && str(model.model_type)) || 'SacAgent';
  if (CAR_MODEL_TYPES.indexOf(modelType) < 0) c.fail('model_type', `Model type must be one of ${CAR_MODEL_TYPES.join(', ')}`);
  const rawCourse = str(spec.course_type) || (model ? str(model.course_type) : '');
  const course = rawCourse === 'trainer default' ? '' : rawCourse;
  if (course && !CAR_COURSES.some((x) => x.value === course)) c.fail('course_type', `Unknown course ${course}`);
  const camera = CAMERA_COURSES.indexOf(course) >= 0;
  const fly = FLY_COURSES.indexOf(course) >= 0;
  if (jt === 'BC_TRAINING_ONLY' && camera) {
    c.fail('job_type', `BC_TRAINING_ONLY is refused on ${course}: it trains a flat MLP and cannot read the camera. Record with DEMO, then BC inside a TRAIN job.`);
  }
  if ((jt === 'DEMO' || jt === 'BC_TRAINING_ONLY') && fly) {
    c.fail('job_type', `${jt} is impossible on ${course}: the observation is the brain's own history and cannot be recorded.`);
  }

  Object.assign(doc, {
    job_type: jt,
    model_type: modelType,
    robot_type: 'robotaxi',
    demo_job_id: str(spec.demo_job_id),
    pass_through_actions: false,
  });
  if (course) doc.course_type = course;

  const budget = c.int(spec, 'budget', jt === 'DEMO' ? 'Episodes' : 'Iterations', 1);
  if (budget !== undefined) doc.num_iterations = budget;
  if (jt === 'DEMO' || jt === 'BC_TRAINING_ONLY') {
    const steps = c.int(spec, 'training_steps', 'Training steps', 0);
    if (steps !== undefined) doc.training_steps = steps;
  }
  if (jt === 'DEMO') {
    const cap = c.int(spec, 'demo_step_budget', 'Demo transitions', 1);
    if (cap !== undefined) doc.demo_step_budget = cap;
  }
  const radius = c.num(spec, 'corner_radius_val', 'Corner radius');
  if (radius !== undefined) doc.corner_radius_val = radius;
  const curv = c.num(spec, 'curvature_difficulty_val', 'Curvature difficulty');
  if (curv !== undefined) doc.curvature_difficulty_val = curv;
  const seed = c.int(spec, 'seed', 'Seed', -2147483648, 2147483647);
  if (seed !== undefined) doc.seed = seed;

  if (jt === 'TRAIN') {
    if (spec.skip_first_eval) doc.skip_first_eval = true;
    doc.video = spec.video !== false;
    doc.progress_video = spec.progress_video !== false;
  }

  if (jt === 'EVAL') {
    // Baselines are rebuilt from scratch, so a model they were launched from lends no location.
    const fromScratch = modelType === 'FlyPyPolicy' || modelType === 'RandomPyPolicy';
    const location = str(spec.location) || (model && !fromScratch ? str(model.location) : '');
    if (modelType === 'FlyPyPolicy') {
      if (location) c.fail('location', 'Leave the model location empty for a FlyPyPolicy eval: the policy is built from the connectome and do_job refuses a location.');
    } else if (!location && !fromScratch) {
      c.fail('location', 'Pick the SavedModel to evaluate');
    }
    if (location) doc.location = location;
    const trials = c.int(spec, 'num_trials', 'Trials', 1, 100);
    if (trials !== undefined) doc.num_trials = trials;
    const eps = c.int(spec, 'num_eval_episodes', 'Episodes per trial', 1);
    if (eps !== undefined) doc.num_eval_episodes = eps;
  }

  const gymId = str(spec.gym_id);
  const gym = await c.owned('gym_id', 'Gym', gymId, CAR, (id) => cat.gym(id));
  if (gym) {
    doc.gym_id = String(gym._id);
    doc.gym_name = gym.name || '';
    doc.gym_file_path = gym.file_path || '';
  }

  const demoId = str(spec.demo_id);
  if (demoId && (jt === 'TRAIN' || jt === 'BC_TRAINING_ONLY')) {
    const demo = await cat.demo(demoId);
    if (!demo) c.fail('demo_id', `Demo set ${demoId} not found`);
    else if (!demo.tfrecords_path) c.fail('demo_id', 'That demo set has no TFRecords path');
    else {
      // A picked demo set replaces the course-default demos (buildJobPayload).
      doc.demo_id = String(demo._id);
      doc.demo_label = demoLabel(demo);
      doc.demo_tfrecords_paths = [String(demo.tfrecords_path)];
      doc.skip_default_demo = true;
      if (demo.source_job_id) {
        doc.demo_job_ids = [String(demo.source_job_id)];
        if (!doc.demo_job_id) doc.demo_job_id = String(demo.source_job_id);
      }
    }
  }

  const rd = await c.owned('reward_design_id', 'Reward design', str(spec.reward_design_id), CAR, (id) => cat.rewardDesign(id));
  let ed = await c.owned('experiment_design_id', 'Experiment design', str(spec.experiment_design_id), CAR, (id) => cat.experimentDesign(id));
  designFields(doc, 'reward', rd);
  designFields(doc, 'experiment', ed);
  if (model) {
    // The checkpoint's own designs, as recorded (spec-compiled reward ids have no reward_designs row).
    for (const kind of ['reward', 'experiment']) {
      if (doc[`${kind}_design_id`] || !model[`${kind}_design_id`]) continue;
      for (const k of ['id', 'name', 'version']) {
        const v = model[`${kind}_design_${k}`];
        if (v !== undefined && v !== null) doc[`${kind}_design_${k}`] = k === 'id' ? String(v) : v;
      }
    }
    if (!ed && model.experiment_design_id) ed = await cat.experimentDesign(String(model.experiment_design_id));
  }

  if (jt === 'EVAL' && (spec.eval_all_stages || !blank(spec.eval_stage_start) || !blank(spec.eval_stage_end))) {
    const stages = ed && Array.isArray(ed.curriculum_stages) ? ed.curriculum_stages.length : 0;
    if (!stages) {
      c.fail('eval_stage_start', 'A curriculum sweep needs an experiment design with curriculum stages');
    } else {
      const s = c.int(spec, 'eval_stage_start', 'Start stage', 0, stages - 1);
      const e = c.int(spec, 'eval_stage_end', 'End stage', 0, stages - 1);
      if (s !== undefined && e !== undefined && s > e) c.fail('eval_stage_end', 'End stage comes before the start stage');
      doc.eval_all_stages = true;
      if (s !== undefined) doc.eval_stage_start = s;
      if (e !== undefined) doc.eval_stage_end = e;
    }
  }

  copyCarry(doc, spec.carry, CAR_CARRY);
  if (!doc.demo_id) copyCarry(doc, spec.carry, CAR_DEMO_CARRY);

  if (jt === 'TRAIN' && !doc.demo_tfrecords_paths && COURSES_WITHOUT_DEFAULT_DEMOS.indexOf(course) >= 0 && ed
      && String(ed._id) !== PINNED_DESIGNS.roboracer.experiment) {
    // robotaxi.py _demo_dependent_design_features fails such a job unless allow_no_demos is set.
    const features = DEMO_FEATURES.filter(([k]) => Number(ed[k]) > 0).map(([, label]) => label);
    if (features.length) {
      if (spec.allow_no_demos) doc.allow_no_demos = true;
      else {
        return {
          confirm: {
            flag: 'allow_no_demos',
            message: `"${ed.name}" uses ${features.join(', ')}, but no demo set is picked and ${course} has no default demos. `
              + 'All of these would be skipped and the run would train plain SAC from scratch.',
          },
        };
      }
    }
  }
  return {};
}

export function demoLabel(r: any): string {
  const desc = r.description || r.tfrecords_path || '(no description)';
  const n = r.num_demos == null ? '?' : r.num_demos;
  return `${desc} \u2014 ${n} demos${r.course ? ', ' + r.course : ''}`;
}

/**
 * The spec that relaunches `job`: the form fields read back off the document,
 * plus every other worker input under `carry`. Curriculum and run-state
 * fields are dropped, so a clone of a curriculum stage is a standalone run.
 */
export function specFromJob(job: any, robot: Robot | undefined): LaunchSpec {
  const robotId = (job && job.robot) || CAR;
  const mjlab = isMjlabRobot(robot, robotId);
  const pick = (k: string) => (job[k] === undefined || job[k] === null ? undefined : job[k]);
  const spec: LaunchSpec = {
    robot: robotId,
    job_type: job.job_type || 'TRAIN',
    name: job.name ? `${job.name} (copy)` : undefined,
    notes: pick('notes'),
    gym_id: pick('gym_id') != null ? String(job.gym_id) : undefined,
    reward_design_id: pick('reward_design_id') != null ? String(job.reward_design_id) : undefined,
    experiment_design_id: pick('experiment_design_id') != null ? String(job.experiment_design_id) : undefined,
    budget: pick(mjlab ? 'max_iterations' : 'num_iterations'),
    seed: pick('seed'),
    video: job.video !== false,
    progress_video: job.progress_video !== false,
    cloned_from: String(job._id),
  };
  const carry: any = {};
  if (mjlab) {
    Object.assign(spec, {
      num_envs: pick('num_envs'),
      save_interval: pick('save_interval'),
      init_checkpoint: pick('init_checkpoint'),
      eval_num_envs: pick('eval_num_envs'),
      eval_steps: pick('eval_steps'),
    });
    for (const k of MJLAB_CARRY) if (pick(k) !== undefined) carry[k] = job[k];
  } else {
    Object.assign(spec, {
      course_type: pick('course_type'),
      model_type: pick('model_type'),
      demo_id: pick('demo_id') != null ? String(job.demo_id) : undefined,
      demo_job_id: job.demo_id ? undefined : pick('demo_job_id'),
      skip_first_eval: !!job.skip_first_eval,
      training_steps: job.job_type === 'TRAIN' ? undefined : pick('training_steps'),
      demo_step_budget: pick('demo_step_budget'),
      location: pick('location'),
      num_trials: pick('num_trials'),
      num_eval_episodes: pick('num_eval_episodes'),
      corner_radius_val: pick('corner_radius_val'),
      curvature_difficulty_val: pick('curvature_difficulty_val'),
      eval_all_stages: job.eval_all_stages ? true : undefined,
      eval_stage_start: job.eval_all_stages ? pick('eval_stage_start') : undefined,
      eval_stage_end: job.eval_all_stages ? pick('eval_stage_end') : undefined,
      allow_no_demos: !!job.allow_no_demos,
    });
    const keys = job.demo_id ? CAR_CARRY : CAR_CARRY.concat(CAR_DEMO_CARRY);
    for (const k of keys) if (pick(k) !== undefined) carry[k] = job[k];
  }
  if (Object.keys(carry).length) spec.carry = carry;
  for (const k of Object.keys(spec)) if ((spec as any)[k] === undefined) delete (spec as any)[k];
  return spec;
}
