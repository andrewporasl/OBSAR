"""Decode any supported media file into a list of PIL frames plus metadata."""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageOps

from . import config

try:  # HEIC/AVIF support if available
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:  # pragma: no cover
    pass


def ffmpeg_exe() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def run_hidden(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    """subprocess.run that never flashes a console window on Windows."""
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = subprocess.SW_HIDE
        kw.setdefault("startupinfo", si)
        kw["creationflags"] = kw.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
    kw.setdefault("stdin", subprocess.DEVNULL)
    return subprocess.run(cmd, **kw)


@dataclass
class Decoded:
    kind: str
    width: int
    height: int
    duration: float | None
    frames: list[Image.Image] = field(default_factory=list)
    # fraction [0,1] of where each frame sits in the timeline (for video/gif)
    positions: list[float] = field(default_factory=list)


def _rgb(im: Image.Image) -> Image.Image:
    im = ImageOps.exif_transpose(im)
    if im.mode != "RGB":
        im = im.convert("RGB")
    return im


def _sample_positions(n: int) -> list[float]:
    if n <= 1:
        return [0.5]
    return [(i + 0.5) / n for i in range(n)]


def decode_image(path: Path) -> Decoded:
    with Image.open(path) as im:
        im.load()
        return Decoded("image", im.width, im.height, None, [_rgb(im)], [0.5])


def decode_gif(path: Path, max_frames: int = config.GIF_FRAMES_MAX) -> Decoded:
    with Image.open(path) as im:
        n = getattr(im, "n_frames", 1)
        duration_ms = 0
        try:
            for i in range(n):
                im.seek(i)
                duration_ms += im.info.get("duration", 100)
        except EOFError:
            pass
        want = min(n, max_frames)
        idxs = sorted({int(p * n) for p in _sample_positions(want)})
        frames: list[Image.Image] = []
        for i in idxs:
            im.seek(min(i, n - 1))
            frames.append(_rgb(im.copy()))
        positions = [(i + 0.5) / n for i in idxs]
        return Decoded("gif", im.width, im.height, duration_ms / 1000.0 or None, frames, positions)


def probe_video(path: Path) -> tuple[int, int, float]:
    """Return (width, height, duration_seconds) using ffmpeg's -i stderr parse via ffprobe if present, else ffmpeg."""
    exe = ffmpeg_exe()
    probe = Path(exe).with_name(Path(exe).name.replace("ffmpeg", "ffprobe"))
    if probe.exists():
        out = run_hidden(
            [str(probe), "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height:format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        try:
            j = json.loads(out.stdout)
            s = j["streams"][0]
            return int(s["width"]), int(s["height"]), float(j["format"].get("duration") or 0)
        except Exception:
            pass
    # Fallback: parse `ffmpeg -i` stderr
    import re

    out = run_hidden([exe, "-hide_banner", "-i", str(path)], capture_output=True, text=True, timeout=60)
    txt = out.stderr
    dur = 0.0
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.?\d*)", txt)
    if m:
        dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    w = h = 0
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", txt)
    if m:
        w, h = int(m.group(1)), int(m.group(2))
    return w, h, dur


def grab_video_frame(path: Path, t: float, max_side: int = 768) -> Image.Image | None:
    exe = ffmpeg_exe()
    cmd = [
        exe, "-hide_banner", "-loglevel", "error", "-ss", f"{max(t, 0):.3f}", "-i", str(path),
        "-frames:v", "1", "-vf", f"scale='min({max_side},iw)':-2", "-f", "image2pipe", "-vcodec", "png", "-",
    ]
    out = run_hidden(cmd, capture_output=True, timeout=60)
    if out.returncode != 0 or not out.stdout:
        return None
    import io

    im = Image.open(io.BytesIO(out.stdout))
    im.load()
    return _rgb(im)


def decode_video(path: Path) -> Decoded:
    w, h, dur = probe_video(path)
    n = int(max(config.VIDEO_FRAMES_MIN, min(config.VIDEO_FRAMES_MAX, (dur or 1) / 5)))
    positions = _sample_positions(n)
    frames: list[Image.Image] = []
    kept: list[float] = []
    for p in positions:
        t = p * dur if dur else 0
        fr = grab_video_frame(path, t)
        if fr is None and dur:
            fr = grab_video_frame(path, max(t - 0.5, 0))
        if fr is not None:
            frames.append(fr)
            kept.append(p)
    if not frames:
        raise RuntimeError("ffmpeg could not decode any frame")
    if not w or not h:
        w, h = frames[0].width, frames[0].height
    return Decoded("video", w, h, dur or None, frames, kept)


def decode(path: Path) -> Decoded:
    kind = config.kind_for(path)
    if kind == "image":
        return decode_image(path)
    if kind == "gif":
        return decode_gif(path)
    if kind == "video":
        return decode_video(path)
    raise ValueError(f"unsupported file type: {path.suffix}")
