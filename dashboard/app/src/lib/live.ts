// One WebSocket to /api/v1/live per tab. Run changes patch the query cache in
// place; new metric points invalidate that run's series so charts refetch.
import { useEffect, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { keys, type Run, type RunDetail } from './api';

type Status = 'connecting' | 'live' | 'offline';

const RECONNECT_MS = 3000;
/** Without a heartbeat for this long the socket is assumed dead. */
const STALE_MS = 75_000;
const RUNS_REFETCH_DEBOUNCE_MS = 1500;

class LiveClient {
  private ws: WebSocket | null = null;
  private status: Status = 'connecting';
  private listeners = new Set<() => void>();
  private subs = new Map<string, number>();
  private lastMessage = 0;
  private connectedBefore = false;
  private runsTimer: number | undefined;
  private queryClient: QueryClient | null = null;

  start(queryClient: QueryClient) {
    if (this.queryClient) return;
    this.queryClient = queryClient;
    this.connect();
    window.setInterval(() => {
      if (this.ws && this.status === 'live' && Date.now() - this.lastMessage > STALE_MS) this.ws.close();
    }, 15_000);
  }

  private connect() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/v1/live`);
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.lastMessage = Date.now();
      this.setStatus('live');
      this.sendSubscriptions();
      // Anything may have changed while we were away.
      if (this.connectedBefore) this.queryClient?.invalidateQueries();
      this.connectedBefore = true;
    };
    ws.onmessage = (e) => {
      this.lastMessage = Date.now();
      try {
        this.handle(JSON.parse(e.data));
      } catch {
        // Ignore malformed frames.
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus('offline');
      window.setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }

  private handle(msg: { type: string; run?: Run; id?: string }) {
    const qc = this.queryClient;
    if (!qc) return;
    if (msg.type === 'run.updated' && msg.run) {
      const run = msg.run;
      qc.setQueryData<RunDetail>(keys.run(run.id), (old) => (old ? { ...old, run } : old));
      this.refetchRunsSoon();
    } else if (msg.type === 'run.deleted') {
      this.refetchRunsSoon();
    } else if (msg.type === 'metrics.changed' && msg.id) {
      qc.invalidateQueries({ queryKey: keys.allMetrics(msg.id) });
    }
  }

  /** Lists can't be patched in place (filters, order), so batch a refetch. */
  private refetchRunsSoon() {
    window.clearTimeout(this.runsTimer);
    this.runsTimer = window.setTimeout(() => {
      const qc = this.queryClient;
      qc?.invalidateQueries({ queryKey: keys.allRuns });
      qc?.invalidateQueries({ queryKey: keys.queue });
      // Training, eval and export jobs write models and their scores as they finish.
      qc?.invalidateQueries({ queryKey: keys.allModels });
      qc?.invalidateQueries({ queryKey: keys.allModel });
      qc?.invalidateQueries({ queryKey: keys.allLeaderboard });
      // Stage jobs move curriculum runs along.
      qc?.invalidateQueries({ queryKey: keys.allCurricula });
    }, RUNS_REFETCH_DEBOUNCE_MS);
  }

  subscribe(runId: string): () => void {
    this.subs.set(runId, (this.subs.get(runId) ?? 0) + 1);
    this.sendSubscriptions();
    return () => {
      const n = (this.subs.get(runId) ?? 1) - 1;
      if (n <= 0) this.subs.delete(runId);
      else this.subs.set(runId, n);
      this.sendSubscriptions();
    };
  }

  private sendSubscriptions() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', runs: [...this.subs.keys()] }));
    }
  }

  private setStatus(s: Status) {
    this.status = s;
    this.listeners.forEach((l) => l());
  }

  getStatus = () => this.status;

  onStatus = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

export const live = new LiveClient();

export function useLiveStatus(): Status {
  return useSyncExternalStore(live.onStatus, live.getStatus);
}

/** Keeps this run's metric charts updating while the component is mounted. */
export function useLiveMetrics(runId: string | undefined, enabled = true) {
  useEffect(() => {
    if (!runId || !enabled) return;
    return live.subscribe(runId);
  }, [runId, enabled]);
}
