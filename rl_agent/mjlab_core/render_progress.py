"""Shared checkpoint clip & progression video renderer for mjlab + rsl_rl robots."""
import argparse
import importlib
import os
import sys
import time
from dataclasses import asdict
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from media import Media, clean_partials, exclusive_file_lock, font, label, stitch  # noqa: E402
from mjlab_core import launch as core_launch  # noqa: E402
from mjlab_core import stage_settings  # noqa: E402

WATCH_POLL_S = 5
CHECKPOINT_SETTLE_S = 5
SHOVE_LABEL_S = 0.5
PUSH_RECOVERY_S = 3.0


class ClipRenderer:
    """``director(raw_env, checkpoint)`` may return an object acting on the env each frame
    (e.g. requesting jumps): ``min_seconds`` lengthens the clip,
    ``step(frame) -> str | None`` adds a label to that frame, and a true
    ``hides_pushes`` drops the SHOVE label for that frame."""

    def __init__(self, task_id, seconds, device, *, camera=None, clip_size=(640, 480),
                 clip_dir="clips", unity_tasks=None, register_modules=(), clip_label=None,
                 director=None):
        self.task_id = (unity_tasks or {}).get(task_id, task_id)
        self.seconds = seconds
        self.device = device
        self.camera = camera or {"distance": 1.2, "elevation": -15.0}
        self.clip_size = clip_size
        self.clip_dir = clip_dir
        self.register_modules = tuple(register_modules)
        self.clip_label = (clip_label or "").strip() or None
        self.shows_pushes = False
        self.director = director
        self._env = None

    def _build(self):
        from rsl_rl.runners import OnPolicyRunner

        for mod in self.register_modules:
            importlib.import_module(mod)
        import mjlab.tasks  # noqa: F401
        from mjlab.envs import ManagerBasedRlEnv
        from mjlab.rl import RslRlVecEnvWrapper
        from mjlab.tasks.registry import load_env_cfg, load_rl_cfg, load_runner_cls
        from mjlab.utils.torch import configure_torch_backends

        configure_torch_backends()
        env_cfg = load_env_cfg(self.task_id, play=True)
        train_cfg = load_env_cfg(self.task_id)
        core_launch.match_training_intervals(env_cfg, train_cfg)
        # Stages that train against pushes show them in their clips too.
        settings = stage_settings.from_env()
        stage_settings.apply(env_cfg, settings, train_cfg)
        self.shows_pushes = stage_settings.wants_push(settings)
        if self.shows_pushes:
            # Long enough for the first push and the recovery after it.
            first_push_by = env_cfg.events[stage_settings.PUSH_EVENT].params["cooldown_s"][1]
            self.seconds = max(self.seconds, first_push_by + PUSH_RECOVERY_S)
        env_cfg.scene.num_envs = 1
        env_cfg.viewer.width, env_cfg.viewer.height = self.clip_size
        env_cfg.viewer.distance = self.camera["distance"]
        env_cfg.viewer.elevation = self.camera["elevation"]
        agent_cfg = load_rl_cfg(self.task_id)
        self._raw_env = ManagerBasedRlEnv(cfg=env_cfg, device=self.device, render_mode="rgb_array")
        self._env = RslRlVecEnvWrapper(self._raw_env, clip_actions=agent_cfg.clip_actions)
        self._runner = (load_runner_cls(self.task_id) or OnPolicyRunner)(
            self._env, asdict(agent_cfg), device=self.device)
        self.fps = round(1.0 / self._raw_env.step_dt)
        self._font = font(28)

    def clip(self, checkpoint):
        out = core_launch.clip_path(checkpoint, clip_dir=self.clip_dir)
        # Lock so a live watcher and the end-of-job renderer never write the
        # same clip_N at once (even with per-pid temps, dual replace races).
        with exclusive_file_lock(out):
            if out.exists():
                return out
            if self._env is None:
                self._build()
            self._runner.load(str(checkpoint), map_location=self.device)
            policy = self._runner.get_inference_policy(device=self.device)
            step = f"iteration {core_launch.checkpoint_iteration(checkpoint)}"
            text = f"{self.clip_label} · {step}" if self.clip_label else step
            started = time.time()
            clean_partials(out)
            shove_frames = max(1, round(SHOVE_LABEL_S * self.fps))
            shove_left = 0
            with Media(out, self.fps) as media:
                with torch.inference_mode():
                    obs, _ = self._env.reset()
                    director = self.director(self._raw_env, checkpoint) if self.director else None
                    seconds = max(self.seconds, getattr(director, "min_seconds", 0))
                    steps = int(seconds * self.fps)
                    for frame in range(steps):
                        obs, _, dones, _ = self._env.step(policy(obs))
                        if hasattr(policy, "reset") and dones.bool().any():
                            policy.reset(dones.bool())
                        tags = []
                        if director is not None and (tag := director.step(frame)):
                            tags.append(tag)
                        # A push lasts a few frames; hold the marker long enough to read.
                        if self.shows_pushes and stage_settings.push_active(self._raw_env):
                            shove_left = shove_frames
                        if getattr(director, "hides_pushes", False):
                            shove_left = 0
                        if shove_left:
                            tags.append("SHOVE")
                        shove_left = max(0, shove_left - 1)
                        frame_text = " · ".join([text, *tags])
                        media.add(label(self._raw_env.render(), frame_text, self._font))
            print(f"rendered {out}: {steps} frames in {time.time() - started:.1f}s", flush=True)
            return out

    def close(self):
        if self._env is not None:
            self._env.close()


def keep_watching(parent_pid, current_ppid):
    """Whether the clip watcher should keep polling.

    Normally we stop once the launching worker dies and we are reparented to
    init (PID 1). When the worker *is* PID 1 (Docker entrypoint), reparenting
    cannot signal exit — keep going until SIGTERM from ``stop_process``.
    """
    if parent_pid == 1:
        return True
    return current_ppid == parent_pid


def watch(renderer, run_dir, clip_dir="clips"):
    parent = os.getppid()
    failed = set()
    print(f"watching {run_dir} (ppid={parent}, docker_init_parent={parent == 1})",
          flush=True)
    while keep_watching(parent, os.getppid()):
        for _, checkpoint in core_launch.checkpoints([run_dir]):
            if checkpoint in failed or core_launch.clip_path(checkpoint, clip_dir=clip_dir).exists():
                continue
            if time.time() - checkpoint.stat().st_mtime < CHECKPOINT_SETTLE_S:
                continue
            try:
                renderer.clip(checkpoint)
            except Exception as exc:  # noqa: BLE001
                print(f"clip of {checkpoint} failed: {exc!r}", flush=True)
                failed.add(checkpoint)
        time.sleep(WATCH_POLL_S)


def run_cli(camera=None, clip_size=(640, 480), clip_dir="clips",
            default_seconds=5, unity_tasks=None, register_modules=(), director=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("task_id")
    parser.add_argument("--watch", type=Path, metavar="RUN_DIR")
    parser.add_argument("--checkpoints", nargs="+", type=Path, default=[])
    parser.add_argument("--progression", nargs="+", type=Path, default=[])
    parser.add_argument("--out", help="the progression video")
    parser.add_argument("--seconds", type=float, default=default_seconds)
    parser.add_argument("--device", default="cuda:0" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--label", default="",
                        help="optional overlay prefix (curriculum stage name)")
    args = parser.parse_args()
    if args.out and args.checkpoints and not args.progression:
        args.progression, args.checkpoints = args.checkpoints, []
    if bool(args.watch) == bool(args.checkpoints or args.progression):
        parser.error("give --watch, or --checkpoints and/or --progression")
    if bool(args.progression) != bool(args.out):
        parser.error("--progression and --out go together")
    renderer = ClipRenderer(args.task_id, args.seconds, args.device,
                            camera=camera, clip_size=clip_size, clip_dir=clip_dir,
                            unity_tasks=unity_tasks, register_modules=register_modules,
                            clip_label=args.label, director=director)
    try:
        if args.watch:
            watch(renderer, args.watch, clip_dir=clip_dir)
        for checkpoint in args.checkpoints:
            renderer.clip(checkpoint)
        if args.progression:
            stitch([renderer.clip(c) for c in args.progression], args.out)
    finally:
        renderer.close()


if __name__ == "__main__":
    run_cli()
