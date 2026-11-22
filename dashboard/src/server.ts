import * as express from 'express';
import * as bodyParser from 'body-parser';
import * as path from 'path';
import * as fs from 'fs';
import * as mongoDB from 'mongodb';
const ObjectID = require('mongodb').ObjectID;
const cors = require('cors');
const { spawn } = require('child_process');
const crypto = require('crypto');
import { log, LogLevel } from './log';
import * as morgan from 'morgan';
import { createApiV1 } from './api/v1';
import { applyRunAction, RUN_ACTIONS } from './api/curricula';
import { HttpError } from './api/http';
import { gateGroups, weaknessGrid } from './api/weakness';
import { decide as labDecide, edit as labEdit, proposalId as labProposalId } from './api/lab';
import { setQueuePaused } from './api/queue';
import { deleteModel } from './api/models';
import { Context as ApiContext } from './api/runs';


// ----------------------------------------------------------------
// Process-level crash guards.
//
// The dashboard is a SINGLE Node process. Historically, any transient
// MongoDB error surfaced through a `if (err) throw err` in an async
// driver callback (see the REST handlers below) became an
// uncaughtException / unhandledRejection with no handler - and on
// Node >=15 an unhandled rejection TERMINATES the process by default.
// Docker's `restart: always` then bounced the container, whose
// `npm start` re-runs `prestart` (npm install + tsc) before listening
// again - so a 1s blip became tens of seconds (or, on a network hiccup
// during npm install, an indefinite) outage. That is the "dashboard
// freezes / locks up during a demo" symptom.
//
// These guards keep the event loop alive across a stray async error.
// They are a LAST RESORT backstop: the individual handlers below also
// respond with a 500 instead of throwing, so requests don't hang. We
// deliberately do NOT exit here - a logged-and-swallowed error keeps
// every other tab/socket working, which is exactly what we want for a
// live demo. Genuinely fatal, unrecoverable states (OOM, etc.) still
// crash the runtime on their own.
// ----------------------------------------------------------------
process.on('uncaughtException', (err: any) => {
  console.error('[uncaughtException] kept process alive:', err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (reason: any) => {
  console.error('[unhandledRejection] kept process alive:', reason && ((reason as any).stack || (reason as any).message || reason));
});

// ----------------------------------------------------------------
// Resilient change-stream supervisor.
//
// A MongoDB change stream is a long-lived tailable cursor. When its
// underlying pooled connection is reset (idle-connection reaping, a
// single-node-RS blip, the mongo container bouncing) the stream goes
// inert. A dead stream was once never noticed or recreated, and because
// its handler flips the `*Changed` flag the REST poll path is gated on,
// it froze the change-gated routes until the container was restarted.
//
// This supervisor (re)creates a stream and, on ANY error/close,
// schedules a recreate with capped exponential backoff. On every
// (re)open it fires `markChanged()` so the REST poll path re-syncs the
// data that may have changed while the stream was down (change streams
// can't replay missed events without a stored resume token, and the
// poll fallback is the cheap, correct catch-up path here).
// ----------------------------------------------------------------
function superviseChangeStream(
  collName: string,
  collection: any,
  markChanged: () => number | void,
): void {
  let backoff = 1000;
  const MAX_BACKOFF = 30000;

  const open = () => {
    let stream: any = null;
    let reopened = false;

    const scheduleReopen = (why: string, info?: any) => {
      if (reopened) return;          // error+close both fire; recreate once
      reopened = true;
      console.error(`[stream:${collName}] ${why}; recreating in ${backoff}ms`,
        info != null ? info : '');
      if (stream) { try { Promise.resolve(stream.close()).catch(() => {}); } catch (e) { /* noop */ } }
      const delay = backoff;
      backoff = Math.min(MAX_BACKOFF, backoff * 2);
      setTimeout(open, delay);
    };

    try {
      stream = collection.watch([], { fullDocument: 'updateLookup' });
    } catch (e: any) {
      scheduleReopen('watch() threw', e && (e.message || e));
      return;
    }

    // Re-sync the REST poll path on every (re)open.
    markChanged();

    stream.on('change', (change: any) => {
      backoff = 1000;                // healthy traffic resets the backoff
      console.log(`Change detected (${collName}):`, change.operationType, change.documentKey?._id);
      markChanged();
    });
    stream.on('error', (err: any) => scheduleReopen('stream error', err && (err.message || err)));
    stream.on('close', () => scheduleReopen('stream closed'));
  };

  open();
}

export const createServer = (config): express.Application => {
  const app: express.Application = express();
  const databaseName = process.env.DATABASE_NAME || "robotaxi";
  var jobsChanged = true;
  var modelsChanged = true;
  var leaderboardScoresChanged = true;
  // The env_specs collection holds one document per robot_type
  // describing the live env's observation / action spec. Populated by
  // robotaxi.py's publish_env_spec() at every TRAIN / EVAL job start.
  // Used by the Models tab's "Compat" column to flag rows whose
  // training-time spec no longer matches the running env.
  var envSpecsChanged = true;
  // The reward_designs collection holds user-authored reward functions
  // (see rl_agent/reward_designs.py). One document per design with a
  // human-friendly name + Python source code + version. Selected
  // per-job via the New-Job form's "Reward design" dropdown.
  var rewardDesignsChanged = true;
  // Sibling of rewardDesignsChanged: the experiment_designs collection
  // holds user-authored training-loop configs (SAC hyperparameters,
  // BC pretrain steps, replay capacity, network sizes). Selected per-
  // job via the New-Job form's "Experiment design" dropdown alongside
  // the existing Reward design dropdown.
  var experimentDesignsChanged = true;
  // The gyms collection records registered Unity scene / gym
  // configurations (name + full file path). Selected per-job via the
  // New-Job and Eval dialogs' "Gym" dropdowns.
  var gymsChanged = true;
  // The demos collection registers expert-demonstration TFRecords
  // directories (see rl_agent/demos_registry.py). Selected per-job via
  // the New-Job dialog's "Expert demos" dropdown.
  var demosChanged = true;
  var robotsChanged = true;
  var curriculaChanged = true;
  var curriculumRunsChanged = true;

  // ----------------------------------------------------------------
  // Per-collection version cursor.
  //
  // The `*Changed` booleans above are a SINGLE shared flag per
  // collection: whichever client polls first consumes it (flips it
  // false), so a second tab polling the same collection gets a false
  // NO_CHANGES and renders stale. That's why every polling tab had to
  // pass ?force=true (re-pulling the entire collection every few
  // seconds) - which is the load we're trying to remove.
  //
  // These monotonically-increasing counters are the per-client fix. The
  // change-stream bumps the counter on every write; a client passes
  // ?since=<last-seen-version> and the server replies NO_CHANGES only if
  // the client is already current (since >= version). Because the
  // decision is derived from the client's own cursor (not a shared
  // boolean), N tabs can all poll cheaply without racing each other.
  // The current version rides back on every response as the
  // `X-Coll-Version` header (present on both data and NO_CHANGES
  // replies) so the client can advance its cursor.
  //
  // Backward compatible: ?force=true still forces; a client that sends
  // neither force nor since falls back to the legacy shared-flag path.
  // ----------------------------------------------------------------
  const collVersions: Record<string, number> = {
    jobs: 1, models: 1, leaderboard_scores: 1, env_specs: 1,
    reward_designs: 1, experiment_designs: 1, gyms: 1, demos: 1, robots: 1,
    curricula: 1, curriculum_runs: 1,
  };
  const bumpVersion = (name: string): number => {
    collVersions[name] = (collVersions[name] || 0) + 1;
    return collVersions[name];
  };

  var MongoClient = mongoDB.MongoClient;
  var url = process.env.MONGODB_URL || "mongodb://root:example@mongo:27017";
  var dbo;
  // Retry the initial connect instead of throwing (a throw here at boot
  // would crash the process before it ever listens; with restart:always
  // that becomes a tight crash-loop whenever mongo is a few seconds
  // behind the dashboard coming up).
  const connectWithRetry = (attempt: number) => {
    MongoClient.connect(url, function(err, db) {
      if (err) {
        const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
        console.error(`[mongo] connect failed (attempt ${attempt + 1}); retrying in ${delay}ms:`, err && (err.message || err));
        setTimeout(() => connectWithRetry(attempt + 1), delay);
        return;
      }
      dbo = db.db(databaseName);
      onConnected();
    });
  };
  const onConnected = () => {
    // create a collection object for the collection based on collection_name
    // collectionNames.forEach(function(collectionName) {
    //   const collection = dbo.collection(collectionName);
    //   const changeStream = collection.watch();
  
    //   // listen for changes in the collection
    //   changeStream.on('change', function(change) {
    //     console.log(`Change detected in ${collectionName}:`, change);
    //     // handle the change event here
    //   });
    // });
    // Each collection gets a self-healing change stream (see
    // superviseChangeStream). The markChanged callback flips the same
    // `*Changed` flag the matching REST route is gated on, so the poll
    // path recovers after a stream recreate.
    superviseChangeStream('jobs', dbo.collection("jobs"), () => { jobsChanged = true; return bumpVersion('jobs'); });
    superviseChangeStream('models', dbo.collection("models"), () => { modelsChanged = true; return bumpVersion('models'); });
    superviseChangeStream('leaderboard_scores', dbo.collection("leaderboard_scores"), () => { leaderboardScoresChanged = true; return bumpVersion('leaderboard_scores'); });
    superviseChangeStream('env_specs', dbo.collection("env_specs"), () => { envSpecsChanged = true; return bumpVersion('env_specs'); });
    superviseChangeStream('reward_designs', dbo.collection("reward_designs"), () => { rewardDesignsChanged = true; return bumpVersion('reward_designs'); });
    superviseChangeStream('experiment_designs', dbo.collection("experiment_designs"), () => { experimentDesignsChanged = true; return bumpVersion('experiment_designs'); });
    superviseChangeStream('gyms', dbo.collection("gyms"), () => { gymsChanged = true; return bumpVersion('gyms'); });
    superviseChangeStream('demos', dbo.collection("demos"), () => { demosChanged = true; return bumpVersion('demos'); });
    superviseChangeStream('robots', dbo.collection("robots"), () => { robotsChanged = true; refreshRobotCacheFromDb().catch(() => {}); return bumpVersion('robots'); });
    superviseChangeStream('curricula', dbo.collection("curricula"), () => { curriculaChanged = true; return bumpVersion('curricula'); });
    superviseChangeStream('curriculum_runs', dbo.collection("curriculum_runs"), () => { curriculumRunsChanged = true; return bumpVersion('curriculum_runs'); });
    dbo.collection("jobs").createIndex(
      { curriculum_key: 1 },
      { name: "jobs_curriculum_key", partialFilterExpression: { curriculum_key: { $type: "string" } } }
    ).catch((e: any) => console.warn('jobs curriculum_key index failed:', e && e.message));
    seedRobotsFromManifests().catch((e) => console.warn('robots seed failed:', e && e.message));

    // One demos row per DEMO job: the trainer and the backfill script both
    // upsert on source_job_id. Hand-registered rows carry no source job.
    dbo.collection("demos").createIndex(
      { source_job_id: 1 },
      { name: "demos_source_job", unique: true,
        partialFilterExpression: { source_job_id: { $type: "string" } } }
    ).catch((e) => console.warn('demos index create failed:', e && e.message));

    // One-shot, idempotent backfill of the per-job `course_type` field
    // (added alongside the New-job form's Course selector). Every job that
    // predates that field ran against the only course that existed then -
    // the classic 'donut' course - so stamping course_type='donut' on any
    // doc missing it is accurate historical provenance, and lets the Jobs
    // table's Course column show a concrete value instead of a fallback.
    // Runs once per server start; the {$exists:false} filter makes it a
    // no-op on subsequent boots (and never touches docs that already carry
    // an explicit course_type from the form).
    // Other robots' jobs (robot set, e.g. microduck) have no course; earlier
    // versions of this backfill stamped 'donut' on them too, so undo that.
    const carJob = { $or: [{ robot: { $exists: false } }, { robot: 'roboracer' }] };
    dbo.collection("jobs").updateMany(
      { course_type: { $exists: false }, ...carJob },
      { $set: { course_type: "donut" } }
    ).then((r) => {
      if (r && r.modifiedCount) {
        console.log(`course_type backfill: set 'donut' on ${r.modifiedCount} legacy job(s)`);
      }
    }).catch((e) => {
      console.warn("course_type backfill failed:", e && e.message ? e.message : e);
    });
    dbo.collection("jobs").updateMany(
      { robot: { $exists: true, $nin: ['roboracer'] }, course_type: { $exists: true } },
      { $unset: { course_type: "" } }
    ).then((r) => {
      if (r && r.modifiedCount) console.log(`course_type: removed from ${r.modifiedCount} non-car job(s)`);
    }).catch((e) => {
      console.warn("course_type cleanup failed:", e && e.message ? e.message : e);
    });
    // Non-car jobs queued before /add_job stamped gym_name (see stampRobotFromGym).
    (async () => {
      const jobs = await dbo.collection("jobs").find(
        { robot: { $exists: true, $nin: ['roboracer'] }, gym_name: { $exists: false }, task_id: { $exists: true } },
        { projection: { robot: 1, task_id: 1 } }).toArray();
      let named = 0;
      for (const j of jobs) {
        const gym = await dbo.collection("gyms").findOne({ _id: `${j.robot}:${j.task_id}` }, { projection: { name: 1 } });
        if (!gym || !gym.name) continue;
        await dbo.collection("jobs").updateOne({ _id: j._id }, { $set: { gym_name: gym.name } });
        named++;
      }
      if (named) console.log(`gym_name backfill: named the gym on ${named} non-car job(s)`);
    })().catch((e) => console.warn("gym_name backfill failed:", e && e.message ? e.message : e));

    // Index for the Weakness Map (/weakness_map). The logs collection is
    // dominated by per-step "did not fail" rows (no position_history), so
    // an unindexed {job_id, position_history} query degrades to a full
    // collection scan - which for a non-existent job_id never short-
    // circuits and hangs the request. This compound index lets Mongo
    // walk one job's rows newest-first directly. Idempotent / background.
    dbo.collection("logs").createIndex(
      { job_id: 1, _id: -1 },
      { name: "weakness_job_recent", background: true }
    ).then(
      (n) => console.log('logs index ensured:', n),
      (e) => console.warn('logs index create failed:', e && e.message)
    );

  };
  connectWithRetry(0);

  if (config.logging != "none") {
    app.use(morgan(config.logging));
  }

  app.use(cors());
  app.options('*', cors());
  // List endpoints are change-gated GETs whose body is often the
  // identical "NO_CHANGES" string. Express's default ETag turns that
  // into a 304, and fetch() then either throws (status not ok) or
  // serves a cached payload — both look like a frozen jobs table.
  app.set('etag', false);
  // Let browser fetch() read the version cursor header (needed only for
  // cross-origin reads; harmless same-origin).
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Expose-Headers', 'X-Coll-Version');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(bodyParser.json());

  // The new app (dashboard/app, built to app/dist) and its API. Mounted ahead of
  // the static handler below, which would otherwise serve app/ as source files.
  const desiredGymState: Map<string, any> = new Map();
  const apiContext: ApiContext = {
    db: () => dbo,
    desiredGyms: () => {
      const out: { [index: string]: any } = {};
      desiredGymState.forEach((v, k) => { out[k] = v; });
      return out;
    },
    robots: () => robotCache,
    mediaRoots: () => mediaRoots,
  };
  app.locals.apiContext = apiContext;
  app.use('/api/v1', createApiV1(apiContext));
  const appDist = path.join(__dirname, '/../app/dist');
  app.use('/app', express.static(appDist, { index: false }));
  app.get(['/app', '/app/*'], (req, res) => {
    const index = path.join(appDist, 'index.html');
    if (fs.existsSync(index)) {
      res.sendFile(index);
    } else {
      res.status(503).type('text/plain').send(
        'The new app is not built yet. On the host: cd dashboard/app; npm install; npm run build');
    }
  });

  // The classic Golden Layout pages became the app; old links still land.
  app.get(['/', '/index.html'], (req, res) => res.redirect('/app'));
  app.get(['/jobs', '/jobs.html'], (req, res) => res.redirect('/app/runs'));
  app.get(['/logs', '/logs.html'], (req, res) => res.redirect('/app/system'));
  app.get(['/weakness', '/weakness.html'], (req, res) => {
    const run = typeof req.query.job_id === 'string' ? req.query.job_id : '';
    res.redirect(run ? `/app/insights?run=${encodeURIComponent(run)}` : '/app/insights');
  });
  app.get(['/madscientist', '/madscientist.html'], (req, res) => res.redirect('/app/lab'));
  // The Models and Leaderboard tabs became /app/models.
  app.get(['/models', '/models.html'], (req, res) => res.redirect('/app/models'));
  app.get(['/leaderboard', '/leaderboard.html'], (req, res) => res.redirect('/app/models?view=leaderboard'));
  // Decide whether a change-gated GET should return fresh data. Always
  // stamps the current per-collection version on the response so the
  // client can advance its cursor (even on a NO_CHANGES reply).
  //
  //   ?force=true      -> always send (legacy / on-demand loads)
  //   ?since=<version> -> per-client cursor: send iff the client is
  //                       behind (since < current version). Unparseable
  //                       `since` fails safe toward sending.
  //   (neither)        -> legacy shared-`changed`-flag path.
  var needsUpdate = function (req, res, changed, collName) {
    const ver = collVersions[collName] || 0;
    try { res.setHeader('X-Coll-Version', String(ver)); } catch (e) { /* headers already sent */ }
    if (req.query.force === 'true') return true;
    if (req.query.since !== undefined) {
      const since = parseInt(String(req.query.since), 10);
      return !Number.isFinite(since) || since < ver;
    }
    return changed;
  }


  app.get('/leaderboard_scores', (req,res) => {
    if(needsUpdate(req, res, leaderboardScoresChanged, 'leaderboard_scores'))
    {
      leaderboardScoresChanged=false;
      dbo.collection("leaderboard_scores").find({}).toArray(function(err, result) {
        if (err) { console.error('leaderboard_scores query failed:', err); leaderboardScoresChanged = true; res.status(500).json({ error: String(err && (err.message || err)) }); return; }
        console.log(`${result.length} leaderboard scores retrieved`);
        res.json(result);
      });
      return;
    }
    
    console.log(`No leaderboard scores retrieved`);
    res.status(200).send('NO_CHANGES');
  
  });
  // A job's gym decides which worker claims it: duck gyms
  // (robot: "microduck", from rl_agent/duck/gyms.py) stamp robot and
  // task_id so the car trainer, which takes every job without a robot,
  // never picks them up.
  async function stampRobotFromGym(job: any) {
    if (!job) return;
    // Duck EVAL / EXPORT / VIDEO jobs name a task rather than a gym.
    const gymId = job.gym_id
      || (job.robot && job.robot !== 'roboracer' && job.task_id ? `${job.robot}:${job.task_id}` : null);
    if (!gymId) return;
    const gym = await dbo.collection("gyms").findOne(
      { _id: String(gymId) }, { projection: { robot: 1, task_id: 1, name: 1 } });
    if (!gym || !gym.robot || gym.robot === 'roboracer') return;
    job.robot = gym.robot;
    if (!job.task_id && gym.task_id) job.task_id = gym.task_id;
    if (!job.gym_name && gym.name) job.gym_name = gym.name;
  }

  app.post('/add_job', async (req,res) => {
    console.log("add_job: " + JSON.stringify(req.body));
    try {
      await stampRobotFromGym(req.body);
    } catch (err) {
      console.error('add_job gym lookup failed:', err);
      res.status(500).json({ error: String(err && ((err as any).message || err)) });
      return;
    }
    dbo.collection("jobs").insertOne(req.body,function(err, result) {
      if (err) { console.error('add_job failed:', err); res.status(500).json({ error: String(err && (err.message || err)) }); return; }
      res.json(result)
    });
  });
  app.get('/get_jobs', (req,res) => {
    if (needsUpdate(req, res, jobsChanged, 'jobs')) {
      jobsChanged=false;
      dbo.collection("jobs").find({}).toArray(function(err, result) {
          if (err) { console.error('get_jobs query failed:', err); jobsChanged = true; res.status(500).json({ error: String(err && (err.message || err)) }); return; }
          console.log(`${result.length} jobs retrieved`)
          res.json(result)
      });
      return;
    }
    
    console.log(`No jobs retrieved`);
    res.status(200).send('NO_CHANGES');
  });

  // Classic weakness routes for the MCP console; the app uses /api/v1/insights (api/weakness.ts).
  app.get('/weakness_map', (req, res) => {
    const jobId = String(req.query.job_id || '');
    if (!jobId) { res.status(400).json({ ok: false, error: 'job_id required' }); return; }
    const bins = Math.max(8, Math.min(200, parseInt(String(req.query.bins || '48'), 10) || 48));
    const limit = Math.max(1, Math.min(5000, parseInt(String(req.query.limit || '500'), 10) || 500));
    weaknessGrid(dbo, jobId, bins, limit).then((g) => res.json(g), (err) => res.status(500).json({ ok: false, error: String(err) }));
  });

  // Difficulty by goal gate (api/weakness.ts gateGroups); the MCP console's gate tools read it.
  app.get('/weakness_by_gate', (req, res) => {
    const jobId = String(req.query.job_id || '');
    if (!jobId) { res.status(400).json({ ok: false, error: 'job_id required' }); return; }
    const limit = Math.max(1, Math.min(20000, parseInt(String(req.query.limit || '2000'), 10) || 2000));
    gateGroups(dbo, jobId, limit).then(
      (gates) => res.json({ ok: true, job_id: jobId, segments: gates.reduce((s, g) => s + g.attempts, 0), gates }),
      (err) => res.status(500).json({ ok: false, error: String(err) }));
  });

  app.post('/update_job_status', (req, res) => {
    console.log("update_job_status: " + JSON.stringify(req.body));
    var job = req.body;
    const myquery = { "_id": ObjectID(job["_id"]) };
    const newvalues = { "$set": { "status": job["status"] } };
    const options = { upsert: false };
    dbo.collection("jobs").updateOne(myquery,newvalues, options, function(err, result) {
      if (err) { console.error('update_job_status failed:', err); res.status(500).json({ error: String(err && (err.message || err)) }); return; }
      console.log(result);
      res.json(result)
    });
  });

  app.post('/delete_job', (req,res) => {
    var job = req.body;
    const myquery = { "_id": ObjectID(job["_id"]) };
    console.log(myquery);
    dbo.collection("jobs").deleteOne(myquery, function(err, result) {
      if (err) { console.error('delete_job failed:', err); res.status(500).json({ error: String(err && (err.message || err)) }); return; }
      console.log(result);
      res.json(result)
    });
  });

  // Full-cleanup delete of a model (files under /saved_models, its
  // leaderboard_scores, the record); same as DELETE /api/v1/models/:id.
  app.post('/delete_model', (req, res) => {
    const body = req.body || {};
    if (!body._id) {
      res.status(400).json({ error: "_id is required" });
      return;
    }
    const ids: any[] = [String(body._id)];
    try { ids.push(ObjectID(body._id)); } catch (e) { /* legacy string _id */ }
    dbo.collection("models").findOne({ _id: { $in: ids } }, { projection: { location: 1 } })
      .then((model: any) => {
        if (!model) return { deletedCount: 0, files_deleted: false, scores_deleted: 0 };
        return deleteModel(dbo, model).then((summary) => ({ deletedCount: 1, ...summary }));
      })
      .then((result: any) => {
        console.log('delete_model:', body._id, result);
        res.json(result);
      })
      .catch((err: any) => {
        console.error('delete_model failed:', err);
        res.status(500).json({ error: String(err && (err.message || err)) });
      });
  });

  // Global job-queue pause switch. A singleton doc in queue_control that
  // the trainer's run_jobs_loop polls (_is_queue_paused). When paused, the
  // trainer stops picking up NEW jobs but leaves all job statuses alone, so
  // the operator can halt the queue, test something, then resume where it
  // left off. Distinct from per-job Pause (which checkpoints + PAUSES a
  // single running job).
  app.get('/get_queue_state', (req, res) => {
    dbo.collection("queue_control").findOne({ _id: "singleton" }, function(err, doc) {
      if (err) {
        console.error('get_queue_state failed:', err);
        res.status(500).json({ error: String(err) });
        return;
      }
      res.json({ paused: !!(doc && (doc as any).paused) });
    });
  });

  // Pausing also pauses the running job(s); resuming re-queues only those
  // (api/queue.ts setQueuePaused, shared with /api/v1/queue).
  app.post('/set_queue_state', async (req, res) => {
    const paused = !!(req.body && req.body.paused);
    try {
      const jobs = await setQueuePaused(dbo, paused);
      console.log('queue paused =', paused);
      res.json({ ok: true, paused, jobs });
    } catch (err) {
      console.error('set_queue_state failed:', err);
      res.status(500).json({ error: String(err) });
    }
  });

  // The Analysis page became /app/compare; old links carried ?ids=<model ids>.
  app.get(['/analysis', '/analysis.html'], (req, res) => {
    const ids = typeof req.query.ids === 'string' ? req.query.ids : '';
    res.redirect(ids ? `/app/compare?tab=evals&models=${encodeURIComponent(ids)}` : '/app/compare');
  });

  // The design and curricula pages moved into the app; old links (and their ?id=) still land.
  const MOVED: { [page: string]: string } = {
    rewards: '/app/design/rewards',
    reward_designs: '/app/design/rewards',
    reward_specs: '/app/design/specs',
    experiment_designs: '/app/design/experiments',
    gyms: '/app/design/gyms',
    demos: '/app/design/demos',
    curricula: '/app/curricula',
  };
  Object.keys(MOVED).forEach((page) => {
    app.get([`/${page}`, `/${page}.html`], (req, res) => {
      const id = typeof req.query.id === 'string' && req.query.id ? `/${encodeURIComponent(req.query.id)}` : '';
      res.redirect(MOVED[page] + id);
    });
  });

  // ---------------------------------------------------------------- *
  // Desired-gym state for the Unity supervisor hot-swap feature.
  //
  // When do_job in robotaxi.py picks up a job that carries a gym,
  // it POSTs to /set_desired_gym with the gym's file_path. Each
  // RunClientWrapper.ps1 supervisor polls /get_desired_gym?index=N
  // and restarts the Unity process with the new binary if the path
  // has changed, or in or out of -batchmode if `headless` has.
  //
  // State is in-memory (keyed by actor index or '*' for all actors).
  // It does not survive a dashboard container restart, which is
  // intentional: after a restart the supervisors poll once more and
  // the running job's do_job will re-signal if it hasn't finished yet.
  // ---------------------------------------------------------------- *

  app.get('/get_desired_gym', (req, res) => {
    const idx = req.query.index !== undefined ? String(req.query.index) : '*';
    // Return the per-index entry if present, otherwise the wildcard entry.
    const state = desiredGymState.get(idx) || desiredGymState.get('*') || null;
    res.json(state || {});
  });

  app.post('/set_desired_gym', (req, res) => {
    const body = req.body || {};
    if (!body.file_path) {
      res.status(400).json({ error: 'file_path is required' });
      return;
    }
    // If index is omitted or '*', broadcast to all actors.
    const idx = body.index !== undefined ? String(body.index) : '*';
    const state = {
      gym_id:    String(body.gym_id   || ''),
      gym_name:  String(body.gym_name || ''),
      file_path: String(body.file_path),
      headless:  body.headless === true,
      set_at:    new Date().toISOString(),
    };
    desiredGymState.set(idx, state);
    console.log(`[desired-gym] index=${idx} -> ${state.file_path}${state.headless ? ' (headless)' : ''}`);
    res.json({ ok: true, index: idx, state });
  });

  // ---- MadScientist API ----------------------------------------------
  //
  // Three endpoints feed the Mad Scientist Lab dashboard tab. Each is
  // intentionally narrow:
  //
  //   GET /madscientist/proposals?status=<csv>&limit=<n>
  //       Returns proposals filtered by status. status defaults to
  //       "pending_user,implementing,pr_open,training,done,failed"
  //       (everything an operator might want to see). Heavy fields
  //       (rubric markdown, full audit_events) are stripped server-
  //       side to keep the payload small for the 5s poll cadence.
  //
  //   GET /madscientist/activity?limit=<n>
  //       Returns recent audit_events flattened across all proposals,
  //       sorted by timestamp desc. Renders as the activity feed.
  //
  //   POST /madscientist/decide
  //       Body: { proposal_id, action: "approve"|"reject"|"defer", note }
  //       Updates the proposal's status + decision fields. Phase 1A
  //       does NOT yet trigger the orchestrator on "approve" - that
  //       lands in Phase 1C. For now an approved proposal just sits
  //       at status=approved waiting for the human to act on it.
  //
  // The status enum + collection name come straight from the Python
  // side (rl_agent/madscientist/constants.py); we duplicate them
  // here because the dashboard server doesn't import Python modules.
  // Drift risk is low because the values are extremely stable.

  const MS_PROPOSALS_COLL = 'proposals';
  const MS_VALID_DECISIONS = new Set([
    'approve', 'reject', 'defer', 'approve_with_revisions',
  ]);
  const MS_OBJID_RE = /^[a-fA-F0-9]{24}$/;

  function labRoute(res: express.Response, fn: () => Promise<any>) {
    Promise.resolve().then(fn).then(
      (body) => res.json(body),
      (e) => {
        if (e instanceof HttpError) res.status(e.status).json({ error: e.message });
        else sendError(res, 'madscientist', e);
      });
  }

  app.get('/madscientist/proposals', (req, res) => {
    const rawStatus = (req.query.status as string | undefined) || '';
    let statusFilter: string[];
    if (rawStatus.trim()) {
      statusFilter = rawStatus.split(',').map((s) => s.trim()).filter((s) => s.length);
    } else {
      // Default: everything except still-being-judged (those don't
      // need UI attention yet) and the explicitly-rejected ones
      // (they live in the activity feed instead).
      statusFilter = [
        'pending_user', 'deferred', 'approved', 'implementing',
        'pr_open', 'training', 'done', 'failed',
      ];
    }
    const limit = Math.max(1, Math.min(200,
      parseInt((req.query.limit as string) || '50', 10) || 50));

    // Projection: omit heavy / sensitive / not-yet-used fields. Keeps
    // the polled payload small.
    const projection = {
      // never send: rubric markdown, full audit_event details (we
      // serve those separately from /madscientist/activity),
      // implementation_log streams (those are tailed via a
      // dedicated endpoint in Phase 1C).
      audit_events: 0,
      implementation_log: 0,
    };

    dbo.collection(MS_PROPOSALS_COLL)
      .find({ status: { $in: statusFilter } }, { projection })
      .sort({ updated_at: -1, created_at: -1 })
      .limit(limit)
      .toArray((err, docs) => {
        if (err) {
          console.error('GET /madscientist/proposals:', err);
          res.status(500).json({ error: String(err) });
          return;
        }
        res.json(docs || []);
      });
  });

  // GET /madscientist/proposals/:id
  //   Returns the full proposal document including audit_events and
  //   the full judge_review (no projection). Used by the Activity
  //   Feed's "view details" modal so the operator can review the
  //   proposal + judge review + audit timeline after approval (the
  //   carousel only shows pending proposals).
  app.get('/madscientist/proposals/:id', (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!MS_OBJID_RE.test(id)) {
      res.status(400).json({ error: 'proposal id must be a 24-char hex ObjectId' });
      return;
    }
    dbo.collection(MS_PROPOSALS_COLL).findOne(
      { _id: ObjectID(id) },
      {},
      (err, doc) => {
        if (err) {
          console.error('GET /madscientist/proposals/:id:', err);
          res.status(500).json({ error: String(err) });
          return;
        }
        if (!doc) {
          res.status(404).json({ error: 'proposal not found' });
          return;
        }
        res.json(doc);
      });
  });

  app.get('/madscientist/activity', (req, res) => {
    const limit = Math.max(1, Math.min(200,
      parseInt((req.query.limit as string) || '30', 10) || 30));
    // Page offset (number of most-recent events to skip). Enables the
    // dashboard's Prev/Next paging through older activity.
    const offset = Math.max(0,
      parseInt((req.query.offset as string) || '0', 10) || 0);

    // Aggregate the most-recent N audit_events across all proposals,
    // sorted by timestamp desc. We use a Mongo aggregation so the
    // unwind + sort + limit happens server-side instead of streaming
    // every proposal across the wire.
    //
    // For proposals in `training` state, we $lookup the related TRAIN
    // jobs and project their status array as `job_statuses`. The
    // dashboard Activity Feed uses this to render an aggregated job-
    // status badge (e.g. "IN_PROGRESS 2/4 · 1 FAILED") instead of the
    // bare `training` proposal status. Lookup happens BEFORE $unwind
    // so we do one lookup per proposal, not one per event.
    dbo.collection(MS_PROPOSALS_COLL).aggregate([
      { $match: { audit_events: { $exists: true, $ne: [] } } },
      // $lookup with a let + $expr because proposals._id is ObjectId
      // and jobs.proposal_id is stored as the 24-char hex STRING (the
      // madscientist orchestrator stamps it via str(proposal['_id'])
      // - see rl_agent/madscientist/orchestrator.py). Plain
      // localField/foreignField $lookup does strict equality and
      // would return [] for every row because ObjectId != str.
      { $lookup: {
          from: 'jobs',
          let: { proposalIdStr: { $toString: '$_id' } },
          pipeline: [
            { $match: { $expr: { $eq: ['$proposal_id', '$$proposalIdStr'] } } },
            { $project: { _id: 0, status: 1 } },
          ],
          as: '_jobs',
        } },
      { $unwind: '$audit_events' },
      { $project: {
          _id: 0,
          proposal_id: '$_id',
          proposal_title: '$title',
          proposal_status: '$status',
          at: '$audit_events.at',
          by_agent: '$audit_events.by_agent',
          event: '$audit_events.event',
          detail: '$audit_events.detail',
          job_statuses: '$_jobs.status',
        } },
      { $sort: { at: -1 } },
      // $facet returns one page of events AND the total event count in a
      // single round-trip, so the dashboard pager can show "X–Y of Z"
      // and disable Next at the end without a second query.
      { $facet: {
          rows:  [ { $skip: offset }, { $limit: limit } ],
          total: [ { $count: 'count' } ],
      } },
    ]).toArray((err, result) => {
      if (err) {
        console.error('GET /madscientist/activity:', err);
        res.status(500).json({ error: String(err) });
        return;
      }
      const facet = (result && result[0]) || {};
      const rows = facet.rows || [];
      const total = (facet.total && facet.total[0] && facet.total[0].count) || 0;
      res.json({ rows, total, offset, limit });
    });
  });

  // POST /madscientist/proposals/:id/edit  Body: { patch: { <field>: <value>, ... } }
  // Whitelisted edits to a pending_user / deferred proposal (api/lab.ts editPatch).
  app.post('/madscientist/proposals/:id/edit', (req, res) => {
    labRoute(res, () => labEdit(dbo, labProposalId(req.params.id), (req.body || {}).patch, 'dashboard'));
  });

  // GET /madscientist/act?token=<pid.action.exp.hmac>
  //   The magic-link target for the Approve / Reject / Defer buttons in
  //   the proposal notification email (see
  //   rl_agent/madscientist/email_bridge.py). Verifies the HMAC-SHA256
  //   token (signed with MADSCIENTIST_TOKEN_SECRET, must match the
  //   Python signer), applies the decision via the same logic as
  //   /madscientist/decide, and returns a small HTML confirmation page
  //   (since it's opened in a browser from an email client).
  //
  //   "Single use" is enforced by gating the update on the proposal
  //   still being in pending_user/deferred - a stale link can't
  //   override a decision already taken (e.g. can't reject a proposal
  //   that's already approved + training).
  const MS_TOKEN_SECRET = (process.env.MADSCIENTIST_TOKEN_SECRET || '').trim();
  const MS_ACT_STATUSES = new Set(['pending_user', 'deferred']);

  function msActPage(opts: { ok: boolean; heading: string; body: string }): string {
    const accent = opts.ok ? '#4f46e5' : '#dc2626';
    return `<!DOCTYPE html><html><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>MadScientist decision</title></head>` +
      `<body style="margin:0;background:#0f172a;font-family:Arial,sans-serif">` +
      `<div style="max-width:520px;margin:40px auto;background:#ffffff;` +
      `border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">` +
      `<div style="padding:18px 22px;background:#0f172a;color:#818cf8;` +
      `font-size:11px;letter-spacing:0.08em;text-transform:uppercase;` +
      `font-weight:700">MadScientist</div>` +
      `<div style="padding:24px">` +
      `<h2 style="margin:0 0 10px 0;color:${accent};font-size:20px">${opts.heading}</h2>` +
      `<div style="color:#334155;font-size:14px;line-height:1.6">${opts.body}</div>` +
      `<div style="margin-top:22px"><a href="/app/lab" ` +
      `style="display:inline-block;padding:10px 18px;background:#4f46e5;` +
      `color:#fff;text-decoration:none;border-radius:8px;font-weight:600;` +
      `font-size:14px">Open the dashboard</a></div>` +
      `</div></div></body></html>`;
  }

  app.get('/madscientist/act', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const token = String(req.query.token || '');

    if (!MS_TOKEN_SECRET) {
      res.status(503).send(msActPage({
        ok: false,
        heading: 'One-click decisions are disabled',
        body: 'MADSCIENTIST_TOKEN_SECRET is not configured on the server, ' +
          'so signed decision links can\'t be verified. Use the dashboard ' +
          'to decide.',
      }));
      return;
    }

    const parts = token.split('.');
    if (parts.length !== 4) {
      res.status(400).send(msActPage({
        ok: false, heading: 'Invalid link',
        body: 'This decision link is malformed.',
      }));
      return;
    }
    const [pid, action, expStr, sig] = parts;
    const signed = `${pid}.${action}.${expStr}`;
    const expected = crypto.createHmac('sha256', MS_TOKEN_SECRET)
      .update(signed).digest('hex');
    // Constant-time compare; lengths must match for timingSafeEqual.
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    const sigOk = sigBuf.length === expBuf.length &&
      crypto.timingSafeEqual(sigBuf, expBuf);
    if (!sigOk) {
      res.status(403).send(msActPage({
        ok: false, heading: 'Invalid or tampered link',
        body: 'The signature on this decision link did not verify.',
      }));
      return;
    }
    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp) || Math.floor(Date.now() / 1000) > exp) {
      res.status(410).send(msActPage({
        ok: false, heading: 'Link expired',
        body: 'This decision link has expired. Use the dashboard to decide.',
      }));
      return;
    }
    if (!MS_ACT_STATUSES.has('pending_user') || !MS_VALID_DECISIONS.has(action)) {
      res.status(400).send(msActPage({
        ok: false, heading: 'Invalid action',
        body: `Action ${action} is not recognized.`,
      }));
      return;
    }
    if (!MS_OBJID_RE.test(pid)) {
      res.status(400).send(msActPage({
        ok: false, heading: 'Invalid link',
        body: 'The proposal id in this link is malformed.',
      }));
      return;
    }

    const now = new Date();
    let nextStatus: string;
    if (action === 'reject') nextStatus = 'rejected';
    else if (action === 'defer') nextStatus = 'deferred';
    else nextStatus = 'approved';

    const decision = {
      at: now, by: 'user', action, note: '',
      revision_applied: false, source: 'email',
    };
    const auditEvent = {
      at: now, by_agent: 'user', event: 'decided',
      detail: { action, next_status: nextStatus, source: 'email' },
    };

    // Gate the update on the proposal still awaiting a decision so a
    // re-clicked / stale link can't override an already-made decision.
    dbo.collection(MS_PROPOSALS_COLL).findOneAndUpdate(
      { _id: ObjectID(pid), status: { $in: Array.from(MS_ACT_STATUSES) } },
      { $set: { status: nextStatus, decision, updated_at: now },
        $push: { audit_events: auditEvent } },
      { returnDocument: 'before' },
      (err, result) => {
        if (err) {
          console.error('GET /madscientist/act:', err);
          res.status(500).send(msActPage({
            ok: false, heading: 'Server error',
            body: 'Something went wrong applying your decision. Try the dashboard.',
          }));
          return;
        }
        const matched = result && result.value;
        if (!matched) {
          // Either the proposal doesn't exist or it's no longer
          // awaiting a decision (already decided / in flight).
          dbo.collection(MS_PROPOSALS_COLL).findOne(
            { _id: ObjectID(pid) }, { projection: { status: 1, title: 1 } },
            (e2, cur) => {
              if (e2 || !cur) {
                res.status(404).send(msActPage({
                  ok: false, heading: 'Proposal not found',
                  body: 'This proposal no longer exists.',
                }));
                return;
              }
              res.status(409).send(msActPage({
                ok: false, heading: 'Already decided',
                body: `This proposal is already <b>${cur.status}</b>, so your ` +
                  `<b>${action}</b> click had no effect. Open the dashboard ` +
                  `to see its current state.`,
              }));
            });
          return;
        }
        const title = matched.title || '(untitled)';
        const verb = action === 'approve' ? 'approved'
          : action === 'reject' ? 'rejected' : 'deferred';
        res.send(msActPage({
          ok: true,
          heading: `Proposal ${verb}`,
          body: `<b>${String(title).replace(/[&<>]/g, '')}</b> is now ` +
            `<b>${nextStatus}</b>.` +
            (action === 'approve'
              ? ' The orchestrator will queue its training jobs shortly.'
              : ''),
        }));
      });
  });

  app.post('/madscientist/decide', (req, res) => {
    const body = req.body || {};
    labRoute(res, () => labDecide(dbo, labProposalId(body.proposal_id), String(body.action || '').trim(), String(body.note || ''), 'dashboard', false));
  });
  // One robot's models for pickers (the microduck job form), newest first;
  // /get_models carries every car model and is too heavy for that.
  app.get('/get_robot_models', async (req, res) => {
    try {
      const robot = String(req.query.robot || '');
      if (!robot || robot === 'roboracer') {
        res.status(400).json({ error: "robot is required (not roboracer)" });
        return;
      }
      const rows = await dbo.collection("models").find(
        { robot },
        { projection: { job_id: 1, location: 1, task_id: 1, training_iterations: 1, onnx_location: 1,
                        avg_return: 1, reward_design_name: 1, experiment_design_name: 1,
                      updated_at: 1, create_date: 1 } })
        .sort({ updated_at: -1 }).limit(200).toArray();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err && ((err as any).message || err)) });
    }
  });

  // Training videos and GIFs (rl_agent/media.py), stored on jobs as the
  // trainer's own paths: mjlab workers under /<robot>_rl/logs (saved_models/<subdir>
  // on the host), the car trainer under /saved_models. Registered robots from
  // /get_robots extend this list dynamically via mediaRoots.
  const DEFAULT_MEDIA_ROOTS: Array<[string, string]> = [
    ['/microduck_rl/logs/', '/saved_models/microduck'],
    ['/saved_models/', '/saved_models'],
  ];
  let robotCache: any[] = [];
  let mediaRoots: Array<[string, string]> = DEFAULT_MEDIA_ROOTS.slice();

  function updateMediaRoots(robots: any[]): void {
    const roots: Array<[string, string]> = [];
    for (const r of robots || []) {
      if (r && r.media_prefix && r.saved_models_subdir && r.media_prefix !== '/saved_models/') {
        roots.push([String(r.media_prefix), path.posix.join('/saved_models', String(r.saved_models_subdir))]);
      }
    }
    for (const pair of DEFAULT_MEDIA_ROOTS) {
      if (!roots.some(([p]) => p === pair[0])) roots.push(pair);
    }
    mediaRoots = roots;
  }

  async function refreshRobotCacheFromDb(): Promise<any[]> {
    if (!dbo) return robotCache;
    const rows = await dbo.collection("robots").find({}).toArray();
    if (rows && rows.length) {
      robotCache = rows;
      updateMediaRoots(rows);
    }
    return robotCache;
  }

  async function seedRobotsFromManifests(): Promise<void> {
    const res = await runDuckScript('/python_ws/src/robots_registry.py', {});
    const list = Array.isArray(res && res.robots) ? res.robots : [];
    if (!list.length) {
      await refreshRobotCacheFromDb();
      return;
    }
    const now = new Date();
    for (const r of list) {
      await dbo.collection("robots").updateOne(
        { _id: r.id } as any,
        { $set: { ...r, updated_at: now }, $setOnInsert: { created_at: now } },
        { upsert: true },
      );
    }
    robotCache = list;
    updateMediaRoots(list);
    robotsChanged = true;
  }

  app.get('/get_robots', async (_req, res) => {
    try {
      let rows = dbo ? await dbo.collection("robots").find({}).toArray() : [];
      if (!rows || !rows.length) {
        const reg = await runDuckScript('/python_ws/src/robots_registry.py', {});
        rows = Array.isArray(reg && reg.robots) ? reg.robots : [];
      }
      if (rows.length) {
        robotCache = rows;
        updateMediaRoots(rows);
      }
      res.json({ robots: rows });
    } catch (err) {
      res.status(500).json({ error: String(err && ((err as any).message || err)) });
    }
  });

  // One job by id, for tabs that don't hold the whole job list (the Models
  // tab's MicroDuck video button).
  app.get('/get_job/:id', async (req, res) => {
    let filter;
    try {
      filter = { _id: ObjectID(req.params.id) };
    } catch (e) {
      filter = { _id: String(req.params.id) };
    }
    try {
      const job = await dbo.collection("jobs").findOne(filter);
      if (!job) {
        res.status(404).json({ error: `no job ${req.params.id}` });
        return;
      }
      res.json(job);
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message || e) });
    }
  });

  // /duck_media is the old name, still in links shared before the car had videos.
  app.get(['/media', '/duck_media'], (req, res) => {
    const stored = String(req.query.path || '');
    const match = mediaRoots.find(([prefix]) => stored.startsWith(prefix));
    if (!match) {
      res.status(400).json({ error: `path must start with ${mediaRoots.map(([p]) => p).join(' or ')}` });
      return;
    }
    const [prefix, root] = match;
    const resolved = path.resolve(root, stored.slice(prefix.length));
    if (!resolved.startsWith(root + path.sep)) {
      res.status(400).json({ error: 'path escapes the training output folder' });
      return;
    }
    if (!['.mp4', '.gif'].includes(path.extname(resolved).toLowerCase())) {
      res.status(400).json({ error: 'only .mp4 and .gif files are served' });
      return;
    }
    res.sendFile(resolved, { maxAge: '1h' }, (err: any) => {
      if (err && !res.headersSent) res.status(err.status || 404).json({ error: 'not found' });
    });
  });

  app.get('/get_models', (req,res) => {
    if(needsUpdate(req, res, modelsChanged, 'models'))
    {
      modelsChanged=false;
      // Projection excludes ``reward_design_code`` from the list-view
      // payload. That field stores the verbatim Python source of the
      // model's training-time reward design - small per model (often
      // ~1 KB) but with thousands of historical model docs it
      // dominates the /get_models response size (multi-MB JSON parsed
      // on every dashboard load). The Models tab's "View source"
      // modal fetches the source on click via /get_model_source/:id
      // below, so no UX is lost - the source just isn't pre-loaded.
      //
      // observation_spec / action_spec are kept because the Compat
      // column on the Models tab reads them directly from each row
      // to compare against the live env spec; they're tiny (a few
      // tens of bytes each) so they're not a payload concern.
      dbo.collection("models")
         .find({}, { projection: { reward_design_code: 0 } })
         .toArray(function(err, result) {
        if (err) { console.error('get_models query failed:', err); modelsChanged = true; res.status(500).json({ error: String(err && (err.message || err)) }); return; }
        console.log(`${result.length} models retrieved`)
        res.json(result)
      });
      return;
    }
    console.log(`No models retrieved`);
    res.status(200).send('NO_CHANGES');
  });

  // Per-model source fetch. Returns just the ``reward_design_code``
  // field for one model so the Models tab's source-view modal can
  // populate on click without paying the cost of preloading every
  // model's source through /get_models. Tiny payload (one document,
  // one field) so no projection/index tuning needed.
  //
  // 404 if the id doesn't parse as an ObjectId or no such document
  // exists. 200 with {code: null} when the model exists but has no
  // reward design recorded (legacy / RandomPyPolicy / etc.).
  app.get('/get_model_source/:id', (req, res) => {
    const idStr = String(req.params.id || '');
    let oid;
    try {
      oid = ObjectID(idStr);
    } catch (_e) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    dbo.collection("models").findOne(
      { _id: oid },
      { projection: { reward_design_code: 1, reward_design_name: 1, reward_design_version: 1, reward_design_id: 1 } },
      function(err, doc) {
        if (err) {
          console.error('get_model_source failed:', err);
          res.status(500).json({ error: String(err.message || err) });
          return;
        }
        if (!doc) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        res.json({
          _id: idStr,
          reward_design_id: doc.reward_design_id || null,
          reward_design_name: doc.reward_design_name || null,
          reward_design_version: doc.reward_design_version || null,
          reward_design_code: doc.reward_design_code || null,
        });
      });
  });

  // env_specs: one document per robot_type, written by
  // publish_env_spec() in rl_agent/robotaxi.py whenever a TRAIN or
  // EVAL job starts. The Models tab fetches this alongside
  // /get_models and /leaderboard_scores so the "Compat" column can
  // compare each model's stored observation/action spec against the
  // live env's. Same NO_CHANGES short-circuit as the other read-only
  // endpoints to keep the dashboard polling cheap.
  app.get('/get_env_specs', (req,res) => {
    if(needsUpdate(req, res, envSpecsChanged, 'env_specs'))
    {
      envSpecsChanged=false;
      dbo.collection("env_specs").find({}).toArray(function(err, result) {
        if (err) { console.error('get_env_specs query failed:', err); envSpecsChanged = true; res.status(500).json({ error: String(err && (err.message || err)) }); return; }
        console.log(`${result.length} env_specs retrieved`)
        res.json(result)
      });
      return;
    }
    console.log(`No env_specs retrieved`);
    res.status(200).send('NO_CHANGES');
  });

  // ---- reward_designs CRUD ----------------------------------------
  //
  // User-authored reward function modules (see rl_agent/reward_designs.py
  // for the contract). The dashboard's Rewards tab (Raw Designs) and the
  // New-Job form's reward-design dropdown both consume these.
  //
  // /get_reward_designs       : list current designs (with NO_CHANGES short-
  //                             circuit, same as other read endpoints)
  // /add_reward_design        : insert a new design
  // /update_reward_design     : update an existing design (bumps version)
  // /archive_reward_design    : soft-delete (archived: true) so historical
  //                             models keep resolving their reward design
  // /lint_reward_design       : compile-check the code via the sim-controller
  //                             container without saving anything

  app.get('/get_reward_designs', (req, res) => {
    if (needsUpdate(req, res, rewardDesignsChanged, 'reward_designs')) {
      rewardDesignsChanged = false;
      dbo.collection("reward_designs").find({}).toArray(function(err, result) {
        if (err) { console.error('get_reward_designs query failed:', err); rewardDesignsChanged = true; res.status(500).json({ error: String(err && (err.message || err)) }); return; }
        console.log(`${result.length} reward_designs retrieved`);
        res.json(result);
      });
      return;
    }
    console.log(`No reward_designs retrieved`);
    res.status(200).send('NO_CHANGES');
  });

  app.post('/add_reward_design', (req, res) => {
    // Body shape: { name, description, code, author?, archived? (default false) }
    // We stamp created_at / updated_at / version=1 here so the client
    // never has to set them; subsequent edits go through
    // /update_reward_design which bumps version.
    const body = req.body || {};
    if (!body.name || !body.code) {
      res.status(400).json({ error: "name and code are required" });
      return;
    }
    const now = new Date();
    const doc: any = {
      name: String(body.name),
      description: String(body.description || ''),
      code: String(body.code),
      author: String(body.author || ''),
      archived: !!body.archived,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    // Car designs carry no robot field; duck designs (a top-level TERMS dict)
    // are stamped so the duck worker accepts them and car jobs can't pick them.
    const robot = body.robot || (/(^|\n)TERMS\s*=/.test(doc.code) ? 'microduck' : null);
    if (robot && robot !== 'roboracer') doc.robot = String(robot);
    dbo.collection("reward_designs").insertOne(doc, function(err, result) {
      if (err) {
        console.error('add_reward_design failed:', err);
        res.status(500).json({ error: String(err.message || err) });
        return;
      }
      console.log('reward_design inserted', result.insertedId);
      res.json(result);
    });
  });

  app.post('/update_reward_design', (req, res) => {
    // Body shape: { _id, name?, description?, code?, archived? }
    // Edits bump version and updated_at. The previous version's code
    // is NOT preserved here (that would require a separate
    // reward_design_versions collection); historical models record
    // their training-time code on the model document itself, so a
    // user's accidental edit doesn't break reproducibility of
    // already-trained models.
    const body = req.body || {};
    if (!body._id) {
      res.status(400).json({ error: "_id is required" });
      return;
    }
    let idFilter;
    try {
      idFilter = { "_id": ObjectID(body._id) };
    } catch (e) {
      // Could be the string id used by the canonical seed (see
      // rl_agent/reward_designs.PASSTHROUGH_DESIGN_ID); accept either
      // shape so the dashboard can edit a seeded design too.
      idFilter = { "_id": String(body._id) };
    }
    const update: any = { "$set": { updated_at: new Date() } };
    // Archiving or restoring isn't a new version of the reward.
    if (Object.keys(body).some((k) => k !== '_id' && k !== 'archived')) update["$inc"] = { version: 1 };
    if (body.name        !== undefined) update["$set"].name        = String(body.name);
    if (body.description !== undefined) update["$set"].description = String(body.description);
    if (body.code        !== undefined) update["$set"].code        = String(body.code);
    if (body.archived    !== undefined) update["$set"].archived    = !!body.archived;
    // Designs compiled from a spec change only through the spec.
    if (body.code !== undefined) (idFilter as any).spec_id = { $exists: false };
    dbo.collection("reward_designs").updateOne(
      idFilter, update, { upsert: false },
      function(err, result) {
        if (err) {
          console.error('update_reward_design failed:', err);
          res.status(500).json({ error: String(err.message || err) });
          return;
        }
        if (body.code !== undefined && result && result.matchedCount === 0) {
          res.status(409).json({ error: "no such design, or it is compiled from a reward spec: edit the spec on the Rewards tab (Specs)" });
          return;
        }
        console.log('reward_design updated', body._id, result);
        res.json(result);
      });
  });

  app.post('/archive_reward_design', (req, res) => {
    // Soft-delete. We do NOT physically remove the document because
    // historical model records reference reward_design_id; deleting
    // the design would orphan that reference. Archived designs are
    // hidden from the New-Job dropdown but still resolve when an
    // in-flight job looks them up.
    const body = req.body || {};
    if (!body._id) {
      res.status(400).json({ error: "_id is required" });
      return;
    }
    let idFilter;
    try {
      idFilter = { "_id": ObjectID(body._id) };
    } catch (e) {
      idFilter = { "_id": String(body._id) };
    }
    dbo.collection("reward_designs").updateOne(
      idFilter,
      { "$set": { archived: true, updated_at: new Date() } },
      { upsert: false },
      function(err, result) {
        if (err) {
          console.error('archive_reward_design failed:', err);
          res.status(500).json({ error: String(err.message || err) });
          return;
        }
        console.log('reward_design archived', body._id);
        res.json(result);
      });
  });

  // ---- curricula + curriculum runs (rl_agent/curriculum) ------------ *
  //
  // A curriculum is an ordered list of training stages for one robot. A run
  // chains them as jobs on the shared queue (one TRAIN job per stage, plus
  // an EVAL job for a gated stage); the curriculum-runner service owns run
  // state after it is created here. Validation and run construction go
  // through rl_agent/curriculum/cli.py so the rules live in one place.
  //
  // /get_curricula, /get_curriculum_runs   change-gated lists
  // /get_curriculum_capabilities          per-robot carry items, gate metrics
  // /validate_curriculum                  dry run: resolved stages or problems
  // /create_curriculum, /update_curriculum, /set_curriculum_archived
  // /start_curriculum_run, /cancel_curriculum_run, /retry_curriculum_run,
  // /skip_curriculum_run, /delete_curriculum_run
  const CURRICULUM_CLI = '/python_ws/src/curriculum/cli.py';
  function anyIdFilter(id: any): any {
    const s = String(id);
    return /^[0-9a-f]{24}$/i.test(s) ? { _id: { $in: [ObjectID(s), s] } } : { _id: s };
  }

  function curriculumProblem(res: any, out: any) {
    res.status(400).json({ error: out.error || 'invalid curriculum', problems: out.problems || [] });
  }

  // id -> row maps the validator checks stage references against.
  async function curriculumContext(robot: string): Promise<any> {
    const rows = async (coll: string, query: any, projection: any) => {
      const docs = await dbo.collection(coll).find(query, { projection }).toArray();
      const out: any = {};
      for (const d of docs) out[String(d._id)] = d;
      return out;
    };
    const mine = robot === 'roboracer' ? { robot: { $in: [null, 'roboracer'] } } : { robot };
    return {
      gyms: await rows('gyms', {}, { robot: 1, archived: 1, task_id: 1 }),
      reward_designs: await rows('reward_designs', {}, { robot: 1, archived: 1 }),
      experiment_designs: await rows('experiment_designs', {}, { robot: 1, archived: 1 }),
      models: await rows('models', mine, { robot: 1, location: 1 }),
    };
  }

  async function validateCurriculum(doc: any): Promise<any> {
    return runDuckScript(CURRICULUM_CLI, {
      op: 'validate', curriculum: doc, context: await curriculumContext(String(doc.robot || '')),
    });
  }

  const sendError = (res: any, where: string, e: any) => {
    console.error(`${where} failed:`, e);
    res.status(500).json({ error: String((e && e.message) || e) });
  };

  app.get('/get_curricula', (req, res) => {
    if (!needsUpdate(req, res, curriculaChanged, 'curricula')) { res.status(200).send('NO_CHANGES'); return; }
    curriculaChanged = false;
    dbo.collection('curricula').find({}).toArray()
      .then((rows: any[]) => res.json(rows))
      .catch((e: any) => { curriculaChanged = true; sendError(res, 'get_curricula', e); });
  });

  app.get('/get_curriculum_runs', (req, res) => {
    if (!needsUpdate(req, res, curriculumRunsChanged, 'curriculum_runs')) { res.status(200).send('NO_CHANGES'); return; }
    curriculumRunsChanged = false;
    dbo.collection('curriculum_runs').find({}).toArray()
      .then((rows: any[]) => res.json(rows))
      .catch((e: any) => { curriculumRunsChanged = true; sendError(res, 'get_curriculum_runs', e); });
  });

  app.get('/get_curriculum_capabilities', async (req, res) => {
    const out = await runDuckScript(CURRICULUM_CLI, { op: 'capabilities' });
    if (!out.ok) { res.status(500).json({ error: out.error }); return; }
    res.json(out);
  });

  app.post('/validate_curriculum', async (req, res) => {
    try {
      const out = await validateCurriculum(req.body || {});
      if (!out.ok) { curriculumProblem(res, out); return; }
      res.json(out);
    } catch (e) { sendError(res, 'validate_curriculum', e); }
  });

  app.post('/create_curriculum', async (req, res) => {
    // Body: { robot, name, description?, author?, stages: [...] }. Stored as
    // authored (stages that leave a field out inherit it) plus the resolved
    // stages for display; runs snapshot the resolved stages when they start.
    const body = req.body || {};
    try {
      const out = await validateCurriculum(body);
      if (!out.ok) { curriculumProblem(res, out); return; }
      const now = new Date();
      const doc: any = {
        robot: out.curriculum.robot,
        name: out.curriculum.name,
        description: out.curriculum.description,
        author: String(body.author || ''),
        stages: body.stages,
        resolved_stages: out.curriculum.stages,
        archived: false,
        version: 1,
        created_at: now,
        updated_at: now,
      };
      const result = await dbo.collection('curricula').insertOne(doc);
      res.json({ ...result, curriculum: { ...doc, _id: result.insertedId } });
    } catch (e) { sendError(res, 'create_curriculum', e); }
  });

  app.post('/update_curriculum', async (req, res) => {
    // Body: { _id, name?, description?, stages? }. Bumps version; runs already
    // started keep the stages they snapshotted.
    const body = req.body || {};
    if (!body._id) { res.status(400).json({ error: '_id is required' }); return; }
    try {
      const filter = anyIdFilter(body._id);
      const current = await dbo.collection('curricula').findOne(filter);
      if (!current) { res.status(404).json({ error: `curriculum ${body._id} not found` }); return; }
      const merged: any = {
        robot: current.robot,
        name: body.name !== undefined ? body.name : current.name,
        description: body.description !== undefined ? body.description : current.description,
        stages: body.stages !== undefined ? body.stages : current.stages,
      };
      const out = await validateCurriculum(merged);
      if (!out.ok) { curriculumProblem(res, out); return; }
      const result = await dbo.collection('curricula').updateOne(filter, {
        $set: {
          name: out.curriculum.name, description: out.curriculum.description,
          stages: merged.stages, resolved_stages: out.curriculum.stages, updated_at: new Date(),
        },
        $inc: { version: 1 },
      });
      res.json({ ...result, curriculum: await dbo.collection('curricula').findOne(filter) });
    } catch (e) { sendError(res, 'update_curriculum', e); }
  });

  app.post('/set_curriculum_archived', async (req, res) => {
    const body = req.body || {};
    if (!body._id) { res.status(400).json({ error: '_id is required' }); return; }
    try {
      const result = await dbo.collection('curricula').updateOne(
        anyIdFilter(body._id), { $set: { archived: body.archived !== false, updated_at: new Date() } });
      if (!result.matchedCount) { res.status(404).json({ error: `curriculum ${body._id} not found` }); return; }
      res.json(result);
    } catch (e) { sendError(res, 'set_curriculum_archived', e); }
  });

  app.post('/start_curriculum_run', async (req, res) => {
    // Body: { curriculum_id, start_stage? (id or index), priority? "front" | "normal" }.
    const body = req.body || {};
    if (!body.curriculum_id) { res.status(400).json({ error: 'curriculum_id is required' }); return; }
    try {
      const cur = await dbo.collection('curricula').findOne(anyIdFilter(body.curriculum_id));
      if (!cur) { res.status(404).json({ error: `curriculum ${body.curriculum_id} not found` }); return; }
      if (cur.archived) { res.status(409).json({ error: `curriculum "${cur.name}" is archived; unarchive it first` }); return; }
      const out = await runDuckScript(CURRICULUM_CLI, {
        op: 'new_run',
        curriculum: { ...cur, _id: String(cur._id) },
        context: await curriculumContext(String(cur.robot)),
        start_stage: body.start_stage,
        priority: body.priority,
      });
      if (!out.ok) { curriculumProblem(res, out); return; }
      const now = new Date();
      const run = { ...out.run, created_at: now, updated_at: now };
      const result = await dbo.collection('curriculum_runs').insertOne(run);
      res.json({ ...result, run: { ...run, _id: result.insertedId } });
    } catch (e) { sendError(res, 'start_curriculum_run', e); }
  });

  // Run transitions are shared with /api/v1/curriculum-runs/:id/actions (api/curricula.ts).
  // cancel: the runner finishes it; the pending job is cancelled at once.
  // retry: FAILED_GATE gets one more attempt from the last checkpoint; FAILED / CANCELLED rerun the attempt.
  // skip: a FAILED_GATE stage is waved through and the next stage starts from its checkpoint.
  // delete: { _id, delete_jobs? } keeps the stage jobs unless delete_jobs; cancel first.
  for (const action of RUN_ACTIONS) {
    app.post(`/${action}_curriculum_run`, async (req, res) => {
      const body = req.body || {};
      if (!body._id) { res.status(400).json({ error: '_id is required' }); return; }
      try {
        res.json(await applyRunAction(dbo, String(body._id), action, { deleteJobs: !!body.delete_jobs }));
      } catch (e) {
        if (e instanceof HttpError) res.status(e.status).json({ error: e.message });
        else sendError(res, `${action}_curriculum_run`, e);
      }
    });
  }

  // ---- design_specs: robot-agnostic reward specs -------------------- *
  //
  // A spec is Markdown prose (rl_agent/specs/spec.py) that Mad Scientist's
  // spec_compiler turns into each robot's reward code. Compiles land as
  // compile.<robot>.result with state "pending"; accepting one writes the code
  // into the spec text and publishes it as the reward design
  // "spec:<spec id>:<robot>", which jobs pick like any other. The published
  // design carries spec_status (fresh / edited / stale) and the workers refuse
  // stale ones, and edited ones in strict mode.
  const SPEC_CLI = '/python_ws/src/specs/cli.py';
  const SPEC_SETTINGS_ID = 'design_specs';

  function specIdFilter(id: any): any {
    try { return { _id: ObjectID(String(id)) }; } catch (e) { return { _id: String(id) }; }
  }

  async function specSettings(): Promise<{ strict_generated: boolean }> {
    const doc = await dbo.collection('settings').findOne({ _id: SPEC_SETTINGS_ID } as any);
    return { strict_generated: !!(doc && doc.strict_generated) };
  }

  function isMjlabRobot(robot: string): boolean {
    if (!robot || robot === 'roboracer') return false;
    const hit = robotCache.find((r) => r && r.id === robot);
    return hit ? hit.engine === 'mjlab_rsl_rl' : robot === 'microduck';
  }

  function specRobotsList(): string[] {
    const fromCache = robotCache
      .filter((r) => r && r.supports && r.supports.reward_specs)
      .map((r) => String(r.id));
    return fromCache.length ? fromCache : ['roboracer', 'microduck', 'openbeni'];
  }

  function specTaskId(robot: string, summary: any): string {
    if (robot === 'openbeni') return String(summary.openbeni_task || 'Beni-Velocity-Flat');
    if (robot === 'microduck') return String(summary.microduck_task || 'Mjlab-Velocity-Flat-MicroDuck');
    return String(summary.microduck_task || '');
  }

  async function lintSpecCode(robot: string, code: string, taskId: string): Promise<string[]> {
    let gym: any = null;
    let library: any[] = [];
    if (isMjlabRobot(robot)) {
      gym = await dbo.collection('gyms').findOne({ _id: `${robot}:${taskId}` } as any,
        { projection: { reward_defaults: 1 } });
      const catalog = await dbo.collection('reward_term_catalog').findOne({ _id: robot } as any);
      library = (catalog && catalog.functions) || [];
    }
    const r = await runDuckScript(SPEC_CLI, { op: 'lint', robot, code, gym, library });
    return r.ok ? r.problems : [r.error];
  }

  // Mirror a spec's compiled code into reward_designs, one design per robot.
  async function publishSpec(specId: any, summary: any): Promise<void> {
    const now = new Date();
    const designs = dbo.collection('reward_designs');
    const allRobots = Array.from(new Set([...specRobotsList(), ...Object.keys(summary.compiled || {})]));
    for (const robot of allRobots) {
      const _id = `spec:${String(specId)}:${robot}`;
      const compiled = summary.compiled[robot];
      if (!compiled || !summary.robots.includes(robot)) {
        await designs.updateOne({ _id } as any, { $set: { archived: true, updated_at: now } });
        continue;
      }
      const set: any = {
        name: summary.name,
        description: summary.description || String(summary.goal || '').split('\n\n')[0].replace(/\s+/g, ' ').trim(),
        code: compiled.code,
        author: 'reward spec',
        archived: false,
        spec_id: String(specId),
        spec_status: summary.statuses[robot],
        spec_inputs_sha: compiled.meta.inputs_sha || null,
        updated_at: now,
      };
      if (robot !== 'roboracer') set.robot = robot;
      const existing = await designs.findOne({ _id } as any, { projection: { code: 1 } });
      const update: any = { $set: set, $setOnInsert: { created_at: now } };
      if (!existing) update.$setOnInsert.version = 1;
      else if (existing.code !== compiled.code) update.$inc = { version: 1 };
      await designs.updateOne({ _id } as any, update, { upsert: true });
    }
    rewardDesignsChanged = true;
  }

  // Store new spec text (already checked) and republish.
  async function storeSpecText(filter: any, text: string, summary: any, extra: any = {}): Promise<void> {
    await dbo.collection('design_specs').updateOne(filter, {
      $set: {
        text, name: summary.name, robots: summary.robots, statuses: summary.statuses,
        updated_at: new Date(), ...extra,
      },
      $inc: { version: 1 },
    });
    await publishSpec(filter._id, summary);
  }

  function specRoute(handler: (req: any, res: any) => Promise<void>) {
    return (req: any, res: any) => {
      handler(req, res).catch((err: any) => {
        console.error(`${req.path} failed:`, err);
        res.status(500).json({ error: String(err && (err.message || err)) });
      });
    };
  }

  app.get('/get_design_specs', specRoute(async (req, res) => {
    const docs = await dbo.collection('design_specs').find({}).sort({ updated_at: -1 }).toArray();
    for (const d of docs) {
      const s = await runDuckScript(SPEC_CLI, { op: 'parse', text: d.text });
      d.summary = s.ok ? s : null;
      d.parse_error = s.ok ? null : s.error;
    }
    res.json({ specs: docs, settings: await specSettings() });
  }));

  app.get('/design_spec_template', specRoute(async (req, res) => {
    res.json(await runDuckScript(SPEC_CLI, { op: 'template' }));
  }));

  app.post('/save_design_spec', specRoute(async (req, res) => {
    const body = req.body || {};
    const text = String(body.text || '');
    const summary = await runDuckScript(SPEC_CLI, { op: 'parse', text });
    if (!summary.ok) { res.status(400).json({ error: summary.error }); return; }
    const specs = dbo.collection('design_specs');
    const old = body._id ? await specs.findOne(specIdFilter(body._id)) : null;
    if (body._id && !old) { res.status(404).json({ error: 'no such spec' }); return; }
    const edited = await runDuckScript(SPEC_CLI, { op: 'edited', old_text: old ? old.text : '', text });
    if (!edited.ok) { res.status(400).json({ error: edited.error }); return; }
    if (edited.robots.length) {
      if ((await specSettings()).strict_generated) {
        res.status(400).json({
          error: `strict mode: compiled code is generated only, but this save edits it for ${edited.robots.join(', ')}. ` +
                 'Change the prose and recompile, or turn strict mode off.' });
        return;
      }
      for (const robot of edited.robots) {
        const problems = await lintSpecCode(robot, summary.compiled[robot].code, specTaskId(robot, summary));
        if (problems.length) {
          res.status(400).json({ error: `hand-edited ${robot} code does not load: ${problems.join('; ')}` });
          return;
        }
      }
    }
    let filter: any;
    if (old) {
      filter = { _id: old._id };
    } else {
      const now = new Date();
      const ins = await specs.insertOne({ text, created_at: now, compile: {}, archived: false, version: 0 } as any);
      filter = { _id: ins.insertedId };
    }
    await storeSpecText(filter, text, summary);
    res.json({ ok: true, _id: filter._id, summary, hand_edited: edited.robots });
  }));

  app.post('/compile_design_spec', specRoute(async (req, res) => {
    const body = req.body || {};
    const doc = await dbo.collection('design_specs').findOne(specIdFilter(body._id));
    if (!doc) { res.status(404).json({ error: 'no such spec; save it first' }); return; }
    const summary = await runDuckScript(SPEC_CLI, { op: 'parse', text: doc.text });
    if (!summary.ok) { res.status(400).json({ error: summary.error }); return; }
    const robots: string[] = Array.isArray(body.robots) && body.robots.length ? body.robots : summary.robots;
    const set: any = {};
    for (const robot of robots) {
      if (!summary.robots.includes(robot)) { res.status(400).json({ error: `${robot} is not in this spec's robots` }); return; }
      const state = doc.compile && doc.compile[robot] && doc.compile[robot].state;
      if (state === 'queued' || state === 'running') { res.status(409).json({ error: `${robot} is already compiling` }); return; }
      set[`compile.${robot}`] = { state: 'queued', requested_at: new Date(), inputs_sha: summary.inputs_sha[robot] };
    }
    await dbo.collection('design_specs').updateOne({ _id: doc._id }, { $set: set });
    res.json({ ok: true, queued: robots });
  }));

  app.post('/accept_design_spec_compile', specRoute(async (req, res) => {
    const body = req.body || {};
    const robot = String(body.robot || '');
    const doc = await dbo.collection('design_specs').findOne(specIdFilter(body._id));
    const c = doc && doc.compile && doc.compile[robot];
    if (!c || c.state !== 'pending' || !c.result) { res.status(409).json({ error: `no compiled ${robot} code is waiting for review` }); return; }
    const summary = await runDuckScript(SPEC_CLI, { op: 'parse', text: doc.text });
    if (!summary.ok) { res.status(400).json({ error: summary.error }); return; }
    if (summary.inputs_sha[robot] !== c.result.inputs_sha) {
      res.status(409).json({ error: 'the spec changed after this compile started; compile again' });
      return;
    }
    const set = await runDuckScript(SPEC_CLI, { op: 'set_compiled', text: doc.text, robot, code: c.result.code, model: c.result.model });
    if (!set.ok) { res.status(400).json({ error: set.error }); return; }
    const after = await runDuckScript(SPEC_CLI, { op: 'parse', text: set.text });
    await storeSpecText({ _id: doc._id }, set.text, after, {
      [`compile.${robot}.state`]: 'accepted', [`compile.${robot}.accepted_at`]: new Date() });
    res.json({ ok: true, summary: after });
  }));

  app.post('/discard_design_spec_compile', specRoute(async (req, res) => {
    const body = req.body || {};
    const robot = String(body.robot || '');
    const r = await dbo.collection('design_specs').updateOne(
      { ...specIdFilter(body._id), [`compile.${robot}.state`]: { $in: ['pending', 'failed'] } },
      { $set: { [`compile.${robot}.state`]: 'discarded' } });
    if (!r.matchedCount) { res.status(409).json({ error: `nothing to discard for ${robot}` }); return; }
    res.json({ ok: true });
  }));

  // Keep a robot's current (usually hand-edited) code for the current prose.
  app.post('/repin_design_spec', specRoute(async (req, res) => {
    const body = req.body || {};
    const robot = String(body.robot || '');
    if ((await specSettings()).strict_generated) {
      res.status(400).json({ error: 'strict mode: stale code has to be recompiled' });
      return;
    }
    const doc = await dbo.collection('design_specs').findOne(specIdFilter(body._id));
    if (!doc) { res.status(404).json({ error: 'no such spec' }); return; }
    const pinned = await runDuckScript(SPEC_CLI, { op: 'repin', text: doc.text, robot });
    if (!pinned.ok) { res.status(400).json({ error: pinned.error }); return; }
    const summary = await runDuckScript(SPEC_CLI, { op: 'parse', text: pinned.text });
    const problems = await lintSpecCode(robot, summary.compiled[robot].code, specTaskId(robot, summary));
    if (problems.length) { res.status(400).json({ error: `${robot} code does not load: ${problems.join('; ')}` }); return; }
    await storeSpecText({ _id: doc._id }, pinned.text, summary);
    res.json({ ok: true, summary });
  }));

  app.post('/archive_design_spec', specRoute(async (req, res) => {
    const body = req.body || {};
    const filter = specIdFilter(body._id);
    await dbo.collection('design_specs').updateOne(filter, { $set: { archived: body.archived !== false, updated_at: new Date() } });
    if (body.archived !== false) {
      await dbo.collection('reward_designs').updateMany({ spec_id: String(filter._id) }, { $set: { archived: true } });
      rewardDesignsChanged = true;
    } else {
      const doc = await dbo.collection('design_specs').findOne(filter);
      const summary = doc && await runDuckScript(SPEC_CLI, { op: 'parse', text: doc.text });
      if (summary && summary.ok) await publishSpec(filter._id, summary);
    }
    res.json({ ok: true });
  }));

  app.post('/design_spec_settings', specRoute(async (req, res) => {
    const strict = !!(req.body || {}).strict_generated;
    await dbo.collection('settings').updateOne({ _id: SPEC_SETTINGS_ID } as any,
      { $set: { strict_generated: strict, updated_at: new Date() } }, { upsert: true });
    res.json({ ok: true, settings: { strict_generated: strict } });
  }));

  // ---- experiment_designs CRUD + schema -------------------------- *
  //
  // The structured-config sibling of reward_designs. Each document is
  // a named bundle of training-loop hyperparameters (SAC learning
  // rates, BC pretrain steps, replay capacity, network sizes, ...).
  // Selected per-job via the New-Job form's "Experiment design"
  // dropdown alongside the existing Reward design dropdown. The
  // trainer (rl_agent/robotaxi.py::do_job) overlays the doc's fields
  // onto main()'s kwargs via experiment_designs.apply_to_main_kwargs.
  //
  // Endpoint set parallels /get_reward_designs etc. + adds a schema
  // discovery endpoint at /get_experiment_design_schema so the
  // dashboard form (and the future research-planning agent) can
  // introspect what fields exist without reading trainer source.
  //
  // FALLBACK ONLY - not the source of truth, and not something to keep
  // in sync by hand.
  //
  // The trainer publishes the real field list into
  // schema_registry/experiment_design on every start
  // (robotaxi.py::_publish_experiment_design_schema), and
  // withExperimentDesignSchema below prefers it. This constant is what
  // the dashboard serves when that document is missing - a fresh
  // database, or a trainer that has not booted since the collection was
  // created. The endpoint reports which one it used as `source`.
  //
  // It is allowed to go stale; that is the point of the fallback. If you
  // find yourself wanting to edit it, regenerate instead (the generator
  // is in docs/experiment-designs-tab-plan.md Step 1) - this block began
  // life as a hand-maintained mirror, drifted to 24 of 39 fields, and
  // silently dropped every AWAC, curriculum and track-geometry value
  // posted to /add_experiment_design. Part 2 of that doc is why it is
  // now only a fallback.
  const EXPERIMENT_DESIGN_SCHEMA: any[] = [
    { kind: 'section', label: 'Reinforcement learning loop' },
    { kind: 'field', name: 'num_iterations',               type: 'int',    default: 50000,  min: 1,      max: 10000000,  doc: 'Total SAC training iterations after BC pretrain. Each iter = one collect step + one gradient update.', paper_ref: null, kwarg: 'num_iterations_val' },
    { kind: 'field', name: 'env_discount',                 type: 'float',  default: 0.9,    min: 0.0,    max: 1.0,       doc: 'Per-step discount the env returns on non-terminal transitions; compounds with gamma (effective discount = gamma * env_discount). Legacy default 0.90 yields a short ~9-step horizon at gamma=0.99; set 1.0 to let gamma alone govern the horizon (better for speed / lap objectives).', paper_ref: null, kwarg: 'env_discount_val' },
    { kind: 'field', name: 'initial_collect_steps',        type: 'int',    default: 500,    min: 0,      max: 100000,    doc: 'Pre-RL random-policy collection steps to seed the replay buffer with diverse experience.', paper_ref: null, kwarg: 'initial_collect_steps_val' },
    { kind: 'field', name: 'collect_steps_per_iteration',  type: 'int',    default: 1,      min: 1,      max: 100,       doc: 'Env steps collected per training iteration (between gradient updates).', paper_ref: null, kwarg: 'collect_steps_per_iteration_val' },
    { kind: 'field', name: 'eval_interval',                type: 'int',    default: 5000,   min: 1,      max: 100000,    doc: 'How often (in train_steps) to pause training and run an in-loop eval cycle.', paper_ref: null, kwarg: 'eval_interval_val' },
    { kind: 'field', name: 'num_eval_episodes',            type: 'int',    default: 10,     min: 1,      max: 500,       doc: 'Eval episodes per in-loop eval cycle.', paper_ref: null, kwarg: 'num_eval_episodes_val' },
    { kind: 'field', name: 'eval_time_fraction',           type: 'float',  default: 0.25,   min: 0.0,    max: 1.0,       doc: 'Target fraction of training wall-clock spent in eval. When in (0,1), the loop uses a time-budgeted eval cadence (train ~(1-frac)/frac x each eval\'s wall-clock between evals) and eval_interval only bootstraps the first eval. Set 0.0 or 1.0 to disable budgeting and fall back to the step%eval_interval gate. Overridden at runtime by the EVAL_TIME_FRACTION env var.', paper_ref: null, kwarg: 'eval_time_fraction_val' },
    { kind: 'field', name: 'eval_train_interval_sec',      type: 'int',    default: 0,      min: 0,      max: 86400,     doc: 'Fixed TRAINING wall-clock seconds between evals. When > 0 it takes precedence over eval_time_fraction: an eval fires after every N seconds of training time, a constant \'eval every N minutes\' cadence independent of eval duration (unlike the time-fraction budget, whose train gap scales with eval length). 0 disables (use eval_time_fraction / eval_interval). Overridden at runtime by the EVAL_TRAIN_INTERVAL_SEC env var.', paper_ref: null, kwarg: 'eval_train_interval_sec_val' },
    { kind: 'field', name: 'log_interval',                 type: 'int',    default: 5000,   min: 100,    max: 100000,    doc: 'TensorBoard scalar write cadence (in train_steps).', paper_ref: null, kwarg: 'log_interval_val' },
    { kind: 'field', name: 'policy_save_interval',         type: 'int',    default: 50,     min: 1,      max: 10000,     doc: 'How often (in train_steps) the PolicySavedModelTrigger writes a checkpoint.', paper_ref: null, kwarg: 'policy_save_interval_val' },
    { kind: 'section', label: 'Behavior cloning pretrain' },
    { kind: 'field', name: 'bc_pretrain_steps',            type: 'int',    default: 5000,   min: 0,      max: 1000000,   doc: 'BC gradient steps run on the actor before SAC starts. Set 0 to skip and run pure SAC.', paper_ref: null, kwarg: 'bc_pretrain_steps_val' },
    { kind: 'field', name: 'critic_warmup_steps',          type: 'int',    default: 0,      min: 0,      max: 1000000,   doc: 'Critic-only SAC updates (actor frozen) on the expert demo transitions before SAC starts, interleaved step for step with the BC pretrain, so the critic values the BC policy instead of steering it with random Q-values when SAC begins. 0 = off. Skipped on resume.', paper_ref: null, kwarg: 'critic_warmup_steps_val' },
    { kind: 'section', label: 'Replay buffer' },
    { kind: 'field', name: 'replay_buffer_capacity',       type: 'int',    default: 75000,  min: 1000,   max: 10000000,  doc: 'Max samples held in the online Reverb table (RL collection). Over capacity, FIFO eviction.', paper_ref: null, kwarg: 'replay_buffer_capacity_val' },
    { kind: 'field', name: 'batch_size',                   type: 'int',    default: 256,    min: 1,      max: 16384,     doc: 'SAC gradient-update batch size, also used by the BC pretrain phase.', paper_ref: null, kwarg: 'batch_size_val' },
    { kind: 'field', name: 'demo_prefill_count',           type: 'int',    default: 50000,  min: 0,      max: 10000000,  doc: 'Expert-demonstration steps to prefill the buffer with at job start. 0 = no demo prefill (pure SAC from random init).', paper_ref: '1707.08817', kwarg: 'demo_prefill_count_val' },
    { kind: 'field', name: 'demo_min_keep',                type: 'int',    default: 0,      min: 0,      max: 10000000,  doc: 'Demo samples PROTECTED from FIFO eviction. 0 = single-table mode (demos pre-fill the online buffer and get FIFO-displaced by RL data over time, current default). >0 = two-table mode where this many demo samples live in a separate Reverb table that never gets new writes, so they stay forever.', paper_ref: '1704.03732', kwarg: 'demo_min_keep_val' },
    { kind: 'field', name: 'demo_sample_ratio',            type: 'float',  default: 0.0,    min: 0.0,    max: 1.0,       doc: 'Two-table mode only (demo_min_keep > 0): fraction of each training batch drawn from the demo table vs the online table. 0.0 = pure online sampling (demos kept but never sampled - acts like demo_min_keep=0). 1.0 = pure demo sampling (online experience kept but never sampled, mostly useful for ablations). Typical 0.1-0.3 for DDPGfD-style demo over-sampling.', paper_ref: '1707.08817', kwarg: 'demo_sample_ratio_val' },
    { kind: 'section', label: 'SAC optimizer' },
    { kind: 'field', name: 'actor_learning_rate',          type: 'float',  default: 3e-05,  min: 1e-07,  max: 1.0,       doc: 'Adam learning rate for the actor network.', paper_ref: null, kwarg: 'actor_learning_rate_val' },
    { kind: 'field', name: 'critic_learning_rate',         type: 'float',  default: 3e-05,  min: 1e-07,  max: 1.0,       doc: 'Adam learning rate for the critic (twin Q-network).', paper_ref: null, kwarg: 'critic_learning_rate_val' },
    { kind: 'field', name: 'alpha_learning_rate',          type: 'float',  default: 3e-05,  min: 1e-07,  max: 1.0,       doc: 'Adam learning rate for the temperature parameter (entropy coefficient).', paper_ref: null, kwarg: 'alpha_learning_rate_val' },
    { kind: 'field', name: 'initial_alpha',                type: 'float',  default: 1.0,    min: 1e-06,  max: 100.0,     doc: 'Starting SAC entropy coefficient alpha (tf-agents initial_log_alpha = ln(initial_alpha)). Lower = less random exploration at the start; alpha is still auto-tuned afterwards.', paper_ref: null, kwarg: 'initial_alpha_val' },
    { kind: 'field', name: 'target_update_tau',            type: 'float',  default: 0.005,  min: 0.0,    max: 1.0,       doc: 'Polyak averaging factor for the target critic. Typical SAC value 0.005.', paper_ref: null, kwarg: 'target_update_tau_val' },
    { kind: 'field', name: 'target_update_period',         type: 'int',    default: 1,      min: 1,      max: 10000,     doc: 'Update the target critic every N train_steps (Polyak averaging cadence).', paper_ref: null, kwarg: 'target_update_period_val' },
    { kind: 'field', name: 'gamma',                        type: 'float',  default: 0.99,   min: 0.0,    max: 1.0,       doc: 'Discount factor for future rewards in the Bellman target.', paper_ref: null, kwarg: 'gamma_val' },
    { kind: 'field', name: 'awac_lambda',                  type: 'float',  default: 0.0,    min: 0.0,    max: 10.0,      doc: 'AWAC advantage-weighted BC regularization weight on the SAC actor loss. 0 = off (plain SAC). >0 adds, each step, an advantage-weighted imitation term sampled from the protected demo table so the demos shape the policy directly (not just the critic) - inherits expert survival without the BC-pretrain degradation. Requires demo_min_keep > 0.', paper_ref: 'AWAC (Nair et al. 2020)', kwarg: 'awac_lambda_val' },
    { kind: 'field', name: 'awac_beta',                    type: 'float',  default: 1.0,    min: 0.01,   max: 100.0,     doc: 'AWAC advantage temperature in exp(A/beta). Lower = sharper preference for expert actions the critic rates above the current policy. Only used when awac_lambda > 0.', paper_ref: null, kwarg: 'awac_beta_val' },
    { kind: 'field', name: 'awac_weight_clip',             type: 'float',  default: 20.0,   min: 1.0,    max: 1000.0,    doc: 'Upper clip on the AWAC weight exp(A/beta) for numerical stability. Only used when awac_lambda > 0.', paper_ref: null, kwarg: 'awac_weight_clip_val' },
    { kind: 'field', name: 'awac_lambda_decay_steps',      type: 'int',    default: 0,      min: 0,      max: 10000000,  doc: 'If > 0, linearly decay awac_lambda to 0 over this many train steps (strong demo-imitation early for survival, then let RL refine speed). 0 = constant awac_lambda. Only used when awac_lambda > 0.', paper_ref: null, kwarg: 'awac_lambda_decay_steps_val' },
    { kind: 'field', name: 'reward_scale_factor',          type: 'float',  default: 1.0,    min: 0.0,    max: 1000.0,    doc: 'Multiplier applied to environment rewards before they enter the Q-target. SAC is sensitive to this.', paper_ref: null, kwarg: 'reward_scale_factor_val' },
    { kind: 'section', label: 'Network architecture' },
    { kind: 'field', name: 'actor_fc_layers_x',            type: 'int',    default: 512,    min: 1,      max: 8192,      doc: 'First-layer width of the actor MLP.', paper_ref: null, kwarg: 'actor_fc_layer_params_x' },
    { kind: 'field', name: 'actor_fc_layers_y',            type: 'int',    default: 512,    min: 1,      max: 8192,      doc: 'Second-layer width of the actor MLP.', paper_ref: null, kwarg: 'actor_fc_layer_params_y' },
    { kind: 'field', name: 'critic_fc_layers_x',           type: 'int',    default: 512,    min: 1,      max: 8192,      doc: 'First-layer width of the critic joint MLP (after obs+action concatenation).', paper_ref: null, kwarg: 'critic_joint_fc_layer_params_x' },
    { kind: 'field', name: 'critic_fc_layers_y',           type: 'int',    default: 512,    min: 1,      max: 8192,      doc: 'Second-layer width of the critic joint MLP.', paper_ref: null, kwarg: 'critic_joint_fc_layer_params_y' },
    { kind: 'section', label: 'Track / environment (curriculum)' },
    { kind: 'field', name: 'curriculum_stages',            type: 'json',   default: null,   min: null,   max: null,      doc: '[Curriculum] Optional list of track-difficulty stages the trainer advances through automatically based on policy performance. Each entry is a dict with keys: corner_radius (float), curvature_difficulty (float, DEPRECATED - logging/back-compat only, default 0.0), chicanes_north/chicanes_east/chicanes_south/chicanes_west (int, absolute chicane count on each track edge for this stage, default 0 - these are what actually drive chicane placement as of 2026-07-18), advance_goals (float, goals/ep threshold to advance), and consecutive (int, number of consecutive eval cycles above the threshold before advancing). The last stage has no advance_goals (terminal). None = fixed track (current behaviour, fully back-compat). Example: [{"corner_radius": 14, "advance_goals": 20, "consecutive": 3}, {"corner_radius": 10, "chicanes_south": 1, "advance_goals": 40, "consecutive": 3}, {"corner_radius": 7.5, "chicanes_north": 1, "chicanes_east": 1, "chicanes_south": 2, "chicanes_west": 1}]', paper_ref: null, kwarg: 'curriculum_stages_val' },
    { kind: 'field', name: 'curriculum_start_stage',       type: 'int',    default: 0,      min: 0,      max: 63,        doc: '[Curriculum] 0-based index of the stage the curriculum STARTS on (default 0 = normal bottom-up curriculum). Set to len(curriculum_stages)-1 to start (and stay) on the final/hardest geometry - e.g. to fine-tune a warm-started policy directly on the terminal stage without re-climbing the ladder (the terminal stage has no advance_goals, so the scheduler never advances past it). Clamped into [0, n_stages-1]; ignored when curriculum_stages is unset.', paper_ref: null, kwarg: 'curriculum_start_stage_val' },
    { kind: 'field', name: 'corner_radius',                type: 'float',  default: 10.0,   min: 2.0,    max: 20.0,      doc: '[Curriculum / track geometry] Centreline turn radius (m) of the procedurally-generated track corners. Smaller = tighter, harder turns; larger = gentler. This is the primary curriculum lever: schedule a sequence of arms/jobs with DECREASING corner_radius to progressively harden the track. Applied live in the simulator: the trainer forwards it on every episode reset and Unity\'s TrackGenerator rebuilds the track at this radius.', paper_ref: null, kwarg: 'corner_radius_val' },
    { kind: 'field', name: 'curvature_difficulty',         type: 'float',  default: 0.0,    min: 0.0,    max: 1.0,       doc: 'DEPRECATED (2026-07-18) - no longer drives chicane count, kept for logging/back-compat only. Use chicanes_north/chicanes_east/chicanes_south/chicanes_west instead, which set an absolute chicane count per edge instead of a single 0..1 density applied to one edge.', paper_ref: null, kwarg: 'curvature_difficulty_val' },
    { kind: 'field', name: 'chicanes_north',               type: 'int',    default: 0,      min: 0,      max: 5,         doc: '[Curriculum / track geometry] Number of chicane bumps on the NORTH edge (top edge) of the procedurally-generated track, for a FIXED (non-curriculum) job. Curriculum jobs set this per-stage via curriculum_stages instead. Applied live: forwarded on every episode reset and used by Unity\'s TrackGenerator to rebuild the track.', paper_ref: null, kwarg: 'chicanes_north_val' },
    { kind: 'field', name: 'chicanes_east',                type: 'int',    default: 0,      min: 0,      max: 5,         doc: '[Curriculum / track geometry] Number of chicane bumps on the EAST edge (right edge) of the procedurally-generated track, for a FIXED (non-curriculum) job. Curriculum jobs set this per-stage via curriculum_stages instead.', paper_ref: null, kwarg: 'chicanes_east_val' },
    { kind: 'field', name: 'chicanes_south',               type: 'int',    default: 0,      min: 0,      max: 5,         doc: '[Curriculum / track geometry] Number of chicane bumps on the SOUTH edge (bottom edge) of the procedurally-generated track, for a FIXED (non-curriculum) job. Curriculum jobs set this per-stage via curriculum_stages instead.', paper_ref: null, kwarg: 'chicanes_south_val' },
    { kind: 'field', name: 'chicanes_west',                type: 'int',    default: 0,      min: 0,      max: 5,         doc: '[Curriculum / track geometry] Number of chicane bumps on the WEST edge (left edge) of the procedurally-generated track, for a FIXED (non-curriculum) job. Curriculum jobs set this per-stage via curriculum_stages instead.', paper_ref: null, kwarg: 'chicanes_west_val' },
  ];

  // Resolve the experiment-design field list, preferring the copy the
  // trainer publishes into schema_registry on every start (see
  // robotaxi.py::_publish_experiment_design_schema) and falling back to
  // the constant above.
  //
  // EVERY consumer must go through here - the GET endpoint, the
  // unknown-key validator, and both write copy loops. If the endpoint
  // served the trainer's list while the validator kept using the
  // constant, a field the trainer had just added would be rendered by
  // the form, posted back by the user, and then rejected as an unknown
  // key by the same server that advertised it.
  //
  // Other robots publish their own list (the duck worker writes
  // schema_registry/experiment_design:microduck, see
  // rl_agent/duck/experiment_design.py) and have no fallback: with nothing
  // published the list is empty and every field is rejected as unknown.
  function withExperimentDesignSchema(
    cb: (fields: any[], source: string) => void,
    robot: string = 'roboracer',
  ): void {
    const car = robot === 'roboracer';
    dbo.collection('schema_registry').findOne(
      { _id: car ? 'experiment_design' : `experiment_design:${robot}` } as any,
      (err: any, doc: any) => {
        if (err) {
          console.error('schema_registry read failed; using built-in fallback:', err);
        } else if (doc && Array.isArray(doc.fields) && doc.fields.length) {
          cb(doc.fields, 'trainer');
          return;
        }
        cb(car ? EXPERIMENT_DESIGN_SCHEMA : [], car ? 'fallback' : 'missing');
      });
  }

  app.get('/get_experiment_design_schema', (req, res) => {
    // Self-describing schema for the experiment_designs collection.
    // Returns the field list in form-render order. Consumers (the
    // New-Job form, the Experiment Design tab UI, the research-planning
    // agent) use this to build inputs / validate submissions without
    // reading trainer source.
    //
    // `source` tells you where the list came from: 'trainer' means the
    // running trainer published it, 'fallback' means this build's
    // built-in copy, which may be older than the trainer. Surfacing it
    // here is what turns a silent drift back into a visible one.
    const robot = String(req.query.robot || 'roboracer');
    withExperimentDesignSchema((fields, source) => {
      res.json({ fields, source, robot });
    }, robot);
  });

  app.get('/get_experiment_designs', (req, res) => {
    if (needsUpdate(req, res, experimentDesignsChanged, 'experiment_designs')) {
      experimentDesignsChanged = false;
      dbo.collection("experiment_designs").find({}).toArray(function(err, result) {
        if (err) { console.error('get_experiment_designs query failed:', err); experimentDesignsChanged = true; res.status(500).json({ error: String(err && (err.message || err)) }); return; }
        console.log(`${result.length} experiment_designs retrieved`);
        res.json(result);
      });
      return;
    }
    console.log(`No experiment_designs retrieved`);
    res.status(200).send('NO_CHANGES');
  });

  // Keys the write endpoints accept that are not schema fields.
  //
  // version / created_at / updated_at are server-managed: they're
  // accepted and ignored so a read-modify-write caller (GET a design,
  // tweak it, POST it back) isn't rejected for echoing them.
  const EXPERIMENT_DESIGN_META_KEYS = new Set([
    '_id', 'name', 'description', 'author', 'archived', 'fields',
    'version', 'created_at', 'updated_at', 'robot',
  ]);

  // Body keys that are neither metadata nor a known field. The copy
  // loops below only pick up names they recognise, so without this
  // check an unrecognised key is dropped and the caller still gets a
  // success - which is the bug that motivated
  // docs/experiment-designs-tab-plan.md. Returning them lets a typo or
  // a dashboard/trainer schema mismatch surface as an error instead of
  // as an experiment whose results quietly mean something else.
  function unknownExperimentDesignKeys(body: any, schemaFields: any[]): string[] {
    const known = new Set<string>();
    for (const entry of schemaFields) {
      if (entry.kind === 'field') known.add(entry.name);
    }
    const nested = body.fields && typeof body.fields === 'object';
    const bad: string[] = [];
    for (const k of Object.keys(body)) {
      if (EXPERIMENT_DESIGN_META_KEYS.has(k)) continue;
      // In the flat shape top-level keys double as field overrides; in
      // the nested shape they don't, so an unknown one is still wrong.
      if (!nested && known.has(k)) continue;
      bad.push(k);
    }
    if (nested) {
      for (const k of Object.keys(body.fields)) {
        if (!known.has(k)) bad.push('fields.' + k);
      }
    }
    return bad;
  }

  function rejectUnknownKeys(body: any, res: any, schemaFields: any[]): boolean {
    const unknown = unknownExperimentDesignKeys(body, schemaFields);
    if (!unknown.length) return false;
    res.status(400).json({
      error: 'unknown experiment-design field(s): ' + unknown.join(', '),
      unknown_keys: unknown,
      hint: 'Not in the experiment-design schema, so they would have been '
          + 'silently dropped. Check for a typo, or for a dashboard build '
          + 'older than the trainer. GET /get_experiment_design_schema '
          + 'lists every field this build accepts.',
    });
    return true;
  }

  app.post('/add_experiment_design', (req, res) => {
    // Body shape: { name, description, ...field_overrides, author?, archived? }
    // Field overrides are spread directly onto the doc so any key
    // present in the schema becomes a top-level field on the
    // experiment_designs document. We do NOT validate field types
    // here - the trainer's apply_to_main_kwargs() does soft
    // coercion + clamping with logging, which is the right place
    // for that since it has access to the SCHEMA min/max.
    const body = req.body || {};
    if (!body.name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    // Validate and copy against the SAME field list the GET endpoint
    // serves, so the form can never offer a field this handler would
    // reject or drop.
    const robot = String(body.robot || 'roboracer');
    withExperimentDesignSchema((schemaFields) => {
      if (rejectUnknownKeys(body, res, schemaFields)) return;
      const now = new Date();
      const doc: any = {
        name: String(body.name),
        description: String(body.description || ''),
        author: String(body.author || ''),
        archived: !!body.archived,
        version: 1,
        created_at: now,
        updated_at: now,
      };
      if (robot !== 'roboracer') doc.robot = robot;
      // Allow callers to omit the field-override block entirely (= all
      // nulls = trainer defaults), or pass them as a flat top-level
      // spread. We accept both shapes for ergonomics.
      const fieldOverrides = body.fields && typeof body.fields === 'object'
        ? body.fields
        : body;
      for (const entry of schemaFields) {
        if (entry.kind !== 'field') continue;
        const name = entry.name;
        if (fieldOverrides[name] !== undefined) doc[name] = fieldOverrides[name];
      }
      checkExperimentDesign(robot, doc).then((check) => {
        if (!check.ok) { res.status(400).json({ error: check.error }); return; }
        dbo.collection("experiment_designs").insertOne(doc, function(err, result) {
          if (err) {
            console.error('add_experiment_design failed:', err);
            res.status(500).json({ error: String(err.message || err) });
            return;
          }
          console.log('experiment_design inserted', result.insertedId);
          res.json(result);
        });
      });
    }, robot);
  });

  // Car designs are clamped by the trainer at job start; duck designs are
  // checked here with the same rl_agent/duck/experiment_design.validate the
  // worker runs, so a bad value fails on Save instead of minutes into a job.
  function checkExperimentDesign(robot: string, doc: any): Promise<any> {
    if (!isMjlabRobot(robot)) return Promise.resolve({ ok: true });
    const dir = robot === 'microduck' ? 'duck' : robot;
    return runDuckScript(`/python_ws/src/${dir}/check_experiment_design.py`, doc);
  }

  app.post('/update_experiment_design', (req, res) => {
    // Body shape: { _id, name?, description?, archived?, ...field_overrides }
    // Edits bump version + updated_at. Same accept-either-shape on
    // field overrides as /add_experiment_design.
    const body = req.body || {};
    if (!body._id) {
      res.status(400).json({ error: "_id is required" });
      return;
    }
    let idFilter: any;
    try {
      idFilter = { "_id": ObjectID(body._id) };
    } catch (e) {
      idFilter = { "_id": String(body._id) };  // canonical "Default" uses string _id
    }
    // Same resolved field list as the GET endpoint - see the comment
    // on withExperimentDesignSchema - for the robot the design belongs to.
    dbo.collection("experiment_designs").findOne(idFilter, (findErr: any, existing: any) => {
    if (findErr) { res.status(500).json({ error: String(findErr.message || findErr) }); return; }
    if (!existing) { res.status(404).json({ error: `experiment design ${body._id} not found` }); return; }
    withExperimentDesignSchema((schemaFields) => {
      if (rejectUnknownKeys(body, res, schemaFields)) return;
      const update: any = { "$set": { updated_at: new Date() } };
      // Archiving or restoring isn't a new version of the design.
      if (Object.keys(body).some((k) => k !== '_id' && k !== 'archived')) update["$inc"] = { version: 1 };
      if (body.name        !== undefined) update["$set"].name        = String(body.name);
      if (body.description !== undefined) update["$set"].description = String(body.description);
      if (body.archived    !== undefined) update["$set"].archived    = !!body.archived;
      const fieldOverrides = body.fields && typeof body.fields === 'object'
        ? body.fields
        : body;
      for (const entry of schemaFields) {
        if (entry.kind !== 'field') continue;
        const name = entry.name;
        if (fieldOverrides[name] !== undefined) update["$set"][name] = fieldOverrides[name];
      }
      const robot = existing.robot || 'roboracer';
      checkExperimentDesign(robot, { ...existing, ...update["$set"] }).then((check) => {
        if (!check.ok) { res.status(400).json({ error: check.error }); return; }
        dbo.collection("experiment_designs").updateOne(
          idFilter, update, { upsert: false },
          function(err, result) {
            if (err) {
              console.error('update_experiment_design failed:', err);
              res.status(500).json({ error: String(err.message || err) });
              return;
            }
            console.log('experiment_design updated', body._id, result);
            res.json(result);
          });
      });
    }, existing.robot || 'roboracer');
    });
  });

  app.post('/archive_experiment_design', (req, res) => {
    // Soft-delete. Same rationale as /archive_reward_design: archived
    // designs stay in the collection for backward-compat with model
    // documents that reference them; they just don't appear in the
    // New-job dropdown by default.
    const body = req.body || {};
    if (!body._id) {
      res.status(400).json({ error: "_id is required" });
      return;
    }
    let idFilter;
    try {
      idFilter = { "_id": ObjectID(body._id) };
    } catch (e) {
      idFilter = { "_id": String(body._id) };
    }
    dbo.collection("experiment_designs").updateOne(
      idFilter,
      { "$set": { archived: true, updated_at: new Date() } },
      { upsert: false },
      function(err, result) {
        if (err) {
          console.error('archive_experiment_design failed:', err);
          res.status(500).json({ error: String(err.message || err) });
          return;
        }
        console.log('experiment_design archived', body._id);
        res.json(result);
      });
  });

  // ---------------------------------------------------------------- *
  // Gyms CRUD
  //
  // A "gym" is a registered Unity scene / environment configuration:
  //   name      : human-friendly label shown in job dropdowns
  //   file_path : absolute path to the scene/config file on the host
  //   description: optional notes
  //
  // /get_gyms      : list all (non-archived) gyms
  // /add_gym       : register a new gym
  // /update_gym    : rename / change path / description
  // /archive_gym   : soft-delete
  // ---------------------------------------------------------------- *

  app.get('/get_gyms', (req, res) => {
    if (needsUpdate(req, res, gymsChanged, 'gyms')) {
      gymsChanged = false;
      dbo.collection("gyms").find({}).toArray(function(err, result) {
        if (err) { console.error('get_gyms query failed:', err); gymsChanged = true; res.status(500).json({ error: String(err && (err.message || err)) }); return; }
        console.log(`${result.length} gyms retrieved`);
        res.json(result);
      });
      return;
    }
    console.log('No gyms retrieved');
    res.status(200).send('NO_CHANGES');
  });

  // Strip a single pair of surrounding quotes from a pasted path.
  // Windows Explorer's "Copy as path" wraps the value in double quotes;
  // storing those breaks Test-Path / robocopy on the supervisor side.
  function stripQuotes(s: string): string {
    const t = String(s == null ? '' : s).trim();
    if (t.length >= 2 && t[0] === t[t.length - 1] && (t[0] === '"' || t[0] === "'")) {
      return t.slice(1, -1).trim();
    }
    return t;
  }

  app.post('/add_gym', (req, res) => {
    const body = req.body || {};
    if (!body.name || !body.file_path) {
      res.status(400).json({ error: "name and file_path are required" });
      return;
    }
    const now = new Date();
    const doc = {
      name:        String(body.name),
      file_path:   stripQuotes(body.file_path),
      description: String(body.description || ''),
      archived:    !!body.archived,
      created_at:  now,
      updated_at:  now,
    };
    dbo.collection("gyms").insertOne(doc, function(err, result) {
      if (err) {
        console.error('add_gym failed:', err);
        res.status(500).json({ error: String(err.message || err) });
        return;
      }
      console.log('gym inserted', result.insertedId);
      res.json(result);
    });
  });

  app.post('/update_gym', (req, res) => {
    const body = req.body || {};
    if (!body._id) {
      res.status(400).json({ error: "_id is required" });
      return;
    }
    let idFilter;
    try { idFilter = { "_id": ObjectID(body._id) }; }
    catch (e) { idFilter = { "_id": String(body._id) }; }
    // Worker-registered gyms (<robot>:<task_id>) are rewritten by their worker at boot.
    if (/^[a-z0-9_-]+:/i.test(String(body._id))
        && (body.name !== undefined || body.file_path !== undefined)) {
      res.status(400).json({ error: "this gym is registered by its robot's worker; name and path come from the task" });
      return;
    }
    const setFields: any = { updated_at: new Date() };
    const unsetFields: any = {};
    if (body.name        !== undefined) setFields.name        = String(body.name);
    if (body.file_path   !== undefined) setFields.file_path   = stripQuotes(body.file_path);
    if (body.description !== undefined) setFields.description = String(body.description);
    if (body.archived    !== undefined) setFields.archived    = !!body.archived;
    // Defaults the launch forms and the MCP console prefill for this gym; empty clears one.
    for (const key of ['default_course_type', 'default_reward_design_id', 'default_experiment_design_id', 'default_init_checkpoint']) {
      if (body[key] === undefined) continue;
      if (body[key] === null || String(body[key]).trim() === '') unsetFields[key] = '';
      else setFields[key] = String(body[key]).trim();
    }
    const gymUpdate: any = { "$set": setFields };
    if (Object.keys(unsetFields).length) gymUpdate["$unset"] = unsetFields;
    dbo.collection("gyms").updateOne(
      idFilter, gymUpdate, { upsert: false },
      function(err, result) {
        if (err) {
          console.error('update_gym failed:', err);
          res.status(500).json({ error: String(err.message || err) });
          return;
        }
        res.json(result);
      });
  });

  app.post('/archive_gym', (req, res) => {
    const body = req.body || {};
    if (!body._id) {
      res.status(400).json({ error: "_id is required" });
      return;
    }
    let idFilter;
    try { idFilter = { "_id": ObjectID(body._id) }; }
    catch (e) { idFilter = { "_id": String(body._id) }; }
    dbo.collection("gyms").updateOne(
      idFilter,
      { "$set": { archived: true, updated_at: new Date() } },
      { upsert: false },
      function(err, result) {
        if (err) {
          console.error('archive_gym failed:', err);
          res.status(500).json({ error: String(err.message || err) });
          return;
        }
        console.log('gym archived', body._id);
        res.json(result);
      });
  });

  // ---------------------------------------------------------------- *
  // Demos CRUD
  //
  // An expert-demonstration TFRecords directory (schema in
  // rl_agent/demos_registry.py). The trainer registers one per DEMO job
  // when collection finishes; /add_demo registers any other directory.
  //
  // /get_demos     : list all demos
  // /add_demo      : register a directory by hand
  // /update_demo   : edit num_demos / course / description / path
  // /archive_demo  : soft-delete (a hard delete would let the backfill
  //                  script re-register the job)
  // ---------------------------------------------------------------- *

  app.get('/get_demos', (req, res) => {
    if (needsUpdate(req, res, demosChanged, 'demos')) {
      demosChanged = false;
      dbo.collection("demos").find({}).toArray(function(err, result) {
        if (err) { console.error('get_demos query failed:', err); demosChanged = true; res.status(500).json({ error: String(err && (err.message || err)) }); return; }
        console.log(`${result.length} demos retrieved`);
        res.json(result);
      });
      return;
    }
    console.log('No demos retrieved');
    res.status(200).send('NO_CHANGES');
  });

  // Returns {fields} or {error}. `partial` allows omitted keys (update);
  // a present key is always validated.
  function demoFields(body: any, partial: boolean): { fields?: any, error?: string } {
    const f: any = {};
    if (body.num_demos !== undefined || !partial) {
      const n = Number(body.num_demos);
      if (body.num_demos === '' || body.num_demos == null || !isFinite(n) || Math.floor(n) !== n || n < 0) {
        return { error: "num_demos must be a non-negative integer" };
      }
      f.num_demos = n;
    }
    if (body.tfrecords_path !== undefined || !partial) {
      const p = stripQuotes(body.tfrecords_path);
      if (!p) return { error: "tfrecords_path is required" };
      f.tfrecords_path = p;
    }
    if (body.course      !== undefined) f.course      = String(body.course).trim();
    if (body.description !== undefined) f.description = String(body.description);
    return { fields: f };
  }

  app.post('/add_demo', (req, res) => {
    const { fields, error } = demoFields(req.body || {}, false);
    if (error) { res.status(400).json({ error }); return; }
    const now = new Date();
    const doc = {
      course: '', description: '', ...fields,
      archived: false, created_at: now, updated_at: now,
    };
    dbo.collection("demos").insertOne(doc, function(err, result) {
      if (err) {
        console.error('add_demo failed:', err);
        res.status(500).json({ error: String(err.message || err) });
        return;
      }
      res.json(result);
    });
  });

  app.post('/update_demo', (req, res) => {
    const body = req.body || {};
    if (!body._id) { res.status(400).json({ error: "_id is required" }); return; }
    const { fields, error } = demoFields(body, true);
    if (error) { res.status(400).json({ error }); return; }
    let idFilter;
    try { idFilter = { "_id": ObjectID(body._id) }; }
    catch (e) { idFilter = { "_id": String(body._id) }; }
    dbo.collection("demos").updateOne(
      idFilter, { "$set": { ...fields, updated_at: new Date() } }, { upsert: false },
      function(err, result) {
        if (err) {
          console.error('update_demo failed:', err);
          res.status(500).json({ error: String(err.message || err) });
          return;
        }
        res.json(result);
      });
  });

  app.post('/archive_demo', (req, res) => {
    const body = req.body || {};
    if (!body._id) { res.status(400).json({ error: "_id is required" }); return; }
    let idFilter;
    try { idFilter = { "_id": ObjectID(body._id) }; }
    catch (e) { idFilter = { "_id": String(body._id) }; }
    dbo.collection("demos").updateOne(
      idFilter,
      { "$set": { archived: body.archived === undefined ? true : !!body.archived,
                  updated_at: new Date() } },
      { upsert: false },
      function(err, result) {
        if (err) {
          console.error('archive_demo failed:', err);
          res.status(500).json({ error: String(err.message || err) });
          return;
        }
        res.json(result);
      });
  });

  // Task-aware lint for a duck design: the task's default term names (from its
  // gym) and the addable library (reward_term_catalog) go to
  // rl_agent/duck/lint_design.py, which needs nothing but python3.
  const DUCK_LINT_SCRIPT = '/python_ws/src/duck/lint_design.py';
  const DUCK_EXPERIMENT_CHECK_SCRIPT = '/python_ws/src/duck/check_experiment_design.py';
  const DUCK_SCRIPT_TIMEOUT_MS = 10000;

  // Run one of rl_agent/duck's stdin->stdout JSON checkers with the dashboard's python3.
  function runDuckScript(script: string, input: any): Promise<any> {
    return new Promise((resolve) => {
      const proc = spawn('python3', [script]);
      let out = '';
      let err = '';
      const timer = setTimeout(() => proc.kill('SIGKILL'), DUCK_SCRIPT_TIMEOUT_MS);
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('error', (e: Error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: `check could not run: ${e.message}` });
      });
      proc.on('close', (codeExit: number | null, signal: string | null) => {
        clearTimeout(timer);
        if (signal) {
          resolve({ ok: false, error: `check timed out after ${DUCK_SCRIPT_TIMEOUT_MS / 1000}s (module-level code runs at load)` });
          return;
        }
        try {
          resolve(JSON.parse(out));
        } catch (_e) {
          resolve({ ok: false, error: `check exited ${codeExit}: ${err.trim().split('\n').slice(-3).join(' ')}` });
        }
      });
      proc.stdin.end(JSON.stringify(input));
    });
  }

  async function lintMjlabDesign(robot: string, code: string, taskId: string | null): Promise<any> {
    let defaultTerms: string[] | null = null;
    if (taskId) {
      const prefix = `${robot}:`;
      const gym = await dbo.collection("gyms").findOne(
        { _id: taskId.startsWith(prefix) ? taskId : prefix + taskId },
        { projection: { reward_terms: 1 } });
      if (gym && Array.isArray(gym.reward_terms)) defaultTerms = gym.reward_terms;
    }
    const catalog = await dbo.collection("reward_term_catalog").findOne(
      { _id: robot }, { projection: { 'functions.name': 1 } });
    const library = catalog && Array.isArray(catalog.functions)
      ? catalog.functions.map((f: any) => f.name) : null;
    const dir = robot === 'microduck' ? 'duck' : robot;
    const result = await runDuckScript(`/python_ws/src/${dir}/lint_design.py`, { code, default_terms: defaultTerms, library });
    return { funcs: [], ...result, task_checked: defaultTerms !== null };
  }

  // Default terms per task live on the microduck gyms; this is the library of
  // reward functions a duck design can add ("func": name).
  app.get('/get_reward_term_catalog', async (req, res) => {
    try {
      const robot = String(req.query.robot || 'microduck');
      const doc = await dbo.collection("reward_term_catalog").findOne({ _id: robot });
      res.json(doc || { _id: robot, functions: [] });
    } catch (err) {
      res.status(500).json({ error: String(err && ((err as any).message || err)) });
    }
  });

  app.post('/lint_reward_design', (req, res) => {
    // Cheap structural lint of a candidate reward-design code string.
    //
    // The authoritative compile-check is what `load_reward_design()` does
    // inside the sim-controller (rl_agent/reward_designs.py): exec'd in
    // a restricted namespace, with the right argument-set enforced. We
    // can't reach Python from inside this Node container without
    // adding docker-CLI plus a socket mount, so we approximate just
    // enough to give the editor useful feedback before save:
    //
    //   - reject obviously empty input,
    //   - require at least one of the three reward function names,
    //   - flag use of obviously-disallowed builtins so users see them
    //     here instead of waiting until job start.
    //
    // A pass here still doesn't guarantee the design loads cleanly;
    // any syntactic error caught only by Python's compile() will surface
    // at the next job pickup as a RewardDesignError on that job (see
    // do_job's TRAIN branch in rl_agent/robotaxi.py).
    const body = req.body || {};
    if (typeof body.code !== 'string') {
      res.status(400).json({ ok: false, error: "code (string) is required" });
      return;
    }
    const code: string = body.code;
    if (!code.trim()) {
      res.json({ ok: false, error: "code is empty", funcs: [] });
      return;
    }
    // MicroDuck designs (rl_agent/duck/reward_design.py) edit the task's reward
    // terms through a top-level TERMS dict plus optional term_<name>() functions.
    // They are linted by the same Python the duck worker runs at job start, so
    // a pass here means the design applies to the chosen task.
    if (isMjlabRobot(String(body.robot || '')) || /(^|\n)TERMS\s*=/.test(code)) {
      const r = isMjlabRobot(String(body.robot || '')) ? String(body.robot) : 'microduck';
      lintMjlabDesign(r, code, body.task_id ? String(body.task_id) : null)
        .then((result) => res.json(result))
        .catch((err) => res.json({ ok: false, error: String(err && (err.message || err)), funcs: [] }));
      return;
    }
    const allowedFuncs = ['reward_standard', 'reward_success', 'reward_failure'];
    const found: string[] = [];
    for (const name of allowedFuncs) {
      // top-level `def reward_X(...)` declaration. We match any
      // amount of leading whitespace except a leading non-blank
      // character so we still catch a deliberately-indented def
      // (which would mean the function isn't top-level and the loader
      // would skip it anyway, but the user can see they're warned).
      const re = new RegExp('(^|\\n)\\s*def\\s+' + name + '\\s*\\(', 'm');
      if (re.test(code)) found.push(name);
    }
    if (!found.length) {
      res.json({
        ok: false,
        error: "no reward functions defined. Expected one or more of: " +
               allowedFuncs.join(', '),
        funcs: [],
      });
      return;
    }
    // Look for disallowed module access. This is a *hint*, not a
    // security boundary - the real sandbox is the restricted exec
    // builtins in load_reward_design(). We just want to fail fast
    // here when someone tries `import os` because the trainer would
    // also reject it.
    const disallowedImports = [
      /(^|\n)\s*import\s+(os|sys|subprocess|socket|requests|urllib)\b/,
      /(^|\n)\s*from\s+(os|sys|subprocess|socket|requests|urllib)\b/,
    ];
    for (const re of disallowedImports) {
      const m = code.match(re);
      if (m) {
        res.json({
          ok: false,
          error: "import of restricted module: " + m[2] +
                 " (the trainer's sandbox blocks os / sys / subprocess / sockets / network).",
          funcs: found,
        });
        return;
      }
    }
    res.json({ ok: true, error: null, funcs: found });
  });

  return app;
};
