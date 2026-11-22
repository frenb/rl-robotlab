// Launch a run: from the robot's defaults, from a recent run, or as a clone (?from=<run id>).
// Every edit is checked by the server (POST /runs?dry_run=1), which owns the rules,
// so errors appear next to the field they are about before anything is queued.
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, CheckCircle2, CopyPlus, Rocket, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { confirmDialog, toast } from '../components/feedback';
import { RobotBadge, StatusBadge, runTitle, typeLabel } from '../components/RunBits';
import { Button, Card, CardHeader, Empty, Field, Input, Select, Spinner, Textarea } from '../components/ui';
import { api, ApiError, keys, type LaunchOptions, type LaunchProblem, type LaunchSpec } from '../lib/api';
import { useRobots, useSelectedRobot } from '../lib/robots';
import { cn, formatNumber, shortId, timeAgo } from '../lib/utils';

export interface LaunchSearch { from?: string; robot?: string }

const CHECK_DEBOUNCE_MS = 400;

const CAR_HINTS: Record<string, string> = {
  TRAIN: 'SAC on the picked course. donut is 32-D (with angle-to-goal); donut_no_hint is 31-D for sim2real. Both reuse the classic expert demos for BC pretrain unless you pick a demo set.',
  DEMO: 'Collects expert TFRecords with the heuristic driver. Episodes are split across the experiment design\u2019s curriculum stages if it has any.',
  EVAL: 'Runs a SavedModel. Each trial reports one mean-of-episodes score; the Analysis tab pools trials.',
  BC_TRAINING_ONLY: 'Flat-MLP behaviour cloning on vector demos. Refused on camera courses.',
};
const MJLAB_HINTS: Record<string, string> = {
  TRAIN: 'PPO on the picked task. A reward design edits its reward terms; the job fails within seconds if the design does not fit the task.',
  EVAL: 'Runs the checkpoint under the task\u2019s training conditions and records falls, return and episode length.',
  EXPORT: 'Writes the checkpoint as ONNX (observation normaliser baked in) and validates it.',
  VIDEO: 'Renders evenly spaced checkpoints of the run that produced this model into one progression video.',
};

function blankSpec(o: LaunchOptions): LaunchSpec {
  const has = (list: { id: string }[], id: string | null) => (id && list.some((x) => x.id === id) ? id : undefined);
  const gymId = has(o.gyms, o.defaults.gym_id);
  const spec: LaunchSpec = {
    robot: o.robot,
    job_type: 'TRAIN',
    gym_id: gymId,
    reward_design_id: has(o.reward_designs, o.defaults.reward_design_id),
    experiment_design_id: has(o.experiment_designs, o.defaults.experiment_design_id),
    video: true,
    progress_video: true,
  };
  if (o.engine === 'car') spec.model_type = 'SacAgent';
  else spec.init_checkpoint = o.gyms.find((g) => g.id === gymId)?.default_init_checkpoint ?? undefined;
  return spec;
}

/** Drops blank values so the spec reads like what will be sent. */
function clean(spec: LaunchSpec): LaunchSpec {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) if (v !== undefined && v !== '' && v !== null) out[k] = v;
  return out as unknown as LaunchSpec;
}

type Source = { kind: 'blank' } | { kind: 'run'; id: string; title: string; clone: boolean };

export function LaunchPage() {
  const search = useSearch({ strict: false }) as LaunchSearch;
  const navigate = useNavigate();
  const { data: robots } = useRobots();
  const [selected] = useSelectedRobot();
  const [robot, setRobot] = useState<string>(search.robot || selected || '');
  const [spec, setSpec] = useState<LaunchSpec | null>(null);
  const [source, setSource] = useState<Source>({ kind: 'blank' });
  const [loadingFrom, setLoadingFrom] = useState(!!search.from);
  /** Bumped whenever a new starting point is loaded, so the form starts over from it. */
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    if (!robot && robots?.length) setRobot(robots[0].id);
  }, [robot, robots]);

  const options = useQuery({
    queryKey: keys.launchOptions(robot),
    queryFn: () => api.launchOptions(robot),
    enabled: !!robot,
    staleTime: 15_000,
  });

  const loadFrom = async (id: string, clone: boolean) => {
    setLoadingFrom(true);
    try {
      const [s, detail] = await Promise.all([api.cloneSpec(id), api.run(id)]);
      if (!clone) {
        // A template keeps the recipe, not the identity of the run it came from.
        delete s.cloned_from;
        delete s.notes;
        if (s.name) s.name = s.name.replace(/ \(copy\)$/, '');
      }
      setRobot(s.robot);
      setSpec(s);
      setSource({ kind: 'run', id, title: runTitle(detail.run), clone });
      setFormKey((k) => k + 1);
    } catch (e) {
      toast('error', `Couldn't load run ${shortId(id)}: ${(e as Error).message}`);
    } finally {
      setLoadingFrom(false);
    }
  };

  useEffect(() => {
    if (search.from) loadFrom(search.from, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.from]);

  useEffect(() => {
    if (!options.data || loadingFrom) return;
    if (!spec || spec.robot !== options.data.robot) {
      setSpec(blankSpec(options.data));
      setSource({ kind: 'blank' });
      setFormKey((k) => k + 1);
    }
  }, [options.data, loadingFrom, spec]);

  const pickRobot = (id: string) => {
    if (id === robot) return;
    setSpec(null);
    setSource({ kind: 'blank' });
    setRobot(id);
    navigate({ to: '/runs/new', search: { robot: id }, replace: true });
  };

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 sm:p-8">
      <div>
        <Link to="/runs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Runs
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Launch a run</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Start from the robot&apos;s defaults, a recent run, or a clone. It joins the shared queue; the oldest queued run starts first.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(robots ?? []).map((r) => (
          <button
            key={r.id}
            onClick={() => pickRobot(r.id)}
            className={cn(
              'h-9 cursor-pointer rounded-lg border px-3 text-sm transition-colors',
              r.id === robot ? 'border-primary bg-card font-medium shadow-sm' : 'bg-card text-muted-foreground hover:text-foreground',
            )}
          >
            {r.display_name}
          </button>
        ))}
      </div>

      {options.error ? (
        <Empty title="Couldn't load launch options">{(options.error as Error).message}</Empty>
      ) : !options.data || !spec || loadingFrom ? (
        <div className="grid place-items-center py-24"><Spinner /></div>
      ) : (
        <LaunchForm
          key={formKey}
          options={options.data}
          initial={spec}
          source={source}
          onTemplate={(id) => loadFrom(id, false)}
          onBlank={() => {
            setSpec(blankSpec(options.data));
            setSource({ kind: 'blank' });
            setFormKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function LaunchForm({ options: o, initial, source, onTemplate, onBlank }: {
  options: LaunchOptions; initial: LaunchSpec; source: Source; onTemplate: (id: string) => void; onBlank: () => void;
}) {
  const navigate = useNavigate();
  const { data: robots } = useRobots();
  const robotInfo = robots?.find((r) => r.id === o.robot);
  const [spec, setSpec] = useState<LaunchSpec>(initial);
  const [check, setCheck] = useState<{ pending: boolean; problem: LaunchProblem | null; doc: Record<string, unknown> | null; warnings: string[] }>(
    { pending: true, problem: null, doc: null, warnings: [] },
  );
  const [submitting, setSubmitting] = useState(false);
  const seq = useRef(0);
  const car = o.engine === 'car';
  const jt = spec.job_type;

  const set = <K extends keyof LaunchSpec>(k: K, v: LaunchSpec[K]) => setSpec((s) => ({ ...s, [k]: v }));
  const bindText = (k: keyof LaunchSpec) => ({
    value: (spec[k] as string | number | undefined | null) ?? '',
    onChange: (e: { target: { value: string } }) => set(k, e.target.value as never),
  });

  useEffect(() => {
    const n = ++seq.current;
    setCheck((c) => ({ ...c, pending: true }));
    const t = window.setTimeout(async () => {
      try {
        const r = await api.checkLaunch(clean(spec));
        if (n === seq.current) setCheck({ pending: false, problem: null, doc: r.doc, warnings: r.warnings });
      } catch (e) {
        if (n !== seq.current) return;
        const body = e instanceof ApiError ? e.body : {};
        setCheck({
          pending: false,
          doc: body.doc ?? null,
          warnings: body.warnings ?? [],
          problem: { errors: body.errors ?? { _: (e as Error).message }, warnings: body.warnings ?? [], confirm: body.confirm ?? null },
        });
      }
    }, CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [spec]);

  const errors = check.problem?.errors ?? {};
  const err = (k: string) => errors[k];
  const otherErrors = Object.entries(errors).filter(([k]) => !FIELD_KEYS.has(k));
  const blocked = Object.keys(errors).length > 0;

  const submit = async () => {
    setSubmitting(true);
    let body = clean(spec);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await api.launch(body);
          toast('success', <>Queued <b>{runTitle(r.run)}</b>{r.run.queue_position ? ` (#${r.run.queue_position} in queue)` : ''}.</>);
          navigate({ to: '/runs/$runId', params: { runId: r.run.id } });
          return;
        } catch (e) {
          const p = e instanceof ApiError ? (e.body as LaunchProblem) : null;
          if (p?.confirm) {
            const ok = await confirmDialog({ title: 'Launch anyway?', message: p.confirm.message, confirmLabel: 'Launch anyway' });
            if (!ok) return;
            body = { ...body, [p.confirm.flag]: true };
            setSpec((s) => ({ ...s, [p.confirm!.flag]: true }));
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      toast('error', `Launch failed: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const ed = o.experiment_designs.find((d) => d.id === spec.experiment_design_id);
  const gym = o.gyms.find((g) => g.id === spec.gym_id);
  const iterLabel = car ? (jt === 'DEMO' ? 'Episodes to collect' : 'Iterations') : (robotInfo?.iter_label || 'Iterations');
  const carryKeys = Object.keys(spec.carry ?? {});
  const modelLabel = (m: LaunchOptions['models'][number]) => [
    m.task_id || m.course_type || 'model',
    m.iteration != null ? `it ${formatNumber(m.iteration, 0)}` : null,
    m.avg_return != null ? `return ${formatNumber(m.avg_return)}` : null,
    m.reward_design_name,
    m.job_id ? `run \u2026${m.job_id.slice(-6)}` : 'imported',
  ].filter(Boolean).join(' \u00b7 ');
  const initKnown = !spec.init_checkpoint || o.models.some((m) => m.location === spec.init_checkpoint);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1fr_340px]">
      <div className="flex min-w-0 flex-col gap-5">
        <StartFrom options={o} source={source} onTemplate={onTemplate} onBlank={onBlank} />

        <Card className="pb-5">
          <CardHeader title="What to run" description={(car ? CAR_HINTS : MJLAB_HINTS)[jt]} />
          <div className="grid gap-4 px-4 pt-4 sm:grid-cols-2">
            <Field label="Job type" error={err('job_type')}>
              <Select value={jt} onChange={(e) => set('job_type', e.target.value)}>
                {o.job_types.map((t) => <option key={t} value={t}>{typeLabel(t)} ({t})</option>)}
              </Select>
            </Field>
            <Field label="Name" hint="Shown in lists; optional." error={err('name')}>
              <Input {...bindText('name')} placeholder={car ? 'e.g. camera AWAC, alpha 0.1' : 'e.g. walk with lean bonus'} />
            </Field>
            {(car || jt === 'TRAIN') && (
              <Field label={car ? 'Gym' : (robotInfo?.course_label || 'Task')} error={err('gym_id')}
                hint={car ? 'The Unity build the clients load. Blank keeps the current one.' : gym?.task_id ?? undefined}>
                <Select
                  value={spec.gym_id ?? ''}
                  onChange={(e) => {
                    const g = o.gyms.find((x) => x.id === e.target.value);
                    setSpec((s) => ({ ...s, gym_id: e.target.value || undefined, ...(car ? {} : { init_checkpoint: g?.default_init_checkpoint ?? undefined }) }));
                  }}
                >
                  <option value="">{car ? 'Current gym' : 'Pick a task'}</option>
                  {o.gyms.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  {spec.gym_id && !gym && <option value={spec.gym_id}>{spec.gym_id} (archived or missing)</option>}
                </Select>
              </Field>
            )}
            {car && (
              <Field label="Course" error={err('course_type')} hint="The observation the policy gets.">
                <Select value={spec.course_type ?? ''} onChange={(e) => set('course_type', e.target.value)}>
                  {o.courses.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </Select>
              </Field>
            )}
            {!car && jt !== 'TRAIN' && (
              <Field label="Model" error={err('model_id')} className="sm:col-span-2"
                hint={jt === 'VIDEO' ? 'Renders the checkpoints of the run that produced it.' : undefined}>
                <Select value={spec.model_id ?? ''} onChange={(e) => set('model_id', e.target.value)}>
                  <option value="">Pick a model</option>
                  {o.models.map((m) => <option key={m.id} value={m.id} title={m.location ?? ''}>{modelLabel(m)}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Notes" className="sm:col-span-2" error={err('notes')}>
              <Textarea {...bindText('notes')} rows={2} placeholder="Why this run, what changed" />
            </Field>
          </div>
        </Card>

        {(car || jt === 'TRAIN') && (
          <Card className="pb-5">
            <CardHeader title="Designs" description="Reward terms and training hyperparameters. Blank uses the task or trainer defaults." />
            <div className="grid gap-4 px-4 pt-4 sm:grid-cols-2">
              <Field label="Reward design" error={err('reward_design_id')}>
                <Select value={spec.reward_design_id ?? ''} onChange={(e) => set('reward_design_id', e.target.value || undefined)}>
                  <option value="">{car ? 'Course default (no design)' : 'Task default (no design)'}</option>
                  {o.reward_designs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.version ? ` (v${d.version})` : ''}</option>)}
                </Select>
              </Field>
              <Field label="Experiment design" error={err('experiment_design_id')}
                hint={ed?.demo_features.length ? `Uses ${ed.demo_features.join(', ').replace(/_/g, ' ')}.` : undefined}>
                <Select value={spec.experiment_design_id ?? ''} onChange={(e) => set('experiment_design_id', e.target.value || undefined)}>
                  <option value="">{car ? 'Trainer defaults (no design)' : 'Task defaults (no design)'}</option>
                  {o.experiment_designs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.version ? ` (v${d.version})` : ''}</option>)}
                </Select>
              </Field>
              {car && (jt === 'TRAIN' || jt === 'BC_TRAINING_ONLY') && (
                <Field label="Expert demos" error={err('demo_id')} className="sm:col-span-2"
                  hint="Replaces the course-default demo set for prefill and BC.">
                  <Select value={spec.demo_id ?? ''} onChange={(e) => set('demo_id', e.target.value || undefined)}>
                    <option value="">Course default demos</option>
                    {o.demos.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </Select>
                </Field>
              )}
              {!car && (
                <Field label="Warm start from" error={err('init_checkpoint')} className="sm:col-span-2"
                  hint="Starts from another run's checkpoint with the full iteration budget. Same task family only.">
                  <Select value={spec.init_checkpoint ?? ''} onChange={(e) => set('init_checkpoint', e.target.value || undefined)}>
                    <option value="">Nothing (train from scratch)</option>
                    {!initKnown && <option value={spec.init_checkpoint}>{spec.init_checkpoint}</option>}
                    {o.models.filter((m) => m.location).map((m) => <option key={m.id} value={m.location!}>{modelLabel(m)}</option>)}
                  </Select>
                </Field>
              )}
            </div>
          </Card>
        )}

        <Card className="pb-5">
          <CardHeader title="Budget & settings" description="Blank fields use the worker's defaults." />
          <div className="grid gap-4 px-4 pt-4 sm:grid-cols-3">
            {(car || jt === 'TRAIN') && (
              <Field label={iterLabel} error={err('budget')}>
                <Input type="number" min={1} {...bindText('budget')} placeholder={car ? '50000' : '1000'} />
              </Field>
            )}
            {!car && jt === 'TRAIN' && (
              <>
                <Field label="Robots in parallel" error={err('num_envs')}>
                  <Input type="number" min={1} {...bindText('num_envs')} placeholder="2048" />
                </Field>
                <Field label="Checkpoint every" hint="Iterations; also the most a pause can lose." error={err('save_interval')}>
                  <Input type="number" min={1} {...bindText('save_interval')} placeholder="50" />
                </Field>
              </>
            )}
            {!car && jt === 'EVAL' && (
              <>
                <Field label="Robots in parallel" error={err('eval_num_envs')}>
                  <Input type="number" min={1} {...bindText('eval_num_envs')} placeholder="512" />
                </Field>
                <Field label="Steps" hint="At 50 Hz; 1000 = 20 s per robot." error={err('eval_steps')}>
                  <Input type="number" min={1} {...bindText('eval_steps')} placeholder="1000" />
                </Field>
              </>
            )}
            {car && (jt === 'DEMO' || jt === 'BC_TRAINING_ONLY') && (
              <Field label="BC training steps" hint="Run on the demos after collection." error={err('training_steps')}>
                <Input type="number" min={0} {...bindText('training_steps')} placeholder="20000" />
              </Field>
            )}
            {car && jt === 'DEMO' && (
              <Field label="Demo transitions" hint="Stop at the first episode end after this many steps." error={err('demo_step_budget')}>
                <Input type="number" min={1} {...bindText('demo_step_budget')} placeholder="no limit" />
              </Field>
            )}
            {car && jt === 'BC_TRAINING_ONLY' && (
              <Field label="Demo job id" error={err('demo_job_id')}>
                <Input {...bindText('demo_job_id')} placeholder="DEMO job whose TFRecords to use" />
              </Field>
            )}
            {(car || jt === 'TRAIN') && (
              <Field label="Seed" error={err('seed')}>
                <Input type="number" {...bindText('seed')} placeholder="default" />
              </Field>
            )}
            {car && (
              <>
                <Field label="Model type" error={err('model_type')}>
                  <Select value={spec.model_type ?? 'SacAgent'} onChange={(e) => set('model_type', e.target.value)}>
                    {o.model_types.map((m) => <option key={m} value={m}>{m}</option>)}
                  </Select>
                </Field>
                <Field label="Corner radius" error={err('corner_radius_val')} hint="Track geometry; blank = 10.">
                  <Input type="number" step="any" {...bindText('corner_radius_val')} placeholder="10" />
                </Field>
                <Field label="Curvature difficulty" error={err('curvature_difficulty_val')} hint="Blank = 0.">
                  <Input type="number" step="any" {...bindText('curvature_difficulty_val')} placeholder="0" />
                </Field>
              </>
            )}
          </div>
          {(jt === 'TRAIN') && (
            <div className="flex flex-wrap gap-x-6 gap-y-2 px-4 pt-4 text-sm">
              {car && (
                <Check checked={!!spec.skip_first_eval} onChange={(v) => set('skip_first_eval', v)}
                  label="Skip the two startup evals" title="Go straight to training; periodic evals still run." />
              )}
              <Check checked={spec.video !== false} onChange={(v) => set('video', v)}
                label={car ? 'Clip of each eval' : 'Clip of each checkpoint'} />
              <Check checked={spec.progress_video !== false} onChange={(v) => set('progress_video', v)} label="Progression video at the end" />
            </div>
          )}
        </Card>

        {car && jt === 'EVAL' && (
          <Card className="pb-5">
            <CardHeader title="Evaluation" description="Same controls as the Models tab's Eval dialog." />
            <div className="grid gap-4 px-4 pt-4 sm:grid-cols-3">
              <Field label="Model location" className="sm:col-span-3" error={err('location')}
                hint={spec.model_type === 'FlyPyPolicy' ? 'Leave empty: a FlyPyPolicy eval builds its policy from the connectome.' : 'A SavedModel directory; pick one or paste a path.'}>
                <Input list="car-models" {...bindText('location')} placeholder="/saved_models/robotaxi/SacAgent/…" />
                <datalist id="car-models">
                  {o.models.filter((m) => m.location).map((m) => <option key={m.id} value={m.location!}>{modelLabel(m)}</option>)}
                </datalist>
              </Field>
              <Field label="Trials" hint="3 smoke, 10 standard, 30 tight CI." error={err('num_trials')}>
                <Input type="number" min={1} max={100} {...bindText('num_trials')} placeholder="3" />
              </Field>
              <Field label="Episodes per trial" error={err('num_eval_episodes')}>
                <Input type="number" min={1} {...bindText('num_eval_episodes')} placeholder="5" />
              </Field>
              <div />
              {ed && ed.stages > 0 && (
                <>
                  <Field label="Sweep from stage" error={err('eval_stage_start')} hint={`${ed.stages} curriculum stages in the design.`}>
                    <Select value={spec.eval_stage_start ?? ''} onChange={(e) => set('eval_stage_start', e.target.value === '' ? undefined : Number(e.target.value))}>
                      <option value="">No sweep</option>
                      {Array.from({ length: ed.stages }, (_, i) => <option key={i} value={i}>Stage {i}</option>)}
                    </Select>
                  </Field>
                  <Field label="to stage" error={err('eval_stage_end')}>
                    <Select value={spec.eval_stage_end ?? ''} onChange={(e) => set('eval_stage_end', e.target.value === '' ? undefined : Number(e.target.value))}>
                      <option value="">No sweep</option>
                      {Array.from({ length: ed.stages }, (_, i) => <option key={i} value={i}>Stage {i}</option>)}
                    </Select>
                  </Field>
                </>
              )}
            </div>
          </Card>
        )}

        {carryKeys.length > 0 && (
          <Card className="pb-4">
            <CardHeader title="Carried over" description="Worker settings from the source run that this form has no control for. Remove any you don't want." />
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {carryKeys.map((k) => (
                <span key={k} className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-1 font-mono text-xs"
                  title={JSON.stringify(spec.carry![k], null, 1)}>
                  {k}
                  <button
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={() => setSpec((s) => {
                      const carry = { ...s.carry };
                      delete carry[k];
                      return { ...s, carry: Object.keys(carry).length ? carry : undefined };
                    })}
                    title="Don't carry this over"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </Card>
        )}
      </div>

      <div className="flex flex-col gap-4 lg:sticky lg:top-6">
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <RobotBadge robot={o.robot} />
            <span className="text-sm font-medium">{typeLabel(jt)}</span>
          </div>
          <div className="mt-3 min-h-10 text-sm">
            {check.pending ? (
              <span className="flex items-center gap-2 text-muted-foreground"><Spinner /> Checking…</span>
            ) : blocked ? (
              <div className="flex flex-col gap-1 text-rose-600 dark:text-rose-400">
                <span className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-4 w-4" /> Fix {Object.keys(errors).length} field{Object.keys(errors).length === 1 ? '' : 's'}</span>
                {otherErrors.map(([k, v]) => <span key={k} className="text-xs">{v}</span>)}
              </div>
            ) : check.problem?.confirm ? (
              <span className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {check.problem.confirm.message}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4" /> Ready to launch</span>
            )}
            {check.warnings.map((w) => (
              <p key={w} className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
              </p>
            ))}
          </div>
          <Button variant="primary" className="mt-4 w-full" disabled={submitting || check.pending || blocked} onClick={submit}>
            {submitting ? <Spinner className="border-t-primary-foreground" /> : <Rocket className="h-4 w-4" />} Launch
          </Button>
        </Card>
        {check.doc && (
          <Card className="overflow-hidden">
            <details>
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Job document</summary>
              <pre className="max-h-96 overflow-auto border-t bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                {JSON.stringify(check.doc, null, 2)}
              </pre>
            </details>
          </Card>
        )}
      </div>
    </div>
  );
}

/** Spec fields that have their own control; any other error is listed by the Launch button. */
const FIELD_KEYS = new Set([
  'job_type', 'name', 'notes', 'gym_id', 'course_type', 'model_id', 'reward_design_id', 'experiment_design_id', 'demo_id',
  'init_checkpoint', 'budget', 'num_envs', 'save_interval', 'eval_num_envs', 'eval_steps', 'training_steps',
  'demo_step_budget', 'demo_job_id', 'seed', 'model_type', 'corner_radius_val', 'curvature_difficulty_val', 'location',
  'num_trials', 'num_eval_episodes', 'eval_stage_start', 'eval_stage_end',
]);

function Check({ checked, onChange, label, title }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; title?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2" title={title}>
      <input type="checkbox" className="h-4 w-4 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function StartFrom({ options: o, source, onTemplate, onBlank }: {
  options: LaunchOptions; source: Source; onTemplate: (id: string) => void; onBlank: () => void;
}) {
  const recent = useMemo(() => o.recent.slice(0, 6), [o.recent]);
  return (
    <Card className="pb-4">
      <CardHeader
        title="Start from"
        description={source.kind === 'run'
          ? <>{source.clone ? 'Cloned from' : 'Settings copied from'} <Link to="/runs/$runId" params={{ runId: source.id }} className="underline">{source.title}</Link>{' '}<span className="font-mono">{shortId(source.id)}</span></>
          : 'The robot\u2019s default task and designs. Or copy the settings of a recent run.'}
      />
      <div className="grid gap-2 px-4 pt-3 sm:grid-cols-2 xl:grid-cols-3">
        <button
          onClick={onBlank}
          className={cn(
            'flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/50',
            source.kind === 'blank' && 'border-primary ring-1 ring-primary',
          )}
        >
          <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">Defaults</span>
        </button>
        {recent.map((r) => (
          <button
            key={r.id}
            onClick={() => onTemplate(r.id)}
            className={cn(
              'flex min-w-0 cursor-pointer flex-col gap-1 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50',
              source.kind === 'run' && source.id === r.id && 'border-primary ring-1 ring-primary',
            )}
            title={`Copy the settings of ${runTitle(r)}`}
          >
            <span className="flex items-center gap-1.5 truncate text-sm font-medium">
              <CopyPlus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{r.curriculum_stage_name || runTitle(r)}</span>
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {r.curriculum_stage_name ? r.curriculum_name : (r.gym_name || r.task_id)} · <span className="font-mono">{shortId(r.id)}</span>
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <StatusBadge status={r.status} />
              {r.mean_reward != null && <span className="tabular-nums">reward {formatNumber(r.mean_reward)}</span>}
              <span>{timeAgo(r.created_at)}</span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}
