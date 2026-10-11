"""Watch every library root and feed changes to the indexer with debouncing."""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer
from watchdog.observers.api import ObservedWatch

from . import config
from .indexer import Indexer

log = logging.getLogger(__name__)


class _Handler(FileSystemEventHandler):
    def __init__(self, indexer: Indexer):
        self.indexer = indexer
        self._timers: dict[str, threading.Timer] = {}
        self._lock = threading.Lock()

    def _schedule(self, path: str) -> None:
        with self._lock:
            t = self._timers.pop(path, None)
            if t:
                t.cancel()
            t = threading.Timer(config.WATCH_DEBOUNCE_S, self._settle, args=(path,))
            t.daemon = True
            self._timers[path] = t
            t.start()

    def _settle(self, path: str) -> None:
        """Wait until the file stops growing (copies in progress), then enqueue."""
        with self._lock:
            self._timers.pop(path, None)
        p = Path(path)
        if not p.exists():
            return
        last = -1
        for _ in range(40):  # up to ~20 s for large video copies
            try:
                size = p.stat().st_size
            except OSError:
                return
            if size == last and size > 0:
                break
            last = size
            time.sleep(0.5)
        self.indexer.enqueue_path(p)

    def on_created(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            self._scan_dir(Path(event.src_path))
        else:
            self._schedule(event.src_path)

    def on_modified(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._schedule(event.src_path)

    def on_deleted(self, event: FileSystemEvent) -> None:
        self.indexer.remove_path(Path(event.src_path))

    def on_moved(self, event: FileSystemEvent) -> None:
        self.indexer.rename_path(Path(event.src_path), Path(event.dest_path))
        if not event.is_directory and config.kind_for(Path(event.dest_path)):
            self._schedule(event.dest_path)

    def _scan_dir(self, d: Path) -> None:
        for p in d.rglob("*"):
            if p.is_file() and config.kind_for(p):
                self._schedule(str(p))


class Watcher:
    """One observer thread, one scheduled watch per library."""

    def __init__(self, indexer: Indexer):
        self.indexer = indexer
        self._obs: Observer | None = None
        self._watches: dict[int, ObservedWatch] = {}
        self._handler = _Handler(indexer)

    def _ensure(self) -> Observer:
        if self._obs is None or not self._obs.is_alive():
            self._obs = Observer()
            self._obs.daemon = True
            self._obs.start()
            self._watches.clear()
        return self._obs

    def add(self, lid: int, root: Path) -> None:
        self.remove(lid)
        if not root.exists():
            return
        obs = self._ensure()
        self._watches[lid] = obs.schedule(self._handler, str(root), recursive=True)
        log.info("watching library %d: %s", lid, root)

    def remove(self, lid: int) -> None:
        w = self._watches.pop(lid, None)
        if w and self._obs:
            try:
                self._obs.unschedule(w)
            except Exception:
                pass

    def sync(self, libraries: dict[int, Path]) -> None:
        for lid in list(self._watches):
            if lid not in libraries:
                self.remove(lid)
        for lid, root in libraries.items():
            if lid not in self._watches:
                self.add(lid, root)

    def stop(self) -> None:
        if self._obs:
            try:
                self._obs.stop()
                self._obs.join(timeout=2)
            except Exception:
                pass
            self._obs = None
            self._watches.clear()

    def watching(self, lid: int) -> bool:
        return lid in self._watches and bool(self._obs and self._obs.is_alive())
