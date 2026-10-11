"""Where OBSAR keeps things and how big they are, for the Settings page."""
from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

from . import config

_cache: dict[str, tuple[float, int]] = {}


def dir_size(p: Path, ttl: float = 10.0) -> int:
    """Recursive byte size, cached briefly because Settings polls."""
    key = str(p)
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    total = 0
    if p.exists():
        stack = [p]
        while stack:
            d = stack.pop()
            try:
                with os.scandir(d) as it:
                    for e in it:
                        try:
                            if e.is_dir(follow_symlinks=False):
                                stack.append(Path(e.path))
                            elif e.is_file(follow_symlinks=False):
                                total += e.stat(follow_symlinks=False).st_size
                        except OSError:
                            pass
            except OSError:
                pass
    _cache[key] = (now, total)
    return total


def free_space(p: Path) -> int | None:
    try:
        anchor = p if p.exists() else Path(p.anchor)
        return shutil.disk_usage(anchor).free
    except OSError:
        return None


def models_dir() -> Path:
    return Path(os.environ.get("HF_HOME") or (Path.home() / ".cache" / "huggingface"))


def _model_dir(name: str) -> Path:
    return models_dir() / "hub" / ("models--" + name.replace("/", "--"))


def model_present(name: str) -> bool:
    """True when the Hub cache can serve the model fully offline."""
    d = _model_dir(name)
    if not (d / "snapshots").exists():
        return False
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(name, local_files_only=True)
        return True
    except Exception:
        return False


def prune_incomplete(name: str) -> int:
    """Delete the blobs folder once the snapshot is whole.

    huggingface_hub stores content in blobs/ and symlinks snapshots/ to it. Windows without
    Developer Mode cannot symlink, so the hub *copies* files into snapshots/, doubling disk use.
    The snapshot alone is enough for local_files_only loads, so drop the blobs (and any
    *.incomplete leftovers from interrupted downloads)."""
    blobs = _model_dir(name) / "blobs"
    n = 0
    if blobs.exists():
        for b in blobs.iterdir():
            if b.is_file() and (b.name.endswith(".incomplete") or not b.is_symlink()):
                try:
                    b.unlink()
                    n += 1
                except OSError:
                    pass
    if n:
        _cache.clear()
    return n


def model_info(name: str, enabled: bool) -> dict:
    d = _model_dir(name)
    return {
        "name": name,
        "path": str(d),
        "bytes": dir_size(d),
        "present": model_present(name),
        "enabled": enabled,
    }


def storage_report(captions_enabled: bool) -> dict:
    data = config.data_dir()
    cache = config.cache_dir()
    db_bytes = sum(p.stat().st_size for p in data.glob("index.db*") if p.is_file())
    thumbs = previews = 0
    try:
        with os.scandir(cache) as it:
            for e in it:
                if not e.is_file():
                    continue
                sz = e.stat().st_size
                if e.name.endswith("_p.webp"):
                    previews += sz
                else:
                    thumbs += sz
    except OSError:
        pass
    venv = data / "venv"
    python = data / "python"
    mdir = models_dir()
    models = [model_info(config.EMBED_MODEL, True), model_info(config.CAPTION_MODEL, captions_enabled)]
    return {
        "data_dir": str(data),
        "data_free": free_space(data),
        "db_bytes": db_bytes,
        "thumb_bytes": thumbs,
        "preview_bytes": previews,
        "runtime_bytes": (dir_size(venv) + dir_size(python)) if (venv.exists() or python.exists()) else 0,
        "models_dir": str(mdir),
        "models_free": free_space(mdir),
        "models": models,
        "models_bytes": sum(m["bytes"] for m in models),
        "total_bytes": db_bytes + thumbs + previews + sum(m["bytes"] for m in models)
        + ((dir_size(venv) + dir_size(python)) if (venv.exists() or python.exists()) else 0),
    }


def clear_previews() -> int:
    n = 0
    for p in config.cache_dir().glob("*_p.webp"):
        try:
            p.unlink()
            n += 1
        except OSError:
            pass
    _cache.clear()
    return n


def clear_thumbs() -> int:
    n = 0
    for p in config.cache_dir().glob("*.webp"):
        try:
            p.unlink()
            n += 1
        except OSError:
            pass
    _cache.clear()
    return n


def delete_model(name: str) -> bool:
    d = _model_dir(name)
    if not d.exists():
        return False
    shutil.rmtree(d, ignore_errors=True)
    _cache.clear()
    return True
