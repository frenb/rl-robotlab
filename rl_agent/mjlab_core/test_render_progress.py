"""CPU-only tests for the checkpoint clip watcher lifecycle."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from mjlab_core.render_progress import keep_watching  # noqa: E402


def test_keep_watching_while_parent_alive():
    assert keep_watching(parent_pid=42, current_ppid=42)


def test_stop_when_reparented_to_init():
    assert not keep_watching(parent_pid=42, current_ppid=1)


def test_keep_watching_when_worker_is_docker_init():
    # beni-trainer / duck-trainer run as PID 1; orphaning is not observable.
    assert keep_watching(parent_pid=1, current_ppid=1)
