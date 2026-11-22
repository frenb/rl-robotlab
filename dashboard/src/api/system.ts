// What the stack is doing: worker heartbeats, the queue, Mongo, disk, the
// Unity clients' desired gym, gym releases, and the workers' shared log files.
//
// The dashboard container sees only its volumes (./dashboard, ./rl_agent,
// ./robots, ../saved_models, the tmpdata volume on /tmp) and no Docker
// socket, so Unity processes, local gym builds and packaging stay with the
// MCP console tools that run on the Windows host (get_unity_clients,
// set_unity_clients, list_gym_builds, package_gym, add_gym_to_release).
import * as express from 'express';
import * as fs from 'fs';
import { HttpError, intParam, iso, route } from './http';
import { queuePaused } from './queue';
import { CAR_TRAINER_LOG } from './carlogs';
import { Context, summarize, SUMMARY_PROJECTION } from './runs';

const LOG_TAIL_BYTES = 64 * 1024;
const LOG_MAX_BYTES = 256 * 1024;
const HEARTBEAT_TTL_MS = 120 * 1000; // rl_agent/job_queue.py HEARTBEAT_TTL_S
const RELEASES_TTL_MS = 5 * 60 * 1000;
const RELEASES_SHOWN = 10;
const GITHUB_REPO = process.env.ROBORACER_GITHUB_REPO || 'frenb/rl-robotlab';
const STARTED_AT = new Date();
const COUNTED = ['jobs', 'models', 'logs', 'proposals', 'curricula', 'gyms', 'reward_designs', 'experiment_designs'];
const VOLUMES = [
  { path: '/saved_models', label: 'Saved models', about: 'Checkpoints, exports, job logs and clips (../saved_models)' },
  { path: '/tmp', label: 'Shared tmp', about: 'Live trainer logs and car event files (tmpdata volume)' },
];

/**
 * The workers' shared output, as the dashboard sees it on tmpdata. The duck
 * and beni workers truncate theirs at the start of each job.
 */
export const SERVICE_LOGS: { [id: string]: { label: string; path: string; about: string; robot: string } } = {
  car: { label: 'Car trainer', path: CAR_TRAINER_LOG, robot: 'roboracer', about: 'robotaxi.py in sim-controller, piped through tee' },
  microduck: { label: 'MicroDuck worker', path: '/tmp/duck_trainer.log', robot: 'microduck', about: 'Current job only; truncated when a job starts' },
  openbeni: { label: 'OpenBeni worker', path: '/tmp/beni_trainer.log', robot: 'openbeni', about: 'Current job only; truncated when a job starts' },
};

export interface LogChunk { available: boolean; note?: string | null; start: number; end: number; size?: number; text: string; reset?: boolean }

/**
 * A slice of a growing log file: from `offset` when given (up to 256 KB),
 * else the last 64 KB from a line boundary. Never reads before `floor`;
 * reset means the asked offset is gone (file truncated or rotated).
 */
export async function readLogChunk(file: string, floor: number, offset: number | null, note?: string | null): Promise<LogChunk> {
  let size = 0;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch (e) {
    return { available: false, note: 'The log file is gone.', start: 0, end: 0, text: '' };
  }
  const low = Math.min(floor, size);
  const start = offset != null && offset <= size && offset >= low ? offset : Math.max(low, size - LOG_TAIL_BYTES);
  const end = Math.min(size, start + LOG_MAX_BYTES);
  const buf = Buffer.alloc(end - start);
  if (end > start) {
    const fh = await fs.promises.open(file, 'r');
    try {
      await fh.read(buf, 0, end - start, start);
    } finally {
      await fh.close();
    }
  }
  let text = buf.toString('utf8');
  let from = start;
  if (offset == null && start > low) {
    // Drop the partial first line of a tail.
    const nl = text.indexOf('\n');
    if (nl >= 0) {
      from = start + Buffer.byteLength(text.slice(0, nl + 1));
      text = text.slice(nl + 1);
    }
  }
  return { available: true, note: note || null, start: from, end, size, text, reset: offset != null && (offset > size || offset < low) };
}

async function fileInfo(file: string) {
  try {
    const st = await fs.promises.stat(file);
    return { exists: true, size: st.size, modified_at: st.mtime.toISOString() };
  } catch (e) {
    return { exists: false, size: 0, modified_at: null as string | null };
  }
}

async function volume(path: string) {
  const statfs = (fs.promises as any).statfs;
  if (!statfs) return null;
  try {
    const s = await statfs(path);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total_bytes: total, free_bytes: free, used_bytes: total - s.bfree * s.bsize };
  } catch (e) {
    return null;
  }
}

let releasesCache: { at: number; body: any } | null = null;

/** The repo's GitHub releases with their assets, cached for a few minutes. GITHUB_TOKEN lifts rate limits and reaches a private repo. */
async function releases(force: boolean) {
  if (!force && releasesCache && Date.now() - releasesCache.at < RELEASES_TTL_MS) return releasesCache.body;
  const headers: { [k: string]: string } = { Accept: 'application/vnd.github+json', 'User-Agent': 'rl-robotlab-dashboard' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let body: any;
  try {
    const res = await (globalThis as any).fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=${RELEASES_SHOWN}`, { headers });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const why = res.status === 404 ? 'not found (a private repo needs GITHUB_TOKEN on the dashboard)' : (data && data.message) || res.statusText;
      body = { repo: GITHUB_REPO, ok: false, error: `GitHub answered ${res.status}: ${why}`, items: [] };
    } else {
      body = {
        repo: GITHUB_REPO,
        ok: true,
        items: (data || []).map((r: any) => ({
          tag: r.tag_name, name: r.name || r.tag_name, url: r.html_url, draft: !!r.draft, prerelease: !!r.prerelease,
          published_at: r.published_at || null,
          assets: (r.assets || []).map((a: any) => ({ name: a.name, size: a.size, downloads: a.download_count, url: a.browser_download_url, updated_at: a.updated_at })),
        })),
      };
    }
  } catch (e) {
    body = { repo: GITHUB_REPO, ok: false, error: `Couldn't reach GitHub: ${String((e && (e as any).message) || e)}`, items: [] };
  }
  releasesCache = { at: Date.now(), body: { ...body, fetched_at: new Date().toISOString() } };
  return releasesCache.body;
}

export function mountSystem(api: express.Router, ctx: Context, db: () => any, desiredGyms: () => { [index: string]: any }) {
  api.get('/system', route(async () => {
    const d = db();
    const now = Date.now();
    const pingStart = Date.now();
    let mongo: any;
    try {
      await d.command({ ping: 1 });
      const ping_ms = Date.now() - pingStart;
      const [stats, counts] = await Promise.all([
        d.stats().catch(() => null),
        Promise.all(COUNTED.map((c) => d.collection(c).estimatedDocumentCount().catch(() => null))),
      ]);
      mongo = {
        ok: true, ping_ms,
        data_bytes: stats ? stats.dataSize : null, storage_bytes: stats ? stats.storageSize : null, index_bytes: stats ? stats.indexSize : null,
        collections: COUNTED.map((c, i) => ({ name: c, count: counts[i] })),
      };
    } catch (e) {
      mongo = { ok: false, error: String((e && (e as any).message) || e) };
    }

    const [workers, running, queued, paused, volumes, logs] = await Promise.all([
      d.collection('workers').find({}).toArray(),
      d.collection('jobs').find({ status: { $in: ['IN_PROGRESS', 'PAUSE_REQUESTED'] } }, { projection: SUMMARY_PROJECTION }).toArray(),
      d.collection('jobs').countDocuments({ status: 'NOT_STARTED' }),
      queuePaused(d),
      Promise.all(VOLUMES.map(async (v) => ({ ...v, ...(await volume(v.path)) }))),
      Promise.all(Object.keys(SERVICE_LOGS).map(async (id) => ({ id, ...SERVICE_LOGS[id], ...(await fileInfo(SERVICE_LOGS[id].path)) }))),
    ]);
    const robots = ctx.robots();
    const ids = robots.map((r) => r.id);
    workers.forEach((w: any) => { if (ids.indexOf(String(w._id)) < 0) ids.push(String(w._id)); });

    const gyms = desiredGyms();
    return {
      dashboard: { started_at: STARTED_AT.toISOString(), node: process.version, pid: process.pid },
      mongo,
      queue: { paused, queued, running: running.length },
      workers: ids.map((id) => {
        const r = robots.find((x) => x.id === id);
        const w = workers.find((x: any) => String(x._id) === id);
        const seen = w && w.last_seen ? new Date(w.last_seen).getTime() : null;
        const jobs = running.filter((j: any) => (j.robot || 'roboracer') === id);
        return {
          robot: id,
          display_name: (r && r.display_name) || id,
          registered: !!r,
          online: seen != null && now - seen < HEARTBEAT_TTL_MS,
          last_seen: seen != null ? new Date(seen).toISOString() : null,
          host: (w && w.host) || null,
          running: jobs.map((j: any) => summarize(ctx, j)),
        };
      }),
      volumes,
      logs,
      unity: {
        desired: Object.keys(gyms).sort().map((index) => ({ index, ...gyms[index], set_at: iso(gyms[index].set_at) })),
      },
    };
  }));

  api.get('/system/logs/:service', route(async (req) => {
    const svc = SERVICE_LOGS[req.params.service];
    if (!svc) throw new HttpError(404, `service must be one of ${Object.keys(SERVICE_LOGS).join(', ')}`);
    const offset = req.query.offset != null ? intParam(req.query.offset, 0, 0, 1e15) : null;
    return readLogChunk(svc.path, 0, offset, svc.about);
  }));

  api.get('/system/releases', route(async (req) => releases(req.query.refresh === '1')));
}
