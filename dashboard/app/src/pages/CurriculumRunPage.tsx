import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeft, Ban, Check, CircleDashed, CornerDownRight, Film, FlaskConical, Loader2, RotateCcw, SkipForward, Trash2, X,
} from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { conditionText, CurriculumStatusBadge, StageLadder, useCurriculumRunAction, GateChecks } from '../components/curricula/CurriculumBits';
import { Modal } from '../components/Modal';
import { RobotBadge, StatusBadge } from '../components/RunBits';
import { Badge, Button, Card, Empty, Progress, Spinner, type Tone } from '../components/ui';
import { api, keys, type CurriculumResult, type CurriculumRunDetail, type CurriculumRunJob, type Stage } from '../lib/api';
import { cn, formatDuration, formatNumber, shortId, timeAgo } from '../lib/utils';

type StageState = 'passed' | 'skipped' | 'running' | 'missed' | 'failed' | 'cancelled' | 'pending' | 'not_run';

const STATE: Record<StageState, { label: string; tone: Tone; icon: ComponentType<{ className?: string }>; ring: string }> = {
  passed: { label: 'Passed', tone: 'green', icon: Check, ring: 'bg-emerald-500 text-white' },
  skipped: { label: 'Gate skipped', tone: 'amber', icon: SkipForward, ring: 'bg-amber-500 text-white' },
  running: { label: 'In progress', tone: 'blue', icon: Loader2, ring: 'bg-primary text-primary-foreground' },
  missed: { label: 'Missed gate', tone: 'red', icon: X, ring: 'bg-rose-500 text-white' },
  failed: { label: 'Failed', tone: 'red', icon: X, ring: 'bg-rose-500 text-white' },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban, ring: 'bg-muted-foreground text-white' },
  pending: { label: 'Not started', tone: 'neutral', icon: CircleDashed, ring: 'bg-muted text-muted-foreground' },
  not_run: { label: 'Not run (started later)', tone: 'neutral', icon: CircleDashed, ring: 'bg-muted text-muted-foreground' },
};

function stageState(run: CurriculumRunDetail['run'], i: number): StageState {
  const results = run.results.filter((r) => r.stage_index === i);
  if (results.some((r) => r.passed)) return 'passed';
  if (results.some((r) => r.skipped)) return 'skipped';
  if (i > run.stage_index) return 'pending';
  if (i < run.stage_index) return 'not_run';
  if (run.status === 'RUNNING') return 'running';
  if (run.status === 'FAILED_GATE') return 'missed';
  if (run.status === 'FAILED') return 'failed';
  return run.status === 'PASSED' ? 'passed' : 'cancelled';
}

interface Attempt {
  key: string;
  attempt: number;
  generation: number;
  train: CurriculumRunJob | null;
  eval: CurriculumRunJob | null;
  result: CurriculumResult | null;
}

/** A stage's tries, oldest first: one per attempt and per manual rerun (generation). */
function attemptsOf(detail: CurriculumRunDetail, i: number): Attempt[] {
  const groups = new Map<string, Attempt>();
  for (const j of detail.jobs.filter((x) => x.stage_index === i)) {
    const key = `${j.generation}:${j.attempt}`;
    const a = groups.get(key) ?? { key, attempt: j.attempt, generation: j.generation, train: null, eval: null, result: null };
    if (j.role === 'eval') a.eval = j;
    else a.train = j;
    groups.set(key, a);
  }
  const out = [...groups.values()];
  for (const r of detail.run.results.filter((x) => x.stage_index === i)) {
    const a = out.find((x) => x.train?.id === r.train_job_id) ?? out.find((x) => !x.result && x.attempt === r.attempt);
    if (a) a.result = r;
    else out.push({ key: `r:${r.attempt}:${r.at}`, attempt: r.attempt, generation: 0, train: null, eval: null, result: r });
  }
  return out;
}

function ClipButton({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: keys.media(jobId), queryFn: () => api.media(jobId), enabled: open });
  const src = data?.progress_video ?? data?.clips[data.clips.length - 1]?.url ?? null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} title="Rollout clip of the stage's checkpoint"><Film className="h-3.5 w-3.5" /> Clip</Button>
      {open && (
        <div className="basis-full">
          {isLoading ? <Spinner /> : src ? (
            <video src={src} controls autoPlay muted loop className="mt-1 max-h-72 rounded-lg border bg-black" />
          ) : <p className="text-xs text-muted-foreground">No clip recorded for this job.</p>}
        </div>
      )}
    </>
  );
}

function JobLine({ label, job, icon: Icon }: { label: string; job: CurriculumRunJob; icon: ComponentType<{ className?: string }> }) {
  const live = job.status === 'IN_PROGRESS' || job.status === 'PAUSE_REQUESTED';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="w-12 text-xs text-muted-foreground">{label}</span>
      <StatusBadge status={job.status} />
      <Link to="/runs/$runId" params={{ runId: job.id }} className="font-mono text-xs hover:underline" title="Open the run">{shortId(job.id)}</Link>
      {live && (
        <span className="flex items-center gap-2">
          <Progress value={job.percent_complete} className="w-32" />
          <span className="text-xs tabular-nums text-muted-foreground">{formatNumber(job.percent_complete ?? 0, 0)}%</span>
        </span>
      )}
      {job.iteration != null && job.budget != null && (
        <span className="text-xs tabular-nums text-muted-foreground">{formatNumber(job.iteration)} / {formatNumber(job.budget)}</span>
      )}
      {job.mean_reward != null && <span className="text-xs text-muted-foreground">reward {formatNumber(job.mean_reward)}</span>}
      {job.error && <span className="min-w-0 truncate text-xs text-rose-600 dark:text-rose-400" title={job.error}>{job.error}</span>}
      {label === 'Train' && job.status === 'DONE' && <ClipButton jobId={job.id} />}
    </div>
  );
}

function AttemptBlock({ a, gated }: { a: Attempt; gated: boolean }) {
  const r = a.result;
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background/60 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">Attempt {a.attempt + 1}</span>
        {a.generation > 0 && <span className="text-muted-foreground" title="Requeued by a manual retry of the run">· rerun {a.generation}</span>}
        {r && (r.skipped ? <Badge tone="amber">gate skipped</Badge> : r.passed ? <Badge tone="green">passed</Badge> : <Badge tone="red">missed gate</Badge>)}
        {r?.at && <span className="ml-auto text-muted-foreground">{timeAgo(r.at)}</span>}
      </div>
      {a.train && <JobLine label="Train" job={a.train} icon={CornerDownRight} />}
      {a.eval && <JobLine label="Gate" job={a.eval} icon={FlaskConical} />}
      {r && r.gate.length > 0 && <GateChecks checks={r.gate} />}
      {!r && gated && a.train?.status === 'DONE' && !a.eval && <p className="text-xs text-muted-foreground">Gate eval being queued…</p>}
      {r?.checkpoint && (
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={r.checkpoint}>checkpoint {r.checkpoint}</p>
      )}
    </div>
  );
}

function StageBlock({ detail, stage, i, last }: { detail: CurriculumRunDetail; stage: Stage; i: number; last: boolean }) {
  const state = stageState(detail.run, i);
  const s = STATE[state];
  const attempts = attemptsOf(detail, i);
  const conds = stage.gate?.conditions ?? [];
  const settings = Object.entries(stage.settings ?? {});
  const init = stage.init ?? (i === 0 ? 'none' : 'previous');
  return (
    <div className="relative flex gap-4">
      <div className="flex flex-col items-center">
        <span className={cn('z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full', s.ring)}>
          <s.icon className={cn('h-4 w-4', state === 'running' && 'animate-spin')} />
        </span>
        {!last && <span className="w-px flex-1 bg-border" />}
      </div>
      <div className="min-w-0 flex-1 pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{i + 1}. {stage.name ?? stage.id}</h3>
          <Badge tone={s.tone}>{s.label}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {stage.gym} · {formatNumber(stage.budget ?? null)} per attempt
          {' · '}{init === 'none' ? 'from scratch' : init === 'previous' ? 'from the previous stage' : `from model ${shortId(init.slice(6))}`}
          {stage.carry?.length ? ` carrying ${stage.carry.join(', ')}` : ''}
          {stage.on_fail?.retries ? ` · up to ${stage.on_fail.retries} retr${stage.on_fail.retries === 1 ? 'y' : 'ies'}` : ''}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {conds.length ? conds.map((c, ci) => <Badge key={ci} className="font-mono text-[11px]">gate {conditionText(c)}</Badge>) : <Badge>no gate</Badge>}
          {settings.map(([k, v]) => <Badge key={k} tone="violet" className="font-mono text-[11px]">{k}={v}</Badge>)}
        </div>
        {attempts.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {attempts.map((a) => <AttemptBlock key={a.key} a={a} gated={conds.length > 0} />)}
          </div>
        )}
      </div>
    </div>
  );
}

export function CurriculumRunPage() {
  const { runId } = useParams({ strict: false }) as { runId: string };
  const navigate = useNavigate();
  const act = useCurriculumRunAction();
  const [deleting, setDeleting] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: keys.curriculumRun(runId),
    queryFn: () => api.curriculumRun(runId),
    refetchInterval: (q) => (['RUNNING', 'CANCEL_REQUESTED'].includes(q.state.data?.run.status ?? '') ? 5000 : false),
  });
  if (isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (error || !data) return <div className="p-8"><Empty title="Couldn't load the curriculum run">{(error as Error)?.message}</Empty></div>;
  const run = data.run;
  const started = run.created_at ? new Date(run.created_at).getTime() : null;
  const took = started ? formatDuration((run.ended_at ? new Date(run.ended_at).getTime() : Date.now()) - started) : '—';
  const newer = data.curriculum && run.curriculum_version != null && data.curriculum.version > run.curriculum_version;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-8">
      <div>
        <Link to="/curricula" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Curricula
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{run.curriculum_name ?? 'Curriculum run'}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <CurriculumStatusBadge status={run.status} />
              <RobotBadge robot={run.robot} />
              {data.curriculum ? (
                <Link to="/curricula/$curriculumId" params={{ curriculumId: data.curriculum.id }} className="hover:underline">
                  curriculum v{run.curriculum_version ?? '?'}{newer ? ` (now v${data.curriculum.version})` : ''}
                </Link>
              ) : <span>curriculum deleted</span>}
              <span>· started {timeAgo(run.created_at)} · {took}</span>
              {run.options.priority === 'normal' && <span>· normal queue priority</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {run.actions.includes('cancel') && <Button size="sm" onClick={() => act(run, 'cancel')}><Ban className="h-3.5 w-3.5" /> Cancel</Button>}
            {run.actions.includes('retry') && <Button size="sm" onClick={() => act(run, 'retry')}><RotateCcw className="h-3.5 w-3.5" /> Retry stage</Button>}
            {run.status === 'FAILED_GATE' && (
              <Button size="sm" disabled={!run.actions.includes('skip')} onClick={() => act(run, 'skip')} title={run.skip_reason ?? 'Move on from the missed attempt\u2019s checkpoint'}>
                <SkipForward className="h-3.5 w-3.5" /> Skip gate
              </Button>
            )}
            {run.actions.includes('delete') && (
              <Button size="sm" variant="ghost" className="text-rose-600 dark:text-rose-400" onClick={() => setDeleting(true)}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
            )}
          </div>
        </div>
      </div>

      <Card className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-center justify-between text-sm">
          <span>
            {run.status === 'PASSED' ? 'Every stage passed' : <>Stage <b>{Math.min(run.stage_index + 1, run.stage_count)}</b> of {run.stage_count}: {run.stage_name}{run.attempt ? `, attempt ${run.attempt + 1}` : ''}</>}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">{formatNumber(run.progress * 100, 0)}%</span>
        </div>
        <StageLadder run={run} />
        {run.error && <p className="text-sm text-rose-600 dark:text-rose-400">{run.error}</p>}
      </Card>

      <div className="pt-2">
        {run.stages.map((s, i) => <StageBlock key={i} detail={data} stage={s} i={i} last={i === run.stages.length - 1} />)}
      </div>

      {deleting && (
        <DeleteRunDialog
          jobs={data.jobs.length}
          onClose={() => setDeleting(false)}
          onDelete={async (withJobs) => {
            if (await act(run, 'delete', withJobs)) navigate({ to: '/curricula' });
            else setDeleting(false);
          }}
        />
      )}
    </div>
  );
}

function DeleteRunDialog({ jobs, onClose, onDelete }: { jobs: number; onClose: () => void; onDelete: (withJobs: boolean) => Promise<void> }) {
  const [withJobs, setWithJobs] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Delete this curriculum run?"
      description="Its record and gate results go; the curriculum itself stays."
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Go back</Button>
        <Button variant="primary" className="bg-rose-600 text-white" disabled={busy} onClick={async () => { setBusy(true); await onDelete(withJobs); }}>
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />} Delete
        </Button>
      </>}
    >
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={withJobs} onChange={(e) => setWithJobs(e.target.checked)} />
        <span>Also delete its {jobs} stage run{jobs === 1 ? '' : 's'} (train and gate-eval jobs). Their checkpoints and model records are kept.</span>
      </label>
    </Modal>
  );
}
