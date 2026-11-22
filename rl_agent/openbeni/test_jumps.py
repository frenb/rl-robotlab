"""CPU-only tests for OpenBeni jump clips and jump eval metrics (no mjlab)."""
import pathlib
import sys
from types import SimpleNamespace

import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from openbeni import jumps  # noqa: E402

FPS = 10
AIR, FOLLOW_UP = 3, 20


class FakeJump:
    """Accepts a request from ``ready_at``; touches down after AIR frames and
    stays tracked for FOLLOW_UP more, like OpenBeni's observation window."""

    def __init__(self, ready_at=0, lands=True):
        self.state = {"tracking": torch.zeros(1, dtype=torch.bool), "land_s": -torch.ones(1),
                      "body_hit": torch.zeros(1, dtype=torch.bool), "failed": torch.zeros(1, dtype=torch.bool)}
        self._env_ids = torch.arange(1)
        self.frame, self.ready_at, self.lands = 0, ready_at, lands
        self.requests, self.accepted_at = [], None

    def request(self, ids):
        self.requests.append(self.frame)
        if self.frame < self.ready_at or self.state["tracking"][0]:
            return torch.tensor([1])
        self.state["tracking"][0] = True
        self.state["land_s"][0] = -1
        self.accepted_at = self.frame
        return torch.tensor([0])

    def tick(self, frame):
        self.frame = frame
        if self.accepted_at is None:
            return
        if frame == self.accepted_at + AIR:
            self.state["land_s"][0] = AIR / FPS
            self.state["body_hit"][0] = not self.lands
        if frame == self.accepted_at + AIR + FOLLOW_UP:
            self.state["tracking"][0] = False
            self.accepted_at = None


def env_with(term):
    names = ["twist"] + (["jump"] if term is not None else [])
    manager = SimpleNamespace(active_terms=names, get_term=lambda name: term)
    return SimpleNamespace(command_manager=manager, step_dt=1 / FPS)


def run(term, frames):
    director = jumps.director(env_with(term))
    labels = []
    for frame in range(frames):
        term.tick(frame)
        labels.append(director.step(frame))
    return labels


def test_requests_after_settling_retries_until_ready_and_labels_the_motion():
    term = FakeJump(ready_at=25)
    labels = run(term, 80)
    first = round(jumps.FIRST_REQUEST_S * FPS)
    assert term.requests[:6] == list(range(first, first + 6))
    assert labels[24] is None and labels[25:28] == ["JUMP"] * 3
    hold = round(jumps.OUTCOME_LABEL_S * FPS)
    assert labels[28:28 + hold + 1] == ["LANDED"] * (hold + 1)
    assert labels[28 + hold + 1] is None, "no label for the rest of OpenBeni's follow-up window"
    ended = 25 + AIR + FOLLOW_UP
    assert [r for r in term.requests if r > 25] == [r for r in term.requests if r >= ended + round(jumps.BETWEEN_JUMPS_S * FPS)]
    assert labels[ended + round(jumps.BETWEEN_JUMPS_S * FPS)] == "JUMP"


def test_shove_label_is_hidden_only_while_jumping():
    term = FakeJump()
    director = jumps.director(env_with(term))
    hidden = []
    for frame in range(40):
        term.tick(frame)
        director.step(frame)
        hidden.append(director.hides_pushes)
    first = round(jumps.FIRST_REQUEST_S * FPS)
    assert hidden[first:first + AIR] == [True] * AIR
    assert not any(hidden[:first]) and not any(hidden[first + AIR:])


def test_failed_jump_is_labelled_at_touchdown():
    labels = run(FakeJump(lands=False), 40)
    first = round(jumps.FIRST_REQUEST_S * FPS)
    assert labels[first + AIR] == "JUMP FAILED" and "LANDED" not in labels


def checkpoint_with(tmp_path, infos):
    path = tmp_path / "model_1.pt"
    torch.save({"model_state_dict": {}, "infos": infos}, path)
    return path


def test_checkpoints_without_jump_training_get_a_label_and_no_requests(tmp_path):
    term = FakeJump()
    untrained = checkpoint_with(tmp_path, {"beni_training": {"completed_updates": 10, "jump": None}})
    director = jumps.director(env_with(term), untrained)
    labels = []
    for frame in range(40):
        term.tick(frame)
        labels.append(director.step(frame))
    assert term.requests == [] and set(labels) == {jumps.UNTRAINED_LABEL}
    assert not director.hides_pushes and director.min_seconds == 0


def test_trained_or_unrecorded_checkpoints_still_request_jumps(tmp_path):
    trained = checkpoint_with(tmp_path, {"beni_training": {"jump": {"start_iteration": 9000}}})
    assert jumps.jumps_trained(trained) is True
    assert isinstance(jumps.director(env_with(FakeJump()), trained), jumps.JumpDirector)
    unrecorded = checkpoint_with(tmp_path, None)
    assert jumps.jumps_trained(unrecorded) is None
    assert isinstance(jumps.director(env_with(FakeJump()), unrecorded), jumps.JumpDirector)


def test_tasks_without_a_jump_command_get_no_director_or_metrics():
    assert jumps.director(env_with(None)) is None
    assert jumps.jump_metrics(SimpleNamespace(commands={"twist": object()}), None, "cpu") == {}
