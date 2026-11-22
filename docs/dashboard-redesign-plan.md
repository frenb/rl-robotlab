# Dashboard redesign: user journeys and plan

Status: phases 0–5 done (Nov 2026). Replaces the Golden Layout + iframe + TensorBoard
dashboard (`dashboard/`) with one app built around runs, comparisons and models,
for every robot (roboracer, openbeni, microduck).

## 1. Where we are

| Area | Today |
|---|---|
| Shell | `goldenlayout.js`: fixed two-column layout of ~15 iframes, each a static HTML page loaded from `http://localhost/...`. Pages talk through `postMessage`. |
| Pages | `jobs`, `models`, `analysis`, `leaderboard`, `weakness`, `curricula`, `gyms`, `demos`, `experiment_designs`, `reward_designs`, `reward_specs`, `rewards`, `madscientist`, `logs`: ~15k lines of inline JS. Tailwind via CDN plus `styles.css`; Plotly, three.js, marked and CodeMirror per page; shared helpers in a 2.3k-line `components.js`. |
| Server | `src/server.ts`: one 3.5k-line Express file, ~80 untyped routes (`/get_*`, `/add_*`, ...), `/add_job` inserts the body verbatim, `/get_jobs` returns the whole collection. Change-stream versions plus a WebSocket (8082) push collection changes; a second WebSocket (8080) tails `/tmp/trainer.log`. |
| Training curves | One TensorBoard in `sim-controller` with `--logdir_spec=current:/tmp/active,compare:/tmp/tb_compare`. "Tensorboard (current)" shows only the single car job in `/tmp/active`. "Compare" = `/set_tb_compare_jobs` symlinks archived `/tmp/jobsdata/<id>/<id>` dirs into `/tmp/tb_compare` and re-points an iframe with a `runFilter` regex. |
| mjlab robots | openbeni/microduck write TensorBoard files inside their own containers (`logs/rsl_rl/...`); the car TensorBoard never sees them. Jobs only carry the latest parsed `mean_reward` / iteration, with no history. The console's `compare_in_tensorboard` refuses duck jobs for this reason. |
| Logs | Only the car trainer log is streamed; mjlab logs need `docker logs` (and the console's `tail_trainer_log` is currently broken for openbeni). |
| Media | Clips and progress videos are referenced from job docs (`progress_video`, clips) and opened from the Jobs table. |

The core problems: **no per-job metric store** (curves live in TensorBoard
folders, reachable only for one robot); **pages are islands** (each re-fetches,
re-implements tables and modals, and couples to others through `postMessage`);
and **no information hierarchy** (everything is a tab of equal weight, so a new
user sees 15 tabs and two TensorBoards).

## 2. Who uses it

- **New user**: wants to see a robot learn something in their first 15 minutes.
- **Researcher / operator**: launches and babysits runs, compares variants, decides what to try next. Most daily use.
- **Curriculum author**: sequences stages, sets gates, handles failed gates.
- **Designer**: edits gyms, rewards, experiment designs, reward specs and demos.
- **Deployer**: exports a model and ships it to a real robot or Unity client.
- **Overseer**: reviews and approves the MadScientist agent's proposals.
- **Agents (MCP console)**: the same operations through tools; must stay supported.

## 3. User journeys

Each journey lists the steps, what exists today, and the main friction.

### J1. First run (new user)
1. Open the app, pick a robot.
2. Start a recommended "starter" run from a template (gym, reward, budget prefilled).
3. Land on that run's page: progress, live curve, first clip within minutes.
4. Get a plain-language summary when it finishes ("survived 92% of episodes; watch the clip").

Today: no robot picker, no templates; the New-job modal shows every field; curves live in a separate TensorBoard tab (car only).

### J2. Launch a training run
1. Pick robot → gym → reward design → experiment design (with defaults shown).
2. Set budget, environments, seed; optionally warm-start from a model.
3. Review a summary (estimated duration, queue position) and submit.
4. Or clone an earlier run and change one thing.

Today: New-job modal plus Clone in Jobs; no validation (`/add_job` stores typos); no estimate.

### J3. Monitor live work
1. See everything running and queued across robots and workers, with progress, ETA and health.
2. Open a run: live curves, latest clip, log tail, checkpoint list.
3. Pause, resume, cancel, restart or reprioritise; pause the queue.

Today: Jobs table plus "Tensorboard (current)" (one car job only) plus the car trainer log; mjlab runs have no curves or logs in the UI.

### J4. Diagnose a run
1. Failed: see the error, the log around it, and the last good checkpoint; retry.
2. Poor result: curves (reward terms, episode length, losses), clips over time, eval results, weakness map (car), gate details.
3. Leave a note on the run.

Today: spread across Jobs, logs, TensorBoard, Models, Weakness; errors are raw text; no notes.

### J5. Compare runs and models
1. Select 2–8 runs from anywhere (runs list, model list, curriculum, a link).
2. Overlay curves on aligned axes (iteration, env steps, wall time) with smoothing.
3. Diff configs (gym, reward weights, experiment design, hyperparameters).
4. Compare eval metrics and watch clips side by side at the same iteration.
5. Save or share the comparison as a link.

Today: Models → "Compare in Analysis" → symlink bucket → re-pointed TensorBoard iframe (car only, archived jobs only, lost on restart), plus a separate Plotly Analysis tab for eval scores. No config diff, no video comparison, no sharing.

### J6. Evaluate and rank models
1. From a model or run, start an eval (default suite, or a curriculum sweep for the car).
2. See eval results, gate pass/fail, and where the model sits on the leaderboard.
3. Promote a model as "best" for a robot.

Today: Models eval modal, Leaderboard, Analysis; roboracer-centred; gate results only on curricula.

### J7. Run a curriculum
1. Author stages (gym, reward, settings, gate, budget, carry) with live validation.
2. Start a run and watch a stage timeline: each stage's train and eval jobs, gate outcome and clips.
3. On a failed gate: see why (metric vs threshold), then retry, edit or skip.

Today: Curricula tab with JSON-ish editing; jobs appear in Jobs; retry and failures need the API or MCP.

### J8. Design the task
1. Browse gyms, rewards and experiment designs per robot; see which runs used each.
2. Edit with validation and lint; duplicate, archive.
3. Compile reward specs; manage demos.

Today: five separate tabs with different editors and patterns.

### J9. Ship a model
1. Pick a model, export ONNX, check its observation and action shapes.
2. Package a gym release; check Unity clients; deploy to a car or robot.

Today: Export in Models; releases and Unity clients only via MCP or scripts.

### J10. Oversee the research agent
1. See what MadScientist is doing now, pending decisions, and the outcomes of past proposals (linked to their runs).
2. Approve, reject, defer or edit with context (diff, cost, expected effect).

Today: Mad Scientist tab; outcomes not linked to runs or comparisons.

### J11. Operate the platform
1. Health of workers, Unity clients, queue, disk and Mongo.
2. Logs per service; clean up old runs and artifacts.

Today: scattered (logs tab, `docker logs`, MCP).

## 4. Target experience

**One app, one navigation, robot-aware.** A global robot switcher (All /
roboracer / openbeni / microduck) and a left sidebar:

| Section | Replaces | Contents |
|---|---|---|
| Home | – | Running now, needs attention (failed jobs, failed gates, pending proposals), recent results, "Start a run" |
| Runs | Jobs, Tensorboard (current), logs | Filterable table (robot, status, gym, curriculum, tags); run page with tabs **Overview · Metrics · Media · Logs · Evals · Config** |
| Compare | Both TensorBoard tabs, Analysis | Pick runs or models → overlaid curves, config diff, eval table, synced videos; shareable URL `/compare?runs=a,b,c` |
| Models | Models, Leaderboard | Checkpoints per robot, leaderboard, evaluate, export, promote |
| Curricula | Curricula | Builder with live validation, run timeline per stage, gate details, retry/skip |
| Design | Gyms, Rewards, Reward designs, Reward specs, Experiment designs, Demos | One studio with consistent list → detail → edit, plus "used by N runs" |
| Insights | Weakness | Weakness map (car), difficult sections, future per-robot analyses |
| Lab | Mad Scientist | Activity, decisions, outcomes linked to runs |
| System | logs, MCP-only bits | Queue, workers, Unity clients, releases, service logs, storage |

Principles: every object has a URL; any list can feed Compare; defaults first,
advanced settings folded; live everywhere (no manual refresh); the same
components (table, chart, video, form) across pages; the same metric names for
all robots where possible.

## 5. Architecture

### 5.1 Metrics: TensorBoard event files as the source, read by our API
Trainers keep writing TensorBoard event files exactly as they do now. The
TensorBoard *UI* goes away; the dashboard server reads the event files and
serves curves to the app.

- **One view of all logdirs:** the dashboard container already mounts the car's
  `tmpdata` volume at `/tmp` and `saved_models` at `/saved_models`, so the reader
  (`dashboard/src/api/tfevents.ts`, a small TFRecord + protobuf decoder for scalars)
  lives in the dashboard; no separate service.
- **Job → event files** (`dashboard/src/api/runs.ts`): mjlab jobs record their run
  folders in `<prefix>_run_dirs`, where the prefix comes from the robot's
  `curriculum.checkpoint_field` (`openbeni_checkpoint` → `openbeni_run_dirs`); the
  registry's `media_prefix` maps those container paths to `/saved_models/<robot>`.
  Car jobs resolve by id to `/tmp/active/<id>` while training and
  `/tmp/jobsdata/<id>[/<id>]` once archived; each writer folder (`eval`, `train`,
  `learner/train`, ...) becomes a tag prefix. Cache keys are relative to the run, so
  a run moved by `move_all_jobs_data` keeps its read offsets.
- **Reading** (`dashboard/src/api/metrics.ts`): each file is followed from its last
  byte offset (a half-written last record waits for the next read); parsed series
  stay in memory, capped at 8M points with least-recently-used eviction. Runs that
  were resumed into several folders or files merge into one series per tag.
- **Downsampling:** min/mean/max buckets; charts ask for 1,500 points per series.
- **API:** `GET /api/v1/runs/:id/metrics/tags`, `GET /api/v1/runs/:id/metrics?tags=...&max_points=...`,
  `GET /api/v1/compare/metrics?runs=...&tags=...`; the live socket sends
  `metrics.changed` when a subscribed run logs new points.
- **Tag names:** a per-robot alias map (e.g. car `eval/score` and rsl_rl
  `Train/mean_reward`) so Compare can line up common metrics across robots,
  while every raw tag stays available.
- **TensorBoard:** the TensorBoard process in `sim-controller`, both TensorBoard tabs, the
  `/tmp/tb_compare` bucket and `/set_tb_compare_jobs` were removed when Compare shipped (phase 2).

### 5.2 API v1
- New typed routes under `/api/v1` (runs, models, curricula, designs, media, metrics, system), with zod schemas shared with the frontend, pagination and filters on the server, and validation on create (fixes silent typos in `/add_job`).
- Split `server.ts` into modules (`routes/runs.ts`, `routes/metrics.ts`, ...).
- Keep the existing endpoints during migration; the MCP console moves to v1 last.
- One WebSocket with typed events (`run.updated`, `metrics.appended`, `log.line`, `proposal.updated`) replacing the two ad-hoc sockets and the `?since` polling.

### 5.3 Logs and media
- Per-run log streaming for every robot: workers already write per-job log files; serve `GET /api/v1/runs/:id/logs` (tail plus stream) instead of only `/tmp/trainer.log`.
- Media index per run (clips by iteration, progress video, labels such as SHOVE/JUMP) served with HTTP range requests, so the player can scrub and Compare can sync videos by iteration.

### 5.4 Frontend
Stack: **React + TypeScript + Vite**, routing
with **TanStack Router**, data with **TanStack Query** (cache + WebSocket
invalidation), tables with **TanStack Table**, UI with **Tailwind + shadcn/ui**
(accessible, themeable, light/dark), charts with **uPlot** (fast with many long
series), forms with **react-hook-form + zod** (same schemas as the API). Built to
static files and served by the existing Express container; no extra service.

Working on it (`dashboard/app`):

```powershell
cd dashboard/app
npm install
npm run dev     # http://localhost:5173/app/, API and live socket proxied to the stack on :80
npm run build   # writes app/dist, which the dashboard serves at http://localhost/app/
```

`app/dist` is a build output (git-ignored): build it on the host after pulling.
Node modules stay host-side; the dashboard container only serves the files.

## 6. Delivery plan

The new app ships at `/app` beside the old dashboard; each phase retires the
old tabs it replaces. Every phase ends usable on its own.

| Phase | Scope | Done when |
|---|---|---|
| 0. Foundations (done) | Event-file reader for all robots; `/api/v1` (robots, runs, run, metrics, compare metrics, logs, media) and the `/api/v1/live` socket; app scaffold with shell, robot switcher, Home, Runs list and a first run page (Overview, Metrics, Media, Logs, Config) | Live curves for a training openbeni run and a car run (live and archived) at `/app` |
| 1. Runs (done) | Runs list (server-side filters, sorting, saved views, bulk actions, queue bar with pause/resume and worker heartbeat); run page actions, queue position, lineage and curriculum card; launch wizard at `/app/runs/new` (defaults, recent run as template, clone) validated server-side (`POST /api/v1/runs?dry_run=1`); per-job car logs and car `mean_reward` | J1–J4 doable in `/app` for all robots; "Jobs" and "Tensorboard (current)" tabs retired (the classic shell embeds `/app/runs` as its Runs tab, and Job ID links open the run page) |
| 2. Compare (done) | `/app/compare?runs=…&models=…` (up to 12 runs of any robots; a model brings in its run) from the runs bulk bar, a run page, the classic Models tab or Add runs; overlaid curves with `@reward` / `@length` aliases across robots, smoothing and step or wall-time x axis; settings diff with only-differences and a reward-code line diff; eval table pooling car trials (Welch's t-test, 95% CI, Hedges' g against a chosen baseline, per curriculum stage) and mjlab EVAL aggregates; clips synced by iteration; all state in the URL; `GET /api/v1/compare` | J5 for all robots; TensorBoard process (and port 6006), compare bucket, `/set_tb_compare_jobs`, the TensorBoard tab and the Analysis tab removed (`/analysis` redirects to Compare); MCP `compare_in_tensorboard` replaced by `compare_link` |
| 3. Models & evals (done) | `/app/models`: checkpoints per robot (all, evaluated or promoted; course or task, search, a run's checkpoints) with eval summary and spec compatibility; bulk evaluate, ONNX export and video render (mjlab), compare and delete; leaderboard per robot pooling car trials per model (goals, steps per goal, crashes, return..., 95% CI, min trials, course, ordinary evals or one sweep stage) or ranking mjlab EVAL aggregates per task; `/app/models/:id` with pooled evals, eval jobs, curriculum gate checks, rank, lineage and the run's other checkpoints, observation/action specs and ONNX download, reward code, notes, promote (one per robot, `models.promoted_at`); an eval launcher that dry-runs every model first (car EVALs take the model's course and recorded designs via `model_id`; full curriculum sweeps; mjlab robots and steps); `GET /api/v1/models`, `/models/:id`, `/leaderboard`, `PATCH /models/:id`, `POST /models/:id/promote`, `DELETE /models/:id`, `POST /models/delete` | J6 and the export half of J9; the Models and Leaderboard tabs replaced by one embedded Models tab (`/models` and `/leaderboard` redirect); MCP `promote_model` |
| 4. Curricula & design (done) | `/app/curricula`: curricula per robot with their runs; a builder (form or JSON) with stage settings from the robot's manifest, inherited values shown, starting point and carry, gate conditions, retries, live validation against the server, duplicate, archive and start (from a stage, queue position); `/app/curricula/runs/:id` stage timeline with each attempt's train and gate-eval jobs, gate metrics against thresholds, checkpoints, and cancel, retry, skip (a failed gate) or delete. `/app/design`: reward designs (CodeMirror, lint, mjlab term reference with task defaults and library insertable into `TERMS`), reward specs (Markdown, per-robot compiled code, compile review with rationale and diff, accept/discard/keep, strict mode), experiment designs (form from the robot's schema, overrides only), gyms (launch defaults; worker-registered tasks read-only) and demos; each with what uses it (runs, models, curricula, derived designs) and the versions runs trained with, diffable against the current one; `GET /api/v1/curricula`, `/curriculum-runs`, `POST /curriculum-runs/:id/actions`, `GET /api/v1/designs/:kind[/:id[/versions/:v]]` | J7, J8; the Rewards, Experiment Design, Curricula, Gyms and Demos tabs replaced by embedded Curricula and Design tabs; the old pages redirect (with `?id=`) |
| 5. Lab, insights, system (done) | `/app/lab`: what awaits a decision (approve, defer, reject, edit before approving, with judge concerns and cost), proposals in flight, outcomes (verdict, raw delta against the criterion, per-arm statistics) and the agents' activity feed; `/app/lab/:id` with the arms' runs and scored models, compare links, implementation log, papers, judge review and audit trail. `/app/insights`: a car run's track coloured by weakness, crashes, slowness, pre-crash risk or traffic, with hotspots, goal gates, hardest gates and sections (Wilson ranges) and a start-gate suggestion. `/app/system`: worker heartbeats and running jobs, queue switch, disk and Mongo, Unity clients' desired gym, GitHub releases, workers' live output. `/api/v1/lab`, `/insights/weakness`, `/insights/gates`, `/system`, `/system/logs/:service`, `/system/releases` | J9–J11; Golden Layout and the classic pages removed (their URLs redirect into `/app`), with the 8080 log socket and 8082 data socket; MCP queue, log, weakness and MadScientist tools on `/api/v1`. Unity processes, gym builds and release uploads stay host-side MCP tools (the container can't see them) |

Rough size: phase 0 is the riskiest (data pipeline); phases 1–2 deliver most
of the value for new users.

## 7. Decisions

Made (Nov 2026):
1. Frontend: React + TypeScript + Vite, TanStack Router/Query/Table, Tailwind + shadcn-style components.
2. Metrics: TensorBoard event files stay the source of truth; the dashboard server reads them for all robots.
3. TensorBoard UI: dropped once Compare ships.
4. Rollout: side by side at `/app`, retiring old tabs phase by phase.
5. Charts: uPlot. With series downsampled to 1,500 points the run pages stay responsive; ECharts' extras aren't needed yet.

Open:
6. Auth / multi-user: not needed today; design URLs and APIs so it can be added.
7. Building `app/dist` in the container (needs Linux node modules separate from the host's) vs keeping the host build.

## 8. Risks

- Car runs move between `/tmp/active` and `/tmp/jobsdata` (`move_all_jobs_data`); the path resolver must follow a run across that move without dropping or double-counting points.
- Car per-job logs are cut from the shared `/tmp/trainer.log` by the dashboard (`src/api/carlogs.ts`) and archived to `saved_models/robotaxi/job_logs/<id>.log`; car jobs that finished before phase 1 have no archived log, and a job that starts while the dashboard is down can get a partial one.
- Car `mean_reward` is written by the trainer after each eval; older car jobs are backfilled from `eval/Metrics/AverageReturn` (`src/api/backfill.ts`).
- Event-file volume: thousands of iterations × dozens of tags × many runs; cache parsed series and downsample from day one.
- Feature parity: some old tabs hold rarely used but critical tools (reward spec compile, curriculum sweep evals); list them per phase before retiring a tab.
- MCP console depends on old endpoints; migrate it last and keep shims.
