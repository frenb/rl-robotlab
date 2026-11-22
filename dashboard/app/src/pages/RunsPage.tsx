import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  ArrowDown, ArrowUp, Bookmark, ChevronLeft, ChevronRight, GitCompareArrows, Pause, Play, Plus, Search, Trash2, Waypoints, X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { compareSearch, MAX_COMPARE } from './ComparePage';
import { CurriculumRunGroup } from '../components/curricula/CurriculumRunGroup';
import { confirmDialog, toast } from '../components/feedback';
import { RobotBadge, StatusBadge, runTitle, typeLabel } from '../components/RunBits';
import { Button, Card, Empty, Input, Progress, Select, Spinner } from '../components/ui';
import { ACTION_META, ACTION_ORDER, useRunActions } from '../lib/actions';
import { api, keys, type Run, type RunQuery } from '../lib/api';
import { robotName, useRobots, useSelectedRobot } from '../lib/robots';
import { cn, formatNumber, runDuration, shortId, timeAgo } from '../lib/utils';

export interface RunsSearch {
  view?: string;
  type?: string;
  q?: string;
  sort?: string;
  page?: number;
}

const PAGE_SIZE = 50;
const SAVED_VIEWS_KEY = 'runs.views';
const GROUP_KEY = 'runs.groupCurricula';
const COLUMN_IDS = ['select', 'run', 'status', 'progress', 'reward', 'created', 'duration'];
/** Curriculum groups holding a run in one of these open by default. */
const ACTIVE_STATUSES: string[] = ['IN_PROGRESS', 'PAUSE_REQUESTED', 'PAUSED', 'NOT_STARTED'];

type Line = { kind: 'run'; run: Run } | { kind: 'group'; id: string; runs: Run[] };

const VIEWS: { id: string; label: string; status?: string[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active', status: ['IN_PROGRESS', 'PAUSE_REQUESTED', 'PAUSED', 'NOT_STARTED'] },
  { id: 'queued', label: 'Queued', status: ['NOT_STARTED'] },
  { id: 'done', label: 'Done', status: ['DONE'] },
  { id: 'failed', label: 'Failed', status: ['FAILED'] },
  { id: 'cancelled', label: 'Cancelled', status: ['CANCELLED'] },
];

const TYPE_FILTERS = [
  { id: '', label: 'All types' },
  { id: 'TRAIN', label: 'Training' },
  { id: 'EVAL', label: 'Evaluation' },
  { id: 'DEMO', label: 'Demos' },
  { id: 'EXPORT', label: 'Exports' },
  { id: 'VIDEO', label: 'Videos' },
];

interface SavedView { name: string; search: RunsSearch }

function loadSaved(): SavedView[] {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function QueueBar() {
  const qc = useQueryClient();
  const { data: robots } = useRobots();
  const { data } = useQuery({ queryKey: keys.queue, queryFn: api.queue, refetchInterval: 15_000 });
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const offline = data.workers.filter((w) => !w.online);
  const toggle = async () => {
    const pausing = !data.paused;
    if (pausing && !(await confirmDialog({
      title: 'Pause the queue?',
      message: `No queued run will start until you resume.${data.running.length ? ` The ${data.running.length === 1 ? 'running job checkpoints and pauses' : `${data.running.length} running jobs checkpoint and pause`}, and resumes with the queue.` : ''}`,
      confirmLabel: 'Pause queue',
    }))) return;
    setBusy(true);
    try {
      const r = await api.setQueuePaused(pausing);
      qc.setQueryData(keys.queue, r);
      qc.invalidateQueries({ queryKey: keys.allRuns });
      toast('success', pausing ? 'Queue paused.' : 'Queue resumed; auto-paused runs are queued again.');
    } catch (e) {
      toast('error', `Couldn't ${pausing ? 'pause' : 'resume'} the queue: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const next = data.queued[0];
  return (
    <Card className={cn('flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-sm', data.paused && 'border-amber-500/50 bg-amber-500/5')}>
      <span className="flex items-center gap-2 font-medium">
        <span className={cn('h-2 w-2 rounded-full', data.paused ? 'bg-amber-500' : 'bg-emerald-500')} />
        {data.paused ? 'Queue paused' : 'Queue running'}
      </span>
      <span className="text-muted-foreground">{data.running.length} running · {data.queued.length} queued</span>
      {next && (
        <span className="min-w-0 truncate text-muted-foreground">
          Next: <Link to="/runs/$runId" params={{ runId: next.id }} className="text-foreground hover:underline">{runTitle(next)}</Link>{' '}
          ({robotName(robots, next.robot)})
        </span>
      )}
      {offline.length > 0 && (
        <span className="text-amber-700 dark:text-amber-300" title="No heartbeat in the last 2 minutes; their queued runs wait for them.">
          {offline.map((w) => robotName(robots, w.robot)).join(', ')} worker{offline.length === 1 ? '' : 's'} offline
        </span>
      )}
      <Button size="sm" className="ml-auto" disabled={busy} onClick={toggle} variant={data.paused ? 'primary' : 'outline'}>
        {data.paused ? <><Play className="h-3.5 w-3.5" /> Resume queue</> : <><Pause className="h-3.5 w-3.5" /> Pause queue</>}
      </Button>
    </Card>
  );
}

function SortHeader({ label, field, sort, onSort }: { label: string; field: string; sort: string; onSort: (s: string) => void }) {
  const active = sort === field || sort === `-${field}`;
  const desc = sort === `-${field}`;
  return (
    <button
      className={cn('inline-flex cursor-pointer items-center gap-1 hover:text-foreground', active && 'text-foreground')}
      onClick={() => onSort(active && desc ? field : `-${field}`)}
      title={`Sort by ${label.toLowerCase()}`}
    >
      {label}
      {active && (desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
    </button>
  );
}

export function RunsPage() {
  const [robot] = useSelectedRobot();
  const { data: robots } = useRobots();
  const search = useSearch({ strict: false }) as RunsSearch;
  const navigate = useNavigate();
  const setSearch = (patch: Partial<RunsSearch>, keepPage = false) =>
    navigate({ to: '/runs', search: (s: RunsSearch) => ({ ...s, ...patch, ...(keepPage ? {} : { page: undefined }) }), replace: true });

  const view = search.view ?? 'all';
  const sort = search.sort ?? '-created';
  const page = search.page ?? 1;
  const [text, setText] = useState(search.q ?? '');
  const q = useDebounced(text, 300);
  useEffect(() => {
    if ((search.q ?? '') !== q) setSearch({ q: q || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const [saved, setSaved] = useState<SavedView[]>(loadSaved);
  const persist = (views: SavedView[]) => {
    setSaved(views);
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views));
  };
  const [naming, setNaming] = useState<string | null>(null);

  const [selected, setSelected] = useState<Record<string, Run>>({});
  const selection = Object.values(selected);
  useEffect(() => setSelected({}), [robot, view, search.type, search.q]);
  const { perform, remove } = useRunActions();

  const query: RunQuery = {
    robot: robot || undefined,
    status: VIEWS.find((v) => v.id === view)?.status,
    type: search.type ? [search.type] : undefined,
    q: search.q,
    sort,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };
  const { data, isLoading, error } = useQuery({
    queryKey: keys.runs(query),
    queryFn: () => api.runs(query),
    placeholderData: keepPreviousData,
  });
  const items = data?.items ?? [];
  // Keep selected rows current as live updates change their status.
  useEffect(() => {
    setSelected((sel) => {
      let changed = false;
      const next = { ...sel };
      for (const r of items) if (next[r.id] && next[r.id] !== r) { next[r.id] = r; changed = true; }
      return changed ? next : sel;
    });
  }, [items]);

  const allOnPage = items.length > 0 && items.every((r) => selected[r.id]);
  const selectRuns = (runs: Run[], on: boolean) => setSelected((sel) => {
    const next = { ...sel };
    for (const r of runs) {
      if (on) next[r.id] = r;
      else delete next[r.id];
    }
    return next;
  });

  const [grouped, setGrouped] = useState(() => localStorage.getItem(GROUP_KEY) !== '0');
  const toggleGrouped = () => {
    localStorage.setItem(GROUP_KEY, grouped ? '0' : '1');
    setGrouped(!grouped);
  };
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  /** Runs in page order, with each curriculum run's jobs folded into one line where it first appears. */
  const lines = useMemo(() => {
    if (!grouped) return items.map((run): Line => ({ kind: 'run', run }));
    const out: Line[] = [];
    const groups = new Map<string, Run[]>();
    for (const run of items) {
      const id = run.curriculum_run_id;
      if (!id) {
        out.push({ kind: 'run', run });
        continue;
      }
      if (!groups.has(id)) {
        groups.set(id, []);
        out.push({ kind: 'group', id, runs: groups.get(id)! });
      }
      groups.get(id)!.push(run);
    }
    return out;
  }, [items, grouped]);

  /** One cell of a run row; `note` replaces the stage name for jobs listed under their curriculum stage. */
  const renderCell = (id: string, r: Run, note?: ReactNode): ReactNode => {
    switch (id) {
      case 'select':
        return (
          <input
            type="checkbox"
            className="h-4 w-4 cursor-pointer accent-primary"
            checked={!!selected[r.id]}
            onClick={(e) => e.stopPropagation()}
            onChange={() => selectRuns([r], !selected[r.id])}
          />
        );
      case 'run':
        return (
          <div className={cn('min-w-0', note && 'pl-10')}>
            <p className="truncate font-medium" title={runTitle(r)}>
              {note && r.curriculum_name ? runTitle(r).replace(`${r.curriculum_name} · `, '') : runTitle(r)}
            </p>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              {note ?? <RobotBadge robot={r.robot} />}
              <span>{typeLabel(r.job_type)}</span>
              <span className="font-mono">{shortId(r.id)}</span>
              {!note && r.curriculum_stage_name && <span className="truncate">· stage {r.curriculum_stage_name}</span>}
            </div>
          </div>
        );
      case 'status':
        return (
          <div className="flex flex-col items-start gap-1">
            <StatusBadge status={r.status} />
            {r.queue_position != null && <span className="text-xs text-muted-foreground">#{r.queue_position} in queue</span>}
            {r.status === 'FAILED' && r.error && (
              <span className="line-clamp-1 max-w-56 text-xs text-rose-600 dark:text-rose-400" title={r.error}>{r.error}</span>
            )}
          </div>
        );
      case 'progress':
        return (
          <div className="w-36">
            <Progress value={r.percent_complete} />
            <p className="mt-1 text-xs tabular-nums text-muted-foreground">
              {r.iteration != null ? formatNumber(r.iteration, 0) : '—'}
              {r.budget != null && ` / ${formatNumber(r.budget, 0)}`}
            </p>
          </div>
        );
      case 'reward':
        return <span className="tabular-nums">{formatNumber(r.mean_reward)}</span>;
      case 'created':
        return <span className="text-muted-foreground" title={r.created_at ?? ''}>{timeAgo(r.created_at)}</span>;
      case 'duration':
        return <span className="tabular-nums text-muted-foreground">{runDuration(r)}</span>;
      default:
        return null;
    }
  };

  const renderRow = (r: Run, note?: ReactNode) => (
    <tr
      key={r.id}
      onClick={() => navigate({ to: '/runs/$runId', params: { runId: r.id } })}
      className={cn('cursor-pointer transition-colors hover:bg-muted/40', selected[r.id] && 'bg-primary/5')}
    >
      {COLUMN_IDS.map((id) => (
        <td
          key={id}
          onClick={id === 'select' ? (e) => e.stopPropagation() : undefined}
          className={cn('px-4 py-3 align-middle', id === 'run' && 'max-w-md', id === 'select' && 'pr-0')}
        >
          {renderCell(id, r, note)}
        </td>
      ))}
    </tr>
  );

  const sortHeader = (label: string, field: string) => <SortHeader label={label} field={field} sort={sort} onSort={(s) => setSearch({ sort: s })} />;
  const headers: Record<string, ReactNode> = {
    select: (
      <input
        type="checkbox"
        className="h-4 w-4 cursor-pointer accent-primary"
        checked={allOnPage}
        onChange={() => selectRuns(items, !allOnPage)}
        title="Select this page"
      />
    ),
    run: 'Run',
    status: 'Status',
    progress: sortHeader('Progress', 'progress'),
    reward: sortHeader('Mean reward', 'reward'),
    created: sortHeader('Created', 'created'),
    duration: 'Duration',
  };

  const currentView: RunsSearch = { view: search.view, type: search.type, q: search.q, sort: search.sort };
  const isSaved = (v: SavedView) => JSON.stringify(v.search) === JSON.stringify(currentView);
  const bulk = async (fn: () => Promise<boolean>) => {
    if (await fn()) setSelected({});
  };

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {robot ? `${robotName(robots, robot)} runs` : 'Every training, evaluation and demo job'}; the robot is picked in the sidebar.
          </p>
        </div>
        <Link
          to="/runs/new"
          search={{ robot: robot || undefined }}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> New run
        </Link>
      </div>

      <QueueBar />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search name, gym, design, id…"
            className="w-72 pl-8"
          />
        </div>
        <div className="flex rounded-lg border bg-card p-0.5">
          {VIEWS.map((f) => (
            <button
              key={f.id}
              onClick={() => setSearch({ view: f.id === 'all' ? undefined : f.id })}
              className={cn(
                'h-8 cursor-pointer rounded-md px-3 text-sm transition-colors',
                view === f.id ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Select value={search.type ?? ''} onChange={(e) => setSearch({ type: e.target.value || undefined })}>
          {TYPE_FILTERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </Select>
        <button
          onClick={toggleGrouped}
          aria-pressed={grouped}
          title="Fold each curriculum run's stage jobs into one expandable row"
          className={cn(
            'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-sm transition-colors',
            grouped ? 'border-primary/40 bg-primary/10 text-foreground' : 'bg-card text-muted-foreground hover:text-foreground',
          )}
        >
          <Waypoints className="h-4 w-4" /> Group curricula
        </button>
        <span className="ml-auto text-sm text-muted-foreground">
          {data ? `${data.total.toLocaleString()} runs` : ''}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Bookmark className="h-4 w-4 text-muted-foreground" />
        {saved.map((v) => (
          <span
            key={v.name}
            className={cn('inline-flex items-center rounded-full border bg-card pl-3 pr-1', isSaved(v) && 'border-primary')}
          >
            <button className="h-7 cursor-pointer pr-1" onClick={() => {
              setText(v.search.q ?? '');
              navigate({ to: '/runs', search: v.search, replace: true });
            }}>
              {v.name}
            </button>
            <button
              className="grid h-5 w-5 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => persist(saved.filter((x) => x.name !== v.name))}
              title="Forget this view"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {naming == null ? (
          <button className="cursor-pointer text-muted-foreground hover:text-foreground" onClick={() => setNaming('')}>
            {saved.length ? 'Save current filters…' : 'Save these filters as a view…'}
          </button>
        ) : (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = naming.trim();
              if (!name) return;
              persist([...saved.filter((x) => x.name !== name), { name, search: currentView }]);
              setNaming(null);
            }}
          >
            <Input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="View name" className="h-7 w-44" />
            <Button size="sm" variant="primary" type="submit">Save</Button>
            <Button size="sm" type="button" onClick={() => setNaming(null)}>Cancel</Button>
          </form>
        )}
      </div>

      {selection.length > 0 && (
        <Card className="sticky top-2 z-10 flex flex-wrap items-center gap-2 px-4 py-2.5 shadow-md">
          <span className="mr-2 text-sm font-medium">{selection.length} selected</span>
          {ACTION_ORDER.map((a) => {
            const { label, icon: Icon } = ACTION_META[a];
            const n = selection.filter((r) => r.actions.includes(a)).length;
            return (
              <Button key={a} size="sm" disabled={!n} onClick={() => bulk(() => perform(selection, a))} title={n ? `${label} ${n}` : `${label} applies to none of the selected runs`}>
                <Icon className="h-3.5 w-3.5" /> {label}{n > 0 && n < selection.length ? ` (${n})` : ''}
              </Button>
            );
          })}
          <Button
            size="sm"
            disabled={selection.length > MAX_COMPARE}
            onClick={() => navigate({ to: '/compare', search: compareSearch(selection.map((r) => r.id)) })}
            title={selection.length > MAX_COMPARE ? `Compare takes at most ${MAX_COMPARE} runs` : 'Overlay their curves, diff settings and evals'}
          >
            <GitCompareArrows className="h-3.5 w-3.5" /> Compare
          </Button>
          <Button size="sm" className="text-rose-600 dark:text-rose-400" disabled={!selection.some((r) => r.deletable)} onClick={() => bulk(() => remove(selection))}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected({})}>Clear</Button>
        </Card>
      )}

      {error ? (
        <Empty title="Couldn't load runs">{String((error as Error).message)}</Empty>
      ) : isLoading ? (
        <div className="grid place-items-center py-16"><Spinner /></div>
      ) : !items.length ? (
        <Empty title="No runs match">Try a different robot, status or search.</Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                {COLUMN_IDS.map((id) => (
                  <th key={id} className={cn('px-4 py-2.5 font-medium', id === 'select' && 'w-10 pr-0')}>{headers[id]}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((line) => line.kind === 'run' ? renderRow(line.run) : (
                <CurriculumRunGroup
                  key={line.id}
                  id={line.id}
                  pageRuns={line.runs}
                  open={openGroups[line.id] ?? line.runs.some((r) => r.status != null && ACTIVE_STATUSES.includes(r.status))}
                  onToggle={() => setOpenGroups((g) => ({
                    ...g,
                    [line.id]: !(g[line.id] ?? line.runs.some((r) => r.status != null && ACTIVE_STATUSES.includes(r.status))),
                  }))}
                  colCount={COLUMN_IDS.length}
                  renderRow={renderRow}
                  selected={(r) => !!selected[r.id]}
                  select={selectRuns}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <span>
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total.toLocaleString()}
          </span>
          <Button size="icon" disabled={page <= 1} onClick={() => setSearch({ page: page - 1 > 1 ? page - 1 : undefined }, true)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="icon" disabled={page * PAGE_SIZE >= data.total} onClick={() => setSearch({ page: page + 1 }, true)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
