"""Headless rollout evaluator for any mjlab + rsl_rl task (feedforward or recurrent).

Rates are over finished episodes only: an episode still running when the
rollout stops has neither fallen nor timed out yet. The rollout always runs
past one full episode length so every environment finishes at least once and
time-outs (survived episodes) are counted.
"""
import argparse
import importlib
import json
import time
from dataclasses import asdict

import torch
from rsl_rl.runners import OnPolicyRunner

import mjlab.tasks  # noqa: F401
from mjlab.envs import ManagerBasedRlEnv
from mjlab.rl import RslRlVecEnvWrapper
from mjlab.tasks.registry import load_env_cfg, load_rl_cfg, load_runner_cls
from mjlab.utils.torch import configure_torch_backends

from mjlab_core import stage_settings


def set_fallen_probability(env_cfg, probability):
    """Pin the share of episodes that start knocked over.

    Tasks with a ``fallen_reset_probability`` curriculum would overwrite the
    value on every reset, so that curriculum term is dropped too.
    """
    reset = (env_cfg.events or {}).get("reset_base")
    if reset is None or "fallen_probability" not in (reset.params or {}):
        raise ValueError("this task has no fallen_probability reset to override")
    reset.params["fallen_probability"] = float(probability)
    if env_cfg.curriculum:
        env_cfg.curriculum.pop("fallen_reset_probability", None)


def summarize(done_returns, done_lengths, falls, timeouts, running):
    finished = len(done_returns)
    return {
        "episodes": finished,
        "falls": falls,
        "timeouts": timeouts,
        "still_running": running,
        "fall_rate": falls / finished if finished else None,
        "mean_return": sum(done_returns) / finished if finished else None,
        "mean_episode_length": sum(done_lengths) / finished if finished else None,
        "mean_reward_per_step": sum(done_returns) / max(sum(done_lengths), 1),
    }


def evaluate(task_id, checkpoint, num_envs, steps, device, register_modules=(), fallen_probability=None,
             extra_metrics=None):
    """``extra_metrics(env_cfg, runner, device) -> dict`` adds robot-specific
    metrics (e.g. OpenBeni's jump trials) from the loaded checkpoint."""
    for mod in register_modules:
        importlib.import_module(mod)
    configure_torch_backends()
    env_cfg = load_env_cfg(task_id, play=False)
    env_cfg.scene.num_envs = num_envs
    if fallen_probability is not None:
        set_fallen_probability(env_cfg, fallen_probability)
    settings = stage_settings.from_env()
    stage_settings.apply(env_cfg, settings)
    agent_cfg = load_rl_cfg(task_id)
    env = RslRlVecEnvWrapper(ManagerBasedRlEnv(cfg=env_cfg, device=device),
                             clip_actions=agent_cfg.clip_actions)
    episode_steps = int(getattr(env.unwrapped, "max_episode_length", 0) or 0)
    steps = max(steps, episode_steps + 1)
    runner_cls = load_runner_cls(task_id) or OnPolicyRunner
    runner = runner_cls(env, asdict(agent_cfg), device=device)
    runner.load(str(checkpoint), map_location=device)
    policy = runner.get_inference_policy(device=device)

    returns = torch.zeros(num_envs, device=device)
    lengths = torch.zeros(num_envs, device=device)
    done_returns, done_lengths = [], []
    falls = timeouts = 0
    start = time.time()
    obs, _ = env.reset()
    with torch.inference_mode():
        for _ in range(steps):
            obs, rew, dones, extras = env.step(policy(obs))
            returns += rew
            lengths += 1
            done = dones.bool()
            if done.any():
                if hasattr(policy, "reset"):
                    policy.reset(done)
                time_outs = extras.get("time_outs")
                timed_out = (time_outs.bool() & done) if time_outs is not None else torch.zeros_like(done)
                timeouts += int(timed_out.sum())
                falls += int((done & ~timed_out).sum())
                done_returns += returns[done].tolist()
                done_lengths += lengths[done].tolist()
                returns[done] = 0
                lengths[done] = 0
    dt = getattr(env.unwrapped, "step_dt", None)
    extra = extra_metrics(env_cfg, runner, device) if extra_metrics else {}
    env.close()

    return {
        "task_id": task_id,
        "checkpoint": str(checkpoint),
        "num_envs": num_envs,
        "steps": steps,
        "episode_steps": episode_steps or None,
        "fallen_probability": fallen_probability,
        "stage_settings": settings or None,
        "control_dt": float(dt) if dt is not None else None,
        **summarize(done_returns, done_lengths, falls, timeouts, num_envs),
        **extra,
        "wall_seconds": round(time.time() - start, 1),
    }


def main(register_modules=(), extra_metrics=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task_id")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--num-envs", type=int, default=512)
    parser.add_argument("--steps", type=int, default=1000,
                        help="minimum rollout steps; raised to one full episode + 1")
    parser.add_argument("--fallen-probability", type=float, default=None,
                        help="share of episodes that start knocked over (default: the task's)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--device", default="cuda:0" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--register", nargs="*", default=list(register_modules))
    args = parser.parse_args()
    result = evaluate(args.task_id, args.checkpoint, args.num_envs, args.steps, args.device,
                      register_modules=args.register, fallen_probability=args.fallen_probability,
                      extra_metrics=extra_metrics)
    with open(args.out, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
