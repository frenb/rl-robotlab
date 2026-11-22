// node --test, against the compiled build/ (npm test builds first).
const test = require('node:test');
const assert = require('node:assert');
const { applyRunAction, runActions } = require('../build/api/curricula');

/** Just enough of a Mongo collection for the run transitions. */
function collection(docs) {
  const matches = (doc, filter) => Object.keys(filter).every((k) => {
    const want = filter[k];
    if (want && typeof want === 'object' && '$in' in want) return want.$in.some((v) => String(v) === String(doc[k]));
    return String(doc[k]) === String(want);
  });
  return {
    docs,
    findOne: async (filter) => docs.find((d) => matches(d, filter)) || null,
    updateOne: async (filter, update) => {
      const doc = docs.find((d) => matches(d, filter));
      if (!doc) return { matchedCount: 0 };
      for (const [path, value] of Object.entries(update.$set || {})) {
        const keys = path.split('.');
        let at = doc;
        keys.slice(0, -1).forEach((k) => { at = at[k]; });
        at[keys[keys.length - 1]] = value;
      }
      for (const [k, n] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + n;
      return { matchedCount: 1 };
    },
    deleteOne: async (filter) => { docs.splice(docs.findIndex((d) => matches(d, filter)), 1); },
    deleteMany: async (filter) => {
      const before = docs.length;
      for (let i = docs.length - 1; i >= 0; i--) if (matches(docs[i], filter)) docs.splice(i, 1);
      return { deletedCount: before - docs.length };
    },
  };
}

function fixture(run) {
  const runs = collection([{ _id: 'r1', stages: [{ id: 'a' }, { id: 'b' }], stage_index: 0, attempt: 0, results: [], ...run }]);
  const jobs = collection([
    { _id: 'j1', status: 'IN_PROGRESS', curriculum_run_id: 'r1' },
    { _id: 'j2', status: 'DONE', curriculum_run_id: 'r1' },
  ]);
  const db = { collection: (name) => (name === 'curriculum_runs' ? runs : jobs) };
  return { db, runs, jobs };
}

const missed = { stage_index: 0, attempt: 0, passed: false, checkpoint: '/a.pt' };

test('actions follow the run status', () => {
  assert.deepStrictEqual(runActions({ status: 'RUNNING' }), ['cancel']);
  assert.deepStrictEqual(runActions({ status: 'PASSED' }), ['delete']);
  assert.deepStrictEqual(runActions({ status: 'FAILED_GATE', stage_index: 0, stages: [{}, {}], results: [missed] }), ['retry', 'skip', 'delete']);
  // Nothing to move on to after the last stage, nor without a checkpoint to continue from.
  assert.deepStrictEqual(runActions({ status: 'FAILED_GATE', stage_index: 1, stages: [{}, {}], results: [{ ...missed, stage_index: 1 }] }), ['retry', 'delete']);
  assert.deepStrictEqual(runActions({ status: 'FAILED_GATE', stage_index: 0, stages: [{}, {}], results: [{ ...missed, checkpoint: null }] }), ['retry', 'delete']);
});

test('skip marks the missed attempt and moves to the next stage', async () => {
  const { db, runs } = fixture({ status: 'FAILED_GATE', ended_at: 'x', error: 'missed', results: [{ ...missed }] });
  await applyRunAction(db, 'r1', 'skip');
  const run = runs.docs[0];
  assert.strictEqual(run.status, 'RUNNING');
  assert.strictEqual(run.stage_index, 1);
  assert.strictEqual(run.attempt, 0);
  assert.strictEqual(run.error, null);
  assert.strictEqual(run.results[0].skipped, true);
  assert.strictEqual(run.results[0].passed, false);
  await assert.rejects(applyRunAction(db, 'r1', 'skip'), /only a run that missed a gate/);
});

test('retry adds an attempt after a missed gate and a generation after a failure', async () => {
  let f = fixture({ status: 'FAILED_GATE', attempt: 1 });
  await applyRunAction(f.db, 'r1', 'retry');
  assert.strictEqual(f.runs.docs[0].attempt, 2);
  f = fixture({ status: 'CANCELLED', generation: 0 });
  await applyRunAction(f.db, 'r1', 'retry');
  assert.strictEqual(f.runs.docs[0].generation, 1);
  await assert.rejects(applyRunAction(f.db, 'r1', 'retry'), (e) => e.status === 409);
});

test('cancel stops the pending job; delete needs a finished run', async () => {
  const { db, runs, jobs } = fixture({ status: 'RUNNING', pending: { job_id: 'j1' } });
  await assert.rejects(applyRunAction(db, 'r1', 'delete'), /cancel the run/);
  await applyRunAction(db, 'r1', 'cancel');
  assert.strictEqual(runs.docs[0].status, 'CANCEL_REQUESTED');
  assert.strictEqual(jobs.docs[0].status, 'CANCELLED');
  runs.docs[0].status = 'CANCELLED';
  const out = await applyRunAction(db, 'r1', 'delete', { deleteJobs: true });
  assert.strictEqual(out.jobs_deleted, 2);
  assert.strictEqual(runs.docs.length, 0);
  await assert.rejects(applyRunAction(db, 'r1', 'pause'), (e) => e.status === 404);
});
