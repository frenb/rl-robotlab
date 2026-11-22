import { useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import type { CurriculumRunAction, CurriculumRunSummary, GateCheck, GateCondition } from '../../lib/api';
import { api, keys } from '../../lib/api';
import { cn, formatNumber } from '../../lib/utils';
import { confirmDialog, toast } from '../feedback';
import { Badge, type Tone } from '../ui';

const STATUS: Record<string, { label: string; tone: Tone }> = {
  RUNNING: { label: 'Running', tone: 'blue' },
  CANCEL_REQUESTED: { label: 'Cancelling', tone: 'amber' },
  PASSED: { label: 'Passed', tone: 'green' },
  FAILED_GATE: { label: 'Missed gate', tone: 'red' },
  FAILED: { label: 'Failed', tone: 'red' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export function CurriculumStatusBadge({ status }: { status: string | null }) {
  const s = (status && STATUS[status]) || { label: status ?? 'Unknown', tone: 'neutral' as Tone };
  return (
    <Badge tone={s.tone}>
      {status === 'RUNNING' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {s.label}
    </Badge>
  );
}

const OP_TEXT: Record<string, string> = { '>=': '≥', '<=': '≤', '==': '=', '>': '>', '<': '<' };
export const opText = (op: string) => OP_TEXT[op] ?? op;

export function conditionText(c: GateCondition) {
  return `${c.metric} ${opText(c.op)} ${c.value}`;
}

/** Each gate condition with the value the eval measured, passed or not. */
export function GateChecks({ checks, className }: { checks: GateCheck[]; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {checks.map((c, i) => (
        <span
          key={i}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px]',
            c.passed ? 'border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300' : 'border-rose-500/30 bg-rose-500/8 text-rose-700 dark:text-rose-300',
          )}
          title={c.passed ? 'Met' : 'Not met'}
        >
          {c.passed ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
          {c.metric} {c.actual == null ? 'missing' : formatNumber(c.actual, 3)} {opText(c.op)} {c.value}
        </span>
      ))}
    </div>
  );
}

/** One segment per stage: done, current (with its job's progress), or still to come. */
export function StageLadder({ run, className }: { run: CurriculumRunSummary; className?: string }) {
  const n = Math.max(run.stage_count, 1);
  const failed = run.status === 'FAILED_GATE' || run.status === 'FAILED';
  const current = run.current_job?.percent_complete ?? 0;
  return (
    <div className={cn('flex h-1.5 w-full gap-0.5', className)}>
      {Array.from({ length: n }, (_, i) => {
        const done = run.status === 'PASSED' || i < run.stage_index;
        const here = i === run.stage_index && !done;
        return (
          <div key={i} className="relative h-full flex-1 overflow-hidden rounded-full bg-muted">
            {done && <div className="absolute inset-0 bg-emerald-500" />}
            {here && failed && <div className="absolute inset-0 bg-rose-500" />}
            {here && !failed && run.status === 'RUNNING' && (
              <div className="absolute inset-y-0 left-0 bg-primary transition-[width] duration-500" style={{ width: `${Math.max(4, current)}%` }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

const CONFIRM: Record<Exclude<CurriculumRunAction, 'delete'>, (run: CurriculumRunSummary) => Parameters<typeof confirmDialog>[0]> = {
  cancel: () => ({
    title: 'Cancel the curriculum run?',
    message: 'Its queued or running stage job is cancelled and no further stages are queued. Finished stages and their models are kept; Retry reruns the cancelled stage.',
    confirmLabel: 'Cancel run',
    danger: true,
  }),
  retry: (run) => ({
    title: 'Retry the curriculum run?',
    message: run.status === 'FAILED_GATE'
      ? `Runs one more attempt at ${run.stage_name ?? 'this stage'}, continuing from the last attempt's checkpoint.`
      : `Runs ${run.stage_name ?? 'this stage'} again as new jobs.`,
    confirmLabel: 'Retry',
  }),
  skip: (run) => ({
    title: `Skip the gate of ${run.stage_name ?? 'this stage'}?`,
    message: 'The stage is marked skipped (not passed) and the next stage starts from the missed attempt\u2019s checkpoint.',
    confirmLabel: 'Skip gate',
  }),
};

const DONE_TEXT: Record<CurriculumRunAction, string> = {
  cancel: 'Curriculum run cancelling.', retry: 'Curriculum run retrying.', skip: 'Gate skipped; the next stage is being queued.', delete: 'Curriculum run deleted.',
};

/** Confirms, acts and refreshes; resolves true when the server accepted it. */
export function useCurriculumRunAction() {
  const qc = useQueryClient();
  return async (run: CurriculumRunSummary, action: CurriculumRunAction, deleteJobs = false): Promise<boolean> => {
    if (action !== 'delete' && !(await confirmDialog(CONFIRM[action](run)))) return false;
    try {
      await api.curriculumRunAction(run.id, action, deleteJobs);
      toast('success', DONE_TEXT[action]);
      return true;
    } catch (e) {
      toast('error', (e as Error).message);
      return false;
    } finally {
      qc.invalidateQueries({ queryKey: keys.allCurricula });
      qc.invalidateQueries({ queryKey: keys.allRuns });
    }
  };
}
