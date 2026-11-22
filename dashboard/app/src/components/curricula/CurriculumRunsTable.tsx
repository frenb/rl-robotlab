import { Link } from '@tanstack/react-router';
import type { CurriculumRunSummary } from '../../lib/api';
import { formatDuration, timeAgo } from '../../lib/utils';
import { RobotBadge, StatusBadge } from '../RunBits';
import { Card } from '../ui';
import { CurriculumStatusBadge, GateChecks, StageLadder } from './CurriculumBits';

function duration(run: CurriculumRunSummary) {
  if (!run.created_at) return '—';
  const end = run.ended_at ? new Date(run.ended_at).getTime() : Date.now();
  return formatDuration(end - new Date(run.created_at).getTime());
}

export function CurriculumRunsTable({ runs, showCurriculum = true, showRobot = false }: {
  runs: CurriculumRunSummary[]; showCurriculum?: boolean; showRobot?: boolean;
}) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            {showCurriculum && <th className="px-4 py-2.5 font-medium">Curriculum</th>}
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="w-[30%] px-4 py-2.5 font-medium">Stage</th>
            <th className="px-4 py-2.5 font-medium">Last gate</th>
            <th className="px-4 py-2.5 font-medium">Started</th>
            <th className="px-4 py-2.5 text-right font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
              {showCurriculum && (
                <td className="max-w-72 px-4 py-3">
                  <Link to="/curricula/runs/$runId" params={{ runId: r.id }} className="block truncate font-medium hover:underline">
                    {r.curriculum_name ?? 'Curriculum run'}
                  </Link>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {showRobot && <RobotBadge robot={r.robot} />}
                    {r.curriculum_version != null && <span>v{r.curriculum_version}</span>}
                  </div>
                </td>
              )}
              <td className="px-4 py-3">
                <Link to="/curricula/runs/$runId" params={{ runId: r.id }}><CurriculumStatusBadge status={r.status} /></Link>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">
                    <span className="font-medium">{r.status === 'PASSED' ? 'All stages' : r.stage_name ?? '—'}</span>
                    <span className="text-muted-foreground"> · {Math.min(r.stage_index + 1, r.stage_count)}/{r.stage_count}{r.attempt ? ` · attempt ${r.attempt + 1}` : ''}</span>
                  </span>
                  {r.current_job && (
                    <Link to="/runs/$runId" params={{ runId: r.current_job.id }} className="shrink-0" title={`${r.pending?.role === 'eval' ? 'Gate eval' : 'Training'} job`}>
                      <StatusBadge status={r.current_job.status} />
                    </Link>
                  )}
                </div>
                <StageLadder run={r} className="mt-1.5" />
                {r.error && <p className="mt-1 truncate text-xs text-rose-600 dark:text-rose-400" title={r.error}>{r.error}</p>}
              </td>
              <td className="px-4 py-3">
                {r.last_gate ? <GateChecks checks={r.last_gate.checks} /> : <span className="text-xs text-muted-foreground">—</span>}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{timeAgo(r.created_at)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right text-xs tabular-nums text-muted-foreground">{duration(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
