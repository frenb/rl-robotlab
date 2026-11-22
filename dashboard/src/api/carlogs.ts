// Per-job logs for the car.
//
// The car trainer writes every job to one /tmp/trainer.log (its stdout, tee'd
// by the container), so on its own a finished car job has no log. This
// records the byte offset where each car job's output starts while it runs
// and, once it stops, copies that slice to saved_models/robotaxi/job_logs.
// A job resumed after a pause appends a second slice to the same file.
//
// Done here rather than in the trainer because the trainer forks env workers
// and execv's itself after every job, and redirecting its stdout around that
// has crashed it before.
import * as fs from 'fs';
import * as path from 'path';
import { CAR, Context, robotFilter } from './runs';

export const CAR_TRAINER_LOG = '/tmp/trainer.log';
const ARCHIVE_DIR = '/saved_models/robotaxi/job_logs';
const SPANS = 'run_log_spans';
const POLL_MS = 5000;
/** How far back to look for a job's first line when its start wasn't seen live. */
const SCAN_BYTES = 8 * 1024 * 1024;
const RUNNING = ['IN_PROGRESS', 'PAUSE_REQUESTED'];
/** Printed by _restart_trainer_process after every job; the slice ends at it. */
const JOB_END_MARKER = 'restarting trainer process';
const JOB_START_MARKER = 'doing job\n';

export function archivedLogPath(id: string): string {
  return path.join(ARCHIVE_DIR, `${id}.log`);
}

async function size(p: string): Promise<number | null> {
  try {
    return (await fs.promises.stat(p)).size;
  } catch (e) {
    return null;
  }
}

async function readRange(p: string, start: number, end: number): Promise<Buffer> {
  const buf = Buffer.alloc(Math.max(0, end - start));
  if (!buf.length) return buf;
  const fh = await fs.promises.open(p, 'r');
  try {
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Where running job `id` starts in the log. The trainer runs one job at a time,
 * so that is the last "doing job" line, provided the job is named after it.
 */
export async function locateStart(logPath: string, id: string, logSize: number): Promise<{ start: number; partial: boolean }> {
  const from = Math.max(0, logSize - SCAN_BYTES);
  const text = (await readRange(logPath, from, logSize)).toString('latin1');
  const begin = text.lastIndexOf(JOB_START_MARKER);
  if (begin >= 0 && text.indexOf(id, begin) >= 0) return { start: from + begin, partial: false };
  return { start: from, partial: from > 0 };
}

/** The slice [start, end) of the log, cut after the trainer's end-of-job line. */
export function trimSlice(buf: Buffer): Buffer {
  const text = buf.toString('latin1');
  const at = text.indexOf(JOB_END_MARKER);
  if (at < 0) return buf;
  const nl = text.indexOf('\n', at);
  return buf.subarray(0, nl < 0 ? buf.length : nl + 1);
}

export interface CarLogSpan {
  _id: string;
  /** Offset in the shared log where the running job's output starts, or null when it isn't running. */
  start: number | null;
  partial?: boolean;
  archived_bytes?: number;
}

export async function openSpan(ctx: Context, id: string): Promise<CarLogSpan | null> {
  const db = ctx.db();
  return db ? db.collection(SPANS).findOne({ _id: id }) : null;
}

async function close(db: any, span: CarLogSpan, logSize: number | null): Promise<void> {
  let written = 0;
  if (span.start != null && logSize != null && logSize > span.start) {
    const slice = trimSlice(await readRange(CAR_TRAINER_LOG, span.start, logSize));
    if (slice.length) {
      await fs.promises.mkdir(ARCHIVE_DIR, { recursive: true });
      await fs.promises.appendFile(archivedLogPath(span._id), slice);
      written = slice.length;
    }
  }
  await db.collection(SPANS).updateOne(
    { _id: span._id },
    { $set: { start: null, closed_at: new Date() }, $inc: { archived_bytes: written } });
}

async function tick(ctx: Context): Promise<void> {
  const db = ctx.db();
  if (!db) return;
  const running = await db.collection('jobs').find(
    { $and: [robotFilter(CAR), { status: { $in: RUNNING } }] }, { projection: { _id: 1 } }).toArray();
  const runningIds = running.map((j: any) => String(j._id));
  const open: CarLogSpan[] = await db.collection(SPANS).find({ start: { $ne: null } }).toArray();
  const logSize = await size(CAR_TRAINER_LOG);
  for (const span of open) {
    if (runningIds.indexOf(span._id) < 0) await close(db, span, logSize);
    else if (logSize != null && span.start != null && logSize < span.start) {
      // The log was truncated (trainer container restart); the job's output restarts at 0.
      await db.collection(SPANS).updateOne({ _id: span._id }, { $set: { start: 0, partial: true } });
    }
  }
  if (logSize == null) return;
  for (const id of runningIds) {
    if (open.some((s) => s._id === id)) continue;
    const at = await locateStart(CAR_TRAINER_LOG, id, logSize);
    await db.collection(SPANS).updateOne(
      { _id: id }, { $set: { start: at.start, partial: at.partial, opened_at: new Date() } }, { upsert: true });
  }
}

export function startCarLogRecorder(ctx: Context): void {
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    tick(ctx)
      .catch((e) => console.warn('[api/v1 carlogs] tick failed:', e && (e.message || e)))
      .then(() => { busy = false; });
  }, POLL_MS);
}
