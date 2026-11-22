import { useQuery } from '@tanstack/react-query';
import { Link, useBlocker } from '@tanstack/react-router';
import { GitCompareArrows, History, Plus, Search } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { api, type DesignKind, type DesignUsage } from '../../lib/api';
import { cn, shortId, timeAgo } from '../../lib/utils';
import { DiffView } from '../DiffView';
import { confirmDialog } from '../feedback';
import { Modal } from '../Modal';
import { RobotBadge, runTitle, StatusBadge } from '../RunBits';
import { Badge, Button, Card, CardHeader, Empty, Input, Spinner } from '../ui';

export const DESIGN_TABS = [
  { slug: 'rewards', label: 'Reward designs', kind: 'reward_designs' },
  { slug: 'specs', label: 'Reward specs', kind: null },
  { slug: 'experiments', label: 'Experiment designs', kind: 'experiment_designs' },
  { slug: 'gyms', label: 'Gyms', kind: 'gyms' },
  { slug: 'demos', label: 'Demos', kind: 'demos' },
] as const;
export type DesignTab = (typeof DESIGN_TABS)[number]['slug'];

export interface ListItem {
  id: string;
  title: string;
  meta?: ReactNode;
  description?: string;
  badges?: ReactNode;
  robot?: string;
  archived?: boolean;
}

/** The left-hand list of one studio section: search, archived toggle, new. */
export function DesignList({ tab, items, selected, loading, error, archived, onArchived, showRobot, newLabel, canCreate = true, newHint, newRobot, extra }: {
  tab: DesignTab;
  items: ListItem[];
  selected: string | undefined;
  loading: boolean;
  error: unknown;
  archived: boolean;
  onArchived: (v: boolean) => void;
  showRobot: boolean;
  newLabel: string;
  canCreate?: boolean;
  newHint?: string;
  newRobot?: string;
  extra?: ReactNode;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? items.filter((i) => `${i.title} ${i.id} ${i.description ?? ''}`.toLowerCase().includes(needle))
    : items;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="w-full pl-8" />
        </div>
        <div className="flex items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={archived} onChange={(e) => onArchived(e.target.checked)} />
            Archived too
          </label>
          {canCreate ? (
            <Link
              to="/design/$tab/$itemId"
              params={{ tab, itemId: 'new' }}
              search={{ robot: newRobot }}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" /> {newLabel}
            </Link>
          ) : newHint ? <span className="text-right text-[11px] text-muted-foreground">{newHint}</span> : null}
        </div>
        {extra}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="grid place-items-center py-10"><Spinner /></div>
        ) : error ? (
          <p className="p-4 text-sm text-rose-600 dark:text-rose-400">{(error as Error).message}</p>
        ) : !shown.length ? (
          <p className="p-4 text-sm text-muted-foreground">{needle ? 'Nothing matches.' : 'Nothing here yet.'}</p>
        ) : (
          shown.map((i) => (
            <Link
              key={i.id}
              to="/design/$tab/$itemId"
              params={{ tab, itemId: i.id }}
              search={{}}
              className={cn(
                'block border-b px-3 py-2.5 transition-colors hover:bg-muted/60',
                selected === i.id && 'bg-muted',
                i.archived && 'opacity-60',
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{i.title}</span>
                {i.badges}
                {i.archived && <Badge>archived</Badge>}
              </div>
              {(i.meta || (showRobot && i.robot)) && (
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  {showRobot && i.robot && <RobotBadge robot={i.robot} />}
                  {i.meta}
                </div>
              )}
              {i.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{i.description}</p>}
            </Link>
          ))
        )}
      </div>
    </div>
  );
}

export function usedText(u: { runs: number; models?: number; curricula?: number } | undefined): string {
  if (!u || (!u.runs && !u.models && !u.curricula)) return 'unused';
  const parts: string[] = [];
  if (u.runs) parts.push(`${u.runs} run${u.runs === 1 ? '' : 's'}`);
  if (u.models) parts.push(`${u.models} model${u.models === 1 ? '' : 's'}`);
  if (u.curricula) parts.push(`${u.curricula} curricul${u.curricula === 1 ? 'um' : 'a'}`);
  return parts.join(' · ');
}

/** Title, badges and actions over an editor. */
export function EditorHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="truncate text-xl font-semibold tracking-tight">{title}</h2>
        {meta && <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Asks before leaving with unsaved edits; `leave()` lets a save navigate without asking. */
export function useUnsavedGuard(dirty: boolean) {
  const leaving = useRef(false);
  useBlocker({
    shouldBlockFn: async () => !leaving.current && dirty
      && !(await confirmDialog({ title: 'Discard unsaved changes?', message: 'Your edits haven\u2019t been saved.', confirmLabel: 'Discard', danger: true })),
    enableBeforeUnload: () => dirty,
  });
  return { leave: () => { leaving.current = true; } };
}

/**
 * What uses a design: runs (newest first, to open or compare), models, curricula
 * whose stages pick it, and the versions runs trained with, each viewable
 * against the current one from the copy a run or model kept.
 */
export function UsagePanel({ kind, id, usage, current, render }: {
  kind: DesignKind;
  id: string;
  usage: DesignUsage;
  /** The current version as text, to diff past versions against. */
  current?: string;
  /** A past version's snapshot as text. */
  render?: (snapshot: unknown) => string;
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  const recent = usage.recent;
  return (
    <Card>
      <CardHeader
        title="Used by"
        description={usedText({ runs: usage.runs, models: usage.models, curricula: usage.curricula.length })}
        actions={recent.length > 1 ? (
          <Link to="/compare" search={{ runs: recent.slice(0, 8).map((r) => r.id).join(',') }} className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs font-medium hover:bg-muted">
            <GitCompareArrows className="h-3.5 w-3.5" /> Compare recent
          </Link>
        ) : undefined}
      />
      <div className="flex flex-col gap-4 p-4">
        {!usage.runs && !usage.models && !usage.curricula.length ? (
          <p className="text-sm text-muted-foreground">Nothing has used it yet.</p>
        ) : null}
        {recent.length > 0 && (
          <div className="flex flex-col">
            {recent.map((r) => (
              <Link key={r.id} to="/runs/$runId" params={{ runId: r.id }} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                <StatusBadge status={r.status} />
                <span className="min-w-0 flex-1 truncate">{runTitle(r)}</span>
                <span className="font-mono text-xs text-muted-foreground">{shortId(r.id)}</span>
                <span className="w-16 text-right text-xs text-muted-foreground">{timeAgo(r.created_at)}</span>
              </Link>
            ))}
            {usage.runs > recent.length && (
              <p className="px-2 pt-1 text-xs text-muted-foreground">and {usage.runs - recent.length} older</p>
            )}
          </div>
        )}
        {usage.curricula.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-xs text-muted-foreground">In curricula:</span>
            {usage.curricula.map((c) => (
              <Link key={c.id} to="/curricula/$curriculumId" params={{ curriculumId: c.id }} className="rounded-md bg-muted px-2 py-0.5 text-xs hover:underline">{c.name ?? c.id}</Link>
            ))}
          </div>
        )}
        {usage.derived.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-xs text-muted-foreground">Derived designs:</span>
            {usage.derived.map((d) => (
              <Link key={d.id} to="/design/$tab/$itemId" params={{ tab: 'experiments', itemId: d.id }} className="rounded-md bg-muted px-2 py-0.5 text-xs hover:underline">{d.name ?? d.id}</Link>
            ))}
          </div>
        )}
        {usage.versions.length > 0 && (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><History className="h-3.5 w-3.5" /> Versions trained with</p>
            <table className="w-full text-sm">
              <tbody>
                {usage.versions.map((v) => (
                  <tr key={v.version} className="border-t">
                    <td className="py-1.5 font-medium">v{v.version}</td>
                    <td className="py-1.5 text-xs text-muted-foreground">{usedText(v)}</td>
                    <td className="py-1.5 text-xs text-muted-foreground">{timeAgo(v.last_used)}</td>
                    <td className="py-1.5 text-right">
                      {render && current != null && <Button size="sm" variant="ghost" onClick={() => setViewing(v.version)}>Compare to now</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {viewing != null && render && current != null && (
        <VersionDiff kind={kind} id={id} version={viewing} current={current} render={render} onClose={() => setViewing(null)} />
      )}
    </Card>
  );
}

function VersionDiff({ kind, id, version, current, render, onClose }: {
  kind: DesignKind; id: string; version: number; current: string; render: (s: unknown) => string; onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({ queryKey: ['design-version', kind, id, version], queryFn: () => api.designVersion(kind, id, version) });
  return (
    <Modal
      title={`v${version} compared to the current version`}
      description={data ? <>From the copy {data.from.kind === 'run' ? 'run' : 'model'} {data.from.kind === 'run'
        ? <Link to="/runs/$runId" params={{ runId: data.from.id }} className="font-mono hover:underline">{shortId(data.from.id)}</Link>
        : <Link to="/models/$modelId" params={{ modelId: data.from.id }} className="font-mono hover:underline">{shortId(data.from.id)}</Link>} kept when it trained.</> : undefined}
      onClose={onClose}
      className="max-w-4xl"
    >
      {isLoading ? <div className="grid place-items-center py-10"><Spinner /></div>
        : error ? <Empty title="No copy of that version">{(error as Error).message}</Empty>
        : data ? (render(data.snapshot) === current
          ? <p className="text-sm text-muted-foreground">Identical to the current version.</p>
          : <DiffView a={render(data.snapshot)} b={current} context={3} className="max-h-[65vh]" />)
        : null}
    </Modal>
  );
}

export function Banner({ tone = 'neutral', children }: { tone?: 'neutral' | 'amber'; children: ReactNode }) {
  return (
    <div className={cn('rounded-lg border px-3.5 py-2.5 text-sm', tone === 'amber' ? 'border-amber-500/40 bg-amber-500/8 text-amber-800 dark:text-amber-200' : 'bg-muted/50 text-muted-foreground')}>
      {children}
    </div>
  );
}
