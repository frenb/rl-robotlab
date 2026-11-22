import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { api, isLive, keys, type Run, type Series, type TagInfo } from '../../lib/api';
import { live } from '../../lib/live';
import { cn } from '../../lib/utils';
import { MetricChart, type Line } from '../MetricChart';
import { DEFAULT_TAGS, headlineTag } from '../RunBits';
import { TagBrowser } from '../run/MetricsTab';
import { Card, Empty, Select, Spinner } from '../ui';

export interface Entry {
  run: Run;
  color: string;
  label: string;
}

export type XAxis = 'step' | 'time';

/** Metrics that mean the same thing under different tags, so car and mjlab runs share a chart. */
const ALIASES: { id: string; label: string; resolve: (names: Set<string>, tags: TagInfo[]) => string | null }[] = [
  { id: '@reward', label: 'Reward (headline)', resolve: (_n, tags) => headlineTag(tags) },
  {
    id: '@length',
    label: 'Episode length',
    resolve: (names) => ['Train/mean_episode_length', 'eval/Metrics/AverageEpisodeLength', 'train/Metrics/AverageEpisodeLength']
      .find((t) => names.has(t)) ?? null,
  },
];

export function aliasLabel(tag: string): string {
  return ALIASES.find((a) => a.id === tag)?.label ?? tag;
}

/** Keeps every live run's curves updating while the page is open. */
function useLive(runs: Run[]) {
  const ids = runs.filter(isLive).map((r) => r.id).join(',');
  useEffect(() => {
    const offs = ids ? ids.split(',').map((id) => live.subscribe(id)) : [];
    return () => offs.forEach((off) => off());
  }, [ids]);
}

export function useCompareTags(runs: Run[]) {
  const results = useQueries({
    queries: runs.map((r) => ({
      queryKey: keys.tags(r.id),
      queryFn: () => api.tags(r.id),
      refetchInterval: isLive(r) ? 30_000 : (false as const),
    })),
  });
  const loading = results.some((q) => q.isLoading);
  const perRun = results.map((q) => q.data?.tags ?? []);
  return { loading, perRun };
}

/** The tags a fresh comparison opens with: the common aliases, then defaults most runs have. */
export function defaultTags(perRun: TagInfo[][]): string[] {
  const counts = new Map<string, number>();
  perRun.forEach((tags) => tags.forEach((t) => counts.set(t.tag, (counts.get(t.tag) ?? 0) + 1)));
  const half = Math.max(1, Math.ceil(perRun.length / 2));
  const common = DEFAULT_TAGS.filter((t) => (counts.get(t) ?? 0) >= half && !/mean_reward|AverageReturn|episode_length|EpisodeLength/.test(t));
  return ['@reward', '@length', ...common.slice(0, 4)];
}

export function CompareCurves({
  entries, tags, smoothing, x, onTags, onSmoothing, onX,
}: {
  entries: Entry[];
  /** null: the defaults for these runs. */
  tags: string[] | null;
  smoothing: number;
  x: XAxis;
  onTags: (tags: string[]) => void;
  onSmoothing: (v: number) => void;
  onX: (x: XAxis) => void;
}) {
  const runs = entries.map((e) => e.run);
  useLive(runs);
  const { loading, perRun } = useCompareTags(runs);
  const chosen = useMemo(() => tags ?? defaultTags(perRun), [tags, perRun]);

  // Which concrete tag each run charts for each selected tag or alias.
  const resolved = useMemo(() => perRun.map((runTags) => {
    const names = new Set(runTags.map((t) => t.tag));
    const out: Record<string, string> = {};
    for (const tag of chosen) {
      const alias = ALIASES.find((a) => a.id === tag);
      const r = alias ? alias.resolve(names, runTags) : names.has(tag) ? tag : null;
      if (r) out[tag] = r;
    }
    return out;
  }), [perRun, chosen]);

  const series = useQueries({
    queries: entries.map((e, i) => {
      const want = [...new Set(Object.values(resolved[i] ?? {}))].sort();
      return {
        queryKey: keys.metrics(e.run.id, want, x === 'time'),
        queryFn: () => api.metrics(e.run.id, want, 1500, x === 'time'),
        enabled: want.length > 0,
        placeholderData: (prev: Record<string, Series> | undefined) => prev,
      };
    }),
  });

  const union = useMemo(() => {
    const byTag = new Map<string, number>();
    perRun.forEach((ts) => ts.forEach((t) => byTag.set(t.tag, (byTag.get(t.tag) ?? 0) + 1)));
    return [...byTag.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, n]) => ({ tag, points: n, last_step: 0, last_value: NaN }));
  }, [perRun]);

  // Wall time: hours since each run's first logged point among the charted series.
  const origins = useMemo(() => series.map((q) => {
    let t0 = Infinity;
    Object.values(q.data ?? {}).forEach((s) => { if (s.walls?.length) t0 = Math.min(t0, s.walls[0]); });
    return t0;
  }), [series]);

  const toggle = (tag: string) => onTags(chosen.includes(tag) ? chosen.filter((t) => t !== tag) : [...chosen, tag]);

  if (loading) return <div className="grid place-items-center py-16"><Spinner /></div>;
  if (!union.length) {
    return <Empty title="None of these runs logged curves">Queued runs and evaluation jobs usually have none.</Empty>;
  }

  return (
    <div className="grid gap-6 md:grid-cols-[260px_1fr]">
      <Card className="flex h-fit flex-col gap-3 p-3">
        <div className="flex flex-col gap-1">
          <p className="px-1 text-xs font-medium text-muted-foreground">Common to every robot</p>
          {ALIASES.map((a) => (
            <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted">
              <input type="checkbox" checked={chosen.includes(a.id)} onChange={() => toggle(a.id)} className="accent-[var(--primary)]" />
              <span className="flex-1">{a.label}</span>
              <span className="tabular-nums text-muted-foreground">{resolved.filter((r) => r[a.id]).length}/{entries.length}</span>
            </label>
          ))}
        </div>
        <TagBrowser
          tags={union}
          selected={chosen}
          onToggle={toggle}
          describe={(t) => ({ note: `${t.points}/${entries.length}`, title: `Logged by ${t.points} of ${entries.length} runs` })}
        />
      </Card>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
            X axis
            <Select value={x} onChange={(e) => onX(e.target.value as XAxis)} className="h-8 text-xs">
              <option value="step">Step (iteration for mjlab, train step for the car)</option>
              <option value="time">Wall time (hours since the run's first point)</option>
            </Select>
          </label>
          <label className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
            Smoothing
            <input
              type="range" min={0} max={0.99} step={0.01} value={smoothing}
              onChange={(e) => onSmoothing(Number(e.target.value))}
              className="w-32 accent-[var(--primary)]"
            />
            <span className="w-8 tabular-nums">{smoothing.toFixed(2)}</span>
          </label>
        </div>
        {chosen.length ? (
          <Card className="p-5">
            <div className={cn('grid gap-x-6 gap-y-5', chosen.length > 1 && 'xl:grid-cols-2')}>
              {chosen.map((tag) => {
                const lines: Line[] = [];
                entries.forEach((e, i) => {
                  const concrete = resolved[i]?.[tag];
                  const s = concrete ? series[i].data?.[concrete] : undefined;
                  if (!s) return;
                  const steps = x === 'time' && s.walls ? s.walls.map((w) => (w - origins[i]) / 3600) : s.steps;
                  lines.push({ label: e.label, color: e.color, steps, values: s.values, min: s.min, max: s.max });
                });
                const missing = entries.length - lines.length;
                return (
                  <div key={tag} className="flex min-w-0 flex-col gap-1">
                    <MetricChart
                      title={aliasLabel(tag)}
                      lines={lines}
                      smoothing={smoothing}
                      xLabel={x === 'time' ? 'hours' : 'step'}
                      xDigits={x === 'time' ? 1 : 0}
                    />
                    {missing > 0 && lines.length > 0 && (
                      <p className="px-1 text-[11px] text-muted-foreground">{missing} of {entries.length} runs didn't log this</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        ) : (
          <Empty title="Pick metrics on the left to overlay them" />
        )}
      </div>
    </div>
  );
}
