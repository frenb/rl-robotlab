import { useQueryClient } from '@tanstack/react-query';
import { Crown } from 'lucide-react';
import { api, keys, type Compat, type ModelSummary } from '../../lib/api';
import { robotName, useRobots } from '../../lib/robots';
import { formatNumber, shortId } from '../../lib/utils';
import { confirmDialog, toast } from '../feedback';
import { Badge, type Tone } from '../ui';

export const METRIC_LABELS: Record<string, string> = {
  avg_goals_per_episode: 'Goals per episode',
  steps_per_goal: 'Steps per goal',
  episode_counts: 'Crashes per trial',
  returns: 'Return',
  episode_lengths: 'Episode length',
  avg_speeds: 'Speed (m/s)',
  avg_steering_angle_ratios: 'Steering ratio',
  fall_rate: 'Fall rate',
  mean_return: 'Mean return',
  mean_episode_length: 'Episode length',
  mean_reward_per_step: 'Reward per step',
};

export function formatMetric(key: string, v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—';
  if (key === 'fall_rate') return `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
  return formatNumber(v, key === 'mean_reward_per_step' ? 4 : 2);
}

const COMPAT: Record<Compat['status'], { label: string; tone: Tone }> = {
  compatible: { label: 'Compatible', tone: 'green' },
  incompatible: { label: 'Spec mismatch', tone: 'red' },
  unknown: { label: 'Unverified', tone: 'neutral' },
};

export function CompatBadge({ compat, mjlab }: { compat: Compat; mjlab?: boolean }) {
  const c = COMPAT[compat.status];
  const label = mjlab ? (compat.status === 'compatible' ? 'ONNX ready' : 'No ONNX') : c.label;
  return <span title={compat.reason}><Badge tone={c.tone}>{label}</Badge></span>;
}

/** Promoted always; "latest of run" only where it isn't on nearly every row. */
export function ModelFlags({ model, latest = false }: { model: ModelSummary; latest?: boolean }) {
  return (
    <>
      {model.promoted_at && (
        <span title={`Promoted ${new Date(model.promoted_at).toLocaleString()}: the model to deploy or warm-start from`}>
          <Badge tone="amber"><Crown className="h-3 w-3" /> Promoted</Badge>
        </span>
      )}
      {latest && model.latest_of_run && <span title="The newest checkpoint its run saved"><Badge>Latest of run</Badge></span>}
    </>
  );
}

/** The one-line eval result a list row shows. */
export function evalLine(model: ModelSummary): string | null {
  const e = model.eval;
  if (!e) return null;
  const m = e.metrics;
  if (m.fall_rate != null || m.mean_return != null) {
    return `falls ${formatMetric('fall_rate', m.fall_rate)} · return ${formatMetric('mean_return', m.mean_return)}`;
  }
  const goals = m.avg_goals_per_episode != null ? `${formatMetric('avg_goals_per_episode', m.avg_goals_per_episode)} goals/ep` : null;
  return [goals, `${e.trials} trial${e.trials === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
}

export function modelTitle(model: Pick<ModelSummary, 'label' | 'id'>): string {
  return model.label || shortId(model.id);
}

/** Model jobs and record changes, with confirmation and toasts; each returns whether it acted. */
export function useModelActions() {
  const qc = useQueryClient();
  const { data: robots } = useRobots();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.allModels });
    qc.invalidateQueries({ queryKey: keys.allModel });
    qc.invalidateQueries({ queryKey: keys.allLeaderboard });
    qc.invalidateQueries({ queryKey: keys.allRuns });
  };

  const queue = async (models: ModelSummary[], jobType: 'EXPORT' | 'VIDEO') => {
    const what = jobType === 'EXPORT' ? 'ONNX export' : 'video render';
    const ok = await confirmDialog({
      title: `Queue ${models.length === 1 ? `a ${what}` : `${models.length} ${what}s`}?`,
      message: jobType === 'EXPORT'
        ? 'Writes an ONNX file next to each checkpoint and checks it against the observation and action sizes.'
        : 'Renders a rollout of each checkpoint on its task; the video lands on the training run\u2019s Media tab.',
      confirmLabel: 'Queue',
    });
    if (!ok) return false;
    const results = await Promise.all(models.map((m) =>
      api.launch({ robot: m.robot, job_type: jobType, model_id: m.id }).then(() => null, (e: Error) => `${modelTitle(m)}: ${e.message}`)));
    const errors = results.filter(Boolean);
    if (errors.length) toast('error', `${errors.length} of ${models.length} failed. ${errors[0]}`);
    else toast('success', `${models.length} ${what}${models.length === 1 ? '' : 's'} queued.`);
    refresh();
    return errors.length < models.length;
  };

  const promote = async (model: ModelSummary, promoted: boolean) => {
    const robot = robotName(robots, model.robot);
    if (promoted && !(await confirmDialog({
      title: `Promote ${modelTitle(model)}?`,
      message: `It becomes ${robot}'s promoted model, replacing the current one if there is one.`,
      confirmLabel: 'Promote',
    }))) return false;
    try {
      await api.promoteModel(model.id, promoted);
      toast('success', promoted ? `Promoted for ${robot}.` : 'No longer promoted.');
      refresh();
      return true;
    } catch (e) {
      toast('error', `Couldn't change the promotion: ${(e as Error).message}`);
      return false;
    }
  };

  const remove = async (models: ModelSummary[]) => {
    const mjlab = models.some((m) => m.robot !== 'roboracer');
    const ok = await confirmDialog({
      title: `Delete ${models.length === 1 ? modelTitle(models[0]) : `${models.length} models`}?`,
      message: (
        <>
          Removes the saved model files under /saved_models and their eval scores, then the record.
          {mjlab && ' mjlab checkpoints live in the trainer\u2019s logs and are kept; only their records go.'}
        </>
      ),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return false;
    try {
      const results = await api.removeModels(models.map((m) => m.id));
      const failed = results.filter((r) => !r.ok);
      if (failed.length) toast('error', `${failed.length} of ${results.length} not deleted: ${failed[0].error}`);
      else toast('success', `${results.length} model${results.length === 1 ? '' : 's'} deleted.`);
      refresh();
      return failed.length < results.length;
    } catch (e) {
      toast('error', `Delete failed: ${(e as Error).message}`);
      return false;
    }
  };

  return { exportOnnx: (m: ModelSummary[]) => queue(m, 'EXPORT'), renderVideo: (m: ModelSummary[]) => queue(m, 'VIDEO'), promote, remove, refresh };
}
