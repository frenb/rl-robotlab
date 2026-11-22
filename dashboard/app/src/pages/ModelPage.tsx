import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeft, Check, CheckCircle2, Copy, Crown, Download, Film, FlaskConical, GitCompareArrows, Package, Trash2, XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from '../components/feedback';
import { EvalDialog } from '../components/models/EvalDialog';
import { CompatBadge, formatMetric, METRIC_LABELS, ModelFlags, modelTitle, useModelActions } from '../components/models/ModelBits';
import { RobotBadge, StatusBadge, runTitle, typeLabel } from '../components/RunBits';
import { Badge, Button, Card, CardHeader, Empty, Spinner, Textarea } from '../components/ui';
import { api, keys, type ModelDetail } from '../lib/api';
import { isMjlab, useRobots } from '../lib/robots';
import { summarize } from '../lib/stats';
import { cn, formatNumber, shortId, timeAgo } from '../lib/utils';

const CAR_ORDER = ['avg_goals_per_episode', 'steps_per_goal', 'episode_counts', 'returns', 'episode_lengths', 'avg_speeds', 'avg_steering_angle_ratios'];
const MJLAB_ORDER = ['fall_rate', 'mean_return', 'mean_episode_length', 'mean_reward_per_step'];

function CopyText({ text, label }: { text: string; label?: ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="inline-flex max-w-full cursor-pointer items-center gap-1 text-left font-mono text-xs text-muted-foreground hover:text-foreground"
      title="Copy"
    >
      <span className="truncate">{label ?? text}</span>
      {done ? <Check className="h-3 w-3 shrink-0" /> : <Copy className="h-3 w-3 shrink-0" />}
    </button>
  );
}

function Stat({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 text-xl font-semibold tabular-nums">{children}</div>
      {sub && <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  if (children == null || children === '') return null;
  return (
    <div className="grid grid-cols-[150px_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function isLeaf(s: unknown): s is { shape?: (number | null)[]; dtype?: string } {
  return !!s && typeof s === 'object' && 'shape' in (s as object);
}

function formatSpec(s: unknown): string {
  if (!s) return '—';
  if (!isLeaf(s)) {
    return Object.keys(s as object).sort().map((k) => `${k} ${formatSpec((s as Record<string, unknown>)[k])}`).join(', ');
  }
  const dtype = String(s.dtype ?? '').replace(/^<dtype: '(.*)'>$/, '$1');
  return `[${(s.shape ?? []).map((d) => (d == null ? '?' : d)).join(', ')}]${dtype ? ` ${dtype}` : ''}`;
}

/** Car: pooled trials per metric with a 95% interval, then one row per eval run. */
function CarEvals({ data }: { data: ModelDetail }) {
  const stages = Array.from(new Set(data.samples.map((s) => s.stage).filter((s): s is number => s != null))).sort((a, b) => a - b);
  const hasMain = data.samples.some((s) => s.stage == null);
  const [stage, setStage] = useState<string>(hasMain ? 'main' : 'all');
  const kept = data.samples.filter((s) => stage === 'all' || (stage === 'main' ? s.stage == null : String(s.stage) === stage));
  const rows = useMemo(() => CAR_ORDER.map((k) => {
    const xs = kept.flatMap((s) => s.trials[k] ?? []);
    return xs.length ? { key: k, s: summarize(xs) } : null;
  }).filter((r): r is NonNullable<typeof r> => r !== null), [kept]);
  return (
    <div className="flex flex-col gap-4">
      {(stages.length > 0) && (
        <div className="flex flex-wrap gap-1.5 px-4">
          {[...(hasMain ? [['main', 'Ordinary evals']] : []), ['all', 'Everything'], ...stages.map((s) => [String(s), `Sweep stage ${s + 1}`])].map(([v, label]) => (
            <button
              key={v}
              onClick={() => setStage(v)}
              className={cn('h-7 cursor-pointer rounded-full border px-2.5 text-xs', stage === v ? 'border-primary bg-primary/10' : 'hover:bg-muted')}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="border-y bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Metric</th>
            <th className="px-4 py-2 text-right font-medium">Mean</th>
            <th className="px-4 py-2 text-right font-medium">95% CI</th>
            <th className="px-4 py-2 text-right font-medium">Median</th>
            <th className="px-4 py-2 text-right font-medium">Trials</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(({ key, s }) => (
            <tr key={key}>
              <td className="px-4 py-2">{METRIC_LABELS[key] ?? key}</td>
              <td className="px-4 py-2 text-right font-medium tabular-nums">{formatMetric(key, s.mean)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                {isFinite(s.ci[0]) ? `${formatMetric(key, s.ci[0])} – ${formatMetric(key, s.ci[1])}` : '—'}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{formatMetric(key, s.median)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{s.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="px-4">
        <summary className="cursor-pointer text-sm font-medium">Each eval run ({data.samples.length})</summary>
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1.5 font-medium">When</th>
              <th className="py-1.5 font-medium">Stage</th>
              <th className="py-1.5 text-right font-medium">Trials</th>
              <th className="py-1.5 text-right font-medium">Goals/ep</th>
              <th className="py-1.5 text-right font-medium">Steps/goal</th>
              <th className="py-1.5 text-right font-medium">Crashes/trial</th>
              <th className="py-1.5 text-right font-medium">Return</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.samples.map((s) => {
              const m = (k: string) => {
                const xs = s.trials[k] ?? [];
                return xs.length ? formatMetric(k, xs.reduce((a, b) => a + b, 0) / xs.length) : '—';
              };
              return (
                <tr key={s.id}>
                  <td className="py-1.5 text-muted-foreground" title={s.created_at ?? ''}>{timeAgo(s.created_at)}</td>
                  <td className="py-1.5 text-muted-foreground">{s.stage != null ? s.stage + 1 : '—'}</td>
                  <td className="py-1.5 text-right tabular-nums">{(s.trials.returns ?? []).length}</td>
                  <td className="py-1.5 text-right tabular-nums">{m('avg_goals_per_episode')}</td>
                  <td className="py-1.5 text-right tabular-nums">{m('steps_per_goal')}</td>
                  <td className="py-1.5 text-right tabular-nums">{m('episode_counts')}</td>
                  <td className="py-1.5 text-right tabular-nums">{m('returns')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function MjlabEval({ data }: { data: ModelDetail }) {
  const a = data.aggregate!;
  const num = (k: string) => (typeof a[k] === 'number' ? (a[k] as number) : null);
  return (
    <div className="px-4">
      <dl className="divide-y">
        {MJLAB_ORDER.map((k) => <Detail key={k} label={METRIC_LABELS[k]}>{formatMetric(k, num(k))}</Detail>)}
        <Detail label="Episodes">{num('episodes') != null ? `${num('episodes')} (${num('falls') ?? 0} falls, ${num('timeouts') ?? 0} timeouts)` : null}</Detail>
        <Detail label="Conditions">{num('num_envs') != null ? `${num('num_envs')} robots × ${num('steps')} steps` : null}</Detail>
        <Detail label="Eval job">
          {a.eval_job_id && <Link to="/runs/$runId" params={{ runId: a.eval_job_id }} className="font-mono hover:underline">{shortId(a.eval_job_id)}</Link>}
        </Detail>
      </dl>
    </div>
  );
}

function Notes({ id, notes }: { id: string; notes: string | null }) {
  const qc = useQueryClient();
  const [text, setText] = useState(notes ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(notes ?? ''), [notes]);
  const dirty = text.trim() !== (notes ?? '');
  const save = async () => {
    setBusy(true);
    try {
      await api.setModelNotes(id, text);
      qc.invalidateQueries({ queryKey: keys.model(id) });
      qc.invalidateQueries({ queryKey: keys.allModels });
      toast('success', 'Notes saved.');
    } catch (e) {
      toast('error', `Couldn't save notes: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 px-4 pb-4 pt-3">
      <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="What is this checkpoint good or bad at? Searchable from the models list." rows={3} />
      <div className="flex justify-end">
        <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={save}>Save notes</Button>
      </div>
    </div>
  );
}

export function ModelPage() {
  const { modelId } = useParams({ strict: false }) as { modelId: string };
  const navigate = useNavigate();
  const { data: robots } = useRobots();
  const { data, isLoading, error } = useQuery({ queryKey: keys.model(modelId), queryFn: () => api.model(modelId) });
  const actions = useModelActions();
  const [evaluating, setEvaluating] = useState(false);

  if (isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (error || !data) {
    return <div className="p-8"><Empty title="Couldn't load this model">{String((error as Error)?.message ?? '')}</Empty></div>;
  }
  const { model, run } = data;
  const mjlab = isMjlab(robots, model.robot);
  const canExport = mjlab && robots?.find((r) => r.id === model.robot)?.supports?.export !== false;
  const headlineKey = mjlab ? 'fall_rate' : 'avg_goals_per_episode';
  const pending = data.eval_runs.filter((r) => r.status === 'NOT_STARTED' || r.status === 'IN_PROGRESS');

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 sm:p-8">
      <div>
        <Link to="/models" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Models
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="break-all text-2xl font-semibold tracking-tight">{modelTitle(model)}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <RobotBadge robot={model.robot} />
              <ModelFlags model={model} latest />
              <CompatBadge compat={model.compat} mjlab={mjlab} />
              {model.model_type && <span>{model.model_type}</span>}
              <CopyText text={model.id} label={shortId(model.id)} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => setEvaluating(true)}><FlaskConical className="h-4 w-4" /> Evaluate</Button>
            {canExport && <Button onClick={() => actions.exportOnnx([model])}><Package className="h-4 w-4" /> Export ONNX</Button>}
            {mjlab && <Button onClick={() => actions.renderVideo([model])}><Film className="h-4 w-4" /> Render video</Button>}
            <Link
              to="/compare"
              search={{ models: model.id, tab: model.eval ? 'evals' : undefined }}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-3.5 text-sm font-medium hover:bg-muted"
              title="Its evals and training run next to others"
            >
              <GitCompareArrows className="h-4 w-4" /> Compare
            </Link>
            <Button onClick={() => actions.promote(model, !model.promoted_at)} title="One promoted model per robot: the one to deploy or warm-start from">
              <Crown className="h-4 w-4" /> {model.promoted_at ? 'Unpromote' : 'Promote'}
            </Button>
            <Button className="text-rose-600 dark:text-rose-400" onClick={async () => { if (await actions.remove([model])) navigate({ to: '/models' }); }}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={METRIC_LABELS[headlineKey]}
          sub={model.eval ? `${model.eval.trials} ${mjlab ? 'episodes' : 'trials'}${model.eval.count > 1 ? ` over ${model.eval.count} evals` : ''} · ${timeAgo(model.eval.last_at)}` : 'not evaluated yet'}
        >
          {formatMetric(headlineKey, model.eval?.metrics[headlineKey])}
        </Stat>
        <Stat label="Leaderboard" sub={data.rank ? `on ${data.rank.course ?? 'all'} by ${METRIC_LABELS[data.rank.metric]?.toLowerCase()}` : 'evaluate it to rank it'}>
          {data.rank ? (
            <Link to="/models" search={{ view: 'leaderboard', course: data.rank.course ?? undefined, robot: model.robot }} className="hover:underline">
              #{data.rank.rank} <span className="text-sm font-normal text-muted-foreground">of {data.rank.of}</span>
            </Link>
          ) : '—'}
        </Stat>
        <Stat label="Iteration" sub={model.course ?? undefined}>{formatNumber(model.iteration, 0)}</Stat>
        <Stat label="Training return" sub="recorded when the checkpoint was saved">{formatNumber(model.avg_return)}</Stat>
      </div>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-6">
          <Card className="pb-4">
            <CardHeader
              title="Evaluation"
              description={mjlab ? 'The latest EVAL: falls, return and episode length on its task.' : 'Trials pooled over every eval run of this checkpoint.'}
              actions={<Button size="sm" onClick={() => setEvaluating(true)}><FlaskConical className="h-3.5 w-3.5" /> Evaluate</Button>}
            />
            <div className="pt-3">
              {mjlab ? (data.aggregate ? <MjlabEval data={data} /> : <p className="px-4 text-sm text-muted-foreground">No eval result yet.</p>)
                : data.samples.length ? <CarEvals data={data} /> : <p className="px-4 text-sm text-muted-foreground">No eval result yet.</p>}
            </div>
          </Card>

          {data.eval_runs.length > 0 && (
            <Card className="pb-2">
              <CardHeader title="Eval jobs" description={pending.length ? `${pending.length} queued or running; results appear above when they finish.` : 'Every EVAL job run on this checkpoint.'} />
              <ul className="mt-2 divide-y">
                {data.eval_runs.slice(0, 12).map((r) => (
                  <li key={r.id}>
                    <Link to="/runs/$runId" params={{ runId: r.id }} className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-muted/40">
                      <StatusBadge status={r.status} />
                      <span className="min-w-0 flex-1 truncate">{runTitle(r)}</span>
                      {r.status === 'FAILED' && r.error && <span className="max-w-64 truncate text-xs text-rose-600 dark:text-rose-400" title={r.error}>{r.error}</span>}
                      <span className="text-xs text-muted-foreground">{timeAgo(r.created_at ?? r.started_at ?? r.ended_at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.gates.length > 0 && (
            <Card className="pb-2">
              <CardHeader title="Curriculum gates" description="Gate checks of curriculum stages that trained or evaluated this checkpoint." />
              <ul className="mt-2 divide-y">
                {data.gates.map((g, i) => (
                  <li key={i} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={g.passed ? 'green' : 'red'}>{g.passed ? 'Passed' : 'Failed'}</Badge>
                      <span className="font-medium">{g.curriculum_name ?? 'Curriculum'}</span>
                      <span className="text-muted-foreground">
                        · stage {g.stage_name ?? (g.stage_index != null ? g.stage_index + 1 : '?')}{g.attempt ? ` · attempt ${g.attempt + 1}` : ''}
                      </span>
                      {g.eval_job_id && (
                        <Link to="/runs/$runId" params={{ runId: g.eval_job_id }} className="ml-auto text-xs text-muted-foreground hover:underline">eval job</Link>
                      )}
                    </div>
                    <table className="mt-2 w-full text-xs">
                      <tbody>
                        {g.checks.map((c, j) => (
                          <tr key={j}>
                            <td className="w-5 py-0.5">
                              {c.passed ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="h-3.5 w-3.5 text-rose-600" />}
                            </td>
                            <td className="py-0.5">{METRIC_LABELS[c.metric] ?? c.metric}</td>
                            <td className="py-0.5 tabular-nums">{formatMetric(c.metric, c.actual)}</td>
                            <td className="py-0.5 text-muted-foreground">needs {c.op} {formatMetric(c.metric, c.value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.clip_url && (
            <Card className="pb-4">
              <CardHeader title="Clip at this checkpoint" />
              <video src={data.clip_url} controls loop muted className="mx-4 mt-3 w-[calc(100%-2rem)] rounded-lg bg-black" />
            </Card>
          )}

          {data.reward_code && (
            <Card className="pb-4">
              <CardHeader title="Reward code" description="As compiled into this checkpoint's training run." />
              <details className="px-4 pt-2">
                <summary className="cursor-pointer text-sm">{model.reward_design?.name ?? 'Show code'}</summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-muted p-4 font-mono text-xs">{data.reward_code}</pre>
              </details>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <Card className="pb-2">
            <CardHeader title="Lineage" />
            <dl className="divide-y px-4 pt-1">
              <Detail label="Training run">
                {run ? (
                  <Link to="/runs/$runId" params={{ runId: run.id }} className="hover:underline">
                    {runTitle(run)} <span className="text-muted-foreground">({typeLabel(run.job_type)}, {String(run.status ?? '').toLowerCase()})</span>
                  </Link>
                ) : model.run_id ? <span className="font-mono text-muted-foreground">{shortId(model.run_id)} (deleted)</span> : null}
              </Detail>
              <Detail label={mjlab ? 'Task' : 'Course'}>{model.course}</Detail>
              <Detail label="Reward design">
                {model.reward_design && `${model.reward_design.name ?? model.reward_design.id}${model.reward_design.version ? ` (v${model.reward_design.version})` : ''}`}
              </Detail>
              <Detail label="Experiment design">
                {model.experiment_design && `${model.experiment_design.name ?? model.experiment_design.id}${model.experiment_design.version ? ` (v${model.experiment_design.version})` : ''}`}
              </Detail>
              <Detail label="Code">{data.git && <span className="font-mono text-xs">{data.git.branch ? `${data.git.branch} @ ` : ''}{data.git.sha.slice(0, 10)}</span>}</Detail>
              <Detail label="Saved">{model.created_at && new Date(model.created_at).toLocaleString()}</Detail>
              <Detail label="Location">{model.location && <CopyText text={model.location} />}</Detail>
            </dl>
            {data.checkpoints.length > 1 && (
              <div className="px-4 pb-2 pt-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  {data.checkpoints.length} checkpoints from this run;{' '}
                  {model.run_id && <Link to="/models" search={{ run: model.run_id, filter: 'all' }} className="hover:underline">list them</Link>}
                </p>
                <div className="flex flex-wrap gap-1">
                  {data.checkpoints.map((c) => (
                    <Link
                      key={c.id}
                      to="/models/$modelId"
                      params={{ modelId: c.id }}
                      title={`Iteration ${c.iteration ?? '?'}${c.evaluated ? ', evaluated' : ''}${c.promoted ? ', promoted' : ''}`}
                      className={cn(
                        'h-6 min-w-6 rounded px-1.5 text-center text-[11px] leading-6 tabular-nums',
                        c.id === model.id ? 'bg-primary text-primary-foreground' : c.evaluated ? 'bg-emerald-500/15 text-emerald-800 hover:bg-emerald-500/25 dark:text-emerald-200' : 'bg-muted text-muted-foreground hover:bg-muted/70',
                      )}
                    >
                      {c.iteration != null ? formatNumber(c.iteration, 0) : '?'}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <Card className="pb-2">
            <CardHeader title="Deploy" description={model.compat.reason} />
            <dl className="divide-y px-4 pt-1">
              {mjlab ? (
                <>
                  <Detail label="Observation">{model.obs_dim != null ? `[${model.obs_dim}]` : '—'}</Detail>
                  <Detail label="Action">{model.act_dim != null ? `[${model.act_dim}]` : '—'}</Detail>
                </>
              ) : (
                <>
                  <Detail label="Observation">{formatSpec(data.specs.observation)}</Detail>
                  <Detail label="Action">{formatSpec(data.specs.action)}</Detail>
                  {data.specs.env && <Detail label="Live env action">{formatSpec(data.specs.env.action)}</Detail>}
                </>
              )}
              <Detail label="ONNX">
                {model.onnx_location ? (
                  <div className="flex flex-col items-start gap-1">
                    <CopyText text={model.onnx_location} />
                    {data.onnx_url && (
                      <a href={data.onnx_url} download className="inline-flex items-center gap-1 text-xs font-medium hover:underline">
                        <Download className="h-3.5 w-3.5" /> Download
                      </a>
                    )}
                  </div>
                ) : mjlab ? 'Not exported yet' : 'The car deploys its SavedModel; no ONNX export'}
              </Detail>
            </dl>
          </Card>

          <Card>
            <CardHeader title="Notes" />
            <Notes id={model.id} notes={model.notes} />
          </Card>
        </div>
      </div>

      {evaluating && <EvalDialog models={[model]} onClose={() => setEvaluating(false)} />}
    </div>
  );
}
