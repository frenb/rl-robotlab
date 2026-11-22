import { Bot } from 'lucide-react';
import type { Run, RunStatus, TagInfo } from '../lib/api';
import { robotName, robotTone, useRobots } from '../lib/robots';
import { Badge, type Tone } from './ui';

const STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  NOT_STARTED: { label: 'Queued', tone: 'neutral' },
  IN_PROGRESS: { label: 'Running', tone: 'blue' },
  PAUSE_REQUESTED: { label: 'Pausing', tone: 'amber' },
  PAUSED: { label: 'Paused', tone: 'amber' },
  DONE: { label: 'Done', tone: 'green' },
  FAILED: { label: 'Failed', tone: 'red' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export function StatusBadge({ status }: { status: Run['status'] }) {
  const s = (status && STATUS[status]) || { label: status ?? 'Unknown', tone: 'neutral' as Tone };
  return (
    <Badge tone={s.tone}>
      {status === 'IN_PROGRESS' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {s.label}
    </Badge>
  );
}

const TYPES: Record<string, string> = {
  TRAIN: 'Train', EVAL: 'Eval', DEMO: 'Demo', BC_TRAINING_ONLY: 'BC', EXPORT: 'Export', VIDEO: 'Video',
};

export function typeLabel(t: string | null) {
  return (t && TYPES[t]) || t || '—';
}

export function RobotBadge({ robot }: { robot: string }) {
  const { data: robots } = useRobots();
  return (
    <Badge tone={robotTone(robots?.find((r) => r.id === robot))}>
      <Bot className="h-3 w-3" />
      {robotName(robots, robot)}
    </Badge>
  );
}

export function runTitle(run: Pick<Run, 'name' | 'gym_name' | 'task_id' | 'job_type'>) {
  return run.name || run.gym_name || run.task_id || `${typeLabel(run.job_type)} run`;
}

/** The one curve that best says "is it learning", per trainer family. */
const HEADLINE_TAGS = [
  'Train/mean_reward',
  'eval/Metrics/AverageReturn',
  'train/Metrics/AverageReturn',
  'metrics/Metrics/AverageReturn',
];

export function headlineTag(tags: TagInfo[] | undefined): string | null {
  if (!tags?.length) return null;
  const names = new Set(tags.map((t) => t.tag));
  return HEADLINE_TAGS.find((t) => names.has(t)) ?? tags.find((t) => /return|reward/i.test(t.tag))?.tag ?? null;
}

/** Charts a new viewer sees first on the Metrics tab, when the run has them. */
export const DEFAULT_TAGS = [
  'Train/mean_reward',
  'Train/mean_episode_length',
  'Loss/value',
  'Loss/surrogate',
  'Loss/entropy',
  'Perf/total_fps',
  'eval/Metrics/AverageReturn',
  'eval/Metrics/AverageEpisodeLength',
  'train/Metrics/AverageReturn',
  'learner/train/Losses/critic_loss',
  'learner/train/Losses/actor_loss',
  'learner/train/Losses/alpha_loss',
];
