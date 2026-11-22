import http from 'node:http';
import { runTurn } from './agent.js';
import { config, REPO_DIR } from './config.js';
import { McpClient } from './mcp.js';
import { deleteSession, listSessions, loadSession, newSession, saveSession } from './sessions.js';

const mcp = new McpClient({
  name: 'roboracer-console',
  command: process.execPath,
  args: [config.consoleEntry],
  env: { ROBORACER_DASHBOARD_URL: config.dashboardUrl },
  cwd: REPO_DIR,
});

/** sessionId -> { controller, approvals: Map<toolUseId, resolve> } while a turn runs. */
const running = new Map();

const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);

function cors(req) {
  const origin = req.headers.origin;
  const h = { vary: 'Origin' };
  if (origin && config.origins.includes(origin)) {
    Object.assign(h, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-private-network': 'true',
    });
  }
  return h;
}

function send(req, res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...cors(req) });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

async function status() {
  try {
    const tools = await mcp.listTools();
    return { ok: Boolean(config.anthropicKey), model: config.model, key: Boolean(config.anthropicKey), tools: tools.length, mcp: 'ok' };
  } catch (e) {
    return { ok: false, model: config.model, key: Boolean(config.anthropicKey), tools: 0, mcp: 'error', error: e.message };
  }
}

async function streamTurn(req, res, id) {
  if (running.has(id)) return send(req, res, 409, { error: 'this chat is already answering' });
  if (!config.anthropicKey) return send(req, res, 503, { error: 'ANTHROPIC_API_KEY is not set in .env' });
  const { text, context } = await readJson(req);
  if (typeof text !== 'string' || !text.trim()) return send(req, res, 400, { error: 'text is required' });
  const session = await loadSession(id);

  const run = { controller: new AbortController(), approvals: new Map() };
  const { signal } = run.controller;
  running.set(id, run);
  let finished = false;

  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', ...cors(req) });
  const emit = (e) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(e)}\n`);
  };
  res.on('close', () => {
    if (!finished) run.controller.abort(new Error('the page closed the connection'));
  });
  const approve = (call) => new Promise((resolve) => {
    run.approvals.set(call.id, resolve);
    signal.addEventListener('abort', () => resolve(false), { once: true });
  });

  try {
    await runTurn({ session, text: text.trim(), context, mcp, emit, approve, signal });
  } catch (e) {
    emit({ type: 'error', message: signal.aborted ? 'Stopped.' : e.message });
  } finally {
    finished = true;
    running.delete(id);
    try {
      await saveSession(session);
    } catch (e) {
      emit({ type: 'error', message: `Could not save the chat: ${e.message}` });
    }
    res.end();
  }
}

async function route(req, res) {
  if (!allowedHosts.has(req.headers.host || '')) return send(req, res, 403, { error: 'bad host' });
  const origin = req.headers.origin;
  if (origin && !config.origins.includes(origin)) return send(req, res, 403, { error: `origin ${origin} not allowed` });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req));
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const [a, id, action] = parts;

  if (req.method === 'GET' && url.pathname === '/status') return send(req, res, 200, await status());
  if (a !== 'sessions') return send(req, res, 404, { error: 'not found' });

  if (!id) {
    if (req.method === 'GET') return send(req, res, 200, await listSessions());
    if (req.method === 'POST') {
      const s = newSession();
      await saveSession(s);
      return send(req, res, 200, s);
    }
  } else if (!action) {
    if (req.method === 'GET') return send(req, res, 200, { ...(await loadSession(id)), running: running.has(id) });
    if (req.method === 'DELETE') {
      running.get(id)?.controller.abort(new Error('deleted'));
      await deleteSession(id);
      return send(req, res, 200, { ok: true });
    }
  } else if (req.method === 'POST' && action === 'messages') {
    return streamTurn(req, res, id);
  } else if (req.method === 'POST' && action === 'approve') {
    const { id: callId, allow } = await readJson(req);
    const resolve = running.get(id)?.approvals.get(callId);
    if (!resolve) return send(req, res, 404, { error: 'nothing is waiting for that approval' });
    running.get(id).approvals.delete(callId);
    resolve(Boolean(allow));
    return send(req, res, 200, { ok: true });
  } else if (req.method === 'POST' && action === 'stop') {
    running.get(id)?.controller.abort(new Error('stopped'));
    return send(req, res, 200, { ok: true });
  }
  return send(req, res, 405, { error: 'method not allowed' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (res.headersSent) return res.end();
    send(req, res, e.status || 500, { error: e.message });
  });
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE'
    ? `Port ${config.port} is taken: the bridge is probably already running. Set AGENT_PORT to use another port.`
    : e.message);
  process.exit(1);
});

server.listen(config.port, config.host, async () => {
  console.log(`robot-lab agent bridge on http://${config.host}:${config.port} (model ${config.model})`);
  if (!config.anthropicKey) console.warn('ANTHROPIC_API_KEY is not set; chats will be refused.');
  const s = await status();
  console.log(s.mcp === 'ok' ? `roboracer-console: ${s.tools} tools` : `roboracer-console failed to start: ${s.error}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    mcp.close();
    server.close();
    process.exit(0);
  });
}
