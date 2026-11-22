import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 ' +
    'cursor-pointer whitespace-nowrap',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:opacity-90',
        outline: 'border bg-card hover:bg-muted',
        ghost: 'hover:bg-muted',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-9 px-3.5',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

export function Button({
  className, variant, size, ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border bg-card shadow-sm', className)} {...props} />;
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pt-4">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 rounded-md border bg-card px-3 text-sm placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-9 min-w-0 cursor-pointer rounded-md border bg-card px-2.5 text-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-16 rounded-md border bg-card px-3 py-2 text-sm placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  );
}

/** A labelled form row with its hint or, when the server rejected it, the reason. */
export function Field({ label, hint, error, children, className }: {
  label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string;
}) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-rose-600 dark:text-rose-400">{error}</span>
      ) : hint ? (
        <span className="text-xs text-muted-foreground/80">{hint}</span>
      ) : null}
    </label>
  );
}

const TONES = {
  neutral: 'bg-muted text-muted-foreground',
  blue: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
  green: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  red: 'bg-rose-500/12 text-rose-700 dark:text-rose-300',
  violet: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Progress({ value, className }: { value: number | null; className?: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${v}%` }} />
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground', className)}
    />
  );
}
