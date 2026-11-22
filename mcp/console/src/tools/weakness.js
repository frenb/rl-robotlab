// Insights page: where on the track a car run's policy drives badly. The
// dashboard scores the cells, finds the hotspots and ranks the gates
// (dashboard/src/api/weakness.ts); these tools pick the run, trim the
// answer and draw the track as text so the answer is "where", not a list
// of numbers.

import { z } from 'zod';
import { get } from '../api.js';
import { defineTool, defined } from '../util.js';

const LAYERS = ['weakness', 'crash', 'speed', 'risk', 'visits'];
const ASCII_MAX = 64;
const SHADES = ['.', '-', '+', '*', '#'];
const GATE_NOTE = 'Gate numbers belong to one track layout; a curriculum stage that rebuilds the track renumbers them, '
  + 'so lap_fraction (gate / gate count) is the layout-independent position.';

/** A run id from a full id or an id suffix; undefined lets the dashboard pick the running (else newest) car TRAIN run. */
async function runId(ref) {
  if (!ref) return undefined;
  if (/^[0-9a-f]{24}$/i.test(ref)) return ref;
  const { items } = await get('/api/v1/runs', { q: ref, limit: 10 });
  const hits = items.filter((r) => r.id.endsWith(ref.toLowerCase()));
  if (hits.length !== 1) throw new Error(hits.length ? `"${ref}" matches ${hits.length} runs; give more characters` : `no run id ends in "${ref}"`);
  return hits[0].id;
}

function jobInfo(res) {
  const r = res.run;
  if (!r) return { _id: res.run_id, status: 'job document not found (deleted?)' };
  return { _id: r.id, name: r.name, job_type: r.job_type, status: r.status, gym_name: r.gym_name, created_at: r.created_at };
}

async function weakness(args) {
  return get('/api/v1/insights/weakness', defined({
    run: await runId(args.job_id), layer: args.layer, bins: args.bins, limit: args.limit, min_visits: args.min_visits,
    threshold: args.threshold, w_crash: args.weights?.crash, w_slow: args.weights?.slow, w_risk: args.weights?.risk,
  }));
}

const NO_TRAJECTORIES = 'No trajectory data for this job yet (only finished episodes record a path).';
const NO_GATES = 'No gate-to-gate driving logs for this job yet.';

/** The track as text, top row = high second axis. Hotspot peaks are numbered. */
function asciiMap(map) {
  const { nx, ny, axis_names: axes } = map;
  const f = Math.max(1, Math.ceil(Math.max(nx, ny) / ASCII_MAX));
  const W = Math.ceil(nx / f);
  const H = Math.ceil(ny / f);
  const best = Array.from({ length: H }, () => new Array(W).fill(-1));
  for (const c of map.cells) {
    const gx = Math.floor(c.ix / f);
    const gy = Math.floor(c.iy / f);
    best[gy][gx] = Math.max(best[gy][gx], c.score ?? 0);
  }
  const grid = best.map((row) => row.map((s) => (s < 0 ? ' ' : SHADES[Math.min(SHADES.length - 1, Math.floor(s * SHADES.length))])));
  map.hotspots.slice(0, 9).forEach((h) => {
    grid[Math.floor(h.peak_cell.iy / f)][Math.floor(h.peak_cell.ix / f)] = String(h.rank);
  });
  const rows = grid.reverse().map((r) => r.join('').replace(/\s+$/, ''));
  return [
    `+${'-'.repeat(W)}+  ^ ${axes[1]}`,
    ...rows.map((r) => `|${r.padEnd(W)}|`),
    `+${'-'.repeat(W)}+  > ${axes[0]}`,
    `legend: ' ' never driven, ${SHADES.map((s, i) => `'${s}' ${(i / SHADES.length).toFixed(1)}+`).join(', ')}, 1-9 = hotspot peaks`,
  ].join('\n');
}

const onAxes = (p, axes) => ({ [axes[0]]: p.x, [axes[1]]: p.y });

const commonInput = {
  job_id: z.string().optional().describe('Job id or suffix. Default: the running car TRAIN job, else the newest one.'),
  layer: z.enum(LAYERS).optional().describe('weakness (default) = weighted blend of crash rate, slowness and pre-crash risk; '
    + 'crash = crashes per visit; speed = slow is weak (the start straight always reads slow: episodes begin from rest); '
    + 'risk = share of visits within 30 steps of a crash; visits = traffic.'),
  weights: z.object({ crash: z.number().min(0).max(1).optional(), slow: z.number().min(0).max(1).optional(), risk: z.number().min(0).max(1).optional() })
    .optional().describe('Blend weights for the weakness layer. Default crash 0.5, slow 0.3, risk 0.2.'),
  bins: z.number().int().min(8).max(200).optional().describe('Grid cells per side. Default 48.'),
  limit: z.number().int().min(1).max(5000).optional().describe('Most recent episodes to use. Default 500.'),
  min_visits: z.number().int().min(1).max(30).optional().describe('Cells visited fewer times are not scored. Default 3.'),
};

export function register(server) {
  defineTool(server, 'get_weakness_map', {
    title: 'Where the car drives badly',
    description: 'Insights page: scores the track from a job\'s recent episodes (crashes, slow sections, approaches that end in '
      + 'a crash) and returns the weak hotspots, each with where it is on the track, its bounds in world coordinates, '
      + 'crash rate and speed relative to the rest of the track, plus a text map with the hotspots numbered.',
    readOnly: true,
    input: {
      ...commonInput,
      threshold: z.number().min(0).max(1).optional().describe('Score (0-1) a cell needs to count toward a hotspot. Default 0.6.'),
      top: z.number().int().min(1).max(30).optional().describe('Hotspots to return. Default 5.'),
      ascii: z.boolean().optional().describe('Include the text map. Default true.'),
      raw: z.boolean().optional().describe('Return the dashboard\'s full answer, every scored cell included.'),
    },
  }, async (args) => {
    const res = await weakness(args);
    if (args.raw) return res;
    const m = res.map;
    if (!m) return { job: jobInfo(res), episodes: res.episodes, note: NO_TRAJECTORIES };
    const axes = m.axis_names;
    const out = {
      job: jobInfo(res),
      layer: res.layer,
      weights: res.layer === 'weakness' ? res.weights : undefined,
      episodes: res.episodes,
      crashed_episodes: m.crashed_episodes,
      goal_episodes: m.goal_episodes,
      ground_axes: axes,
      extent: { [axes[0]]: [+m.extent.xmin.toFixed(2), +m.extent.xmax.toFixed(2)], [axes[1]]: [+m.extent.ymin.toFixed(2), +m.extent.ymax.toFixed(2)] },
      grid: `${m.nx}x${m.ny}, min ${res.min_visits} visits per scored cell`,
      track_median_step_distance: m.track_median_speed && +m.track_median_speed.toFixed(4),
      hotspots: m.hotspots.slice(0, args.top ?? 5).map(({ member_cells, peak_cell, thin_evidence, centroid, bounds, peak_at, ...h }) => ({
        ...h,
        centroid: onAxes(centroid, axes),
        bounds: { [axes[0]]: bounds.x, [axes[1]]: bounds.y },
        peak_at: onAxes(peak_at, axes),
        ...(thin_evidence ? { evidence: `thin: ${h.visits} visits; may be noise` } : {}),
      })),
    };
    if (!m.hotspots.length) out.note = `No cell scored ${res.threshold} or more; lower threshold to see milder weak spots.`;
    if (args.ascii !== false) out.map = asciiMap(m);
    return out;
  });

  defineTool(server, 'get_weakness_at', {
    title: 'Weakness at a track position',
    description: 'Insights page hover: metrics for the grid cell containing a world position, and its neighbours, for a job.',
    readOnly: true,
    input: {
      ...commonInput,
      x: z.number().describe('Position on the first ground axis (see get_weakness_map ground_axes).'),
      y: z.number().describe('Position on the second ground axis.'),
      radius: z.number().int().min(0).max(5).optional().describe('Neighbouring cells to include on each side. Default 1.'),
    },
  }, async (args) => {
    const res = await weakness(args);
    const m = res.map;
    if (!m) return { job: jobInfo(res), note: NO_TRAJECTORIES };
    const axes = m.axis_names;
    const [cw, ch] = m.cell_size;
    const ix = Math.floor((args.x - m.extent.xmin) / cw);
    const iy = Math.floor((args.y - m.extent.ymin) / ch);
    if (ix < 0 || iy < 0 || ix >= m.nx || iy >= m.ny) {
      return {
        job: jobInfo(res),
        note: 'That position is outside the area the car has driven.',
        extent: { [axes[0]]: [m.extent.xmin, m.extent.xmax], [axes[1]]: [m.extent.ymin, m.extent.ymax] },
      };
    }
    const byCell = new Map(m.cells.map((c) => [c.iy * m.nx + c.ix, c]));
    const r = args.radius ?? 1;
    const cells = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const jx = ix + dx;
        const jy = iy + dy;
        if (jx < 0 || jy < 0 || jx >= m.nx || jy >= m.ny) continue;
        const c = byCell.get(jy * m.nx + jx);
        const at = { x: +(m.extent.xmin + (jx + 0.5) * cw).toFixed(2), y: +(m.extent.ymin + (jy + 0.5) * ch).toFixed(2) };
        const row = { ...onAxes(at, axes), visits: c ? c.visits : 0 };
        if (c) {
          Object.assign(row, {
            crashes: c.crashes,
            goals: c.goals,
            crash_rate: c.crash_rate,
            pre_crash_risk: c.risk,
            speed_vs_track_median: c.speed_vs_track_median,
            score: c.score ?? `unscored (< ${res.min_visits} visits)`,
          });
        }
        if (dx === 0 && dy === 0) row.queried = true;
        cells.push(row);
      }
    }
    return { job: jobInfo(res), layer: res.layer, cells };
  });

  const gateInput = {
    job_id: commonInput.job_id,
    limit: z.number().int().min(1).max(20000).optional().describe('Most recent gate-to-gate stretches to use. Default 2000.'),
    min_attempts: z.number().int().min(1).optional().describe('Leave out gates attempted fewer times. Default 3.'),
  };
  const gates = async (args) => get('/api/v1/insights/gates', defined({
    run: await runId(args.job_id), limit: args.limit, min_attempts: args.min_attempts,
    weak_share: args.weak_share, lead: args.lead, top_k: args.top_k,
  }));

  defineTool(server, 'get_difficult_sections', {
    title: 'Where the track is most difficult',
    description: 'Ranks the track\'s goal gates by how often the car crashes on the way to them (each gate-to-gate stretch '
      + 'is one attempt), ordered by the low end of the 95% confidence range so thinly-sampled gates do not dominate. '
      + 'Also groups adjacent hard gates into sections. Gates are where episodes start, so this is the input for '
      + 'start-position experiments (suggest_start_gates).',
    readOnly: true,
    input: { ...gateInput, top: z.number().int().min(1).max(100).optional().describe('Gates to return. Default 10.') },
  }, async (args) => {
    const s = await gates(args);
    if (!s.gates.length) return { job: jobInfo(s), note: NO_GATES };
    return {
      job: jobInfo(s),
      gate_count: s.gate_count,
      attempts: s.attempts,
      crashes: s.crashes,
      track_crash_rate: s.track_crash_rate,
      ...(s.gates_never_attempted.length ? { gates_never_attempted: s.gates_never_attempted } : {}),
      hardest_sections: s.hardest_sections.slice(0, 5).map(({ first, last, ...sec }) => sec),
      hardest_gates: s.hardest_gates.slice(0, args.top ?? 10).map(({ reliable, last_seen, ...g }) => g),
      note: GATE_NOTE,
    };
  });

  defineTool(server, 'suggest_start_gates', {
    title: 'Where to place the car',
    description: 'Start-position distribution for weakness-focused training: a share of resets (default 25%) start a few '
      + 'gates before the hardest gates, so the car drives into its weak spots; the rest stay uniformly random so the rest '
      + 'of the track is not forgotten. Each gate\'s crash rate is shrunk toward the track average before weighting. '
      + 'Evaluation should keep uniform starts for a fair comparison. The trainer cannot apply this yet: start-gate control '
      + 'in Unity, the reset message and the trainer is a separate change.',
    readOnly: true,
    input: {
      ...gateInput,
      weak_share: z.number().min(0).max(1).optional().describe('Share of resets aimed at weak spots. Default 0.25.'),
      lead: z.number().int().min(0).max(10).optional().describe('Start this many gates before each hard gate, to give a run-up. Default 1.'),
      top_k: z.number().int().min(1).max(50).optional().describe('How many hard gates to target. Default 5.'),
    },
  }, async (args) => {
    const s = await gates(args);
    if (!s.gates.length) return { job: jobInfo(s), note: NO_GATES };
    if (!s.start) return { job: jobInfo(s), note: 'No gate is reliably harder than the track average; keep uniform starts.', track_crash_rate: s.track_crash_rate };
    const { distribution, uniform_probability_other_gates, ...start } = s.start;
    return {
      job: jobInfo(s),
      gate_count: s.gate_count,
      track_crash_rate: s.track_crash_rate,
      ...start,
      targets: start.targets.map(({ hard_index, start_index, ...t }) => t),
      start_distribution: distribution.map(({ index, ...d }) => d),
      uniform_probability_other_gates,
      note: `${GATE_NOTE} Not yet applied by the trainer: Unity picks a uniformly random start gate on every reset.`,
    };
  });
}
