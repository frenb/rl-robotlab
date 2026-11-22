import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Plus } from 'lucide-react';
import { HeadlineChart } from '../components/run/MetricsTab';
import { RobotBadge, StatusBadge, runTitle, typeLabel } from '../components/RunBits';
import { Card, Empty, Progress, Spinner } from '../components/ui';
import { api, keys, type Run, type RunQuery } from '../lib/api';
import { robotName, useRobots, useSelectedRobot } from '../lib/robots';
import { formatNumber, runDuration, timeAgo } from '../lib/utils';

function useRunList(query: RunQuery) {
  return useQuery({ queryKey: keys.runs(query), queryFn: () => api.runs(query) });
}

function RunningCard({ run }: { run: Run }) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/runs/$runId" params={{ runId: run.id }} className="line-clamp-2 font-medium hover:underline" title={runTitle(run)}>
            {runTitle(run)}
          </Link>
          <div className="mt-1 flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
            <RobotBadge robot={run.robot} />
            <span>{typeLabel(run.job_type)}</span>
            <span>· {runDuration(run)}</span>
          </div>
        </div>
        <StatusBadge status={run.status} />
      </div>
      {run.job_type === 'TRAIN' && <HeadlineChart run={run} height={130} />}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <Progress value={run.percent_complete} className="flex-1" />
        <span className="tabular-nums">
          {formatNumber(run.iteration, 0)}{run.budget != null && ` / ${formatNumber(run.budget, 0)}`}
        </span>
      </div>
    </Card>
  );
}

function RunRow({ run }: { run: Run }) {
  return (
    <Link
      to="/runs/$runId"
      params={{ runId: run.id }}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{runTitle(run)}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {typeLabel(run.job_type)} · {timeAgo(run.ended_at ?? run.created_at)}
          {run.status === 'FAILED' && run.error ? ` · ${run.error}` : ''}
        </p>
      </div>
      <RobotBadge robot={run.robot} />
      <StatusBadge status={run.status} />
    </Link>
  );
}

function Section({ title, link, children }: { title: string; link?: boolean; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {link && (
          <Link to="/runs" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            All runs <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

export function HomePage() {
  const [robot] = useSelectedRobot();
  const { data: robots } = useRobots();
  const scope = robot || undefined;
  const running = useRunList({ robot: scope, status: ['IN_PROGRESS', 'PAUSE_REQUESTED', 'PAUSED'], limit: 12 });
  const queued = useRunList({ robot: scope, status: ['NOT_STARTED'], limit: 1 });
  const failed = useRunList({ robot: scope, status: ['FAILED'], limit: 5 });
  const recent = useRunList({ robot: scope, status: ['DONE'], limit: 8 });

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-8 p-4 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {robot ? robotName(robots, robot) : 'All robots'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {running.data ? `${running.data.total} running` : '…'}
            {queued.data ? ` · ${queued.data.total} queued` : ''}
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

      <Section title="Running now">
        {running.isLoading ? (
          <Spinner />
        ) : running.data?.items.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {running.data.items.map((r) => <RunningCard key={r.id} run={r} />)}
          </div>
        ) : (
          <Empty title="Nothing is training">Queued runs start as soon as a worker for their robot is free.</Empty>
        )}
      </Section>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="Needs attention" link>
          <Card className="divide-y overflow-hidden">
            {failed.data?.items.length ? (
              failed.data.items.map((r) => <RunRow key={r.id} run={r} />)
            ) : (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">No failed runs.</p>
            )}
          </Card>
        </Section>
        <Section title="Recently finished" link>
          <Card className="divide-y overflow-hidden">
            {recent.data?.items.length ? (
              recent.data.items.map((r) => <RunRow key={r.id} run={r} />)
            ) : (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">No finished runs yet.</p>
            )}
          </Card>
        </Section>
      </div>
    </div>
  );
}
