import fs from 'node:fs';
import path from 'node:path';
import { config, REPO_DIR } from './config.js';
import { streamMessage } from './llm.js';

const MAX_RESULT_CHARS = 24_000;
const UI_RESULT_CHARS = 6_000;
export const CONTEXT_TAG = 'page_context';

/** MCP tool listings in the Anthropic tool format, with the last one marked for prompt caching. */
export function toModelTools(mcpTools) {
  const tools = mcpTools.map((t) => {
    const { $schema, ...schema } = t.inputSchema || { type: 'object', properties: {} };
    return {
      name: t.name,
      description: [t.title, t.description].filter(Boolean).join(': ').slice(0, 4000),
      input_schema: { type: 'object', properties: {}, ...schema },
    };
  });
  if (tools.length) tools[tools.length - 1].cache_control = { type: 'ephemeral' };
  return tools;
}

/** MCP result parts (text and images, in order) as Anthropic tool_result content blocks. */
export function toModelContent(parts) {
  let budget = MAX_RESULT_CHARS;
  return parts.map((p) => {
    if (p.type === 'image') return { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } };
    const text = clip(p.text, Math.max(200, budget)) || ' ';
    budget -= text.length;
    return { type: 'text', text };
  });
}

/** Read-only tools run straight away; everything else waits for the user. */
export function needsApproval(tool) {
  return !tool?.annotations?.readOnlyHint;
}

/** One line per robots/<dir>/robot.yaml, from its top-level id, display_name, engine and description. */
function robotLines() {
  const dir = path.join(REPO_DIR, 'robots');
  if (!fs.existsSync(dir)) return [];
  const lines = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'robot.yaml');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const key = (k) => text.match(new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, 'm'))?.[1];
    lines.push(`- **${key('id') ?? name}** (${key('display_name') ?? name}, engine ${key('engine') ?? '?'}, manifest robots/${name}/robot.yaml): ${key('description') ?? ''}`);
  }
  return lines;
}

function systemPrompt(mcpTools) {
  const base = fs.existsSync(config.promptFile) ? fs.readFileSync(config.promptFile, 'utf8') : '';
  const today = new Date().toISOString().slice(0, 10);
  const gated = mcpTools.filter(needsApproval).map((t) => t.name).join(', ');
  const robots = robotLines();
  return [
    base,
    robots.length ? `## Robots registered now\n${robots.join('\n')}` : '',
    `Today is ${today}. Tools that change things and so wait for the user's approval: ${gated}.`,
  ].filter(Boolean).join('\n\n');
}

function contextBlock(context) {
  if (!context || typeof context !== 'object') return null;
  const lines = Object.entries(context)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return lines.length ? { type: 'text', text: `<${CONTEXT_TAG}>\n${lines.join('\n')}\n</${CONTEXT_TAG}>` } : null;
}

/**
 * Make the history valid to send again after an interrupted turn: tool calls
 * without results get a "cancelled" result, and the next user content joins
 * a trailing user message instead of following it.
 */
export function appendUserContent(messages, content) {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    const open = last.content.filter((b) => b.type === 'tool_use');
    if (open.length) {
      messages.push({
        role: 'user',
        content: open.map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: 'Cancelled by the user.', is_error: true })),
      });
    }
  }
  const tail = messages[messages.length - 1];
  if (tail?.role === 'user') tail.content.push(...content);
  else messages.push({ role: 'user', content });
}

/** The history with a cache breakpoint on its last block, without touching the stored copy. */
function withCacheBreakpoint(messages) {
  const out = messages.slice();
  const last = out[out.length - 1];
  if (!last) return out;
  const content = last.content.slice();
  content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
  out[out.length - 1] = { ...last, content };
  return out;
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters cut]` : text;
}

/**
 * Run one user turn to completion: stream the model, run the tools it asks
 * for (asking `approve` first where needed), and loop until it stops.
 * `emit` receives the UI events; `session` is mutated and should be saved after.
 */
export async function runTurn({ session, text, context, mcp, emit, approve, signal }) {
  const mcpTools = await mcp.listTools();
  const byName = new Map(mcpTools.map((t) => [t.name, t]));
  const tools = toModelTools(mcpTools);
  const system = [{ type: 'text', text: systemPrompt(mcpTools), cache_control: { type: 'ephemeral' } }];

  const ctx = contextBlock(context);
  appendUserContent(session.messages, [...(ctx ? [ctx] : []), { type: 'text', text }]);
  if (!session.title) session.title = text.replace(/\s+/g, ' ').trim().slice(0, 80);

  for (let step = 0; step < config.maxSteps; step++) {
    const reply = await streamMessage({
      apiKey: config.anthropicKey,
      model: session.model || config.model,
      maxTokens: config.maxTokens,
      system,
      tools,
      messages: withCacheBreakpoint(session.messages),
      signal,
      onText: (delta) => emit({ type: 'text', text: delta }),
    });
    session.messages.push({ role: 'assistant', content: reply.content });
    for (const [k, v] of Object.entries(reply.usage)) session.usage[k] = (session.usage[k] || 0) + (v || 0);
    emit({ type: 'usage', usage: session.usage });

    const calls = reply.content.filter((b) => b.type === 'tool_use');
    if (reply.stop_reason !== 'tool_use' || !calls.length) {
      emit({ type: 'done', stop_reason: reply.stop_reason });
      return;
    }

    const results = [];
    for (const call of calls) {
      const tool = byName.get(call.name);
      const gated = needsApproval(tool);
      emit({ type: 'tool_call', id: call.id, name: call.name, input: call.input, approval: gated ? 'pending' : 'auto' });
      let out;
      if (!tool) {
        out = { text: `Unknown tool ${call.name}.`, isError: true };
      } else if (gated && !(await approve(call))) {
        out = { text: 'The user declined this tool call. Ask what they would like instead.', isError: true };
      } else {
        try {
          out = await mcp.callTool(call.name, call.input);
        } catch (e) {
          out = { text: `Tool failed: ${e.message}`, isError: true };
        }
      }
      if (signal?.aborted) throw signal.reason ?? new Error('stopped');
      const images = out.images || [];
      emit({
        type: 'tool_result', id: call.id, ok: !out.isError, text: clip(out.text, UI_RESULT_CHARS),
        ...(images.length ? { images: images.map((p) => `data:${p.mimeType};base64,${p.data}`) } : {}),
      });
      const content = images.length ? toModelContent(out.parts) : (clip(out.text, MAX_RESULT_CHARS) || '(no output)');
      results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(out.isError ? { is_error: true } : {}) });
    }
    session.messages.push({ role: 'user', content: results });
  }
  emit({ type: 'done', stop_reason: 'max_steps', note: `Stopped after ${config.maxSteps} steps; say "continue" to carry on.` });
}
