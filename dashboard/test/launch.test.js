// node --test, against the compiled build/ (npm test builds first).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildJob, specFromJob } = require('../build/api/launch');
const { actionsFor, positions } = require('../build/api/queue');
const { locateStart, trimSlice } = require('../build/api/carlogs');

const ROBOTS = [
  { id: 'roboracer', engine: 'tf_agents_unity', default_job_types: ['TRAIN', 'DEMO', 'EVAL', 'BC_TRAINING_ONLY'] },
  { id: 'openbeni', engine: 'mjlab_rsl_rl', default_job_types: ['TRAIN', 'EVAL', 'EXPORT', 'VIDEO'] },
];

function catalog(rows) {
  const find = (kind) => async (id) => (rows[kind] || []).find((r) => String(r._id) === String(id)) || null;
  return {
    robot: (id) => ROBOTS.find((r) => r.id === id),
    gym: find('gyms'),
    rewardDesign: find('rewards'),
    experimentDesign: find('experiments'),
    demo: find('demos'),
    model: find('models'),
  };
}

const CAT = catalog({
  gyms: [
    { _id: 'g-car', name: 'TrackGen-v13', file_path: 'C:\\gyms\\v13.exe' },
    { _id: 'openbeni:Beni-Jump-Flat', robot: 'openbeni', name: 'Jump', task_id: 'Beni-Jump-Flat' },
    { _id: 'g-old', name: 'Old gym', archived: true },
  ],
  rewards: [{ _id: 'rd1', name: 'Speed v4' }, { _id: 'openbeni-passthrough', robot: 'openbeni', name: 'Passthrough' }],
  experiments: [
    { _id: 'ed-awac', name: 'Camera AWAC', awac_lambda: 1, bc_pretrain_steps: 1000 },
    { _id: 'ed-cur', name: 'Curriculum', curriculum_stages: [{}, {}, {}] },
  ],
  demos: [{ _id: 'd1', description: 'Camera demos', num_demos: 177, course: 'donut_camera', tfrecords_path: '/tfrecords/job_x', source_job_id: 'job_x' }],
  models: [
    { _id: 'm1', robot: 'openbeni', task_id: 'Beni-Jump-Flat', job_id: 'j9', location: '/openbeni_rl/logs/x/model_100.pt' },
    {
      _id: 'mc', location: '/saved_models/robotaxi/SacAgent/7_step_9', model_type: 'SacAgent', course_type: 'donut_camera',
      reward_design_id: 'spec:abc:roboracer', reward_design_name: 'Spec reward', reward_design_version: 2,
      experiment_design_id: 'ed-cur', experiment_design_name: 'Curriculum', experiment_design_version: 1,
    },
  ],
});
const NOW = new Date('2026-11-20T00:00:00Z');

test('car TRAIN builds the document the classic form built', async () => {
  const r = await buildJob({
    robot: 'roboracer', job_type: 'TRAIN', gym_id: 'g-car', reward_design_id: 'rd1', budget: 50000,
    course_type: 'donut_camera', demo_id: 'd1', experiment_design_id: 'ed-awac', skip_first_eval: true,
  }, CAT, NOW);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.doc.robot, undefined, 'car jobs carry no robot field');
  assert.strictEqual(r.doc.status, 'NOT_STARTED');
  assert.strictEqual(r.doc.num_iterations, 50000);
  assert.strictEqual(r.doc.gym_file_path, 'C:\\gyms\\v13.exe');
  assert.deepStrictEqual(r.doc.demo_tfrecords_paths, ['/tfrecords/job_x']);
  assert.strictEqual(r.doc.skip_default_demo, true);
  assert.strictEqual(r.doc.demo_job_id, 'job_x');
  assert.strictEqual(r.doc.reward_design_name, 'Speed v4');
  assert.strictEqual(r.doc.skip_first_eval, true);
  assert.strictEqual(r.doc.training_steps, undefined, 'blank numbers are omitted, not zeroed');
});

test('car TRAIN without demos on a camera course asks before dropping demo features', async () => {
  const spec = { robot: 'roboracer', job_type: 'TRAIN', course_type: 'donut_camera', experiment_design_id: 'ed-awac' };
  const r = await buildJob(spec, CAT, NOW);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.confirm.flag, 'allow_no_demos');
  const ok = await buildJob({ ...spec, allow_no_demos: true }, CAT, NOW);
  assert.ok(ok.ok);
  assert.strictEqual(ok.doc.allow_no_demos, true);
});

test('car rules the trainer would otherwise fail the job on', async () => {
  const evalNoLoc = await buildJob({ robot: 'roboracer', job_type: 'EVAL' }, CAT, NOW);
  assert.ok(evalNoLoc.errors.location);
  const fly = await buildJob({ robot: 'roboracer', job_type: 'EVAL', model_type: 'FlyPyPolicy', location: '/x' }, CAT, NOW);
  assert.ok(fly.errors.location);
  const bc = await buildJob({ robot: 'roboracer', job_type: 'BC_TRAINING_ONLY', course_type: 'donut_camera' }, CAT, NOW);
  assert.ok(bc.errors.job_type);
  const sweep = await buildJob({ robot: 'roboracer', job_type: 'EVAL', location: '/m', experiment_design_id: 'ed-cur', eval_stage_start: 2, eval_stage_end: 1 }, CAT, NOW);
  assert.ok(sweep.errors.eval_stage_end);
  const zero = await buildJob({ robot: 'roboracer', job_type: 'DEMO', budget: 0 }, CAT, NOW);
  assert.ok(zero.errors.budget);
  const wrong = await buildJob({ robot: 'roboracer', job_type: 'TRAIN', gym_id: 'openbeni:Beni-Jump-Flat' }, CAT, NOW);
  assert.match(wrong.errors.gym_id, /belongs to openbeni/);
  const archived = await buildJob({ robot: 'roboracer', job_type: 'TRAIN', gym_id: 'g-old' }, CAT, NOW);
  assert.ok(archived.ok);
  assert.strictEqual(archived.warnings.length, 1);
});

test('car EVAL of a model takes its location, course and recorded designs', async () => {
  const r = await buildJob({ robot: 'roboracer', job_type: 'EVAL', model_id: 'mc', num_trials: 10, eval_all_stages: true }, CAT, NOW);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.doc.location, '/saved_models/robotaxi/SacAgent/7_step_9');
  assert.strictEqual(r.doc.course_type, 'donut_camera');
  assert.strictEqual(r.doc.model_type, 'SacAgent');
  assert.strictEqual(r.doc.reward_design_id, 'spec:abc:roboracer', 'spec-compiled reward ids pass through unvalidated');
  assert.strictEqual(r.doc.reward_design_version, 2);
  assert.strictEqual(r.doc.experiment_design_name, 'Curriculum');
  assert.strictEqual(r.doc.eval_all_stages, true, 'a sweep needs no explicit stage range');
  assert.strictEqual(r.doc.eval_stage_start, undefined);

  const override = await buildJob({ robot: 'roboracer', job_type: 'EVAL', model_id: 'mc', course_type: 'donut', reward_design_id: 'rd1' }, CAT, NOW);
  assert.strictEqual(override.doc.course_type, 'donut');
  assert.strictEqual(override.doc.reward_design_name, 'Speed v4');

  const random = await buildJob({ robot: 'roboracer', job_type: 'EVAL', model_id: 'mc', model_type: 'RandomPyPolicy' }, CAT, NOW);
  assert.ok(random.ok, JSON.stringify(random.errors));
  assert.strictEqual(random.doc.location, undefined, 'baselines are rebuilt from scratch');

  const duck = await buildJob({ robot: 'roboracer', job_type: 'EVAL', model_id: 'm1' }, CAT, NOW);
  assert.match(duck.errors.model_id, /belongs to openbeni/);
});

test('mjlab TRAIN and EVAL', async () => {
  const r = await buildJob({
    robot: 'openbeni', job_type: 'TRAIN', gym_id: 'openbeni:Beni-Jump-Flat', reward_design_id: 'openbeni-passthrough',
    budget: 15000, num_envs: '4096', seed: 7, init_checkpoint: '/openbeni_rl/logs/x/model_100.pt', video: false,
    carry: { stage_settings: { push_force_max: 20 }, status: 'DONE' },
  }, CAT, NOW);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.doc.robot, 'openbeni');
  assert.strictEqual(r.doc.task_id, 'Beni-Jump-Flat');
  assert.strictEqual(r.doc.max_iterations, 15000);
  assert.strictEqual(r.doc.num_envs, 4096);
  assert.strictEqual(r.doc.video, false);
  assert.deepStrictEqual(r.doc.stage_settings, { push_force_max: 20 });
  assert.strictEqual(r.doc.status, 'NOT_STARTED', 'carry only copies whitelisted worker inputs');

  const noGym = await buildJob({ robot: 'openbeni', job_type: 'TRAIN' }, CAT, NOW);
  assert.ok(noGym.errors.gym_id);
  const badInit = await buildJob({ robot: 'openbeni', job_type: 'TRAIN', gym_id: 'openbeni:Beni-Jump-Flat', init_checkpoint: '/x/policy.onnx' }, CAT, NOW);
  assert.ok(badInit.errors.init_checkpoint);
  const ev = await buildJob({ robot: 'openbeni', job_type: 'EVAL', model_id: 'm1', eval_steps: 1000 }, CAT, NOW);
  assert.ok(ev.ok);
  assert.strictEqual(ev.doc.checkpoint, '/openbeni_rl/logs/x/model_100.pt');
  assert.strictEqual(ev.doc.source_job_id, 'j9');
  assert.strictEqual(ev.doc.gym_name, 'Jump');
  const badType = await buildJob({ robot: 'openbeni', job_type: 'DEMO' }, CAT, NOW);
  assert.ok(badType.errors.job_type);
});

test('a clone rebuilds its source, minus run state and curriculum links', async () => {
  const source = {
    _id: 'abc', robot: 'openbeni', job_type: 'TRAIN', name: 'Jumping', gym_id: 'openbeni:Beni-Jump-Flat',
    task_id: 'Beni-Jump-Flat', max_iterations: 15000, video: true, progress_video: true,
    stage_settings: { push_force_max: 20 }, status: 'IN_PROGRESS', percent_complete: 16,
    curriculum_run_id: 'cr1', openbeni_run_dirs: ['/x'], reward_design_id: 'openbeni-passthrough',
  };
  const spec = specFromJob(source, ROBOTS[1]);
  assert.strictEqual(spec.name, 'Jumping (copy)');
  assert.strictEqual(spec.budget, 15000);
  const r = await buildJob(spec, CAT, NOW);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.doc.cloned_from, 'abc');
  assert.deepStrictEqual(r.doc.stage_settings, { push_force_max: 20 });
  for (const k of ['curriculum_run_id', 'percent_complete', 'openbeni_run_dirs']) assert.strictEqual(r.doc[k], undefined, k);

  const car = specFromJob({ _id: 'c1', job_type: 'TRAIN', num_iterations: 50000, training_steps: 22776, nn_size_x: 256, course_type: 'donut' }, ROBOTS[0]);
  assert.strictEqual(car.training_steps, undefined, 'a car TRAIN job stamps progress into training_steps');
  assert.deepStrictEqual(car.carry, { nn_size_x: 256 });
});

test('actions and queue order', () => {
  assert.deepStrictEqual(actionsFor('IN_PROGRESS'), ['pause', 'cancel', 'mark_done']);
  assert.deepStrictEqual(actionsFor('PAUSED'), ['resume', 'mark_done']);
  assert.deepStrictEqual(actionsFor('FAILED'), ['restart', 'mark_done']);
  const q = positions([
    { _id: 'b', create_date: '2026-11-02T00:00:00Z' },
    { _id: 'a', create_date: new Date('2026-11-01T00:00:00Z') },
    { _id: '6b0000000000000000000000' },
  ]);
  assert.deepStrictEqual(q, { a: 1, b: 2, '6b0000000000000000000000': 3 });
});

test('car log slices', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlog-'));
  const log = path.join(dir, 'trainer.log');
  const text = 'doing job\nupdating job AAA with status = IN_PROGRESS\nrestarting trainer process for a clean next job\n'
    + 'Polling\ndoing job\nupdating job BBB with status = IN_PROGRESS\nstep 1\n';
  fs.writeFileSync(log, text);
  const at = await locateStart(log, 'BBB', Buffer.byteLength(text));
  assert.strictEqual(text.slice(at.start).split('\n')[1], 'updating job BBB with status = IN_PROGRESS');
  const missing = await locateStart(log, 'AAA', Buffer.byteLength(text));
  assert.strictEqual(missing.start, 0, 'a job that is not the latest falls back to the scan window');
  const cut = trimSlice(Buffer.from(text)).toString();
  assert.ok(cut.endsWith('restarting trainer process for a clean next job\n'));
  assert.ok(cut.indexOf('BBB') < 0);
});
