import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Plus, Trash2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { CurriculumCaps, GateCondition, LaunchOptions, Stage } from '../../lib/api';
import { cn, formatNumber, shortId } from '../../lib/utils';
import { Badge, Button, Field, Input, Select } from '../ui';
import { conditionText } from './CurriculumBits';

/** Keys a stage takes from the one before when it leaves them out (model.py INHERITED). */
const INHERITED = ['gym', 'reward_design_id', 'experiment_design_id', 'budget'] as const;
type InheritedKey = (typeof INHERITED)[number];
const INHERIT = '__inherit';
const TASK_DEFAULT = '__default';
const OPS = ['>=', '>', '<=', '<', '=='];

/** What stage i gets for an inherited key: its own value, or the nearest earlier stage's. */
export function inheritedValue(stages: Stage[], i: number, key: InheritedKey): unknown {
  for (let j = i; j >= 0; j--) if (key in stages[j]) return stages[j][key];
  return undefined;
}

/** Settings stage i trains with: every earlier stage's settings merged, its own last. */
export function mergedSettings(stages: Stage[], i: number): Record<string, number> {
  let out: Record<string, number> = {};
  for (let j = 0; j <= i; j++) out = { ...out, ...(stages[j].settings ?? {}) };
  return out;
}

export function effectiveInit(stage: Stage, i: number): string {
  return stage.init || (i === 0 ? 'none' : 'previous');
}

function without<T extends object>(obj: T, key: string): T {
  const out = { ...obj } as Record<string, unknown>;
  delete out[key];
  return out as T;
}

const num = (s: string): number | undefined => (s.trim() === '' || !isFinite(Number(s)) ? undefined : Number(s));

function budgetUnit(caps: CurriculumCaps) {
  return caps.budget_field === 'max_iterations' ? 'iterations' : caps.budget_field === 'num_iterations' ? 'steps' : caps.budget_field ?? 'budget';
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function stageSummary(stage: Stage, i: number, stages: Stage[], options: LaunchOptions | undefined, caps: CurriculumCaps): string {
  const gymId = inheritedValue(stages, i, 'gym') as string | undefined;
  const gym = options?.gyms.find((g) => g.id === gymId);
  const budget = inheritedValue(stages, i, 'budget') as number | undefined;
  const parts = [gym?.task_id || gym?.name || gymId || 'no gym', budget ? `${formatNumber(budget)} ${budgetUnit(caps)}` : 'no budget'];
  const init = effectiveInit(stage, i);
  parts.push(init === 'none' ? 'from scratch' : init === 'previous' ? 'from previous stage' : `from model ${shortId(init.slice(6))}`);
  const conds = stage.gate?.conditions ?? [];
  parts.push(conds.length ? `gate ${conds.map(conditionText).join(', ')}` : 'no gate');
  return parts.join(' · ');
}

export function StageEditor({
  stage, index, stages, caps, options, resolved, problems, readOnly, onChange, onMove, onRemove, onDuplicate,
}: {
  stage: Stage;
  index: number;
  stages: Stage[];
  caps: CurriculumCaps;
  options: LaunchOptions | undefined;
  /** The validator's view of this stage (inheritance and default carry applied), when the last check passed. */
  resolved: Stage | undefined;
  problems: string[];
  readOnly: boolean;
  onChange: (stage: Stage) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const [open, setOpen] = useState(true);
  const first = index === 0;
  const set = (key: string, value: unknown) => onChange(value === undefined ? without(stage, key) : { ...stage, [key]: value });
  const prevValue = (key: InheritedKey) => (first ? undefined : inheritedValue(stages, index - 1, key));
  const nameOf = (list: { id: string; name: string }[] | undefined, id: unknown) =>
    id == null ? 'task default' : list?.find((x) => x.id === id)?.name ?? String(id);

  const gymValue = 'gym' in stage ? String(stage.gym ?? '') : first ? '' : INHERIT;
  const designValue = (key: 'reward_design_id' | 'experiment_design_id') =>
    !(key in stage) ? (first ? TASK_DEFAULT : INHERIT) : stage[key] == null ? TASK_DEFAULT : String(stage[key]);
  const setDesign = (key: 'reward_design_id' | 'experiment_design_id', v: string) =>
    set(key, v === INHERIT ? undefined : v === TASK_DEFAULT ? (first ? undefined : null) : v);

  const init = effectiveInit(stage, index);
  const initKind = init === 'none' || init === 'previous' ? init : 'model';
  const settingsSpec = caps.stage_settings ?? {};
  const before = first ? {} : mergedSettings(stages, index - 1);
  const gate = stage.gate && stage.gate.conditions ? stage.gate : null;
  const setGate = (conditions: GateCondition[] | null) =>
    set('gate', conditions === null ? undefined : { ...(gate ?? {}), conditions });
  const resolvedCarry = resolved?.carry;
  const metricOptions = caps.gate_metrics;

  return (
    <div className={cn('rounded-xl border bg-card shadow-sm', problems.length && 'border-rose-500/50')}>
      <div className="flex items-center gap-2 px-4 py-3">
        <button className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">{index + 1}</span>
          <span className="truncate text-sm font-semibold">{stage.name || `Stage ${index + 1}`}</span>
          {!open && <span className="truncate text-xs text-muted-foreground">{stageSummary(stage, index, stages, options, caps)}</span>}
        </button>
        {problems.length > 0 && <Badge tone="red">{problems.length} to fix</Badge>}
        {!readOnly && (
          <div className="flex shrink-0 items-center">
            <Button size="icon" variant="ghost" disabled={first} onClick={() => onMove(-1)} title="Move up"><ArrowUp className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" disabled={index === stages.length - 1} onClick={() => onMove(1)} title="Move down"><ArrowDown className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" onClick={onDuplicate} title="Duplicate stage"><Copy className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" disabled={stages.length === 1} onClick={onRemove} title="Remove stage"><Trash2 className="h-4 w-4" /></Button>
          </div>
        )}
      </div>

      {open && (
        <fieldset disabled={readOnly} className="flex flex-col gap-4 px-4 pb-4">
          {problems.length > 0 && (
            <ul className="list-disc rounded-lg bg-rose-500/8 py-2 pl-8 pr-3 text-xs text-rose-700 dark:text-rose-300">
              {problems.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          )}
          <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr_0.8fr]">
            <Field label="Name">
              <Input value={stage.name ?? ''} onChange={(e) => set('name', e.target.value || undefined)} placeholder={`Stage ${index + 1}`} maxLength={80} />
            </Field>
            <Field label="Gym" hint={first ? undefined : 'Leave on "Same as previous" to keep training the same task.'}>
              <Select value={gymValue} onChange={(e) => set('gym', e.target.value === INHERIT ? undefined : e.target.value || undefined)}>
                {first ? <option value="">Pick a gym…</option> : <option value={INHERIT}>Same as previous ({nameOf(options?.gyms, prevValue('gym'))})</option>}
                {options?.gyms.map((g) => <option key={g.id} value={g.id}>{g.name}{g.task_id && g.task_id !== g.name ? ` (${g.task_id})` : ''}</option>)}
                {gymValue && gymValue !== INHERIT && !options?.gyms.some((g) => g.id === gymValue) && <option value={gymValue}>{gymValue} (archived or missing)</option>}
              </Select>
            </Field>
            <Field label={`Budget (${budgetUnit(caps)})`} hint={caps.early_stop ? 'A ceiling: the stage stops once its gate passes.' : 'Trains this long, then the gate is checked.'}>
              <Input
                type="number"
                min={1}
                step={1}
                value={stage.budget ?? ''}
                placeholder={prevValue('budget') != null ? `same as previous: ${prevValue('budget')}` : 'e.g. 1000'}
                onChange={(e) => set('budget', num(e.target.value))}
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(['reward_design_id', 'experiment_design_id'] as const).map((key) => {
              const list = key === 'reward_design_id' ? options?.reward_designs : options?.experiment_designs;
              const v = designValue(key);
              return (
                <Field key={key} label={key === 'reward_design_id' ? 'Reward design' : 'Experiment design'}>
                  <Select value={v} onChange={(e) => setDesign(key, e.target.value)}>
                    {!first && <option value={INHERIT}>Same as previous ({nameOf(list, prevValue(key))})</option>}
                    <option value={TASK_DEFAULT}>Task default</option>
                    {list?.map((d) => <option key={d.id} value={d.id}>{d.name}{d.version ? ` · v${d.version}` : ''}</option>)}
                    {v !== INHERIT && v !== TASK_DEFAULT && !list?.some((d) => d.id === v) && <option value={v}>{v} (archived or missing)</option>}
                  </Select>
                </Field>
              );
            })}
          </div>

          <Section title="Starting point" hint="Which checkpoint this stage starts from, and what training state comes with it.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Starts from">
                <div className="flex gap-2">
                  <Select
                    className="flex-1"
                    value={initKind}
                    onChange={(e) => {
                      const k = e.target.value;
                      const next = { ...stage, init: k === 'model' ? `model:${options?.models[0]?.id ?? ''}` : k };
                      onChange(k === 'none' ? without(next, 'carry') : next);
                    }}
                  >
                    <option value="none">Scratch (new network)</option>
                    {!first && <option value="previous">The previous stage's checkpoint</option>}
                    <option value="model">A saved model</option>
                  </Select>
                </div>
              </Field>
              {initKind === 'model' && (
                <Field label="Model">
                  <Select value={init.slice(6)} onChange={(e) => set('init', `model:${e.target.value}`)}>
                    {!options?.models.length && <option value="">No models for this robot</option>}
                    {options?.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {(m.location ?? m.id).split('/').slice(-2).join('/')}{m.task_id ? ` · ${m.task_id}` : ''}{m.iteration != null ? ` · it ${formatNumber(m.iteration)}` : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            <CarryField stage={stage} init={init} caps={caps} resolvedCarry={resolvedCarry} onChange={(carry) => set('carry', carry)} />
          </Section>

          {Object.keys(settingsSpec).length > 0 && (
            <Section title="Stage settings" hint="Empty keeps the value from earlier stages (or the task's own when no stage set it).">
              <div className="grid gap-3 sm:grid-cols-3">
                {Object.entries(settingsSpec).map(([key, spec]) => (
                  <Field
                    key={key}
                    label={<span className="font-mono">{key}{spec.unit ? <span className="font-sans text-muted-foreground/80"> ({spec.unit})</span> : null}</span>}
                    hint={`${spec.doc ?? ''}${spec.min != null || spec.max != null ? ` [${spec.min ?? '−∞'}, ${spec.max ?? '∞'}]` : ''}`}
                  >
                    <Input
                      type="number"
                      step={spec.integer ? 1 : 'any'}
                      min={spec.min}
                      max={spec.max}
                      value={stage.settings?.[key] ?? ''}
                      placeholder={before[key] != null ? `from earlier: ${before[key]}` : 'task default'}
                      onChange={(e) => {
                        const v = num(e.target.value);
                        const next = { ...(stage.settings ?? {}) };
                        if (v === undefined) delete next[key];
                        else next[key] = v;
                        set('settings', Object.keys(next).length ? next : undefined);
                      }}
                    />
                  </Field>
                ))}
              </div>
            </Section>
          )}

          <Section
            title="Gate"
            hint={gate
              ? `An eval of the stage's checkpoint must meet every condition to move on${caps.early_stop ? '' : '; it runs once training finishes'}.`
              : index === stages.length - 1 ? 'No gate: the last stage trains to its budget and the run passes.' : 'No gate: the stage always passes after training to its budget.'}
          >
            {gate ? (
              <div className="flex flex-col gap-2">
                {gate.conditions.map((c, ci) => {
                  const setCond = (patch: Partial<GateCondition>) =>
                    setGate(gate.conditions.map((x, xi) => (xi === ci ? { ...x, ...patch } : x)));
                  return (
                    <div key={ci} className="flex flex-wrap items-center gap-2">
                      {metricOptions.length ? (
                        <Select value={c.metric} onChange={(e) => setCond({ metric: e.target.value })} className="w-64 font-mono text-xs">
                          {!metricOptions.includes(c.metric) && <option value={c.metric}>{c.metric || 'Pick a metric…'}</option>}
                          {metricOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                        </Select>
                      ) : (
                        <Input value={c.metric} onChange={(e) => setCond({ metric: e.target.value })} placeholder="metric" className="w-64 font-mono text-xs" />
                      )}
                      <Select value={c.op} onChange={(e) => setCond({ op: e.target.value })} className="w-20">
                        {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                      </Select>
                      <Input
                        type="number"
                        step="any"
                        value={Number.isFinite(c.value) ? c.value : ''}
                        onChange={(e) => setCond({ value: e.target.value === '' ? NaN : Number(e.target.value) })}
                        className="w-28"
                      />
                      <Button size="icon" variant="ghost" onClick={() => setGate(gate.conditions.length > 1 ? gate.conditions.filter((_, xi) => xi !== ci) : null)} title="Remove condition">
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setGate([...gate.conditions, { metric: metricOptions[0] ?? '', op: '>=', value: 0 }])}>
                    <Plus className="h-3.5 w-3.5" /> Condition
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onChange(without(without(stage, 'gate'), 'on_fail'))}>Remove gate</Button>
                </div>
                <div className="mt-1 grid gap-3 sm:grid-cols-3">
                  {caps.early_stop && (
                    <Field label="Evaluations in a row" hint="How many consecutive evals must pass.">
                      <Input type="number" min={1} step={1} value={gate.consecutive ?? ''} placeholder="1"
                        onChange={(e) => set('gate', { ...gate, consecutive: num(e.target.value) })} />
                    </Field>
                  )}
                  <Field label="Retries" hint="Extra attempts, each continuing from the missed one.">
                    <Input type="number" min={0} max={10} step={1} value={stage.on_fail?.retries ?? ''} placeholder="0"
                      onChange={(e) => {
                        const next = { ...(stage.on_fail ?? {}), retries: num(e.target.value) };
                        if (next.retries === undefined) delete next.retries;
                        set('on_fail', Object.keys(next).length ? next : undefined);
                      }} />
                  </Field>
                  <Field label={`Budget per retry (${budgetUnit(caps)})`}>
                    <Input type="number" min={1} step={1} value={stage.on_fail?.extra_budget ?? ''}
                      placeholder={`stage budget: ${inheritedValue(stages, index, 'budget') ?? '?'}`}
                      disabled={!stage.on_fail?.retries}
                      onChange={(e) => {
                        const next = { ...(stage.on_fail ?? {}), extra_budget: num(e.target.value) };
                        if (next.extra_budget === undefined) delete next.extra_budget;
                        set('on_fail', Object.keys(next).length ? next : undefined);
                      }} />
                  </Field>
                  <Field label="Fallen starts in the gate eval" hint="Share of eval episodes that begin fallen over (0-1); blank uses the task's.">
                    <Input type="number" min={0} max={1} step={0.05} value={stage.eval?.fallen_probability ?? ''} placeholder="task default"
                      onChange={(e) => {
                        const v = num(e.target.value);
                        set('eval', v === undefined ? undefined : { ...(stage.eval ?? {}), fallen_probability: v });
                      }} />
                  </Field>
                </div>
              </div>
            ) : (
              <div>
                <Button size="sm" onClick={() => setGate([{ metric: metricOptions[0] ?? '', op: '>=', value: 0 }])}>
                  <Plus className="h-3.5 w-3.5" /> Add a gate
                </Button>
              </div>
            )}
          </Section>
        </fieldset>
      )}
    </div>
  );
}

function CarryField({ stage, init, caps, resolvedCarry, onChange }: {
  stage: Stage; init: string; caps: CurriculumCaps; resolvedCarry: string[] | undefined; onChange: (carry: string[] | undefined) => void;
}) {
  const supported = caps.carry;
  const explicit = Array.isArray(stage.carry);
  if (init === 'none') {
    return <p className="text-xs text-muted-foreground">Nothing carries over: the stage trains a new network.</p>;
  }
  if (!supported.length) {
    return <p className="text-xs text-amber-700 dark:text-amber-300">This robot's trainer can't restore training state yet, so the stage starts from scratch.</p>;
  }
  const resolvedText = resolvedCarry ? (resolvedCarry.length ? resolvedCarry.join(', ') : 'nothing (starts from scratch)') : null;
  if (caps.carry_atomic) {
    const value = !explicit ? 'default' : stage.carry!.length ? 'all' : 'none';
    return (
      <Field
        label="Training state carried over"
        hint={<>This robot restores {supported.join(', ')} together, so it's all or nothing.{resolvedText && value === 'default' ? ` Default here: ${resolvedText}.` : ''}</>}
      >
        <Select value={value} onChange={(e) => onChange(e.target.value === 'default' ? undefined : e.target.value === 'all' ? [...supported] : [])}>
          <option value="default">Default</option>
          <option value="all">All of it ({supported.join(', ')})</option>
          <option value="none">Nothing (starts from scratch)</option>
        </Select>
      </Field>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">Training state carried over</span>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={!explicit} onChange={(e) => onChange(e.target.checked ? undefined : [...(resolvedCarry ?? [])])} />
          Default{resolvedText && !explicit ? ` (${resolvedText})` : ''}
        </label>
        {explicit && supported.map((item) => (
          <label key={item} className="flex cursor-pointer items-center gap-1.5 font-mono text-xs">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={stage.carry!.includes(item)}
              onChange={(e) => onChange(e.target.checked ? supported.filter((x) => x === item || stage.carry!.includes(x)) : stage.carry!.filter((x) => x !== item))}
            />
            {item}
          </label>
        ))}
      </div>
      {explicit && supported.includes('replay') && (
        <span className="text-xs text-muted-foreground/80">replay needs the previous stage's checkpoint, the same gym and the same reward design.</span>
      )}
    </div>
  );
}
