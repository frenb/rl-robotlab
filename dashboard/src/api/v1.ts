// /api/v1: typed, robot-aware API behind the new app (dashboard/app).
import * as express from 'express';
import * as fs from 'fs';
import {
  buildJob, CAR_COURSES, CAR_MODEL_TYPES, Catalog, DEFAULT_GYM, demoLabel, jobTypes, LaunchSpec,
  PINNED_DESIGNS, specFromJob,
} from './launch';
import { evalSample, modelEval, runConfig } from './compare';
import { listTags, readSeries } from './metrics';
import {
  CAR_METRICS, carCourse, checkpointIteration, DEFAULT_METRIC, deleteModel, evalSummary, gatesFor, MJLAB_METRICS, modelSummary, rankCar, rankMjlab,
  scoresByModel, stageFilter,
} from './models';
import { ACTIONS, DELETABLE, positions, queueState, setQueuePaused } from './queue';
import {
  CAR, Context, eventSources, isMjlab, jumpStatus, localPath, logFile, media, mediaUrl, robotFilter, summarize, SUMMARY_PROJECTION,
} from './runs';
import { anyId, escapeRegex, HttpError, idFilter, intParam, list, route, withObjectIds } from './http';
import { mountCurricula } from './curricula';
import { mountDesigns } from './designs';
import { mountLab } from './lab';
import { mountInsights } from './weakness';
import { mountSystem, readLogChunk } from './system';

const MAX_RUNS_PAGE = 200;
const DEFAULT_MAX_POINTS = 1500;
const MAX_COMPARE_RUNS = 12;
const MAX_BULK = 200;
const TEMPLATE_RUNS = 8;
const MODEL_PROJECTION = {
  job_id: 1, robot: 1, location: 1, training_iterations: 1, create_date: 1, avg_return: 1, eval_results: 1,
};
/** Everything a models list row needs; reward code is the only large field. */
const MODEL_ROW_PROJECTION = { reward_design_code: 0, export_report: 0 };
const MAX_MODELS_PAGE = 200;
const RUN_CHECKPOINTS = 200;
const MODEL_SORTS: { [key: string]: any } = {
  '-created': { create_date: -1, _id: -1 },
  created: { create_date: 1, _id: 1 },
  '-iteration': { training_iterations: -1, _id: -1 },
  iteration: { training_iterations: 1, _id: 1 },
  '-return': { avg_return: -1, _id: -1 },
  return: { avg_return: 1, _id: 1 },
};
/** Experiment-design fields that make a car TRAIN depend on expert demos (launch.ts). */
const DEMO_FEATURE_FIELDS = ['bc_pretrain_steps', 'critic_warmup_steps', 'awac_lambda', 'demo_prefill_count'];
/** Runs list sort keys -> Mongo sort. */
const SORTS: { [key: string]: any } = {
  created: { create_date: 1, _id: 1 },
  '-created': { create_date: -1, _id: -1 },
  started: { started_at: 1, _id: 1 },
  '-started': { started_at: -1, _id: -1 },
  reward: { mean_reward: 1, _id: -1 },
  '-reward': { mean_reward: -1, _id: -1 },
  progress: { percent_complete: 1, _id: -1 },
  '-progress': { percent_complete: -1, _id: -1 },
};

function ids(body: any): string[] {
  const out = Array.isArray(body && body.ids) ? body.ids.map(String).filter(Boolean) : [];
  if (!out.length || out.length > MAX_BULK) throw new HttpError(400, `ids must list 1-${MAX_BULK} run ids`);
  return out;
}

function ownedBy(robot: string): (row: any) => boolean {
  return (row) => ((row && row.robot) || CAR) === robot;
}

export function createApiV1(ctx: Context): express.Router {
  const api = express.Router();

  const db = () => {
    const d = ctx.db();
    if (!d) throw new HttpError(503, 'database not connected yet');
    return d;
  };

  const getJob = async (id: string, projection?: any) => {
    const job = await db().collection('jobs').findOne(idFilter(id), projection ? { projection } : undefined);
    if (!job) throw new HttpError(404, `no run ${id}`);
    return job;
  };

  const robot = (id: string) => ctx.robots().find((r) => r && r.id === id);

  const catalog: Catalog = {
    robot,
    gym: (id) => db().collection('gyms').findOne(idFilter(id)),
    rewardDesign: (id) => db().collection('reward_designs').findOne(idFilter(id)),
    experimentDesign: (id) => db().collection('experiment_designs').findOne(idFilter(id)),
    demo: (id) => db().collection('demos').findOne(idFilter(id)),
    model: (id) => db().collection('models').findOne(idFilter(id)),
  };

  const queuedPositions = async () => positions(
    await db().collection('jobs').find({ status: 'NOT_STARTED' }, { projection: { create_date: 1 } }).toArray());

  api.get('/robots', route(async () => ({
    robots: ctx.robots().map((r) => ({
      id: r.id,
      display_name: r.display_name || r.id,
      engine: r.engine || null,
      badge_color: r.badge_color || null,
      iter_label: r.iter_label || null,
      course_label: r.course_label || null,
      job_types: jobTypes(r, r.id),
      supports: r.supports || {},
    })),
  })));

  api.get('/runs', route(async (req) => {
    const and: any[] = [];
    const robotId = String(req.query.robot || '');
    if (robotId) and.push(robotFilter(robotId));
    const statuses = list(req.query.status);
    if (statuses.length) and.push({ status: { $in: statuses } });
    const types = list(req.query.type);
    if (types.length) and.push({ job_type: { $in: types } });
    const curriculumRun = String(req.query.curriculum_run || '');
    if (curriculumRun) and.push({ curriculum_run_id: curriculumRun });
    const q = String(req.query.q || '').trim();
    if (q) {
      const re = new RegExp(escapeRegex(q), 'i');
      const or: any[] = [{ name: re }, { gym_name: re }, { curriculum_name: re }, { reward_design_name: re },
        { experiment_design_name: re }, { task_id: re }, { notes: re }];
      if (/^[0-9a-f]{6,24}$/i.test(q)) or.push({ $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: escapeRegex(q) + '$', options: 'i' } } });
      and.push({ $or: or });
    }
    const filter = and.length ? { $and: and } : {};
    const limit = intParam(req.query.limit, 50, 1, MAX_RUNS_PAGE);
    const offset = intParam(req.query.offset, 0, 0, 1e9);
    const sort = SORTS[String(req.query.sort || '-created')] || SORTS['-created'];
    const jobs = db().collection('jobs');
    const [rows, total, queue] = await Promise.all([
      jobs.find(filter, { projection: SUMMARY_PROJECTION }).sort(sort).skip(offset).limit(limit).toArray(),
      jobs.countDocuments(filter),
      queuedPositions(),
    ]);
    const items = rows.map((j: any) => ({ ...summarize(ctx, j), queue_position: queue[String(j._id)] || null }));
    return { items, total, offset, limit };
  }));

  api.post('/runs', route(async (req) => {
    const spec: LaunchSpec = req.body || {};
    const built = await buildJob(spec, catalog);
    const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
    if (!built.ok) {
      throw new HttpError(built.confirm ? 409 : 400,
        built.confirm ? built.confirm.message : 'Some fields need fixing',
        { errors: built.errors, warnings: built.warnings, confirm: built.confirm || null, doc: built.doc });
    }
    if (dryRun) return { ok: true, dry_run: true, doc: built.doc, warnings: built.warnings };
    const result = await db().collection('jobs').insertOne(built.doc);
    const job = { ...built.doc, _id: result.insertedId };
    return { ok: true, run: summarize(ctx, job), warnings: built.warnings };
  }));

  api.get('/runs/:id', route(async (req) => {
    const job = await getJob(req.params.id);
    const queue = job.status === 'NOT_STARTED' ? await queuedPositions() : {};
    let curriculumRun = null;
    if (job.curriculum_run_id) {
      const cr = await db().collection('curriculum_runs').findOne(idFilter(String(job.curriculum_run_id)));
      if (cr) {
        curriculumRun = {
          id: String(cr._id), status: cr.status || null, name: cr.curriculum_name || job.curriculum_name || null,
          stage_index: typeof cr.stage_index === 'number' ? cr.stage_index : null,
          stage_count: Array.isArray(cr.stages) ? cr.stages.length : null,
          attempt: typeof cr.attempt === 'number' ? cr.attempt : null,
          error: cr.error || null,
        };
      }
    }
    return {
      run: { ...summarize(ctx, job), queue_position: queue[String(job._id)] || null },
      curriculum_run: curriculumRun,
      jump: isMjlab(ctx, (job.robot as string) || CAR) ? jumpStatus(ctx, job) : null,
      job,
    };
  }));

  api.get('/runs/:id/clone', route(async (req) => {
    const job = await getJob(req.params.id);
    const r = robot((job.robot as string) || CAR);
    return { spec: specFromJob(job, r) };
  }));

  const applyAction = async (id: string, action: string) => {
    const def = ACTIONS[action];
    if (!def) throw new HttpError(400, `action must be one of ${Object.keys(ACTIONS).join(', ')}`);
    const job = await getJob(id, { status: 1 });
    if (def.from.indexOf(job.status) < 0) {
      throw new HttpError(409, `${def.label} doesn't apply to a ${job.status} run`);
    }
    const update: any = { $set: { status: def.to } };
    if (action !== 'pause') update.$unset = { queue_auto_paused: '' };
    const r = await db().collection('jobs').updateOne({ _id: job._id, status: { $in: def.from } }, update);
    if (!r.matchedCount) throw new HttpError(409, 'The run changed status meanwhile; refresh and try again');
    return summarize(ctx, await getJob(id, SUMMARY_PROJECTION));
  };

  api.post('/runs/:id/actions', route(async (req) => ({
    run: await applyAction(req.params.id, String((req.body && req.body.action) || '')),
  })));

  api.post('/runs/actions', route(async (req) => {
    const action = String((req.body && req.body.action) || '');
    const results = await Promise.all(ids(req.body).map(async (id) => {
      try {
        return { id, ok: true, run: await applyAction(id, action) };
      } catch (e) {
        return { id, ok: false, error: String((e && (e as any).message) || e) };
      }
    }));
    return { results };
  }));

  const deleteRun = async (id: string) => {
    const job = await getJob(id, { status: 1 });
    if (DELETABLE.indexOf(job.status) < 0) throw new HttpError(409, `Cancel the ${job.status} run before deleting it`);
    await db().collection('jobs').deleteOne({ _id: job._id, status: { $in: DELETABLE } });
  };

  api.delete('/runs/:id', route(async (req) => {
    await deleteRun(req.params.id);
    return { ok: true };
  }));

  api.post('/runs/delete', route(async (req) => ({
    results: await Promise.all(ids(req.body).map(async (id) => {
      try {
        await deleteRun(id);
        return { id, ok: true };
      } catch (e) {
        return { id, ok: false, error: String((e && (e as any).message) || e) };
      }
    })),
  })));

  api.get('/queue', route(async () => queueState(ctx)));

  api.post('/queue', route(async (req) => {
    if (!req.body || typeof req.body.paused !== 'boolean') throw new HttpError(400, 'paused (boolean) is required');
    const jobs = await setQueuePaused(db(), req.body.paused);
    return { ...(await queueState(ctx)), changed: jobs };
  }));

  // Everything the launch form offers for one robot, plus the starting points it can copy.
  api.get('/launch/options', route(async (req) => {
    const robotId = String(req.query.robot || CAR);
    const r = robot(robotId);
    if (!r) throw new HttpError(404, `unknown robot ${robotId}`);
    const mjlab = isMjlab(ctx, robotId);
    const d = db();
    const mine = ownedBy(robotId);
    const active = { archived: { $ne: true } };
    const [gyms, rewards, experiments, demos, models, recent] = await Promise.all([
      d.collection('gyms').find(active, { projection: { name: 1, robot: 1, task_id: 1, default_init_checkpoint: 1 } }).toArray(),
      d.collection('reward_designs').find(active, { projection: { name: 1, robot: 1, version: 1 } }).toArray(),
      d.collection('experiment_designs').find(active).toArray(),
      mjlab ? Promise.resolve([]) : d.collection('demos').find(active).toArray(),
      d.collection('models').find(mjlab ? { robot: robotId } : { robot: { $in: [null, CAR] } }, {
        projection: { job_id: 1, location: 1, task_id: 1, training_iterations: 1, avg_return: 1,
          reward_design_name: 1, experiment_design_name: 1, course_type: 1, create_date: 1, updated_at: 1 },
      }).sort({ _id: -1 }).limit(200).toArray(),
      d.collection('jobs').find(
        { $and: [robotFilter(robotId), { job_type: 'TRAIN' }, { status: { $ne: 'NOT_STARTED' } }] },
        { projection: SUMMARY_PROJECTION },
      ).sort({ create_date: -1, _id: -1 }).limit(TEMPLATE_RUNS).toArray(),
    ]);
    const pinned = PINNED_DESIGNS[robotId] || { reward: '', experiment: '' };
    const byName = (pin: string) => (a: any, b: any) => {
      if (String(a._id) === pin) return -1;
      if (String(b._id) === pin) return 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    };
    const design = (row: any) => ({ id: String(row._id), name: row.name || String(row._id), version: row.version || null });
    return {
      robot: robotId,
      engine: mjlab ? 'mjlab' : 'car',
      job_types: jobTypes(r, robotId),
      courses: mjlab ? [] : CAR_COURSES,
      model_types: mjlab ? [] : CAR_MODEL_TYPES,
      gyms: gyms.filter(mine).sort(byName('')).map((g: any) => ({
        id: String(g._id), name: g.name || String(g._id), task_id: g.task_id || null,
        default_init_checkpoint: g.default_init_checkpoint || null,
      })),
      reward_designs: rewards.filter(mine).sort(byName(pinned.reward)).map(design),
      experiment_designs: experiments.filter(mine).sort(byName(pinned.experiment)).map((e: any) => ({
        ...design(e),
        stages: Array.isArray(e.curriculum_stages) ? e.curriculum_stages.length : 0,
        demo_features: DEMO_FEATURE_FIELDS.filter((k) => Number(e[k]) > 0),
      })),
      demos: demos
        .sort((a: any, b: any) => String(b.collected_at || b.created_at || '').localeCompare(String(a.collected_at || a.created_at || '')))
        .map((m: any) => ({ id: String(m._id), label: demoLabel(m), course: m.course || null })),
      models: models.map((m: any) => ({
        id: String(m._id), location: m.location || null, task_id: m.task_id || null,
        job_id: m.job_id ? String(m.job_id) : null, iteration: m.training_iterations != null ? m.training_iterations : null,
        avg_return: typeof m.avg_return === 'number' ? m.avg_return : null,
        reward_design_name: m.reward_design_name || null, experiment_design_name: m.experiment_design_name || null,
        course_type: m.course_type || null,
      })),
      defaults: {
        gym_id: DEFAULT_GYM[robotId] || null,
        reward_design_id: pinned.reward || null,
        experiment_design_id: pinned.experiment || null,
      },
      recent: recent.map((j: any) => summarize(ctx, j)),
    };
  }));

  api.get('/runs/:id/metrics/tags', route(async (req) => {
    const job = await getJob(req.params.id);
    const sources = await eventSources(ctx, job);
    return { tags: await listTags(sources), files: sources.length };
  }));

  api.get('/runs/:id/metrics', route(async (req) => {
    const job = await getJob(req.params.id);
    const tags = list(req.query.tags);
    if (!tags.length) throw new HttpError(400, 'tags is required (comma-separated)');
    const maxPoints = intParam(req.query.max_points, DEFAULT_MAX_POINTS, 10, 20000);
    const walls = req.query.walls === '1' || req.query.walls === 'true';
    return { series: await readSeries(await eventSources(ctx, job), tags, maxPoints, walls) };
  }));

  // Runs (and models, which bring the run that trained them) side by side:
  // settings to diff and every eval of the models those runs trained.
  api.get('/compare', route(async (req) => {
    const d = db();
    const askedModels = list(req.query.models);
    const runIds = list(req.query.runs);
    if (runIds.length + askedModels.length === 0) throw new HttpError(400, 'pass runs and/or models (comma-separated ids)');
    if (askedModels.length > MAX_BULK) throw new HttpError(400, `models must list at most ${MAX_BULK} ids`);
    const pickedModels = askedModels.length
      ? await d.collection('models').find(anyId(askedModels), { projection: MODEL_PROJECTION }).toArray()
      : [];
    for (const m of pickedModels) {
      if (m.job_id && runIds.indexOf(String(m.job_id)) < 0) runIds.push(String(m.job_id));
    }
    if (runIds.length > MAX_COMPARE_RUNS) throw new HttpError(400, `compare at most ${MAX_COMPARE_RUNS} runs at once`);

    const jobs = runIds.length ? await d.collection('jobs').find(anyId(runIds), { projection: { videos: 0 } }).toArray() : [];
    const byId: { [id: string]: any } = {};
    jobs.forEach((j: any) => { byId[String(j._id)] = j; });
    const found = runIds.filter((id) => byId[id]);
    const designIds = found.map((id) => byId[id].experiment_design_id).filter(Boolean).map(String);
    const [designs, trained] = await Promise.all([
      designIds.length ? d.collection('experiment_designs').find(anyId(designIds)).toArray() : [],
      found.length ? d.collection('models').find({ job_id: { $in: withObjectIds(found) } }, { projection: MODEL_PROJECTION }).toArray() : [],
    ]);
    const designById: { [id: string]: any } = {};
    designs.forEach((x: any) => { designById[String(x._id)] = x; });

    const models: any[] = [];
    const seen: { [id: string]: boolean } = {};
    for (const m of pickedModels.concat(trained)) {
      if (seen[String(m._id)]) continue;
      seen[String(m._id)] = true;
      models.push(m);
    }
    const carModels = models.filter((m) => !m.robot || m.robot === CAR);
    const locations = carModels.map((m) => m.location).filter((l) => typeof l === 'string');
    const scores = carModels.length ? await d.collection('leaderboard_scores').find({
      $or: [{ model_id: { $in: withObjectIds(carModels.map((m) => String(m._id))) } }, { path: { $in: locations } }],
    }).toArray() : [];
    const rowsFor = (m: any) => scores.filter((s: any) =>
      (s.model_id && String(s.model_id) === String(m._id)) || (!s.model_id && s.path && s.path === m.location));

    const checkpoints: { [runId: string]: number } = {};
    trained.forEach((m: any) => { checkpoints[String(m.job_id)] = (checkpoints[String(m.job_id)] || 0) + 1; });
    // Car jobs keep no reward code; every checkpoint they save does.
    await Promise.all(found.filter((id) => typeof byId[id].reward_design_code !== 'string' && checkpoints[id]).map(async (id) => {
      const m = await d.collection('models').findOne(
        { job_id: { $in: withObjectIds([id]) }, reward_design_code: { $type: 'string' } },
        { projection: { reward_design_code: 1 } });
      if (m) byId[id] = { ...byId[id], reward_design_code: m.reward_design_code };
    }));
    return {
      runs: found.map((id) => {
        const job = byId[id];
        return {
          run: summarize(ctx, job),
          config: runConfig(job, job.experiment_design_id ? designById[String(job.experiment_design_id)] : null),
          reward_code: typeof job.reward_design_code === 'string' ? job.reward_design_code : null,
          checkpoints: checkpoints[id] || 0,
        };
      }),
      models: models.map((m) => modelEval(m, rowsFor(m))).filter(Boolean),
      picked_models: pickedModels.map((m: any) => String(m._id)),
      missing: runIds.filter((id) => !byId[id]).concat(askedModels.filter((id) => !pickedModels.some((m: any) => String(m._id) === id))),
    };
  }));

  api.get('/compare/metrics', route(async (req) => {
    const runIds = list(req.query.runs);
    if (!runIds.length || runIds.length > MAX_COMPARE_RUNS) {
      throw new HttpError(400, `runs must list 1-${MAX_COMPARE_RUNS} run ids`);
    }
    const tags = list(req.query.tags);
    if (!tags.length) throw new HttpError(400, 'tags is required (comma-separated)');
    const maxPoints = intParam(req.query.max_points, DEFAULT_MAX_POINTS, 10, 20000);
    const runs: { [id: string]: any } = {};
    await Promise.all(runIds.map(async (id) => {
      const job = await getJob(id);
      runs[id] = { run: summarize(ctx, job), series: await readSeries(await eventSources(ctx, job), tags, maxPoints) };
    }));
    return { runs };
  }));

  // Without ?offset: the last 64 KB. With it: what was appended since,
  // so a client can follow the log by passing back `end`. Offsets are absolute
  // in the file; a car run's output starts at `floor` of the shared trainer log.
  api.get('/runs/:id/logs', route(async (req) => {
    const job = await getJob(req.params.id);
    const log = await logFile(ctx, job);
    if (!log.path) return { available: false, note: log.note, start: 0, end: 0, text: '' };
    const asked = req.query.offset != null ? intParam(req.query.offset, 0, 0, 1e15) : null;
    return readLogChunk(log.path, log.floor, asked, log.note);
  }));

  api.get('/runs/:id/media', route(async (req) => media(await getJob(req.params.id))));

  // ---- models ----

  const robotOfModel = (m: any): string => (m && m.robot) || CAR;
  const mjlabModel = (m: any) => isMjlab(ctx, robotOfModel(m));

  const getModel = async (id: string, projection?: any) => {
    const m = await db().collection('models').findOne(idFilter(id), projection ? { projection } : undefined);
    if (!m) throw new HttpError(404, `no model ${id}`);
    return m;
  };

  const envSpecs = async () => {
    const out: { [robotType: string]: any } = {};
    (await db().collection('env_specs').find({}).toArray()).forEach((r: any) => { out[String(r.robot_type)] = r; });
    return out;
  };

  const scoresFor = async (models: any[]) => {
    const car = models.filter((m) => !mjlabModel(m));
    if (!car.length) return {} as { [id: string]: any[] };
    const locations = car.map((m) => m.location).filter((l) => typeof l === 'string');
    const scores = await db().collection('leaderboard_scores').find({
      $or: [{ model_id: { $in: withObjectIds(car.map((m) => String(m._id))) } }, { path: { $in: locations } }],
    }).toArray();
    return scoresByModel(car, scores);
  };

  const summaries = async (models: any[]) => {
    const [rows, specs] = await Promise.all([scoresFor(models), envSpecs()]);
    return models.map((m) => modelSummary(m, mjlabModel(m), rows[String(m._id)] || [], specs));
  };

  const runBriefs = async (runIds: string[]) => {
    const out: { [id: string]: any } = {};
    if (!runIds.length) return out;
    const jobs = await db().collection('jobs').find(anyId(runIds), { projection: SUMMARY_PROJECTION }).toArray();
    jobs.forEach((j: any) => {
      const s: any = summarize(ctx, j);
      out[String(j._id)] = {
        id: s.id, name: s.name, status: s.status, job_type: s.job_type, gym_name: s.gym_name, task_id: s.task_id,
        curriculum_name: s.curriculum_name, curriculum_stage_name: s.curriculum_stage_name,
      };
    });
    return out;
  };

  const courseFilter = (robotId: string, course: string): any => {
    if (!course) return null;
    if (robotId && isMjlab(ctx, robotId)) return { task_id: course };
    const car = course === 'donut'
      ? { course_type: { $in: [null, '', 'donut', 'trainer default'] } }
      : { course_type: course };
    return robotId ? car : { $or: [car, { task_id: course }] };
  };

  api.get('/models', route(async (req) => {
    const d = db();
    const and: any[] = [];
    const robotId = String(req.query.robot || '');
    if (robotId) and.push(robotFilter(robotId));
    const run = String(req.query.run || '');
    if (run) and.push({ job_id: { $in: withObjectIds([run]) } });
    const course = courseFilter(robotId, String(req.query.course || ''));
    if (course) and.push(course);
    if (req.query.promoted === '1') and.push({ promoted_at: { $exists: true } });
    if (req.query.evaluated === '1') {
      const [ids, paths] = await Promise.all([
        d.collection('leaderboard_scores').distinct('model_id'),
        d.collection('leaderboard_scores').distinct('path'),
      ]);
      and.push({ $or: [
        { eval_results: { $exists: true } },
        { _id: { $in: withObjectIds(ids.filter(Boolean).map(String)) } },
        { location: { $in: paths.filter(Boolean) } },
      ] });
    }
    const q = String(req.query.q || '').trim();
    if (q) {
      const re = new RegExp(escapeRegex(q), 'i');
      const or: any[] = [{ location: re }, { task_id: re }, { course_type: re }, { model_type: re }, { notes: re },
        { reward_design_name: re }, { experiment_design_name: re }];
      if (/^[0-9a-f]{6,24}$/i.test(q)) {
        const tail = escapeRegex(q) + '$';
        or.push({ $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: tail, options: 'i' } } });
        or.push({ $expr: { $regexMatch: { input: { $toString: { $ifNull: ['$job_id', ''] } }, regex: tail, options: 'i' } } });
      }
      and.push({ $or: or });
    }
    const filter = and.length ? { $and: and } : {};
    const limit = intParam(req.query.limit, 50, 1, MAX_MODELS_PAGE);
    const offset = intParam(req.query.offset, 0, 0, 1e9);
    const sort = MODEL_SORTS[String(req.query.sort || '-created')] || MODEL_SORTS['-created'];
    const models = d.collection('models');
    const scope = robotId ? robotFilter(robotId) : {};
    const [rows, total, courseTypes, tasks] = await Promise.all([
      models.find(filter, { projection: MODEL_ROW_PROJECTION }).sort(sort).skip(offset).limit(limit).toArray(),
      models.countDocuments(filter),
      robotId && isMjlab(ctx, robotId) ? Promise.resolve([]) : models.distinct('course_type', scope),
      robotId && !isMjlab(ctx, robotId) ? Promise.resolve([]) : models.distinct('task_id', scope),
    ]);
    const runs = await runBriefs(rows.map((m: any) => m.job_id).filter(Boolean).map(String));
    const items = (await summaries(rows)).map((s) => ({ ...s, run: (s.run_id && runs[s.run_id]) || null }));
    const courses = courseTypes.map((c: any) => (!c || c === 'trainer default' ? 'donut' : String(c))).concat(tasks.filter(Boolean).map(String));
    return { items, total, offset, limit, courses: courses.filter((c: string, i: number) => courses.indexOf(c) === i).sort() };
  }));

  /** Ranked models of one robot; car rows pool per-trial values across eval runs. */
  const leaderboard = async (robotId: string, metric: string, course: string, stage: any, minTrials: number) => {
    const d = db();
    const mjlab = isMjlab(ctx, robotId);
    if (mjlab) {
      const filter: any = { robot: robotId, eval_results: { $exists: true } };
      const all = await d.collection('models').find(filter, { projection: MODEL_ROW_PROJECTION }).toArray();
      const tasks = all.map((m: any) => m.task_id).filter(Boolean);
      const models = course ? all.filter((m: any) => m.task_id === course) : all;
      return { models, ranked: rankMjlab(models, metric), rowsById: {} as { [id: string]: any[] },
        courses: tasks.filter((t: string, i: number) => tasks.indexOf(t) === i).sort(), stages: [] as number[] };
    }
    const scores = await d.collection('leaderboard_scores').find({}).toArray();
    const ids = scores.map((s: any) => s.model_id).filter(Boolean).map(String);
    const paths = scores.filter((s: any) => !s.model_id && s.path).map((s: any) => s.path);
    const all = await d.collection('models').find({ $and: [robotFilter(CAR), {
      $or: [{ _id: { $in: withObjectIds(ids) } }, { location: { $in: paths } }],
    }] }, { projection: MODEL_ROW_PROJECTION }).toArray();
    const courseList = all.map((m: any) => carCourse(m) as string);
    const models = course ? all.filter((m: any) => carCourse(m) === course) : all;
    const rowsById = scoresByModel(all, scores);
    const stageList = scores.map((s: any) => s.stage_idx).filter((x: any) => typeof x === 'number');
    return {
      models, rowsById, ranked: rankCar(models, rowsById, metric, stageFilter(stage), minTrials),
      courses: courseList.filter((c: string, i: number) => courseList.indexOf(c) === i).sort(),
      stages: stageList.filter((x: number, i: number) => stageList.indexOf(x) === i).sort((a: number, b: number) => a - b),
    };
  };

  api.get('/leaderboard', route(async (req) => {
    const robotId = String(req.query.robot || CAR);
    if (!robot(robotId)) throw new HttpError(404, `unknown robot ${robotId}`);
    const mjlab = isMjlab(ctx, robotId);
    const catalogue = mjlab ? MJLAB_METRICS : CAR_METRICS;
    const metric = catalogue[String(req.query.metric || '')] ? String(req.query.metric) : DEFAULT_METRIC[mjlab ? 'mjlab' : 'car'];
    const minTrials = intParam(req.query.min_trials, 1, 1, 100000);
    const limit = intParam(req.query.limit, 100, 1, 1000);
    const stage = mjlab ? 'main' : String(req.query.stage || 'main');
    const board = await leaderboard(robotId, metric, String(req.query.course || ''), stage, minTrials);
    const top = board.ranked.slice(0, limit);
    const byId: { [id: string]: any } = {};
    board.models.forEach((m: any) => { byId[String(m._id)] = m; });
    const specs = await envSpecs();
    const runs = await runBriefs(top.map((r) => byId[r.model_id].job_id).filter(Boolean).map(String));
    return {
      robot: robotId,
      engine: mjlab ? 'mjlab' : 'car',
      metric,
      metrics: Object.keys(catalogue).map((k) => ({ key: k, ...catalogue[k] })),
      courses: board.courses,
      stages: board.stages,
      stage,
      min_trials: minTrials,
      total: board.ranked.length,
      rows: top.map((r) => {
        const m = byId[r.model_id];
        const s = modelSummary(m, mjlab, board.rowsById[r.model_id] || [], specs);
        return { ...r, model: { ...s, run: (s.run_id && runs[s.run_id]) || null } };
      }),
    };
  }));

  api.get('/models/:id', route(async (req) => {
    const d = db();
    const m = await getModel(req.params.id);
    const mjlab = mjlabModel(m);
    const robotId = robotOfModel(m);
    const rows = (await scoresFor([m]))[String(m._id)] || [];
    const specs = await envSpecs();
    const location = typeof m.location === 'string' ? m.location : '';
    const evalTarget = mjlab ? { checkpoint: location } : { location };
    const gateMatch: any[] = [];
    if (m.job_id) gateMatch.push({ 'results.train_job_id': String(m.job_id) });
    if (location) gateMatch.push({ 'results.checkpoint': location });
    const [evalJobs, curriculumRuns, siblings, run] = await Promise.all([
      location ? d.collection('jobs').find({ $and: [{ job_type: 'EVAL' }, evalTarget] }, { projection: SUMMARY_PROJECTION })
        .sort({ create_date: -1, _id: -1 }).limit(50).toArray() : [],
      gateMatch.length ? d.collection('curriculum_runs').find({ $or: gateMatch }).toArray() : [],
      m.job_id ? d.collection('models').find({ job_id: { $in: withObjectIds([String(m.job_id)]) } }, {
        projection: { training_iterations: 1, create_date: 1, location: 1, eval_results: 1, is_global_best: 1, promoted_at: 1, robot: 1 },
      }).sort({ create_date: 1, _id: 1 }).limit(RUN_CHECKPOINTS).toArray() : [],
      m.job_id ? d.collection('jobs').findOne(idFilter(String(m.job_id)), { projection: SUMMARY_PROJECTION }) : null,
    ]);
    const siblingRows = await scoresFor(siblings);
    const summary = modelSummary(m, mjlab, rows, specs);

    // Where it sits on its robot's leaderboard (car: among models on its course).
    let rank = null;
    if (summary.eval) {
      const metric = DEFAULT_METRIC[mjlab ? 'mjlab' : 'car'];
      const board = await leaderboard(robotId, metric, mjlab ? (m.task_id || '') : summary.course || '', 'main', 1);
      const mine = board.ranked.find((r) => r.model_id === String(m._id));
      rank = mine ? { metric, rank: mine.rank, of: board.ranked.length, course: mjlab ? m.task_id || null : summary.course } : null;
    }
    const onnxLocal = m.onnx_location ? localPath(ctx, String(m.onnx_location)) : null;
    return {
      model: summary,
      run: run ? summarize(ctx, run) : null,
      specs: {
        observation: m.observation_spec || null,
        action: m.action_spec || null,
        env: m.robot_type && specs[String(m.robot_type)] ? {
          observation: specs[String(m.robot_type)].observation_spec || null,
          action: specs[String(m.robot_type)].action_spec || null,
          updated_at: specs[String(m.robot_type)].updated_at || null,
        } : null,
        obs_dim: summary.obs_dim,
        act_dim: summary.act_dim,
      },
      onnx_url: onnxLocal && fs.existsSync(onnxLocal) ? mediaUrl(String(m.onnx_location)) : null,
      clip_url: typeof m.clip === 'string' ? mediaUrl(m.clip) : null,
      git: m.git_sha ? { sha: String(m.git_sha), branch: m.git_branch || null } : null,
      reward_code: typeof m.reward_design_code === 'string' ? m.reward_design_code : null,
      samples: rows.map((r: any) => ({ id: String(r._id), ...evalSample(r) }))
        .sort((a: any, b: any) => String(b.created_at || '').localeCompare(String(a.created_at || ''))),
      aggregate: mjlab && m.eval_results ? { ...m.eval_results, eval_job_id: m.eval_job_id ? String(m.eval_job_id) : null } : null,
      eval_runs: evalJobs.map((j: any) => summarize(ctx, j)),
      gates: gatesFor(m, curriculumRuns),
      rank,
      checkpoints: siblings.map((s: any) => {
        const e = evalSummary(s, mjlabModel(s), siblingRows[String(s._id)] || []);
        return {
          id: String(s._id), iteration: checkpointIteration(s),
          created_at: s.create_date || null, evaluated: !!e, latest_of_run: !!s.is_global_best, promoted: !!s.promoted_at,
        };
      }),
    };
  }));

  api.patch('/models/:id', route(async (req) => {
    const m = await getModel(req.params.id, { _id: 1 });
    const body = req.body || {};
    if (typeof body.notes !== 'string') throw new HttpError(400, 'notes (string) is required');
    if (body.notes.length > 4000) throw new HttpError(400, 'notes must be at most 4000 characters');
    await db().collection('models').updateOne({ _id: m._id }, { $set: { notes: body.notes.trim() || 'NA', updated_at: new Date().toISOString() } });
    return { model: (await summaries([await getModel(req.params.id, MODEL_ROW_PROJECTION)]))[0] };
  }));

  // One promoted model per robot: the one to deploy or warm-start from.
  api.post('/models/:id/promote', route(async (req) => {
    const m = await getModel(req.params.id, { robot: 1 });
    const body = req.body || {};
    if (typeof body.promoted !== 'boolean') throw new HttpError(400, 'promoted (boolean) is required');
    const models = db().collection('models');
    let demoted: string[] = [];
    if (body.promoted) {
      const prev = await models.find({ $and: [robotFilter(robotOfModel(m)), { promoted_at: { $exists: true } }, { _id: { $ne: m._id } }] },
        { projection: { _id: 1 } }).toArray();
      demoted = prev.map((p: any) => String(p._id));
      if (prev.length) await models.updateMany({ _id: { $in: prev.map((p: any) => p._id) } }, { $unset: { promoted_at: '' } });
      await models.updateOne({ _id: m._id }, { $set: { promoted_at: new Date().toISOString() } });
    } else {
      await models.updateOne({ _id: m._id }, { $unset: { promoted_at: '' } });
    }
    return { model: (await summaries([await getModel(req.params.id, MODEL_ROW_PROJECTION)]))[0], demoted };
  }));

  const removeModel = async (id: string) => deleteModel(db(), await getModel(id, { location: 1 }));

  api.delete('/models/:id', route(async (req) => ({ ok: true, ...(await removeModel(req.params.id)) })));

  api.post('/models/delete', route(async (req) => {
    const list = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    if (!list.length || list.length > MAX_BULK) throw new HttpError(400, `ids must list 1-${MAX_BULK} model ids`);
    return {
      results: await Promise.all(list.map(async (id: string) => {
        try {
          return { id, ok: true, ...(await removeModel(id)) };
        } catch (e) {
          return { id, ok: false, error: String((e && (e as any).message) || e) };
        }
      })),
    };
  }));

  mountCurricula(api, ctx, db);
  mountDesigns(api, ctx, db);
  mountLab(api, ctx, db);
  mountInsights(api, ctx, db);
  mountSystem(api, ctx, db, () => (ctx.desiredGyms ? ctx.desiredGyms() : {}));

  api.use(route(async () => { throw new HttpError(404, 'no such API route'); }));

  return api;
}
