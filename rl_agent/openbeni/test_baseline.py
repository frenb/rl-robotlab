"""CPU-only tests for seeding open-beni's pretrained checkpoint as a model."""
import datetime
import pathlib
import sys
from types import SimpleNamespace as NS

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from openbeni import baseline  # noqa: E402

NOW = datetime.datetime(2026, 11, 18)


class FakeModels:
    def __init__(self):
        self.docs = {}

    def update_one(self, flt, update, upsert=False):
        key = (flt["robot"], flt["location"])
        doc = self.docs.get(key)
        if doc is None:
            assert upsert
            doc = dict(update.get("$setOnInsert", {}))
            self.docs[key] = doc
        doc.update(update["$set"])


def test_seed_canonicalizes_upstream_policy(tmp_path):
    upstream = tmp_path / "policy.pt"
    upstream.write_bytes(b"x" * 16)
    db = NS(models=FakeModels())
    canonical = tmp_path / "model_15000.pt"
    assert baseline.seed(db, NOW, checkpoint=upstream) == [str(canonical)]
    assert canonical.is_file()
    assert canonical.read_bytes() == upstream.read_bytes()
    assert baseline.seed(db, NOW, checkpoint=upstream) == [str(canonical)]
    assert len(db.models.docs) == 1
    doc = db.models.docs[("openbeni", str(canonical))]
    assert "job_id" not in doc
    assert doc["task_id"] == "Beni-Jump-Flat"
    assert doc["training_iterations"] == 15000
    assert doc["create_date"] == NOW
    assert doc["location"] == str(canonical)


def test_seed_keeps_already_canonical_name(tmp_path):
    ckpt = tmp_path / "model_15000.pt"
    ckpt.write_bytes(b"y")
    db = NS(models=FakeModels())
    assert baseline.seed(db, NOW, checkpoint=ckpt) == [str(ckpt)]
    assert list(tmp_path.iterdir()) == [ckpt]


def test_missing_checkpoint_registers_nothing(tmp_path):
    db = NS(models=FakeModels())
    assert baseline.seed(db, NOW, checkpoint=tmp_path / "absent.pt") == []
    assert db.models.docs == {}
