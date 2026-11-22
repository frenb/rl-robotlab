import { spawn } from 'node:child_process';
import readline from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';

/**
 * A minimal MCP client for one stdio server: newline-delimited JSON-RPC.
 * The server process is (re)started on demand, so a crash costs one failed call.
 */
export class McpClient {
  constructor({ name, command, args = [], env = {}, cwd }) {
    Object.assign(this, { name, command, args, env, cwd });
    this.child = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = this.#boot().catch((e) => {
      this.#teardown(e);
      throw e;
    });
    return this.ready;
  }

  async #boot() {
    const child = spawn(this.command, this.args, {
      cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.#onLine(line));
    child.stderr.on('data', (d) => process.stderr.write(`[${this.name}] ${d}`));
    child.on('exit', (code) => this.#teardown(new Error(`${this.name} exited (${code})`)));
    child.on('error', (e) => this.#teardown(e));

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'robot-lab-agent', version: '0.1.0' },
    }, 30_000);
    this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const tools = [];
    let cursor;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {}, 30_000);
      tools.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = tools;
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id) && (msg.result !== undefined || msg.error)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method === 'ping' && msg.id != null) {
      this.#send({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method && msg.id != null) {
      this.#send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } });
    }
  }

  #send(msg) {
    if (!this.child?.stdin.writable) throw new Error(`${this.name} is not running`);
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  #teardown(err) {
    if (!this.child && !this.ready) return;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    try {
      this.child?.kill();
    } catch { /* already gone */ }
    this.child = null;
    this.ready = null;
  }

  request(method, params, timeoutMs = 300_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async listTools() {
    await this.start();
    return this.tools;
  }

  /** `{ text, images, parts, isError }`: text joined, images as `{ mimeType, data }`, parts in the tool's own order. */
  async callTool(name, args) {
    await this.start();
    const res = await this.request('tools/call', { name, arguments: args ?? {} });
    const parts = (res.content || []).map((c) => {
      if (c.type === 'text') return { type: 'text', text: c.text };
      if (c.type === 'image' && c.data) return { type: 'image', mimeType: c.mimeType || 'image/png', data: c.data };
      return { type: 'text', text: `[${c.type} content]` };
    });
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const images = parts.filter((p) => p.type === 'image');
    return { text, images, parts, isError: Boolean(res.isError) };
  }

  close() {
    this.#teardown(new Error('closed'));
  }
}
