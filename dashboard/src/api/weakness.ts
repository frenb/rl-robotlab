// Where on the track a car run's policy drives badly, from the segment-end
// trajectory logs the trainer writes (log_reward() in
// rl_agent/environments/courses/utils/logging.py). Only "has succeeded" /
// "has failed - reward" docs carry position_history, a Python list-repr
// joined by commas ("[x, y, z],[x, y, z],...").
//
// Two views of the same logs:
//   grid   per-cell counters over the ground plane, scored into a 0-1
//          weakness (crash rate, slowness, pre-crash risk) and grouped into
//          hotspots
//   gates  per goal gate ("Goal-N", where SimController spawns the car on
//          reset): attempts, crashes, confidence ranges, hard sections and
//          a start-gate distribution aimed at them
// Gate numbers belong to one track layout; a curriculum stage that rebuilds
// the track renumbers them, so lap_fraction is the layout-independent position.
import * as express from 'express';
import { HttpError, idFilter, intParam, route } from './http';
import { Context, summarize, SUMMARY_PROJECTION } from './runs';

const ObjectID = require('mongodb').ObjectID;

/** Steps before a crash whose cells count toward pre-crash risk. */
const HAZARD_WINDOW = 30;
const AXIS_NAMES = ['x', 'y', 'z'];
export const LAYERS = ['weakness', 'crash', 'speed', 'risk', 'visits'];
export const DEFAULT_WEIGHTS = { crash: 0.5, slow: 0.3, risk: 0.2 };
const DEFAULT_MIN_VISITS = 3;
const DEFAULT_THRESHOLD = 0.6;
const THIN_EVIDENCE_VISITS = 10;
const DEFAULT_WEAK_SHARE = 0.25;
/** Pseudo-attempts of the track-wide crash rate mixed into each gate's, so a gate seen twice can't outrank one seen forty times. */
const SHRINK_ATTEMPTS = 5;
const QUERY_MS = 20000;

export interface GridCell { ix: number; iy: number; v: number; ss: number; sc: number; cr: number; gl: number; scs: number; scc: number; hz: number }
export interface Grid {
  ok: true;
  job_id: string;
  episodes: number;
  axes?: number[];
  axisNames?: string[];
  extent?: { xmin: number; xmax: number; ymin: number; ymax: number };
  nx?: number;
  ny?: number;
  cells: GridCell[];
}

function jobMatch(jobId: string): any {
  // The trainer writes logs.job_id as an ObjectId; keep the string form for older rows.
  const or: any[] = [{ job_id: jobId }];
  try { or.push({ job_id: new ObjectID(jobId) }); } catch (e) { /* not an ObjectId */ }
  return { $and: [{ $or: or }, { position_history: { $ne: null } }] };
}

/**
 * Per-cell counters for a run's most recent `limit` episodes, newest first so
 * the map reflects the current policy. The ground plane is the two axes with
 * the widest spread (Unity's up axis is near constant).
 */
export async function weaknessGrid(db: any, jobId: string, bins: number, limit: number): Promise<Grid> {
  const docs = await db.collection('logs').find(jobMatch(jobId))
    .project({ type: 1, score: 1, position_history: 1 }).sort({ _id: -1 }).limit(limit).maxTimeMS(QUERY_MS).toArray();
  const trajs: { pts: number[][]; type: string; score: number }[] = [];
  for (const d of docs) {
    const toks = String(d.position_history || '').match(/\[[^\]]*\]/g) || [];
    const pts: number[][] = [];
    for (const tok of toks) {
      const parts = tok.slice(1, -1).split(',');
      if (parts.length < 3) continue;
      const p = [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2])];
      if (p.every(isFinite)) pts.push(p);
    }
    if (pts.length) trajs.push({ pts, type: String(d.type || ''), score: Number(d.score) });
  }
  if (!trajs.length) return { ok: true, job_id: jobId, episodes: 0, cells: [] };

  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (const t of trajs) for (const p of t.pts) for (let k = 0; k < 3; k++) {
    if (p[k] < mins[k]) mins[k] = p[k];
    if (p[k] > maxs[k]) maxs[k] = p[k];
  }
  const ranges = [0, 1, 2].map((k) => maxs[k] - mins[k]);
  const [ax, ay] = [0, 1, 2].sort((a, b) => ranges[b] - ranges[a]);
  const xmin = mins[ax];
  const ymin = mins[ay];
  const xmax = maxs[ax] > xmin ? maxs[ax] : xmin + 1;
  const ymax = maxs[ay] > ymin ? maxs[ay] : ymin + 1;
  const nx = bins;
  const ny = bins;
  const cw = (xmax - xmin) / nx;
  const ch = (ymax - ymin) / ny;
  const binOf = (p: number[]) => {
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((p[ax] - xmin) / cw)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor((p[ay] - ymin) / ch)));
    return iy * nx + ix;
  };
  const N = nx * ny;
  const visits = new Float64Array(N);
  const speedSum = new Float64Array(N);
  const speedCnt = new Float64Array(N);
  const crash = new Float64Array(N);
  const goal = new Float64Array(N);
  const scoreSum = new Float64Array(N);
  const scoreCnt = new Float64Array(N);
  const hazard = new Float64Array(N);
  for (const t of trajs) {
    const P = t.pts;
    for (let i = 0; i < P.length; i++) {
      const b = binOf(P[i]);
      visits[b] += 1;
      if (i > 0) {
        speedSum[b] += Math.hypot(P[i][ax] - P[i - 1][ax], P[i][ay] - P[i - 1][ay]);
        speedCnt[b] += 1;
      }
    }
    const lb = binOf(P[P.length - 1]);
    if (t.type.indexOf('fail') >= 0) {
      crash[lb] += 1;
      for (let i = Math.max(0, P.length - HAZARD_WINDOW); i < P.length; i++) hazard[binOf(P[i])] += 1;
    } else if (t.type.indexOf('succeed') >= 0) {
      goal[lb] += 1;
    }
    if (isFinite(t.score)) { scoreSum[lb] += t.score; scoreCnt[lb] += 1; }
  }
  const cells: GridCell[] = [];
  for (let b = 0; b < N; b++) {
    if (visits[b] <= 0) continue;
    cells.push({
      ix: b % nx, iy: Math.floor(b / nx), v: visits[b], ss: speedSum[b], sc: speedCnt[b],
      cr: crash[b], gl: goal[b], scs: scoreSum[b], scc: scoreCnt[b], hz: hazard[b],
    });
  }
  return {
    ok: true, job_id: jobId, episodes: trajs.length, axes: [ax, ay], axisNames: [AXIS_NAMES[ax], AXIS_NAMES[ay]],
    extent: { xmin, xmax, ymin, ymax }, nx, ny, cells,
  };
}

export interface GateGroup {
  gate: string | null; index: number | null; attempts: number; crashes: number; mean_steps: number | null;
  mean_steps_success: number | null; reach_x: number | null; reach_z: number | null; crash_x: number | null; crash_z: number | null; last_seen: Date | null;
}

/** The same logs grouped by the gate each stretch was heading for (extra_data.car.current_goal). */
export async function gateGroups(db: any, jobId: string, limit: number): Promise<GateGroup[]> {
  const rows = await db.collection('logs').aggregate([
    { $match: jobMatch(jobId) },
    { $sort: { _id: -1 } },
    { $limit: limit },
    { $project: {
      gate: '$extra_data.car.current_goal',
      failed: { $regexMatch: { input: { $ifNull: ['$type', ''] }, regex: 'fail' } },
      steps: { $size: { $regexFindAll: { input: '$position_history', regex: '\\[' } } },
      x: '$extra_data.car.location_x',
      z: '$extra_data.car.location_z',
      at: { $toDate: '$_id' },
    } },
    { $group: {
      _id: '$gate',
      attempts: { $sum: 1 },
      crashes: { $sum: { $cond: ['$failed', 1, 0] } },
      mean_steps: { $avg: '$steps' },
      mean_steps_success: { $avg: { $cond: ['$failed', null, '$steps'] } },
      reach_x: { $avg: { $cond: ['$failed', null, '$x'] } },
      reach_z: { $avg: { $cond: ['$failed', null, '$z'] } },
      crash_x: { $avg: { $cond: ['$failed', '$x', null] } },
      crash_z: { $avg: { $cond: ['$failed', '$z', null] } },
      last_seen: { $max: '$at' },
    } },
  ], { maxTimeMS: QUERY_MS }).toArray();
  return rows.map((r: any) => {
    const m = /(\d+)$/.exec(String(r._id || ''));
    const { _id, ...rest } = r;
    return { gate: _id || null, index: m ? parseInt(m[1], 10) : null, ...rest };
  }).sort((a: GateGroup, b: GateGroup) => (a.index == null ? 1e9 : a.index) - (b.index == null ? 1e9 : b.index));
}

function normalize(values: Map<number, number>): Map<number, number> {
  let min = Infinity;
  let max = -Infinity;
  values.forEach((v) => {
    if (!isFinite(v)) return;
    if (v < min) min = v;
    if (v > max) max = v;
  });
  const span = (max - min) || 1;
  const out = new Map<number, number>();
  values.forEach((v, k) => out.set(k, (v - min) / span));
  return out;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round = (v: number, d: number) => +v.toFixed(d);

function thirds(fx: number, fy: number, names: string[]): string {
  const third = (f: number) => (f < 1 / 3 ? 'low' : f > 2 / 3 ? 'high' : 'mid');
  const a = third(fx);
  const b = third(fy);
  if (a === 'mid' && b === 'mid') return 'centre of the track area';
  if (a === 'mid') return `${b}-${names[1]} side`;
  if (b === 'mid') return `${a}-${names[0]} side`;
  return `${a}-${names[0]} / ${b}-${names[1]} corner`;
}

export interface WeaknessOptions { layer: string; weights: { crash: number; slow: number; risk: number }; minVisits: number; threshold: number }

/**
 * Scores each cell 0-1, higher = weaker, and groups cells at or above the
 * threshold into 8-connected hotspots, heaviest first. For speed, slower is
 * weaker; for visits, busier.
 */
export function analyseGrid(grid: Grid, o: WeaknessOptions) {
  if (!grid.cells.length || !grid.extent || !grid.nx || !grid.ny) return null;
  const { nx, ny, extent } = grid;
  const names = grid.axisNames || ['x', 'z'];
  const cw = (extent.xmax - extent.xmin) / nx;
  const ch = (extent.ymax - extent.ymin) / ny;
  const center = (k: number): [number, number] => [extent.xmin + ((k % nx) + 0.5) * cw, extent.ymin + (Math.floor(k / nx) + 0.5) * ch];
  const where = (x: number, y: number) => thirds((x - extent.xmin) / (extent.xmax - extent.xmin), (y - extent.ymin) / (extent.ymax - extent.ymin), names);

  const byKey = new Map<number, GridCell>();
  const crashRate = new Map<number, number>();
  const speed = new Map<number, number>();
  const risk = new Map<number, number>();
  const visits = new Map<number, number>();
  for (const c of grid.cells) {
    const k = c.iy * nx + c.ix;
    byKey.set(k, c);
    if (c.v < o.minVisits) continue;
    crashRate.set(k, c.cr / c.v);
    speed.set(k, c.sc > 0 ? c.ss / c.sc : 0);
    risk.set(k, (c.hz || 0) / c.v);
    visits.set(k, c.v);
  }
  const nCrash = normalize(crashRate);
  const nSpeed = normalize(speed);
  const nRisk = normalize(risk);
  const nVisits = normalize(visits);
  const w = o.weights;
  const wsum = (w.crash + w.slow + w.risk) || 1;
  const score = new Map<number, number>();
  crashRate.forEach((_, k) => {
    const s = o.layer === 'crash' ? nCrash.get(k)!
      : o.layer === 'speed' ? 1 - nSpeed.get(k)!
        : o.layer === 'risk' ? nRisk.get(k)!
          : o.layer === 'visits' ? nVisits.get(k)!
            : (w.crash * nCrash.get(k)! + w.slow * (1 - nSpeed.get(k)!) + w.risk * nRisk.get(k)!) / wsum;
    score.set(k, s);
  });
  const trackSpeed = median(Array.from(speed.values()));

  const hot = new Set<number>();
  score.forEach((s, k) => { if (s >= o.threshold) hot.add(k); });
  const seen = new Set<number>();
  const regions: any[] = [];
  hot.forEach((start) => {
    if (seen.has(start)) return;
    const members: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop()!;
      members.push(k);
      const ix = k % nx;
      const iy = Math.floor(k / nx);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx;
          const jy = iy + dy;
          if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
          const j = jy * nx + jx;
          if (hot.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); }
        }
      }
    }
    let wv = 0; let cx = 0; let cy = 0; let crashes = 0; let v = 0; let weight = 0;
    let peak = members[0];
    const xs: number[] = [];
    const ys: number[] = [];
    const speeds: number[] = [];
    for (const k of members) {
      const c = byKey.get(k)!;
      const [x, y] = center(k);
      cx += x * c.v; cy += y * c.v; wv += c.v;
      crashes += c.cr; v += c.v; weight += score.get(k)!;
      xs.push(x); ys.push(y); speeds.push(speed.get(k)!);
      if (score.get(k)! > score.get(peak)!) peak = k;
    }
    cx /= wv; cy /= wv;
    const [px, py] = center(peak);
    const regionSpeed = median(speeds);
    regions.push({
      where: where(cx, cy),
      centroid: { x: round(cx, 2), y: round(cy, 2) },
      bounds: {
        x: [round(Math.min(...xs) - cw / 2, 2), round(Math.max(...xs) + cw / 2, 2)],
        y: [round(Math.min(...ys) - ch / 2, 2), round(Math.max(...ys) + ch / 2, 2)],
      },
      cells: members.length,
      peak_score: round(score.get(peak)!, 3),
      peak_at: { x: round(px, 2), y: round(py, 2) },
      peak_cell: { ix: peak % nx, iy: Math.floor(peak / nx) },
      visits: v,
      crashes,
      crash_rate: round(crashes / v, 4),
      peak_cell_crash_rate: round(crashRate.get(peak)!, 4),
      speed_vs_track_median: trackSpeed && regionSpeed != null ? round(regionSpeed / trackSpeed, 2) : null,
      thin_evidence: v < THIN_EVIDENCE_VISITS,
      member_cells: members.map((k) => [k % nx, Math.floor(k / nx)]),
      _weight: weight,
    });
  });
  regions.sort((a, b) => b._weight - a._weight);

  return {
    axis_names: names,
    extent,
    nx,
    ny,
    cell_size: [cw, ch],
    track_median_speed: trackSpeed,
    crashed_episodes: grid.cells.reduce((s, c) => s + c.cr, 0),
    goal_episodes: grid.cells.reduce((s, c) => s + c.gl, 0),
    cells: grid.cells.map((c) => {
      const k = c.iy * nx + c.ix;
      const [x, y] = center(k);
      const sp = c.sc > 0 ? c.ss / c.sc : null;
      return {
        ix: c.ix, iy: c.iy, x: round(x, 3), y: round(y, 3), visits: c.v, crashes: c.cr, goals: c.gl,
        crash_rate: round(c.cr / c.v, 4),
        risk: round((c.hz || 0) / c.v, 4),
        speed: sp == null ? null : round(sp, 5),
        speed_vs_track_median: sp != null && trackSpeed ? round(sp / trackSpeed, 2) : null,
        mean_score: c.scc ? round(c.scs / c.scc, 3) : null,
        score: score.has(k) ? round(score.get(k)!, 4) : null,
      };
    }),
    hotspots: regions.map(({ _weight, ...r }, i) => ({ rank: i + 1, ...r })),
  };
}

/** 95% Wilson score interval for k successes in n trials. */
function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export interface GateOptions { minAttempts: number; weakShare: number; lead: number; topK: number }

/**
 * Per-gate crash rates with confidence ranges, runs of consecutive gates
 * harder than the track average, and a start distribution that sends a share
 * of resets a few gates before the hardest ones.
 */
export function analyseGates(groups: GateGroup[], o: GateOptions) {
  const gates = groups.filter((g) => g.index != null) as (GateGroup & { index: number })[];
  if (!gates.length) return null;
  const gateCount = Math.max(...gates.map((g) => g.index));
  const attempts = gates.reduce((s, g) => s + g.attempts, 0);
  const crashes = gates.reduce((s, g) => s + g.crashes, 0);
  const trackRate = crashes / attempts;
  const medianSteps = median(gates.map((g) => g.mean_steps_success).filter((v): v is number => v != null && isFinite(v)));
  const pos = (g: GateGroup): [number | null, number | null] => [g.reach_x != null ? g.reach_x : g.crash_x, g.reach_z != null ? g.reach_z : g.crash_z];
  const pts = gates.map(pos).filter(([x, z]) => x != null && z != null && isFinite(x) && isFinite(z)) as [number, number][];
  const ext = pts.length ? {
    xmin: Math.min(...pts.map((p) => p[0])), xmax: Math.max(...pts.map((p) => p[0])),
    zmin: Math.min(...pts.map((p) => p[1])), zmax: Math.max(...pts.map((p) => p[1])),
  } : null;
  const where = (x: number | null, z: number | null) => (ext && x != null && z != null
    ? thirds((x - ext.xmin) / ((ext.xmax - ext.xmin) || 1), (z - ext.zmin) / ((ext.zmax - ext.zmin) || 1), ['x', 'z']) : null);

  const rows = gates.map((g) => {
    const [lo, hi] = wilson(g.crashes, g.attempts);
    const [x, z] = pos(g);
    return {
      gate: g.gate,
      index: g.index,
      lap_fraction: round(g.index / gateCount, 3),
      where: where(x, z),
      position: x != null && z != null && isFinite(x) ? { x: round(x, 2), z: round(z, 2) } : null,
      crash_position: g.crash_x != null && g.crash_z != null ? { x: round(g.crash_x, 2), z: round(g.crash_z, 2) } : null,
      attempts: g.attempts,
      crashes: g.crashes,
      crash_rate: round(g.crashes / g.attempts, 3),
      crash_rate_ci95: [round(lo, 3), round(hi, 3)],
      smoothed_crash_rate: round((g.crashes + SHRINK_ATTEMPTS * trackRate) / (g.attempts + SHRINK_ATTEMPTS), 3),
      steps_to_clear_vs_median: g.mean_steps_success != null && medianSteps ? round(g.mean_steps_success / medianSteps, 2) : null,
      reliable: g.attempts >= o.minAttempts,
      last_seen: g.last_seen ? new Date(g.last_seen).toISOString() : null,
    };
  });
  const present = new Set(rows.map((r) => r.index));
  const missing: number[] = [];
  for (let i = 1; i <= gateCount; i++) if (!present.has(i)) missing.push(i);

  const ranked = rows.filter((g) => g.reliable).sort((a, b) => b.crash_rate_ci95[0] - a.crash_rate_ci95[0]);
  const hard = new Set(rows.filter((g) => g.reliable && g.smoothed_crash_rate > trackRate).map((g) => g.index));
  const byIndex = new Map(rows.map((g) => [g.index, g] as [number, typeof g]));
  const sections: any[] = [];
  for (let i = 1; i <= gateCount; i++) {
    if (!hard.has(i) || hard.has(i - 1)) continue;
    let j = i;
    while (hard.has(j + 1)) j++;
    const members = [];
    for (let k = i; k <= j; k++) members.push(byIndex.get(k)!);
    const att = members.reduce((t, g) => t + g.attempts, 0);
    const cr = members.reduce((t, g) => t + g.crashes, 0);
    sections.push({
      gates: i === j ? `Goal-${i}` : `Goal-${i} to Goal-${j}`,
      first: i,
      last: j,
      lap_fraction: [round(i / gateCount, 3), round(j / gateCount, 3)],
      where: members[0].where,
      attempts: att,
      crashes: cr,
      crash_rate: round(cr / att, 3),
      crash_rate_ci95: wilson(cr, att).map((v) => round(v, 3)),
    });
  }
  sections.sort((a, b) => b.crash_rate_ci95[0] - a.crash_rate_ci95[0]);

  const targets = rows.filter((g) => hard.has(g.index)).sort((a, b) => b.smoothed_crash_rate - a.smoothed_crash_rate).slice(0, o.topK);
  let start: any = null;
  if (targets.length) {
    const N = gateCount;
    const excess = targets.map((g) => g.smoothed_crash_rate - trackRate);
    const total = excess.reduce((a, b) => a + b, 0) || 1;
    const startOf = (idx: number) => ((((idx - 1 - o.lead) % N) + N) % N) + 1;
    const uniform = (1 - o.weakShare) / N;
    const prob = new Map<number, number>();
    for (let i = 1; i <= N; i++) prob.set(i, uniform);
    const aimed = targets.map((g, k) => {
      const s = startOf(g.index);
      prob.set(s, prob.get(s)! + (o.weakShare * excess[k]) / total);
      return {
        hard_gate: g.gate, hard_index: g.index, start_at: `Goal-${s}`, start_index: s, start_lap_fraction: round(s / N, 3), where: g.where,
        hard_gate_crash_rate: g.crash_rate, smoothed_crash_rate: g.smoothed_crash_rate, attempts: g.attempts,
        weak_share_of_this_target: round(excess[k] / total, 3),
      };
    });
    const weights: { [f: string]: number } = {};
    aimed.forEach((t) => { weights[String(t.start_lap_fraction)] = round((weights[String(t.start_lap_fraction)] || 0) + t.weak_share_of_this_target, 3); });
    start = {
      weak_share: o.weakShare,
      lead_gates: o.lead,
      targets: aimed,
      distribution: Array.from(prob.entries()).filter(([, p]) => p > uniform + 1e-9)
        .map(([i, p]) => ({ gate: `Goal-${i}`, index: i, lap_fraction: round(i / N, 3), probability: round(p, 4) }))
        .sort((a, b) => b.probability - a.probability),
      uniform_probability_other_gates: round(uniform, 4),
      // The shape a future experiment-design field would take; the trainer doesn't read it yet.
      proposed_experiment_fields: { start_gate_weak_share: o.weakShare, start_gate_weights_by_lap_fraction: weights },
    };
  }

  return {
    gate_count: gateCount,
    attempts,
    crashes,
    track_crash_rate: round(trackRate, 3),
    gates_never_attempted: missing,
    gates: rows,
    hardest_gates: ranked.map((g, i) => ({ rank: i + 1, ...g })),
    hardest_sections: sections,
    start,
  };
}

function numParam(v: any, fallback: number, min: number, max: number): number {
  const n = parseFloat(String(v));
  return isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function mountInsights(api: express.Router, ctx: Context, db: () => any) {
  /** The run a query names, else the running car TRAIN run, else the newest one. */
  const pickRun = async (ref: string) => {
    const jobs = db().collection('jobs');
    if (ref) {
      if (!/^[0-9a-f]{24}$/i.test(ref)) throw new HttpError(400, 'run must be a 24-character run id');
      const job = await jobs.findOne(idFilter(ref), { projection: SUMMARY_PROJECTION });
      // Trajectory logs outlive a deleted run.
      return { id: ref, run: job ? summarize(ctx, job) : null };
    }
    const car = { $or: [{ robot: { $exists: false } }, { robot: 'roboracer' }], job_type: 'TRAIN' };
    const job = await jobs.findOne({ ...car, status: 'IN_PROGRESS' }, { projection: SUMMARY_PROJECTION, sort: { _id: -1 } })
      || await jobs.findOne(car, { projection: SUMMARY_PROJECTION, sort: { _id: -1 } });
    if (!job) throw new HttpError(404, 'there are no car training runs yet');
    return { id: String(job._id), run: summarize(ctx, job) };
  };

  api.get('/insights/weakness', route(async (req) => {
    const { id, run } = await pickRun(String(req.query.run || ''));
    const bins = intParam(req.query.bins, 48, 8, 200);
    const limit = intParam(req.query.limit, 500, 1, 5000);
    const layer = LAYERS.indexOf(String(req.query.layer)) >= 0 ? String(req.query.layer) : 'weakness';
    const opts: WeaknessOptions = {
      layer,
      weights: {
        crash: numParam(req.query.w_crash, DEFAULT_WEIGHTS.crash, 0, 1),
        slow: numParam(req.query.w_slow, DEFAULT_WEIGHTS.slow, 0, 1),
        risk: numParam(req.query.w_risk, DEFAULT_WEIGHTS.risk, 0, 1),
      },
      minVisits: intParam(req.query.min_visits, DEFAULT_MIN_VISITS, 1, 30),
      threshold: numParam(req.query.threshold, DEFAULT_THRESHOLD, 0, 1),
    };
    const grid = await weaknessGrid(db(), id, bins, limit);
    return {
      run_id: id, run, episodes: grid.episodes, bins, limit, layer, weights: opts.weights, min_visits: opts.minVisits, threshold: opts.threshold,
      map: analyseGrid(grid, opts),
    };
  }));

  api.get('/insights/gates', route(async (req) => {
    const { id, run } = await pickRun(String(req.query.run || ''));
    const limit = intParam(req.query.limit, 2000, 1, 20000);
    const groups = await gateGroups(db(), id, limit);
    return {
      run_id: id, run, limit,
      ...(analyseGates(groups, {
        minAttempts: intParam(req.query.min_attempts, 3, 1, 1e6),
        weakShare: numParam(req.query.weak_share, DEFAULT_WEAK_SHARE, 0, 1),
        lead: intParam(req.query.lead, 1, 0, 10),
        topK: intParam(req.query.top_k, 5, 1, 50),
      }) || { gate_count: 0, gates: [], hardest_gates: [], hardest_sections: [], start: null }),
    };
  }));
}
