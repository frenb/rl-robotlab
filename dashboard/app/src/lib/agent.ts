import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

/** The agent bridge runs on this machine (agent/, `npm start`), not in the dashboard container. */
export const AGENT_URL = localStorage.getItem('agentUrl') || 'http://127.0.0.1:8790';
const SESSION_KEY = 'agentSession';
const CONTEXT_PREFIX = '<page_context>';

export interface AgentStatus {
  ok: boolean;
  model: string;
  key: boolean;
  tools: number;
  mcp: 'ok' | 'error';
  error?: string;
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  created: string;
  updated: string;
}

export type Approval = 'auto' | 'pending' | 'approved' | 'declined';

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; approval: Approval; result?: { ok: boolean; text: string; images?: string[] } }
  | { kind: 'error'; text: string };

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | ResultPart[]; is_error?: boolean }
  | { type: string };

type ResultPart = { type: string; text?: string; source?: { media_type: string; data: string } };

interface StoredSession {
  id: string;
  title: string;
  usage: Usage;
  running?: boolean;
  messages: { role: 'user' | 'assistant'; content: Block[] }[];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(AGENT_URL + path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body as T;
}

export function useAgentStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['agent', 'status'],
    queryFn: () => call<AgentStatus>('/status'),
    enabled,
    retry: false,
    refetchInterval: (q) => (q.state.status === 'error' ? 5_000 : 30_000),
  });
}

export function useAgentSessions(enabled: boolean) {
  return useQuery({ queryKey: ['agent', 'sessions'], queryFn: () => call<AgentSessionSummary[]>('/sessions'), enabled, retry: false });
}

const DECLINED = 'The user declined';
const resultText = (c: Extract<Block, { type: 'tool_result' }>['content']) =>
  typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
const resultImages = (c: Extract<Block, { type: 'tool_result' }>['content']) =>
  typeof c === 'string' ? [] : c.flatMap((p) => (p.type === 'image' && p.source ? [`data:${p.source.media_type};base64,${p.source.data}`] : []));

/** A stored conversation as chat items: page context hidden, tool results folded into their calls. */
export function toItems(session: StoredSession): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>();
  for (const m of session.messages) {
    for (const b of m.content) {
      if (b.type === 'text') {
        const text = (b as { text: string }).text;
        if (m.role === 'user' && !text.startsWith(CONTEXT_PREFIX)) items.push({ kind: 'user', text });
        else if (m.role === 'assistant' && text.trim()) items.push({ kind: 'text', text });
      } else if (b.type === 'tool_use') {
        const u = b as Extract<Block, { type: 'tool_use' }>;
        const item: ChatItem = { kind: 'tool', id: u.id, name: u.name, input: u.input, approval: 'auto' };
        tools.set(u.id, item);
        items.push(item);
      } else if (b.type === 'tool_result') {
        const r = b as Extract<Block, { type: 'tool_result' }>;
        const item = tools.get(r.tool_use_id);
        if (!item) continue;
        const text = resultText(r.content);
        const images = resultImages(r.content);
        item.result = { ok: !r.is_error, text, ...(images.length ? { images } : {}) };
        if (text.startsWith(DECLINED)) item.approval = 'declined';
      }
    }
  }
  return items;
}

type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; approval: 'auto' | 'pending' }
  | { type: 'tool_result'; id: string; ok: boolean; text: string; images?: string[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stop_reason: string; note?: string }
  | { type: 'error'; message: string };

function apply(items: ChatItem[], e: AgentEvent): ChatItem[] {
  const last = items[items.length - 1];
  switch (e.type) {
    case 'text':
      return last?.kind === 'text' ? [...items.slice(0, -1), { ...last, text: last.text + e.text }] : [...items, { kind: 'text', text: e.text }];
    case 'tool_call':
      return [...items, { kind: 'tool', id: e.id, name: e.name, input: e.input, approval: e.approval }];
    case 'tool_result':
      return items.map((it) => (it.kind === 'tool' && it.id === e.id
        ? { ...it, result: { ok: e.ok, text: e.text, ...(e.images?.length ? { images: e.images } : {}) }, approval: it.approval === 'pending' ? (e.text.startsWith(DECLINED) ? 'declined' : 'approved') : it.approval }
        : it));
    case 'done':
      return e.note ? [...items, { kind: 'text', text: e.note }] : items;
    case 'error':
      return [...items, { kind: 'error', text: e.message }];
    default:
      return items;
  }
}

/** One chat with the bridge: its items, streaming state, and the actions the panel needs. */
export function useAgentChat() {
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem(SESSION_KEY));
  const [items, setItems] = useState<ChatItem[]>([]);
  const [usage, setUsage] = useState<Usage>({});
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const open = useCallback(async (id: string | null) => {
    abort.current?.abort();
    setSessionId(id);
    setItems([]);
    setUsage({});
    setLoadError(null);
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
    if (!id) return;
    try {
      const s = await call<StoredSession>(`/sessions/${id}`);
      setItems(toItems(s));
      setUsage(s.usage || {});
    } catch (e) {
      if ((e as Error).message === 'no such session') open(null);
      else setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (sessionId) open(sessionId);
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(async (text: string, context: Record<string, unknown>) => {
    let id = sessionId;
    setBusy(true);
    setItems((xs) => [...xs, { kind: 'user', text }]);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      if (!id) {
        id = (await call<{ id: string }>('/sessions', { method: 'POST' })).id;
        setSessionId(id);
        localStorage.setItem(SESSION_KEY, id);
      }
      const res = await fetch(`${AGENT_URL}/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, context }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${res.status} ${res.statusText}`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let cut;
        while ((cut = buf.indexOf('\n')) >= 0) {
          const e = JSON.parse(buf.slice(0, cut)) as AgentEvent;
          buf = buf.slice(cut + 1);
          if (e.type === 'usage') setUsage(e.usage);
          else setItems((xs) => apply(xs, e));
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setItems((xs) => [...xs, { kind: 'error', text: `Couldn't reach the assistant: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['agent', 'sessions'] });
    }
  }, [sessionId, qc]);

  const stop = useCallback(() => {
    if (sessionId) call(`/sessions/${sessionId}/stop`, { method: 'POST' }).catch(() => {});
  }, [sessionId]);

  const decide = useCallback(async (toolId: string, allow: boolean) => {
    if (!sessionId) return;
    setItems((xs) => xs.map((it) => (it.kind === 'tool' && it.id === toolId ? { ...it, approval: allow ? 'approved' : 'declined' } : it)));
    try {
      await call(`/sessions/${sessionId}/approve`, { method: 'POST', body: JSON.stringify({ id: toolId, allow }) });
    } catch (e) {
      setItems((xs) => [...xs, { kind: 'error', text: (e as Error).message }]);
    }
  }, [sessionId]);

  const remove = useCallback(async (id: string) => {
    await call(`/sessions/${id}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['agent', 'sessions'] });
    if (id === sessionId) open(null);
  }, [sessionId, open, qc]);

  return { sessionId, items, usage, busy, loadError, open, send, stop, decide, remove };
}
