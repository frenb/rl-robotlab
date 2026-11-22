import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { formatNumber } from '../lib/utils';

export const PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#84cc16', '#ec4899',
  '#0ea5e9', '#f97316', '#14b8a6', '#78716c',
];

export interface Line {
  label: string;
  color: string;
  steps: number[];
  values: number[];
  /** Range of each bucketed point; drawn as a faint band. */
  min?: number[];
  max?: number[];
}

/** TensorBoard's smoothing: a debiased exponential moving average. */
export function smooth(values: number[], weight: number): number[] {
  if (weight <= 0) return values;
  let last = 0;
  let n = 0;
  return values.map((v) => {
    last = last * weight + (1 - weight) * v;
    n++;
    return last / (1 - Math.pow(weight, n));
  });
}

function useIsDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function useWidth(ref: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const obs = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [ref]);
  return width;
}

interface Hover {
  step: number;
  values: { label: string; color: string; value: number | null }[];
}

export function MetricChart({
  title, lines, smoothing = 0, height = 190, xLabel = 'step', xDigits = 0,
}: {
  title: string;
  lines: Line[];
  smoothing?: number;
  height?: number;
  xLabel?: string;
  /** Decimals on x tick labels and the hover readout. */
  xDigits?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const dark = useIsDark();
  const [hover, setHover] = useState<Hover | null>(null);

  const built = useMemo(() => {
    const xs = Array.from(new Set(lines.flatMap((l) => l.steps))).sort((a, b) => a - b);
    const index = new Map(xs.map((x, i) => [x, i]));
    const data: (number | null)[][] = [xs];
    const series: uPlot.Series[] = [{ label: xLabel }];
    const bands: uPlot.Band[] = [];
    const main: { idx: number; label: string; color: string }[] = [];
    for (const line of lines) {
      const align = (arr: number[]) => {
        const out: (number | null)[] = new Array(xs.length).fill(null);
        line.steps.forEach((s, i) => { out[index.get(s)!] = arr[i]; });
        return out;
      };
      if (line.min && line.max) {
        data.push(align(line.min), align(line.max));
        const lo = data.length - 2;
        series.push({ stroke: 'transparent', points: { show: false } }, { stroke: 'transparent', points: { show: false } });
        bands.push({ series: [lo + 1, lo], fill: line.color + '1f' });
      }
      if (smoothing > 0) {
        data.push(align(line.values));
        series.push({ stroke: line.color + '40', width: 1, points: { show: false }, spanGaps: true });
      }
      data.push(align(smooth(line.values, smoothing)));
      series.push({ stroke: line.color, width: 1.75, points: { show: false }, spanGaps: true });
      main.push({ idx: data.length - 1, label: line.label, color: line.color });
    }
    return { xs, data, series, bands, main };
  }, [lines, smoothing, xLabel]);

  useEffect(() => {
    if (!box.current || !width || !built.xs.length) return;
    const axis = dark ? '#a1a1aa' : '#71717a';
    const grid = dark ? '#ffffff12' : '#0000000d';
    const axisOpts: uPlot.Axis = {
      stroke: axis,
      grid: { stroke: grid, width: 1 },
      ticks: { show: false },
      font: '11px Inter, system-ui, sans-serif',
    };
    const chart = new uPlot(
      {
        width,
        height,
        series: built.series,
        bands: built.bands,
        legend: { show: false },
        cursor: { drag: { x: true, y: false }, points: { size: 6 } },
        scales: { x: { time: false } },
        axes: [
          { ...axisOpts, values: (_u, ticks) => ticks.map((t) => formatNumber(t, xDigits)) },
          { ...axisOpts, size: 52, values: (_u, ticks) => ticks.map((t) => formatNumber(t)) },
        ],
        hooks: {
          setCursor: [
            (u) => {
              const i = u.cursor.idx;
              if (i == null) {
                setHover(null);
                return;
              }
              setHover({
                step: built.xs[i],
                values: built.main.map((m) => ({ label: m.label, color: m.color, value: built.data[m.idx][i] })),
              });
            },
          ],
        },
      },
      built.data as uPlot.AlignedData,
      box.current,
    );
    return () => chart.destroy();
  }, [built, width, height, dark, xDigits]);

  const latest = built.main.map((m) => {
    const col = built.data[m.idx];
    for (let i = col.length - 1; i >= 0; i--) if (col[i] != null) return { ...m, value: col[i] };
    return { ...m, value: null };
  });
  const readout = hover ? hover.values : latest;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <p className="min-w-0 truncate font-mono text-xs font-medium" title={title}>{title}</p>
        <div className="flex flex-wrap items-baseline justify-end gap-x-2 text-xs tabular-nums text-muted-foreground">
          {hover && <span>{xLabel} {formatNumber(hover.step, xDigits)}</span>}
          {readout.map((r) => (
            <span key={r.label} className="font-medium" title={r.label} style={{ color: lines.length > 1 ? r.color : undefined }}>
              {formatNumber(r.value)}
            </span>
          ))}
        </div>
      </div>
      <div ref={box} className="min-w-0" style={{ height }}>
        {!built.xs.length && (
          <div className="grid h-full place-items-center text-xs text-muted-foreground">No points yet</div>
        )}
      </div>
    </div>
  );
}
