"""Score an OpenBeni checkpoint headlessly and write metrics as JSON.

Jump tasks also run OpenBeni's own jump trials (``jump_*`` metrics), since
the rollout itself never jumps outside OpenBeni's trainer.
"""
import pathlib
import sys

_RL_AGENT = str(pathlib.Path(__file__).resolve().parents[1])
if _RL_AGENT not in sys.path:
    sys.path.insert(0, _RL_AGENT)

from mjlab_core.evaluate import evaluate, main as _core_main  # noqa: E402,F401
from openbeni.jumps import jump_metrics  # noqa: E402


def main():
    # beni_rl registers Beni-* tasks through the mjlab.tasks entry point;
    # import it explicitly so eval works even if plugin discovery is delayed.
    _core_main(register_modules=("beni_rl",), extra_metrics=jump_metrics)


if __name__ == "__main__":
    main()
