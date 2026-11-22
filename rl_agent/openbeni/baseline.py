"""Registers open-beni's shipped checkpoint as an OpenBeni model.

``assets/models/policy.pt`` is the upstream jump-stage policy (15,000 PPO
updates, GRU-512). The shared mjlab launcher only accepts ``model_<N>.pt``
names (same as microduck), so seed materializes a canonical
``model_15000.pt`` next to it (hardlink when possible, else copy) and
registers that path. It is the reference that the plan's EVAL baseline and
the curriculum gate thresholds are measured against, and a warm start for
``Beni-Jump-Flat`` jobs.
"""
import os
import pathlib
import shutil

from mjlab_core.launch import CHECKPOINT_RE

ROBOT = "openbeni"
TASK_ID = "Beni-Jump-Flat"
ITERATIONS = 15000
_RL_DIR = pathlib.Path(os.environ.get("OPENBENI_RL_DIR", "/openbeni_rl"))
UPSTREAM = _RL_DIR / "assets/models/policy.pt"
CHECKPOINT = _RL_DIR / f"assets/models/model_{ITERATIONS}.pt"


def ensure_canonical(source=UPSTREAM, iterations=ITERATIONS):
    """Return a ``model_<N>.pt`` path for *source*, creating it if needed.

    Already-canonical paths are returned as-is. Missing sources yield None.
    """
    source = pathlib.Path(source)
    if not source.is_file():
        return None
    if CHECKPOINT_RE.match(source.name):
        return source
    dest = source.with_name(f"model_{iterations}.pt")
    if dest.is_file() and dest.stat().st_size == source.stat().st_size:
        return dest
    dest.unlink(missing_ok=True)
    try:
        os.link(source, dest)
    except OSError:
        shutil.copy2(source, dest)
    return dest


def model_doc(checkpoint=CHECKPOINT):
    return {
        "location": str(checkpoint),
        "task_id": TASK_ID,
        "training_iterations": ITERATIONS,
        "model_type": "PPO",
        "notes": "open-beni upstream pretrained policy (jump stage, 15k updates); baseline",
    }


def seed(db, now, checkpoint=UPSTREAM):
    """Upsert the baseline model record. Returns the locations registered.

    No job produced it, so it has no job_id (the Models tab offers clips and
    VIDEO jobs only for models that have one). Accepts the upstream
    ``policy.pt`` or an already-canonical ``model_<N>.pt``.
    """
    canonical = ensure_canonical(checkpoint, ITERATIONS)
    if canonical is None:
        return []
    doc = model_doc(canonical)
    db.models.update_one(
        {"robot": ROBOT, "location": doc["location"]},
        {"$set": {**doc, "updated_at": now},
         "$setOnInsert": {"robot": ROBOT, "create_date": now}},
        upsert=True)
    return [doc["location"]]
