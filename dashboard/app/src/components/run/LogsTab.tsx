import { useEffect, useRef, useState } from 'react';
import { api, isLive, type LogChunk, type Run } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Card, Empty, Spinner } from '../ui';

const POLL_MS = 2500;
const MAX_LINES = 4000;

export function LogsTab({ run }: { run: Run }) {
  return <LogView source={run.id} fetchChunk={(offset) => api.logs(run.id, offset)} live={isLive(run)} emptyTitle="No log for this run" />;
}

/**
 * A growing log file: the tail first, then (while live) what was appended
 * since, by passing back each chunk's end offset. Stays scrolled to the
 * bottom unless the reader scrolls up.
 */
export function LogView({ source, fetchChunk, live, emptyTitle, className }: {
  source: string; fetchChunk: (offset?: number) => Promise<LogChunk>; live: boolean; emptyTitle: string; className?: string;
}) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const fetcher = useRef(fetchChunk);
  fetcher.current = fetchChunk;

  useEffect(() => {
    let cancelled = false;
    let offset: number | undefined;
    let partial = '';
    let timer: number | undefined;
    setLines(null);

    const append = (text: string, replace: boolean) => {
      const parts = (partial + text).split('\n');
      partial = parts.pop() ?? '';
      setLines((prev) => {
        const next = replace ? parts : [...(prev ?? []), ...parts];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    };

    const tick = async () => {
      try {
        const chunk = await fetcher.current(offset);
        if (cancelled) return;
        setAvailable(chunk.available);
        setNote(chunk.note);
        setError(null);
        if (chunk.available) {
          const first = offset === undefined || !!chunk.reset;
          if (first) partial = '';
          append(chunk.text, first);
          offset = chunk.end;
        } else {
          setLines([]);
        }
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message));
      }
      if (!cancelled && live) timer = window.setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, live]);

  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  if (lines === null && !error) return <div className="grid place-items-center py-16"><Spinner /></div>;
  if (!available) return <Empty title={emptyTitle}>{note}</Empty>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{note ?? (live ? 'Following the log as it grows.' : 'End of the log.')}</span>
        {error && <span className="text-rose-600">{error}</span>}
      </div>
      <Card className="overflow-hidden bg-zinc-950 dark:bg-black">
        <pre
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className={cn('h-[calc(100vh-260px)] overflow-auto p-4 font-mono text-xs leading-relaxed text-zinc-200', className)}
        >
          {(lines ?? []).join('\n')}
        </pre>
      </Card>
    </div>
  );
}
