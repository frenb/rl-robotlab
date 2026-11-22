import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, keys, type LaunchProblem, type LaunchSpec, type ModelSummary } from '../../lib/api';
import { isMjlab, robotName, useRobots } from '../../lib/robots';
import { cn, formatDuration } from '../../lib/utils';
import { toast } from '../feedback';
import { Modal } from '../Modal';
import { Button, Field, Input, Select, Spinner } from '../ui';
import { modelTitle } from './ModelBits';

const TRIAL_PRESETS = [
  { n: 3, hint: 'smoke test' },
  { n: 10, hint: 'standard' },
  { n: 30, hint: 'tight CI' },
  { n: 50, hint: 'publication' },
];
const DEFAULT_EPISODES = 5;
/** Seconds per car eval episode, low and high (components.js evalCostEstimate). */
const EPISODE_SECONDS: [number, number] = [2, 6];

interface Problem { model: ModelSummary; message: string }

/** Queues one EVAL per model; every model must belong to the same robot. */
export function EvalDialog({ models, onClose, onQueued }: { models: ModelSummary[]; onClose: () => void; onQueued?: () => void }) {
  const qc = useQueryClient();
  const { data: robots } = useRobots();
  const robot = models[0].robot;
  const mjlab = isMjlab(robots, robot);
  const { data: opts } = useQuery({ queryKey: keys.launchOptions(robot), queryFn: () => api.launchOptions(robot), enabled: !mjlab });

  const [trials, setTrials] = useState('10');
  const [episodes, setEpisodes] = useState('');
  const [course, setCourse] = useState('');
  const [modelType, setModelType] = useState('');
  const [gym, setGym] = useState('');
  const [reward, setReward] = useState('');
  const [experiment, setExperiment] = useState('');
  const [sweep, setSweep] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [envs, setEnvs] = useState('');
  const [steps, setSteps] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [launched, setLaunched] = useState(false);

  const designStages = (id: string | null | undefined) => opts?.experiment_designs.find((d) => d.id === id)?.stages ?? 0;
  const stages = experiment ? designStages(experiment) : Math.max(0, ...models.map((m) => designStages(m.experiment_design?.id)));

  const spec = (m: ModelSummary): LaunchSpec => mjlab
    ? { robot, job_type: 'EVAL', model_id: m.id, eval_num_envs: envs || undefined, eval_steps: steps || undefined }
    : {
      robot, job_type: 'EVAL', model_id: m.id, num_trials: trials, num_eval_episodes: episodes || undefined,
      course_type: course || undefined, model_type: modelType || undefined, gym_id: gym || undefined,
      reward_design_id: reward || undefined, experiment_design_id: experiment || undefined,
      eval_all_stages: sweep && stages > 0 ? true : undefined,
      eval_stage_start: sweep && start !== '' ? start : undefined,
      eval_stage_end: sweep && end !== '' ? end : undefined,
    };

  const submit = async () => {
    setBusy(true);
    setProblems([]);
    setLaunched(false);
    try {
      const checks = await Promise.all(models.map((m) => api.checkLaunch(spec(m)).then(() => null, (e: Error) => {
        const body = e instanceof ApiError ? (e.body as LaunchProblem) : null;
        const fields = body?.errors ? Object.values(body.errors) : [];
        return { model: m, message: fields.length ? fields.join(' ') : body?.confirm?.message ?? e.message };
      })));
      const bad = checks.filter((p): p is Problem => p !== null);
      if (bad.length) {
        setProblems(bad);
        return;
      }
      const results = await Promise.all(models.map((m) => api.launch(spec(m)).then(() => null, (e: Error) => ({ model: m, message: e.message }))));
      const failed = results.filter((p): p is Problem => p !== null);
      qc.invalidateQueries({ queryKey: keys.allRuns });
      qc.invalidateQueries({ queryKey: keys.allModel });
      if (failed.length) {
        setLaunched(true);
        setProblems(failed);
        toast('error', `${failed.length} of ${models.length} evals not queued.`);
        return;
      }
      const n = models.length;
      toast('success', mjlab
        ? `${n} eval${n === 1 ? '' : 's'} queued. Results land on the model when the job finishes.`
        : `${n} eval${n === 1 ? '' : 's'} queued, ${trials} trial${trials === '1' ? '' : 's'} each${sweep ? ' per curriculum stage' : ''}.`);
      onQueued?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const nTrials = Math.max(1, Number(trials) || 0);
  const nStages = sweep && stages ? (Number(end === '' ? stages - 1 : end) - Number(start === '' ? 0 : start) + 1) : 1;
  const totalEpisodes = models.length * nTrials * (Number(episodes) || DEFAULT_EPISODES) * Math.max(1, nStages);

  return (
    <Modal
      title={`Evaluate ${models.length === 1 ? modelTitle(models[0]) : `${models.length} ${robotName(robots, robot)} models`}`}
      description={mjlab
        ? 'Runs each checkpoint on its own task under training conditions and records falls, return and episode length.'
        : 'One EVAL job per model. Course, model type and designs follow each model unless you override them.'}
      onClose={onClose}
      footer={(
        <>
          {!mjlab && (
            <span className="mr-auto text-xs text-muted-foreground">
              {totalEpisodes.toLocaleString()} episodes, about {formatDuration(totalEpisodes * EPISODE_SECONDS[0] * 1000)}–{formatDuration(totalEpisodes * EPISODE_SECONDS[1] * 1000)}
            </span>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || (!mjlab && !opts)} onClick={submit}>
            {busy && <Spinner className="h-3.5 w-3.5" />} Queue {models.length === 1 ? 'eval' : `${models.length} evals`}
          </Button>
        </>
      )}
    >
      {mjlab ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Robots in parallel" hint="Blank: 512">
            <Input type="number" min={1} value={envs} onChange={(e) => setEnvs(e.target.value)} placeholder="512" />
          </Field>
          <Field label="Steps" hint="Blank: 1000 control steps">
            <Input type="number" min={1} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder="1000" />
          </Field>
        </div>
      ) : !opts ? (
        <div className="grid place-items-center py-10"><Spinner /></div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Trials per model" hint="More trials narrow the confidence interval on the leaderboard.">
            <div className="flex flex-wrap items-center gap-2">
              <Input type="number" min={1} max={100} value={trials} onChange={(e) => setTrials(e.target.value)} className="w-24" />
              {TRIAL_PRESETS.map((p) => (
                <button
                  key={p.n}
                  type="button"
                  onClick={() => setTrials(String(p.n))}
                  className={cn('h-7 cursor-pointer rounded-full border px-2.5 text-xs', trials === String(p.n) ? 'border-primary bg-primary/10' : 'hover:bg-muted')}
                >
                  {p.n} <span className="text-muted-foreground">{p.hint}</span>
                </button>
              ))}
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Episodes per trial" hint={`Blank: ${DEFAULT_EPISODES}`}>
              <Input type="number" min={1} value={episodes} onChange={(e) => setEpisodes(e.target.value)} placeholder={String(DEFAULT_EPISODES)} />
            </Field>
            <Field label="Gym" hint="Blank: the trainer's current build">
              <Select value={gym} onChange={(e) => setGym(e.target.value)}>
                <option value="">Default</option>
                {opts.gyms.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </Select>
            </Field>
            <Field label="Course" hint="A different course than a model trained on fails its spec check.">
              <Select value={course} onChange={(e) => setCourse(e.target.value)}>
                <option value="">From each model</option>
                {opts.courses.filter((c) => c.value).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </Select>
            </Field>
            <Field label="Model type" hint="RandomPyPolicy and FlyPyPolicy are baselines built from scratch.">
              <Select value={modelType} onChange={(e) => setModelType(e.target.value)}>
                <option value="">From each model</option>
                {opts.model_types.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </Field>
          </div>
          <details className="rounded-lg border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Designs and curriculum sweep</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="Reward design" hint="Scores returns; goals and crashes don't depend on it.">
                <Select value={reward} onChange={(e) => setReward(e.target.value)}>
                  <option value="">From each model</option>
                  {opts.reward_designs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.version ? ` (v${d.version})` : ''}</option>)}
                </Select>
              </Field>
              <Field label="Experiment design" hint="Its curriculum stages are what a sweep runs.">
                <Select value={experiment} onChange={(e) => setExperiment(e.target.value)}>
                  <option value="">From each model</option>
                  {opts.experiment_designs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.stages ? ` · ${d.stages} stages` : ''}</option>)}
                </Select>
              </Field>
              <label className={cn('flex items-center gap-2 text-sm sm:col-span-2', !stages && 'opacity-60')}>
                <input type="checkbox" className="h-4 w-4 accent-primary" disabled={!stages} checked={sweep && stages > 0} onChange={(e) => setSweep(e.target.checked)} />
                Sweep curriculum stages{stages ? ` (${stages} in the design)` : ': the experiment design has none'}
              </label>
              {sweep && stages > 0 && (
                <>
                  <Field label="From stage">
                    <Select value={start} onChange={(e) => setStart(e.target.value)}>
                      <option value="">First</option>
                      {Array.from({ length: stages }, (_, i) => <option key={i} value={i}>Stage {i + 1}</option>)}
                    </Select>
                  </Field>
                  <Field label="To stage">
                    <Select value={end} onChange={(e) => setEnd(e.target.value)}>
                      <option value="">Last</option>
                      {Array.from({ length: stages }, (_, i) => <option key={i} value={i}>Stage {i + 1}</option>)}
                    </Select>
                  </Field>
                </>
              )}
            </div>
          </details>
          {models.some((m) => m.compat.status === 'incompatible') && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
              {models.filter((m) => m.compat.status === 'incompatible').length} of these models don&apos;t match their course&apos;s
              observation spec; their evals will fail unless you pick a course they fit.
            </p>
          )}
        </div>
      )}
      {problems.length > 0 && (
        <div className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-sm">
          <p className="font-medium text-rose-700 dark:text-rose-300">
            {launched ? `${models.length - problems.length} queued; these were not:` : 'Nothing was queued. Fix these first:'}
          </p>
          <ul className="mt-1 list-disc pl-5 text-rose-700 dark:text-rose-300">
            {problems.slice(0, 6).map((p) => <li key={p.model.id}><b>{modelTitle(p.model)}</b>: {p.message}</li>)}
          </ul>
        </div>
      )}
    </Modal>
  );
}
