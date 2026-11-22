"""CPU-only tests for curriculum stage settings on mjlab configs (no mjlab needed)."""
import pathlib
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from mjlab_core import stage_settings  # noqa: E402


def push_term():
    return SimpleNamespace(params={"force_range": (-20.0, 20.0), "torque_range": (-1.0, 1.0),
                                   "duration_s": (0.01, 0.01), "cooldown_s": (2.0, 4.0)})


def cfg(events):
    return SimpleNamespace(events=events)


def test_push_settings_rewrite_the_push_event():
    env_cfg = cfg({"push_robot": push_term()})
    changed = stage_settings.apply(env_cfg, {"push_force_max": 30, "push_duration_s": 0.05,
                                             "push_interval_min_s": 3})
    params = env_cfg.events["push_robot"].params
    assert changed == ["push_force_max", "push_duration_s", "push_interval_min_s"]
    assert params["force_range"] == (-30.0, 30.0)
    assert params["torque_range"] == (-1.0, 1.0)
    assert params["duration_s"] == (0.05, 0.05)
    assert params["cooldown_s"] == (3.0, 4.0)


def test_play_configs_get_the_training_push_back():
    train = cfg({"push_robot": push_term()})
    play = cfg({})
    assert stage_settings.apply(play, {"push_force_max": 30}, train_cfg=train)
    assert play.events["push_robot"].params["force_range"] == (-30.0, 30.0)


def test_no_settings_leave_play_configs_calm():
    play = cfg({})
    assert stage_settings.apply(play, {}, train_cfg=cfg({"push_robot": push_term()})) == []
    assert "push_robot" not in play.events


def test_missing_push_event_and_bad_interval_raise():
    with pytest.raises(ValueError, match="no 'push_robot' event"):
        stage_settings.apply(cfg({}), {"push_force_max": 30})
    with pytest.raises(ValueError, match="above push_interval_max_s"):
        stage_settings.apply(cfg({"push_robot": push_term()}), {"push_interval_min_s": 9})


def jump_cfg():
    gate = SimpleNamespace(force_jump_after_updates=9000, success_rate=0.8, consecutive_passes=2)
    return SimpleNamespace(events={"push_robot": push_term()}, commands={"jump": SimpleNamespace(recovery_gate=gate)})


def test_jump_settings_rewrite_the_recovery_gate():
    env_cfg = jump_cfg()
    changed = stage_settings.apply(env_cfg, {"jump_start_by_update": 1.0, "jump_recovery_pass_rate": 0.75,
                                             "jump_recovery_passes": 1})
    gate = env_cfg.commands["jump"].recovery_gate
    assert changed == ["jump_start_by_update", "jump_recovery_pass_rate", "jump_recovery_passes"]
    assert gate.force_jump_after_updates == 1 and isinstance(gate.force_jump_after_updates, int)
    assert gate.success_rate == 0.75 and gate.consecutive_passes == 1
    assert env_cfg.events["push_robot"].params["force_range"] == (-20.0, 20.0)


def test_jump_settings_need_a_jump_command():
    with pytest.raises(ValueError, match="no 'jump' command"):
        stage_settings.apply(SimpleNamespace(events={}, commands={}), {"jump_start_by_update": 1})


def test_env_round_trip(monkeypatch):
    env = stage_settings.env_for({"stage_settings": {"push_force_max": 30}})
    monkeypatch.setenv(stage_settings.ENV, env[stage_settings.ENV])
    assert stage_settings.from_env() == {"push_force_max": 30}
    assert stage_settings.env_for({"stage_settings": {}}) == {}
