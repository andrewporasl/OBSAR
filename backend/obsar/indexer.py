"""Library reconciliation, work queue and the GPU worker that fills the index."""
from __future__ import annotations

import logging
import os
import queue
import threading
import time
from pathlib import Path

import numpy as np

from . import config, media, thumbs
from .db import DB
from .models import Captioner, Embedder, ModelManager

log = logging.getLogger(__name__)

SKIP_DIRS = {"node_modules", "$recycle.bin", "system volume information", ".git"}


class VectorStore:
    """In-memory matrix of all frame vectors, rebuilt from SQLite when dirty."""

    def __init__(self, db: DB):
        self.db = db
        self._lock = threading.Lock()
        self._dirty = True
        self.mat = np.zeros((0, 0), dtype=np.float32)
        self.ids = np.zeros((0,), dtype=np.int64)

    def invalidate(self) -> None:
        with self._lock:
            self._dirty = True

    def get(self) -> tuple[np.ndarray, np.ndarray]:
        with self._lock:
            if self._dirty:
                t = time.time()
                self.mat, self.ids = self.db.load_all_vectors()
                self._dirty = False
                log.debug("vector store rebuilt: %d frames in %.0f ms", len(self.ids), (time.time() - t) * 1000)
            return self.mat, self.ids


class Indexer:
    def __init__(self, db: DB, models: ModelManager, store: VectorStore):
        self.db = db
        self.models = models
        self.store = store
        self.libraries: dict[int, Path] = {}
        self.q: queue.Queue[int] = queue.Queue()
        self._queued: set[int] = set()
        self._qlock = threading.Lock()
        self._stop = threading.Event()
        self._paused: set[int] = set()
        self._thread: threading.Thread | None = None
        self.current: str | None = None
        self.current_library: int | None = None
        self.last_error: str | None = None
        self.syncing: set[int] = set()

    @property
    def embedder(self) -> Embedder:
        return self.models.embedder

    @property
    def captioner(self) -> Captioner | None:
        return self.models.captioner

    # ---- lifecycle ------------------------------------------------------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="obsar-indexer", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    # ---- libraries ------------------------------------------------------
    def load_libraries(self) -> None:
        self.libraries = {r["id"]: Path(r["path"]) for r in self.db.list_libraries() if r["enabled"]}

    def library_for(self, path: Path) -> int | None:
        best, best_len = None, -1
        sp = str(path)
        for lid, root in self.libraries.items():
            r = str(root)
            if (sp == r or sp.startswith(r.rstrip(os.sep) + os.sep)) and len(r) > best_len:
                best, best_len = lid, len(r)
        return best

    def pause(self, lid: int, paused: bool) -> None:
        if paused:
            self._paused.add(lid)
        else:
            self._paused.discard(lid)
            for fid in self.db.pending_ids(lid):
                self.enqueue_id(fid)

    # ---- queueing -------------------------------------------------------
    def enqueue_id(self, file_id: int) -> None:
        with self._qlock:
            if file_id in self._queued:
                return
            self._queued.add(file_id)
        self.q.put(file_id)

    def enqueue_path(self, path: Path) -> None:
        kind = config.kind_for(path)
        if not kind:
            return
        lid = self.library_for(path)
        if lid is None:
            return
        try:
            st = path.stat()
        except OSError:
            return
        if st.st_size == 0:
            return
        existing = self.db.get_file_by_path(str(path))
        if existing and existing["status"] == "done" and existing["size"] == st.st_size and abs(existing["mtime"] - st.st_mtime) < 1e-3:
            return
        fid = self.db.upsert_pending(str(path), kind, st.st_size, st.st_mtime, lid)
        self.enqueue_id(fid)

    def remove_path(self, path: Path) -> None:
        fid = self.db.delete_path(str(path))
        if fid is None:
            removed = self.db.delete_prefix(str(path) + os.sep)
            if removed:
                self.store.invalidate()
            return
        self.store.invalidate()

    def rename_path(self, old: Path, new: Path) -> None:
        if config.kind_for(new) is None:
            if new.is_dir():
                prefix_old = str(old) + os.sep
                for p, row in self.db.all_files_meta().items():
                    if p.startswith(prefix_old):
                        self.db.rename_path(p, str(new) + os.sep + p[len(prefix_old):])
                return
            self.remove_path(old)
            return
        if self.db.rename_path(str(old), str(new)) is None:
            self.enqueue_path(new)

    # ---- reconcile ------------------------------------------------------
    def reconcile(self, lid: int, full: bool = False) -> dict[str, int]:
        """Walk one library root, enqueue new/changed files, drop rows whose file vanished."""
        root = self.libraries.get(lid)
        if root is None:
            return {"added": 0, "removed": 0, "missing_root": 1}
        if not root.exists():
            log.warning("library %d root missing: %s", lid, root)
            return {"added": 0, "removed": 0, "missing_root": 1}
        self.syncing.add(lid)
        try:
            known = self.db.all_files_meta(lid)
            seen: set[str] = set()
            added = 0
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if not d.startswith(".") and d.lower() not in SKIP_DIRS]
                for fn in filenames:
                    p = Path(dirpath) / fn
                    kind = config.kind_for(p)
                    if not kind:
                        continue
                    sp = str(p)
                    seen.add(sp)
                    try:
                        st = p.stat()
                    except OSError:
                        continue
                    row = known.get(sp)
                    unchanged = row is not None and row["size"] == st.st_size and abs(row["mtime"] - st.st_mtime) < 1e-3
                    if unchanged and not full and row["status"] in ("done", "error"):
                        continue
                    fid = self.db.upsert_pending(sp, kind, st.st_size, st.st_mtime, lid)
                    if lid not in self._paused:
                        self.enqueue_id(fid)
                    added += 1
            gone = [row["id"] for p, row in known.items() if p not in seen]
            if gone:
                self.db.delete_ids(gone)
                self.store.invalidate()
            self.db.touch_library(lid)
            log.info("reconcile %s: %d queued, %d removed, %d total", root.name, added, len(gone), len(seen))
            return {"added": added, "removed": len(gone), "missing_root": 0}
        finally:
            self.syncing.discard(lid)

    def reconcile_all(self) -> None:
        for lid in list(self.libraries):
            try:
                self.reconcile(lid)
            except Exception:
                log.exception("reconcile failed for library %d", lid)

    def purge_library_files(self, rows: list[tuple[int, float]]) -> None:
        for fid, mtime in rows:
            for p in (thumbs.thumb_path(fid, mtime), thumbs.preview_path(fid, mtime)):
                try:
                    p.unlink(missing_ok=True)
                except OSError:
                    pass
        self.store.invalidate()

    def status(self) -> dict:
        c = self.db.counts()
        per = self.db.counts_by_library()
        libs = {}
        for lid, root in self.libraries.items():
            d = per.get(lid, {"pending": 0, "done": 0, "error": 0, "total": 0})
            d = dict(d)
            d["syncing"] = lid in self.syncing or (d["pending"] > 0 and lid not in self._paused)
            d["paused"] = lid in self._paused
            d["exists"] = root.exists()
            d["current"] = self.current if self.current_library == lid else None
            libs[lid] = d
        return {
            **c,
            "queued": self.q.qsize(),
            "current": self.current,
            "libraries": libs,
            "models_loaded": self.models.loaded,
            "last_error": self.last_error,
        }

    # ---- worker ---------------------------------------------------------
    def _run(self) -> None:
        try:
            self.models.load()
        except Exception as e:  # pragma: no cover
            log.exception("model load failed")
            self.last_error = f"model load failed: {e}"
            return
        while not self._stop.is_set():
            try:
                fid = self.q.get(timeout=0.5)
            except queue.Empty:
                continue
            with self._qlock:
                self._queued.discard(fid)
            try:
                self._process(fid)
            except Exception as e:
                log.exception("index failed for id=%s", fid)
                self.last_error = str(e)
                self.db.mark_error(fid, str(e))
            finally:
                self.current = None
                self.current_library = None

    def _process(self, fid: int) -> None:
        row = self.db.get_file(fid)
        if row is None:
            return
        lid = row["library_id"]
        if lid in self._paused or lid not in self.libraries:
            return  # stays pending; resumed later
        path = Path(row["path"])
        if not path.exists():
            self.db.delete_path(str(path))
            self.store.invalidate()
            return
        self.current = path.name
        self.current_library = lid
        t0 = time.time()
        d = media.decode(path)
        vecs = self.embedder.embed_images(d.frames)
        caption, ocr = "", ""
        if self.captioner:
            if len(d.frames) == 1:
                rep = d.frames
            else:
                n = len(d.frames)
                rep = [d.frames[0], d.frames[n // 2], d.frames[-1]] if n >= 3 else d.frames
            caption, ocr = self.captioner.describe(rep)
        self.db.store_indexed(
            fid, path=str(path), width=d.width, height=d.height, duration=d.duration,
            caption=caption, ocr=ocr, vectors=vecs,
        )
        thumbs.write_thumb(fid, row["mtime"], d.frames[len(d.frames) // 2])
        self.store.invalidate()
        log.info("indexed %s (%d frames) in %.1fs", path.name, len(d.frames), time.time() - t0)
