import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Check, FileCode2, FileText, Pin, Save, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, keys, type RewardSpec, type SpecCompile, type SpecStatus } from '../../lib/api';
import { cn, timeAgo } from '../../lib/utils';
import { CodeEditor } from '../CodeEditor';
import { DiffView } from '../DiffView';
import { toast } from '../feedback';
import { RobotBadge } from '../RunBits';
import { Badge, Button, Card, Spinner, type Tone } from '../ui';
import { Banner, EditorHeader, useUnsavedGuard } from './DesignBits';

const BUSY = ['queued', 'running'];

export function useRewardSpecs() {
  return useQuery({
    queryKey: keys.rewardSpecs,
    queryFn: api.rewardSpecs,
    refetchInterval: (q) => (q.state.data?.specs.some((s) => Object.values(s.compile ?? {}).some((c) => BUSY.includes(c.state))) ? 3000 : 15000),
  });
}

export const STATUS: Record<SpecStatus, { label: string; tone: Tone; title: string }> = {
  fresh: { label: 'compiled', tone: 'green', title: 'The code matches the spec.' },
  edited: { label: 'hand-edited', tone: 'amber', title: 'The code was edited by hand after it was compiled.' },
  stale: { label: 'stale', tone: 'red', title: 'The spec changed since this code was compiled; runs refuse it until it is recompiled.' },
  missing: { label: 'not compiled', tone: 'neutral', title: 'No code for this robot yet.' },
};

export function compileTag(c: SpecCompile | undefined): { label: string; tone: Tone } | null {
  if (!c) return null;
  if (BUSY.includes(c.state)) return { label: 'compiling…', tone: 'blue' };
  if (c.state === 'pending') return { label: 'review', tone: 'violet' };
  if (c.state === 'failed') return { label: 'compile failed', tone: 'red' };
  return null;
}

interface Section { robot: string; before: string; code: string | null; after: string }
const HEADING = /^## Compiled: *(\S+)[ \t]*$/gm;
const FENCE = /```python\n([\s\S]*?)```/;

/** The prose, then one "## Compiled: <robot>" section per robot with its code fence. */
function splitDoc(text: string): { prose: string; sections: Section[] } {
  const t = text.replace(/\r\n/g, '\n');
  const heads = [...t.matchAll(HEADING)];
  if (!heads.length) return { prose: t, sections: [] };
  const sections = heads.map((m, i) => {
    const body = t.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : t.length);
    const fence = FENCE.exec(body);
    if (!fence) return { robot: m[1], before: body, code: null, after: '' };
    const start = fence.index + '```python\n'.length;
    return { robot: m[1], before: body.slice(0, start), code: fence[1], after: body.slice(start + fence[1].length) };
  });
  return { prose: t.slice(0, heads[0].index), sections };
}

const joinDoc = (prose: string, sections: Section[]) =>
  prose + sections.map((s) => (s.code == null ? s.before : s.before + s.code + s.after)).join('');

export function RewardSpecEditor({ id }: { id: string | null }) {
  const { data, isLoading, error } = useRewardSpecs();
  const template = useQuery({ queryKey: ['reward-spec-template'], queryFn: api.rewardSpecTemplate, enabled: !id, staleTime: Infinity });
  if (isLoading || (!id && template.isLoading)) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (error) return <Banner tone="amber">{(error as Error).message}</Banner>;
  const spec = id ? data?.specs.find((s) => s._id === id) : undefined;
  if (id && !spec) return <Banner tone="amber">No reward spec {id}. It may have been deleted.</Banner>;
  return <Editor key={id ?? 'new'} spec={spec} template={template.data ?? ''} strict={!!data?.settings.strict_generated} />;
}

function Editor({ spec, template, strict }: { spec: RewardSpec | undefined; template: string; strict: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const id = spec?._id ?? null;
  const serverText = (spec?.text ?? template).replace(/\r\n/g, '\n');
  const [saved, setSaved] = useState(id ? serverText : '');
  const [text, setText] = useState(serverText);
  const [tab, setTab] = useState<'prose' | 'compiled'>('prose');
  const [busy, setBusy] = useState<string | null>(null);
  const dirty = text !== saved;
  const { leave } = useUnsavedGuard(dirty);

  // Pick up server-side changes (accepted compiles, other tabs) unless mid-edit.
  useEffect(() => {
    if (id && !dirty && serverText !== saved) { setSaved(serverText); setText(serverText); }
  }, [id, serverText]); // eslint-disable-line react-hooks/exhaustive-deps

  const doc = useMemo(() => splitDoc(text), [text]);
  const summary = spec?.summary ?? null;
  const robots = summary?.robots ?? doc.sections.map((s) => s.robot);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.rewardSpecs });

  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast('success', done);
      await refresh();
      qc.invalidateQueries({ queryKey: keys.designKind('reward_designs') });
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = () => act('save', async () => {
    const out = await api.saveRewardSpec(id, text);
    setSaved(text);
    toast(out.hand_edited.length ? 'info' : 'success', out.hand_edited.length ? `Saved. Hand-edited code kept for ${out.hand_edited.join(', ')}.` : 'Saved.');
    if (!id) {
      leave();
      navigate({ to: '/design/$tab/$itemId', params: { tab: 'specs', itemId: out._id }, search: {}, replace: true });
    }
  });

  const setCode = (robot: string, code: string) =>
    setText(joinDoc(doc.prose, doc.sections.map((s) => (s.robot === robot ? { ...s, code } : s))));

  const pendingReviews = robots.filter((r) => spec?.compile?.[r]?.state === 'pending').length;

  return (
    <div className="flex flex-col gap-4">
      <EditorHeader
        title={summary?.name || spec?.name || (id ? '(unnamed)' : 'New reward spec')}
        meta={<>
          {spec && <span>v{spec.version}</span>}
          {spec?.updated_at && <span>{timeAgo(spec.updated_at)}</span>}
          {spec?.archived && <Badge>archived</Badge>}
          {dirty && <Badge tone="amber">{id ? 'unsaved' : 'not saved yet'}</Badge>}
          {robots.map((r) => <RobotBadge key={r} robot={r} />)}
        </>}
        actions={<>
          {id && (
            <Button size="sm" disabled={!!busy || dirty || !summary} title={dirty ? 'Save first' : 'Have the MadScientist compile the spec into code for every robot'}
              onClick={() => act('compile', () => api.compileRewardSpec(id), 'Queued for compiling.')}>
              <Sparkles className="h-3.5 w-3.5" /> Compile all robots
            </Button>
          )}
          {id && (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act('archive', () => api.setRewardSpecArchived(id, !spec?.archived), spec?.archived ? 'Restored, with its designs.' : 'Archived, with its designs.')}>
              {spec?.archived ? <><ArchiveRestore className="h-3.5 w-3.5" /> Restore</> : <><Archive className="h-3.5 w-3.5" /> Archive</>}
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!!busy || (!dirty && !!id)} onClick={save}>
            {busy === 'save' ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} {id ? 'Save' : 'Create'}
          </Button>
        </>}
      />

      {spec?.parse_error && <Banner tone="amber">The spec doesn&apos;t parse: {spec.parse_error}</Banner>}
      {!!summary?.warnings.length && <Banner tone="amber">{summary.warnings.join(' · ')}</Banner>}

      <div className="flex w-fit rounded-lg border bg-card p-0.5">
        {([['prose', FileText, 'Spec'], ['compiled', FileCode2, 'Compiled code']] as const).map(([t, Icon, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={cn('inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors', tab === t ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}>
            <Icon className="h-3.5 w-3.5" /> {label}
            {t === 'compiled' && pendingReviews > 0 && <Badge tone="violet">{pendingReviews} to review</Badge>}
          </button>
        ))}
      </div>

      {tab === 'prose' ? (
        <div className="flex flex-col gap-2">
          <CodeEditor value={doc.prose} onChange={(prose) => setText(joinDoc(prose, doc.sections))} language="markdown" className="max-h-[70vh] min-h-96" />
          <p className="text-xs text-muted-foreground">
            Sections: <code className="font-mono">## Goal</code>, <code className="font-mono">## Encourage</code>, <code className="font-mono">## Discourage</code>, <code className="font-mono">## Never</code>, <code className="font-mono">## Success looks like</code> and <code className="font-mono">## Notes for &lt;robot&gt;</code>. Save, then compile: the MadScientist writes each robot&apos;s code and you review it before it&apos;s used.
          </p>
        </div>
      ) : !id ? (
        <Empty>Save the spec, then compile it to generate code for each robot.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            {strict
              ? 'Strict mode is on: this code only comes from the compiler.'
              : 'You can edit the code here; saving pins that robot\u2019s code as hand-edited until the next accepted compile.'}
          </p>
          {robots.map((r) => (
            <RobotCode
              key={r}
              spec={spec!}
              robot={r}
              section={doc.sections.find((s) => s.robot === r)}
              strict={strict}
              dirty={dirty}
              busy={busy}
              onCode={(code) => setCode(r, code)}
              act={act}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

function RobotCode({ spec, robot, section, strict, dirty, busy, onCode, act }: {
  spec: RewardSpec;
  robot: string;
  section: Section | undefined;
  strict: boolean;
  dirty: boolean;
  busy: string | null;
  onCode: (code: string) => void;
  act: (key: string, fn: () => Promise<unknown>, done?: string) => Promise<void>;
}) {
  const summary = spec.summary;
  const status = summary?.statuses[robot] ?? 'missing';
  const c = spec.compile?.[robot];
  const compiled = summary?.compiled[robot];
  const tag = compileTag(c);
  const compiling = !!c && BUSY.includes(c.state);
  const meta = compiled?.meta;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <RobotBadge robot={robot} />
          <Badge tone={STATUS[status].tone}><span title={STATUS[status].title}>{STATUS[status].label}</span></Badge>
          {tag && <Badge tone={tag.tone}>{tag.label}</Badge>}
          {status !== 'missing' && (
            <Link to="/design/$tab/$itemId" params={{ tab: 'rewards', itemId: `spec:${spec._id}:${robot}` }} search={{}} className="text-xs text-muted-foreground hover:underline">
              reward design
            </Link>
          )}
          {meta?.at && <span className="text-xs text-muted-foreground">compiled {timeAgo(meta.at)}{meta.model ? ` by ${meta.model}` : ''}</span>}
          {robot === 'microduck' && summary?.microduck_task && <span className="font-mono text-xs text-muted-foreground">{summary.microduck_task}</span>}
        </div>
        <div className="flex items-center gap-2">
          {status === 'stale' && !strict && (
            <Button size="sm" variant="ghost" disabled={!!busy || dirty} title="Keep the current code for the changed spec; it's marked hand-edited"
              onClick={() => act(`repin:${robot}`, () => api.repinRewardSpec(spec._id, robot), `Kept the current ${robot} code.`)}>
              <Pin className="h-3.5 w-3.5" /> Keep current code
            </Button>
          )}
          {!compiling && (
            <Button size="sm" disabled={!!busy || dirty} title={dirty ? 'Save first' : undefined}
              onClick={() => act(`compile:${robot}`, () => api.compileRewardSpec(spec._id, [robot]), 'Queued for compiling.')}>
              <Sparkles className="h-3.5 w-3.5" /> {status === 'missing' ? 'Compile' : 'Recompile'}
            </Button>
          )}
        </div>
      </div>

      {status === 'stale' && <p className="text-xs text-rose-600 dark:text-rose-400">Runs refuse this code until it&apos;s recompiled{strict ? '' : ' or kept'}.</p>}
      {status === 'edited' && strict && <p className="text-xs text-amber-700 dark:text-amber-300">Strict mode blocks hand-edited code; recompile it.</p>}

      {c?.state === 'queued' && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-3.5 w-3.5" /> Waiting for the MadScientist to pick it up…</p>}
      {c?.state === 'running' && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-3.5 w-3.5" /> Compiling (it retries with the checker&apos;s feedback up to 3 times)…</p>}
      {c?.state === 'failed' && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/8 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          <p className="font-medium">{c.error || 'Compile failed'}</p>
          {!!c.result?.problems?.length && <ul className="mt-1 list-disc pl-5 text-xs">{c.result.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
          <Button size="sm" variant="ghost" className="mt-2" disabled={!!busy} onClick={() => act(`discard:${robot}`, () => api.discardRewardSpec(spec._id, robot))}>Dismiss</Button>
        </div>
      )}
      {c?.state === 'pending' && c.result && (
        <Review spec={spec} robot={robot} compile={c} current={compiled?.code ?? ''} status={status} dirty={dirty} busy={busy} act={act} />
      )}

      {section?.code != null ? (
        <CodeEditor value={section.code} onChange={onCode} language="python" readOnly={strict} className="max-h-[50vh]" />
      ) : status === 'missing' ? (
        <p className="text-sm text-muted-foreground">No code yet: compile this robot to generate it.</p>
      ) : null}
    </Card>
  );
}

function Review({ spec, robot, compile: c, current, status, dirty, busy, act }: {
  spec: RewardSpec; robot: string; compile: SpecCompile; current: string; status: SpecStatus; dirty: boolean; busy: string | null;
  act: (key: string, fn: () => Promise<unknown>, done?: string) => Promise<void>;
}) {
  const r = c.result!;
  const stale = !!r.inputs_sha && r.inputs_sha !== spec.summary?.inputs_sha[robot];
  const bits = [r.model, r.rounds ? `${r.rounds.length} round${r.rounds.length === 1 ? '' : 's'}` : null, r.cost_usd != null ? `$${r.cost_usd.toFixed(3)}` : null].filter(Boolean);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-violet-500/40 bg-violet-500/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          New code to review{bits.length ? <span className="font-normal text-muted-foreground"> · {bits.join(' · ')}</span> : null}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act(`discard:${robot}`, () => api.discardRewardSpec(spec._id, robot), 'Discarded.')}>
            <Trash2 className="h-3.5 w-3.5" /> Discard
          </Button>
          <Button size="sm" variant="primary" disabled={!!busy || stale || dirty} title={stale ? 'The spec changed after this compile; compile again' : dirty ? 'Save or undo your edits first' : undefined}
            onClick={() => act(`accept:${robot}`, () => api.acceptRewardSpec(spec._id, robot), `${robot} code accepted and published.`)}>
            <Check className="h-3.5 w-3.5" /> Accept
          </Button>
        </div>
      </div>
      {status === 'edited' && <p className="text-xs text-amber-700 dark:text-amber-300">Accepting replaces your hand edits.</p>}
      {stale && <p className="text-xs text-rose-600 dark:text-rose-400">The spec changed after this compile; compile again.</p>}
      {!!r.rationale?.length && (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2 font-medium">Section</th><th className="py-1 pr-2 font-medium">Asked for</th><th className="py-1 font-medium">How</th></tr></thead>
          <tbody>
            {r.rationale.map((x, i) => (
              <tr key={i} className="border-t align-top">
                <td className="py-1 pr-2 text-muted-foreground">{x.section}</td>
                <td className="py-1 pr-2">{x.bullet}</td>
                <td className="py-1">{x.implementation}{x.terms?.length ? <span className="ml-1 font-mono text-muted-foreground">[{x.terms.join(', ')}]</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!!r.unsupported?.length && (
        <div className="text-xs">
          <p className="font-medium">Not implementable on this robot</p>
          <ul className="mt-1 list-disc pl-5">{r.unsupported.map((u, i) => <li key={i}><b>{u.section}:</b> {u.bullet}{u.reason ? ` (${u.reason})` : ''}</li>)}</ul>
        </div>
      )}
      {r.code != null && <DiffView a={current} b={r.code} context={4} className="max-h-[50vh]" />}
    </div>
  );
}
