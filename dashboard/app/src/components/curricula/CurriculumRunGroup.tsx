import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, ExternalLink, Waypoints } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { api, keys, type CurriculumResult, type CurriculumRunJob, type Run } from '../../lib/api';
import { cn, formatNumber, runDuration, shortId, timeAgo } from '../../lib/utils';
import { RobotBadge } from '../RunBits';
import { Badge, Spinner, type Tone } from '../ui';
import { CurriculumStatusBadge, GateChecks, StageLadder } from './CurriculumBits';

const ACTIVE = new Set(['RUNNING', 'CANCEL_REQUESTED']);

export const isActiveCurriculum = (status: string | null | undefined) => !!status && ACTIVE.has(status);

function stageState(i: number, run: { status: string | null; stage_index: number }, results: CurriculumResult[]): { label: string; tone: Tone } {
  const last = results.filter((r) => r.stage_index === i).at(-1);
  if (last?.passed) return { label: 'Passed', tone: 'green' };
  if (last?.skipped) return { label: 'Gate skipped', tone: 'amber' };
  if (run.status === 'PASSED' || i < run.stage_index) return { label: 'Done', tone: 'green' };
  if (i > run.stage_index) return { label: 'Not reached', tone: 'neutral' };
  if (run.status === 'RUNNING') return { label: 'Current', tone: 'blue' };
  if (run.status === 'FAILED_GATE') return { label: 'Missed gate', tone: 'red' };
  if (run.status === 'FAILED') return { label: 'Failed', tone: 'red' };
  return { label: 'Stopped here', tone: 'neutral' };
}

const jobLabel = (j: CurriculumRunJob) =>
  `${j.role === 'eval' ? 'Gate eval' : 'Training'}${j.attempt > 1 ? ` · attempt ${j.attempt}` : ''}`;

/**
 * One curriculum run as an accordion in the runs table: a summary row, and
 * when open, every stage with its gate result and the jobs that ran it.
 * `renderRow` draws a job like any other run row; `select` (de)selects jobs.
 */
export function CurriculumRunGroup({
  id, pageRuns, open, onToggle, colCount, renderRow, selected, select,
}: {
  id: string;
  pageRuns: Run[];
  open: boolean;
  onToggle: () => void;
  colCount: number;
  renderRow: (run: Run, note?: ReactNode) => ReactNode;
  selected: (run: Run) => boolean;
  select: (runs: Run[], on: boolean) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: keys.curriculumRun(id),
    queryFn: () => api.curriculumRun(id),
    refetchInterval: (q) => (isActiveCurriculum(q.state.data?.run.status) ? 10_000 : false),
  });
  const cr = data?.run;
  const jobs: Run[] = data?.jobs ?? pageRuns;
  const first = pageRuns[0];
  const name = cr?.curriculum_name ?? first?.curriculum_name ?? 'Curriculum';
  const allSelected = jobs.length > 0 && jobs.every(selected);
  const starts = jobs.map((j) => j.started_at).filter(Boolean).sort() as string[];
  const ended = cr && !isActiveCurriculum(cr.status) ? (cr.ended_at ?? jobs.map((j) => j.ended_at).filter(Boolean).sort().at(-1) ?? null) : null;

  return (
    <>
      <tr onClick={onToggle} className={cn('cursor-pointer bg-muted/25 transition-colors hover:bg-muted/50', open && 'bg-muted/40')}>
        <td className="px-4 py-3 pr-0 align-middle" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            className="h-4 w-4 cursor-pointer accent-primary"
            checked={allSelected}
            onChange={() => select(jobs, !allSelected)}
            title="Select every job in this curriculum run"
          />
        </td>
        <td className="max-w-md px-4 py-3 align-middle">
          <div className="flex min-w-0 items-center gap-2">
            <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
            <Waypoints className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="truncate font-medium">{name}</p>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <RobotBadge robot={cr?.robot ?? first?.robot ?? ''} />
                <span>Curriculum</span>
                <span className="font-mono">{shortId(id)}</span>
                <span>· {jobs.length} job{jobs.length === 1 ? '' : 's'}</span>
                <Link
                  to="/curricula/runs/$runId"
                  params={{ runId: id }}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-0.5 hover:text-foreground"
                  title="Open the curriculum run"
                >
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </div>
          </div>
        </td>
        <td className="px-4 py-3 align-middle">
          {cr ? (
            <div className="flex flex-col items-start gap-1">
              <CurriculumStatusBadge status={cr.status} />
              <span className="text-xs text-muted-foreground">
                Stage {Math.min(cr.stage_index + 1, cr.stage_count)} of {cr.stage_count}{cr.stage_name ? ` · ${cr.stage_name}` : ''}
              </span>
            </div>
          ) : isLoading ? <Spinner className="h-3.5 w-3.5" /> : <span className="text-xs text-muted-foreground">—</span>}
        </td>
        <td className="px-4 py-3 align-middle">
          {cr && (
            <div className="w-36">
              <StageLadder run={cr} />
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">{cr.stages_done} / {cr.stage_count} stages</p>
            </div>
          )}
        </td>
        <td className="px-4 py-3 align-middle tabular-nums">{formatNumber(cr?.current_job?.mean_reward ?? first?.mean_reward)}</td>
        <td className="px-4 py-3 align-middle text-muted-foreground" title={cr?.created_at ?? ''}>{timeAgo(cr?.created_at ?? first?.created_at ?? null)}</td>
        <td className="px-4 py-3 align-middle tabular-nums text-muted-foreground">{runDuration({ started_at: starts[0] ?? null, ended_at: ended })}</td>
      </tr>

      {open && (
        error ? (
          <>
            <tr><td colSpan={colCount} className="px-4 py-2 pl-16 text-xs text-muted-foreground">Couldn't load the curriculum run ({(error as Error).message}); showing its runs on this page.</td></tr>
            {pageRuns.map((r) => renderRow(r))}
          </>
        ) : !data ? (
          <tr><td colSpan={colCount} className="px-4 py-3 pl-16"><Spinner className="h-3.5 w-3.5" /></td></tr>
        ) : (
          Array.from({ length: Math.max(cr!.stage_count, 1) }, (_, i) => {
            const stage = cr!.stages[i];
            const state = stageState(i, cr!, cr!.results);
            const gate = cr!.results.filter((r) => r.stage_index === i).at(-1);
            const stageJobs = data.jobs
              .filter((j) => j.stage_index === i)
              .sort((a, b) => a.attempt - b.attempt || (a.role === 'eval' ? 1 : 0) - (b.role === 'eval' ? 1 : 0));
            return (
              <Fragment key={i}>
                <tr className="bg-card">
                  <td />
                  <td colSpan={colCount - 1} className="px-4 py-2 pl-12">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                      <span className="font-medium text-foreground">Stage {i + 1}{stage?.name ? ` · ${stage.name}` : ''}</span>
                      <Badge tone={state.tone}>{state.label}</Badge>
                      {gate?.gate?.length ? <GateChecks checks={gate.gate} /> : null}
                      {!stageJobs.length && <span className="text-muted-foreground">No jobs yet</span>}
                    </div>
                  </td>
                </tr>
                {stageJobs.map((j) => renderRow(j, <span className="text-foreground/80">{jobLabel(j)}</span>))}
              </Fragment>
            );
          })
        )
      )}
    </>
  );
}
