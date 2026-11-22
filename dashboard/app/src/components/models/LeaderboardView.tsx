import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, keys, type Leaderboard, type LeaderboardQuery } from '../../lib/api';
import { tCritical } from '../../lib/stats';
import { cn, formatNumber, timeAgo } from '../../lib/utils';
import { runTitle } from '../RunBits';
import { Badge, Card, Empty, Input, Select, Spinner } from '../ui';
import { formatMetric, ModelFlags, modelTitle } from './ModelBits';

export interface LeaderboardSearch {
  metric?: string;
  course?: string;
  stage?: string;
  min?: number;
}

type Row = Leaderboard['rows'][number];

function ci(row: Row): [number, number] | null {
  const { n, mean, sd } = row.stats;
  if (n < 2 || !isFinite(sd)) return null;
  const h = tCritical(n - 1) * sd / Math.sqrt(n);
  return [mean - h, mean + h];
}

/** Mean with its 95% interval drawn on a scale shared by every row. */
function RangeBar({ row, lo, hi, best }: { row: Row; lo: number; hi: number; best: boolean }) {
  const span = hi - lo || 1;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / span) * 100))}%`;
  const c = ci(row);
  return (
    <div className="relative h-4 w-40">
      <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
      {c && <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary/25" style={{ left: pos(c[0]), right: `calc(100% - ${pos(c[1])})` }} />}
      <div className={cn('absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full', best ? 'bg-primary' : 'bg-foreground/60')} style={{ left: pos(row.stats.mean) }} />
    </div>
  );
}

export function LeaderboardView({ robot, search, onSearch }: {
  robot: string;
  search: LeaderboardSearch;
  onSearch: (patch: Partial<LeaderboardSearch>) => void;
}) {
  const query: LeaderboardQuery = { robot, metric: search.metric, course: search.course, stage: search.stage, min_trials: search.min };
  const { data, isLoading, error } = useQuery({
    queryKey: keys.leaderboard(query),
    queryFn: () => api.leaderboard(query),
    placeholderData: keepPreviousData,
  });

  if (error) return <Empty title="Couldn't load the leaderboard">{(error as Error).message}</Empty>;
  if (isLoading || !data) return <div className="grid place-items-center py-16"><Spinner /></div>;

  const car = data.engine === 'car';
  const metric = data.metrics.find((m) => m.key === data.metric);
  const bounds = data.rows.flatMap((r) => ci(r) ?? [r.stats.mean]);
  const lo = Math.min(...bounds);
  const hi = Math.max(...bounds);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Rank by
          <Select value={data.metric} onChange={(e) => onSearch({ metric: e.target.value })}>
            {data.metrics.map((m) => (
              <option key={m.key} value={m.key}>{m.label}{m.better ? ` (${m.better} is better)` : ''}</option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {car ? 'Course' : 'Task'}
          <Select value={search.course ?? ''} onChange={(e) => onSearch({ course: e.target.value || undefined })}>
            <option value="">All</option>
            {data.courses.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </label>
        {car && (
          <>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Evals
              <Select value={data.stage} onChange={(e) => onSearch({ stage: e.target.value === 'main' ? undefined : e.target.value })}>
                <option value="main">Ordinary evals</option>
                <option value="all">All, sweep stages pooled</option>
                {data.stages.map((s) => <option key={s} value={String(s)}>Sweep stage {s + 1} only</option>)}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Min trials
              <Input
                type="number"
                min={1}
                className="w-24"
                value={search.min ?? 1}
                onChange={(e) => onSearch({ min: Number(e.target.value) > 1 ? Number(e.target.value) : undefined })}
              />
            </label>
          </>
        )}
        <span className="ml-auto text-sm text-muted-foreground">
          {data.total} ranked{data.total > data.rows.length ? `, top ${data.rows.length} shown` : ''}
        </span>
      </div>

      {!data.rows.length ? (
        <Empty title="Nothing ranked yet">
          {car ? 'No model has evals that match these filters. Evaluate a model from the Checkpoints view.' : 'No model of this robot has an EVAL result yet.'}
        </Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-12 px-4 py-2.5 font-medium">#</th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">{car ? 'Course' : 'Task'}</th>
                <th className="px-4 py-2.5 text-right font-medium">{metric?.label ?? data.metric}</th>
                {car && <th className="px-4 py-2.5 font-medium" title="Mean and 95% confidence interval over pooled trials">95% CI</th>}
                {car && <th className="px-4 py-2.5 text-right font-medium">Median</th>}
                <th className="px-4 py-2.5 text-right font-medium">{car ? 'Trials' : 'Episodes'}</th>
                <th className="px-4 py-2.5 font-medium">Evaluated</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.rows.map((r) => {
                const c = ci(r);
                return (
                  <tr key={r.model_id} className="hover:bg-muted/40">
                    <td className="px-4 py-3 font-semibold tabular-nums">{r.rank}</td>
                    <td className="max-w-sm px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link to="/models/$modelId" params={{ modelId: r.model_id }} className="truncate font-medium hover:underline">
                          {modelTitle(r.model)}
                        </Link>
                        <ModelFlags model={r.model} />
                      </div>
                      {r.model.run && (
                        <Link to="/runs/$runId" params={{ runId: r.model.run.id }} className="mt-0.5 block truncate text-xs text-muted-foreground hover:underline">
                          {runTitle(r.model.run)}{r.model.iteration != null ? ` · iteration ${formatNumber(r.model.iteration, 0)}` : ''}
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.model.course ?? '—'}</td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {formatMetric(data.metric, r.stats.mean)}
                      {c && <span className="ml-1 text-xs font-normal text-muted-foreground">±{formatNumber((c[1] - c[0]) / 2)}</span>}
                    </td>
                    {car && <td className="px-4 py-3"><RangeBar row={r} lo={lo} hi={hi} best={r.rank === 1} /></td>}
                    {car && <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{formatMetric(data.metric, r.stats.median)}</td>}
                    <td className="px-4 py-3 text-right tabular-nums">
                      {r.stats.n.toLocaleString()}
                      {car && r.evals > 1 && <Badge className="ml-1.5">{r.evals} evals</Badge>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground" title={r.last_at ?? ''}>{timeAgo(r.last_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {car && (
        <p className="text-xs text-muted-foreground">
          Each model&apos;s trials are pooled across its eval runs. Ordinary evals leave out curriculum sweeps, which run on other track geometries.
          Use Compare for a significance test between two models.
        </p>
      )}
    </div>
  );
}
