// /api/v1/live: one WebSocket per app tab, on the same port as the HTTP API.
//
// Server -> client:
//   {type: 'run.updated', run}        any job inserted or changed (run = runs.summarize)
//   {type: 'run.deleted', id}
//   {type: 'metrics.changed', id, points}  a subscribed run logged new scalars
//   {type: 'heartbeat', t}
// Client -> server:
//   {type: 'subscribe', runs: [id, ...]}   replaces the tab's metric subscriptions
import { Server } from 'http';
import { pointCount } from './metrics';
import { Context, eventSources, summarize } from './runs';
import { idFilter } from './http';

const WebSocket = require('ws');

const METRICS_POLL_MS = 5000;
const HEARTBEAT_MS = 30000;
const MAX_SUBSCRIBED_RUNS = 16;

export function attachLive(server: Server, ctx: Context): void {
  const wss = new WebSocket.Server({ server, path: '/api/v1/live' });
  const subs = new Map<any, string[]>();
  const lastPoints: { [id: string]: number } = Object.create(null);

  const send = (ws: any, msg: any) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch (e) { /* closed mid-send */ }
    }
  };
  const broadcast = (msg: any) => subs.forEach((_runs, ws) => send(ws, msg));

  wss.on('connection', (ws: any) => {
    subs.set(ws, []);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data: any) => {
      let msg: any;
      try { msg = JSON.parse(String(data)); } catch (e) { return; }
      if (msg && msg.type === 'subscribe' && Array.isArray(msg.runs)) {
        subs.set(ws, msg.runs.map(String).slice(0, MAX_SUBSCRIBED_RUNS));
      }
    });
    ws.on('close', () => subs.delete(ws));
    ws.on('error', () => subs.delete(ws));
  });

  setInterval(() => {
    wss.clients.forEach((ws: any) => {
      if (ws.isAlive === false) {
        subs.delete(ws);
        try { ws.terminate(); } catch (e) { /* already gone */ }
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* closing */ }
      send(ws, { type: 'heartbeat', t: Date.now() });
    });
  }, HEARTBEAT_MS);

  let polling = false;
  setInterval(async () => {
    if (polling || !ctx.db() || !subs.size) return;
    polling = true;
    try {
      const wanted: { [id: string]: boolean } = Object.create(null);
      subs.forEach((runs) => runs.forEach((id) => { wanted[id] = true; }));
      for (const id of Object.keys(wanted)) {
        const job = await ctx.db().collection('jobs').findOne(idFilter(id), { projection: { reward_design_code: 0 } });
        if (!job) continue;
        const points = await pointCount(await eventSources(ctx, job));
        if (points === lastPoints[id]) continue;
        const first = lastPoints[id] === undefined;
        lastPoints[id] = points;
        if (first) continue;
        subs.forEach((runs, ws) => {
          if (runs.indexOf(id) >= 0) send(ws, { type: 'metrics.changed', id, points });
        });
      }
    } catch (e) {
      console.warn('[api/v1 live] metrics poll failed:', e && ((e as any).message || e));
    } finally {
      polling = false;
    }
  }, METRICS_POLL_MS);

  watchJobs(ctx, (change) => {
    if (change.operationType === 'delete') {
      broadcast({ type: 'run.deleted', id: String(change.documentKey && change.documentKey._id) });
    } else if (change.fullDocument) {
      broadcast({ type: 'run.updated', run: summarize(ctx, change.fullDocument) });
    }
  });
}

/** Tails the jobs collection, reopening the change stream whenever it dies. */
function watchJobs(ctx: Context, onChange: (change: any) => void): void {
  const open = () => {
    const db = ctx.db();
    if (!db) {
      setTimeout(open, 1000);
      return;
    }
    let reopened = false;
    const reopen = (why: string) => {
      if (reopened) return;
      reopened = true;
      console.warn(`[api/v1 live] jobs stream ${why}; reopening`);
      try { Promise.resolve(stream.close()).catch(() => {}); } catch (e) { /* already closed */ }
      setTimeout(open, 2000);
    };
    let stream: any;
    try {
      stream = db.collection('jobs').watch([], { fullDocument: 'updateLookup' });
    } catch (e) {
      setTimeout(open, 2000);
      return;
    }
    stream.on('change', (change: any) => {
      try { onChange(change); } catch (e) { console.warn('[api/v1 live] change handler failed:', e); }
    });
    stream.on('error', (e: any) => reopen(`error: ${e && (e.message || e)}`));
    stream.on('close', () => reopen('closed'));
  };
  open();
}
