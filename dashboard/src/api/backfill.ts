// mean_reward for car runs that finished before the trainer started writing it
// (rl_agent/robotaxi.py writes it after every eval since 2026-11). Read once per
// dashboard start from the run's eval curve, so the runs list can show and sort
// car runs by reward like mjlab runs.
import { lastValue } from './metrics';
import { CAR, Context, eventSources, robotFilter } from './runs';

const TAG = 'eval/Metrics/AverageReturn';
const DONE = ['DONE', 'FAILED', 'CANCELLED', 'PAUSED'];
const START_DELAY_MS = 30000;

export async function backfillCarRewards(ctx: Context): Promise<number> {
  const db = ctx.db();
  if (!db) return 0;
  const jobs = await db.collection('jobs').find(
    { $and: [robotFilter(CAR), { job_type: 'TRAIN', status: { $in: DONE }, mean_reward: { $exists: false } }] },
    { projection: { _id: 1, robot: 1 } },
  ).toArray();
  let filled = 0;
  for (const job of jobs) {
    const sources = (await eventSources(ctx, job)).filter((s) => s.prefix === 'eval/');
    if (!sources.length) continue;
    const v = await lastValue(sources, TAG);
    if (v == null || !isFinite(v)) continue;
    await db.collection('jobs').updateOne(
      { _id: job._id, mean_reward: { $exists: false } }, { $set: { mean_reward: v } });
    filled++;
  }
  return filled;
}

export function scheduleCarRewardBackfill(ctx: Context): void {
  setTimeout(() => {
    backfillCarRewards(ctx).then(
      (n) => { if (n) console.log(`[api/v1 backfill] mean_reward set on ${n} car runs`); },
      (e) => console.warn('[api/v1 backfill] failed:', e && (e.message || e)),
    );
  }, START_DELAY_MS);
}
