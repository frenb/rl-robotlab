import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { CurriculumStatusBadge } from '../components/curricula/CurriculumBits';
import { CurriculumRunsTable } from '../components/curricula/CurriculumRunsTable';
import { RobotBadge } from '../components/RunBits';
import { Badge, Card, Empty, Spinner } from '../components/ui';
import { api, keys } from '../lib/api';
import { robotName, useRobots, useSelectedRobot } from '../lib/robots';
import { formatNumber, timeAgo } from '../lib/utils';

const RUNS_SHOWN = 15;

export function useCurriculumCaps() {
  return useQuery({ queryKey: keys.curriculumCaps, queryFn: api.curriculumCaps, staleTime: 5 * 60_000 });
}

export function CurriculaPage() {
  const [robot] = useSelectedRobot();
  const { data: robots } = useRobots();
  const { data: caps } = useCurriculumCaps();
  const [archived, setArchived] = useState(false);
  const enabled = Object.entries(caps?.robots ?? {}).filter(([, c]) => c.enabled).map(([id]) => id);
  const robotEnabled = robot ? enabled.includes(robot) : enabled.length > 0;
  const newRobot = robot && enabled.includes(robot) ? robot : enabled[0];

  const runsQuery = { robot: robot || undefined, limit: RUNS_SHOWN };
  const runs = useQuery({
    queryKey: keys.curriculumRuns(runsQuery),
    queryFn: () => api.curriculumRuns(runsQuery),
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'RUNNING' || r.status === 'CANCEL_REQUESTED') ? 10_000 : 60_000),
  });
  const list = useQuery({ queryKey: keys.curricula(robot, archived), queryFn: () => api.curricula(robot, archived) });

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-4 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Curricula</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Chains of training stages{robot ? ` for ${robotName(robots, robot)}` : ''}: each stage trains, an eval checks its gate, and the next stage starts from its checkpoint.
          </p>
        </div>
        {newRobot ? (
          <Link
            to="/curricula/$curriculumId"
            params={{ curriculumId: 'new' }}
            search={{ robot: newRobot }}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> New curriculum
          </Link>
        ) : null}
      </div>

      {caps && !robotEnabled && (
        <Card className="px-4 py-3 text-sm text-muted-foreground">
          Curricula aren't enabled for {robot ? robotName(robots, robot) : 'any robot'} yet; a robot opts in with <code className="font-mono text-xs">curriculum.enabled</code> in its manifest
          {enabled.length ? <> (on today: {enabled.map((id) => robotName(robots, id)).join(', ')})</> : null}.
        </Card>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Runs</h2>
          {runs.data && runs.data.total > RUNS_SHOWN && <span className="text-xs text-muted-foreground">Latest {RUNS_SHOWN} of {runs.data.total}</span>}
        </div>
        {runs.isLoading ? (
          <div className="grid place-items-center py-10"><Spinner /></div>
        ) : runs.error ? (
          <Empty title="Couldn't load curriculum runs">{(runs.error as Error).message}</Empty>
        ) : !runs.data?.items.length ? (
          <Empty title="No curriculum runs yet">Open a curriculum and start a run; each stage then appears on the Runs page as it's queued.</Empty>
        ) : (
          <CurriculumRunsTable runs={runs.data.items} showRobot={!robot} />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Curricula</h2>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Show archived
          </label>
        </div>
        {list.isLoading ? (
          <div className="grid place-items-center py-10"><Spinner /></div>
        ) : list.error ? (
          <Empty title="Couldn't load curricula">{(list.error as Error).message}</Empty>
        ) : !list.data?.length ? (
          <Empty title="No curricula yet">{newRobot ? 'Create one to chain training stages with gates between them.' : null}</Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {list.data.map((c) => (
              <Link key={c.id} to="/curricula/$curriculumId" params={{ curriculumId: c.id }} className="group">
                <Card className="flex h-full flex-col gap-3 p-4 transition-colors group-hover:bg-muted/40">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{c.name ?? c.id}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {!robot && <RobotBadge robot={c.robot} />}
                        <span>v{c.version}</span>
                        <span>· updated {timeAgo(c.updated_at)}</span>
                        {c.archived && <Badge>archived</Badge>}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                  </div>
                  {c.description && <p className="line-clamp-2 text-xs text-muted-foreground">{c.description}</p>}
                  <div className="flex flex-wrap items-center gap-1">
                    {c.stages.map((s, i) => (
                      <span key={i} className="inline-flex items-center gap-1 text-xs">
                        {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/60" />}
                        <span className="rounded-md bg-muted px-1.5 py-0.5" title={`${s.gym ?? ''}${s.budget ? ` · ${formatNumber(s.budget)}` : ''}${s.gated ? ' · gated' : ''}`}>
                          {s.name ?? s.id}
                        </span>
                      </span>
                    ))}
                  </div>
                  <div className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{c.runs?.total ? `${c.runs.total} run${c.runs.total === 1 ? '' : 's'}` : 'Never run'}</span>
                    {c.last_run && <CurriculumStatusBadge status={c.last_run.status} />}
                    {c.last_run && <span>{timeAgo(c.last_run.created_at)}</span>}
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
