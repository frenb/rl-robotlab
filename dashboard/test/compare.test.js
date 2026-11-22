// node --test, against the compiled build/ (npm test builds first).
const test = require('node:test');
const assert = require('node:assert');
const { evalSample, modelEval, runConfig } = require('../build/api/compare');
const { downsample } = require('../build/api/metrics');

const section = (sections, title) => (sections.find((s) => s.title === title) || { values: {} }).values;

test('runConfig drops run state and outputs, keeps settings', () => {
  const job = {
    _id: 'j1', status: 'DONE', job_type: 'TRAIN', model_type: 'SacAgent', num_iterations: 50000,
    course_type: 'donut_camera', gym_id: 'g1', gym_name: 'fences-v2', percent_complete: 100, mean_reward: 9.9,
    reward_design_name: 'Speed', reward_design_version: 4, reward_design_code: 'a\nb\n',
    experiment_design_id: 'ed1', experiment_design_name: 'AWAC', trainer_git_sha: 'abc', nn_size_x: 256,
    openbeni_checkpoint: '/x/model_1.pt', openbeni_run_dirs: ['/x'], init_checkpoint: '/y/model_9.pt',
  };
  const design = { _id: 'ed1', name: 'AWAC', version: 1, awac_lambda: 0.5, bc_pretrain_steps: 5000 };
  const cfg = runConfig(job, design);
  assert.deepStrictEqual(section(cfg, 'Run').budget, 50000);
  assert.strictEqual(section(cfg, 'Run').gym, 'fences-v2');
  assert.strictEqual(section(cfg, 'Run')['warm start'], '/y/model_9.pt');
  assert.strictEqual(section(cfg, 'Experiment design').awac_lambda, 0.5);
  assert.strictEqual(section(cfg, 'Experiment design').description, undefined);
  assert.match(String(section(cfg, 'Reward design').code), /^[0-9a-f]{8} · 3 lines$/);
  assert.deepStrictEqual(section(cfg, 'Other'), { nn_size_x: 256 });
});

test('runConfig prefers the job snapshot of the experiment design and folds copied stage settings', () => {
  const job = {
    _id: 'j2', robot: 'openbeni', max_iterations: 15000, experiment_design_fields: { learning_rate: 0.001 },
    stage_settings: { push_force_max: 20 }, push_force_max: 20, handoff: { checkpoint: '/c/model_5.pt' },
  };
  const cfg = runConfig(job, { _id: 'ed', lr_from_doc: 1 });
  assert.deepStrictEqual(section(cfg, 'Experiment design').learning_rate, 0.001);
  assert.strictEqual(section(cfg, 'Experiment design').lr_from_doc, undefined);
  assert.strictEqual(section(cfg, 'Stage settings').push_force_max, 20);
  assert.strictEqual(section(cfg, 'Other').push_force_max, undefined);
  assert.strictEqual(section(cfg, 'Run')['warm start'], '/c/model_5.pt');
});

test('evalSample reads legacy scores and derives steps per goal', () => {
  const s = evalSample({ scores: [1, null, 3], episode_lengths: [100, 200, 300], avg_goals_per_episode: [2, 0, 3], stage_idx: 1 });
  assert.deepStrictEqual(s.trials.returns, [1, 3]);
  assert.deepStrictEqual(s.trials.steps_per_goal, [50, 100]);
  assert.strictEqual(s.stage, 1);
});

test('modelEval is null for an unevaluated model and keeps mjlab aggregates', () => {
  assert.strictEqual(modelEval({ _id: 'm0', location: '/a/b/model_1.pt' }, []), null);
  const m = modelEval({ _id: 'm1', robot: 'microduck', job_id: 'j', location: '/r/run/model_1999.pt',
    eval_results: { mean_return: 74.2, fall_rate: 0.04, task_id: 'x' } }, []);
  assert.deepStrictEqual(m.aggregate, { mean_return: 74.2, fall_rate: 0.04 });
  assert.strictEqual(m.label, 'run/model_1999.pt');
  assert.strictEqual(m.run_id, 'j');
});

test('downsample carries wall times', () => {
  const steps = [1, 2, 3, 4];
  const out = downsample(steps, [1, 2, 3, 4], 2, [10, 20, 30, 40]);
  assert.deepStrictEqual(out.walls, [20, 40]);
  assert.deepStrictEqual(downsample(steps, steps, 10, [5, 6, 7, 8]).walls, [5, 6, 7, 8]);
});
