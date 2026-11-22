import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { DESIGN_TABS, DesignList, usedText, type DesignTab, type ListItem } from '../components/design/DesignBits';
import { DemoEditor } from '../components/design/DemoEditor';
import { ExperimentDesignEditor } from '../components/design/ExperimentDesignEditor';
import { CAR, GymEditor } from '../components/design/GymEditor';
import { RewardDesignEditor } from '../components/design/RewardDesignEditor';
import { compileTag, RewardSpecEditor, STATUS, useRewardSpecs } from '../components/design/RewardSpecEditor';
import { toast } from '../components/feedback';
import { Badge, Select } from '../components/ui';
import { api, keys, type DesignKind, type DesignRows } from '../lib/api';
import { useRobots, useSelectedRobot } from '../lib/robots';
import { cn } from '../lib/utils';

export interface DesignSearch { from?: string; robot?: string }
export const DESIGN_TAB_SLUGS = DESIGN_TABS.map((t) => t.slug) as DesignTab[];

const LIST_REFRESH_MS = 30_000;

/** Most recently used first, with the robots' defaults on top and archived ones last. */
function byUse<T extends { archived: boolean; canonical?: boolean; used?: { last_used: string | null }; updated_at: string | null; created_at: string | null }>(a: T, b: T) {
  if (a.archived !== b.archived) return a.archived ? 1 : -1;
  if (!!a.canonical !== !!b.canonical) return a.canonical ? -1 : 1;
  const t = (x: T) => x.used?.last_used ?? x.updated_at ?? x.created_at ?? '';
  return t(b).localeCompare(t(a));
}

function useDesignList<K extends DesignKind>(kind: K, robot: string, archived: boolean, enabled: boolean) {
  return useQuery({
    queryKey: keys.designs(kind, robot, archived),
    queryFn: () => api.designs(kind, robot, archived),
    enabled,
    refetchInterval: LIST_REFRESH_MS,
  });
}

export function DesignPage() {
  const params = useParams({ strict: false }) as { tab?: string; itemId?: string };
  const search = useSearch({ strict: false }) as DesignSearch;
  const tab: DesignTab = DESIGN_TAB_SLUGS.includes(params.tab as DesignTab) ? (params.tab as DesignTab) : 'rewards';
  const itemId = params.itemId;
  const isNew = itemId === 'new';
  const [selectedRobot] = useSelectedRobot();
  const { data: robots } = useRobots();
  const [archived, setArchived] = useState(false);
  const robot = selectedRobot;
  const newRobot = search.robot || robot || robots?.[0]?.id || CAR;

  const rewards = useDesignList('reward_designs', robot, archived, tab === 'rewards');
  const experiments = useDesignList('experiment_designs', robot, archived, tab === 'experiments');
  const gyms = useDesignList('gyms', robot, archived, tab === 'gyms');
  const demos = useDesignList('demos', robot, archived, tab === 'demos');
  const specs = useRewardSpecs();

  const list = useMemo((): { items: ListItem[]; loading: boolean; error: unknown } => {
    const used = (u: DesignRows[DesignKind]['used']) => <span>{usedText(u)}</span>;
    if (tab === 'rewards') {
      return {
        loading: rewards.isLoading, error: rewards.error,
        items: (rewards.data ?? []).slice().sort(byUse).map((d) => ({
          id: d.id, title: d.name ?? d.id, robot: d.robot, archived: d.archived, description: d.description,
          meta: <><span>v{d.version}</span>{used(d.used)}</>,
          badges: <>{d.canonical && <Badge tone="blue">default</Badge>}{d.spec_id && <Badge tone="violet">spec</Badge>}</>,
        })),
      };
    }
    if (tab === 'experiments') {
      return {
        loading: experiments.isLoading, error: experiments.error,
        items: (experiments.data ?? []).slice().sort(byUse).map((d) => ({
          id: d.id, title: d.name ?? d.id, robot: d.robot, archived: d.archived, description: d.description,
          meta: <><span>v{d.version}</span><span>{d.overrides ? `${d.overrides} override${d.overrides === 1 ? '' : 's'}` : 'defaults'}</span>{used(d.used)}</>,
          badges: <>{d.canonical && <Badge tone="blue">default</Badge>}{d.proposal_id && <Badge tone="violet">lab</Badge>}</>,
        })),
      };
    }
    if (tab === 'gyms') {
      return {
        loading: gyms.isLoading, error: gyms.error,
        items: (gyms.data ?? []).slice().sort(byUse).map((g) => ({
          id: g.id, title: g.name ?? g.task_id ?? g.id, robot: g.robot, archived: g.archived, description: g.description,
          meta: <><span className="max-w-48 truncate font-mono">{g.task_id ?? g.file_path?.split(/[\\/]/).pop() ?? ''}</span>{used(g.used)}</>,
        })),
      };
    }
    if (tab === 'demos') {
      return {
        loading: demos.isLoading, error: demos.error,
        items: (demos.data ?? []).slice().sort((a, b) => (a.archived !== b.archived ? (a.archived ? 1 : -1) : (b.collected_at ?? '').localeCompare(a.collected_at ?? ''))).map((d) => ({
          id: d.id, title: d.label, archived: d.archived, description: d.description,
          meta: <><span>{d.num_demos ?? '?'} demos</span>{d.course && <span>{d.course}</span>}{used(d.used)}</>,
        })),
      };
    }
    const all = (specs.data?.specs ?? [])
      .filter((s) => archived || !s.archived)
      .filter((s) => !robot || !s.summary || s.summary.robots.includes(robot));
    return {
      loading: specs.isLoading, error: specs.error,
      items: all.map((s) => ({
        id: s._id, title: s.summary?.name || s.name || s._id, archived: s.archived,
        description: s.summary?.goal ?? s.summary?.description,
        meta: s.summary ? <>{s.summary.robots.map((r) => {
          const st = STATUS[s.summary!.statuses[r] ?? 'missing'];
          const tag = compileTag(s.compile?.[r]);
          return <span key={r} className="inline-flex items-center gap-1">{r}: <Badge tone={tag?.tone ?? st.tone} className="px-1.5 py-0 text-[10px]">{tag?.label ?? st.label}</Badge></span>;
        })}</> : <span className="text-rose-600 dark:text-rose-400">{s.parse_error ?? 'unreadable'}</span>,
      })),
    };
  }, [tab, rewards, experiments, gyms, demos, specs, archived, robot]);

  const current = DESIGN_TABS.find((t) => t.slug === tab)!;
  const id = isNew || !itemId ? null : itemId;
  const carOnly = tab === 'demos' || tab === 'gyms';
  const canCreate = !carOnly || !robot || robot === CAR;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 border-b px-4 pt-4 sm:px-6">
        <div className="pb-3">
          <h1 className="text-2xl font-semibold tracking-tight">Design</h1>
        </div>
        <nav className="flex gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
          {DESIGN_TABS.map((t) => (
            <Link key={t.slug} to="/design/$tab" params={{ tab: t.slug }} search={{}}
              className={cn('-mb-px whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm transition-colors',
                t.slug === tab ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className={cn('shrink-0 border-r bg-card/40 md:block md:w-80', itemId ? 'hidden' : 'w-full')}>
          <DesignList
            tab={tab}
            items={list.items}
            selected={itemId}
            loading={list.loading}
            error={list.error}
            archived={archived}
            onArchived={setArchived}
            showRobot={!robot && tab !== 'specs' && tab !== 'demos'}
            newLabel={tab === 'demos' ? 'Register' : 'New'}
            canCreate={canCreate}
            newHint={tab === 'gyms' ? 'Registered by the robot\u2019s worker' : tab === 'demos' ? 'Car only' : undefined}
            newRobot={tab === 'specs' || carOnly ? undefined : newRobot}
            extra={tab === 'specs' ? <StrictToggle strict={!!specs.data?.settings.strict_generated} /> : undefined}
          />
        </aside>
        <section className={cn('min-w-0 flex-1 overflow-y-auto', !itemId && 'hidden md:block')}>
          <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6">
            {itemId && isNew && (tab === 'rewards' || tab === 'experiments') && !search.from && (
              <NewRobotPicker robot={newRobot} tab={tab} />
            )}
            {!itemId ? (
              <Placeholder tab={tab} count={list.items.length} label={current.label} />
            ) : tab === 'rewards' ? (
              <RewardDesignEditor id={id} robot={newRobot} from={search.from} />
            ) : tab === 'experiments' ? (
              <ExperimentDesignEditor id={id} robot={newRobot} from={search.from} />
            ) : tab === 'gyms' ? (
              <GymEditor id={id} robot={robot || CAR} />
            ) : tab === 'demos' ? (
              <DemoEditor id={id} />
            ) : (
              <RewardSpecEditor id={id} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const ABOUT: Record<DesignTab, string> = {
  rewards: 'Python that shapes what a run is rewarded for. Each save is a new version; runs and models keep the code they trained with.',
  specs: 'Plain-language reward goals the MadScientist compiles into each robot\u2019s reward design, which you review before it\u2019s used.',
  experiments: 'Trainer settings that differ from the defaults: learning rates, buffer sizes, domain randomisation and the like.',
  gyms: 'The environments runs train in: Unity builds for the car, registered tasks for the other robots, with the designs each starts from.',
  demos: 'Recorded expert driving the car can pretrain on or replay from.',
};

function Placeholder({ tab, count, label }: { tab: DesignTab; count: number; label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
      <p className="text-sm font-medium">{label}</p>
      <p className="max-w-md text-sm text-muted-foreground">{ABOUT[tab]}</p>
      <p className="text-xs text-muted-foreground">{count ? `Pick one of the ${count} on the left.` : 'Nothing here yet.'}</p>
    </div>
  );
}

function NewRobotPicker({ robot, tab }: { robot: string; tab: DesignTab }) {
  const navigate = useNavigate();
  const { data: robots } = useRobots();
  return (
    <label className="flex items-center gap-2 self-start text-sm text-muted-foreground">
      For
      <Select value={robot} onChange={(e) => navigate({ to: '/design/$tab/$itemId', params: { tab, itemId: 'new' }, search: { robot: e.target.value }, replace: true })} className="h-8">
        {(robots ?? []).map((r) => <option key={r.id} value={r.id}>{r.display_name}</option>)}
      </Select>
    </label>
  );
}

function StrictToggle({ strict }: { strict: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      await api.setRewardSpecStrict(next);
      await qc.invalidateQueries({ queryKey: keys.rewardSpecs });
      toast('success', next ? 'Strict mode on: compiled code can only come from the compiler.' : 'Strict mode off: compiled code can be edited by hand.');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title="Runs refuse hand-edited spec code, and code can only change by recompiling">
      <input type="checkbox" className="h-3.5 w-3.5 accent-primary" disabled={busy} checked={strict} onChange={(e) => toggle(e.target.checked)} />
      Generated code only (strict)
    </label>
  );
}
