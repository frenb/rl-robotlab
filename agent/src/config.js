import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = path.resolve(AGENT_DIR, '..');

/** KEY=value lines from the repo's .env; the process environment wins. */
function readDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const env = { ...readDotEnv(path.join(REPO_DIR, '.env')), ...process.env };

export const config = {
  host: '127.0.0.1',
  port: Number(env.AGENT_PORT || 8790),
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  model: env.AGENT_MODEL || 'claude-opus-5-5',
  maxTokens: Number(env.AGENT_MAX_TOKENS || 8000),
  maxSteps: Number(env.AGENT_MAX_STEPS || 30),
  dashboardUrl: env.ROBORACER_DASHBOARD_URL || 'http://localhost',
  consoleEntry: path.join(REPO_DIR, 'mcp', 'console', 'src', 'index.js'),
  sessionsDir: path.join(AGENT_DIR, '.sessions'),
  promptFile: path.join(AGENT_DIR, 'prompt.md'),
  // Pages that may talk to the bridge: the dashboard and the Vite dev server.
  origins: (env.AGENT_ORIGINS || 'http://localhost,http://127.0.0.1,http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map((s) => s.trim()).filter(Boolean),
};
