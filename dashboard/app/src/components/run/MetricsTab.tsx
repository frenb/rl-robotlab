import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, isLive, keys, type Run, type TagInfo } from '../../lib/api';
import { useLiveMetrics } from '../../lib/live';
import { cn, formatNumber } from '../../lib/utils';
import { MetricChart, PALETTE } from '../MetricChart';
import { DEFAULT_TAGS, headlineTag } from '../RunBits';
import { Card, Empty, Input, Spinner } from '../ui';

/** Charts for some tags of one run, refreshed live while it trains. */
export function RunCharts({
  run, tags, smoothing, height, columns = 2,
}: {
  run: Run;
  tags: string[];
  smoothing: number;
  height?: number;
  columns?: 1 | 2;
}) {
  useLiveMetrics(run.id, isLive(run));
  const { data, isLoading } = useQuery({
    queryKey: keys.metrics(run.id, tags),
    queryFn: () => api.metrics(run.id, tags),
    enabled: tags.length > 0,
    placeholderData: (prev) => prev,
  });
  if (isLoading) return <div className="grid place-items-center py-10"><Spinner /></div>;
  return (
    <div className={cn('grid gap-x-6 gap-y-5', columns === 2 && 'xl:grid-cols-2')}>
      {tags.map((tag, i) => {
        const s = data?.[tag];
        return (
          <MetricChart
            key={tag}
            title={tag}
            height={height}
            smoothing={smoothing}
            lines={s ? [{ label: tag, color: PALETTE[i % PALETTE.length], ...s }] : []}
          />
        );
      })}
    </div>
  );
}

export function useRunTags(run: Run) {
  return useQuery({
    queryKey: keys.tags(run.id),
    queryFn: () => api.tags(run.id),
    refetchInterval: isLive(run) ? 30_000 : false,
  });
}

/** The headline curve for overview cards; nothing if the run logged none. */
export function HeadlineChart({ run, height = 160 }: { run: Run; height?: number }) {
  const { data } = useRunTags(run);
  const tag = headlineTag(data?.tags);
  if (!data) return <div className="grid place-items-center" style={{ height }}><Spinner /></div>;
  if (!tag) return <div className="grid place-items-center text-xs text-muted-foreground" style={{ height }}>No curves logged</div>;
  return <RunCharts run={run} tags={[tag]} smoothing={0.6} height={height} columns={1} />;
}

function section(tag: string) {
  const i = tag.lastIndexOf('/');
  return i > 0 ? tag.slice(0, i) : '(top level)';
}

export function TagBrowser({
  tags, selected, onToggle, describe,
}: {
  tags: TagInfo[];
  selected: string[];
  onToggle: (tag: string) => void;
  /** Right-hand note and tooltip per tag; defaults to its last value. */
  describe?: (t: TagInfo) => { note: string; title: string };
}) {
  const info = describe ?? ((t: TagInfo) => ({
    note: formatNumber(t.last_value),
    title: `${t.points} points, last ${formatNumber(t.last_value)} at step ${formatNumber(t.last_step, 0)}`,
  }));
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const f = filter.toLowerCase();
    const out = new Map<string, TagInfo[]>();
    for (const t of tags) {
      if (f && !t.tag.toLowerCase().includes(f)) continue;
      const s = section(t.tag);
      out.set(s, [...(out.get(s) ?? []), t]);
    }
    return [...out.entries()];
  }, [tags, filter]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${tags.length} metrics`} className="w-full pl-8" />
      </div>
      <div className="flex max-h-[calc(100vh-280px)] flex-col overflow-y-auto pr-1">
        {groups.map(([name, items]) => {
          const isOpen = filter !== '' || (open[name] ?? items.some((t) => selected.includes(t.tag)));
          const count = items.filter((t) => selected.includes(t.tag)).length;
          return (
            <div key={name}>
              <button
                onClick={() => setOpen({ ...open, [name]: !isOpen })}
                className="flex w-full cursor-pointer items-center gap-1 rounded px-1 py-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <span className="flex-1 truncate">{name}</span>
                <span className="tabular-nums">{count ? `${count}/` : ''}{items.length}</span>
              </button>
              {isOpen && items.map((t) => (
                <label
                  key={t.tag}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
                  title={info(t).title}
                >
                  <input type="checkbox" checked={selected.includes(t.tag)} onChange={() => onToggle(t.tag)} className="accent-[var(--primary)]" />
                  <span className="flex-1 truncate font-mono">{t.tag.slice(name === '(top level)' ? 0 : name.length + 1)}</span>
                  <span className="tabular-nums text-muted-foreground">{info(t).note}</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MetricsTab({ run }: { run: Run }) {
  const { data, isLoading } = useRunTags(run);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [smoothing, setSmoothing] = useState(0.6);

  useEffect(() => {
    if (!data || selected) return;
    const names = new Set(data.tags.map((t) => t.tag));
    const defaults = DEFAULT_TAGS.filter((t) => names.has(t));
    setSelected(defaults.length ? defaults : data.tags.slice(0, 6).map((t) => t.tag));
  }, [data, selected]);

  if (isLoading) return <div className="grid place-items-center py-16"><Spinner /></div>;
  if (!data?.tags.length) {
    return (
      <Empty title="No curves for this run">
        {data?.files ? 'Its event files hold no scalar metrics.' : 'No TensorBoard event files were found for it. Queued runs and evaluation jobs usually have none.'}
      </Empty>
    );
  }

  const chosen = selected ?? [];
  const toggle = (tag: string) =>
    setSelected(chosen.includes(tag) ? chosen.filter((t) => t !== tag) : [...chosen, tag]);

  return (
    <div className="grid gap-6 md:grid-cols-[240px_1fr]">
      <Card className="h-fit p-3">
        <TagBrowser tags={data.tags} selected={chosen} onToggle={toggle} />
      </Card>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="whitespace-nowrap text-sm text-muted-foreground">
            {chosen.length} of {data.tags.length} metrics{isLive(run) && ' · updating live'}
          </p>
          <label className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
            Smoothing
            <input
              type="range" min={0} max={0.99} step={0.01} value={smoothing}
              onChange={(e) => setSmoothing(Number(e.target.value))}
              className="w-32 accent-[var(--primary)]"
            />
            <span className="w-8 tabular-nums">{smoothing.toFixed(2)}</span>
          </label>
        </div>
        {chosen.length ? (
          <Card className="p-5"><RunCharts run={run} tags={chosen} smoothing={smoothing} /></Card>
        ) : (
          <Empty title="Pick metrics on the left to chart them" />
        )}
      </div>
    </div>
  );
}
