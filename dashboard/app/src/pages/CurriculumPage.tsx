import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Archive, ArchiveRestore, ArrowLeft, Braces, CheckCircle2, ClipboardCopy, Copy, ListChecks, Play, Plus, Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CurriculumRunsTable } from '../components/curricula/CurriculumRunsTable';
import { StageEditor } from '../components/curricula/StageEditor';
import { confirmDialog, toast } from '../components/feedback';
import { Modal } from '../components/Modal';
import { RobotBadge } from '../components/RunBits';
import { Badge, Button, Card, Empty, Field, Input, Select, Spinner, Textarea } from '../components/ui';
import { api, ApiError, keys, type CurriculumCaps, type Stage } from '../lib/api';
import { robotName, useRobots } from '../lib/robots';
import { cn } from '../lib/utils';
import { useCurriculumCaps } from './CurriculaPage';

export interface CurriculumSearch { robot?: string; from?: string }

interface Draft { name: string; description: string; stages: Stage[] }

const CHECK_DEBOUNCE_MS = 600;
const STAGE_PROBLEM = /^stage (\d+)(?: \([^)]*\))?: /;

function newStage(i: number): Stage {
  return { name: `Stage ${i + 1}` };
}

function firstStage(defaultGym: string | null): Stage {
  return { name: 'Stage 1', ...(defaultGym ? { gym: defaultGym } : {}), budget: 1000, init: 'none' };
}

/** "stage 2 (Jump): gym is required" -> stage 1 gets "gym is required". */
function splitProblems(problems: string[]) {
  const byStage: Record<number, string[]> = {};
  const general: string[] = [];
  for (const p of problems) {
    const m = STAGE_PROBLEM.exec(p);
    if (m) (byStage[Number(m[1]) - 1] ??= []).push(p.slice(m[0].length));
    else general.push(p);
  }
  return { byStage, general };
}

const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

export function CurriculumPage() {
  const { curriculumId } = useParams({ strict: false }) as { curriculumId: string };
  const search = useSearch({ strict: false }) as CurriculumSearch;
  const isNew = curriculumId === 'new';
  const sourceId = isNew ? search.from : curriculumId;
  const { data: caps } = useCurriculumCaps();
  const source = useQuery({ queryKey: keys.curriculum(sourceId ?? ''), queryFn: () => api.curriculum(sourceId!), enabled: !!sourceId });

  if (sourceId && source.isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (sourceId && source.error) {
    return <div className="p-8"><Empty title="Couldn't load the curriculum">{(source.error as Error).message}</Empty></div>;
  }
  const cur = source.data?.curriculum;
  const robot = cur?.robot ?? search.robot ?? Object.entries(caps?.robots ?? {}).find(([, c]) => c.enabled)?.[0];
  if (!caps || !robot) return <div className="grid place-items-center py-24"><Spinner /></div>;
  const initial: Draft | null = cur
    ? { name: isNew ? `${cur.name ?? 'Curriculum'} (copy)` : cur.name ?? '', description: cur.description, stages: cur.authored }
    : null;
  return (
    <Editor
      key={`${curriculumId}:${cur?.version ?? 0}:${robot}`}
      id={isNew ? null : curriculumId}
      robot={robot}
      caps={caps.robots[robot]}
      initial={initial}
      version={isNew ? null : cur?.version ?? null}
      archived={!isNew && !!cur?.archived}
      runs={isNew ? [] : source.data?.runs ?? []}
      resolvedSaved={isNew ? [] : cur?.resolved ?? []}
    />
  );
}

function Editor({ id, robot, caps, initial, version, archived, runs, resolvedSaved }: {
  id: string | null;
  robot: string;
  caps: CurriculumCaps | undefined;
  initial: Draft | null;
  version: number | null;
  archived: boolean;
  runs: NonNullable<Awaited<ReturnType<typeof api.curriculum>>>['runs'];
  resolvedSaved: Stage[];
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: robots } = useRobots();
  const { data: options } = useQuery({ queryKey: keys.launchOptions(robot), queryFn: () => api.launchOptions(robot) });
  const blank = useMemo<Draft>(() => ({ name: '', description: '', stages: [firstStage(null)] }), []);
  const [baseline, setBaseline] = useState<Draft>(initial ?? blank);
  const [draft, setDraft] = useState<Draft>(initial ?? blank);
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ resolved: Stage[] | null; problems: string[]; checking: boolean }>({ resolved: null, problems: [], checking: false });
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const enabled = !!caps?.enabled;
  const readOnly = archived || !enabled;
  const dirty = !sameDraft(draft, baseline);

  // A new curriculum starts on the robot's usual first gym once the options are in.
  useEffect(() => {
    if (initial || !options?.defaults.gym_id) return;
    const withGym = { ...blank, stages: [firstStage(options.defaults.gym_id)] };
    setBaseline(withGym);
    setDraft((d) => (sameDraft(d, blank) ? withGym : d));
  }, [options, initial, blank]);

  // Live check against the same validator Save uses.
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const n = ++seq.current;
    setCheck((c) => ({ ...c, checking: true }));
    const t = window.setTimeout(async () => {
      try {
        const out = await api.checkCurriculum({ robot, name: draft.name.trim() || 'untitled', description: draft.description, stages: draft.stages });
        if (n === seq.current) setCheck({ resolved: out.curriculum.stages, problems: [], checking: false });
      } catch (e) {
        if (n !== seq.current) return;
        const problems = e instanceof ApiError && Array.isArray(e.body?.problems) && e.body.problems.length ? e.body.problems : [(e as Error).message];
        setCheck({ resolved: null, problems, checking: false });
      }
    }, CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [draft, robot, enabled]);

  const leaving = useRef(false);
  useBlocker({
    shouldBlockFn: async () => !leaving.current && dirty && !(await confirmDialog({ title: 'Discard unsaved changes?', message: 'Your edits to this curriculum haven\u2019t been saved.', confirmLabel: 'Discard', danger: true })),
    enableBeforeUnload: () => dirty,
  });

  const { byStage, general } = splitProblems(check.problems);
  const resolved = check.resolved ?? (dirty ? null : resolvedSaved);
  const setStages = (fn: (s: Stage[]) => Stage[]) => setDraft((d) => ({ ...d, stages: fn(d.stages) }));

  const toJson = () => {
    setJsonText(JSON.stringify(draft.stages, null, 2));
    setJsonError(null);
    setMode('json');
  };
  const onJson = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed) || parsed.some((s) => !s || typeof s !== 'object' || Array.isArray(s))) throw new Error('stages must be a JSON array of objects');
      setJsonError(null);
      setStages(() => parsed);
    } catch (e) {
      setJsonError((e as Error).message);
    }
  };

  const save = async () => {
    if (!draft.name.trim()) { toast('error', 'Give the curriculum a name first.'); return; }
    if (jsonError) { toast('error', 'Fix the stages JSON first.'); return; }
    setSaving(true);
    try {
      const body = { name: draft.name.trim(), description: draft.description, stages: draft.stages };
      if (id) {
        await api.updateCurriculum(id, body);
        setBaseline({ ...draft, name: body.name });
        toast('success', `Saved as v${(version ?? 0) + 1}. Runs already started keep the stages they began with.`);
      } else {
        const newId = await api.createCurriculum({ robot, ...body });
        setBaseline(draft);
        toast('success', 'Curriculum created.');
        leaving.current = true;
        navigate({ to: '/curricula/$curriculumId', params: { curriculumId: newId }, replace: true });
      }
      qc.invalidateQueries({ queryKey: keys.allCurricula });
    } catch (e) {
      const problems = e instanceof ApiError && Array.isArray(e.body?.problems) ? e.body.problems : [];
      toast('error', problems.length ? `Not saved: ${problems.length} problem${problems.length === 1 ? '' : 's'} to fix (shown on the stages).` : `Not saved: ${(e as Error).message}`);
      if (problems.length) setCheck({ resolved: null, problems, checking: false });
    } finally {
      setSaving(false);
    }
  };

  const setArchived = async (next: boolean) => {
    if (!id) return;
    if (next && !(await confirmDialog({ title: 'Archive this curriculum?', message: 'It\u2019s hidden from the list and can\u2019t start new runs. Its runs, jobs and models are kept.', confirmLabel: 'Archive' }))) return;
    try {
      await api.setCurriculumArchived(id, next);
      toast('success', next ? 'Archived.' : 'Restored.');
      qc.invalidateQueries({ queryKey: keys.allCurricula });
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const copyJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify({ robot, name: draft.name, description: draft.description, stages: draft.stages }, null, 2));
    toast('info', 'Copied the curriculum as JSON.');
  };

  const stageNames = (resolved ?? draft.stages).map((s, i) => s.name || `Stage ${i + 1}`);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 p-4 sm:p-8">
      <div>
        <Link to="/curricula" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Curricula
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{draft.name || (id ? '(unnamed)' : 'New curriculum')}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <RobotBadge robot={robot} />
              {version != null && <span>v{version}</span>}
              {archived && <Badge>archived</Badge>}
              {dirty && <Badge tone="amber">unsaved</Badge>}
              {enabled && (check.checking ? <span className="text-xs">Checking…</span> : check.problems.length ? (
                <Badge tone="red">{check.problems.length} problem{check.problems.length === 1 ? '' : 's'}</Badge>
              ) : check.resolved ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> Valid</span>
              ) : null)}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {id && (
              <Button size="sm" disabled={readOnly || dirty} onClick={() => setStarting(true)} title={dirty ? 'Save your edits before starting a run' : archived ? 'Restore it to start runs' : 'Queue its stages'}>
                <Play className="h-3.5 w-3.5" /> Start run
              </Button>
            )}
            {id && (
              <Link to="/curricula/$curriculumId" params={{ curriculumId: 'new' }} search={{ from: id, robot }}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs font-medium hover:bg-muted">
                <Copy className="h-3.5 w-3.5" /> Duplicate
              </Link>
            )}
            <Button size="sm" variant="ghost" onClick={copyJson} title="Copy as JSON (for the MCP console or a script)"><ClipboardCopy className="h-3.5 w-3.5" /> JSON</Button>
            {id && (archived
              ? <Button size="sm" variant="ghost" onClick={() => setArchived(false)}><ArchiveRestore className="h-3.5 w-3.5" /> Restore</Button>
              : <Button size="sm" variant="ghost" onClick={() => setArchived(true)}><Archive className="h-3.5 w-3.5" /> Archive</Button>)}
            <Button size="sm" variant="primary" disabled={readOnly || saving || (!dirty && !!id)} onClick={save}>
              {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} {id ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      </div>

      {!enabled && (
        <Card className="px-4 py-3 text-sm text-muted-foreground">
          Curricula aren't enabled for {robotName(robots, robot)} (manifest <code className="font-mono text-xs">curriculum.enabled</code>), so this one is read-only.
        </Card>
      )}

      <Card className="grid gap-4 p-4 sm:grid-cols-[1fr_2fr]">
        <Field label="Name">
          <Input value={draft.name} disabled={readOnly} maxLength={160} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Balance → recovery → jump" />
        </Field>
        <Field label="Description">
          <Input value={draft.description} disabled={readOnly} maxLength={600} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What it builds up to, and why in this order" />
        </Field>
      </Card>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Stages <span className="font-normal text-muted-foreground">· {draft.stages.length}</span></h2>
          <div className="flex rounded-lg border bg-card p-0.5">
            {([['form', ListChecks, 'Form'], ['json', Braces, 'JSON']] as const).map(([m, Icon, label]) => (
              <button
                key={m}
                onClick={() => (m === 'json' ? toJson() : !jsonError && setMode('form'))}
                className={cn('inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors', mode === m ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}
                title={m === 'form' && jsonError ? 'Fix the JSON first' : undefined}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
        </div>
        {general.length > 0 && (
          <ul className="list-disc rounded-lg border border-rose-500/40 bg-rose-500/8 py-2 pl-8 pr-3 text-sm text-rose-700 dark:text-rose-300">
            {general.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        )}
        {!caps ? null : mode === 'json' ? (
          <div className="flex flex-col gap-1.5">
            <Textarea
              value={jsonText}
              onChange={(e) => onJson(e.target.value)}
              disabled={readOnly}
              spellCheck={false}
              className="min-h-[28rem] font-mono text-xs"
            />
            <p className={cn('text-xs', jsonError ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground')}>
              {jsonError ?? 'A stage that leaves out gym, reward_design_id, experiment_design_id or budget keeps the previous stage\u2019s; settings merge over earlier stages.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {draft.stages.map((s, i) => (
              <StageEditor
                key={i}
                stage={s}
                index={i}
                stages={draft.stages}
                caps={caps}
                options={options}
                resolved={resolved?.[i]}
                problems={byStage[i] ?? []}
                readOnly={readOnly}
                onChange={(next) => setStages((all) => all.map((x, xi) => (xi === i ? next : x)))}
                onMove={(dir) => setStages((all) => {
                  const next = all.slice();
                  [next[i], next[i + dir]] = [next[i + dir], next[i]];
                  return next;
                })}
                onRemove={() => setStages((all) => all.filter((_, xi) => xi !== i))}
                onDuplicate={() => setStages((all) => [...all.slice(0, i + 1), { ...structuredClone(s), id: undefined, name: `${s.name || `Stage ${i + 1}`} (copy)` }, ...all.slice(i + 1)])}
              />
            ))}
            {!readOnly && (
              <Button className="self-start" onClick={() => setStages((all) => [...all, newStage(all.length)])}>
                <Plus className="h-4 w-4" /> Add stage
              </Button>
            )}
          </div>
        )}
      </div>

      {id && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Runs <span className="font-normal text-muted-foreground">· {runs.length}</span></h2>
          {runs.length ? <CurriculumRunsTable runs={runs} showCurriculum /> : <Empty title="Not run yet">Start a run to queue its first stage.</Empty>}
        </section>
      )}

      {starting && id && (
        <StartRunDialog
          id={id}
          name={draft.name}
          stages={stageNames}
          resolved={resolved ?? []}
          onClose={() => setStarting(false)}
          onStarted={(runId) => navigate({ to: '/curricula/runs/$runId', params: { runId } })}
        />
      )}
    </div>
  );
}

function StartRunDialog({ id, name, stages, resolved, onClose, onStarted }: {
  id: string; name: string; stages: string[]; resolved: Stage[]; onClose: () => void; onStarted: (runId: string) => void;
}) {
  const qc = useQueryClient();
  const [start, setStart] = useState(0);
  const [priority, setPriority] = useState<'front' | 'normal'>('front');
  const [busy, setBusy] = useState(false);
  const needsPrevious = start > 0 && (resolved[start]?.init ?? 'previous') === 'previous';
  const go = async () => {
    setBusy(true);
    try {
      const runId = await api.startCurriculumRun(id, { start_stage: start, priority });
      qc.invalidateQueries({ queryKey: keys.allCurricula });
      qc.invalidateQueries({ queryKey: keys.allRuns });
      toast('success', 'Curriculum run started.');
      onStarted(runId);
    } catch (e) {
      const problems = e instanceof ApiError && Array.isArray(e.body?.problems) ? e.body.problems : [];
      toast('error', problems.length ? problems.join('; ') : (e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Start “${name}”`}
      description="Each stage is queued as a training job, followed by a gate eval when it has a gate."
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || needsPrevious} onClick={go}>{busy ? <Spinner className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} Start run</Button>
      </>}
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Start at"
          error={needsPrevious ? 'That stage starts from the previous stage\u2019s checkpoint, which a run starting there won\u2019t have.' : undefined}
          hint="Later stages run in order from there."
        >
          <Select value={start} onChange={(e) => setStart(Number(e.target.value))}>
            {stages.map((s, i) => <option key={i} value={i}>{i + 1}. {s}</option>)}
          </Select>
        </Field>
        <Field label="Queue position">
          <div className="flex flex-col gap-1.5 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="radio" className="accent-primary" checked={priority === 'front'} onChange={() => setPriority('front')} />
              Front of the queue: each stage jumps ahead of queued runs
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="radio" className="accent-primary" checked={priority === 'normal'} onChange={() => setPriority('normal')} />
              Back of the queue, like any other run
            </label>
          </div>
        </Field>
      </div>
    </Modal>
  );
}
