import { Link, useNavigate } from '@tanstack/react-router';
import { CopyPlus, MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Run } from '../../lib/api';
import { ACTION_META, ACTION_ORDER, DeleteIcon, useRunActions } from '../../lib/actions';
import { Button } from '../ui';

/** Pause / resume / restart / cancel as buttons; mark done and delete in the overflow menu. */
export function RunActions({ run }: { run: Run }) {
  const { perform, remove } = useRunActions();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const run1 = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMenu(false);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const main = ACTION_ORDER.filter((a) => a !== 'mark_done' && run.actions.includes(a));

  return (
    <div className="flex items-center gap-2">
      {main.map((a) => {
        const { label, icon: Icon } = ACTION_META[a];
        return (
          <Button key={a} disabled={busy} onClick={() => run1(() => perform([run], a))}>
            <Icon className="h-4 w-4" /> {label}
          </Button>
        );
      })}
      <Link
        to="/runs/new"
        search={{ from: run.id }}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-3.5 text-sm font-medium hover:bg-muted"
        title="Open the launch form filled in from this run"
      >
        <CopyPlus className="h-4 w-4" /> Clone
      </Link>
      <div className="relative" ref={menuRef}>
        <Button size="icon" className="h-9 w-9" disabled={busy} onClick={() => setMenu(!menu)} title="More actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
        {menu && (
          <div className="absolute right-0 z-20 mt-1 w-44 rounded-lg border bg-card p-1 shadow-lg">
            {run.actions.includes('mark_done') && (
              <MenuItem icon={ACTION_META.mark_done.icon} onClick={() => run1(() => perform([run], 'mark_done'))}>
                Mark done
              </MenuItem>
            )}
            <MenuItem
              icon={DeleteIcon}
              danger
              disabled={!run.deletable}
              title={run.deletable ? undefined : 'Cancel the run before deleting it'}
              onClick={() => run1(async () => {
                if (await remove([run])) navigate({ to: '/runs' });
              })}
            >
              Delete
            </MenuItem>
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({ icon: Icon, children, danger, disabled, title, onClick }: {
  icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; danger?: boolean;
  disabled?: boolean; title?: string; onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={
        'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-default disabled:opacity-50 '
        + (danger ? 'text-rose-600 dark:text-rose-400' : '')
      }
    >
      <Icon className="h-4 w-4" /> {children}
    </button>
  );
}
