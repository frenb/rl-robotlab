// Request plumbing shared by the /api/v1 route modules.
import * as express from 'express';

const ObjectID = require('mongodb').ObjectID;

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message);
    // Compiled to ES5, a subclass of Error loses its prototype and instanceof fails.
    (Object as any).setPrototypeOf(this, HttpError.prototype);
  }
}

export type Handler = (req: express.Request, res: express.Response) => Promise<any>;

export function route(fn: Handler): express.RequestHandler {
  return (req, res) => {
    fn(req, res).then(
      (body) => { if (!res.headersSent) res.json(body); },
      (err) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(`[api/v1] ${req.method} ${req.originalUrl}:`, err);
        if (!res.headersSent) {
          res.status(status).json({ error: String((err && err.message) || err), ...((err && err.body) || {}) });
        }
      },
    );
  };
}

export function idFilter(id: string): any {
  const ids: any[] = [id];
  try {
    ids.push(ObjectID(id));
  } catch (e) {
    // Not an ObjectId; jobs created by the workers use string ids.
  }
  return { _id: { $in: ids } };
}

/** Ids as stored: workers write some as strings, the dashboard as ObjectIds. */
export function withObjectIds(ids: string[]): any[] {
  const out: any[] = ids.slice();
  for (const id of ids) {
    try {
      out.push(ObjectID(id));
    } catch (e) {
      // Not an ObjectId.
    }
  }
  return out;
}

export function anyId(ids: string[]): any {
  return { _id: { $in: withObjectIds(ids) } };
}

export function list(v: any): string[] {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function intParam(v: any, fallback: number, min: number, max: number): number {
  const n = parseInt(String(v), 10);
  return isNaN(n) ? fallback : Math.max(min, Math.min(max, n));
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function iso(v: any): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
