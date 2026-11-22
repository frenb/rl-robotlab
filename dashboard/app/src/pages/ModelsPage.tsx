import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Film, FlaskConical, GitCompareArrows, Package, Search, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EvalDialog } from '../components/models/EvalDialog';
import { LeaderboardView, type LeaderboardSearch } from '../components/models/LeaderboardView';
import { CompatBadge, evalLine, ModelFlags, modelTitle, useModelActions } from '../components/models/ModelBits';
import { RobotBadge, runTitle } from '../components/RunBits';
import { Button, Card, Empty, Input, Select, Spinner } from '../components/ui';
import { api, keys, type ModelQuery, type ModelSummary } from '../lib/api';
import { isMjlab, robotName, useRobots, useSelectedRobot } from '../lib/robots';
import { cn, formatNumber, shortId, timeAgo } from '../lib/utils';

export const MODEL_FILTERS = ['all', 'evaluated', 'promoted'] as const;
export type ModelFilter = (typeof MODEL_FILTERS)[number];

export interface ModelsSearch extends LeaderboardSearch {
  view?: 'leaderboard';
  filter?: ModelFilter;
  q?: string;
  sort?: string;
  page?: number;
  run?: string;
  /** Leaderboard robot while the sidebar shows all robots. */
  robot?: string;
}

const PAGE_SIZE = 50;
const MAX_COMPARE_MODELS = 50;
const FILTER_LABELS: Record<ModelFilter, string> = { all: 'All checkpoints', evaluated: 'Evaluated', promoted: 'Promoted' };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function SortHeader({ label, field, sort, onSort, className }: { label: string; field: string; sort: string; onSort: (s: string) => void; className?: string }) {
  const active = sort === field || sort === `-${field}`;
  const desc = sort === `-${field}`;
  return (
    <button
      className={cn('inline-flex cursor-pointer items-center gap-1 hover:text-foreground', active && 'text-foreground', className)}
      onClick={() => onSort(active && desc ? field : `-${field}`)}
    >
      {label}
      {active && (desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
    </button>
  );
}

function Checkpoints({ robot, search, set }: { robot: string; search: ModelsSearch; set: (p: Partial<ModelsSearch>, keepPage?: boolean) => void }) {
  const { data: robots } = useRobots();
  const navigate = useNavigate();
  const filter = search.filter ?? 'evaluated';
  const sort = search.sort ?? '-created';
  const page = search.page ?? 1;
  const [text, setText] = useState(search.q ?? '');
  const q = useDebounced(text, 300);
  useEffect(() => {
    if ((search.q ?? '') !== q) set({ q: q || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const [selected, setSelected] = useState<Record<string, ModelSummary>>({});
  const selection = Object.values(selected);
  useEffect(() => setSelected({}), [robot, filter, search.q, search.course, search.run]);
  const [evaluating, setEvaluating] = useState<ModelSummary[] | null>(null);
  const actions = useModelActions();

  const query: ModelQuery = {
    robot: robot || undefined,
    q: search.q,
    course: search.course,
    run: search.run,
    evaluated: filter === 'evaluated',
    promoted: filter === 'promoted',
    sort,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };
  const { data, isLoading, error } = useQuery({
    queryKey: keys.models(query),
    queryFn: () => api.models(query),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const items = data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((m) => selected[m.id]);
  const robotsIn = Array.from(new Set(selection.map((m) => m.robot)));
  const oneRobot = robotsIn.length === 1;
  const allMjlab = oneRobot && isMjlab(robots, robotsIn[0]);
  const exportable = allMjlab && robots?.find((r) => r.id === robotsIn[0])?.supports?.export !== false;
  const toggle = (m: ModelSummary) => setSelected((sel) => {
    const next = { ...sel };
    if (next[m.id]) delete next[m.id];
    else next[m.id] = m;
    return next;
  });
  const bulk = async (fn: () => Promise<boolean>) => { if (await fn()) setSelected({}); };
  const sortBy = (s: string) => set({ sort: s });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search path, task, design, notes, id…" className="w-72 pl-8" />
        </div>
        <div className="flex rounded-lg border bg-card p-0.5">
          {MODEL_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => set({ filter: f === 'evaluated' ? undefined : f })}
              className={cn('h-8 cursor-pointer rounded-md px-3 text-sm transition-colors', filter === f ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
        <Select value={search.course ?? ''} onChange={(e) => set({ course: e.target.value || undefined })}>
          <option value="">All courses and tasks</option>
          {(data?.courses ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        {search.run && (
          <span className="inline-flex items-center gap-1 rounded-full border bg-card py-0.5 pl-3 pr-1 text-sm">
            Run <Link to="/runs/$runId" params={{ runId: search.run }} className="font-mono hover:underline">{shortId(search.run)}</Link>
            <button className="grid h-5 w-5 cursor-pointer place-items-center rounded-full hover:bg-muted" onClick={() => set({ run: undefined })} title="Show every run">
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
        <span className="ml-auto text-sm text-muted-foreground">{data ? `${data.total.toLocaleString()} models` : ''}</span>
      </div>

      {selection.length > 0 && (
        <Card className="sticky top-2 z-10 flex flex-wrap items-center gap-2 px-4 py-2.5 shadow-md">
          <span className="mr-2 text-sm font-medium">{selection.length} selected</span>
          <Button size="sm" disabled={!oneRobot} onClick={() => setEvaluating(selection)} title={oneRobot ? 'Queue an EVAL per model' : 'Evaluate models of one robot at a time'}>
            <FlaskConical className="h-3.5 w-3.5" /> Evaluate
          </Button>
          <Button size="sm" disabled={!exportable} onClick={() => bulk(() => actions.exportOnnx(selection))} title={exportable ? 'Queue an ONNX export per model' : 'ONNX export is for mjlab robots'}>
            <Package className="h-3.5 w-3.5" /> Export ONNX
          </Button>
          <Button size="sm" disabled={!allMjlab} onClick={() => bulk(() => actions.renderVideo(selection))} title={allMjlab ? 'Render a rollout video per model' : 'Video renders are for mjlab robots'}>
            <Film className="h-3.5 w-3.5" /> Render video
          </Button>
          <Button
            size="sm"
            disabled={selection.length > MAX_COMPARE_MODELS}
            onClick={() => navigate({ to: '/compare', search: { models: selection.map((m) => m.id).join(','), tab: 'evals' } })}
            title="Their evals side by side with a significance test, plus the runs that trained them"
          >
            <GitCompareArrows className="h-3.5 w-3.5" /> Compare
          </Button>
          <Button size="sm" className="text-rose-600 dark:text-rose-400" onClick={() => bulk(() => actions.remove(selection))}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected({})}>Clear</Button>
        </Card>
      )}

      {error ? (
        <Empty title="Couldn't load models">{(error as Error).message}</Empty>
      ) : isLoading ? (
        <div className="grid place-items-center py-16"><Spinner /></div>
      ) : !items.length ? (
        <Empty title="No models match">
          {filter === 'evaluated' ? 'None of these have been evaluated yet; switch to All checkpoints to pick one to evaluate.' : 'Try a different robot, course or search.'}
        </Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-10 py-2.5 pl-4">
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer accent-primary"
                    checked={allOnPage}
                    onChange={() => setSelected((sel) => {
                      const next = { ...sel };
                      if (allOnPage) items.forEach((m) => delete next[m.id]);
                      else items.forEach((m) => { next[m.id] = m; });
                      return next;
                    })}
                    title="Select this page"
                  />
                </th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">Course / task</th>
                <th className="px-4 py-2.5 text-right font-medium" title="Training step the checkpoint was saved at">Iteration</th>
                <th className="px-4 py-2.5 text-right font-medium" title="Return the trainer recorded when it saved the checkpoint">
                  <SortHeader label="Training return" field="return" sort={sort} onSort={sortBy} />
                </th>
                <th className="px-4 py-2.5 font-medium">Eval</th>
                <th className="px-4 py-2.5 font-medium">Compat</th>
                <th className="px-4 py-2.5 font-medium"><SortHeader label="Created" field="created" sort={sort} onSort={sortBy} /></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((m) => {
                const line = evalLine(m);
                return (
                  <tr
                    key={m.id}
                    onClick={() => navigate({ to: '/models/$modelId', params: { modelId: m.id } })}
                    className={cn('cursor-pointer transition-colors hover:bg-muted/40', selected[m.id] && 'bg-primary/5')}
                  >
                    <td className="py-3 pl-4" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="h-4 w-4 cursor-pointer accent-primary" checked={!!selected[m.id]} onChange={() => toggle(m)} />
                    </td>
                    <td className="max-w-md px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium" title={m.location ?? ''}>{modelTitle(m)}</span>
                        <ModelFlags model={m} />
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        {!robot && <RobotBadge robot={m.robot} />}
                        <span className="font-mono">{shortId(m.id)}</span>
                        {m.run && (
                          <Link to="/runs/$runId" params={{ runId: m.run.id }} onClick={(e) => e.stopPropagation()} className="truncate hover:text-foreground hover:underline">
                            {runTitle(m.run)}
                          </Link>
                        )}
                      </div>
                    </td>
                    <td className="max-w-44 truncate px-4 py-3 text-muted-foreground" title={m.course ?? ''}>{m.course ?? '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatNumber(m.iteration, 0)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{formatNumber(m.avg_return)}</td>
                    <td className="px-4 py-3">
                      {line ? (
                        <div className="whitespace-nowrap">
                          <p className="tabular-nums">{line}</p>
                          <p className="text-xs text-muted-foreground">
                            {m.eval!.count > 1 ? `${m.eval!.count} evals · ` : ''}{timeAgo(m.eval!.last_at)}
                          </p>
                        </div>
                      ) : (
                        <button
                          className="cursor-pointer text-xs text-muted-foreground hover:text-foreground hover:underline"
                          onClick={(e) => { e.stopPropagation(); setEvaluating([m]); }}
                        >
                          Not evaluated · evaluate
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3"><CompatBadge compat={m.compat} mjlab={isMjlab(robots, m.robot)} /></td>
                    <td className="px-4 py-3 text-muted-foreground" title={m.created_at ?? ''}>{timeAgo(m.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <span>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total.toLocaleString()}</span>
          <Button size="icon" disabled={page <= 1} onClick={() => set({ page: page - 1 > 1 ? page - 1 : undefined }, true)}><ChevronLeft className="h-4 w-4" /></Button>
          <Button size="icon" disabled={page * PAGE_SIZE >= data.total} onClick={() => set({ page: page + 1 }, true)}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      )}

      {evaluating && <EvalDialog models={evaluating} onClose={() => setEvaluating(null)} onQueued={() => setSelected({})} />}
      {robot === '' && robots && (
        <p className="text-xs text-muted-foreground">Showing every robot; pick one in the sidebar to narrow the list to {robots.map((r) => r.display_name).join(', ')}.</p>
      )}
    </div>
  );
}

export function ModelsPage() {
  const [robot] = useSelectedRobot();
  const { data: robots } = useRobots();
  const search = useSearch({ strict: false }) as ModelsSearch;
  const navigate = useNavigate();
  const set = (patch: Partial<ModelsSearch>, keepPage = false) =>
    navigate({ to: '/models', search: { ...search, ...patch, ...(keepPage ? {} : { page: undefined }) }, replace: true });
  const view = search.view === 'leaderboard' ? 'leaderboard' : 'checkpoints';
  const boardRobot = robot || search.robot || 'roboracer';
  const [lastRobot, setLastRobot] = useState(robot);
  useEffect(() => {
    if (lastRobot === robot) return;
    setLastRobot(robot);
    if (search.course || search.metric || search.stage) set({ course: undefined, metric: undefined, stage: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robot]);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {robot ? `${robotName(robots, robot)} checkpoints` : 'Checkpoints of every robot'}: evaluate, rank, export and promote.
        </p>
      </div>

      <div className="flex items-center gap-1 border-b">
        {(['checkpoints', 'leaderboard'] as const).map((v) => (
          <button
            key={v}
            onClick={() => set({ view: v === 'leaderboard' ? 'leaderboard' : undefined, course: undefined })}
            className={cn(
              '-mb-px cursor-pointer border-b-2 px-3 py-2 text-sm transition-colors',
              v === view ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {v === 'checkpoints' ? 'Checkpoints' : 'Leaderboard'}
          </button>
        ))}
        {view === 'leaderboard' && !robot && (
          <Select className="mb-1 ml-auto h-8" value={boardRobot} onChange={(e) => set({ robot: e.target.value, metric: undefined, course: undefined, stage: undefined })}>
            {(robots ?? []).map((r) => <option key={r.id} value={r.id}>{r.display_name}</option>)}
          </Select>
        )}
      </div>

      {view === 'checkpoints'
        ? <Checkpoints robot={robot} search={search} set={set} />
        : <LeaderboardView key={boardRobot} robot={boardRobot} search={search} onSearch={(p) => set(p)} />}
    </div>
  );
}
