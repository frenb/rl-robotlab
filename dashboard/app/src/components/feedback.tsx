// Toasts and a confirm dialog, callable from anywhere; <FeedbackHost/> renders both.
import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Button } from './ui';

type ToastTone = 'success' | 'error' | 'info';
interface Toast { id: number; tone: ToastTone; message: ReactNode }
interface Confirm {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const TOAST_MS = 5000;
let toasts: Toast[] = [];
let pending: Confirm | null = null;
let nextId = 1;
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function toast(tone: ToastTone, message: ReactNode) {
  const id = nextId++;
  toasts = [...toasts, { id, tone, message }];
  emit();
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, tone === 'error' ? TOAST_MS * 2 : TOAST_MS);
}

export function confirmDialog(opts: Omit<Confirm, 'resolve'>): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { ...opts, resolve };
    emit();
  });
}

function settle(ok: boolean) {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(ok);
}

const ICONS = { success: CheckCircle2, error: XCircle, info: Info };
const TONES = {
  success: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-rose-600 dark:text-rose-400',
  info: 'text-sky-600 dark:text-sky-400',
};

function ConfirmModal({ c }: { c: Confirm }) {
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ok.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') settle(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [c]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-[2px]" onMouseDown={() => settle(false)}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-xl border bg-card p-5 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{c.title}</h2>
        {c.message && <div className="mt-2 text-sm text-muted-foreground">{c.message}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => settle(false)}>Go back</Button>
          <Button
            ref={ok}
            variant="primary"
            className={cn(c.danger && 'bg-rose-600 text-white')}
            onClick={() => settle(true)}
          >
            {c.confirmLabel ?? 'Confirm'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function FeedbackHost() {
  useSyncExternalStore(subscribe, () => version);
  return (
    <>
      {pending && <ConfirmModal c={pending} />}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => {
          const Icon = ICONS[t.tone];
          return (
            <div key={t.id} className="pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-card px-3.5 py-3 text-sm shadow-lg">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONES[t.tone])} />
              <div className="min-w-0 break-words">{t.message}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}
