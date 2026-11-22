// The MadScientist research agent (rl_agent/madscientist): its proposals, the
// decisions waiting on the user, the runs each approved proposal queued and
// how they came out. Statuses mirror rl_agent/madscientist/constants.py:
//   pending_judge -> pending_user (or rejected) -> approved -> implementing
//   -> pr_open (Cursor path) -> training -> done; failed/cancelled from anywhere.
// The classic /madscientist/* routes in server.ts share decide() and
// editPatch(); the email magic links and the MCP console still use them.
import * as express from 'express';
import { escapeRegex, HttpError, intParam, iso, list, route, withObjectIds } from './http';
import { Context, summarize, SUMMARY_PROJECTION } from './runs';

const ObjectID = require('mongodb').ObjectID;

export const PROPOSALS = 'proposals';
export const DECISIONS = ['approve', 'reject', 'defer', 'approve_with_revisions'];
/** Statuses a user decision or edit applies to. */
export const AWAITING_USER = ['pending_user', 'deferred'];
export const GROUPS: { [group: string]: string[] } = {
  pending: AWAITING_USER,
  in_flight: ['approved', 'implementing', 'pr_open', 'training'],
  outcomes: ['done', 'failed'],
  closed: ['rejected', 'cancelled'],
  judging: ['pending_judge'],
};
const STATUS_ORDER = ['pending_judge', 'pending_user', 'deferred', 'approved', 'implementing', 'pr_open', 'training',
  'done', 'failed', 'rejected', 'cancelled'];
const COST_KEYS = ['madscientist_usd', 'judge_usd', 'cursor_usd', 'other_usd'];
const ROW_PROJECTION = { audit_events: 0, implementation_log: 0, research_note_ids: 0 };
const LOG_LINES = 200;
const MAX_PAGE = 200;

const OBJID_RE = /^[a-fA-F0-9]{24}$/;
const EDITABLE_TOP_LEVEL = ['title', 'hypothesis', 'motivation', 'code_changes_summary', 'n_seeds_per_arm',
  'num_iterations_per_seed', 'expected_wall_time_hours'];
const EDITABLE_PRIMARY = ['metric', 'arm_a', 'arm_b', 'comparator', 'threshold', 'threshold_kind'];
const COMPARATORS = ['>=', '<=', '>', '<'];
const THRESHOLD_KINDS = ['relative', 'absolute'];

export function proposalId(raw: any): any {
  const id = String(raw || '').trim();
  if (!OBJID_RE.test(id)) throw new HttpError(400, 'proposal id must be a 24-char hex ObjectId');
  return ObjectID(id);
}

export function nextStatus(action: string): string {
  return action === 'reject' ? 'rejected' : action === 'defer' ? 'deferred' : 'approved';
}

/**
 * Records a user decision. gate limits it to proposals still awaiting one, so
 * a stale page can't re-decide a proposal that's already training.
 */
export async function decide(db: any, id: any, action: string, note: string, source: string, gate: boolean) {
  if (DECISIONS.indexOf(action) < 0) throw new HttpError(400, `action must be one of ${DECISIONS.join(', ')}`);
  const now = new Date();
  const status = nextStatus(action);
  const text = String(note || '').slice(0, 4000);
  const filter: any = { _id: id };
  if (gate) filter.status = { $in: AWAITING_USER };
  const r = await db.collection(PROPOSALS).updateOne(filter, {
    $set: {
      status,
      decision: { at: now, by: 'user', action, note: text, revision_applied: action === 'approve_with_revisions', source },
      updated_at: now,
    },
    $push: { audit_events: { at: now, by_agent: 'user', event: 'decided', detail: { action, next_status: status, note_chars: text.length, source } } },
  });
  if (!r.matchedCount) {
    const cur = await db.collection(PROPOSALS).findOne({ _id: id }, { projection: { status: 1 } });
    if (!cur) throw new HttpError(404, 'proposal not found');
    throw new HttpError(409, `proposal is already ${cur.status}; only pending_user / deferred proposals take a decision`);
  }
  return { ok: true, proposal_id: String(id), new_status: status, action };
}

/** Validates an edit patch against the stored proposal: the fields to $set and a from/to diff for the audit trail. */
export function editPatch(existing: any, patch: any): { set: { [k: string]: any }; diff: { [k: string]: { from: any; to: any } } } {
  const set: { [k: string]: any } = {};
  const diff: { [k: string]: { from: any; to: any } } = {};
  const put = (key: string, from: any, to: any) => {
    if (from !== to) {
      set[key] = to;
      diff[key] = { from: from === undefined ? null : from, to };
    }
  };
  Object.keys(patch).forEach((k) => {
    if (EDITABLE_TOP_LEVEL.indexOf(k) < 0) return;
    const v = patch[k];
    let out: any;
    if (k === 'n_seeds_per_arm' || k === 'num_iterations_per_seed') {
      out = parseInt(String(v), 10);
      if (!isFinite(out) || out < 1 || out > 100000) throw new HttpError(400, `${k} must be an integer in [1, 100000]; got ${JSON.stringify(v)}`);
    } else if (k === 'expected_wall_time_hours') {
      if (v === null || v === undefined || v === '') {
        out = null;
      } else {
        out = parseFloat(String(v));
        if (!isFinite(out) || out < 0 || out > 10000) {
          throw new HttpError(400, `expected_wall_time_hours must be a non-negative float < 10000; got ${JSON.stringify(v)}`);
        }
      }
    } else {
      if (typeof v !== 'string') throw new HttpError(400, `${k} must be a string; got ${typeof v}`);
      out = v.slice(0, 16000);
    }
    put(k, existing[k], out);
  });
  const criteria = existing.success_criteria || {};
  if (typeof patch['success_criteria.primary'] === 'string') {
    put('success_criteria.primary', criteria.primary || '', patch['success_criteria.primary'].slice(0, 8000));
  }
  const parsed = criteria.primary_parsed || {};
  EDITABLE_PRIMARY.forEach((k) => {
    const key = `success_criteria.primary_parsed.${k}`;
    if (!(key in patch)) return;
    let v = patch[key];
    if (k === 'comparator') {
      if (COMPARATORS.indexOf(String(v)) < 0) throw new HttpError(400, `comparator must be one of ${COMPARATORS.join(', ')}; got ${JSON.stringify(v)}`);
    } else if (k === 'threshold_kind') {
      if (THRESHOLD_KINDS.indexOf(String(v)) < 0) throw new HttpError(400, `threshold_kind must be one of ${THRESHOLD_KINDS.join(', ')}; got ${JSON.stringify(v)}`);
    } else if (k === 'threshold') {
      v = parseFloat(String(v));
      if (!isFinite(v)) throw new HttpError(400, `threshold must be a finite number; got ${JSON.stringify(patch[key])}`);
    } else {
      if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${k} must be a non-empty string; got ${JSON.stringify(v)}`);
      v = v.trim().slice(0, 200);
    }
    put(key, parsed[k], v);
  });
  return { set, diff };
}

export async function edit(db: any, id: any, patch: any, source: string) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'patch object required');
  const coll = db.collection(PROPOSALS);
  const existing = await coll.findOne({ _id: id });
  if (!existing) throw new HttpError(404, 'proposal not found');
  if (AWAITING_USER.indexOf(existing.status) < 0) {
    throw new HttpError(409, `proposal status=${existing.status} is no longer editable. Only pending_user / deferred proposals can be edited.`);
  }
  const { set, diff } = editPatch(existing, patch);
  if (!Object.keys(set).length) return { ok: true, proposal_id: String(id), updated_fields: [] as string[], note: 'patch contained no changes' };
  const now = new Date();
  const r = await coll.updateOne({ _id: id, status: { $in: AWAITING_USER } }, {
    $set: { ...set, updated_at: now },
    $push: { audit_events: { at: now, by_agent: 'user', event: 'edited', detail: { source, field_diff: diff } } },
  });
  if (!r.matchedCount) throw new HttpError(409, 'proposal status changed concurrently; refresh and retry');
  return { ok: true, proposal_id: String(id), updated_fields: Object.keys(set) };
}

function num(v: any): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function costOf(p: any): number {
  const c = p.cost || {};
  return COST_KEYS.reduce((s, k) => s + (num(c[k]) || 0), 0);
}

function statusCounts(statuses: string[]): { [s: string]: number } {
  const out: { [s: string]: number } = {};
  statuses.forEach((s) => { out[s || 'UNKNOWN'] = (out[s || 'UNKNOWN'] || 0) + 1; });
  return out;
}

/** One proposal as the lists show it; jobs are the statuses of the runs it queued. */
function row(p: any, jobs: string[]): any {
  const jr = p.judge_review || null;
  const res = p.results || null;
  const parsed = (p.success_criteria && p.success_criteria.primary_parsed) || null;
  return {
    id: String(p._id),
    title: p.title || null,
    status: p.status || null,
    created_at: iso(p.created_at),
    updated_at: iso(p.updated_at),
    hypothesis: p.hypothesis || '',
    arms: Array.isArray(p.experiment_arms) ? p.experiment_arms.map((a: any) => String((a && a.name) || '')) : [],
    n_seeds_per_arm: num(p.n_seeds_per_arm),
    num_iterations_per_seed: num(p.num_iterations_per_seed),
    expected_wall_time_hours: num(p.expected_wall_time_hours),
    primary: (p.success_criteria && p.success_criteria.primary) || null,
    primary_parsed: parsed,
    verdict: jr ? jr.overall || null : null,
    score: jr ? num(jr.normalized_score) : null,
    concerns: jr && Array.isArray(jr.concerns) ? jr.concerns : [],
    judge_error: jr ? jr.judge_error || null : null,
    papers: Array.isArray(p.source_papers) ? p.source_papers.length : 0,
    cost_usd: costOf(p),
    jobs: { total: jobs.length, by_status: statusCounts(jobs) },
    decision: p.decision ? { action: p.decision.action || null, at: iso(p.decision.at), note: p.decision.note || '', source: p.decision.source || null } : null,
    implementation: p.implementation_branch || p.implementation_pr_url || p.implementation_failure_reason ? {
      branch: p.implementation_branch || null,
      pr_url: p.implementation_pr_url || null,
      failure: p.implementation_failure_reason || null,
    } : null,
    results: res ? {
      verdict: res.verdict || null,
      primary_delta: num(res.primary_delta),
      primary_criterion_met: typeof res.primary_criterion_met === 'boolean' ? res.primary_criterion_met : null,
      n_jobs_succeeded: num(res.n_jobs_succeeded),
      n_jobs_failed: num(res.n_jobs_failed),
      notes: res.notes || null,
      computed_at: iso(res.computed_at),
    } : null,
  };
}

function startOfMonth(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function mountLab(api: express.Router, ctx: Context, db: () => any) {
  const jobsFor = async (ids: string[]) => {
    const out: { [pid: string]: string[] } = {};
    if (!ids.length) return out;
    const jobs = await db().collection('jobs').find({ proposal_id: { $in: ids } }, { projection: { proposal_id: 1, status: 1 } }).toArray();
    jobs.forEach((j: any) => { (out[String(j.proposal_id)] = out[String(j.proposal_id)] || []).push(j.status); });
    return out;
  };

  api.get('/lab/summary', route(async () => {
    const coll = db().collection(PROPOSALS);
    const [byStatus, spend, agents] = await Promise.all([
      coll.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
      coll.aggregate([
        { $match: { created_at: { $gte: startOfMonth() } } },
        { $group: { _id: null, n: { $sum: 1 }, ...COST_KEYS.reduce((o: any, k) => { o[k] = { $sum: { $ifNull: [`$cost.${k}`, 0] } }; return o; }, {}) } },
      ]).toArray(),
      coll.aggregate([
        { $match: { audit_events: { $exists: true, $ne: [] } } },
        { $project: { title: 1, audit_events: { at: 1, by_agent: 1, event: 1 } } },
        { $unwind: '$audit_events' },
        { $sort: { 'audit_events.at': -1 } },
        { $group: { _id: '$audit_events.by_agent', at: { $first: '$audit_events.at' }, event: { $first: '$audit_events.event' },
          proposal_id: { $first: '$_id' }, title: { $first: '$title' }, events: { $sum: 1 } } },
      ]).toArray(),
    ]);
    const counts: { [s: string]: number } = {};
    byStatus.forEach((s: any) => { counts[s._id || 'unknown'] = s.n; });
    const m = spend[0] || {};
    const group = (g: string) => GROUPS[g].reduce((s, st) => s + (counts[st] || 0), 0);
    const envNum = (k: string) => (process.env[k] && isFinite(Number(process.env[k])) ? Number(process.env[k]) : null);
    return {
      counts,
      statuses: STATUS_ORDER,
      groups: Object.keys(GROUPS).reduce((o: any, g) => { o[g] = group(g); return o; }, {}),
      month: {
        start: startOfMonth().toISOString(),
        proposals: m.n || 0,
        spend_usd: COST_KEYS.reduce((s, k) => s + (m[k] || 0), 0),
        by: COST_KEYS.reduce((o: any, k) => { o[k.replace(/_usd$/, '')] = m[k] || 0; return o; }, {}),
        budget_usd: envNum('BUDGET_USD_PER_MONTH'),
      },
      agents: agents.map((a: any) => ({
        agent: a._id, last_at: iso(a.at), last_event: a.event || null, proposal_id: String(a.proposal_id), proposal_title: a.title || null, events: a.events,
      })).sort((a: any, b: any) => String(b.last_at || '').localeCompare(String(a.last_at || ''))),
    };
  }));

  api.get('/lab/proposals', route(async (req) => {
    const statuses = list(req.query.status);
    const group = String(req.query.group || '');
    if (group && !GROUPS[group]) throw new HttpError(400, `group must be one of ${Object.keys(GROUPS).join(', ')}`);
    const and: any[] = [];
    if (statuses.length) and.push({ status: { $in: statuses } });
    if (group) and.push({ status: { $in: GROUPS[group] } });
    const q = String(req.query.q || '').trim();
    if (q) {
      const re = new RegExp(escapeRegex(q), 'i');
      and.push({ $or: [{ title: re }, { hypothesis: re }, { 'source_papers.arxiv_id': re }] });
    }
    const filter = and.length ? { $and: and } : {};
    const limit = intParam(req.query.limit, 50, 1, MAX_PAGE);
    const offset = intParam(req.query.offset, 0, 0, 1e9);
    const sort = group === 'pending' ? { created_at: 1, _id: 1 } : { updated_at: -1, created_at: -1, _id: -1 };
    const coll = db().collection(PROPOSALS);
    const [docs, total] = await Promise.all([
      coll.find(filter, { projection: ROW_PROJECTION }).sort(sort).skip(offset).limit(limit).toArray(),
      coll.countDocuments(filter),
    ]);
    const jobs = await jobsFor(docs.map((d: any) => String(d._id)));
    return { items: docs.map((d: any) => row(d, jobs[String(d._id)] || [])), total, offset, limit };
  }));

  api.get('/lab/proposals/:id', route(async (req) => {
    const id = proposalId(req.params.id);
    const d = db();
    const p = await d.collection(PROPOSALS).findOne({ _id: id });
    if (!p) throw new HttpError(404, 'proposal not found');
    const pid = String(p._id);
    const linked = Array.isArray(p.training_job_ids) ? p.training_job_ids.map(String) : [];
    const jobs = await d.collection('jobs').find({ $or: [{ proposal_id: pid }, { _id: { $in: withObjectIds(linked) } }] }, {
      projection: SUMMARY_PROJECTION,
    }).sort({ create_date: 1, _id: 1 }).toArray();
    const jobIds = jobs.map((j: any) => String(j._id));
    const [models, designs] = await Promise.all([
      jobIds.length ? d.collection('models').find({ job_id: { $in: withObjectIds(jobIds) } }, {
        projection: { job_id: 1, avg_return: 1, is_global_best: 1, training_iterations: 1, create_date: 1 },
      }).toArray() : [],
      d.collection('experiment_designs').find({ proposal_id: pid }, { projection: { name: 1, base_design_id: 1, archived: 1 } }).toArray(),
    ]);
    // Each run's model as the outcome ingester scores it: the latest, else its best avg_return.
    const best: { [job: string]: any } = {};
    models.forEach((m: any) => {
      const k = String(m.job_id);
      const cur = best[k];
      if (!cur || (m.is_global_best && !cur.is_global_best)
        || (!!m.is_global_best === !!cur.is_global_best && (num(m.avg_return) ?? -Infinity) > (num(cur.avg_return) ?? -Infinity))) best[k] = m;
    });
    const log = Array.isArray(p.implementation_log) ? p.implementation_log : [];
    const doc = { ...p };
    delete doc.implementation_log;
    return {
      proposal: row(p, jobs.map((j: any) => j.status)),
      doc: { ...doc, implementation_log_lines: log.length },
      implementation_log: log.slice(-LOG_LINES).map(String),
      runs: jobs.map((j: any) => {
        const m = best[String(j._id)];
        return {
          arm: j.proposal_arm || null,
          seed: typeof j.seed === 'number' ? j.seed : null,
          run: summarize(ctx, j),
          model: m ? { id: String(m._id), avg_return: num(m.avg_return), iteration: num(m.training_iterations), latest: !!m.is_global_best } : null,
        };
      }),
      designs: designs.map((x: any) => ({ id: String(x._id), name: x.name || null, base_design_id: x.base_design_id || null, archived: !!x.archived })),
      per_arm: (p.results && Array.isArray(p.results.per_arm)) ? p.results.per_arm : [],
    };
  }));

  api.get('/lab/activity', route(async (req) => {
    const limit = intParam(req.query.limit, 30, 1, MAX_PAGE);
    const offset = intParam(req.query.offset, 0, 0, 1e9);
    const match: any = { audit_events: { $exists: true, $ne: [] } };
    if (req.query.proposal) match._id = proposalId(req.query.proposal);
    const agents = list(req.query.agent);
    const result = await db().collection(PROPOSALS).aggregate([
      { $match: match },
      { $project: { title: 1, status: 1, audit_events: 1 } },
      { $unwind: '$audit_events' },
      ...(agents.length ? [{ $match: { 'audit_events.by_agent': { $in: agents } } }] : []),
      { $sort: { 'audit_events.at': -1 } },
      { $facet: { rows: [{ $skip: offset }, { $limit: limit }], total: [{ $count: 'count' }] } },
    ]).toArray();
    const facet = result[0] || {};
    return {
      items: (facet.rows || []).map((r: any) => ({
        proposal_id: String(r._id),
        proposal_title: r.title || null,
        proposal_status: r.status || null,
        at: iso(r.audit_events.at),
        agent: r.audit_events.by_agent || null,
        event: r.audit_events.event || null,
        detail: r.audit_events.detail || null,
      })),
      total: (facet.total && facet.total[0] && facet.total[0].count) || 0,
      offset,
      limit,
    };
  }));

  /** Who made a change, for the audit trail: the app, or the agent through the MCP console. */
  const sourceOf = (body: any) => (body && body.source === 'mcp' ? 'mcp' : 'dashboard');

  api.post('/lab/proposals/:id/decision', route(async (req) => {
    const body = req.body || {};
    return decide(db(), proposalId(req.params.id), String(body.action || ''), String(body.note || ''), sourceOf(body), true);
  }));

  api.patch('/lab/proposals/:id', route(async (req) => edit(db(), proposalId(req.params.id), (req.body || {}).patch, sourceOf(req.body))));
}
