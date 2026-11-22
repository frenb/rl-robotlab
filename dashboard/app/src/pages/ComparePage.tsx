import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AlertTriangle, Link2, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CompareClips } from '../components/compare/CompareClips';
import { CompareCurves, type Entry, type XAxis } from '../components/compare/CompareCurves';
import { ConfigDiff } from '../components/compare/ConfigDiff';
import { EvalTable } from '../components/compare/EvalTable';
import { toast } from '../components/feedback';
import { PALETTE } from '../components/MetricChart';
import { RobotBadge, StatusBadge, runTitle } from '../components/RunBits';
import { Button, Card, Empty, Input, Spinner } from '../components/ui';
import { api, keys, type Run } from '../lib/api';
import { useSelectedRobot } from '../lib/robots';
import { cn, shortId, timeAgo } from '../lib/utils';

export const COMPARE_TABS = ['curves', 'config', 'evals', 'clips'] as const;
export type CompareTab = (typeof COMPARE_TABS)[number];
export const MAX_COMPARE = 12;

export interface CompareSearch {
  runs?: string;
  models?: string;
  tab?: CompareTab;
  tags?: string;
  smooth?: number;
  x?: XAxis;
  base?: string;
  metric?: string;
  stage?: string;
}

const TAB_LABELS: Record<CompareTab, string> = { curves: 'Curves', config: 'Settings', evals: 'Evals', clips: 'Clips' };
const DEFAULT_SMOOTHING = 0.6;

const ids = (s: string | undefined) => (s ? s.split(',').filter(Boolean) : []);

/** The URL of a comparison, for links from other pages. */
export function compareSearch(runIds: string[], modelIds: string[] = []): CompareSearch {
  return { runs: runIds.join(',') || undefined, models: modelIds.join(',') || undefined };
}

function entryLabel(run: Run) {
  return `${run.curriculum_stage_name || runTitle(run)} · ${run.id.slice(-4)}`;
}

function AddRuns({ have, onAdd }: { have: string[]; onAdd: (id: string) => void }) {
  const [robot] = useSelectedRobot();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const query = { robot: robot || undefined, q: debounced || undefined, type: ['TRAIN'], limit: 15 };
  const { data, isFetching } = useQuery({ queryKey: keys.runs(query), queryFn: () => api.runs(query), placeholderData: keepPreviousData });
  const full = have.length >= MAX_COMPARE;
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search training runs by name, gym, design or id" className="w-full pl-8" />
      </div>
      {full && <p className="text-xs text-amber-700 dark:text-amber-300">A comparison holds at most {MAX_COMPARE} runs.</p>}
      <div className="flex max-h-72 flex-col overflow-y-auto">
        {isFetching && !data && <div className="grid place-items-center py-4"><Spinner /></div>}
        {data?.items.map((r) => {
          const added = have.includes(r.id);
          return (
            <button
              key={r.id}
              disabled={added || full}
              onClick={() => onAdd(r.id)}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-default disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{runTitle(r)}{r.curriculum_stage_name && <span className="text-muted-foreground"> · {r.curriculum_stage_name}</span>}</span>
              <StatusBadge status={r.status} />
              <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground">{shortId(r.id)}</span>
              <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">{timeAgo(r.created_at)}</span>
            </button>
          );
        })}
        {data && !data.items.length && <p className="px-2 py-3 text-sm text-muted-foreground">No training runs match.</p>}
      </div>
    </Card>
  );
}

export function ComparePage() {
  const search = useSearch({ strict: false }) as CompareSearch;
  const navigate = useNavigate();
  const set = (patch: Partial<CompareSearch>) =>
    navigate({ to: '/compare', search: { ...search, ...patch }, replace: true });

  const runIds = ids(search.runs);
  const modelIds = ids(search.models);
  const tab = search.tab ?? 'curves';
  const [adding, setAdding] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: keys.compare(runIds, modelIds),
    queryFn: () => api.compare(runIds, modelIds),
    enabled: runIds.length + modelIds.length > 0,
    placeholderData: keepPreviousData,
  });

  // Picked models bring their runs; keep those in the URL so the link stands on its own.
  useEffect(() => {
    if (!data) return;
    const brought = data.runs.map((r) => r.run.id).filter((id) => !runIds.includes(id));
    if (brought.length) set({ runs: [...runIds, ...brought].join(',') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const entries: Entry[] = useMemo(() => (data?.runs ?? []).map((r, i) => ({
    run: r.run, color: PALETTE[i % PALETTE.length], label: entryLabel(r.run),
  })), [data]);

  const add = (id: string) => set({ runs: [...runIds, id].join(',') });
  const remove = (id: string) => {
    const dropModels = new Set((data?.models ?? []).filter((m) => m.run_id === id).map((m) => m.id));
    const models = modelIds.filter((m) => !dropModels.has(m));
    set({ runs: runIds.filter((r) => r !== id).join(',') || undefined, models: models.join(',') || undefined });
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast('success', 'Link copied: it opens this comparison as you see it.');
    } catch {
      toast('error', `Couldn't copy; share the address bar instead: ${window.location.href}`);
    }
  };

  const counts: Partial<Record<CompareTab, number>> = data ? {
    evals: data.models.length,
  } : {};

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Compare</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Overlay curves, diff settings, test eval results and watch clips side by side, for runs of any robot.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setAdding(!adding)} variant={adding ? 'primary' : 'outline'}>
            <Plus className="h-4 w-4" /> Add runs
          </Button>
          <Button onClick={copyLink} disabled={!runIds.length && !modelIds.length}>
            <Link2 className="h-4 w-4" /> Copy link
          </Button>
        </div>
      </div>

      {adding && <AddRuns have={runIds} onAdd={add} />}

      {entries.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {entries.map((e) => (
            <span key={e.run.id} className="flex max-w-full items-center gap-2 rounded-lg border bg-card py-1 pl-2.5 pr-1 text-sm shadow-sm">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: e.color }} />
              <Link to="/runs/$runId" params={{ runId: e.run.id }} className="min-w-0 truncate hover:underline" title={runTitle(e.run)}>
                {e.label}
              </Link>
              <RobotBadge robot={e.run.robot} />
              <StatusBadge status={e.run.status} />
              <button onClick={() => remove(e.run.id)} className="grid h-6 w-6 cursor-pointer place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" title="Remove from the comparison">
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {data && data.missing.length > 0 && (
        <p className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4" /> Not found (deleted?): {data.missing.map(shortId).join(', ')}
        </p>
      )}

      {!runIds.length && !modelIds.length ? (
        <Empty title="Pick runs to compare">
          Use Add runs above, select runs on the Runs page and press Compare, or press Compare on a run's page.
        </Empty>
      ) : error ? (
        <Empty title="Couldn't load this comparison">{String((error as Error).message)}</Empty>
      ) : isLoading || !data ? (
        <div className="grid place-items-center py-16"><Spinner /></div>
      ) : !entries.length && !data.models.length ? (
        <Empty title="Nothing to compare">None of these ids is a run or a model any more.</Empty>
      ) : (
        <>
          <div className="flex gap-1 border-b">
            {COMPARE_TABS.map((t) => (
              <button
                key={t}
                onClick={() => set({ tab: t === 'curves' ? undefined : t })}
                className={cn(
                  '-mb-px cursor-pointer border-b-2 px-3 py-2 text-sm transition-colors',
                  tab === t ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {TAB_LABELS[t]}
                {counts[t] != null && <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">{counts[t]}</span>}
              </button>
            ))}
          </div>
          {tab === 'curves' && (
            entries.length ? (
              <CompareCurves
                entries={entries}
                tags={search.tags != null ? ids(search.tags) : null}
                smoothing={search.smooth ?? DEFAULT_SMOOTHING}
                x={search.x ?? 'step'}
                onTags={(t) => set({ tags: t.join(',') })}
                onSmoothing={(v) => set({ smooth: v === DEFAULT_SMOOTHING ? undefined : v })}
                onX={(x) => set({ x: x === 'step' ? undefined : x })}
              />
            ) : <Empty title="These models aren't linked to a run, so there are no curves" />
          )}
          {tab === 'config' && <ConfigDiff runs={data.runs} entries={entries} />}
          {tab === 'evals' && (
            <EvalTable
              models={data.models}
              entries={entries}
              picked={data.picked_models}
              metric={search.metric ?? ''}
              stage={search.stage ?? ''}
              baseline={search.base ?? data.picked_models[0] ?? ''}
              onMetric={(m) => set({ metric: m })}
              onStage={(s) => set({ stage: s || undefined })}
              onBaseline={(id) => set({ base: id })}
            />
          )}
          {tab === 'clips' && <CompareClips entries={entries} />}
        </>
      )}
    </div>
  );
}
