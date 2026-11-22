import { useRouterState } from '@tanstack/react-router';
import { Check, ChevronRight, CircleAlert, Hand, History, Plus, Send, Sparkles, Square, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AGENT_URL, useAgentChat, useAgentSessions, useAgentStatus, type ChatItem } from '../../lib/agent';
import { useSelectedRobot } from '../../lib/robots';
import { cn } from '../../lib/utils';
import { Button, Spinner } from '../ui';
import { Markdown } from './Markdown';

function suggestionsFor(path: string): string[] {
  if (/\/runs\/[^/]+$/.test(path) && !path.endsWith('/new')) return ['How did this run go?', 'Where does it crash or slow down?', 'Are its models better than the current best?'];
  if (/\/models\/[^/]+$/.test(path)) return ['How good is this model, with confidence?', 'How does it compare with the leaderboard leader?'];
  if (/\/lab\/[^/]+$/.test(path)) return ['Summarize this proposal. Should I approve it?'];
  if (path.includes('/insights')) return ['What are the hardest sections on this run, and why?'];
  if (path.includes('/system')) return ['Is anything unhealthy right now?'];
  return ["What's running right now?", 'Which model is best on the leaderboard?', 'Anything I should look at today?'];
}

const tokens = (n?: number) => (n == null ? '0' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function ToolCard({ item, onDecide }: { item: Extract<ChatItem, { kind: 'tool' }>; onDecide: (allow: boolean) => void }) {
  const pending = item.approval === 'pending' && !item.result;
  const [open, setOpen] = useState(false);
  const expanded = open || pending;
  const running = !item.result && !pending && item.approval !== 'declined';
  return (
    <div className={cn('rounded-lg border text-xs', pending && 'border-amber-500/60 bg-amber-500/5')}>
      <button onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left">
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
        <span className="font-mono">{item.name}</span>
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          {pending ? (
            <><Hand className="h-3 w-3 text-amber-600" /> needs approval</>
          ) : item.approval === 'declined' ? (
            <><X className="h-3 w-3" /> declined</>
          ) : running ? (
            <Spinner className="h-3 w-3" />
          ) : item.result?.ok ? (
            <Check className="h-3 w-3 text-emerald-600" />
          ) : (
            <><CircleAlert className="h-3 w-3 text-rose-600" /> failed</>
          )}
        </span>
      </button>
      {!!item.result?.images?.length && (
        <div className="grid grid-cols-3 gap-1 border-t p-1.5">
          {item.result.images.map((src, i) => (
            <img key={i} src={src} alt={`frame ${i + 1}`} className="w-full rounded border" />
          ))}
        </div>
      )}
      {expanded && (
        <div className="space-y-2 border-t px-2.5 py-2">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{JSON.stringify(item.input, null, 2)}</pre>
          {item.result && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t pt-2 font-mono text-[11px]">{item.result.text}</pre>
          )}
          {pending && (
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={() => onDecide(true)}>Approve</Button>
              <Button size="sm" onClick={() => onDecide(false)}>Decline</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Offline({ error }: { error?: string }) {
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-4 text-sm">
      <p className="font-medium">The assistant isn't running</p>
      <p className="text-muted-foreground">
        It runs on this computer, next to the dashboard. Start it from the repo with:
      </p>
      <pre className="rounded bg-muted px-2 py-1.5 font-mono text-xs">cd agent{'\n'}npm start</pre>
      <p className="text-xs text-muted-foreground">Looking for it at {AGENT_URL}{error ? ` (${error})` : ''}.</p>
    </div>
  );
}

export function AgentPanel({ hidden, onClose }: { hidden: boolean; onClose: () => void }) {
  const status = useAgentStatus(!hidden);
  const [showHistory, setShowHistory] = useState(false);
  const sessions = useAgentSessions(showHistory);
  const chat = useAgentChat();
  const [robot] = useSelectedRobot();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const online = status.data?.mcp === 'ok' && status.data.key;

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.items]);
  useEffect(() => {
    if (!hidden) input.current?.focus();
  }, [chat.sessionId, hidden]);

  const submit = (text = draft) => {
    const t = text.trim();
    if (!t || chat.busy) return;
    setDraft('');
    chat.send(t, {
      page: window.location.pathname + window.location.search,
      robot: robot || 'all robots',
      title: document.title,
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <aside className={cn('fixed inset-0 z-40 flex flex-col bg-background sm:static sm:z-auto sm:w-[400px] sm:shrink-0 sm:border-l', hidden && 'hidden sm:hidden')}>
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <Sparkles className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-sm font-semibold">Assistant</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {status.isLoading ? 'Connecting…' : online ? `${status.data!.model} · ${status.data!.tools} tools` : status.data && !status.data.key ? 'No ANTHROPIC_API_KEY in .env' : 'Offline'}
          </p>
        </div>
        <Button size="icon" variant="ghost" title="Past chats" onClick={() => setShowHistory(!showHistory)} className={cn(showHistory && 'bg-muted')}>
          <History className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" title="New chat" onClick={() => { chat.open(null); setShowHistory(false); }}>
          <Plus className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" title="Close (Ctrl+/)" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      {showHistory && (
        <div className="max-h-72 overflow-y-auto border-b">
          {sessions.isLoading && <p className="p-3 text-xs text-muted-foreground">Loading…</p>}
          {sessions.data?.length === 0 && <p className="p-3 text-xs text-muted-foreground">No past chats yet.</p>}
          {sessions.data?.map((s) => (
            <div key={s.id} className={cn('group flex items-center gap-2 px-3 py-1.5 hover:bg-muted', s.id === chat.sessionId && 'bg-muted')}>
              <button className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => { chat.open(s.id); setShowHistory(false); }}>
                <p className="truncate text-sm">{s.title}</p>
                <p className="text-[11px] text-muted-foreground">{new Date(s.updated).toLocaleString()}</p>
              </button>
              <button title="Delete chat" onClick={() => chat.remove(s.id)} className="cursor-pointer text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!status.isLoading && !online && <Offline error={status.data?.error ?? (status.error as Error | null)?.message} />}
        {chat.loadError && <p className="text-xs text-rose-600">{chat.loadError}</p>}
        {online && chat.items.length === 0 && (
          <div className="space-y-2 pt-2">
            <p className="text-sm text-muted-foreground">
              Ask about runs, models and experiments, or ask it to queue and manage jobs. Anything that changes something waits for your approval.
            </p>
            <div className="flex flex-col items-start gap-1.5">
              {suggestionsFor(path).map((s) => (
                <button key={s} onClick={() => submit(s)} className="cursor-pointer rounded-full border px-3 py-1 text-left text-xs hover:bg-muted">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.items.map((it, i) =>
          it.kind === 'user' ? (
            <div key={i} className="ml-8 whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">{it.text}</div>
          ) : it.kind === 'text' ? (
            <Markdown key={i} text={it.text} />
          ) : it.kind === 'tool' ? (
            <ToolCard key={it.id} item={it} onDecide={(allow) => chat.decide(it.id, allow)} />
          ) : (
            <p key={i} className="flex gap-1.5 text-xs text-rose-600 dark:text-rose-400">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {it.text}
            </p>
          ),
        )}
        {chat.busy && chat.items[chat.items.length - 1]?.kind === 'user' && <Spinner className="h-3.5 w-3.5" />}
      </div>

      <div className="border-t p-3">
        <div className="flex items-end gap-2 rounded-lg border bg-card p-1.5 focus-within:ring-2 focus-within:ring-ring">
          <textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder={online ? 'Ask about this page, or anything in the lab…' : 'The assistant is offline'}
            disabled={!online}
            className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm placeholder:text-muted-foreground focus:outline-none"
          />
          {chat.busy ? (
            <Button size="icon" variant="outline" title="Stop" onClick={chat.stop}>
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button size="icon" variant="primary" title="Send (Enter)" onClick={() => submit()} disabled={!online || !draft.trim()}>
              <Send className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        {(chat.usage.input_tokens || chat.usage.cache_read_input_tokens) ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            This chat: {tokens((chat.usage.input_tokens ?? 0) + (chat.usage.cache_creation_input_tokens ?? 0))} in,{' '}
            {tokens(chat.usage.cache_read_input_tokens)} cached, {tokens(chat.usage.output_tokens)} out
          </p>
        ) : null}
      </div>
    </aside>
  );
}
