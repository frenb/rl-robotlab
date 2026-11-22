import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Archive, ArchiveRestore, BookOpen, CheckCircle2, Copy, Save, ScanSearch, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { api, ApiError, keys, type DesignUsage, type LintResult, type RewardDesignRow } from '../../lib/api';
import { isMjlab, useRobots } from '../../lib/robots';
import { cn } from '../../lib/utils';
import { CodeEditor, type EditorApi } from '../CodeEditor';
import { confirmDialog, toast } from '../feedback';
import { RobotBadge } from '../RunBits';
import { Badge, Button, Card, CardHeader, Field, Input, Select, Spinner } from '../ui';
import { Banner, EditorHeader, UsagePanel, useUnsavedGuard } from './DesignBits';

const CAR_TEMPLATE = `"""Brief description of what this reward design changes.

Each function returns a float reward for the named situation.
Missing functions fall through to the underlying course's defaults.
"""


def reward_standard(data, data_arr, step_costs, *, defaults, course):
    """Per-step reward while the episode is still running."""
    return defaults.standard(data, data_arr, step_costs)


def reward_success(data, data_arr, step_costs, position_history, *,
                   defaults, course):
    """Terminal reward when the episode ends in success."""
    return defaults.success(data, data_arr, step_costs, position_history)


def reward_failure(data, data_arr, step_costs, position_history, *,
                   defaults, course):
    """Terminal reward when the episode ends in failure."""
    return defaults.failure(data, data_arr, step_costs, position_history)
`;

// Kept in sync with PASSTHROUGH_DESIGN_CODE in rl_agent/duck/reward_design.py.
const MJLAB_TEMPLATE = `"""Brief description of what this reward design changes.

TERMS maps a reward term name to
  None                              drop the task's default term
  {"weight": w, "params": {...}}    reweight / re-parameterise a default term
  {"func": "<library fn>", "weight": w, "params": {...}}   add a library term
  {"weight": w, "params": {...}}    add term_<name> defined below
A curriculum that ramps a term's weight or params is removed when this design
drops the term or sets what the curriculum ramps; the job log lists them.

env offers: num_envs, device, step_dt, episode_length_buf, robot (joint_pos,
joint_vel, root_link_lin_vel_b, root_link_ang_vel_b, projected_gravity_b, ...),
action, prev_action, command(name), sensor(name), joint_ids(regex),
body_ids(regex).
"""

TERMS = {
}


# def term_lean_forward(env, target):
#     pitch = -env.robot.projected_gravity_b[:, 0]
#     return torch.exp(-((pitch - target) ** 2) / 0.01)
`;

interface Draft { name: string; description: string; code: string }

export function RewardDesignEditor({ id, robot, from }: { id: string | null; robot: string; from?: string }) {
  const sourceId = id ?? from;
  const { data, isLoading, error } = useQuery({
    queryKey: keys.design('reward_designs', sourceId ?? ''),
    queryFn: () => api.design('reward_designs', sourceId!),
    enabled: !!sourceId,
  });
  if (sourceId && isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (sourceId && error) return <Banner tone="amber">{(error as Error).message}</Banner>;
  const item = data?.item;
  const theRobot = item?.robot ?? robot;
  return (
    <Editor
      key={`${id ?? 'new'}:${from ?? ''}:${item?.version ?? 0}:${theRobot}`}
      id={id}
      robot={theRobot}
      item={id ? item : undefined}
      usage={id ? data?.usage : undefined}
      initial={item
        ? { name: id ? item.name ?? '' : `${item.name ?? 'design'} (copy)`, description: item.description, code: item.code ?? '' }
        : null}
    />
  );
}

function Editor({ id, robot, item, usage, initial }: {
  id: string | null;
  robot: string;
  item: RewardDesignRow | undefined;
  usage: DesignUsage | undefined;
  initial: Draft | null;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: robots } = useRobots();
  const mjlab = isMjlab(robots, robot);
  const blank: Draft = { name: '', description: '', code: mjlab ? MJLAB_TEMPLATE : CAR_TEMPLATE };
  const [baseline, setBaseline] = useState<Draft>(initial ?? blank);
  const [draft, setDraft] = useState<Draft>(initial ?? blank);
  const [lint, setLint] = useState<{ busy: boolean; result: LintResult | null }>({ busy: false, result: null });
  const [saving, setSaving] = useState(false);
  const [taskId, setTaskId] = useState(() => localStorage.getItem(`rd-task:${robot}`) ?? '');
  const editorRef = useRef<EditorApi | null>(null);
  const dirty = draft.name !== baseline.name || draft.description !== baseline.description || draft.code !== baseline.code;
  const { leave } = useUnsavedGuard(dirty);

  const specCompiled = !!item?.spec_id;
  const readOnly = !!item?.canonical || specCompiled;

  const gyms = useQuery({ queryKey: keys.designs('gyms', robot, false), queryFn: () => api.designs('gyms', robot, false), enabled: mjlab });
  const { data: options } = useQuery({ queryKey: keys.launchOptions(robot), queryFn: () => api.launchOptions(robot), enabled: mjlab });
  const tasks = useMemo(() => (gyms.data ?? []).filter((g) => g.task_id).sort((a, b) => a.task_id!.localeCompare(b.task_id!)), [gyms.data]);
  const task = tasks.find((g) => g.task_id === taskId) ?? tasks.find((g) => g.id === options?.defaults.gym_id) ?? tasks[0];

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (patch.code !== undefined) setLint({ busy: false, result: null });
  };

  const runLint = async (): Promise<LintResult | null> => {
    setLint({ busy: true, result: null });
    try {
      const result = await api.lintRewardDesign(draft.code, robot, mjlab ? task?.task_id : null);
      setLint({ busy: false, result });
      return result;
    } catch (e) {
      const result = { ok: false, error: (e as Error).message };
      setLint({ busy: false, result });
      return result;
    }
  };

  const save = async () => {
    const name = draft.name.trim();
    if (!name) { toast('error', 'Give the design a name first.'); return; }
    if (!draft.code.trim()) { toast('error', 'The code is empty.'); return; }
    const linted = await runLint();
    if (!linted?.ok) { toast('error', 'Not saved: it doesn\u2019t lint. The problem is shown under the code.'); return; }
    setSaving(true);
    try {
      if (id) {
        await api.updateRewardDesign(id, { name, description: draft.description, code: draft.code });
        setBaseline({ ...draft, name });
        toast('success', `Saved as v${(item?.version ?? 0) + 1}. Runs already queued keep the version they started with.`);
      } else {
        const newId = await api.addRewardDesign({ name, description: draft.description, code: draft.code, robot });
        setBaseline(draft);
        toast('success', 'Reward design created.');
        leave();
        navigate({ to: '/design/$tab/$itemId', params: { tab: 'rewards', itemId: newId }, search: {}, replace: true });
      }
      qc.invalidateQueries({ queryKey: keys.designKind('reward_designs') });
      qc.invalidateQueries({ queryKey: keys.launchOptions(robot) });
    } catch (e) {
      toast('error', `Not saved: ${e instanceof ApiError ? e.message : (e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const setArchived = async (next: boolean) => {
    if (!id) return;
    if (next && !(await confirmDialog({ title: 'Archive this reward design?', message: 'It\u2019s hidden from the launch form and curricula pickers. Runs and models that used it keep their copy.', confirmLabel: 'Archive' }))) return;
    try {
      await (next ? api.archiveRewardDesign(id) : api.updateRewardDesign(id, { archived: false }));
      toast('success', next ? 'Archived.' : 'Restored.');
      qc.invalidateQueries({ queryKey: keys.designKind('reward_designs') });
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const insert = (line: string) => {
    if (readOnly) return;
    editorRef.current?.insertLine(line, /^TERMS\s*=\s*\{/m);
  };

  return (
    <div className="flex flex-col gap-4">
      <EditorHeader
        title={draft.name || (id ? '(unnamed)' : 'New reward design')}
        meta={<>
          <RobotBadge robot={robot} />
          {item && <span>v{item.version}</span>}
          {item?.canonical && <Badge tone="blue">default</Badge>}
          {specCompiled && <Badge tone="violet">from a spec</Badge>}
          {item?.archived && <Badge>archived</Badge>}
          {dirty && <Badge tone="amber">unsaved</Badge>}
          {item?.author && <span className="text-xs">by {item.author}</span>}
        </>}
        actions={<>
          <Button size="sm" onClick={runLint} disabled={lint.busy || !draft.code.trim()}>
            {lint.busy ? <Spinner className="h-3.5 w-3.5" /> : <ScanSearch className="h-3.5 w-3.5" />} Lint
          </Button>
          {id && (
            <Link to="/design/$tab/$itemId" params={{ tab: 'rewards', itemId: 'new' }} search={{ from: id, robot }}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs font-medium hover:bg-muted">
              <Copy className="h-3.5 w-3.5" /> Duplicate
            </Link>
          )}
          {id && !readOnly && (item?.archived
            ? <Button size="sm" variant="ghost" onClick={() => setArchived(false)}><ArchiveRestore className="h-3.5 w-3.5" /> Restore</Button>
            : <Button size="sm" variant="ghost" onClick={() => setArchived(true)}><Archive className="h-3.5 w-3.5" /> Archive</Button>)}
          {!readOnly && (
            <Button size="sm" variant="primary" disabled={saving || lint.busy || (!dirty && !!id)} onClick={save}>
              {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} {id ? 'Save' : 'Create'}
            </Button>
          )}
        </>}
      />

      {item?.canonical && (
        <Banner>The robot&apos;s default design is read-only so runs that rely on it stay comparable. Duplicate it to change it.</Banner>
      )}
      {specCompiled && (
        <Banner>
          This code is compiled from a reward spec, so it&apos;s edited there.{' '}
          <Link to="/design/$tab/$itemId" params={{ tab: 'specs', itemId: item!.spec_id! }} className="font-medium underline">Open the spec</Link>
          {item?.spec_status && item.spec_status !== 'fresh' && <> (it&apos;s <b>{item.spec_status}</b> for this robot)</>}.
        </Banner>
      )}

      <Card className="grid gap-4 p-4 sm:grid-cols-[1fr_2fr]">
        <Field label="Name">
          <Input value={draft.name} disabled={readOnly} maxLength={120} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. proximity-bonus-v1" />
        </Field>
        <Field label="Description">
          <Input value={draft.description} disabled={readOnly} maxLength={280} onChange={(e) => set({ description: e.target.value })} placeholder="What it rewards, and why" />
        </Field>
      </Card>

      <div className={cn('grid gap-4', mjlab && 'xl:grid-cols-[minmax(0,1fr)_20rem]')}>
        <div className="flex min-w-0 flex-col gap-2">
          <CodeEditor
            value={draft.code}
            onChange={(code) => set({ code })}
            language="python"
            readOnly={readOnly}
            editorRef={editorRef}
            className="max-h-[70vh] min-h-80"
          />
          <LintLine lint={lint} mjlab={mjlab} task={task?.task_id} />
          <p className="text-xs text-muted-foreground">
            {mjlab
              ? <>A top-level <code className="font-mono">TERMS</code> dict edits the task&apos;s reward terms; <code className="font-mono">term_&lt;name&gt;(env, …)</code> functions add new ones. Lint runs the duck worker&apos;s own loader against the task picked on the right.</>
              : <>Define <code className="font-mono">reward_standard</code>, <code className="font-mono">reward_success</code> and/or <code className="font-mono">reward_failure</code>; any left out fall through to the course&apos;s defaults (<code className="font-mono">defaults.standard(…)</code> and so on). Saving lints first.</>}
          </p>
        </div>
        {mjlab && (
          <TermReference
            robot={robot}
            tasks={tasks}
            taskId={task?.task_id ?? ''}
            gymId={task?.id}
            onTask={(t) => { setTaskId(t); localStorage.setItem(`rd-task:${robot}`, t); setLint({ busy: false, result: null }); }}
            onInsert={readOnly ? undefined : insert}
          />
        )}
      </div>

      {id && usage && <UsagePanel kind="reward_designs" id={id} usage={usage} current={draft.code} render={(s) => (typeof s === 'string' ? s : '')} />}
    </div>
  );
}

function LintLine({ lint, mjlab, task }: { lint: { busy: boolean; result: LintResult | null }; mjlab: boolean; task: string | null | undefined }) {
  const r = lint.result;
  if (lint.busy) return <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner className="h-3 w-3" /> Linting…</p>;
  if (!r) return null;
  if (r.ok) {
    const what = mjlab
      ? [`${r.terms?.length ?? 0} TERMS entr${r.terms?.length === 1 ? 'y' : 'ies'}`, ...(r.funcs ?? []), r.task_checked && task ? `fits ${task}` : 'task not checked']
      : r.funcs ?? [];
    return (
      <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" /> Lint ok{what.length ? ` · ${what.join(', ')}` : ''}
        {r.notes?.length ? <span className="text-muted-foreground"> · {r.notes.join('; ')}</span> : null}
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-rose-500/40 bg-rose-500/8 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
      <p className="flex items-center gap-1.5 font-medium"><XCircle className="h-3.5 w-3.5" /> Lint failed</p>
      <pre className="mt-1 whitespace-pre-wrap font-mono">{r.error || 'unknown error'}</pre>
    </div>
  );
}

/** The task's default reward terms and the term library, each insertable as a TERMS entry. */
function TermReference({ robot, tasks, taskId, gymId, onTask, onInsert }: {
  robot: string;
  tasks: { id: string; task_id: string | null }[];
  taskId: string;
  gymId: string | undefined;
  onTask: (t: string) => void;
  onInsert: ((line: string) => void) | undefined;
}) {
  const [q, setQ] = useState('');
  const defaults = useQuery({ queryKey: ['gym-defaults', gymId], queryFn: () => api.gymDefaults(gymId!), enabled: !!gymId });
  const catalog = useQuery({ queryKey: keys.termCatalog(robot), queryFn: () => api.rewardTermCatalog(robot), staleTime: 5 * 60_000 });
  const needle = q.trim().toLowerCase();
  const terms = (defaults.data ?? []).filter((t) => !needle || `${t.name} ${t.func ?? ''}`.toLowerCase().includes(needle));
  const funcs = (catalog.data ?? []).filter((f) => !needle || `${f.name} ${f.doc ?? ''}`.toLowerCase().includes(needle));
  const row = 'flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left text-xs enabled:cursor-pointer enabled:hover:bg-muted';
  return (
    <Card className="flex max-h-[70vh] min-w-0 flex-col">
      <CardHeader title={<span className="inline-flex items-center gap-1.5"><BookOpen className="h-4 w-4" /> Reward terms</span>} description={onInsert ? 'Click one to add it to TERMS at the cursor.' : undefined} />
      <div className="flex flex-col gap-2 p-4 pb-2">
        <Select value={taskId} onChange={(e) => onTask(e.target.value)} disabled={!tasks.length}>
          {!tasks.length && <option value="">No tasks registered</option>}
          {tasks.map((t) => <option key={t.id} value={t.task_id!}>{t.task_id}</option>)}
        </Select>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter terms…" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <p className="px-1.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Task defaults</p>
        {defaults.isLoading ? <Spinner className="m-2" /> : !terms.length ? <p className="px-1.5 text-xs text-muted-foreground">None.</p> : terms.map((t) => (
          <button key={t.name} disabled={!onInsert} className={row} title={`${t.func ?? ''} ${JSON.stringify(t.params ?? {})}`}
            onClick={() => onInsert?.(`    ${JSON.stringify(t.name)}: {"weight": ${t.weight}},`)}>
            <span className="min-w-0 flex-1 truncate font-mono">{t.name}</span>
            <span className={cn('font-mono tabular-nums', t.weight < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400')}>{t.weight}</span>
          </button>
        ))}
        <p className="px-1.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Library (added with &quot;func&quot;)</p>
        {catalog.isLoading ? <Spinner className="m-2" /> : !funcs.length ? <p className="px-1.5 text-xs text-muted-foreground">None.</p> : funcs.map((f) => {
          const required = (f.params ?? []).filter((p) => p.required).map((p) => p.name);
          const params = required.length
            ? `, "params": {${required.map((p) => `${JSON.stringify(p)}: None`).join(', ')}}},  # fill in ${required.join(', ')}`
            : '},';
          return (
            <button key={f.name} disabled={!onInsert} className={cn(row, 'flex-col items-start gap-0')} title={`${f.doc ?? ''}\n${f.module ?? ''}`}
              onClick={() => onInsert?.(`    ${JSON.stringify(f.name)}: {"func": ${JSON.stringify(f.name)}, "weight": 0.0${params}`)}>
              <span className="font-mono">{f.name}</span>
              {!!f.params?.length && <span className="text-[11px] text-muted-foreground">{f.params.map((p) => (p.required ? p.name : `${p.name}?`)).join(', ')}</span>}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
