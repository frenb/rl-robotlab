import { useEffect, useMemo, useRef, useState } from 'react';
import type { GateRow, WeaknessCell, WeaknessLayer, WeaknessMap } from '../../lib/api';
import { formatNumber } from '../../lib/utils';

type MapData = NonNullable<WeaknessMap['map']>;

const HEAT: [number, number, number][] = [[23, 20, 60], [120, 28, 109], [212, 72, 66], [251, 155, 6], [252, 255, 164]];
const COOL: [number, number, number][] = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
const MAX_HEIGHT = 680;
const PAD = 8;

export function colorAt(t: number, layer: WeaknessLayer): string {
  const stops = layer === 'visits' ? COOL : HEAT;
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function ColorScale({ layer }: { layer: WeaknessLayer }) {
  const stops = Array.from({ length: 11 }, (_, i) => colorAt(i / 10, layer)).join(',');
  const [lo, hi] = layer === 'visits' ? ['quiet', 'busy'] : layer === 'speed' ? ['fast', 'slow'] : ['fine', 'weak'];
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>{lo}</span>
      <span className="h-2 w-32 rounded-full" style={{ background: `linear-gradient(to right, ${stops})` }} />
      <span>{hi}</span>
      <span className="ml-2 inline-block h-2 w-3 rounded-sm bg-muted-foreground/30" /> <span>too few visits to score</span>
    </div>
  );
}

/**
 * The track as the car drove it: one square per grid cell coloured by its
 * score, hotspots outlined and numbered, and goal gates (when the map's
 * ground plane is x/z, as the gate positions are) as rings.
 */
export function WeaknessCanvas({ map, layer, gates, selected, onSelect, focusHotspot }: {
  map: MapData; layer: WeaknessLayer; gates: GateRow[] | null; selected: WeaknessCell | null;
  onSelect: (c: WeaknessCell | null) => void; focusHotspot: number | null;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ cell: WeaknessCell | null; gate: GateRow | null; px: number; py: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { extent, nx, ny, axis_names: axes } = map;
  const spanX = extent.xmax - extent.xmin;
  const spanY = extent.ymax - extent.ymin;
  const height = Math.min(MAX_HEIGHT, Math.round(((width - 2 * PAD) * spanY) / spanX) + 2 * PAD);
  const scale = Math.min((width - 2 * PAD) / spanX, (height - 2 * PAD) / spanY);
  const ox = (width - spanX * scale) / 2;
  const oy = (height - spanY * scale) / 2;
  const toPx = (x: number, y: number): [number, number] => [ox + (x - extent.xmin) * scale, height - oy - (y - extent.ymin) * scale];
  const cw = (spanX / nx) * scale;
  const ch = (spanY / ny) * scale;

  const byKey = useMemo(() => {
    const m = new Map<number, WeaknessCell>();
    map.cells.forEach((c) => m.set(c.iy * nx + c.ix, c));
    return m;
  }, [map, nx]);

  /** Gate positions on the map's axes, when it's the x/z plane they're recorded in. */
  const gatePts = useMemo(() => {
    if (!gates) return [];
    const xi = axes.indexOf('x');
    const zi = axes.indexOf('z');
    if (xi < 0 || zi < 0) return [];
    return gates.filter((g) => g.position).map((g) => {
      const p = [0, 0];
      p[xi] = g.position!.x;
      p[zi] = g.position!.z;
      return { g, x: p[0], y: p[1] };
    });
  }, [gates, axes]);
  const maxRate = Math.max(0.0001, ...gatePts.map((p) => p.g.smoothed_crash_rate));

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = height * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const dark = document.documentElement.classList.contains('dark');

    for (const c of map.cells) {
      const [x, y] = toPx(extent.xmin + c.ix * (spanX / nx), extent.ymin + (c.iy + 1) * (spanY / ny));
      ctx.fillStyle = c.score == null ? (dark ? 'rgba(148,163,184,0.18)' : 'rgba(100,116,139,0.18)') : colorAt(c.score, layer);
      ctx.fillRect(x, y, Math.ceil(cw), Math.ceil(ch));
    }

    // Hotspots: outline the edges of each region where it borders non-members.
    map.hotspots.forEach((h) => {
      const members = new Set(h.member_cells.map(([ix, iy]) => iy * nx + ix));
      const focused = focusHotspot === h.rank;
      ctx.strokeStyle = focused ? '#38bdf8' : dark ? 'rgba(255,255,255,0.9)' : 'rgba(15,23,42,0.85)';
      ctx.lineWidth = focused ? 2.5 : 1.5;
      ctx.beginPath();
      for (const [ix, iy] of h.member_cells) {
        const [x0, y1] = toPx(extent.xmin + ix * (spanX / nx), extent.ymin + iy * (spanY / ny));
        const x1 = x0 + cw;
        const y0 = y1 - ch;
        if (!members.has(iy * nx + ix - 1) || ix === 0) { ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); }
        if (!members.has(iy * nx + ix + 1) || ix === nx - 1) { ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); }
        if (!members.has((iy - 1) * nx + ix)) { ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); }
        if (!members.has((iy + 1) * nx + ix)) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); }
      }
      ctx.stroke();
    });

    for (const { g, x, y } of gatePts) {
      const [px, py] = toPx(x, y);
      const t = g.smoothed_crash_rate / maxRate;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = dark ? 'rgba(15,23,42,0.85)' : 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(${Math.round(56 + 188 * t)},${Math.round(189 - 126 * t)},${Math.round(248 - 154 * t)},1)`;
      ctx.stroke();
      ctx.fillStyle = dark ? '#e2e8f0' : '#0f172a';
      ctx.font = '600 8px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(g.index), px, py + 0.5);
    }

    map.hotspots.slice(0, 9).forEach((h) => {
      const [px, py] = toPx(h.peak_at.x, h.peak_at.y);
      ctx.beginPath();
      ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.fillStyle = focusHotspot === h.rank ? '#0284c7' : '#e11d48';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 10px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(h.rank), px, py + 0.5);
    });

    if (selected) {
      const [x, y] = toPx(extent.xmin + selected.ix * (spanX / nx), extent.ymin + (selected.iy + 1) * (spanY / ny));
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 1, y - 1, cw + 2, ch + 2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, layer, width, height, gatePts, selected, focusHotspot]);

  const locate = (e: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const gate = gatePts.find((p) => {
      const [gx, gy] = toPx(p.x, p.y);
      return Math.hypot(gx - px, gy - py) <= 7;
    })?.g ?? null;
    const x = extent.xmin + (px - ox) / scale;
    const y = extent.ymin + (height - oy - py) / scale;
    const ix = Math.floor((x - extent.xmin) / (spanX / nx));
    const iy = Math.floor((y - extent.ymin) / (spanY / ny));
    const cell = ix >= 0 && iy >= 0 && ix < nx && iy < ny ? byKey.get(iy * nx + ix) ?? null : null;
    return { cell, gate, px, py };
  };

  return (
    <div ref={wrap} className="relative w-full">
      <canvas
        ref={canvas}
        style={{ width, height }}
        className="cursor-crosshair"
        onMouseMove={(e) => setHover(locate(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => { const l = locate(e); onSelect(l.cell); }}
      />
      <span className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-muted-foreground">{axes[0]} →, {axes[1]} ↑</span>
      {hover && (hover.cell || hover.gate) && (
        <div
          className="pointer-events-none absolute z-10 w-56 rounded-md border bg-card/95 px-2.5 py-2 text-xs shadow-lg backdrop-blur"
          style={{ left: Math.min(hover.px + 14, width - 230), top: Math.max(0, hover.py - 10) }}
        >
          {hover.gate ? <GateTip g={hover.gate} /> : <CellTip c={hover.cell!} axes={axes} />}
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-3"><span className="text-muted-foreground">{k}</span><span className="font-mono tabular-nums">{v}</span></div>;
}

export function CellTip({ c, axes }: { c: WeaknessCell; axes: string[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="mb-0.5 font-medium">{axes[0]}={formatNumber(c.x)} {axes[1]}={formatNumber(c.y)}</p>
      <Row k="Score" v={c.score == null ? 'not scored' : formatNumber(c.score, 2)} />
      <Row k="Visits" v={formatNumber(c.visits)} />
      <Row k="Crashes here" v={`${c.crashes} (${formatNumber(c.crash_rate * 100, 1)}%)`} />
      <Row k="Within 30 steps of a crash" v={`${formatNumber(c.risk * 100, 1)}%`} />
      <Row k="Speed vs track median" v={c.speed_vs_track_median == null ? '—' : `${formatNumber(c.speed_vs_track_median, 2)}×`} />
      <Row k="Goals reached here" v={String(c.goals)} />
    </div>
  );
}

function GateTip({ g }: { g: GateRow }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="mb-0.5 font-medium">{g.gate} · {formatNumber(g.lap_fraction * 100, 0)}% round the lap</p>
      <Row k="Attempts" v={String(g.attempts)} />
      <Row k="Crashes" v={`${g.crashes} (${formatNumber(g.crash_rate * 100, 1)}%)`} />
      <Row k="95% range" v={`${formatNumber(g.crash_rate_ci95[0] * 100, 1)}–${formatNumber(g.crash_rate_ci95[1] * 100, 1)}%`} />
      <Row k="Steps to clear vs median" v={g.steps_to_clear_vs_median == null ? '—' : `${formatNumber(g.steps_to_clear_vs_median, 2)}×`} />
    </div>
  );
}
