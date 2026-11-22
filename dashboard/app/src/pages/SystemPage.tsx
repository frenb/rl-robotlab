import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ExternalLink, Pause, Play, RefreshCw, Terminal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from '../components/feedback';
import { LogView } from '../components/run/LogsTab';
import { RobotBadge, runTitle } from '../components/RunBits';
import { Badge, Button, Card, CardHeader, Empty, Spinner } from '../components/ui';
import { api, keys, systemApi, type SystemStatus } from '../lib/api';
import { cn, formatBytes, formatNumber, timeAgo } from '../lib/utils';

const POLL_MS = 15_000;
/** A volume this full, or with this little left, gets a warning. */
const DISK_WARN_FRACTION = 0.05;
const DISK_WARN_BYTES = 20 * 1024 ** 3;
/** A service log written to this recently is followed live. */
const LIVE_LOG_MS = 10 * 60 * 1000;

const lowDisk = (v: SystemStatus['volumes'][number]) =>
  v.total_bytes != null && v.free_bytes != null && (v.free_bytes < DISK_WARN_BYTES || v.free_bytes / v.total_bytes < DISK_WARN_FRACTION);

export function SystemPage() {
  const status = useQuery({ queryKey: keys.system, queryFn: systemApi.status, refetchInterval: POLL_MS });
  const s = status.data;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">System</h1>
          <p className="mt-1 text-sm text-muted-foreground">Workers, the queue, storage, the Unity clients, gym releases and the workers' live output.</p>
        </div>
        {s && <span className="text-xs text-muted-foreground">Dashboard up since {timeAgo(s.dashboard.started_at)} · Node {s.dashboard.node}</span>}
      </div>

      {status.error ? <Empty title="Couldn't load the system status">{(status.error as Error).message}</Empty>
        : !s ? <div className="grid place-items-center py-24"><Spinner /></div>
          : <>
            <Alerts s={s} />
            <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <Workers s={s} />
              <Queue s={s} />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <Storage s={s} />
              <Database s={s} />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <Unity s={s} />
              <ReleasesCard />
            </div>
            <ServiceLogs s={s} />
          </>}
    </div>
  );
}

function Alerts({ s }: { s: SystemStatus }) {
  const items: ReactNode[] = [];
  s.volumes.filter(lowDisk).forEach((v) => items.push(
    <span key={v.path}>The disk behind <b>{v.label}</b> ({v.path}) has only {formatBytes(v.free_bytes)} free of {formatBytes(v.total_bytes)}. It's a host drive, so anything else on it counts too. Checkpoints, exports and logs fail when it fills; free space on the host or delete unused models on the Models page.</span>,
  ));
  s.workers.filter((w) => w.registered && !w.online).forEach((w) => items.push(
    <span key={w.robot}><b>{w.display_name}</b> worker is offline{w.last_seen ? ` (last heartbeat ${timeAgo(w.last_seen)})` : ' (never seen)'}; its queued runs won't start.</span>,
  ));
  if (!s.mongo.ok) items.push(<span key="mongo"><b>MongoDB</b> isn't answering: {s.mongo.error}</span>);
  if (s.queue.paused) items.push(<span key="queue">The <b>queue is paused</b>: no new runs will start until it's resumed.</span>);
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{it}
        </div>
      ))}
    </div>
  );
}

function Dot({ on }: { on: boolean }) {
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', on ? 'bg-emerald-500' : 'bg-rose-500')} />;
}

function Workers({ s }: { s: SystemStatus }) {
  return (
    <Card>
      <CardHeader title="Workers" description="One queue worker per robot, each sending a heartbeat every 30 seconds; offline after two minutes of silence." />
      <div className="grid gap-3 p-4 pt-3 sm:grid-cols-3">
        {s.workers.map((w) => (
          <div key={w.robot} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Dot on={w.online} />
              <RobotBadge robot={w.robot} />
              <span className="ml-auto text-xs text-muted-foreground">{w.online ? 'online' : 'offline'}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {w.last_seen ? `Heartbeat ${timeAgo(w.last_seen)}` : 'Never seen'}{w.host && <> · <span className="font-mono">{w.host.slice(0, 12)}</span></>}
            </p>
            {w.running.length ? w.running.map((r) => (
              <Link key={r.id} to="/runs/$runId" params={{ runId: r.id }} className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/50 px-2 py-1.5 text-xs hover:bg-muted">
                <span className="truncate font-medium">{runTitle(r)}</span>
                <span className="flex items-center gap-2">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-primary" style={{ width: `${Math.min(100, r.percent_complete ?? 0)}%` }} /></span>
                  <span className="font-mono tabular-nums text-muted-foreground">{formatNumber(r.percent_complete ?? 0, 0)}%</span>
                </span>
              </Link>
            )) : <p className="text-xs text-muted-foreground">Idle</p>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Queue({ s }: { s: SystemStatus }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await api.setQueuePaused(!s.queue.paused);
      await qc.invalidateQueries({ queryKey: keys.system });
      qc.invalidateQueries({ queryKey: keys.queue });
      qc.invalidateQueries({ queryKey: keys.allRuns });
      toast('success', s.queue.paused ? 'Queue resumed.' : 'Queue paused.');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Queue" description="Shared by all robots; each worker takes the oldest queued run for its robot." />
      <div className="flex flex-col gap-3 p-4 pt-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="State" value={s.queue.paused ? 'Paused' : 'Running'} tone={s.queue.paused ? 'text-amber-600' : 'text-emerald-600'} />
          <Stat label="Running" value={String(s.queue.running)} />
          <Stat label="Queued" value={String(s.queue.queued)} />
        </div>
        <div className="flex gap-2">
          <Button variant={s.queue.paused ? 'primary' : 'outline'} size="sm" onClick={toggle} disabled={busy}>
            {s.queue.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {s.queue.paused ? 'Resume queue' : 'Pause queue'}
          </Button>
          <Link to="/runs" className="inline-flex items-center rounded-md px-3 text-sm text-muted-foreground hover:text-foreground">Open runs →</Link>
        </div>
        <p className="text-xs text-muted-foreground">Pausing lets running runs reach a checkpoint and stop; resuming queues them again.</p>
      </div>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md bg-muted/50 px-2 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  );
}

function Storage({ s }: { s: SystemStatus }) {
  return (
    <Card>
      <CardHeader title="Storage" description="Disks behind the volumes the dashboard can see." />
      <div className="flex flex-col gap-4 p-4 pt-3">
        {s.volumes.map((v) => {
          const used = v.total_bytes ? 1 - (v.free_bytes ?? 0) / v.total_bytes : null;
          const warn = lowDisk(v);
          return (
            <div key={v.path} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span><span className="font-medium">{v.label}</span> <span className="font-mono text-xs text-muted-foreground">{v.path}</span></span>
                <span className={cn('text-xs tabular-nums', warn ? 'font-semibold text-rose-600' : 'text-muted-foreground')}>
                  {used == null ? 'unknown' : `${formatBytes(v.free_bytes)} free of ${formatBytes(v.total_bytes)}`}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                {used != null && <div className={cn('h-full', warn ? 'bg-rose-500' : used > 0.85 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${used * 100}%` }} />}
              </div>
              <p className="text-xs text-muted-foreground">{v.about}</p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Database({ s }: { s: SystemStatus }) {
  const m = s.mongo;
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Dot on={m.ok} /> MongoDB</span>} description={m.ok ? `Answered a ping in ${m.ping_ms} ms.` : m.error} />
      {m.ok && (
        <div className="flex flex-col gap-3 p-4 pt-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Data" value={formatBytes(m.data_bytes)} />
            <Stat label="On disk" value={formatBytes(m.storage_bytes)} />
            <Stat label="Indexes" value={formatBytes(m.index_bytes)} />
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
            {m.collections.map((c) => (
              <div key={c.name} className="flex justify-between gap-2">
                <span className="truncate text-muted-foreground">{c.name}</span>
                <span className="font-mono tabular-nums">{c.count == null ? '—' : formatNumber(c.count)}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Counts are estimates. <span className="font-mono">logs</span> holds every training step the car logs, so it dominates the size.</p>
        </div>
      )}
    </Card>
  );
}

function Unity({ s }: { s: SystemStatus }) {
  const desired = s.unity.desired;
  return (
    <Card>
      <CardHeader title="Unity clients" description="The gym each Unity client supervisor is told to run. Supervisors poll this and hot-swap the binary when it changes." />
      <div className="flex flex-col gap-3 p-4 pt-3">
        {!desired.length ? (
          <p className="text-sm text-muted-foreground">No gym has been set since the dashboard started; supervisors keep whatever they are running.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="py-1.5 pr-3 font-medium">Client</th><th className="px-3 py-1.5 font-medium">Gym</th><th className="py-1.5 pl-3 text-right font-medium">Set</th></tr>
            </thead>
            <tbody className="divide-y">
              {desired.map((d) => (
                <tr key={d.index}>
                  <td className="py-1.5 pr-3">{d.index === '*' ? 'All' : `#${d.index}`}</td>
                  <td className="px-3 py-1.5">
                    <span className="font-medium">{d.gym_name || '—'}</span>
                    {d.headless && <Badge className="ml-2 px-1.5 py-0 text-[10px]">headless</Badge>}
                    {d.file_path && <p className="truncate font-mono text-[11px] text-muted-foreground" title={d.file_path}>{d.file_path}</p>}
                  </td>
                  <td className="py-1.5 pl-3 text-right text-xs text-muted-foreground">{timeAgo(d.set_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <HostNote>
          The client processes run on the Windows host, out of the dashboard's reach. To see or change how many are running, ask the agent
          (<span className="font-mono">get_unity_clients</span>, <span className="font-mono">set_unity_clients</span>) or run
          {' '}<span className="font-mono">scripts/Start-Clients.ps1</span>.
        </HostNote>
      </div>
    </Card>
  );
}

function HostNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{children}</span>
    </div>
  );
}

function ReleasesCard() {
  const qc = useQueryClient();
  const rel = useQuery({ queryKey: keys.releases, queryFn: () => systemApi.releases(), staleTime: 5 * 60_000 });
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(keys.releases, await systemApi.releases(true));
    } finally {
      setRefreshing(false);
    }
  };
  const r = rel.data;
  return (
    <Card>
      <CardHeader
        title="Gym releases"
        description={r ? <>GitHub releases of <a href={`https://github.com/${r.repo}/releases`} target="_blank" rel="noreferrer" className="hover:underline">{r.repo}</a>, where installers fetch gyms and demos.</> : 'GitHub releases, where installers fetch gyms and demos.'}
        actions={<Button size="icon" variant="ghost" className="h-7 w-7" title="Refresh from GitHub" onClick={refresh} disabled={refreshing}><RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} /></Button>}
      />
      <div className="flex flex-col gap-3 p-4 pt-3">
        {rel.isLoading ? <Spinner /> : !r ? null : !r.ok ? <p className="text-sm text-rose-600">{r.error}</p>
          : !r.items.length ? <p className="text-sm text-muted-foreground">No releases yet.</p>
            : r.items.map((x) => (
              <details key={x.tag} className="group rounded-md border px-3 py-2" open={x === r.items[0]}>
                <summary className="flex cursor-pointer list-none items-center gap-2 text-sm">
                  <span className="font-medium">{x.name}</span>
                  {x.prerelease && <Badge tone="amber" className="px-1.5 py-0 text-[10px]">pre-release</Badge>}
                  {x.draft && <Badge className="px-1.5 py-0 text-[10px]">draft</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">{x.assets.length} assets · {timeAgo(x.published_at)}</span>
                  <a href={x.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" title="Open on GitHub"><ExternalLink className="h-3.5 w-3.5" /></a>
                </summary>
                <table className="mt-2 w-full text-xs">
                  <tbody className="divide-y">
                    {x.assets.filter((a) => !a.name.endsWith('.sha256')).map((a) => (
                      <tr key={a.name}>
                        <td className="py-1 pr-3"><a href={a.url} className="font-mono hover:underline">{a.name}</a></td>
                        <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">{formatBytes(a.size)}</td>
                        <td className="py-1 pl-3 text-right tabular-nums text-muted-foreground">{a.downloads} ↓</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
        <HostNote>
          Gym builds live on the Windows host. Packaging a build and uploading it to a release is done by the agent
          (<span className="font-mono">list_gym_builds</span>, <span className="font-mono">package_gym</span>, <span className="font-mono">add_gym_to_release</span>).
        </HostNote>
      </div>
    </Card>
  );
}

function ServiceLogs({ s }: { s: SystemStatus }) {
  const [pick, setPick] = useState(s.logs[0]?.id ?? 'car');
  const log = s.logs.find((l) => l.id === pick) ?? s.logs[0];
  const live = !!log?.modified_at && Date.now() - new Date(log.modified_at).getTime() < LIVE_LOG_MS;
  return (
    <Card>
      <CardHeader title="Worker output" description="What each worker is printing right now, from the shared log files. Per-run logs are on each run's Logs tab." />
      <div className="flex flex-col gap-3 p-4 pt-3">
        <div className="flex flex-wrap gap-1.5">
          {s.logs.map((l) => (
            <button
              key={l.id}
              onClick={() => setPick(l.id)}
              className={cn('flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs', l.id === pick ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted')}
            >
              <span className="font-medium">{l.label}</span>
              <span>{l.exists ? `${formatBytes(l.size)} · ${timeAgo(l.modified_at)}` : 'no file'}</span>
            </button>
          ))}
        </div>
        {log && (log.exists
          ? <LogView key={log.id} source={log.id} fetchChunk={(o) => systemApi.log(log.id, o)} live={live} emptyTitle="No output" className="h-[28rem]" />
          : <Empty title="No output yet">{log.label} hasn't written <span className="font-mono">{log.path}</span> since the stack started.</Empty>)}
      </div>
    </Card>
  );
}
