"""Make OpenBeni's jumps visible outside its trainer.

Beni-Jump-Flat only switches jumps on inside ``BeniVelocityOnPolicyRunner``
(after warm-up and its recovery gate), and play configs never request one on
their own. So gate evals run OpenBeni's own jump trials, and clips request
jumps the way the interactive viewer's "Request one jump" button does, but
only from checkpoints trained with jumps on: before that the policy has only
ever seen a zero jump command, and a request would just be ignored.
"""
import torch

FIRST_REQUEST_S = 2.0
BETWEEN_JUMPS_S = 1.0
OUTCOME_LABEL_S = 1.0
CLIP_SECONDS = 10.0
UNTRAINED_LABEL = "jumps not trained yet"
SUMMARY_KEYS = {
    "takeoff_rate": "jump_takeoff_rate",
    "landing_rate": "jump_landing_rate",
    "strict_success_rate": "jump_success_rate",
    "heading_directional_landing_rate": "jump_heading_landing_rate",
    "median_clearance_m": "jump_median_clearance_m",
}


def jump_term(raw_env):
    if "jump" not in raw_env.command_manager.active_terms:
        return None
    return raw_env.command_manager.get_term("jump")


def jumps_trained(checkpoint):
    """Whether OpenBeni's trainer had jumps on when it saved ``checkpoint``; None when it didn't record it."""
    state = torch.load(checkpoint, map_location="cpu", weights_only=False)
    training = (state.get("infos") or {}).get("beni_training")
    if not isinstance(training, dict):
        return None
    return training.get("jump") is not None


def jump_metrics(env_cfg, runner, device):
    """OpenBeni's jump checkpoint trials (8 speeds x 8 trials, one jump each)."""
    if "jump" not in (env_cfg.commands or {}):
        return {}
    from beni_rl.jump_evaluation import evaluate_jump_checkpoint

    trials_cfg = env_cfg.commands["jump"].best_checkpoint
    result = evaluate_jump_checkpoint(env_cfg, runner.alg.actor, trials_cfg, device)
    recovery = {k: v for k, v in (result.get("landing_recovery") or {}).items() if k != "trials"}
    return {
        "jump_trials": len(result["trials"]),
        **{ours: result[theirs] for theirs, ours in SUMMARY_KEYS.items()},
        "jump_landing_recovery": recovery,
    }


class JumpDirector:
    """Requests jumps in a one-env clip and labels them.

    OpenBeni keeps tracking a jump for several seconds after touchdown, so the
    label follows the motion instead: JUMP until touchdown, then the outcome.
    The SHOVE label is hidden while JUMP shows, so it isn't read as the cause.
    """

    min_seconds = CLIP_SECONDS

    def __init__(self, raw_env, fps):
        self.command = jump_term(raw_env)
        self.fps = fps
        self.next_request = round(FIRST_REQUEST_S * fps)
        self.outcome, self.outcome_until = None, -1
        self.jumping = self.touched_down = False
        self.hides_pushes = False

    def step(self, frame):
        tag = self._step(frame)
        self.hides_pushes = tag == "JUMP"
        return tag

    def _step(self, frame):
        if self.command is None:
            return None
        s = self.command.state
        if bool(s["tracking"][0]):
            if not self.jumping:
                self.jumping, self.touched_down = True, False
            if bool(s["land_s"][0] < 0):
                return "JUMP"
            if not self.touched_down:
                self.touched_down = True
                failed = bool(s["body_hit"][0]) or bool(s["failed"][0])
                self._show("JUMP FAILED" if failed else "LANDED", frame)
            return self._shown(frame)
        if self.jumping:
            self.jumping = False
            if not self.touched_down:
                self._show("JUMP FAILED", frame)
            self.next_request = frame + round(BETWEEN_JUMPS_S * self.fps)
        if shown := self._shown(frame):
            return shown
        if frame >= self.next_request:
            # Rejected while the robot isn't steady yet; try again next frame.
            if int(self.command.request(self.command._env_ids[:1])[0]) == 0:
                return "JUMP"
        return None

    def _show(self, outcome, frame):
        self.outcome, self.outcome_until = outcome, frame + round(OUTCOME_LABEL_S * self.fps)

    def _shown(self, frame):
        return self.outcome if frame <= self.outcome_until else None


class UntrainedJumps:
    """Labels a clip whose checkpoint never trained with jumps, and requests none."""

    min_seconds = 0
    hides_pushes = False

    def step(self, frame):
        return UNTRAINED_LABEL


def director(raw_env, checkpoint=None):
    """Clip director factory; ``None`` for tasks without a jump command."""
    if jump_term(raw_env) is None:
        return None
    if checkpoint is not None and jumps_trained(checkpoint) is False:
        return UntrainedJumps()
    return JumpDirector(raw_env, round(1.0 / raw_env.step_dt))
