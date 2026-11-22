"""Training videos and GIFs, the same for every robot.

Each saved checkpoint of a training job gets a short clip, ``clip_<N>.mp4`` plus
a smaller ``clip_<N>.gif`` labelled with its step, and when training finishes a
progression video stitches evenly spaced clips into ``progress_<N>.mp4`` and
``.gif``. The job records them as ``videos`` (``[{iteration, path, gif}]``),
``progress_video`` and ``progress_gif``. Only where the frames come from is
robot-specific: the duck renders its checkpoints in mjlab, the car records its
Unity client's overhead camera during every eval.

imageio, numpy and Pillow are imported where they're used, so code that only
needs the paths and bookkeeping here doesn't need them installed.
"""
import contextlib
import os
import re
import time
from pathlib import Path

GIF_WIDTH = 360
GIF_FRAME_STRIDE = 4
_CLIP_RE = re.compile(r"^clip_(\d+)\.mp4$")
_PART_RE = re.compile(r"^(?P<stem>.+)\.part(?:\.\d+)?(?P<suffix>\.(?:mp4|gif))$")


def font(size=28):
    from PIL import ImageFont
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1 has a single fixed-size bitmap font
        return ImageFont.load_default()


def label(frame, text, label_font):
    import numpy as np
    from PIL import Image, ImageDraw
    image = Image.fromarray(frame)
    draw = ImageDraw.Draw(image)
    left, top, right, bottom = draw.textbbox((12, 10), text, font=label_font)
    draw.rectangle((left - 6, top - 4, right + 6, bottom + 4), fill=(0, 0, 0))
    draw.text((12, 10), text, fill=(255, 255, 255), font=label_font)
    return np.asarray(image)


def gif_frame(frame):
    import numpy as np
    from PIL import Image
    scale = GIF_WIDTH / frame.shape[1]
    return np.asarray(Image.fromarray(frame).resize((GIF_WIDTH, int(frame.shape[0] * scale))))


def fit(frame, size):
    """``frame`` scaled to fit ``size`` (width, height), letterboxed in black."""
    import numpy as np
    from PIL import Image
    width, height = size
    if frame.shape[1] == width and frame.shape[0] == height:
        return frame
    image = Image.fromarray(frame)
    scale = min(width / image.width, height / image.height)
    image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))))
    canvas = Image.new("RGB", (width, height))
    canvas.paste(image, ((width - image.width) // 2, (height - image.height) // 2))
    return np.asarray(canvas)


def _unlink(path):
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass


def clean_partials(out_mp4):
    """Remove leftover ``.part`` / ``.part.<pid>`` temps for ``out_mp4`` and its GIF."""
    out_mp4 = Path(out_mp4)
    parent = out_mp4.parent
    if not parent.is_dir():
        return
    stems = {out_mp4.stem, out_mp4.with_suffix(".gif").stem}
    for path in parent.iterdir():
        match = _PART_RE.match(path.name)
        if match and match.group("stem") in stems:
            _unlink(path)


@contextlib.contextmanager
def exclusive_file_lock(path, timeout_s=120.0, poll_s=0.2):
    """Exclusive lock for one output path so watcher and end-of-job render don't race.

    Uses ``fcntl`` when available (Linux trainers). Elsewhere the lock is a no-op
    so unit tests on Windows still exercise the write path.
    """
    path = Path(path)
    lock_path = path.with_name(path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(lock_path, "a+b")
    try:
        try:
            import fcntl
        except ImportError:
            yield
            return
        deadline = time.monotonic() + timeout_s
        while True:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"timed out waiting for lock {lock_path}")
                time.sleep(poll_s)
        yield
    finally:
        try:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        except Exception:  # noqa: BLE001
            pass
        fh.close()


class Media:
    """Streams frames into ``<out>.mp4`` and a subsampled ``<out>.gif``.

    Both are written under temporary names and renamed when complete, the MP4
    last, so an existing MP4 always means a finished pair. Temps are tagged
    with the process id so a live clip watcher and the end-of-job renderer
    cannot clobber the same ``.part`` file.
    """

    def __init__(self, out_mp4, fps):
        import imageio.v2 as imageio
        self._imageio = imageio
        self.mp4 = Path(out_mp4)
        self.gif = self.mp4.with_suffix(".gif")
        self.fps = fps
        self.mp4.parent.mkdir(parents=True, exist_ok=True)
        tag = f".part.{os.getpid()}"
        self._tmp_mp4 = self.mp4.with_name(self.mp4.stem + tag + ".mp4")
        self._tmp_gif = self.gif.with_name(self.gif.stem + tag + ".gif")
        self._writer = self._imageio.get_writer(self._tmp_mp4, fps=fps, macro_block_size=1)
        self._gif_frames = []
        self._count = 0
        self._closed = False

    def add(self, frame):
        self._writer.append_data(frame)
        if self._count % GIF_FRAME_STRIDE == 0:
            self._gif_frames.append(gif_frame(frame))
        self._count += 1

    def _cleanup_temps(self):
        _unlink(self._tmp_mp4)
        _unlink(self._tmp_gif)

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self._writer.close()
            if self._count <= 0:
                raise RuntimeError(f"no frames written for {self.mp4}")
            self._imageio.mimsave(
                self._tmp_gif, self._gif_frames,
                duration=1000 * GIF_FRAME_STRIDE / self.fps, loop=0)
            os.replace(self._tmp_gif, self.gif)
            os.replace(self._tmp_mp4, self.mp4)
        except Exception:
            self._cleanup_temps()
            raise

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is not None:
            try:
                self._writer.close()
            except Exception:  # noqa: BLE001
                pass
            self._closed = True
            self._cleanup_temps()
            return False
        self.close()
        return False


def write_clip(frames, out_mp4, fps, text=None):
    """``frames`` (RGB arrays) as ``out_mp4`` and its GIF, each labelled ``text``
    in type sized to the frame width."""
    out_mp4 = Path(out_mp4)
    with exclusive_file_lock(out_mp4):
        if out_mp4.is_file():
            return out_mp4
        clean_partials(out_mp4)
        label_font = None
        with Media(out_mp4, fps) as media:
            for frame in frames:
                if text and label_font is None:
                    label_font = font(max(16, frame.shape[1] // 30))
                media.add(label(frame, text, label_font) if text else frame)
        return media.mp4


def stitch(clips, out_mp4, max_seconds=None):
    """One video of ``clips`` back to back, with its GIF, at the newest clip's
    size (a job's clips can differ, e.g. across a client upgrade); each clip
    cut to its first ``max_seconds`` when given.

    Missing or unreadable clips are skipped so a raced/deleted clip mid-run
    cannot fail the whole progression video.
    """
    import imageio.v2 as imageio
    out_mp4 = Path(out_mp4)
    clips = [Path(c) for c in clips]
    with exclusive_file_lock(out_mp4):
        if out_mp4.is_file():
            return out_mp4
        present = [c for c in clips if c.is_file()]
        if not present:
            raise FileNotFoundError("stitch: no clip files on disk")
        fps = size = None
        for candidate in reversed(present):
            try:
                reader = imageio.get_reader(candidate)
                meta = reader.get_meta_data()
                reader.close()
                fps, size = meta["fps"], tuple(meta["size"])
                break
            except Exception as exc:  # noqa: BLE001
                print(f"stitch: unreadable meta from {candidate}: {exc!r}", flush=True)
        if fps is None or size is None:
            raise FileNotFoundError("stitch: no readable clip files on disk")
        limit = round(max_seconds * fps) if max_seconds else None
        used = 0
        clean_partials(out_mp4)
        with Media(out_mp4, fps) as media:
            for clip in present:
                if not clip.is_file():
                    print(f"stitch: skipping missing {clip}", flush=True)
                    continue
                try:
                    reader = imageio.get_reader(clip)
                except Exception as exc:  # noqa: BLE001
                    print(f"stitch: skipping unreadable {clip}: {exc!r}", flush=True)
                    continue
                try:
                    for n, frame in enumerate(reader):
                        if limit is not None and n >= limit:
                            break
                        media.add(fit(frame, size))
                    used += 1
                except Exception as exc:  # noqa: BLE001
                    print(f"stitch: truncated {clip}: {exc!r}", flush=True)
                finally:
                    reader.close()
        if used <= 0:
            _unlink(out_mp4)
            _unlink(out_mp4.with_suffix(".gif"))
            raise FileNotFoundError("stitch: no frames could be read from clips")
        print(f"Written {media.mp4} and {media.gif} from {used} clips", flush=True)
        return media.mp4


def pick_evenly(items, count):
    """Up to ``count`` items spread evenly, always keeping the first and last."""
    if count <= 1 or len(items) <= count:
        return list(items) if count > 1 else list(items[-1:])
    step = (len(items) - 1) / (count - 1)
    return [items[round(i * step)] for i in range(count)]


def video_entry(iteration, mp4):
    """The ``videos`` entry a job records for one clip."""
    return {"iteration": iteration, "path": str(mp4), "gif": str(Path(mp4).with_suffix(".gif"))}


def clips_in(clip_dir):
    """``videos`` entries for the finished clips in ``clip_dir``, oldest first."""
    clip_dir = Path(clip_dir)
    if not clip_dir.is_dir():
        return []
    found = []
    for path in clip_dir.iterdir():
        match = _CLIP_RE.match(path.name)
        if match:
            found.append(video_entry(int(match.group(1)), path))
    return sorted(found, key=lambda v: v["iteration"])
