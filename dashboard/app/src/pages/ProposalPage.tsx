import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, GitCompare } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  agentLabel, criterionText, deltaText, eventText, JobsBar, OutcomeBadge, ProposalStatusBadge, usd, VerdictBadge,
} from '../components/lab/LabBits';
import { DecisionPanel, ProposalEditForm } from '../components/lab/ProposalActions';
import { StatusBadge, runTitle } from '../components/RunBits';
import { Badge, Card, CardHeader, Empty, Progress, Spinner } from '../components/ui';
import { keys, labApi, type ProposalAction, type ProposalDetail } from '../lib/api';
import { cn, formatNumber, shortId, timeAgo } from '../lib/utils';
import { MAX_COMPARE } from './ComparePage';

const POLL_MS = 10_000;
const AWAITING = ['pending_user', 'deferred'];
const LIVE = ['pending_judge', 'approved', 'implementing', 'pr_open', 'training'];
const DECIDED: Record<ProposalAction, string> = {
  approve: 'approved', reject: 'rejected', defer: 'deferred', approve_with_revisions: 'approved with revisions',
};

export function ProposalPage() {
  const { proposalId } = useParams({ strict: false }) as { proposalId: string };
  const search = useSearch({ strict: false }) as { edit?: boolean };
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: keys.labProposal(proposalId),
    queryFn: () => labApi.proposal(proposalId),
    refetchInterval: (s) => (s.state.data && LIVE.includes(s.state.data.proposal.status ?? '') ? POLL_MS : 60_000),
  });
  const setEditing = (on: boolean) => navigate({ to: '/lab/$proposalId', params: { proposalId }, search: on ? { edit: true } : {}, replace: true });

  if (q.isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (q.error || !q.data) {
    return <div className="mx-auto max-w-3xl p-8"><Empty title="Couldn't load this proposal">{(q.error as Error)?.message}</Empty></div>;
  }
  const { proposal: p, doc } = q.data;
  const awaiting = AWAITING.includes(p.status ?? '');
  const cost = doc.cost ?? {};

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 p-4 sm:p-8">
      <Link to="/lab" className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Lab
      </Link>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{p.title ?? '(untitled)'}</h1>
          <ProposalStatusBadge status={p.status} />
          <VerdictBadge verdict={p.verdict} score={p.score} />
          <OutcomeBadge results={p.results} />
        </div>
        <p className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono" title={p.id}>{shortId(p.id)}</span>
          <span>· drafted {timeAgo(p.created_at)}</span>
          {p.updated_at && <span>· updated {timeAgo(p.updated_at)}</span>}
          <span title={Object.entries(cost).filter(([, v]) => v).map(([k, v]) => `${k.replace(/_usd$/, '')}: ${usd(v, 4)}`).join(', ')}>· cost {usd(p.cost_usd)}</span>
          {doc.git_sha_at_proposal && <span>· proposed at <span className="font-mono">{doc.git_sha_at_proposal.slice(0, 8)}</span>{doc.git_branch_at_proposal ? ` on ${doc.git_branch_at_proposal}` : ''}</span>}
          {p.decision?.action && <span>· {DECIDED[p.decision.action]} {timeAgo(p.decision.at)}{p.decision.source && p.decision.source !== 'dashboard' ? ` by ${p.decision.source}` : ''}</span>}
        </p>
        {p.decision?.note && <p className="text-sm text-muted-foreground">Your note: <span className="text-foreground">{p.decision.note}</span></p>}
      </div>

      {awaiting && (
        <Card className="flex flex-col gap-3 border-violet-500/40 p-4">
          <p className="text-sm font-medium">This proposal is waiting for your decision.</p>
          {search.edit
            ? <ProposalEditForm proposal={p} doc={doc} onClose={() => setEditing(false)} />
            : <DecisionPanel proposal={p} onEdit={() => setEditing(true)} />}
        </Card>
      )}

      {p.judge_error && <Card className="border-rose-500/40 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">The judge failed: {p.judge_error}</Card>}

      {(p.results || q.data.runs.length > 0) && <Outcome data={q.data} />}
      {q.data.runs.length > 0 && <Runs data={q.data} />}
      {(p.implementation || q.data.implementation_log.length > 0) && <Implementation data={q.data} />}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-5">
          <Experiment data={q.data} />
          <Papers data={q.data} />
        </div>
        <div className="flex flex-col gap-5">
          <Judge data={q.data} />
          <Timeline data={q.data} />
        </div>
      </div>
    </div>
  );
}

function Section({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} description={description} actions={actions} />
      <div className="p-4 pt-3">{children}</div>
    </Card>
  );
}

function Prose({ label, children }: { label: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-sm">{children}</p>
    </div>
  );
}

function Bullets({ label, items, tone }: { label: string; items?: string[]; tone?: string }) {
  if (!items?.length) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <ul className={cn('mt-1 list-disc space-y-0.5 pl-4 text-sm', tone)}>{items.map((s, i) => <li key={i}>{s}</li>)}</ul>
    </div>
  );
}

function Outcome({ data }: { data: ProposalDetail }) {
  const p = data.proposal;
  const r = p.results;
  const arms = data.per_arm;
  const parsed = p.primary_parsed;
  const best = Math.max(...arms.map((a) => a.mean ?? -Infinity));
  return (
    <Section
      title="Outcome"
      description={r ? `Scored ${timeAgo(r.computed_at)} from ${r.n_jobs_succeeded ?? 0} finished run${r.n_jobs_succeeded === 1 ? '' : 's'}${r.n_jobs_failed ? `, ${r.n_jobs_failed} failed` : ''}.` : 'Scored once every run finishes.'}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <p className="text-xs text-muted-foreground">Success criterion</p>
            <p className="font-mono text-sm">{criterionText(p)}</p>
          </div>
          {r && (
            <div>
              <p className="text-xs text-muted-foreground">{parsed?.arm_a ?? 'Arm'} minus {parsed?.arm_b ?? 'base'}</p>
              <p className={cn('font-mono text-sm', r.primary_criterion_met === true && 'text-emerald-600 dark:text-emerald-400', r.primary_criterion_met === false && 'text-rose-600 dark:text-rose-400')}>
                {deltaText(p)}{r.primary_criterion_met != null && <span className="ml-2 font-sans text-xs">{r.primary_criterion_met ? 'criterion met' : 'criterion not met'}</span>}
              </p>
            </div>
          )}
          {!r && <JobsBar jobs={p.jobs} className="w-64" />}
        </div>
        {r?.notes && <p className="text-xs text-muted-foreground">{r.notes}</p>}
        {arms.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Arm</th>
                <th className="px-3 py-1.5 text-right font-medium">Runs</th>
                <th className="px-3 py-1.5 text-right font-medium">Mean {parsed?.metric ?? ''}</th>
                <th className="px-3 py-1.5 text-right font-medium">Median</th>
                <th className="px-3 py-1.5 text-right font-medium">Std dev</th>
                <th className="py-1.5 pl-3 text-right font-medium">95% CI</th>
              </tr>
            </thead>
            <tbody className="divide-y font-mono text-xs tabular-nums">
              {arms.map((a) => (
                <tr key={a.name}>
                  <td className="py-1.5 pr-3 font-sans font-medium">{a.name}{a.mean === best && arms.length > 1 && <Badge tone="green" className="ml-2 px-1.5 py-0 text-[10px]">best</Badge>}</td>
                  <td className="px-3 py-1.5 text-right">{a.n_trials}</td>
                  <td className="px-3 py-1.5 text-right">{formatNumber(a.mean)}</td>
                  <td className="px-3 py-1.5 text-right">{formatNumber(a.median)}</td>
                  <td className="px-3 py-1.5 text-right">{formatNumber(a.stddev)}</td>
                  <td className="py-1.5 pl-3 text-right">{a.ci_low_95 != null ? `${formatNumber(a.ci_low_95)} – ${formatNumber(a.ci_high_95)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Section>
  );
}

function Runs({ data }: { data: ProposalDetail }) {
  const runIds = data.runs.map((r) => r.run.id);
  const modelIds = data.runs.map((r) => r.model?.id).filter((x): x is string => !!x);
  const compareRuns = runIds.slice(0, MAX_COMPARE).join(',');
  const compareModels = modelIds.slice(0, MAX_COMPARE).join(',');
  return (
    <Section
      title={`Runs (${data.runs.length})`}
      description={runIds.length > MAX_COMPARE ? `Compare opens the first ${MAX_COMPARE}.` : 'One per arm and seed; the model is the one the outcome was scored on.'}
      actions={<>
        <Link to="/compare" search={{ runs: compareRuns }} className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs font-medium hover:bg-muted">
          <GitCompare className="h-3.5 w-3.5" /> Compare curves
        </Link>
        {modelIds.length > 0 && (
          <Link to="/compare" search={{ models: compareModels, tab: 'evals' }} className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs font-medium hover:bg-muted">
            Compare models
          </Link>
        )}
      </>}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Arm</th>
              <th className="px-3 py-1.5 font-medium">Seed</th>
              <th className="px-3 py-1.5 font-medium">Run</th>
              <th className="px-3 py-1.5 font-medium">Status</th>
              <th className="w-40 px-3 py-1.5 font-medium">Progress</th>
              <th className="px-3 py-1.5 text-right font-medium">Mean reward</th>
              <th className="py-1.5 pl-3 text-right font-medium">Model avg return</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.runs.map(({ arm, seed, run, model }) => (
              <tr key={run.id}>
                <td className="py-2 pr-3 font-medium">{arm ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs">{seed ?? '—'}</td>
                <td className="max-w-xs truncate px-3 py-2">
                  <Link to="/runs/$runId" params={{ runId: run.id }} className="hover:underline">{runTitle(run)}</Link>
                  <span className="ml-1.5 font-mono text-xs text-muted-foreground">{shortId(run.id)}</span>
                </td>
                <td className="px-3 py-2"><StatusBadge status={run.status} /></td>
                <td className="px-3 py-2"><Progress value={run.percent_complete} /></td>
                <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{formatNumber(run.mean_reward)}</td>
                <td className="py-2 pl-3 text-right font-mono text-xs tabular-nums">
                  {model ? <Link to="/models/$modelId" params={{ modelId: model.id }} className="hover:underline">{formatNumber(model.avg_return)}</Link> : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Implementation({ data }: { data: ProposalDetail }) {
  const impl = data.proposal.implementation;
  const log = data.implementation_log;
  return (
    <Section title="Implementation" description="The code change a Cursor agent wrote for this proposal, when it needed one.">
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          {impl?.branch && <span>Branch <span className="font-mono text-xs">{impl.branch}</span></span>}
          {impl?.pr_url && (
            <a href={impl.pr_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-700 hover:underline dark:text-sky-300">
              Pull request <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        {impl?.failure && <p className="text-rose-700 dark:text-rose-300">{impl.failure}</p>}
        {log.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Agent log{data.doc.implementation_log_lines > log.length ? ` (last ${log.length} of ${data.doc.implementation_log_lines} lines)` : ''}</p>
            <pre className="max-h-80 overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200">{log.join('\n')}</pre>
          </div>
        )}
      </div>
    </Section>
  );
}

function Experiment({ data }: { data: ProposalDetail }) {
  const { proposal: p, doc } = data;
  const arms = doc.experiment_arms ?? [];
  const designFor = (arm: string) => data.designs.find((d) => d.name?.endsWith(`:${arm}`));
  const sc = doc.success_criteria;
  return (
    <Section title="Experiment">
      <div className="flex flex-col gap-4">
        <Prose label="Hypothesis">{p.hypothesis}</Prose>
        <Prose label="Motivation">{doc.motivation}</Prose>
        <Prose label="Code changes">{doc.code_changes_summary}</Prose>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Arms · {p.n_seeds_per_arm ?? '?'} seeds × {formatNumber(p.num_iterations_per_seed)} iterations{p.expected_wall_time_hours != null ? ` · ~${formatNumber(p.expected_wall_time_hours, 1)}h` : ''}</p>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {arms.map((a) => {
              const fields = Object.entries(a.experiment_design_fields ?? {});
              const reward = Object.entries(a.reward_design_fields ?? {});
              const design = designFor(a.name);
              return (
                <div key={a.name} className="rounded-md border px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{a.name}</span>
                    {a.description && <span className="text-muted-foreground">{a.description}</span>}
                    {design && (
                      <Link to="/design/$tab/$itemId" params={{ tab: 'experiments', itemId: design.id }} className="ml-auto text-muted-foreground hover:text-foreground hover:underline">
                        {design.name}
                      </Link>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1 font-mono">
                    {fields.length ? fields.map(([k, v]) => <span key={k} className="rounded bg-muted px-1.5 py-0.5">{k}={JSON.stringify(v)}</span>)
                      : <span className="text-muted-foreground">{a.experiment_design_id ? `${a.experiment_design_id}, no overrides` : 'base, no overrides'}</span>}
                    {reward.map(([k, v]) => <span key={k} className="rounded bg-violet-500/10 px-1.5 py-0.5">reward.{k}={JSON.stringify(v)}</span>)}
                    {a.reward_design_id && <span className="rounded bg-violet-500/10 px-1.5 py-0.5">reward design {a.reward_design_id}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Success criterion</p>
          <p className="mt-0.5 text-sm">{sc?.primary ?? '—'}</p>
          {sc?.primary_parsed?.metric && <p className="mt-0.5 font-mono text-xs text-muted-foreground">{criterionText(p)}</p>}
        </div>
        <Bullets label="Also watching" items={sc?.secondary} />
        {doc.proposed_schema_extensions?.length ? (
          <div>
            <p className="text-xs font-medium text-muted-foreground">New experiment fields it needs</p>
            <ul className="mt-1 flex flex-col gap-1.5 text-xs">
              {doc.proposed_schema_extensions.map((x) => (
                <li key={x.name}>
                  <span className="font-mono">{x.name}: {x.type} = {JSON.stringify(x.default)}</span>
                  {(x.min_value != null || x.max_value != null) && <span className="text-muted-foreground"> [{x.min_value ?? '…'}, {x.max_value ?? '…'}]</span>}
                  {x.paper_ref && <span className="text-muted-foreground"> · arXiv:{x.paper_ref}</span>}
                  {x.doc && <p className="text-muted-foreground">{x.doc}</p>}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function Papers({ data }: { data: ProposalDetail }) {
  const papers = data.doc.source_papers ?? [];
  if (!papers.length) return null;
  return (
    <Section title={`Sources (${papers.length})`}>
      <ul className="flex flex-col gap-3">
        {papers.map((s) => (
          <li key={s.arxiv_id} className="text-sm">
            <a href={s.url || `https://arxiv.org/abs/${s.arxiv_id}`} target="_blank" rel="noreferrer" className="font-medium hover:underline">{s.title || s.arxiv_id}</a>
            <span className="ml-2 font-mono text-xs text-muted-foreground">arXiv:{s.arxiv_id}</span>
            {s.section_refs?.length ? <div className="mt-1 flex flex-wrap gap-1">{s.section_refs.map((r) => <Badge key={r}>{r}</Badge>)}</div> : null}
            {s.supporting_evidence
              ? <p className="mt-1 border-l-2 pl-2 text-xs italic text-muted-foreground">{s.supporting_evidence}</p>
              : <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">No supporting excerpt quoted.</p>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Judge({ data }: { data: ProposalDetail }) {
  const jr = data.doc.judge_review;
  if (!jr) return <Section title="Judge review"><p className="text-sm text-muted-foreground">Not judged yet.</p></Section>;
  const scores = Object.entries(jr.scores ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return (
    <Section
      title="Judge review"
      description={[jr.judge_model, jr.rubric_version != null ? `rubric v${jr.rubric_version}` : null, jr.judge_cost_usd != null ? usd(jr.judge_cost_usd, 4) : null, jr.judged_at ? timeAgo(jr.judged_at) : null].filter(Boolean).join(' · ')}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={jr.overall ?? null} score={jr.normalized_score} />
          {jr.robustness_bump_applied && <Badge tone="blue">robustness bump applied</Badge>}
        </div>
        {scores.length > 0 && (
          <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
            {scores.map(([axis, s]) => (
              <div key={axis} className="contents">
                <span className="text-muted-foreground">{axis.replace(/_/g, ' ')}</span>
                <span className="flex items-center gap-1.5">
                  <span className="flex gap-0.5">
                    {[1, 2, 3, 4, 5].map((i) => <span key={i} className={cn('h-2 w-3 rounded-sm', i <= s ? (s <= 1 ? 'bg-rose-500' : s >= 4 ? 'bg-emerald-500' : 'bg-amber-500') : 'bg-muted')} />)}
                  </span>
                  <span className="w-6 text-right tabular-nums">{s}/5</span>
                </span>
              </div>
            ))}
          </div>
        )}
        {jr.axes_skipped?.length ? <p className="text-xs text-muted-foreground">Skipped: {jr.axes_skipped.join(', ')}</p> : null}
        <Bullets label="Strengths" items={jr.strengths} />
        <Bullets label="Concerns" items={jr.concerns} />
        <Bullets label="Suggested revisions" items={jr.suggested_revisions} />
        <Bullets label="Failed pre-checks" items={jr.pre_rubric_check_failures} tone="text-rose-700 dark:text-rose-300" />
      </div>
    </Section>
  );
}

function Timeline({ data }: { data: ProposalDetail }) {
  const events = (data.doc.audit_events ?? []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Section title={`Timeline (${events.length})`}>
      <ol className="relative flex flex-col gap-2.5 border-l pl-4">
        {events.map((e, i) => (
          <li key={i} className="text-xs">
            <span className="absolute -left-[4.5px] mt-1 h-2 w-2 rounded-full bg-muted-foreground/50" />
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{agentLabel(e.by_agent)}</span>
              <span className="min-w-0 flex-1 text-muted-foreground">{eventText(e.event, e.detail ?? null)}</span>
              <span className="shrink-0 text-muted-foreground" title={new Date(e.at).toLocaleString()}>{timeAgo(e.at)}</span>
            </div>
            {e.detail && Object.keys(e.detail).length > 0 && (
              <button className="text-muted-foreground hover:text-foreground" onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'Hide details' : 'Details'}</button>
            )}
            {open === i && <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-muted/50 p-2 font-mono">{JSON.stringify(e.detail, null, 2)}</pre>}
          </li>
        ))}
      </ol>
    </Section>
  );
}
