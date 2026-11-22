import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Copy, Info } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { CellTip, ColorScale, WeaknessCanvas } from '../components/insights/WeaknessCanvas';
import { toast } from '../components/feedback';
import { StatusBadge, runTitle } from '../components/RunBits';
import { Badge, Button, Card, CardHeader, Empty, Field, Input, Select, Spinner } from '../components/ui';
import { api, insightsApi, keys, type GateStats, type WeaknessCell, type WeaknessLayer, type WeaknessMap } from '../lib/api';
import { cn, formatNumber, shortId, timeAgo } from '../lib/utils';

export interface InsightsSearch { run?: string; layer?: WeaknessLayer }
export const WEAKNESS_LAYERS: { id: WeaknessLayer; label: string; about: string }[] = [
  { id: 'weakness', label: 'Weakness', about: 'Weighted blend of crash rate, slowness and pre-crash risk' },
  { id: 'crash', label: 'Crashes', about: 'Episodes that ended in this cell, per visit' },
  { id: 'speed', label: 'Slowness', about: 'Slow is hot. The start straight always reads slow, since episodes begin from rest' },
  { id: 'risk', label: 'Pre-crash risk', about: 'Share of visits within 30 steps of a crash: the approaches that end badly' },
  { id: 'visits', label: 'Traffic', about: 'How often the car passed through' },
];
const CAR = 'roboracer';
const DEBOUNCE_MS = 350;

function useDebounced<T>(value: T, ms = DEBOUNCE_MS): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function InsightsPage() {
  const search = useSearch({ strict: false }) as InsightsSearch;
  const navigate = useNavigate();
  const layer = search.layer ?? 'weakness';
  const setSearch = (patch: Partial<InsightsSearch>) => navigate({ to: '/insights', search: { ...search, ...patch }, replace: true });

  const [bins, setBins] = useState(48);
  const [limit, setLimit] = useState(500);
  const [minVisits, setMinVisits] = useState(3);
  const [threshold, setThreshold] = useState(0.6);
  const [weights, setWeights] = useState({ crash: 0.5, slow: 0.3, risk: 0.2 });
  const [selected, setSelected] = useState<WeaknessCell | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [showGates, setShowGates] = useState(true);
  const [start, setStart] = useState({ weak_share: 0.25, lead: 1, top_k: 5 });

  const runs = useQuery({
    queryKey: keys.runs({ robot: CAR, type: ['TRAIN'], limit: 100 }),
    queryFn: () => api.runs({ robot: CAR, type: ['TRAIN'], limit: 100 }),
    staleTime: 30_000,
  });

  const wq = useDebounced({
    run: search.run, layer, bins, limit, min_visits: minVisits, threshold, w_crash: weights.crash, w_slow: weights.slow, w_risk: weights.risk,
  });
  const weakness = useQuery({ queryKey: keys.weakness(wq), queryFn: () => insightsApi.weakness(wq), placeholderData: keepPreviousData, staleTime: 60_000 });
  const gq = useDebounced({ run: search.run, ...start });
  const gates = useQuery({ queryKey: keys.gates(gq), queryFn: () => insightsApi.gates(gq), placeholderData: keepPreviousData, staleTime: 60_000 });

  const runId = weakness.data?.run_id ?? search.run;
  useEffect(() => { setSelected(null); setFocus(null); }, [runId, bins]);
  const map = weakness.data?.map ?? null;
  const layerInfo = WEAKNESS_LAYERS.find((l) => l.id === layer)!;
  const runOptions = runs.data?.items ?? [];

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Insights</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Where on the track a car run crashes, slows down or heads into trouble, from its most recent episodes.
          </p>
        </div>
      </div>

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Run" className="min-w-72 flex-1">
          <Select value={runId ?? ''} onChange={(e) => setSearch({ run: e.target.value || undefined })} className="h-8 text-xs">
            {runId && !runOptions.some((r) => r.id === runId) && <option value={runId}>{weakness.data?.run ? runTitle(weakness.data.run) : 'Run'} · {shortId(runId)}</option>}
            {runOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {runTitle(r)} · {r.status === 'IN_PROGRESS' ? 'running' : r.status?.toLowerCase()} · {timeAgo(r.created_at)} · {shortId(r.id)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Show">
          <Select value={layer} onChange={(e) => setSearch({ layer: e.target.value as WeaknessLayer })} className="h-8 text-xs" title={layerInfo.about}>
            {WEAKNESS_LAYERS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </Select>
        </Field>
        <Field label="Episodes" hint="Most recent">
          <Input type="number" min={10} max={5000} step={50} value={limit} onChange={(e) => setLimit(Number(e.target.value) || 500)} className="h-8 w-24 text-xs" />
        </Field>
        <Field label="Grid">
          <Select value={bins} onChange={(e) => setBins(Number(e.target.value))} className="h-8 text-xs">
            {[24, 32, 48, 64, 96, 128].map((b) => <option key={b} value={b}>{b}×{b}</option>)}
          </Select>
        </Field>
        <Slider label="Min visits per cell" value={minVisits} min={1} max={30} step={1} onChange={setMinVisits} format={(v) => String(v)} />
        <Slider label="Hotspot threshold" value={threshold} min={0.3} max={0.95} step={0.05} onChange={setThreshold} format={(v) => v.toFixed(2)} />
        {layer === 'weakness' && <>
          <Slider label="Crash weight" value={weights.crash} min={0} max={1} step={0.05} onChange={(v) => setWeights((w) => ({ ...w, crash: v }))} format={(v) => v.toFixed(2)} />
          <Slider label="Slowness weight" value={weights.slow} min={0} max={1} step={0.05} onChange={(v) => setWeights((w) => ({ ...w, slow: v }))} format={(v) => v.toFixed(2)} />
          <Slider label="Risk weight" value={weights.risk} min={0} max={1} step={0.05} onChange={(v) => setWeights((w) => ({ ...w, risk: v }))} format={(v) => v.toFixed(2)} />
        </>}
      </Card>

      {weakness.error ? <Empty title="Couldn't load the weakness map">{(weakness.error as Error).message}</Empty>
        : weakness.isLoading ? <div className="grid place-items-center py-24"><Spinner /></div>
          : (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <Card className="flex min-w-0 flex-col gap-3 p-4">
                <RunHeader data={weakness.data!} fetching={weakness.isFetching} />
                {!map ? (
                  <Empty title="No trajectory data for this run yet">Only finished episodes record a path, so a run that just started has nothing to show.</Empty>
                ) : <>
                  <WeaknessCanvas map={map} layer={layer} gates={showGates ? gates.data?.gates ?? null : null} selected={selected} onSelect={setSelected} focusHotspot={focus} />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <ColorScale layer={layer} />
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                      <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={showGates} onChange={(e) => setShowGates(e.target.checked)} />
                      Goal gates (ring colour = crash rate)
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">{layerInfo.about}. Click a cell to pin its numbers.</p>
                </>}
              </Card>
              <div className="flex min-w-0 flex-col gap-5">
                {selected && map && (
                  <Card className="p-4">
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-sm font-semibold">Pinned cell</p>
                      <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelected(null)}>Clear</button>
                    </div>
                    <CellTip c={selected} axes={map.axis_names} />
                  </Card>
                )}
                {map && <Hotspots map={map} threshold={threshold} focus={focus} onFocus={setFocus} />}
              </div>
            </div>
          )}

      <GateSection gates={gates.data} loading={gates.isLoading} fetching={gates.isFetching} error={gates.error} start={start} onStart={setStart} />
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string;
}) {
  return (
    <label className="flex w-36 flex-col gap-1.5">
      <span className="flex justify-between text-xs font-medium text-muted-foreground"><span>{label}</span><span className="font-mono">{format(value)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-8 accent-primary" />
    </label>
  );
}

function RunHeader({ data, fetching }: { data: WeaknessMap; fetching: boolean }) {
  const m = data.map;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {data.run ? (
        <>
          <Link to="/runs/$runId" params={{ runId: data.run.id }} className="text-sm font-medium text-foreground hover:underline">{runTitle(data.run)}</Link>
          <StatusBadge status={data.run.status} />
          {data.run.gym_name && data.run.gym_name !== runTitle(data.run) && <span>{data.run.gym_name}</span>}
        </>
      ) : <span className="text-sm font-medium text-foreground">Run {shortId(data.run_id)} <span className="text-xs font-normal text-muted-foreground">(deleted; its logs remain)</span></span>}
      <span>· {formatNumber(data.episodes)} episodes</span>
      {m && <span>· {formatNumber(m.crashed_episodes)} crashed, {formatNumber(m.goal_episodes)} reached a goal</span>}
      {fetching && <Spinner className="h-3 w-3" />}
    </div>
  );
}

function Hotspots({ map, threshold, focus, onFocus }: { map: NonNullable<WeaknessMap['map']>; threshold: number; focus: number | null; onFocus: (n: number | null) => void }) {
  const list = map.hotspots.slice(0, 9);
  return (
    <Card>
      <CardHeader title="Hotspots" description={`Connected cells scoring ${threshold.toFixed(2)} or more, heaviest first.`} />
      <div className="p-2">
        {!list.length ? (
          <p className="px-2 pb-2 text-sm text-muted-foreground">Nothing scores {threshold.toFixed(2)} or more; lower the threshold to see milder weak spots.</p>
        ) : list.map((h) => (
          <button
            key={h.rank}
            className={cn('flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left text-xs hover:bg-muted/60', focus === h.rank && 'bg-muted')}
            onMouseEnter={() => onFocus(h.rank)}
            onMouseLeave={() => onFocus(null)}
          >
            <span className="flex items-center gap-2">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose-600 text-[10px] font-bold text-white">{h.rank}</span>
              <span className="font-medium">{h.where}</span>
              {h.thin_evidence && <Badge tone="amber" className="px-1.5 py-0 text-[10px]">thin evidence</Badge>}
            </span>
            <span className="pl-7 text-muted-foreground">
              {h.cells} cell{h.cells === 1 ? '' : 's'} · peak {h.peak_score.toFixed(2)} · {h.crashes} crash{h.crashes === 1 ? '' : 'es'} in {formatNumber(h.visits)} visits
              {h.speed_vs_track_median != null && ` · ${h.speed_vs_track_median.toFixed(2)}× track speed`}
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function GateSection({ gates, loading, fetching, error, start, onStart }: {
  gates?: GateStats; loading: boolean; fetching: boolean; error: unknown;
  start: { weak_share: number; lead: number; top_k: number }; onStart: (s: { weak_share: number; lead: number; top_k: number }) => void;
}) {
  const title = (t: ReactNode) => <span className="flex items-center gap-2">{t}{fetching && <Spinner className="h-3 w-3" />}</span>;
  if (error) return <Empty title="Couldn't load gate statistics">{(error as Error).message}</Empty>;
  if (loading || !gates) {
    return <Card className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Spinner /> Grouping the run's driving by goal gate…</Card>;
  }
  if (!gates.gates.length) return <Empty title="No gate-to-gate driving logs for this run yet" />;
  const s = gates.start;
  const hardest = gates.hardest_gates.filter((g) => g.crashes > 0).slice(0, 10);
  const rangeMax = Math.max(0.01, ...hardest.map((g) => g.crash_rate_ci95[1]));
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader
          title={title('Hardest gates')}
          description={`Crashes on the way to each of the ${gates.gate_count} goal gates over the last ${formatNumber(gates.attempts ?? 0)} stretches (track average ${formatNumber((gates.track_crash_rate ?? 0) * 100, 1)}%). Ranked by the low end of the 95% range so thinly sampled gates don't dominate.`}
        />
        <div className="overflow-x-auto p-4 pt-3">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Gate</th>
                <th className="px-3 py-1.5 font-medium">Where</th>
                <th className="px-3 py-1.5 text-right font-medium">Attempts</th>
                <th className="px-3 py-1.5 text-right font-medium">Crash rate</th>
                <th className="py-1.5 pl-3 font-medium">95% range</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {hardest.map((g) => (
                <tr key={g.index}>
                  <td className="py-1.5 pr-3 font-medium">{g.gate}<span className="ml-1.5 text-xs font-normal text-muted-foreground">{formatNumber(g.lap_fraction * 100, 0)}%</span></td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{g.where ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums">{g.attempts}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums">{formatNumber(g.crash_rate * 100, 1)}%</td>
                  <td className="py-1.5 pl-3"><RangeBar lo={g.crash_rate_ci95[0]} hi={g.crash_rate_ci95[1]} avg={gates.track_crash_rate ?? 0} max={rangeMax} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!hardest.length && <p className="py-2 text-sm text-muted-foreground">No crashes on the way to any gate in this window.</p>}
          {gates.hardest_sections.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-muted-foreground">Hard sections (consecutive gates above the track average)</p>
              <ul className="mt-1 flex flex-col gap-1 text-xs">
                {gates.hardest_sections.slice(0, 5).map((sec) => (
                  <li key={sec.gates} className="flex justify-between gap-3">
                    <span><span className="font-medium">{sec.gates}</span>{sec.where && <span className="text-muted-foreground"> · {sec.where}</span>}</span>
                    <span className="font-mono tabular-nums text-muted-foreground">{formatNumber(sec.crash_rate * 100, 1)}% of {sec.attempts}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {gates.gates_never_attempted?.length ? <p className="mt-3 text-xs text-muted-foreground">Never attempted in this window: {gates.gates_never_attempted.map((i) => `Goal-${i}`).join(', ')}</p> : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Where to start the car"
          description="A start distribution for weakness-focused training: a share of resets begin a few gates before the hardest gates, the rest stay uniform so the rest of the track isn't forgotten."
        />
        <div className="flex flex-col gap-3 p-4 pt-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex w-40 flex-col gap-1.5">
              <span className="flex justify-between text-xs font-medium text-muted-foreground"><span>Aimed share</span><span className="font-mono">{Math.round(start.weak_share * 100)}%</span></span>
              <input type="range" min={0} max={1} step={0.05} value={start.weak_share} onChange={(e) => onStart({ ...start, weak_share: Number(e.target.value) })} className="h-8 accent-primary" />
            </label>
            <Field label="Run-up gates"><Input type="number" min={0} max={10} value={start.lead} onChange={(e) => onStart({ ...start, lead: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })} className="h-8 w-20 text-xs" /></Field>
            <Field label="Targets"><Input type="number" min={1} max={50} value={start.top_k} onChange={(e) => onStart({ ...start, top_k: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} className="h-8 w-20 text-xs" /></Field>
          </div>
          {!s ? <p className="text-sm text-muted-foreground">No gate is reliably harder than the track average; keep uniform starts.</p> : <>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="py-1.5 pr-3 font-medium">Hard gate</th><th className="px-3 py-1.5 font-medium">Start at</th><th className="px-3 py-1.5 text-right font-medium">Smoothed crash rate</th><th className="py-1.5 pl-3 text-right font-medium">Share of aimed starts</th></tr>
              </thead>
              <tbody className="divide-y">
                {s.targets.map((t) => (
                  <tr key={t.hard_index}>
                    <td className="py-1.5 pr-3 font-medium">{t.hard_gate}</td>
                    <td className="px-3 py-1.5">{t.start_at}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums">{formatNumber(t.smoothed_crash_rate * 100, 1)}%</td>
                    <td className="py-1.5 pl-3 text-right font-mono text-xs tabular-nums">{Math.round(t.weak_share_of_this_target * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground">Every other gate starts with probability {formatNumber(s.uniform_probability_other_gates * 100, 2)}%. Keep evaluation on uniform starts for a fair comparison.</p>
            <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>The trainer can't apply this yet: Unity picks a uniformly random start gate on every reset. These are the experiment fields it would take.</span>
            </div>
            <div className="relative">
              <pre className="overflow-auto rounded-md bg-muted/50 p-2 pr-10 font-mono text-xs">{JSON.stringify(s.proposed_experiment_fields, null, 2)}</pre>
              <Button size="icon" variant="ghost" className="absolute right-1 top-1 h-7 w-7" title="Copy"
                onClick={() => navigator.clipboard.writeText(JSON.stringify(s.proposed_experiment_fields, null, 2)).then(() => toast('success', 'Copied'))}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </>}
        </div>
      </Card>
    </div>
  );
}

function RangeBar({ lo, hi, avg, max }: { lo: number; hi: number; avg: number; max: number }) {
  const pct = (v: number) => `${(v / max) * 100}%`;
  return (
    <div className="relative h-2 w-28 rounded-full bg-muted" title={`${formatNumber(lo * 100, 1)}–${formatNumber(hi * 100, 1)}%`}>
      <div className="absolute h-full rounded-full bg-rose-500/70" style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})` }} />
      <div className="absolute -top-0.5 h-3 w-px bg-foreground/60" style={{ left: pct(avg) }} title="Track average" />
    </div>
  );
}
