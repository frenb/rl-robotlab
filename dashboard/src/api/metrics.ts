// Scalar series for runs, read from their TensorBoard event files and kept in memory.
import { EventFileTail } from './tfevents';

/** One event file of a run. `key` stays the same if the file moves (the car archives runs). */
export interface EventSource {
  key: string;
  path: string;
  /** Prepended to every tag from this file, e.g. "eval/" for the car's eval writer. */
  prefix: string;
}

interface Series {
  steps: number[];
  values: number[];
  walls: number[];
}

interface FileEntry {
  tail: EventFileTail;
  prefix: string;
  series: { [tag: string]: Series };
  points: number;
  readAt: number;
  lastUsed: number;
  pending: Promise<void> | null;
}

export interface TagInfo {
  tag: string;
  points: number;
  last_step: number;
  last_value: number;
}

export interface SeriesOut {
  steps: number[];
  values: number[];
  /** Present when points were bucketed: the range each plotted point stands for. */
  min?: number[];
  max?: number[];
  /** Wall-clock seconds of each point (a bucket's last), when asked for. */
  walls?: number[];
}

/** Re-reading a growing file more often than this buys nothing. */
const REFRESH_MS = 2000;
const MAX_CACHED_POINTS = 8000000;

const files: { [key: string]: FileEntry } = Object.create(null);

function totalPoints(): number {
  let n = 0;
  Object.keys(files).forEach((k) => { n += files[k].points; });
  return n;
}

function evict(keep: { [key: string]: boolean }): void {
  let total = totalPoints();
  if (total <= MAX_CACHED_POINTS) return;
  const keys = Object.keys(files)
    .filter((k) => !keep[k])
    .sort((a, b) => files[a].lastUsed - files[b].lastUsed);
  for (const k of keys) {
    if (total <= MAX_CACHED_POINTS) break;
    total -= files[k].points;
    delete files[k];
  }
}

async function refresh(entry: FileEntry): Promise<void> {
  const { points, reset } = await entry.tail.readNew();
  if (reset) {
    entry.series = Object.create(null);
    entry.points = 0;
  }
  for (const p of points) {
    const tag = entry.prefix + p.tag;
    let s = entry.series[tag];
    if (!s) s = entry.series[tag] = { steps: [], values: [], walls: [] };
    s.steps.push(p.step);
    s.values.push(p.value);
    s.walls.push(p.wall);
  }
  entry.points += points.length;
  entry.readAt = Date.now();
}

async function load(source: EventSource, force: boolean): Promise<FileEntry> {
  let entry = files[source.key];
  if (!entry || entry.prefix !== source.prefix) {
    entry = files[source.key] = {
      tail: new EventFileTail(source.path), prefix: source.prefix, series: Object.create(null),
      points: 0, readAt: 0, lastUsed: 0, pending: null,
    };
  }
  entry.tail.path = source.path;
  entry.lastUsed = Date.now();
  if (entry.pending) {
    await entry.pending;
  } else if (force || Date.now() - entry.readAt > REFRESH_MS) {
    entry.pending = refresh(entry)
      .catch((e) => console.warn(`[metrics] ${source.path}: ${e && (e.message || e)}`))
      .then(() => { entry.pending = null; });
    await entry.pending;
  }
  return entry;
}

async function loadAll(sources: EventSource[], force = false): Promise<FileEntry[]> {
  const entries = await Promise.all(sources.map((s) => load(s, force)));
  const keep: { [key: string]: boolean } = Object.create(null);
  sources.forEach((s) => { keep[s.key] = true; });
  evict(keep);
  return entries;
}

/**
 * One tag across a run's files, ordered by step. Where files overlap (a resumed
 * run re-logs steps after its last checkpoint), the later write wins.
 */
function merged(entries: FileEntry[], tag: string): Series {
  const parts = entries.map((e) => e.series[tag]).filter((s) => s && s.steps.length);
  if (parts.length === 1 && isSorted(parts[0].steps)) return parts[0];
  const idx: Array<[number, number, number]> = [];
  for (const s of parts) {
    for (let i = 0; i < s.steps.length; i++) idx.push([s.steps[i], s.walls[i], s.values[i]]);
  }
  idx.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const out: Series = { steps: [], values: [], walls: [] };
  for (let i = 0; i < idx.length; i++) {
    if (i + 1 < idx.length && idx[i + 1][0] === idx[i][0]) continue;
    out.steps.push(idx[i][0]);
    out.walls.push(idx[i][1]);
    out.values.push(idx[i][2]);
  }
  return out;
}

function isSorted(xs: number[]): boolean {
  for (let i = 1; i < xs.length; i++) if (xs[i] <= xs[i - 1]) return false;
  return true;
}

/** Buckets a series down to at most maxPoints, keeping each bucket's mean, min and max. */
export function downsample(steps: number[], values: number[], maxPoints: number, walls?: number[]): SeriesOut {
  const n = steps.length;
  if (n <= maxPoints) {
    const out: SeriesOut = { steps: steps.slice(), values: values.slice() };
    if (walls) out.walls = walls.slice();
    return out;
  }
  const out: SeriesOut = { steps: [], values: [], min: [], max: [] };
  if (walls) out.walls = [];
  for (let b = 0; b < maxPoints; b++) {
    const lo = Math.floor((b * n) / maxPoints);
    const hi = Math.floor(((b + 1) * n) / maxPoints);
    let sum = 0;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = lo; i < hi; i++) {
      const v = values[i];
      sum += v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    out.steps.push(steps[hi - 1]);
    if (walls) out.walls!.push(walls[hi - 1]);
    out.values.push(sum / (hi - lo));
    out.min!.push(mn);
    out.max!.push(mx);
  }
  return out;
}

export async function listTags(sources: EventSource[]): Promise<TagInfo[]> {
  const entries = await loadAll(sources);
  const names: { [tag: string]: boolean } = Object.create(null);
  entries.forEach((e) => Object.keys(e.series).forEach((t) => { names[t] = true; }));
  return Object.keys(names).sort().map((tag) => {
    const s = merged(entries, tag);
    const last = s.steps.length - 1;
    return { tag, points: s.steps.length, last_step: s.steps[last], last_value: s.values[last] };
  });
}

export async function readSeries(
  sources: EventSource[], tags: string[], maxPoints: number, withWalls = false,
): Promise<{ [tag: string]: SeriesOut }> {
  const entries = await loadAll(sources);
  const out: { [tag: string]: SeriesOut } = {};
  for (const tag of tags) {
    const s = merged(entries, tag);
    if (s.steps.length) out[tag] = downsample(s.steps, s.values, maxPoints, withWalls ? s.walls : undefined);
  }
  return out;
}

/** The latest value of one tag, or null when the run never logged it. */
export async function lastValue(sources: EventSource[], tag: string): Promise<number | null> {
  const s = merged(await loadAll(sources), tag);
  return s.values.length ? s.values[s.values.length - 1] : null;
}

/** Total points across a run's files after re-reading them; changes whenever the run logs. */
export async function pointCount(sources: EventSource[]): Promise<number> {
  const entries = await loadAll(sources, true);
  let n = 0;
  entries.forEach((e) => { n += e.points; });
  return n;
}
