// node --test, against the compiled build/ (npm test builds first).
const test = require('node:test');
const assert = require('node:assert');
const {
  compat, evalSummary, gatesFor, modelSummary, rankCar, rankMjlab, scoresByModel, specsCompatible, stats,
} = require('../build/api/models');

const ENV = { robotaxi: { action_spec: { shape: [2], dtype: 'float32' } } };

test('specsCompatible mirrors robotaxi.py', () => {
  assert.strictEqual(specsCompatible({ shape: [31], dtype: "<dtype: 'float32'>" }, { shape: [31], dtype: 'float32' }), true);
  assert.strictEqual(specsCompatible({ shape: [31] }, { shape: [32] }), false);
  assert.strictEqual(specsCompatible({ shape: [null, 3] }, { shape: [84, 3] }), true);
  assert.strictEqual(specsCompatible({ a: { shape: [1] } }, { b: { shape: [1] } }), false);
  assert.strictEqual(specsCompatible(null, { shape: [1] }), null);
});

test('car compat checks the observation of the model\'s own course', () => {
  const m = { robot_type: 'robotaxi', course_type: 'donut_no_hint', observation_spec: { shape: [31], dtype: 'float32' }, action_spec: { shape: [2], dtype: 'float32' } };
  assert.strictEqual(compat(m, false, ENV).status, 'compatible');
  assert.strictEqual(compat({ ...m, course_type: 'donut' }, false, ENV).status, 'incompatible');
  assert.strictEqual(compat({ ...m, course_type: undefined, observation_spec: { shape: [32], dtype: 'float32' } }, false, ENV).status, 'compatible',
    'no course means donut');
  assert.strictEqual(compat({ robot_type: 'robotaxi' }, false, ENV).status, 'unknown');
  assert.strictEqual(compat({ onnx_location: '/x.onnx', obs_dim: 48, act_dim: 12 }, true, {}).status, 'compatible');
  assert.strictEqual(compat({}, true, {}).status, 'unknown');
});

const score = (over) => ({
  create_date: '2026-11-10T00:00:00Z', returns: [1, 2], episode_lengths: [40, 60], avg_goals_per_episode: [4, 6],
  episode_counts: [5, 5], stage_idx: null, ...over,
});

test('car eval summary pools ordinary evals and lists sweep stages apart', () => {
  const rows = [score({}), score({ create_date: '2026-11-12T00:00:00Z', avg_goals_per_episode: [8, 10] }), score({ stage_idx: 3, avg_goals_per_episode: [0, 0] })];
  const e = evalSummary({}, false, rows);
  assert.strictEqual(e.count, 3);
  assert.strictEqual(e.trials, 4, 'the sweep stage is left out of the headline');
  assert.strictEqual(e.metrics.avg_goals_per_episode, 7);
  assert.strictEqual(e.metrics.steps_per_goal, (10 + 10 + 5 + 6) / 4);
  assert.deepStrictEqual(e.stages, [3]);
  assert.strictEqual(e.last_at, '2026-11-12T00:00:00.000Z');
  const sweepOnly = evalSummary({}, false, [score({ stage_idx: 0 })]);
  assert.strictEqual(sweepOnly.trials, 2, 'only sweep stages: pool those');
  assert.strictEqual(evalSummary({}, false, []), null);
});

test('mjlab eval summary is the aggregate', () => {
  const e = evalSummary({ eval_results: { episodes: 256, fall_rate: 0.1, mean_return: 29 }, eval_at: '2026-11-19T07:47:01Z' }, true, []);
  assert.deepStrictEqual(e.metrics, { fall_rate: 0.1, mean_return: 29 });
  assert.strictEqual(e.trials, 256);
});

test('scores join by model_id, else by path', () => {
  const models = [{ _id: 'a', location: '/a' }, { _id: 'b', location: '/b' }];
  const by = scoresByModel(models, [{ model_id: 'a' }, { path: '/b' }, { model_id: 'zzz' }]);
  assert.strictEqual(by.a.length, 1);
  assert.strictEqual(by.b.length, 1);
});

test('car ranking pools trials, honours min trials and direction', () => {
  const models = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }];
  const rows = {
    a: [score({ avg_goals_per_episode: [4, 6] })],
    b: [score({ avg_goals_per_episode: [9, 9] }), score({ avg_goals_per_episode: [7, 7] })],
    c: [score({ avg_goals_per_episode: [20], returns: [1], episode_lengths: [400] })],
  };
  const ranked = rankCar(models, rows, 'avg_goals_per_episode', 'main', 2);
  assert.deepStrictEqual(ranked.map((r) => r.model_id), ['b', 'a']);
  assert.strictEqual(ranked[0].stats.n, 4);
  assert.strictEqual(ranked[0].evals, 2);
  const spg = rankCar(models, rows, 'steps_per_goal', 'main', 1);
  assert.strictEqual(spg[0].model_id, 'b', 'fewer steps per goal ranks first');
});

test('mjlab ranking by a lower-is-better aggregate', () => {
  const ranked = rankMjlab([
    { _id: 'x', eval_results: { fall_rate: 0.3, episodes: 10 } },
    { _id: 'y', eval_results: { fall_rate: 0.05, episodes: 10 } },
    { _id: 'z' },
  ], 'fall_rate');
  assert.deepStrictEqual(ranked.map((r) => [r.model_id, r.rank]), [['y', 1], ['x', 2]]);
});

test('gates match the stage that trained the model or evaluated its checkpoint', () => {
  const runs = [{
    _id: 'cr1', curriculum_name: 'Beni walk',
    results: [
      { stage_index: 0, stage_name: 'Balance', attempt: 0, train_job_id: 'j1', checkpoint: '/c/model_9.pt', passed: false, at: '2026-11-20T04:00:00Z',
        gate: [{ metric: 'fall_rate', op: '<=', value: 0.05, actual: 0.14, passed: false }] },
      { stage_index: 1, train_job_id: 'j2', checkpoint: '/other.pt', passed: true, gate: [] },
    ],
  }];
  const g = gatesFor({ job_id: 'j1', location: '/c/model_9.pt' }, runs);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].stage_name, 'Balance');
  assert.strictEqual(g[0].checks[0].actual, 0.14);
  assert.strictEqual(gatesFor({ job_id: 'j3', location: '/x' }, runs).length, 0);
});

test('model summary', () => {
  const s = modelSummary({
    _id: 'm', location: '/saved_models/robotaxi/SacAgent/7_step_9', notes: 'NA', course_type: 'trainer default', is_global_best: true,
    reward_design_id: 'rd', reward_design_name: 'R', training_iterations: 9, promoted_at: '2026-11-20T00:00:00Z',
  }, false, [], ENV);
  assert.strictEqual(s.robot, 'roboracer');
  assert.strictEqual(s.label, 'SacAgent/7_step_9');
  assert.strictEqual(s.course, 'donut');
  assert.strictEqual(s.iteration, 9, 'a car checkpoint\'s step comes from its path, not the run budget');
  assert.strictEqual(s.notes, null, '"NA" is the trainer\'s placeholder');
  assert.strictEqual(s.latest_of_run, true);
  assert.strictEqual(s.promoted_at, '2026-11-20T00:00:00.000Z');
  assert.strictEqual(s.eval, null);
  assert.deepStrictEqual(stats([1, 2, 3, 4]).median, 2.5);
});
