import type { JudgeVerdict, Proposal, ProposalStatus } from '../../lib/api';
import { cn, formatNumber } from '../../lib/utils';
import { Badge, type Tone } from '../ui';

export const PROPOSAL_STATUS: Record<ProposalStatus, { label: string; tone: Tone; about: string }> = {
  pending_judge: { label: 'Judging', tone: 'neutral', about: 'The judge is reviewing the draft' },
  pending_user: { label: 'Awaiting you', tone: 'violet', about: 'Judged; waiting for your decision' },
  deferred: { label: 'Deferred', tone: 'amber', about: 'Set aside; still takes a decision' },
  approved: { label: 'Approved', tone: 'blue', about: 'The orchestrator picks it up next' },
  implementing: { label: 'Implementing', tone: 'blue', about: 'A Cursor agent is writing the code change' },
  pr_open: { label: 'PR open', tone: 'blue', about: 'The code change is in a pull request' },
  training: { label: 'Training', tone: 'blue', about: 'Its runs are queued or training' },
  done: { label: 'Done', tone: 'green', about: 'Runs finished and the outcome is in' },
  failed: { label: 'Failed', tone: 'red', about: 'Implementation or every run failed' },
  rejected: { label: 'Rejected', tone: 'neutral', about: 'Rejected by you or the judge' },
  cancelled: { label: 'Cancelled', tone: 'neutral', about: 'Cancelled' },
};

export function ProposalStatusBadge({ status }: { status: ProposalStatus | null }) {
  const s = status ? PROPOSAL_STATUS[status] : null;
  return (
    <Badge tone={s?.tone ?? 'neutral'} className="whitespace-nowrap">
      {(status === 'training' || status === 'implementing') && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      <span title={s?.about}>{s?.label ?? status ?? 'Unknown'}</span>
    </Badge>
  );
}

const VERDICT: Record<JudgeVerdict, { label: string; tone: Tone }> = {
  strong_accept: { label: 'Strong accept', tone: 'green' },
  accept: { label: 'Accept', tone: 'green' },
  weak_accept: { label: 'Weak accept', tone: 'amber' },
  weak_reject: { label: 'Weak reject', tone: 'amber' },
  reject: { label: 'Reject', tone: 'red' },
};

export function VerdictBadge({ verdict, score }: { verdict: JudgeVerdict | null; score?: number | null }) {
  if (!verdict) return <Badge>Not judged</Badge>;
  const v = VERDICT[verdict] ?? { label: verdict, tone: 'neutral' as Tone };
  return (
    <Badge tone={v.tone} className="whitespace-nowrap">
      Judge: {v.label}{score != null && <span className="opacity-75">· {Math.round(score * 100)}%</span>}
    </Badge>
  );
}

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  supported: { label: 'Supported', tone: 'green' },
  rejected: { label: 'Not supported', tone: 'red' },
  inconclusive: { label: 'Inconclusive', tone: 'amber' },
};

export function OutcomeBadge({ results }: { results: Proposal['results'] }) {
  if (!results?.verdict) return null;
  const o = OUTCOME[results.verdict] ?? { label: results.verdict, tone: 'neutral' as Tone };
  return <Badge tone={o.tone}>{o.label}</Badge>;
}

/** The success criterion in one line, e.g. "avg_return(exp1) >= 10% over base". */
export function criterionText(p: Pick<Proposal, 'primary_parsed' | 'primary'>): string {
  const c = p.primary_parsed;
  if (!c?.metric) return p.primary ?? '—';
  const t = c.threshold == null ? '?' : c.threshold_kind === 'relative' ? `${formatNumber(c.threshold * 100, 1)}%` : formatNumber(c.threshold);
  return `${c.metric}(${c.arm_a ?? '?'}) ${c.comparator ?? '>='} ${t} ${c.threshold_kind === 'relative' ? 'over' : 'vs'} ${c.arm_b ?? '?'}`;
}

/** The outcome's primary delta in the metric's own units (arm_a minus arm_b). */
export function deltaText(p: Pick<Proposal, 'results' | 'primary_parsed'>): string {
  const d = p.results?.primary_delta;
  if (d == null) return '—';
  return `${d >= 0 ? '+' : ''}${formatNumber(d)} ${p.primary_parsed?.metric ?? ''}`.trim();
}

export function usd(v: number | null | undefined, digits = 2): string {
  return v == null ? '—' : `$${v.toFixed(v > 0 && v < 0.01 ? 4 : digits)}`;
}

const AGENTS: Record<string, string> = {
  'madscientist.researcher': 'Researcher',
  'madscientist.judge': 'Judge',
  'madscientist.email_bridge': 'Email',
  'madscientist.orchestrator': 'Orchestrator',
  'madscientist.outcome_ingester': 'Outcome ingester',
  user: 'You',
  system: 'System',
};

export function agentLabel(agent: string | null): string {
  return (agent && AGENTS[agent]) || agent || '—';
}

const EVENTS: Record<string, string> = {
  drafted: 'drafted a proposal',
  judged: 'judged it',
  notified: 'emailed you about it',
  decided: 'decided',
  edited: 'edited it',
  queued_training_jobs: 'queued its runs',
  cursor_pr_opened: 'opened a pull request',
  cursor_implementation_failed: 'implementation failed',
  implementation_failed: 'implementation failed',
  ingested: 'scored the outcome',
  recovered_from_stale_failure: 'reopened it (runs were retried)',
};

const DECIDED: Record<string, string> = {
  approve: 'approved it', reject: 'rejected it', defer: 'deferred it', approve_with_revisions: 'approved it with revisions',
};

/** "Judge judged it (weak_accept)", with the detail that matters for each event. */
export function eventText(event: string | null, detail: Record<string, unknown> | null): string {
  const base = (event && EVENTS[event]) || event || '—';
  const d = detail ?? {};
  const s = (k: string) => (d[k] == null ? null : String(d[k]));
  if (event === 'judged') return s('verdict') ? `${base}: ${s('verdict')!.replace(/_/g, ' ')}` : s('reason') ? `${base} (${s('reason')!.replace(/_/g, ' ')})` : base;
  if (event === 'decided') return DECIDED[s('action') ?? ''] ?? base;
  if (event === 'edited' && d.field_diff && typeof d.field_diff === 'object') return `${base}: ${Object.keys(d.field_diff).map((k) => k.replace('success_criteria.', '')).join(', ')}`;
  if (event === 'queued_training_jobs' && s('n_jobs')) return `queued ${s('n_jobs')} runs (${s('n_arms')} arms × ${s('n_seeds_per_arm')} seeds)`;
  if (event === 'ingested' && s('outcome')) return `${base}: ${s('outcome')}`;
  if ((event === 'implementation_failed' || event === 'cursor_implementation_failed') && s('reason')) return `${base}: ${s('reason')}`;
  return base;
}

/** Proportional bar of a proposal's run statuses. */
export function JobsBar({ jobs, className }: { jobs: Proposal['jobs']; className?: string }) {
  if (!jobs.total) return <span className="text-xs text-muted-foreground">No runs</span>;
  const order: [string, string][] = [
    ['DONE', 'bg-emerald-500'], ['IN_PROGRESS', 'bg-sky-500'], ['PAUSE_REQUESTED', 'bg-amber-500'], ['PAUSED', 'bg-amber-500'],
    ['NOT_STARTED', 'bg-muted-foreground/30'], ['FAILED', 'bg-rose-500'], ['CANCELLED', 'bg-muted-foreground/60'],
  ];
  const b = jobs.by_status;
  const done = b.DONE ?? 0;
  const parts = [`${done}/${jobs.total} done`];
  if (b.IN_PROGRESS) parts.push(`${b.IN_PROGRESS} running`);
  if (b.FAILED) parts.push(`${b.FAILED} failed`);
  return (
    <div className={cn('flex min-w-32 flex-col gap-1', className)}>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {order.map(([k, c]) => (b[k] ? <div key={k} className={c} style={{ width: `${(b[k] / jobs.total) * 100}%` }} title={`${b[k]} ${k}`} /> : null))}
      </div>
      <span className="text-xs text-muted-foreground">{parts.join(' · ')}</span>
    </div>
  );
}
