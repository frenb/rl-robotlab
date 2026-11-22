import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Ban, Check, Copy, GitCompareArrows, RotateCcw, Trophy, Waypoints } from 'lucide-react';
import { compareSearch } from './ComparePage';
import { useState, type ReactNode } from 'react';
import { confirmDialog, toast } from '../components/feedback';
import { LogsTab } from '../components/run/LogsTab';
import { LatestClip, MediaTab } from '../components/run/MediaTab';
import { HeadlineChart, MetricsTab } from '../components/run/MetricsTab';
import { RunActions } from '../components/run/RunActions';
import { RobotBadge, StatusBadge, runTitle, typeLabel } from '../components/RunBits';
import { Badge, Button, Card, CardHeader, Empty, Progress, Spinner } from '../components/ui';
import { api, keys, type CurriculumRunInfo, type JumpStatus, type Run } from '../lib/api';
import { cn, formatNumber, runDuration, shortId } from '../lib/utils';

export const RUN_TABS = ['overview', 'metrics', 'media', 'logs', 'config'] as const;
export type RunTab = (typeof RUN_TABS)[number];

const TAB_LABELS: Record<RunTab, string> = {
  overview: 'Overview', metrics: 'Metrics', media: 'Media', logs: 'Logs', config: 'Config',
};

function CopyId({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(id);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="inline-flex cursor-pointer items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
      title="Copy full id"
    >
      {shortId(id)}
      {done ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function Stat({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 text-xl font-semibold tabular-nums">{children}</div>
      {sub && <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  if (value == null || value === '') return null;
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}

const JUMP_REASONS: Record<string, string> = {
  recovery_gate: 'recovery check passed',
  update_limit: 'update limit reached',
};

function JumpTraining({ jump }: { jump: JumpStatus }) {
  if (jump.enabled) {
    const why = jump.reason ? JUMP_REASONS[jump.reason] ?? jump.reason : null;
    return (
      <span>
        <Badge tone="green">On</Badge> since update {formatNumber(jump.since_update, 0)}
        {why && <span className="text-muted-foreground"> ({why})</span>}
      </span>
    );
  }
  const c = jump.last_check;
  if (!c) return <span className="text-muted-foreground">Not on yet</span>;
  return (
    <div className="space-y-1">
      <div>
        <Badge tone="amber">Not on yet</Badge>{' '}
        <span className="text-muted-foreground">
          recovery check at update {formatNumber(c.update, 0)} {c.passed ? `passed (${c.consecutive_passes ?? 1} in a row)` : 'failed'}
        </span>
      </div>
      {c.failing.length > 0 && (
        <div className="text-xs text-muted-foreground">
          Below the pass mark: {c.failing.map((f) => `${f.name.replace(/_/g, ' ')} ${f.success_rate != null ? `${Math.round(f.success_rate * 100)}%` : '?'}`).join(', ')}
        </div>
      )}
    </div>
  );
}

function Overview({ run, job, jump }: { run: Run; job: Record<string, unknown>; jump: JumpStatus | null }) {
  const fullError = (job.error || job.eval_error) as string | undefined;
  return (
    <div className="flex flex-col gap-6">
      {run.status === 'FAILED' && fullError && (
        <Card className="border-rose-500/40 bg-rose-500/5 p-4">
          <p className="text-sm font-medium text-rose-700 dark:text-rose-300">{run.error}</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">Full error</summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs">{fullError}</pre>
          </details>
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Progress" sub={<Progress value={run.percent_complete} />}>
          {run.percent_complete != null ? `${formatNumber(run.percent_complete, 1)}%` : '—'}
        </Stat>
        <Stat label="Iteration" sub={run.budget != null ? `of ${formatNumber(run.budget, 0)}` : undefined}>
          {formatNumber(run.iteration, 0)}
        </Stat>
        <Stat label="Mean reward" sub={run.mean_episode_length != null ? `episode length ${formatNumber(run.mean_episode_length, 0)}` : undefined}>
          {formatNumber(run.mean_reward)}
        </Stat>
        <Stat label="Duration" sub={run.started_at ? `started ${new Date(run.started_at).toLocaleString()}` : 'not started'}>
          {runDuration(run)}
        </Stat>
      </div>
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Card className="pb-4">
          <CardHeader title="Learning curve" description="Smoothed; the Metrics tab has every curve." />
          <div className="px-4 pt-3"><HeadlineChart run={run} height={240} /></div>
        </Card>
        <Card className="pb-4">
          <CardHeader title="Latest video" />
          <div className="px-4 pt-3"><LatestClip run={run} /></div>
        </Card>
      </div>
      <Card className="px-5 py-3">
        <dl className="divide-y">
          <Detail label="Gym" value={run.gym_name} />
          <Detail label="Task" value={run.task_id} />
          <Detail label="Reward design" value={run.reward_design_name} />
          <Detail label="Experiment design" value={run.experiment_design_name} />
          <Detail
            label="Curriculum"
            value={run.curriculum_name && `${run.curriculum_name}${run.curriculum_stage_name ? ` · ${run.curriculum_stage_name}` : ''}`}
          />
          {jump && <Detail label="Jump training" value={<JumpTraining jump={jump} />} />}
          <Detail label="Created" value={run.created_at && new Date(run.created_at).toLocaleString()} />
          <Detail label="Ended" value={run.ended_at && new Date(run.ended_at).toLocaleString()} />
        </dl>
      </Card>
    </div>
  );
}

function ConfigTab({ job }: { job: Record<string, unknown> }) {
  const { reward_design_code: code, ...rest } = job;
  return (
    <div className="flex flex-col gap-6">
      {typeof code === 'string' && (
        <Card className="overflow-hidden">
          <CardHeader title="Reward design code" />
          <pre className="m-4 max-h-96 overflow-auto rounded-lg bg-muted p-4 font-mono text-xs">{code}</pre>
        </Card>
      )}
      <Card className="overflow-hidden">
        <CardHeader title="Job document" description="Everything stored for this run." />
        <pre className="m-4 max-h-[70vh] overflow-auto rounded-lg bg-muted p-4 font-mono text-xs">
          {JSON.stringify(rest, null, 2)}
        </pre>
      </Card>
    </div>
  );
}

const CR_RETRYABLE = ['FAILED_GATE', 'FAILED', 'CANCELLED'];

/** The curriculum this run is a stage of; cancel and retry act on the whole curriculum run. */
function CurriculumCard({ cr, run }: { cr: CurriculumRunInfo; run: Run }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const act = async (action: 'cancel' | 'retry') => {
    const ok = await confirmDialog(action === 'cancel'
      ? { title: 'Cancel the curriculum run?', message: 'Stops this stage and every stage after it. Retry later picks up from the failed or cancelled stage.', confirmLabel: 'Cancel curriculum', danger: true }
      : { title: 'Retry the curriculum run?', message: cr.status === 'FAILED_GATE' ? 'Runs one more attempt at this stage, continuing from the last attempt\u2019s checkpoint.' : 'Runs this stage again as new jobs.', confirmLabel: 'Retry' });
    if (!ok) return;
    setBusy(true);
    try {
      await api.curriculumRunAction(cr.id, action);
      toast('success', action === 'cancel' ? 'Curriculum run cancelling.' : 'Curriculum run retrying.');
    } catch (e) {
      toast('error', `${action === 'cancel' ? 'Cancel' : 'Retry'} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: keys.run(run.id) });
      qc.invalidateQueries({ queryKey: keys.allRuns });
    }
  };
  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
      <Waypoints className="h-4 w-4 text-muted-foreground" />
      <span className="min-w-0">
        Stage <b>{run.curriculum_stage_name ?? (cr.stage_index != null ? cr.stage_index + 1 : '?')}</b>
        {cr.stage_count != null && cr.stage_index != null && <> ({cr.stage_index + 1} of {cr.stage_count})</>} of{' '}
        <Link to="/curricula/runs/$runId" params={{ runId: cr.id }} className="font-medium hover:underline" title="Every stage, its gate and its retries">{cr.name ?? 'a curriculum'}</Link>
        {cr.attempt ? <span className="text-muted-foreground"> · attempt {cr.attempt + 1}</span> : null}
      </span>
      <Badge tone={cr.status === 'RUNNING' ? 'blue' : cr.status === 'PASSED' ? 'green' : cr.status === 'CANCELLED' ? 'neutral' : CR_RETRYABLE.includes(cr.status ?? '') ? 'red' : 'neutral'}>
        Curriculum {String(cr.status ?? 'unknown').toLowerCase().replace(/_/g, ' ')}
      </Badge>
      {cr.error && <span className="min-w-0 truncate text-xs text-rose-600 dark:text-rose-400" title={cr.error}>{cr.error}</span>}
      <div className="ml-auto flex gap-2">
        {cr.status === 'RUNNING' && (
          <Button size="sm" disabled={busy} onClick={() => act('cancel')}><Ban className="h-3.5 w-3.5" /> Cancel curriculum</Button>
        )}
        {CR_RETRYABLE.includes(cr.status ?? '') && (
          <Button size="sm" disabled={busy} onClick={() => act('retry')}><RotateCcw className="h-3.5 w-3.5" /> Retry curriculum</Button>
        )}
      </div>
    </Card>
  );
}

export function RunPage() {
  const { runId } = useParams({ strict: false }) as { runId: string };
  const search = useSearch({ strict: false }) as { tab?: RunTab };
  const tab: RunTab = search.tab ?? 'overview';
  const { data, isLoading, error } = useQuery({ queryKey: keys.run(runId), queryFn: () => api.run(runId) });

  if (isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (error || !data) {
    return <div className="p-8"><Empty title="Couldn't load this run">{String((error as Error)?.message ?? '')}</Empty></div>;
  }
  const { run, job } = data;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 sm:p-8">
      <div>
        <Link to="/runs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Runs
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{runTitle(run)}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <StatusBadge status={run.status} />
              {run.queue_position != null && <span>#{run.queue_position} in queue</span>}
              <RobotBadge robot={run.robot} />
              <span>{typeLabel(run.job_type)}</span>
              <CopyId id={run.id} />
              {run.cloned_from && (
                <span>
                  · cloned from{' '}
                  <Link to="/runs/$runId" params={{ runId: run.cloned_from }} className="font-mono hover:text-foreground hover:underline">
                    {shortId(run.cloned_from)}
                  </Link>
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/compare"
              search={compareSearch(run.cloned_from ? [run.cloned_from, run.id] : [run.id])}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-3.5 text-sm font-medium hover:bg-muted"
              title={run.cloned_from ? 'Compare with the run it was cloned from; add more there' : 'Open in Compare and add runs to set it against'}
            >
              <GitCompareArrows className="h-4 w-4" /> Compare
            </Link>
            {run.job_type === 'TRAIN' && (
              <Link
                to="/models"
                search={{ run: run.id, filter: 'all' }}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-3.5 text-sm font-medium hover:bg-muted"
                title="The checkpoints this run saved: evaluate, export or promote them"
              >
                <Trophy className="h-4 w-4" /> Checkpoints
              </Link>
            )}
            <RunActions run={run} />
          </div>
        </div>
      </div>

      {data.curriculum_run && <CurriculumCard cr={data.curriculum_run} run={run} />}

      <div className="flex gap-1 border-b">
        {RUN_TABS.map((t) => (
          <Link
            key={t}
            to="/runs/$runId"
            params={{ runId }}
            search={{ tab: t === 'overview' ? undefined : t }}
            activeOptions={{ includeSearch: true, exact: true }}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              t === tab ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {TAB_LABELS[t]}
          </Link>
        ))}
      </div>

      {tab === 'overview' && <Overview run={run} job={job} jump={data.jump ?? null} />}
      {tab === 'metrics' && <MetricsTab run={run} />}
      {tab === 'media' && <MediaTab run={run} />}
      {tab === 'logs' && <LogsTab run={run} />}
      {tab === 'config' && <ConfigTab job={job} />}
    </div>
  );
}
