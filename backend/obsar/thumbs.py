"""Thumbnail and animated-preview generation, cached on disk by file id + mtime."""
from __future__ import annotations

import hashlib
from pathlib import Path

from PIL import Image

from . import config, media


def _key(file_id: int, mtime: float) -> str:
    return hashlib.sha1(f"{file_id}:{mtime}".encode()).hexdigest()[:16]


def thumb_path(file_id: int, mtime: float) -> Path:
    return config.cache_dir() / f"{_key(file_id, mtime)}.webp"


def preview_path(file_id: int, mtime: float) -> Path:
    return config.cache_dir() / f"{_key(file_id, mtime)}_p.webp"


def _fit(im: Image.Image, size: int) -> Image.Image:
    im = im.copy()
    im.thumbnail((size, size), Image.Resampling.LANCZOS)
    return im


def write_thumb(file_id: int, mtime: float, frame: Image.Image) -> Path:
    out = thumb_path(file_id, mtime)
    if not out.exists():
        _fit(frame, config.THUMB_SIZE).save(out, "WEBP", quality=82, method=4)
    return out


def write_preview(file_id: int, mtime: float, path: Path, kind: str) -> Path | None:
    """Animated webp made from several frames. Generated lazily on first hover."""
    out = preview_path(file_id, mtime)
    if out.exists():
        return out
    frames: list[Image.Image] = []
    if kind == "gif":
        d = media.decode_gif(path, max_frames=config.PREVIEW_FRAMES)
        frames = d.frames
    elif kind == "video":
        w, h, dur = media.probe_video(path)
        n = config.PREVIEW_FRAMES
        for i in range(n):
            t = (i + 0.5) / n * dur if dur else 0
            fr = media.grab_video_frame(path, t, max_side=config.PREVIEW_SIZE)
            if fr is not None:
                frames.append(fr)
    if not frames:
        return None
    small = [_fit(f, config.PREVIEW_SIZE) for f in frames]
    small[0].save(
        out, "WEBP", save_all=True, append_images=small[1:], duration=350, loop=0, quality=70, method=4
    )
    return out
