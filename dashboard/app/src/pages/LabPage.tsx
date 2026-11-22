import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, ExternalLink, FlaskConical } from 'lucide-react';
import { useState } from 'react';
import {
  agentLabel, criterionText, deltaText, eventText, JobsBar, OutcomeBadge, PROPOSAL_STATUS, ProposalStatusBadge, usd, VerdictBadge,
} from '../components/lab/LabBits';
import { DecisionPanel } from '../components/lab/ProposalActions';
import { Badge, Card, Empty, Input, Select, Spinner } from '../components/ui';
import { keys, labApi, type LabSummary, type Proposal, type ProposalGroup, type ProposalStatus } from '../lib/api';
import { cn, formatNumber, timeAgo } from '../lib/utils';

export const LAB_TABS = ['pending', 'in_flight', 'outcomes', 'all', 'activity'] as const;
export type LabTab = (typeof LAB_TABS)[number];
export interface LabSearch { tab?: LabTab; status?: string; q?: string; page?: number; agent?: string }

const POLL_MS = 10_000;
const PAGE = 25;
const ACTIVITY_PAGE = 30;

const TAB_LABEL: Record<LabTab, string> = {
  pending: 'Awaiting you', in_flight: 'In flight', outcomes: 'Outcomes', all: 'All proposals', activity: 'Activity',
};

export function LabPage() {
  const search = useSearch({ strict: false }) as LabSearch;
  const summary = useQuery({ queryKey: keys.labSummary, queryFn: labApi.summary, refetchInterval: POLL_MS });
  const groups = summary.data?.groups;
  const tab: LabTab = search.tab ?? (groups && !groups.pending ? (groups.in_flight ? 'in_flight' : 'outcomes') : 'pending');

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Lab</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The MadScientist reads papers, drafts experiments, has a judge review them and, once you approve, queues the runs and scores the outcome.
        </p>
      </div>

      <Overview summary={summary.data} loading={summary.isLoading} error={summary.error} />

      <nav className="-mb-2 flex gap-1 overflow-x-auto overflow-y-hidden border-b [scrollbar-width:none]">
        {LAB_TABS.map((t) => {
          const n = t === 'all' || t === 'activity' ? null : groups?.[t as ProposalGroup];
          return (
            <Link key={t} to="/lab" search={{ tab: t }}
              className={cn('-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm transition-colors',
                t === tab ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {TAB_LABEL[t]}
              {n ? <Badge tone={t === 'pending' ? 'violet' : 'neutral'} className="px-1.5 py-0 text-[10px]">{n}</Badge> : null}
            </Link>
          );
        })}
      </nav>

      {tab === 'pending' ? <PendingList />
        : tab === 'activity' ? <ActivityFeed search={search} />
          : <ProposalTable tab={tab} search={search} />}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <Card className="flex min-w-0 flex-col gap-0.5 px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-xl font-semibold tabular-nums', tone)}>{value}</span>
      {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
    </Card>
  );
}

function Overview({ summary, loading, error }: { summary?: LabSummary; loading: boolean; error: unknown }) {
  if (loading) return <div className="grid place-items-center py-6"><Spinner /></div>;
  if (error || !summary) return <Empty title="Couldn't load the Lab">{(error as Error)?.message}</Empty>;
  const g = summary.groups;
  const m = summary.month;
  const over = m.budget_usd != null && m.spend_usd > m.budget_usd;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.6fr)]">
      <Stat label="Awaiting you" value={String(g.pending)} hint={summary.counts.deferred ? `${summary.counts.deferred} deferred` : undefined}
        tone={g.pending ? 'text-violet-600 dark:text-violet-400' : undefined} />
      <Stat label="In flight" value={String(g.in_flight)} hint={g.judging ? `${g.judging} being judged` : undefined} />
      <Stat label="Finished" value={String(g.outcomes)} hint={summary.counts.failed ? `${summary.counts.failed} failed` : undefined} />
      <Stat label="Spend this month" value={usd(m.spend_usd)} tone={over ? 'text-rose-600 dark:text-rose-400' : undefined}
        hint={`${m.budget_usd != null ? `of ${usd(m.budget_usd, 0)} · ` : ''}${m.proposals} proposal${m.proposals === 1 ? '' : 's'}`} />
      <Card className="col-span-2 flex min-w-0 flex-col gap-1.5 px-4 py-3 md:col-span-4 xl:col-span-1">
        <span className="text-xs text-muted-foreground">Latest from each agent</span>
        {summary.agents.length ? (
          <ul className="flex flex-col gap-1 text-xs">
            {summary.agents.filter((a) => a.agent !== 'user').slice(0, 4).map((a) => (
              <li key={a.agent} className="flex min-w-0 items-baseline gap-2">
                <span className="w-28 shrink-0 font-medium">{agentLabel(a.agent)}</span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {eventText(a.last_event, null)}
                  {' · '}
                  <Link to="/lab/$proposalId" params={{ proposalId: a.proposal_id }} className="hover:text-foreground hover:underline">{a.proposal_title ?? 'untitled'}</Link>
                </span>
                <span className="ml-auto shrink-0 text-muted-foreground">{timeAgo(a.last_at)}</span>
              </li>
            ))}
          </ul>
        ) : <span className="text-xs text-muted-foreground">No agent has written anything yet.</span>}
      </Card>
    </div>
  );
}

function PendingList() {
  const q = { group: 'pending' as const, limit: 50 };
  const list = useQuery({ queryKey: keys.labProposals(q), queryFn: () => labApi.proposals(q), refetchInterval: POLL_MS });
  if (list.isLoading) return <div className="grid place-items-center py-10"><Spinner /></div>;
  if (list.error) return <Empty title="Couldn't load proposals">{(list.error as Error).message}</Empty>;
  if (!list.data?.items.length) {
    return <Empty title="Nothing awaiting you">When the judge passes a proposal it lands here for your decision, and you get an email if that's set up.</Empty>;
  }
  return (
    <div className="flex flex-col gap-4">
      {list.data.items.map((p) => <PendingCard key={p.id} p={p} />)}
    </div>
  );
}

function PendingCard({ p }: { p: Proposal }) {
  const navigate = useNavigate();
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/lab/$proposalId" params={{ proposalId: p.id }} className="font-semibold hover:underline">{p.title ?? '(untitled)'}</Link>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>drafted {timeAgo(p.created_at)}</span>
            <span>· {p.arms.length} arm{p.arms.length === 1 ? '' : 's'} ({p.arms.join(', ')})</span>
            <span>· {p.n_seeds_per_arm ?? '?'} seeds × {formatNumber(p.num_iterations_per_seed)} iterations</span>
            {p.expected_wall_time_hours != null && <span>· ~{formatNumber(p.expected_wall_time_hours, 1)}h</span>}
            <span>· {p.papers} paper{p.papers === 1 ? '' : 's'}</span>
            <span>· {usd(p.cost_usd)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {p.status === 'deferred' && <ProposalStatusBadge status={p.status} />}
          <VerdictBadge verdict={p.verdict} score={p.score} />
        </div>
      </div>
      <p className="text-sm">{p.hypothesis}</p>
      <p className="text-xs"><span className="text-muted-foreground">Succeeds if </span><span className="font-mono">{criterionText(p)}</span></p>
      {p.concerns.length > 0 && (
        <div className="text-xs">
          <span className="font-medium text-muted-foreground">Judge's concerns</span>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            {p.concerns.slice(0, 3).map((c, i) => <li key={i}>{c}</li>)}
            {p.concerns.length > 3 && <li className="list-none">
              <Link to="/lab/$proposalId" params={{ proposalId: p.id }} className="hover:text-foreground hover:underline">and {p.concerns.length - 3} more</Link>
            </li>}
          </ul>
        </div>
      )}
      <DecisionPanel proposal={p} compact onEdit={() => navigate({ to: '/lab/$proposalId', params: { proposalId: p.id }, search: { edit: true } })} />
    </Card>
  );
}

function ProposalTable({ tab, search }: { tab: Exclude<LabTab, 'pending' | 'activity'>; search: LabSearch }) {
  const navigate = useNavigate();
  const page = search.page ?? 1;
  const [q, setQ] = useState(search.q ?? '');
  const query = tab === 'all'
    ? { status: search.status, q: search.q, limit: PAGE, offset: (page - 1) * PAGE }
    : { group: tab as ProposalGroup, limit: PAGE, offset: (page - 1) * PAGE };
  const list = useQuery({
    queryKey: keys.labProposals(query), queryFn: () => labApi.proposals(query),
    refetchInterval: tab === 'in_flight' ? POLL_MS : 30_000, placeholderData: (prev) => prev,
  });
  const setSearch = (patch: Partial<LabSearch>) => navigate({ to: '/lab', search: { ...search, tab, ...patch }, replace: true });
  const items = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-3">
      {tab === 'all' && (
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={(e) => { e.preventDefault(); setSearch({ q: q.trim() || undefined, page: undefined }); }}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, hypothesis or arXiv id" className="h-8 w-72 text-xs" />
          </form>
          <Select value={search.status ?? ''} onChange={(e) => setSearch({ status: e.target.value || undefined, page: undefined })} className="h-8 text-xs">
            <option value="">Any status</option>
            {(Object.keys(PROPOSAL_STATUS) as ProposalStatus[]).map((s) => <option key={s} value={s}>{PROPOSAL_STATUS[s].label}</option>)}
          </Select>
        </div>
      )}
      {list.isLoading ? <div className="grid place-items-center py-10"><Spinner /></div>
        : list.error ? <Empty title="Couldn't load proposals">{(list.error as Error).message}</Empty>
          : !items.length ? (
            <Empty title={tab === 'in_flight' ? 'Nothing in flight' : tab === 'outcomes' ? 'No outcomes yet' : 'No proposals match'}>
              {tab === 'in_flight' ? 'Approved proposals show here while their code change is written and their runs train.'
                : tab === 'outcomes' ? 'Once every run of an approved proposal finishes, the outcome ingester scores it against its success criterion.' : null}
            </Empty>
          ) : (
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Proposal</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    {tab === 'outcomes' ? <>
                      <th className="px-3 py-2 font-medium">Outcome</th>
                      <th className="px-3 py-2 font-medium">Criterion</th>
                      <th className="px-3 py-2 text-right font-medium">Delta</th>
                    </> : <>
                      <th className="px-3 py-2 font-medium">Runs</th>
                      <th className="px-3 py-2 font-medium">{tab === 'in_flight' ? 'Implementation' : 'Judge'}</th>
                    </>}
                    <th className="px-3 py-2 text-right font-medium">Cost</th>
                    <th className="px-4 py-2 text-right font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((p) => (
                    <tr key={p.id} className="cursor-pointer hover:bg-muted/40" onClick={() => navigate({ to: '/lab/$proposalId', params: { proposalId: p.id } })}>
                      <td className="max-w-md px-4 py-2.5">
                        <Link to="/lab/$proposalId" params={{ proposalId: p.id }} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                          {p.title ?? '(untitled)'}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">{p.arms.join(' vs ')}</p>
                      </td>
                      <td className="px-3 py-2.5"><ProposalStatusBadge status={p.status} /></td>
                      {tab === 'outcomes' ? <>
                        <td className="px-3 py-2.5">
                          <OutcomeBadge results={p.results} />
                          {p.results?.n_jobs_failed ? <span className="ml-1.5 text-xs text-muted-foreground">{p.results.n_jobs_failed} run{p.results.n_jobs_failed === 1 ? '' : 's'} failed</span> : null}
                          {!p.results && p.status === 'failed' && <span className="text-xs text-muted-foreground" title={p.implementation?.failure ?? undefined}>{p.implementation?.failure ? 'Implementation failed' : 'Failed'}</span>}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs">{criterionText(p)}</td>
                        <td className={cn('px-3 py-2.5 text-right font-mono text-xs tabular-nums',
                          p.results?.primary_criterion_met === true && 'text-emerald-600 dark:text-emerald-400',
                          p.results?.primary_criterion_met === false && 'text-rose-600 dark:text-rose-400')}>
                          {deltaText(p)}
                        </td>
                      </> : <>
                        <td className="px-3 py-2.5"><JobsBar jobs={p.jobs} /></td>
                        <td className="px-3 py-2.5 text-xs">
                          {tab === 'in_flight' ? (
                            p.implementation?.pr_url ? (
                              <a href={p.implementation.pr_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1 text-sky-700 hover:underline dark:text-sky-300">
                                Pull request <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : p.implementation?.branch ? <span className="font-mono">{p.implementation.branch}</span>
                              : <span className="text-muted-foreground">{p.status === 'training' ? 'No code change' : '—'}</span>
                          ) : <VerdictBadge verdict={p.verdict} score={p.score} />}
                        </td>
                      </>}
                      <td className="px-3 py-2.5 text-right text-xs tabular-nums text-muted-foreground">{usd(p.cost_usd)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs text-muted-foreground">{timeAgo(p.updated_at ?? p.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
      {list.data && list.data.total > PAGE && (
        <Pager offset={list.data.offset} limit={PAGE} total={list.data.total} onPage={(o) => setSearch({ page: o / PAGE + 1 })} />
      )}
    </div>
  );
}

function Pager({ offset, limit, total, onPage }: { offset: number; limit: number; total: number; onPage: (offset: number) => void }) {
  return (
    <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
      <span>{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
      <button className="rounded-md border p-1 hover:bg-muted disabled:opacity-40" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))} aria-label="Newer">
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <button className="rounded-md border p-1 hover:bg-muted disabled:opacity-40" disabled={offset + limit >= total} onClick={() => onPage(offset + limit)} aria-label="Older">
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const AGENT_FILTERS = ['madscientist.researcher', 'madscientist.judge', 'madscientist.orchestrator', 'madscientist.outcome_ingester', 'madscientist.email_bridge', 'user'];

function ActivityFeed({ search }: { search: LabSearch }) {
  const navigate = useNavigate();
  const page = search.page ?? 1;
  const query = { agent: search.agent, limit: ACTIVITY_PAGE, offset: (page - 1) * ACTIVITY_PAGE };
  const feed = useQuery({ queryKey: keys.labActivity(query), queryFn: () => labApi.activity(query), refetchInterval: POLL_MS, placeholderData: (prev) => prev });
  const setSearch = (patch: Partial<LabSearch>) => navigate({ to: '/lab', search: { ...search, tab: 'activity', ...patch }, replace: true });
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Select value={search.agent ?? ''} onChange={(e) => setSearch({ agent: e.target.value || undefined, page: undefined })} className="h-8 text-xs">
          <option value="">Every agent</option>
          {AGENT_FILTERS.map((a) => <option key={a} value={a}>{agentLabel(a)}</option>)}
        </Select>
      </div>
      {feed.isLoading ? <div className="grid place-items-center py-10"><Spinner /></div>
        : feed.error ? <Empty title="Couldn't load activity">{(feed.error as Error).message}</Empty>
          : !feed.data?.items.length ? <Empty title="No activity yet">The researcher, judge, orchestrator and outcome ingester log each step here as they run.</Empty>
            : (
              <Card className="divide-y">
                {feed.data.items.map((e, i) => {
                  const key = `${e.proposal_id}|${e.at}|${e.event}|${i}`;
                  const hasDetail = e.detail && Object.keys(e.detail).length > 0;
                  return (
                    <div key={key} className="px-4 py-2.5 text-sm">
                      <div className="flex min-w-0 items-baseline gap-3">
                        <span className="w-20 shrink-0 text-xs text-muted-foreground" title={e.at ? new Date(e.at).toLocaleString() : undefined}>{timeAgo(e.at)}</span>
                        <FlaskConical className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium">{agentLabel(e.agent)}</span>{' '}
                          <span className="text-muted-foreground">{eventText(e.event, e.detail)}</span>
                          {' · '}
                          <Link to="/lab/$proposalId" params={{ proposalId: e.proposal_id }} className="hover:underline">{e.proposal_title ?? 'untitled'}</Link>
                        </span>
                        <ProposalStatusBadge status={e.proposal_status} />
                        {hasDetail && (
                          <button className="shrink-0 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(open === key ? null : key)}>
                            {open === key ? 'Hide' : 'Details'}
                          </button>
                        )}
                      </div>
                      {open === key && (
                        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs">{JSON.stringify(e.detail, null, 2)}</pre>
                      )}
                    </div>
                  );
                })}
              </Card>
            )}
      {feed.data && feed.data.total > ACTIVITY_PAGE && (
        <Pager offset={feed.data.offset} limit={ACTIVITY_PAGE} total={feed.data.total} onPage={(o) => setSearch({ page: o / ACTIVITY_PAGE + 1 })} />
      )}
    </div>
  );
}
