"""FastAPI entrypoint. Run: python -m obsar.main [--root <folder>] [--port N]"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from . import __version__, config, storage, thumbs
from .db import DB
from .indexer import Indexer, VectorStore
from .models import PROGRESS, ModelManager, ensure_model
from .search import Searcher, row_to_dict
from .watcher import Watcher

log = logging.getLogger("obsar")


class State:
    db: DB
    store: VectorStore
    models: ModelManager
    indexer: Indexer
    watcher: Watcher
    searcher: Searcher
    sync_on_launch: bool = True


S = State()
_initial_root: str | None = None


def _lib_dict(row, stats: dict | None = None) -> dict:
    st = S.indexer.status()["libraries"].get(row["id"], {})
    d = {
        "id": row["id"],
        "path": row["path"],
        "name": Path(row["path"]).name or row["path"],
        "added_at": row["added_at"],
        "last_synced": row["last_synced"],
        "enabled": bool(row["enabled"]),
        "exists": Path(row["path"]).is_dir(),
        "watching": S.watcher.watching(row["id"]),
        **st,
    }
    if stats is not None:
        d["stats"] = stats
    return d


def _apply_libraries() -> None:
    S.indexer.load_libraries()
    S.watcher.sync(S.indexer.libraries)
    S.store.invalidate()


@asynccontextmanager
async def lifespan(app: FastAPI):
    S.db = DB()
    S.store = VectorStore(S.db)
    S.models = ModelManager(config.CAPTIONS_ENABLED)
    S.indexer = Indexer(S.db, S.models, S.store)
    S.watcher = Watcher(S.indexer)
    S.searcher = Searcher(S.db, S.models.embedder, S.store)
    S.sync_on_launch = S.db.get_setting("sync_on_launch", "1") == "1"
    if _initial_root and Path(_initial_root).is_dir():
        S.db.add_library(_initial_root)
    _apply_libraries()
    S.indexer.start()
    if S.sync_on_launch:
        threading.Thread(target=S.indexer.reconcile_all, name="obsar-reconcile", daemon=True).start()
    yield
    S.indexer.stop()
    S.watcher.stop()


app = FastAPI(title="OBSAR", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ---- status / search ----------------------------------------------------
@app.get("/health")
def health():
    """Cheap liveness probe for the Electron watchdog; never touches the models."""
    return {"ok": True, "version": __version__}


@app.get("/status")
def status():
    st = S.indexer.status()
    st["captions"] = S.models.captions
    st["models"] = PROGRESS.snapshot()
    st["sync_on_launch"] = S.sync_on_launch
    st["library_count"] = len(S.indexer.libraries)
    st["version"] = __version__
    return st


@app.get("/search")
async def search(
    q: str = "",
    kind: str = Query("all", pattern="^(all|image|gif|video)$"),
    library: int | None = None,
    limit: int = Query(60, le=500),
):
    if not S.models.loaded and q.strip():
        res = S.db.fts_search(q, limit=limit)
        rows = S.db.rows_by_ids([f for f, _ in res])
        enabled = S.db.enabled_library_ids()
        items = [
            row_to_dict(rows[f], s, 0, s)
            for f, s in res
            if f in rows and rows[f]["library_id"] in enabled
            and (kind == "all" or rows[f]["kind"] == kind)
            and (library is None or rows[f]["library_id"] == library)
        ]
        return {"items": items, "degraded": True}
    items = await run_in_threadpool(S.searcher.search, q, kind, limit, library)
    return {"items": items, "degraded": False}


@app.get("/browse")
async def browse(
    kind: str = Query("all", pattern="^(all|image|gif|video)$"),
    library: int | None = None,
    limit: int = Query(120, le=500),
    offset: int = Query(0, ge=0),
):
    """Page through the whole library (newest first) when there is no search query."""
    def work():
        rows = S.db.recent(limit, kind, library, offset)
        return {"items": [row_to_dict(r) for r in rows], "total": S.db.browse_count(kind, library), "offset": offset}
    return await run_in_threadpool(work)


@app.get("/similar/{file_id}")
async def similar(file_id: int, limit: int = 30):
    return {"items": await run_in_threadpool(S.searcher.similar, file_id, limit)}


@app.get("/file/{file_id}")
def file_info(file_id: int):
    row = S.db.get_file(file_id)
    if not row:
        raise HTTPException(404)
    return row_to_dict(row)


# ---- media --------------------------------------------------------------
_IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}


@app.get("/thumb/{file_id}")
async def thumb(file_id: int):
    row = S.db.get_file(file_id)
    if not row:
        raise HTTPException(404)
    p = thumbs.thumb_path(file_id, row["mtime"])
    if not p.exists():
        from . import media

        def make():
            d = media.decode(Path(row["path"]))
            return thumbs.write_thumb(file_id, row["mtime"], d.frames[len(d.frames) // 2])

        try:
            p = await run_in_threadpool(make)
        except Exception as e:
            raise HTTPException(500, str(e))
    return FileResponse(p, media_type="image/webp", headers=_IMMUTABLE)


@app.get("/preview/{file_id}")
async def preview(file_id: int):
    row = S.db.get_file(file_id)
    if not row:
        raise HTTPException(404)
    if row["kind"] not in ("gif", "video"):
        return await thumb(file_id)
    p = await run_in_threadpool(thumbs.write_preview, file_id, row["mtime"], Path(row["path"]), row["kind"])
    if p is None:
        return await thumb(file_id)
    return FileResponse(p, media_type="image/webp", headers=_IMMUTABLE)


@app.get("/raw/{file_id}")
def raw(file_id: int):
    row = S.db.get_file(file_id)
    if not row or not Path(row["path"]).exists():
        raise HTTPException(404)
    return FileResponse(row["path"])


# ---- libraries ----------------------------------------------------------
class LibraryBody(BaseModel):
    path: str


@app.get("/libraries")
def libraries():
    rows = S.db.list_libraries()
    return {"items": [_lib_dict(r, S.db.library_stats(r["id"])) for r in rows]}


@app.post("/libraries")
async def add_library(body: LibraryBody):
    p = Path(body.path)
    if not p.is_dir():
        raise HTTPException(400, f"not a directory: {body.path}")
    for existing in S.indexer.libraries.values():
        e = str(existing).rstrip(os.sep)
        n = str(p.resolve()).rstrip(os.sep)
        if n == e:
            break
        if n.startswith(e + os.sep) or e.startswith(n + os.sep):
            raise HTTPException(400, f"overlaps an existing library: {existing}")
    row = S.db.add_library(str(p))
    _apply_libraries()
    threading.Thread(target=S.indexer.reconcile, args=(row["id"],), daemon=True).start()
    return _lib_dict(row, S.db.library_stats(row["id"]))


@app.delete("/libraries/{lid}")
async def remove_library(lid: int, delete_data: bool = False):
    row = S.db.get_library(lid)
    if not row:
        raise HTTPException(404)
    S.watcher.remove(lid)
    S.indexer.pause(lid, True)
    purged = await run_in_threadpool(S.db.remove_library, lid, delete_data)
    if delete_data:
        await run_in_threadpool(S.indexer.purge_library_files, purged)
    S.indexer.pause(lid, False) if not delete_data else None
    _apply_libraries()
    return {"ok": True, "deleted_files": len(purged)}


@app.post("/libraries/{lid}/resync")
async def resync_library(lid: int, full: bool = False):
    row = S.db.get_library(lid)
    if not row:
        raise HTTPException(404)
    if not row["enabled"]:
        S.db.set_library_enabled(lid, True)
        _apply_libraries()
    if full:
        for fid in await run_in_threadpool(S.db.set_all_pending, lid):
            S.indexer.enqueue_id(fid)
    threading.Thread(target=S.indexer.reconcile, args=(lid, full), daemon=True).start()
    return {"ok": True}


@app.post("/libraries/{lid}/enable")
def enable_library(lid: int, enabled: bool = True):
    if not S.db.get_library(lid):
        raise HTTPException(404)
    S.db.set_library_enabled(lid, enabled)
    _apply_libraries()
    if enabled:
        threading.Thread(target=S.indexer.reconcile, args=(lid,), daemon=True).start()
    return {"ok": True}


@app.post("/libraries/{lid}/pause")
def pause_library(lid: int, paused: bool = True):
    if not S.db.get_library(lid):
        raise HTTPException(404)
    S.indexer.pause(lid, paused)
    return {"ok": True}


@app.post("/reindex/{file_id}")
def reindex(file_id: int):
    row = S.db.get_file(file_id)
    if not row:
        raise HTTPException(404)
    S.db.set_pending(file_id)
    S.indexer.enqueue_id(file_id)
    return {"ok": True}


@app.post("/rescan")
def rescan():
    threading.Thread(target=S.indexer.reconcile_all, daemon=True).start()
    return {"ok": True}


# ---- storage / settings -------------------------------------------------
@app.get("/storage")
def storage_info():
    return storage.storage_report(S.models.captions)


@app.post("/storage/clear_previews")
def clear_previews():
    return {"removed": storage.clear_previews()}


@app.post("/storage/clear_thumbs")
def clear_thumbs():
    return {"removed": storage.clear_thumbs()}


class SettingsBody(BaseModel):
    sync_on_launch: bool | None = None
    captions: bool | None = None


@app.post("/settings")
async def set_settings(body: SettingsBody):
    if body.sync_on_launch is not None:
        S.sync_on_launch = body.sync_on_launch
        S.db.set_setting("sync_on_launch", "1" if body.sync_on_launch else "0")
    if body.captions is not None and body.captions != S.models.captions:
        config.CAPTIONS_ENABLED = body.captions
        await run_in_threadpool(S.models.set_captions, body.captions)
    return status()


class ModelsBody(BaseModel):
    captions: bool = True


@app.post("/models/download")
def download_models(body: ModelsBody):
    names = [config.EMBED_MODEL] + ([config.CAPTION_MODEL] if body.captions else [])

    def run():
        for n in names:
            try:
                ensure_model(n)
            except Exception:
                return

    threading.Thread(target=run, name="obsar-download", daemon=True).start()
    return {"started": names}


@app.delete("/models/caption")
async def delete_caption_model():
    await run_in_threadpool(S.models.set_captions, False)
    config.CAPTIONS_ENABLED = False
    ok = await run_in_threadpool(storage.delete_model, config.CAPTION_MODEL)
    PROGRESS.set(config.CAPTION_MODEL, state="missing", done=0, total=0)
    return {"deleted": ok}


@app.exception_handler(Exception)
async def _unhandled(_, exc: Exception):
    log.exception("unhandled")
    return JSONResponse({"error": str(exc)}, status_code=500)


def main(argv: list[str] | None = None) -> None:
    global _initial_root
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", help="add this folder as a library if not already present")
    ap.add_argument("--port", type=int, default=int(os.environ.get("OBSAR_PORT", "8765")))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-captions", action="store_true", help="skip the caption/OCR model (faster, visual only)")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--version", action="version", version=f"obsar {__version__}")
    args = ap.parse_args(argv)
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    try:
        from logging.handlers import RotatingFileHandler

        logdir = config.data_dir() / "logs"
        logdir.mkdir(parents=True, exist_ok=True)
        handlers.append(RotatingFileHandler(logdir / "backend.log", maxBytes=2_000_000, backupCount=2, encoding="utf-8"))
    except OSError:
        pass
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
    )
    log.info("obsar %s starting (data=%s)", __version__, config.data_dir())
    for n in ("watchdog", "httpx", "httpx2", "httpcore", "urllib3", "filelock", "huggingface_hub"):
        logging.getLogger(n).setLevel(logging.WARNING)
    if args.no_captions or os.environ.get("OBSAR_CAPTIONS") == "0":
        config.CAPTIONS_ENABLED = False
    if args.root:
        _initial_root = args.root
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
