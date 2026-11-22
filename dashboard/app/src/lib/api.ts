// Client for the dashboard's /api/v1 (dashboard/src/api).

export interface Robot {
  id: string;
  display_name: string;
  engine: string | null;
  badge_color: string | null;
  iter_label: string | null;
  course_label: string | null;
  job_types: string[];
  supports: Record<string, boolean>;
}

export type RunAction = 'pause' | 'resume' | 'cancel' | 'restart' | 'mark_done';

export type RunStatus =
  | 'NOT_STARTED' | 'IN_PROGRESS' | 'PAUSE_REQUESTED' | 'PAUSED' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface Run {
  id: string;
  robot: string;
  name: string | null;
  job_type: string | null;
  status: RunStatus | null;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  percent_complete: number | null;
  iteration: number | null;
  budget: number | null;
  gym_name: string | null;
  task_id: string | null;
  reward_design_name: string | null;
  experiment_design_name: string | null;
  curriculum_name: string | null;
  curriculum_stage_name: string | null;
  mean_reward: number | null;
  mean_episode_length: number | null;
  error: string | null;
  curriculum_run_id: string | null;
  cloned_from: string | null;
  /** What the run's status allows; the server refuses anything else. */
  actions: RunAction[];
  deletable: boolean;
  /** 1 = next to start, across all robots. */
  queue_position?: number | null;
}

export interface RunPage {
  items: Run[];
  total: number;
  offset: number;
  limit: number;
}

export interface CurriculumRunInfo {
  id: string;
  status: string | null;
  name: string | null;
  stage_index: number | null;
  stage_count: number | null;
  attempt: number | null;
  error: string | null;
}

/** OpenBeni's own switch into jump training, read from the run folder. */
export interface JumpStatus {
  enabled: boolean;
  since_update: number | null;
  reason: string | null;
  last_check: {
    update: number;
    passed: boolean;
    consecutive_passes: number | null;
    failing: { name: string; success_rate: number | null }[];
  } | null;
}

export interface RunDetail {
  run: Run;
  curriculum_run: CurriculumRunInfo | null;
  jump?: JumpStatus | null;
  job: Record<string, unknown>;
}

/** What /runs POST takes (dashboard/src/api/launch.ts LaunchSpec). */
export interface LaunchSpec {
  robot: string;
  job_type: string;
  name?: string;
  notes?: string;
  gym_id?: string;
  reward_design_id?: string;
  experiment_design_id?: string;
  budget?: number | string | null;
  seed?: number | string | null;
  video?: boolean;
  progress_video?: boolean;
  num_envs?: number | string | null;
  save_interval?: number | string | null;
  init_checkpoint?: string;
  model_id?: string;
  eval_num_envs?: number | string | null;
  eval_steps?: number | string | null;
  course_type?: string;
  model_type?: string;
  demo_id?: string;
  demo_job_id?: string;
  skip_first_eval?: boolean;
  training_steps?: number | string | null;
  demo_step_budget?: number | string | null;
  location?: string;
  num_trials?: number | string | null;
  num_eval_episodes?: number | string | null;
  corner_radius_val?: number | string | null;
  curvature_difficulty_val?: number | string | null;
  eval_all_stages?: boolean;
  eval_stage_start?: number | string | null;
  eval_stage_end?: number | string | null;
  allow_no_demos?: boolean;
  carry?: Record<string, unknown>;
  cloned_from?: string;
}

export interface LaunchProblem {
  errors: Record<string, string>;
  warnings: string[];
  confirm: { flag: keyof LaunchSpec; message: string } | null;
}

export interface Option { id: string; name: string; version?: number | null }

export interface LaunchOptions {
  robot: string;
  engine: 'car' | 'mjlab';
  job_types: string[];
  courses: { value: string; label: string }[];
  model_types: string[];
  gyms: (Option & { task_id: string | null; default_init_checkpoint: string | null })[];
  reward_designs: Option[];
  experiment_designs: (Option & { stages: number; demo_features: string[] })[];
  demos: { id: string; label: string; course: string | null }[];
  models: {
    id: string; location: string | null; task_id: string | null; job_id: string | null; iteration: number | null;
    avg_return: number | null; reward_design_name: string | null; experiment_design_name: string | null; course_type: string | null;
  }[];
  defaults: { gym_id: string | null; reward_design_id: string | null; experiment_design_id: string | null };
  recent: Run[];
}

export interface QueueState {
  paused: boolean;
  running: Run[];
  queued: (Run & { position: number })[];
  workers: { robot: string; online: boolean; last_seen: string | null }[];
}

export interface BulkResult { id: string; ok: boolean; error?: string }

export interface TagInfo {
  tag: string;
  points: number;
  last_step: number;
  last_value: number;
}

export interface Series {
  steps: number[];
  values: number[];
  min?: number[];
  max?: number[];
  /** Wall-clock seconds per point, when asked for. */
  walls?: number[];
}

export type ConfigValue = string | number | boolean | null;

export interface ConfigSection {
  title: string;
  values: Record<string, ConfigValue>;
}

export interface EvalSample {
  /** Curriculum-sweep stage the trials ran on; null for a single-geometry eval. */
  stage: number | null;
  created_at: string | null;
  trials: Record<string, number[]>;
}

export interface ModelEval {
  id: string;
  run_id: string | null;
  robot: string;
  label: string;
  location: string | null;
  iteration: number | null;
  created_at: string | null;
  avg_return: number | null;
  /** Car evals: per-trial samples. */
  samples: EvalSample[];
  /** mjlab evals: one aggregate per model, no per-trial samples. */
  aggregate: Record<string, number> | null;
}

export interface CompareRun {
  run: Run;
  config: ConfigSection[];
  reward_code: string | null;
  checkpoints: number;
}

export interface CompareData {
  runs: CompareRun[];
  models: ModelEval[];
  picked_models: string[];
  missing: string[];
}

export interface RunMedia {
  progress_video: string | null;
  progress_gif: string | null;
  clips: { iteration: number | null; url: string; gif_url: string | null }[];
}

export interface LogChunk {
  available: boolean;
  note: string | null;
  start: number;
  end: number;
  text: string;
  reset?: boolean;
}

export interface Compat {
  status: 'compatible' | 'incompatible' | 'unknown';
  reason: string;
}

export interface ModelEvalSummary {
  /** Car: eval runs (one per sweep stage); mjlab: 1 once evaluated. */
  count: number;
  /** Car: pooled trials; mjlab: episodes. */
  trials: number;
  last_at: string | null;
  metrics: Record<string, number>;
  stages: number[];
}

export interface DesignRef { id: string | null; name: string | null; version: number | null }

export interface RunBrief {
  id: string;
  name: string | null;
  status: RunStatus | null;
  job_type: string | null;
  gym_name: string | null;
  task_id: string | null;
  curriculum_name: string | null;
  curriculum_stage_name: string | null;
}

export interface ModelSummary {
  id: string;
  robot: string;
  label: string;
  location: string | null;
  run_id: string | null;
  created_at: string | null;
  iteration: number | null;
  model_type: string | null;
  /** Car course (donut when unset) or mjlab task. */
  course: string | null;
  task_id: string | null;
  /** Training-time return the trainer stamped on the checkpoint. */
  avg_return: number | null;
  reward_design: DesignRef | null;
  experiment_design: DesignRef | null;
  onnx_location: string | null;
  obs_dim: number | null;
  act_dim: number | null;
  notes: string | null;
  promoted_at: string | null;
  /** Newest checkpoint of its run. */
  latest_of_run: boolean;
  eval: ModelEvalSummary | null;
  compat: Compat;
  run?: RunBrief | null;
}

export interface ModelPage {
  items: ModelSummary[];
  total: number;
  offset: number;
  limit: number;
  courses: string[];
}

export interface ModelQuery {
  robot?: string;
  q?: string;
  course?: string;
  run?: string;
  evaluated?: boolean;
  promoted?: boolean;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface GateResult {
  curriculum_run_id: string;
  curriculum_name: string | null;
  stage_index: number | null;
  stage_name: string | null;
  attempt: number | null;
  passed: boolean;
  checks: { metric: string; op: string; value: number; actual: number | null; passed: boolean }[];
  eval_job_id: string | null;
  train_job_id: string | null;
  at: string | null;
}

export interface ModelDetail {
  model: ModelSummary;
  run: Run | null;
  specs: {
    observation: unknown;
    action: unknown;
    env: { observation: unknown; action: unknown; updated_at: string | null } | null;
    obs_dim: number | null;
    act_dim: number | null;
  };
  onnx_url: string | null;
  clip_url: string | null;
  git: { sha: string; branch: string | null } | null;
  reward_code: string | null;
  samples: (EvalSample & { id: string })[];
  aggregate: (Record<string, unknown> & { eval_job_id: string | null }) | null;
  eval_runs: Run[];
  gates: GateResult[];
  rank: { metric: string; rank: number; of: number; course: string | null } | null;
  checkpoints: { id: string; iteration: number | null; created_at: string | null; evaluated: boolean; latest_of_run: boolean; promoted: boolean }[];
}

export interface LeaderboardStats { n: number; mean: number; sd: number; median: number; min: number; max: number }

export interface Leaderboard {
  robot: string;
  engine: 'car' | 'mjlab';
  metric: string;
  metrics: { key: string; label: string; better: 'higher' | 'lower' | null }[];
  courses: string[];
  stages: number[];
  stage: string;
  min_trials: number;
  total: number;
  rows: { rank: number; model_id: string; stats: LeaderboardStats; evals: number; last_at: string | null; model: ModelSummary }[];
}

export interface LeaderboardQuery {
  robot: string;
  metric?: string;
  course?: string;
  stage?: string;
  min_trials?: number;
}

export interface StageSettingSpec { type?: string; integer?: boolean; min?: number; max?: number; unit?: string; doc?: string }

/** A robot's `curriculum:` manifest block (robots/<id>/robot.yaml). */
export interface CurriculumCaps {
  enabled: boolean;
  budget_field: string | null;
  checkpoint_field: string | null;
  carry: string[];
  carry_atomic: boolean;
  carry_same_task: boolean;
  early_stop: boolean;
  gate_metrics: string[];
  stage_settings: Record<string, StageSettingSpec>;
}

export interface GateCondition { metric: string; op: string; value: number }
export interface GateCheck extends GateCondition { actual: number | null; passed: boolean }

/** A stage as authored: a missing key inherits from the stage before (rl_agent/curriculum/model.py). */
export interface Stage {
  id?: string;
  name?: string;
  kind?: string;
  gym?: string;
  reward_design_id?: string | null;
  experiment_design_id?: string | null;
  budget?: number;
  settings?: Record<string, number>;
  init?: string;
  carry?: string[];
  gate?: { conditions: GateCondition[]; consecutive?: number } | null;
  on_fail?: { retries?: number; extra_budget?: number };
  eval?: { fallen_probability?: number };
  [key: string]: unknown;
}

export interface CurriculumSummary {
  id: string;
  robot: string;
  name: string | null;
  description: string;
  version: number;
  archived: boolean;
  author: string | null;
  stage_count: number;
  stages: { id: string | null; name: string | null; gym: string | null; budget: number | null; gated: boolean }[];
  created_at: string | null;
  updated_at: string | null;
  runs?: { total: number; active: number };
  last_run?: { id: string; status: string | null; created_at: string | null; stage_index: number } | null;
}

export type CurriculumRunAction = 'cancel' | 'retry' | 'skip' | 'delete';

export interface CurriculumRunSummary {
  id: string;
  curriculum_id: string | null;
  curriculum_name: string | null;
  curriculum_version: number | null;
  robot: string;
  status: string | null;
  stage_index: number;
  stage_count: number;
  stage_name: string | null;
  attempt: number;
  generation: number;
  error: string | null;
  created_at: string | null;
  updated_at: string | null;
  ended_at: string | null;
  stages_done: number;
  progress: number;
  pending: { role: string | null; job_id: string | null } | null;
  current_job: Run | null;
  last_gate: { stage_index: number; passed: boolean; skipped: boolean; checks: GateCheck[] } | null;
  actions: CurriculumRunAction[];
}

export interface CurriculumResult {
  stage_index: number;
  stage_id: string | null;
  stage_name: string | null;
  attempt: number;
  train_job_id: string | null;
  eval_job_id: string | null;
  checkpoint: string | null;
  metrics: Record<string, unknown> | null;
  gate: GateCheck[];
  passed: boolean;
  skipped: boolean;
  at: string | null;
}

export interface CurriculumRunJob extends Run {
  stage_index: number | null;
  attempt: number;
  generation: number;
  role: 'train' | 'eval' | string;
  handoff: { source_job_id: string | null; checkpoint: string | null; carry: string[] } | null;
}

export interface CurriculumRunDetail {
  run: CurriculumRunSummary & {
    stages: Stage[];
    options: { start_stage?: number; priority?: string };
    results: CurriculumResult[];
    skip_reason: string | null;
  };
  jobs: CurriculumRunJob[];
  curriculum: { id: string; name: string | null; version: number; archived: boolean } | null;
}

/** What the classic validator answers: resolved stages, or one line per problem. */
export interface CurriculumCheck { ok: true; curriculum: { robot: string; name: string; description: string; stages: Stage[] } }

export type DesignKind = 'gyms' | 'reward_designs' | 'experiment_designs' | 'demos';

export interface DesignUse { runs: number; models: number; last_used: string | null; curricula: number }

interface DesignBase {
  id: string;
  robot: string;
  name: string | null;
  description: string;
  archived: boolean;
  created_at: string | null;
  updated_at: string | null;
  used?: DesignUse;
}

export interface GymRow extends DesignBase {
  file_path: string | null;
  task_id: string | null;
  managed_by: string | null;
  engine: string | null;
  skill: string | null;
  terrain: string | null;
  episode_s: number | null;
  reward_term_count: number;
  default_course_type: string | null;
  default_reward_design_id: string | null;
  default_experiment_design_id: string | null;
  default_init_checkpoint: string | null;
  reward_defaults?: { name: string; weight: number; func?: string; params?: Record<string, unknown> }[];
}

export interface RewardDesignRow extends DesignBase {
  version: number;
  author: string | null;
  canonical: boolean;
  spec_id: string | null;
  spec_status: string | null;
  lines: number;
  code?: string;
}

export interface ExperimentDesignRow extends DesignBase {
  version: number;
  author: string | null;
  canonical: boolean;
  overrides: number;
  proposal_id: string | null;
  base_design_id: string | null;
  demo_features: string[];
  legacy_stages: number;
  fields?: Record<string, unknown>;
}

export interface DemoRow extends DesignBase {
  label: string;
  num_demos: number | null;
  num_steps: number | null;
  course: string | null;
  tfrecords_path: string | null;
  gym_name: string | null;
  source_job_id: string | null;
  collected_at: string | null;
}

export interface DesignRows {
  gyms: GymRow;
  reward_designs: RewardDesignRow;
  experiment_designs: ExperimentDesignRow;
  demos: DemoRow;
}

export interface DesignUsage {
  runs: number;
  models: number;
  recent: Run[];
  curricula: { id: string; name: string | null; robot: string }[];
  versions: { version: number; runs: number; models: number; last_used: string | null }[];
  derived: { id: string; name: string | null; archived: boolean }[];
}

export interface ExperimentField {
  kind: 'field' | 'section';
  label?: string;
  name: string;
  type: 'int' | 'float' | 'bool' | 'json' | 'enum' | string;
  default: unknown;
  min?: number | null;
  max?: number | null;
  doc?: string | null;
  paper_ref?: string | null;
  choices?: string[] | null;
}

export interface LintResult {
  ok: boolean;
  error?: string | null;
  funcs?: string[];
  terms?: string[];
  notes?: string[];
  task_checked?: boolean | null;
}

export interface TermFunction { name: string; doc?: string; module?: string; params?: { name: string; required: boolean }[] }

export type SpecStatus = 'missing' | 'stale' | 'edited' | 'fresh';

export interface SpecCompile {
  state: 'queued' | 'running' | 'pending' | 'failed' | 'accepted' | 'discarded';
  requested_at?: string;
  inputs_sha?: string;
  error?: string | null;
  result?: {
    ok?: boolean; code?: string; model?: string; cost_usd?: number; inputs_sha?: string;
    rationale?: { section?: string; bullet?: string; implementation?: string; terms?: string[] }[];
    unsupported?: { section?: string; bullet?: string; reason?: string }[];
    problems?: string[];
    rounds?: { round: number; problems: string[] }[];
  };
}

export interface SpecSummary {
  ok: boolean;
  name: string;
  description?: string;
  goal?: string;
  robots: string[];
  microduck_task?: string | null;
  openbeni_task?: string | null;
  statuses: Record<string, SpecStatus>;
  inputs_sha: Record<string, string>;
  compiled: Record<string, { code: string; meta: { inputs_sha?: string; code_sha?: string; at?: string; model?: string } | null; edited: boolean }>;
  warnings: string[];
}

export interface RewardSpec {
  _id: string;
  text: string;
  name: string;
  version: number;
  archived: boolean;
  updated_at: string | null;
  compile: Record<string, SpecCompile>;
  summary: SpecSummary | null;
  parse_error: string | null;
}

/** MadScientist proposal statuses (rl_agent/madscientist/constants.py). */
export type ProposalStatus =
  | 'pending_judge' | 'pending_user' | 'deferred' | 'approved' | 'implementing' | 'pr_open' | 'training'
  | 'done' | 'failed' | 'rejected' | 'cancelled';
export type ProposalGroup = 'pending' | 'in_flight' | 'outcomes' | 'closed' | 'judging';
export type ProposalAction = 'approve' | 'reject' | 'defer' | 'approve_with_revisions';
export type JudgeVerdict = 'strong_accept' | 'accept' | 'weak_accept' | 'weak_reject' | 'reject';

export interface PrimaryCriterion {
  metric?: string; arm_a?: string; arm_b?: string; comparator?: string; threshold?: number; threshold_kind?: string;
}

export interface Proposal {
  id: string;
  title: string | null;
  status: ProposalStatus | null;
  created_at: string | null;
  updated_at: string | null;
  hypothesis: string;
  arms: string[];
  n_seeds_per_arm: number | null;
  num_iterations_per_seed: number | null;
  expected_wall_time_hours: number | null;
  primary: string | null;
  primary_parsed: PrimaryCriterion | null;
  verdict: JudgeVerdict | null;
  score: number | null;
  concerns: string[];
  judge_error: string | null;
  papers: number;
  cost_usd: number;
  jobs: { total: number; by_status: Record<string, number> };
  decision: { action: ProposalAction | null; at: string | null; note: string; source: string | null } | null;
  implementation: { branch: string | null; pr_url: string | null; failure: string | null } | null;
  results: {
    verdict: 'supported' | 'rejected' | 'inconclusive' | null;
    primary_delta: number | null;
    primary_criterion_met: boolean | null;
    n_jobs_succeeded: number | null;
    n_jobs_failed: number | null;
    notes: string | null;
    computed_at: string | null;
  } | null;
}

export interface ProposalArm {
  name: string;
  description?: string;
  experiment_design_id?: string | null;
  experiment_design_fields?: Record<string, unknown>;
  reward_design_id?: string | null;
  reward_design_fields?: Record<string, unknown>;
}

export interface SourcePaper {
  arxiv_id: string; title?: string; section_refs?: string[]; supporting_evidence?: string; url?: string | null;
}

export interface AuditEvent { at: string; by_agent: string; event: string; detail?: Record<string, unknown> | null }

export interface ArmStats { name: string; n_trials: number; mean: number | null; median: number | null; stddev: number | null; ci_low_95: number | null; ci_high_95: number | null }

/** The stored proposal document, minus its implementation log. */
export interface ProposalDoc {
  _id: string;
  motivation?: string;
  code_changes_summary?: string;
  source_papers?: SourcePaper[];
  experiment_arms?: ProposalArm[];
  success_criteria?: { primary?: string; primary_parsed?: PrimaryCriterion; secondary?: string[] };
  proposed_schema_extensions?: { name: string; type: string; default?: unknown; min_value?: number; max_value?: number; doc?: string; paper_ref?: string }[];
  judge_review?: {
    overall?: JudgeVerdict; scores?: Record<string, number>; axes_skipped?: string[]; normalized_score?: number;
    strengths?: string[]; concerns?: string[]; suggested_revisions?: string[]; pre_rubric_check_failures?: string[];
    judged_at?: string; rubric_version?: number; judge_model?: string; judge_token_count?: number; judge_cost_usd?: number;
    robustness_bump_applied?: boolean; judge_error?: string;
  } | null;
  cost?: Record<string, number>;
  audit_events?: AuditEvent[];
  git_sha_at_proposal?: string | null;
  git_branch_at_proposal?: string | null;
  notified_at?: string | null;
  implementation_log_lines: number;
}

export interface ProposalDetail {
  proposal: Proposal;
  doc: ProposalDoc;
  implementation_log: string[];
  runs: { arm: string | null; seed: number | null; run: Run; model: { id: string; avg_return: number | null; iteration: number | null; latest: boolean } | null }[];
  designs: { id: string; name: string | null; base_design_id: string | null; archived: boolean }[];
  per_arm: ArmStats[];
}

export interface LabSummary {
  counts: Record<string, number>;
  statuses: ProposalStatus[];
  groups: Record<ProposalGroup, number>;
  month: { start: string; proposals: number; spend_usd: number; by: Record<string, number>; budget_usd: number | null };
  agents: { agent: string; last_at: string | null; last_event: string | null; proposal_id: string; proposal_title: string | null; events: number }[];
}

export interface LabEvent {
  proposal_id: string;
  proposal_title: string | null;
  proposal_status: ProposalStatus | null;
  at: string | null;
  agent: string | null;
  event: string | null;
  detail: Record<string, unknown> | null;
}

export type WeaknessLayer = 'weakness' | 'crash' | 'speed' | 'risk' | 'visits';

export interface WeaknessCell {
  ix: number; iy: number; x: number; y: number; visits: number; crashes: number; goals: number; crash_rate: number; risk: number;
  speed: number | null; speed_vs_track_median: number | null; mean_score: number | null; score: number | null;
}

export interface Hotspot {
  rank: number; where: string; centroid: { x: number; y: number }; bounds: { x: [number, number]; y: [number, number] };
  cells: number; peak_score: number; peak_at: { x: number; y: number }; peak_cell: { ix: number; iy: number };
  visits: number; crashes: number; crash_rate: number; peak_cell_crash_rate: number; speed_vs_track_median: number | null;
  thin_evidence: boolean; member_cells: [number, number][];
}

export interface WeaknessQuery {
  run?: string; bins?: number; limit?: number; layer?: WeaknessLayer; w_crash?: number; w_slow?: number; w_risk?: number; min_visits?: number; threshold?: number;
}

export interface WeaknessMap {
  run_id: string; run: Run | null; episodes: number; bins: number; limit: number; layer: WeaknessLayer;
  weights: { crash: number; slow: number; risk: number }; min_visits: number; threshold: number;
  map: {
    axis_names: string[]; extent: { xmin: number; xmax: number; ymin: number; ymax: number }; nx: number; ny: number; cell_size: [number, number];
    track_median_speed: number | null; crashed_episodes: number; goal_episodes: number; cells: WeaknessCell[]; hotspots: Hotspot[];
  } | null;
}

export interface GateRow {
  gate: string; index: number; lap_fraction: number; where: string | null; position: { x: number; z: number } | null;
  crash_position: { x: number; z: number } | null; attempts: number; crashes: number; crash_rate: number; crash_rate_ci95: [number, number];
  smoothed_crash_rate: number; steps_to_clear_vs_median: number | null; reliable: boolean; last_seen: string | null;
}

export interface GateQuery { run?: string; limit?: number; min_attempts?: number; weak_share?: number; lead?: number; top_k?: number }

export interface GateStats {
  run_id: string; run: Run | null; limit: number; gate_count: number; attempts?: number; crashes?: number; track_crash_rate?: number;
  gates_never_attempted?: number[]; gates: GateRow[]; hardest_gates: (GateRow & { rank: number })[];
  hardest_sections: { gates: string; first: number; last: number; lap_fraction: [number, number]; where: string | null; attempts: number; crashes: number; crash_rate: number; crash_rate_ci95: [number, number] }[];
  start: {
    weak_share: number; lead_gates: number;
    targets: { hard_gate: string; hard_index: number; start_at: string; start_index: number; start_lap_fraction: number; where: string | null; hard_gate_crash_rate: number; smoothed_crash_rate: number; attempts: number; weak_share_of_this_target: number }[];
    distribution: { gate: string; index: number; lap_fraction: number; probability: number }[];
    uniform_probability_other_gates: number;
    proposed_experiment_fields: Record<string, unknown>;
  } | null;
}

export interface RunQuery {
  robot?: string;
  status?: string[];
  type?: string[];
  q?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any = {}) {
    super(message);
  }
}

type Params = Record<string, string | number | undefined>;

async function request<T>(method: string, path: string, params?: Params, body?: unknown): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, body === undefined ? { method } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, out.error || res.statusText, out);
  return out as T;
}

const get = <T,>(path: string, params?: Params) => request<T>('GET', `/api/v1${path}`, params);
const post = <T,>(path: string, body: unknown, params?: Params) => request<T>('POST', `/api/v1${path}`, params, body);
/**
 * Classic dashboard endpoints for writes /api/v1 leaves to them: those that
 * validate through Python (curricula, experiment designs, reward specs) or lint.
 * Some answer 200 with {ok: false}; that's an error too.
 */
async function classic<T>(method: 'GET' | 'POST', path: string, body?: unknown, params?: Params): Promise<T> {
  const out = await request<any>(method, path, params, body);
  if (out && out.ok === false && out.error) throw new ApiError(400, out.error, out);
  return out as T;
}
const classicPost = <T,>(path: string, body: unknown) => classic<T>('POST', path, body);

export const api = {
  robots: () => get<{ robots: Robot[] }>('/robots').then((r) => r.robots),
  runs: (q: RunQuery) =>
    get<RunPage>('/runs', {
      robot: q.robot,
      status: q.status?.join(','),
      type: q.type?.join(','),
      q: q.q,
      sort: q.sort,
      limit: q.limit,
      offset: q.offset,
    }),
  run: (id: string) => get<RunDetail>(`/runs/${id}`),
  cloneSpec: (id: string) => get<{ spec: LaunchSpec }>(`/runs/${id}/clone`).then((r) => r.spec),
  launchOptions: (robot: string) => get<LaunchOptions>('/launch/options', { robot }),
  /** Validates without inserting; rejects with ApiError whose body is a LaunchProblem. */
  checkLaunch: (spec: LaunchSpec) =>
    post<{ ok: true; doc: Record<string, unknown>; warnings: string[] }>('/runs', spec, { dry_run: 1 }),
  launch: (spec: LaunchSpec) => post<{ ok: true; run: Run; warnings: string[] }>('/runs', spec),
  act: (id: string, action: RunAction) => post<{ run: Run }>(`/runs/${id}/actions`, { action }).then((r) => r.run),
  actMany: (ids: string[], action: RunAction) =>
    post<{ results: BulkResult[] }>('/runs/actions', { ids, action }).then((r) => r.results),
  remove: (id: string) => request<{ ok: true }>('DELETE', `/api/v1/runs/${id}`),
  removeMany: (ids: string[]) => post<{ results: BulkResult[] }>('/runs/delete', { ids }).then((r) => r.results),
  queue: () => get<QueueState>('/queue'),
  setQueuePaused: (paused: boolean) => post<QueueState>('/queue', { paused }),
  curriculumRunAction: (id: string, action: CurriculumRunAction, deleteJobs = false) =>
    post<{ ok: true; status?: string; jobs_deleted?: number }>(`/curriculum-runs/${id}/actions`, { action, delete_jobs: deleteJobs }),
  curriculumCaps: () => get<{ robots: Record<string, CurriculumCaps>; carry_items: string[]; ops: string[] }>('/curricula/capabilities'),
  curricula: (robot: string, archived: boolean) =>
    get<{ items: CurriculumSummary[] }>('/curricula', { robot, archived: archived ? 1 : undefined }).then((r) => r.items),
  curriculum: (id: string) =>
    get<{ curriculum: CurriculumSummary & { authored: Stage[]; resolved: Stage[] }; runs: CurriculumRunSummary[] }>(`/curricula/${id}`),
  curriculumRuns: (q: { robot?: string; curriculum?: string; active?: boolean; limit?: number }) =>
    get<{ items: CurriculumRunSummary[]; total: number }>('/curriculum-runs', {
      robot: q.robot, curriculum: q.curriculum, active: q.active ? 1 : undefined, limit: q.limit,
    }),
  curriculumRun: (id: string) => get<CurriculumRunDetail>(`/curriculum-runs/${id}`),
  /** Rejects with ApiError whose body.problems lists what's wrong ("stage 2 (Name): ..."). */
  checkCurriculum: (doc: { robot: string; name: string; description?: string; stages: Stage[] }) =>
    classicPost<CurriculumCheck>('/validate_curriculum', doc),
  createCurriculum: (doc: { robot: string; name: string; description?: string; stages: Stage[] }) =>
    classicPost<{ insertedId: string }>('/create_curriculum', { ...doc, author: 'dashboard' }).then((r) => String(r.insertedId)),
  updateCurriculum: (id: string, patch: { name?: string; description?: string; stages?: Stage[] }) =>
    classicPost<{ ok: unknown }>('/update_curriculum', { _id: id, ...patch }),
  setCurriculumArchived: (id: string, archived: boolean) => classicPost('/set_curriculum_archived', { _id: id, archived }),
  startCurriculumRun: (id: string, opts: { start_stage?: number; priority?: 'front' | 'normal' }) =>
    classicPost<{ insertedId: string }>('/start_curriculum_run', { curriculum_id: id, ...opts }).then((r) => String(r.insertedId)),

  designs: <K extends DesignKind>(kind: K, robot: string, archived: boolean) =>
    get<{ items: DesignRows[K][] }>(`/designs/${kind}`, { robot, archived: archived ? 1 : undefined }).then((r) => r.items),
  design: <K extends DesignKind>(kind: K, id: string) =>
    get<{ item: DesignRows[K]; usage: DesignUsage }>(`/designs/${kind}/${encodeURIComponent(id)}`),
  designVersion: (kind: DesignKind, id: string, version: number) =>
    get<{ version: number; snapshot: unknown; from: { kind: 'run' | 'model'; id: string; at: string | null } }>(
      `/designs/${kind}/${encodeURIComponent(id)}/versions/${version}`),
  lintRewardDesign: (code: string, robot: string, taskId?: string | null) =>
    request<LintResult>('POST', '/lint_reward_design', undefined, { code, robot, task_id: taskId ?? null }),
  rewardTermCatalog: (robot: string) =>
    classic<{ functions: TermFunction[] }>('GET', '/get_reward_term_catalog', undefined, { robot }).then((r) => r.functions ?? []),
  gymDefaults: (gymId: string) =>
    get<{ item: GymRow }>(`/designs/gyms/${encodeURIComponent(gymId)}`).then((r) => r.item.reward_defaults ?? []),
  addRewardDesign: (doc: { name: string; description: string; code: string; robot: string }) =>
    classicPost<{ insertedId: string }>('/add_reward_design', doc).then((r) => String(r.insertedId)),
  updateRewardDesign: (id: string, patch: { name?: string; description?: string; code?: string; archived?: boolean }) =>
    classicPost('/update_reward_design', { _id: id, ...patch }),
  archiveRewardDesign: (id: string) => classicPost('/archive_reward_design', { _id: id, archived: true }),
  experimentSchema: (robot: string) =>
    classic<{ fields: ExperimentField[]; source: 'trainer' | 'fallback' | 'missing' }>('GET', '/get_experiment_design_schema', undefined, { robot }),
  addExperimentDesign: (doc: Record<string, unknown>) =>
    classicPost<{ insertedId: string }>('/add_experiment_design', doc).then((r) => String(r.insertedId)),
  updateExperimentDesign: (id: string, patch: Record<string, unknown>) => classicPost('/update_experiment_design', { _id: id, ...patch }),
  archiveExperimentDesign: (id: string) => classicPost('/archive_experiment_design', { _id: id, archived: true }),
  addGym: (doc: { name: string; file_path: string; description: string }) =>
    classicPost<{ insertedId: string }>('/add_gym', doc).then((r) => String(r.insertedId)),
  updateGym: (id: string, patch: Record<string, unknown>) => classicPost('/update_gym', { _id: id, ...patch }),
  archiveGym: (id: string) => classicPost('/archive_gym', { _id: id }),
  addDemo: (doc: { num_demos: number; course: string; description: string; tfrecords_path: string }) =>
    classicPost<{ insertedId: string }>('/add_demo', doc).then((r) => String(r.insertedId)),
  updateDemo: (id: string, patch: Record<string, unknown>) => classicPost('/update_demo', { _id: id, ...patch }),
  setDemoArchived: (id: string, archived: boolean) => classicPost('/archive_demo', { _id: id, archived }),
  rewardSpecs: () => classic<{ specs: RewardSpec[]; settings: { strict_generated?: boolean } }>('GET', '/get_design_specs'),
  rewardSpecTemplate: () => classic<{ text: string }>('GET', '/design_spec_template').then((r) => r.text),
  saveRewardSpec: (id: string | null, text: string) =>
    classicPost<{ _id: string; summary: SpecSummary; hand_edited: string[] }>('/save_design_spec', id ? { _id: id, text } : { text }),
  compileRewardSpec: (id: string, robots?: string[]) => classicPost<{ queued: string[] }>('/compile_design_spec', { _id: id, robots }),
  acceptRewardSpec: (id: string, robot: string) => classicPost('/accept_design_spec_compile', { _id: id, robot }),
  discardRewardSpec: (id: string, robot: string) => classicPost('/discard_design_spec_compile', { _id: id, robot }),
  repinRewardSpec: (id: string, robot: string) => classicPost('/repin_design_spec', { _id: id, robot }),
  setRewardSpecArchived: (id: string, archived: boolean) => classicPost('/archive_design_spec', { _id: id, archived }),
  setRewardSpecStrict: (strict: boolean) => classicPost('/design_spec_settings', { strict_generated: strict }),
  tags: (id: string) => get<{ tags: TagInfo[]; files: number }>(`/runs/${id}/metrics/tags`),
  metrics: (id: string, tags: string[], maxPoints = 1500, walls = false) =>
    get<{ series: Record<string, Series> }>(`/runs/${id}/metrics`, {
      tags: tags.join(','), max_points: maxPoints, walls: walls ? 1 : undefined,
    }).then((r) => r.series),
  compare: (runs: string[], models: string[]) =>
    get<CompareData>('/compare', { runs: runs.join(','), models: models.join(',') }),
  media: (id: string) => get<RunMedia>(`/runs/${id}/media`),
  logs: (id: string, offset?: number) => get<LogChunk>(`/runs/${id}/logs`, { offset }),
  models: (q: ModelQuery) =>
    get<ModelPage>('/models', {
      robot: q.robot, q: q.q, course: q.course, run: q.run, sort: q.sort, limit: q.limit, offset: q.offset,
      evaluated: q.evaluated ? 1 : undefined, promoted: q.promoted ? 1 : undefined,
    }),
  model: (id: string) => get<ModelDetail>(`/models/${id}`),
  leaderboard: (q: LeaderboardQuery) => get<Leaderboard>('/leaderboard', { ...q }),
  setModelNotes: (id: string, notes: string) =>
    request<{ model: ModelSummary }>('PATCH', `/api/v1/models/${id}`, undefined, { notes }).then((r) => r.model),
  promoteModel: (id: string, promoted: boolean) =>
    post<{ model: ModelSummary; demoted: string[] }>(`/models/${id}/promote`, { promoted }),
  removeModels: (ids: string[]) =>
    post<{ results: (BulkResult & { files_deleted?: boolean; scores_deleted?: number })[] }>('/models/delete', { ids }).then((r) => r.results),
};

/** Query keys, so live updates can invalidate exactly what changed. */
export const labApi = {
  summary: () => get<LabSummary>('/lab/summary'),
  proposals: (q: { group?: ProposalGroup; status?: string; q?: string; limit?: number; offset?: number }) =>
    get<{ items: Proposal[]; total: number; offset: number; limit: number }>('/lab/proposals', { ...q }),
  proposal: (id: string) => get<ProposalDetail>(`/lab/proposals/${id}`),
  activity: (q: { proposal?: string; agent?: string; limit?: number; offset?: number }) =>
    get<{ items: LabEvent[]; total: number; offset: number; limit: number }>('/lab/activity', { ...q }),
  decide: (id: string, action: ProposalAction, note: string) =>
    post<{ ok: true; new_status: ProposalStatus }>(`/lab/proposals/${id}/decision`, { action, note }),
  edit: (id: string, patch: Record<string, unknown>) =>
    request<{ ok: true; updated_fields: string[] }>('PATCH', `/api/v1/lab/proposals/${id}`, undefined, { patch }),
};

export interface SystemStatus {
  dashboard: { started_at: string; node: string; pid: number };
  mongo: { ok: true; ping_ms: number; data_bytes: number | null; storage_bytes: number | null; index_bytes: number | null; collections: { name: string; count: number | null }[] }
    | { ok: false; error: string };
  queue: { paused: boolean; queued: number; running: number };
  workers: { robot: string; display_name: string; registered: boolean; online: boolean; last_seen: string | null; host: string | null; running: Run[] }[];
  volumes: { path: string; label: string; about: string; total_bytes?: number; free_bytes?: number; used_bytes?: number }[];
  logs: { id: string; label: string; path: string; robot: string; about: string; exists: boolean; size: number; modified_at: string | null }[];
  unity: { desired: { index: string; gym_id?: string; gym_name?: string; file_path?: string; headless?: boolean; set_at: string | null }[] };
}

export interface Releases {
  repo: string; ok: boolean; error?: string; fetched_at: string;
  items: { tag: string; name: string; url: string; draft: boolean; prerelease: boolean; published_at: string | null; assets: { name: string; size: number; downloads: number; url: string; updated_at: string }[] }[];
}

export const systemApi = {
  status: () => get<SystemStatus>('/system'),
  releases: (refresh?: boolean) => get<Releases>('/system/releases', { refresh: refresh ? 1 : undefined }),
  log: (service: string, offset?: number) => get<LogChunk>(`/system/logs/${service}`, { offset }),
};

export const insightsApi = {
  weakness: (q: WeaknessQuery) => get<WeaknessMap>('/insights/weakness', { ...q }),
  gates: (q: GateQuery) => get<GateStats>('/insights/gates', { ...q }),
};

export const keys = {
  system: ['system'] as const,
  releases: ['system', 'releases'] as const,
  weakness: (q: object) => ['insights', 'weakness', q] as const,
  gates: (q: object) => ['insights', 'gates', q] as const,
  lab: ['lab'] as const,
  labSummary: ['lab', 'summary'] as const,
  labProposals: (q: object) => ['lab', 'proposals', q] as const,
  labProposal: (id: string) => ['lab', 'proposal', id] as const,
  labActivity: (q: object) => ['lab', 'activity', q] as const,
  robots: ['robots'] as const,
  runs: (q: RunQuery) => ['runs', q] as const,
  allRuns: ['runs'] as const,
  run: (id: string) => ['run', id] as const,
  tags: (id: string) => ['metrics', id, 'tags'] as const,
  metrics: (id: string, tags: string[], walls = false) => ['metrics', id, 'series', tags, walls] as const,
  compare: (runs: string[], models: string[]) => ['compare', runs, models] as const,
  allMetrics: (id: string) => ['metrics', id] as const,
  media: (id: string) => ['media', id] as const,
  queue: ['queue'] as const,
  launchOptions: (robot: string) => ['launch-options', robot] as const,
  models: (q: ModelQuery) => ['models', q] as const,
  allModels: ['models'] as const,
  model: (id: string) => ['model', id] as const,
  allModel: ['model'] as const,
  leaderboard: (q: LeaderboardQuery) => ['leaderboard', q] as const,
  allLeaderboard: ['leaderboard'] as const,
  curriculumCaps: ['curricula', 'caps'] as const,
  curricula: (robot: string, archived: boolean) => ['curricula', 'list', robot, archived] as const,
  curriculum: (id: string) => ['curricula', 'one', id] as const,
  curriculumRuns: (q: object) => ['curricula', 'runs', q] as const,
  curriculumRun: (id: string) => ['curricula', 'run', id] as const,
  allCurricula: ['curricula'] as const,
  designs: (kind: DesignKind, robot: string, archived: boolean) => ['designs', kind, 'list', robot, archived] as const,
  design: (kind: DesignKind, id: string) => ['designs', kind, 'one', id] as const,
  designKind: (kind: DesignKind) => ['designs', kind] as const,
  experimentSchema: (robot: string) => ['experiment-schema', robot] as const,
  termCatalog: (robot: string) => ['term-catalog', robot] as const,
  rewardSpecs: ['reward-specs'] as const,
};

export const ACTIVE_STATUSES: RunStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'PAUSE_REQUESTED', 'PAUSED'];

export function isLive(run: Pick<Run, 'status'> | undefined): boolean {
  return run?.status === 'IN_PROGRESS' || run?.status === 'PAUSE_REQUESTED';
}
