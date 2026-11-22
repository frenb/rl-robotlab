import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Last 8 characters, the short form ids are shown and matched by. */
export function shortId(id: string) {
  return id.slice(-8);
}

export function formatNumber(v: number | null | undefined, digits = 2): string {
  if (v == null || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toFixed(abs >= 100 ? 1 : digits);
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  return `${formatDuration(ms).split(' ')[0]} ago`;
}

export function runDuration(run: { started_at: string | null; ended_at: string | null }): string {
  if (!run.started_at) return '—';
  const end = run.ended_at ? new Date(run.ended_at).getTime() : Date.now();
  return formatDuration(end - new Date(run.started_at).getTime());
}
