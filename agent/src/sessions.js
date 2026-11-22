import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const ID_RE = /^[a-z0-9-]{8,64}$/;

const file = (id) => {
  if (!ID_RE.test(id)) throw Object.assign(new Error('bad session id'), { status: 400 });
  return path.join(config.sessionsDir, `${id}.json`);
};

export function newSession() {
  const now = new Date().toISOString();
  const id = `${now.slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
  return { id, title: '', created: now, updated: now, model: config.model, usage: {}, messages: [] };
}

export async function loadSession(id) {
  try {
    return JSON.parse(await fs.readFile(file(id), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error('no such session'), { status: 404 });
    throw e;
  }
}

/** Written to a temp file first so a full disk can't leave a half-written session. */
export async function saveSession(session) {
  session.updated = new Date().toISOString();
  await fs.mkdir(config.sessionsDir, { recursive: true });
  const target = file(session.id);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(session));
  await fs.rename(`${target}.tmp`, target);
}

export async function deleteSession(id) {
  await fs.rm(file(id), { force: true });
}

export async function listSessions() {
  let names = [];
  try {
    names = await fs.readdir(config.sessionsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const s = JSON.parse(await fs.readFile(path.join(config.sessionsDir, name), 'utf8'));
      out.push({ id: s.id, title: s.title || 'Untitled', created: s.created, updated: s.updated });
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => (a.updated < b.updated ? 1 : -1));
}
