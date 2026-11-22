// Read side of the design studio: gyms, reward designs, experiment designs and
// demos per robot, each with what uses it (runs, models, curricula) and the
// versions runs trained with. Edits go through the classic routes in
// server.ts, which validate and lint.
import * as express from 'express';
import { demoLabel, PINNED_DESIGNS } from './launch';
import { HttpError, idFilter, intParam, iso, route, withObjectIds } from './http';
import { CAR, Context, robotFilter, summarize, SUMMARY_PROJECTION } from './runs';

export const DESIGN_KINDS = ['gyms', 'reward_designs', 'experiment_designs', 'demos'];
const RECENT_RUNS = 10;
const CANONICAL: { [id: string]: boolean } = {};
Object.keys(PINNED_DESIGNS).forEach((r) => {
  CANONICAL[PINNED_DESIGNS[r].reward] = true;
  CANONICAL[PINNED_DESIGNS[r].experiment] = true;
});
/** Keys of an experiment design that aren't trainer fields. */
const EXPERIMENT_META = ['_id', 'name', 'description', 'author', 'archived', 'fields', 'version', 'created_at', 'updated_at',
  'create_date', 'robot', 'proposal_id', 'base_design_id'];
const DEMO_FEATURE_FIELDS = ['bc_pretrain_steps', 'critic_warmup_steps', 'awac_lambda', 'demo_prefill_count'];

interface KindDef {
  /** Job field holding the referenced id (gyms also match mjlab jobs by robot + task). */
  jobField: string;
  modelField: string | null;
  versionField: string | null;
  /** Job/model field with the version's snapshot (reward code, experiment fields). */
  snapshotField: string | null;
  curriculumField: string | null;
}

const KINDS: { [kind: string]: KindDef } = {
  gyms: { jobField: 'gym_id', modelField: null, versionField: null, snapshotField: null, curriculumField: 'gym' },
  reward_designs: {
    jobField: 'reward_design_id', modelField: 'reward_design_id', versionField: 'reward_design_version',
    snapshotField: 'reward_design_code', curriculumField: 'reward_design_id',
  },
  experiment_designs: {
    jobField: 'experiment_design_id', modelField: 'experiment_design_id', versionField: 'experiment_design_version',
    snapshotField: 'experiment_design_fields', curriculumField: 'experiment_design_id',
  },
  demos: { jobField: 'demo_id', modelField: null, versionField: null, snapshotField: null, curriculumField: null },
};

function kindOf(req: express.Request): KindDef {
  const def = KINDS[req.params.kind];
  if (!def) throw new HttpError(404, `kind must be one of ${DESIGN_KINDS.join(', ')}`);
  return def;
}

function experimentFields(doc: any): { [k: string]: any } {
  const nested = doc.fields && typeof doc.fields === 'object' ? doc.fields : {};
  const out: { [k: string]: any } = {};
  Object.keys(doc).forEach((k) => { if (EXPERIMENT_META.indexOf(k) < 0 && doc[k] !== null && doc[k] !== undefined) out[k] = doc[k]; });
  Object.keys(nested).forEach((k) => { if (nested[k] !== null && nested[k] !== undefined) out[k] = nested[k]; });
  return out;
}

function row(kind: string, d: any, detail: boolean): any {
  const base = {
    id: String(d._id),
    robot: d.robot || CAR,
    name: d.name || null,
    description: d.description || '',
    archived: !!d.archived,
    created_at: iso(d.created_at || d.create_date),
    updated_at: iso(d.updated_at),
  };
  if (kind === 'gyms') {
    const defaults = Array.isArray(d.reward_defaults) ? d.reward_defaults : [];
    return {
      ...base,
      file_path: d.file_path || null,
      task_id: d.task_id || null,
      managed_by: d.managed_by || null,
      engine: d.engine || null,
      skill: d.skill || null,
      terrain: d.terrain || null,
      episode_s: typeof d.episode_s === 'number' ? d.episode_s : null,
      reward_term_count: Array.isArray(d.reward_terms) ? d.reward_terms.length : defaults.length,
      default_course_type: d.default_course_type || null,
      default_reward_design_id: d.default_reward_design_id || null,
      default_experiment_design_id: d.default_experiment_design_id || null,
      default_init_checkpoint: d.default_init_checkpoint || null,
      ...(detail ? { reward_defaults: defaults } : {}),
    };
  }
  if (kind === 'reward_designs') {
    const code = typeof d.code === 'string' ? d.code : '';
    return {
      ...base,
      version: typeof d.version === 'number' ? d.version : 1,
      author: d.author || null,
      canonical: !!CANONICAL[String(d._id)],
      spec_id: d.spec_id || null,
      spec_status: d.spec_status || null,
      lines: code ? code.split('\n').length : 0,
      ...(detail ? { code } : {}),
    };
  }
  if (kind === 'experiment_designs') {
    const fields = experimentFields(d);
    return {
      ...base,
      version: typeof d.version === 'number' ? d.version : 1,
      author: d.author || null,
      canonical: !!CANONICAL[String(d._id)],
      overrides: Object.keys(fields).length,
      proposal_id: d.proposal_id ? String(d.proposal_id) : null,
      base_design_id: d.base_design_id ? String(d.base_design_id) : null,
      demo_features: DEMO_FEATURE_FIELDS.filter((k) => Number(fields[k]) > 0),
      legacy_stages: Array.isArray(fields.curriculum_stages) ? fields.curriculum_stages.length : 0,
      ...(detail ? { fields } : {}),
    };
  }
  return {
    ...base,
    robot: CAR,
    name: d.description || d.tfrecords_path || null,
    label: demoLabel(d),
    num_demos: typeof d.num_demos === 'number' ? d.num_demos : null,
    num_steps: typeof d.num_steps === 'number' ? d.num_steps : null,
    course: d.course || null,
    tfrecords_path: d.tfrecords_path || null,
    gym_name: d.gym_name || null,
    source_job_id: d.source_job_id ? String(d.source_job_id) : null,
    collected_at: iso(d.collected_at || d.created_at),
  };
}

/** Mongo expression for the id a job refers to; gyms fall back to <robot>:<task_id> for mjlab jobs. */
function refExpr(kind: string, def: KindDef): any {
  const field = { $toString: `$${def.jobField}` };
  if (kind !== 'gyms') return field;
  return { $toString: { $ifNull: [`$${def.jobField}`, {
    $cond: [{ $and: [{ $eq: [{ $type: '$robot' }, 'string'] }, { $eq: [{ $type: '$task_id' }, 'string'] }] },
      { $concat: ['$robot', ':', '$task_id'] }, null],
  }] } };
}

function refMatch(kind: string, def: KindDef, id: string): any {
  const or: any[] = [{ [def.jobField]: { $in: withObjectIds([id]) } }];
  const m = /^([a-z0-9_-]+):(.+)$/i.exec(id);
  if (kind === 'gyms' && m) or.push({ $and: [{ [def.jobField]: { $in: [null, ''] } }, { robot: m[1] }, { task_id: m[2] }] });
  return { $or: or };
}

export function mountDesigns(api: express.Router, ctx: Context, db: () => any) {
  const collection = (kind: string) => db().collection(kind);

  /** id -> {runs, models, last_used} for every referenced id of a kind. */
  const usageCounts = async (kind: string, def: KindDef) => {
    const out: { [id: string]: { runs: number; models: number; last_used: string | null } } = {};
    const bump = (id: any) => (out[String(id)] = out[String(id)] || { runs: 0, models: 0, last_used: null });
    const jobMatch = kind === 'gyms'
      ? { $or: [{ gym_id: { $nin: [null, ''] } }, { task_id: { $nin: [null, ''] } }] }
      : { [def.jobField]: { $nin: [null, ''] } };
    const [jobs, models] = await Promise.all([
      db().collection('jobs').aggregate([
        { $match: jobMatch },
        { $group: { _id: refExpr(kind, def), runs: { $sum: 1 }, last: { $max: '$create_date' } } },
      ]).toArray(),
      def.modelField ? db().collection('models').aggregate([
        { $match: { [def.modelField]: { $nin: [null, ''] } } },
        { $group: { _id: { $toString: `$${def.modelField}` }, n: { $sum: 1 } } },
      ]).toArray() : Promise.resolve([]),
    ]);
    jobs.forEach((j: any) => { if (j._id) { const u = bump(j._id); u.runs = j.runs; u.last_used = iso(j.last); } });
    models.forEach((m: any) => { if (m._id) bump(m._id).models = m.n; });
    return out;
  };

  /** Active curricula whose stages reference each id. */
  const curriculumRefs = async (def: KindDef) => {
    const out: { [id: string]: { id: string; name: string | null; robot: string }[] } = {};
    if (!def.curriculumField) return out;
    const field = def.curriculumField;
    const rows = await db().collection('curricula').find({ archived: { $ne: true } }, { projection: { name: 1, robot: 1, resolved_stages: 1, stages: 1 } }).toArray();
    rows.forEach((c: any) => {
      const stages = Array.isArray(c.resolved_stages) ? c.resolved_stages : Array.isArray(c.stages) ? c.stages : [];
      const ids = stages.map((s: any) => s && s[field]).filter(Boolean).map(String);
      ids.filter((x: string, i: number) => ids.indexOf(x) === i).forEach((x: string) => {
        (out[x] = out[x] || []).push({ id: String(c._id), name: c.name || null, robot: c.robot || CAR });
      });
    });
    return out;
  };

  api.get('/designs/:kind', route(async (req) => {
    const def = kindOf(req);
    const kind = req.params.kind;
    const robotId = String(req.query.robot || '');
    if (kind === 'demos' && robotId && robotId !== CAR) return { items: [] };
    const and: any[] = [];
    if (robotId && kind !== 'demos') and.push(robotFilter(robotId));
    if (req.query.archived !== '1') and.push({ archived: { $ne: true } });
    const projection = kind === 'gyms' ? { reward_terms: 0, reward_defaults: 0 } : {};
    const [rows, usage, refs] = await Promise.all([
      collection(kind).find(and.length ? { $and: and } : {}, { projection }).toArray(),
      usageCounts(kind, def),
      curriculumRefs(def),
    ]);
    const items = rows.map((d: any) => {
      const r = row(kind, d, false);
      const u = usage[r.id] || { runs: 0, models: 0, last_used: null };
      return { ...r, used: { ...u, curricula: (refs[r.id] || []).length } };
    });
    return { items };
  }));

  api.get('/designs/:kind/:id', route(async (req) => {
    const def = kindOf(req);
    const kind = req.params.kind;
    const d = await collection(kind).findOne(idFilter(req.params.id));
    if (!d) throw new HttpError(404, `no ${kind.replace(/s$/, '').replace('_', ' ')} ${req.params.id}`);
    const id = String(d._id);
    const match = refMatch(kind, def, id);
    const jobs = db().collection('jobs');
    const versionOf = def.versionField;
    const [recent, total, models, refs, jobVersions, modelVersions, derived] = await Promise.all([
      jobs.find(match, { projection: SUMMARY_PROJECTION }).sort({ create_date: -1, _id: -1 }).limit(RECENT_RUNS).toArray(),
      jobs.countDocuments(match),
      def.modelField ? db().collection('models').countDocuments({ [def.modelField]: { $in: withObjectIds([id]) } }) : Promise.resolve(0),
      curriculumRefs(def),
      versionOf ? jobs.aggregate([
        { $match: { $and: [match, { [versionOf]: { $type: 'number' } }] } },
        { $group: { _id: `$${versionOf}`, runs: { $sum: 1 }, last: { $max: '$create_date' } } },
      ]).toArray() : Promise.resolve([]),
      versionOf && def.modelField ? db().collection('models').aggregate([
        { $match: { [def.modelField]: { $in: withObjectIds([id]) }, [versionOf]: { $type: 'number' } } },
        { $group: { _id: `$${versionOf}`, models: { $sum: 1 }, last: { $max: '$create_date' } } },
      ]).toArray() : Promise.resolve([]),
      kind === 'experiment_designs'
        ? collection(kind).find({ base_design_id: { $in: withObjectIds([id]) } }, { projection: { name: 1, archived: 1 } }).toArray()
        : Promise.resolve([]),
    ]);
    const versions: { [v: number]: { version: number; runs: number; models: number; last_used: string | null } } = {};
    const at = (v: number) => (versions[v] = versions[v] || { version: v, runs: 0, models: 0, last_used: null });
    const later = (a: string | null, b: any) => { const x = iso(b); return !a || (x && x > a) ? x : a; };
    jobVersions.forEach((g: any) => { const v = at(g._id); v.runs = g.runs; v.last_used = later(v.last_used, g.last); });
    modelVersions.forEach((g: any) => { const v = at(g._id); v.models = g.models; v.last_used = later(v.last_used, g.last); });
    return {
      item: row(kind, d, true),
      usage: {
        runs: total,
        models,
        recent: recent.map((j: any) => summarize(ctx, j)),
        curricula: refs[id] || [],
        versions: Object.keys(versions).map((k) => versions[Number(k)]).sort((a, b) => b.version - a.version),
        derived: derived.map((x: any) => ({ id: String(x._id), name: x.name || null, archived: !!x.archived })),
      },
    };
  }));

  // What a past version looked like, from the snapshot a run or model took when it trained.
  api.get('/designs/:kind/:id/versions/:version', route(async (req) => {
    const def = kindOf(req);
    if (!def.versionField || !def.snapshotField) throw new HttpError(404, `${req.params.kind} have no versions`);
    const version = intParam(req.params.version, 0, 0, 1e9);
    const ids = withObjectIds([req.params.id]);
    const filter = { [def.modelField || def.jobField]: { $in: ids }, [def.versionField]: version, [def.snapshotField]: { $exists: true, $ne: null } };
    const projection = { [def.snapshotField]: 1, create_date: 1 };
    const job = await db().collection('jobs').find({ ...filter, [def.jobField]: { $in: ids } }, { projection })
      .sort({ create_date: -1, _id: -1 }).limit(1).next();
    const model = job ? null : def.modelField
      ? await db().collection('models').find(filter, { projection }).sort({ create_date: -1, _id: -1 }).limit(1).next()
      : null;
    const src = job || model;
    if (!src) throw new HttpError(404, `no run or model kept a copy of version ${version}`);
    return {
      version,
      snapshot: src[def.snapshotField],
      from: { kind: job ? 'run' : 'model', id: String(src._id), at: iso(src.create_date) },
    };
  }));
}
