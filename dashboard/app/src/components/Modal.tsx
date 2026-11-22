import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { cn } from '../lib/utils';

export function Modal({ title, description, onClose, footer, children, className }: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center overflow-y-auto bg-black/40 p-4 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={cn('flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col rounded-xl border bg-card shadow-xl', className)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
          </div>
          <button onClick={onClose} className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
