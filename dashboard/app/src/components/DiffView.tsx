import { useMemo } from 'react';
import { diffLines } from '../lib/diff';
import { cn } from '../lib/utils';

/** Line diff of a -> b; unchanged runs longer than `context` lines around a change fold away. */
export function DiffView({ a, b, context, className }: { a: string; b: string; context?: number; className?: string }) {
  const lines = useMemo(() => diffLines(a, b), [a, b]);
  const shown = useMemo(() => {
    if (context == null) return lines.map((l) => ({ ...l, gap: 0 }));
    const near = lines.map(() => false);
    lines.forEach((l, i) => {
      if (l.kind === 'same') return;
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) near[j] = true;
    });
    const out: { kind: string; text: string; gap: number }[] = [];
    let gap = 0;
    lines.forEach((l, i) => {
      if (near[i]) {
        if (gap) out.push({ kind: 'gap', text: '', gap });
        gap = 0;
        out.push({ ...l, gap: 0 });
      } else gap++;
    });
    if (gap) out.push({ kind: 'gap', text: '', gap });
    return out;
  }, [lines, context]);
  return (
    <div className={cn('overflow-auto rounded-lg border bg-muted/30 font-mono text-[11px] leading-5', className)}>
      {shown.map((l, i) => (l.kind === 'gap' ? (
        <div key={i} className="bg-muted px-3 text-muted-foreground">⋯ {l.gap} unchanged line{l.gap === 1 ? '' : 's'}</div>
      ) : (
        <div
          key={i}
          className={cn(
            'whitespace-pre px-3',
            l.kind === 'add' && 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
            l.kind === 'del' && 'bg-rose-500/15 text-rose-800 dark:text-rose-300',
          )}
        >
          {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}{l.text}
        </div>
      )))}
    </div>
  );
}

export function changedLines(a: string, b: string): number {
  return diffLines(a, b).filter((l) => l.kind !== 'same').length;
}
