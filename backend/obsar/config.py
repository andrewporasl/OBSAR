from __future__ import annotations

import os
from pathlib import Path

APP_NAME = "obsar"


def _load_dotenv() -> None:
    """Read backend/.env (KEY=VALUE per line) into os.environ without overriding existing vars.
    Used for machine-local settings such as HF_HOME (where the ~12 GB of models live)."""
    env = Path(__file__).resolve().parent.parent / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"'))


_load_dotenv()

EMBED_MODEL = os.environ.get("OBSAR_EMBED_MODEL", "google/siglip2-so400m-patch14-384")
CAPTION_MODEL = os.environ.get("OBSAR_CAPTION_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct")
CAPTIONS_ENABLED = os.environ.get("OBSAR_CAPTIONS", "1") != "0"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif"}
GIF_EXTS = {".gif"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".wmv", ".mpg", ".mpeg"}
ALL_EXTS = IMAGE_EXTS | GIF_EXTS | VIDEO_EXTS

THUMB_SIZE = 320
PREVIEW_SIZE = 320
PREVIEW_FRAMES = 12
VIDEO_FRAMES_MIN = 3
VIDEO_FRAMES_MAX = 12
GIF_FRAMES_MAX = 4
EMBED_BATCH = 16
WATCH_DEBOUNCE_S = 1.5


def data_dir() -> Path:
    if os.environ.get("OBSAR_DATA_DIR"):
        d = Path(os.environ["OBSAR_DATA_DIR"])
        d.mkdir(parents=True, exist_ok=True)
        return d
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    d = Path(base) / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return data_dir() / "index.db"


def cache_dir() -> Path:
    d = data_dir() / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def kind_for(path: Path) -> str | None:
    ext = path.suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in GIF_EXTS:
        return "gif"
    if ext in VIDEO_EXTS:
        return "video"
    return None
