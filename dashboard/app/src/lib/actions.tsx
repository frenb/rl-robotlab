// Run lifecycle actions for one run (run page) or a selection (runs list).
import { useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCheck, Pause, Play, RotateCcw, Trash2 } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { confirmDialog, toast } from '../components/feedback';
import { api, keys, type BulkResult, type Run, type RunAction } from './api';

export interface ActionMeta {
  label: string;
  /** Past tense for the result toast. */
  done: string;
  icon: ComponentType<{ className?: string }>;
  confirm?: (n: number) => { title: string; message: ReactNode; danger?: boolean };
}

const plural = (n: number) => (n === 1 ? 'this run' : `${n} runs`);

export const ACTION_META: Record<RunAction, ActionMeta> = {
  pause: { label: 'Pause', done: 'pause requested', icon: Pause },
  resume: { label: 'Resume', done: 'queued to resume', icon: Play },
  restart: {
    label: 'Restart',
    done: 're-queued',
    icon: RotateCcw,
    confirm: (n) => ({
      title: `Restart ${plural(n)}?`,
      message: 'Puts the run back in the queue under the same id. A worker that finds a checkpoint continues from it; to start fresh, clone the run instead.',
    }),
  },
  cancel: {
    label: 'Cancel',
    done: 'cancelled',
    icon: Ban,
    confirm: (n) => ({
      title: `Cancel ${plural(n)}?`,
      message: 'A running job stops at its next iteration without saving a checkpoint; a queued one is skipped. Restart re-queues it later.',
      danger: true,
    }),
  },
  mark_done: {
    label: 'Mark done',
    done: 'marked done',
    icon: CheckCheck,
    confirm: (n) => ({
      title: `Mark ${plural(n)} done?`,
      message: 'Sets the status to DONE without running anything further, e.g. to retire a job stuck after a container restart. A running worker stops at its next iteration.',
    }),
  },
};

export const ACTION_ORDER: RunAction[] = ['pause', 'resume', 'restart', 'cancel', 'mark_done'];
export const DeleteIcon = Trash2;

function summary(results: BulkResult[], verb: string, skipped: number) {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const parts = [`${ok} run${ok === 1 ? '' : 's'} ${verb}`];
  if (skipped) parts.push(`${skipped} skipped (not applicable)`);
  if (failed.length) parts.push(`${failed.length} failed: ${failed[0].error}`);
  return { text: parts.join(', ') + '.', tone: failed.length ? 'error' as const : 'success' as const };
}

export function useRunActions() {
  const qc = useQueryClient();
  const refresh = (ids: string[]) => {
    qc.invalidateQueries({ queryKey: keys.allRuns });
    qc.invalidateQueries({ queryKey: keys.queue });
    ids.forEach((id) => qc.invalidateQueries({ queryKey: keys.run(id) }));
  };

  /** Applies `action` to the runs it applies to; returns false if the user backed out. */
  const perform = async (runs: Run[], action: RunAction): Promise<boolean> => {
    const meta = ACTION_META[action];
    const eligible = runs.filter((r) => r.actions.includes(action));
    if (!eligible.length) {
      toast('info', `${meta.label} doesn't apply to the selected runs.`);
      return false;
    }
    if (meta.confirm && !(await confirmDialog({ ...meta.confirm(eligible.length), confirmLabel: meta.label }))) return false;
    try {
      const results = eligible.length === 1
        ? await api.act(eligible[0].id, action).then(() => [{ id: eligible[0].id, ok: true }])
        : await api.actMany(eligible.map((r) => r.id), action);
      const s = summary(results, meta.done, runs.length - eligible.length);
      toast(s.tone, s.text);
    } catch (e) {
      toast('error', `${meta.label} failed: ${(e as Error).message}`);
    }
    refresh(eligible.map((r) => r.id));
    return true;
  };

  const remove = async (runs: Run[]): Promise<boolean> => {
    const eligible = runs.filter((r) => r.deletable);
    if (!eligible.length) {
      toast('info', 'Running runs can\u2019t be deleted; cancel them first.');
      return false;
    }
    const ok = await confirmDialog({
      title: `Delete ${plural(eligible.length)}?`,
      message: 'Removes the job record. Checkpoints, event files and videos it wrote stay on disk, and models registered from it are kept.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return false;
    try {
      const results = await api.removeMany(eligible.map((r) => r.id));
      const s = summary(results, 'deleted', runs.length - eligible.length);
      toast(s.tone, s.text);
    } catch (e) {
      toast('error', `Delete failed: ${(e as Error).message}`);
    }
    refresh([]);
    return true;
  };

  return { perform, remove };
}
