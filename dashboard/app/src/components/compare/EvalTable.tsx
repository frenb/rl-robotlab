import { useMemo } from 'react';
import type { ModelEval } from '../../lib/api';
import { summarize, versus, type Summary, type Versus } from '../../lib/stats';
import { cn, formatNumber } from '../../lib/utils';
import { Card, Empty, Select } from '../ui';
import type { Entry } from './CompareCurves';

interface Metric {
  label: string;
  /** Per-trial samples (car) or a per-model aggregate (mjlab). */
  kind: 'trials' | 'aggregate';
  better: 'higher' | 'lower' | null;
  help: string;
}

export const EVAL_METRICS: Record<string, Metric> = {
  returns: { label: 'Avg return', kind: 'trials', better: 'higher', help: 'Depends on the reward design: compare only runs trained on the same one.' },
  avg_goals_per_episode: { label: 'Goals per episode', kind: 'trials', better: 'higher', help: 'The most direct task-success measure on the donut course; independent of the reward design.' },
  episode_lengths: { label: 'Episode length', kind: 'trials', better: 'higher', help: 'Env steps before a crash or timeout.' },
  steps_per_goal: { label: 'Steps per goal', kind: 'trials', better: 'lower', help: 'Episode length divided by goals; trials with no goal are left out.' },
  avg_speeds: { label: 'Speed (m/s)', kind: 'trials', better: null, help: 'Faster is not better on its own; read it with goals per episode.' },
  avg_steering_angle_ratios: { label: 'Steering ratio', kind: 'trials', better: 'lower', help: 'Lower means smoother driving.' },
  episode_counts: { label: 'Crashes per trial', kind: 'trials', better: 'lower', help: 'Episodes per trial; every donut episode ends in a crash.' },
  mean_return: { label: 'Mean return', kind: 'aggregate', better: 'higher', help: 'mjlab EVAL: mean episode return. One aggregate per eval, so no significance test.' },
  fall_rate: { label: 'Fall rate', kind: 'aggregate', better: 'lower', help: 'mjlab EVAL: share of episodes that ended in a fall.' },
  mean_episode_length: { label: 'Episode length', kind: 'aggregate', better: 'higher', help: 'mjlab EVAL: mean steps per episode.' },
  mean_reward_per_step: { label: 'Reward per step', kind: 'aggregate', better: 'higher', help: 'mjlab EVAL.' },
};

/** Metrics with data among these models, in table order. */
export function availableMetrics(models: ModelEval[]): string[] {
  return Object.keys(EVAL_METRICS).filter((k) => models.some((m) =>
    EVAL_METRICS[k].kind === 'trials'
      ? m.samples.some((s) => s.trials[k]?.length)
      : m.aggregate?.[k] != null));
}

function pooled(m: ModelEval, metric: string, stage: string): number[] {
  return m.samples
    .filter((s) => stage === '' || String(s.stage) === stage)
    .flatMap((s) => s.trials[metric] ?? []);
}

interface RowStats {
  model: ModelEval;
  entry: Entry | null;
  values: number[];
  summary: Summary | null;
  aggregate: number | null;
  vs: Versus | null;
  /** Aggregate metrics: plain difference from the baseline. */
  delta: number | null;
}

function pValue(p: number) {
  if (!isFinite(p)) return '—';
  if (p < 1e-4) return '<0.0001';
  return p.toFixed(p < 0.01 ? 4 : 3);
}

function good(delta: number | null, better: Metric['better'], significant: boolean): string | undefined {
  if (delta == null || !better || !significant || delta === 0) return undefined;
  const up = delta > 0;
  return (better === 'higher') === up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
}

export function EvalTable({
  models, entries, picked, metric, stage, baseline, onMetric, onStage, onBaseline,
}: {
  models: ModelEval[];
  entries: Entry[];
  picked: string[];
  metric: string;
  stage: string;
  baseline: string;
  onMetric: (m: string) => void;
  onStage: (s: string) => void;
  onBaseline: (id: string) => void;
}) {
  const metrics = availableMetrics(models);
  const key = metrics.includes(metric) ? metric : metrics[0];
  const def = key ? EVAL_METRICS[key] : null;
  const stages = [...new Set(models.flatMap((m) => m.samples.map((s) => s.stage)).filter((s): s is number => s != null))].sort((a, b) => a - b);
  const entryOf = (m: ModelEval) => entries.find((e) => e.run.id === m.run_id) ?? null;

  const rows: RowStats[] = useMemo(() => {
    if (!def || !key) return [];
    const runOrder = (m: ModelEval) => {
      const i = entries.findIndex((e) => e.run.id === m.run_id);
      return i < 0 ? entries.length : i;
    };
    const base = models
      .filter((m) => (def.kind === 'trials' ? pooled(m, key, stage).length > 0 : m.aggregate?.[key] != null))
      .sort((a, b) => runOrder(a) - runOrder(b) || (a.iteration ?? 0) - (b.iteration ?? 0))
      .map((m) => {
        const values = def.kind === 'trials' ? pooled(m, key, stage) : [];
        return {
          model: m,
          entry: entryOf(m),
          values,
          summary: values.length ? summarize(values) : null,
          aggregate: def.kind === 'aggregate' ? m.aggregate![key] : null,
          vs: null as Versus | null,
          delta: null as number | null,
        };
      });
    const ref = base.find((r) => r.model.id === baseline) ?? base[0];
    for (const r of base) {
      if (!ref || r === ref) continue;
      if (def.kind === 'trials') r.vs = versus(r.values, ref.values);
      else if (r.aggregate != null && ref.aggregate != null) r.delta = r.aggregate - ref.aggregate;
    }
    return base;
  }, [models, entries, key, def, stage, baseline]);

  if (!models.length || !def || !key) {
    return (
      <Empty title="None of these runs' models has been evaluated">
        Evaluate a checkpoint (an EVAL job) and its results appear here. Car evals record per-trial scores; mjlab evals one aggregate per checkpoint.
      </Empty>
    );
  }

  const ref = rows.find((r) => r.model.id === baseline) ?? rows[0];
  // Shared scale for the interval bars.
  const lo = Math.min(...rows.flatMap((r) => (r.summary ? [r.summary.ci[0], Math.min(...r.values)] : r.aggregate != null ? [r.aggregate] : [])).filter(isFinite));
  const hi = Math.max(...rows.flatMap((r) => (r.summary ? [r.summary.ci[1], Math.max(...r.values)] : r.aggregate != null ? [r.aggregate] : [])).filter(isFinite));
  const pos = (v: number) => (hi > lo ? ((v - lo) / (hi - lo)) * 100 : 50);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Metric
          <Select value={key} onChange={(e) => onMetric(e.target.value)} className="h-8 text-xs">
            {metrics.map((k) => <option key={k} value={k}>{EVAL_METRICS[k].label}{EVAL_METRICS[k].kind === 'aggregate' ? ' (mjlab)' : ''}</option>)}
          </Select>
        </label>
        {def.kind === 'trials' && stages.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Stage
            <Select value={stage} onChange={(e) => onStage(e.target.value)} className="h-8 text-xs">
              <option value="">All stages pooled</option>
              {stages.map((s) => <option key={s} value={String(s)}>Stage {s + 1}</option>)}
            </Select>
          </label>
        )}
        <p className="text-xs text-muted-foreground">{def.help}</p>
      </div>

      {rows.length === 0 ? (
        <Empty title={`No ${def.label.toLowerCase()} for these models${stage ? ' on this stage' : ''}`} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2.5 font-medium">Baseline</th>
                <th className="px-3 py-2.5 font-medium">Model</th>
                {def.kind === 'trials' ? (
                  <>
                    <th className="px-3 py-2.5 text-right font-medium">Trials</th>
                    <th className="px-3 py-2.5 text-right font-medium">Mean</th>
                    <th className="w-48 px-3 py-2.5 font-medium">95% CI of the mean · trials</th>
                    <th className="px-3 py-2.5 text-right font-medium">Median</th>
                    <th className="px-3 py-2.5 text-right font-medium">Δ mean</th>
                    <th className="px-3 py-2.5 text-right font-medium" title="Welch's t-test, two-sided">p</th>
                    <th className="px-3 py-2.5 text-right font-medium" title="Hedges' g: difference in pooled standard deviations">g</th>
                  </>
                ) : (
                  <>
                    <th className="px-3 py-2.5 text-right font-medium">{def.label}</th>
                    <th className="w-48 px-3 py-2.5 font-medium" />
                    <th className="px-3 py-2.5 text-right font-medium">Δ</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isRef = r === ref;
                const delta = r.vs ? r.vs.diff : r.delta;
                const sig = r.vs ? r.vs.p < 0.05 : r.delta != null;
                return (
                  <tr key={r.model.id} className={cn('border-b last:border-0', picked.includes(r.model.id) && 'bg-primary/5')}>
                    <td className="px-3 py-2">
                      <input
                        type="radio" name="baseline" checked={isRef} onChange={() => onBaseline(r.model.id)}
                        className="cursor-pointer accent-[var(--primary)]" aria-label="Use as baseline"
                      />
                    </td>
                    <td className="max-w-72 px-3 py-2">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.entry?.color ?? 'var(--muted-foreground)' }} />
                        <span className="truncate font-mono text-xs" title={r.model.location ?? r.model.id}>{r.model.label}</span>
                      </span>
                      <span className="block truncate pl-3.5 text-[11px] text-muted-foreground">
                        {r.entry ? r.entry.label : 'not linked to a run'}
                        {r.model.iteration != null && ` · iteration ${formatNumber(r.model.iteration, 0)}`}
                        {r.model.samples.length > 1 && ` · ${r.model.samples.length} evals`}
                      </span>
                    </td>
                    {def.kind === 'trials' && r.summary ? (
                      <>
                        <td className="px-3 py-2 text-right tabular-nums">{r.summary.n}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">{formatNumber(r.summary.mean, 3)}</td>
                        <td className="px-3 py-2">
                          <div className="relative h-4 w-44" title={`95% CI ${formatNumber(r.summary.ci[0], 3)} to ${formatNumber(r.summary.ci[1], 3)}`}>
                            <div className="absolute top-1/2 h-px w-full bg-border" />
                            {r.values.map((v, i) => (
                              <span key={i} className="absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40" style={{ left: `${pos(v)}%`, background: r.entry?.color ?? 'currentColor' }} />
                            ))}
                            {isFinite(r.summary.ci[0]) && (
                              <span
                                className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
                                style={{ left: `${pos(r.summary.ci[0])}%`, width: `${Math.max(1, pos(r.summary.ci[1]) - pos(r.summary.ci[0]))}%`, background: r.entry?.color ?? 'currentColor' }}
                              />
                            )}
                            <span className="absolute top-0 h-4 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: `${pos(r.summary.mean)}%` }} />
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.summary.median, 3)}</td>
                        <td className={cn('px-3 py-2 text-right tabular-nums', good(delta, def.better, sig))}>
                          {isRef ? 'baseline' : r.vs ? (delta! > 0 ? '+' : '') + formatNumber(delta, 3) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.vs ? pValue(r.vs.p) : '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.vs?.g != null ? formatNumber(r.vs.g, 2) : '—'}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">{formatNumber(r.aggregate, 3)}</td>
                        <td className="px-3 py-2">
                          {r.aggregate != null && (
                            <div className="relative h-4 w-44">
                              <div className="absolute top-1/2 h-px w-full bg-border" />
                              <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${pos(r.aggregate)}%`, background: r.entry?.color ?? 'currentColor' }} />
                            </div>
                          )}
                        </td>
                        <td className={cn('px-3 py-2 text-right tabular-nums', good(delta, def.better, sig))}>
                          {isRef ? 'baseline' : delta != null ? (delta > 0 ? '+' : '') + formatNumber(delta, 3) : '—'}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {def.kind === 'trials' && (
        <p className="text-xs text-muted-foreground">
          A trial is the mean of several eval episodes; every eval of a model is pooled. Differences are colored when Welch's p &lt; 0.05.
          Trials aren't independent episodes, so treat p-values from fewer than ~5 trials with care.
        </p>
      )}
    </div>
  );
}
