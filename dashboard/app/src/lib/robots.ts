import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api, keys, type Robot } from './api';
import type { Tone } from '../components/ui';

const STORAGE_KEY = 'robot';
const listeners = new Set<() => void>();

/** The robot picked in the sidebar; '' means all robots. */
export function useSelectedRobot(): [string, (id: string) => void] {
  const robot = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => localStorage.getItem(STORAGE_KEY) ?? '',
  );
  const set = (id: string) => {
    localStorage.setItem(STORAGE_KEY, id);
    listeners.forEach((l) => l());
  };
  return [robot, set];
}

export function useRobots() {
  return useQuery({ queryKey: keys.robots, queryFn: api.robots, staleTime: 5 * 60_000 });
}

const BADGE_TONES: Record<string, Tone> = {
  sky: 'blue', blue: 'blue', emerald: 'green', green: 'green', amber: 'amber', yellow: 'amber',
  rose: 'red', red: 'red', violet: 'violet', purple: 'violet', indigo: 'violet',
};

export function robotTone(robot: Robot | undefined): Tone {
  return (robot?.badge_color && BADGE_TONES[robot.badge_color]) || 'neutral';
}

export function robotName(robots: Robot[] | undefined, id: string): string {
  return robots?.find((r) => r.id === id)?.display_name ?? id;
}

export function isMjlab(robots: Robot[] | undefined, id: string): boolean {
  const r = robots?.find((x) => x.id === id);
  return r ? r.engine === 'mjlab_rsl_rl' : id !== 'roboracer';
}
