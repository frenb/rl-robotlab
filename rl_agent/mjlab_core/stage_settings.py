"""Curriculum stage settings for mjlab tasks, applied the same way in training,
gate evaluation and clip rendering.

The worker passes a job's ``stage_settings`` to each subprocess as JSON in
``MJLAB_STAGE_SETTINGS``. Settings a task can't honour raise, so a stage never
silently trains without the disturbance it asked for.
"""
import json
import os

ENV = "MJLAB_STAGE_SETTINGS"
PUSH_EVENT = "push_robot"
PUSH_KEYS = ("push_force_max", "push_torque_max", "push_duration_s",
             "push_interval_min_s", "push_interval_max_s")
JUMP_COMMAND = "jump"
# Stage setting -> (field of the jump command's recovery_gate, type).
JUMP_KEYS = {
    "jump_start_by_update": ("force_jump_after_updates", int),
    "jump_recovery_pass_rate": ("success_rate", float),
    "jump_recovery_passes": ("consecutive_passes", int),
}


def env_for(job):
    settings = (job or {}).get("stage_settings") or {}
    return {ENV: json.dumps(settings, sort_keys=True)} if settings else {}


def from_env():
    raw = os.environ.get(ENV)
    return json.loads(raw) if raw else {}


def wants_push(settings):
    return any(key in settings for key in PUSH_KEYS)


def push_active(raw_env, env_id=0):
    """Whether the push event is applying a force to ``env_id`` right now."""
    try:
        term = raw_env.event_manager.get_term_cfg(PUSH_EVENT).func
        return bool(term._active[env_id])
    except Exception:  # noqa: BLE001 - no push event, or mjlab changed its internals
        return False


def apply(env_cfg, settings, train_cfg=None):
    """Apply ``settings`` to ``env_cfg``; returns the names it changed.

    Play configs drop the push event, so pass the task's training config as
    ``train_cfg`` to bring it back for clips.
    """
    settings = settings or {}
    return _apply_push(env_cfg, settings, train_cfg) + _apply_jump(env_cfg, settings)


def _apply_jump(env_cfg, settings):
    """Point the jump command's recovery gate (when OpenBeni's trainer starts jumps) at the stage's values."""
    wanted = [key for key in JUMP_KEYS if key in settings]
    if not wanted:
        return []
    command = (getattr(env_cfg, "commands", None) or {}).get(JUMP_COMMAND)
    gate = getattr(command, "recovery_gate", None)
    if gate is None:
        raise ValueError(f"this task has no {JUMP_COMMAND!r} command with a recovery gate for {wanted}")
    for key in wanted:
        field, cast = JUMP_KEYS[key]
        setattr(gate, field, cast(settings[key]))
    return wanted


def _apply_push(env_cfg, settings, train_cfg):
    if not wants_push(settings):
        return []
    events = env_cfg.events if env_cfg.events is not None else {}
    term = events.get(PUSH_EVENT)
    if term is None and train_cfg is not None:
        term = (train_cfg.events or {}).get(PUSH_EVENT)
        if term is not None:
            events[PUSH_EVENT] = term
            env_cfg.events = events
    if term is None:
        raise ValueError(f"this task has no {PUSH_EVENT!r} event for the push stage settings")
    params = term.params
    if "push_force_max" in settings:
        value = float(settings["push_force_max"])
        params["force_range"] = (-value, value)
    if "push_torque_max" in settings:
        value = float(settings["push_torque_max"])
        params["torque_range"] = (-value, value)
    if "push_duration_s" in settings:
        value = float(settings["push_duration_s"])
        params["duration_s"] = (value, value)
    low, high = params["cooldown_s"]
    low = float(settings.get("push_interval_min_s", low))
    high = float(settings.get("push_interval_max_s", high))
    if low > high:
        raise ValueError(f"push_interval_min_s {low} is above push_interval_max_s {high}")
    params["cooldown_s"] = (low, high)
    return [key for key in PUSH_KEYS if key in settings]
