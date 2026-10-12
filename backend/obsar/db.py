from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path
from typing import Iterable

import numpy as np

from .config import db_path

SCHEMA = """
CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    added_at REAL NOT NULL,
    last_synced REAL,
    enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    library_id INTEGER REFERENCES libraries(id),
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL,
    width INTEGER,
    height INTEGER,
    duration REAL,
    caption TEXT DEFAULT '',
    ocr TEXT DEFAULT '',
    indexed_at REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT
);
CREATE INDEX IF NOT EXISTS files_status ON files(status);
CREATE INDEX IF NOT EXISTS files_library ON files(library_id);

CREATE TABLE IF NOT EXISTS embeddings (
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    frame_idx INTEGER NOT NULL,
    vec BLOB NOT NULL,
    PRIMARY KEY (file_id, frame_idx)
);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    caption, ocr, filename,
    tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def _fts_filename(path: str) -> str:
    return Path(path).stem.replace("_", " ").replace("-", " ").replace(".", " ")


def _norm(path: str) -> str:
    return str(Path(path).resolve())


class DB:
    """Thread-safe wrapper over one SQLite connection."""

    def __init__(self, path: Path | None = None):
        self.path = path or db_path()
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.conn.execute("PRAGMA foreign_keys=ON")
            self._migrate_pre()
            self.conn.executescript(SCHEMA)
            self._migrate_post()

    # ---- migrations -----------------------------------------------------
    def _migrate_pre(self) -> None:
        """Runs before SCHEMA: fix up tables whose shape changed since v0.1."""
        row = self.conn.execute("SELECT sql FROM sqlite_master WHERE name='files_fts'").fetchone()
        if row and "content=''" in (row["sql"] or ""):
            # contentless FTS cannot delete rows; rebuild as a normal table
            self.conn.execute("DROP TABLE files_fts")
            self.conn.execute("CREATE VIRTUAL TABLE files_fts USING fts5(caption, ocr, filename, tokenize='trigram')")
            for f in self.conn.execute("SELECT id, path, caption, ocr FROM files WHERE status='done'"):
                self.conn.execute(
                    "INSERT INTO files_fts(rowid, caption, ocr, filename) VALUES(?,?,?,?)",
                    (f["id"], f["caption"] or "", f["ocr"] or "", _fts_filename(f["path"])),
                )
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(files)")}
        if cols and "library_id" not in cols:
            self.conn.execute("CREATE TABLE IF NOT EXISTS libraries (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, added_at REAL NOT NULL, last_synced REAL, enabled INTEGER NOT NULL DEFAULT 1)")
            self.conn.execute("ALTER TABLE files ADD COLUMN library_id INTEGER REFERENCES libraries(id)")
        self.conn.commit()

    def _migrate_post(self) -> None:
        """v0.1 stored a single root in settings; turn it into library 1 and claim its files."""
        root = self.conn.execute("SELECT value FROM settings WHERE key='root'").fetchone()
        has_libs = self.conn.execute("SELECT COUNT(*) FROM libraries").fetchone()[0]
        if root and root["value"] and not has_libs:
            p = _norm(root["value"])
            self.conn.execute(
                "INSERT INTO libraries(path, added_at, last_synced, enabled) VALUES(?,?,?,1)", (p, time.time(), None)
            )
            lid = self.conn.execute("SELECT id FROM libraries WHERE path=?", (p,)).fetchone()["id"]
            self.conn.execute("UPDATE files SET library_id=? WHERE library_id IS NULL", (lid,))
            self.conn.execute("DELETE FROM settings WHERE key='root'")
        # orphan rows (no library) are useless: drop them
        orphans = [r["id"] for r in self.conn.execute("SELECT id FROM files WHERE library_id IS NULL")]
        for fid in orphans:
            self._delete_id(fid)
        self.conn.commit()

    # ---- settings -------------------------------------------------------
    def get_setting(self, key: str, default: str | None = None) -> str | None:
        with self.lock:
            row = self.conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self.lock:
            self.conn.execute(
                "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )
            self.conn.commit()

    # ---- libraries ------------------------------------------------------
    def list_libraries(self) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute("SELECT * FROM libraries ORDER BY added_at").fetchall()

    def get_library(self, lid: int) -> sqlite3.Row | None:
        with self.lock:
            return self.conn.execute("SELECT * FROM libraries WHERE id=?", (lid,)).fetchone()

    def enabled_library_ids(self) -> set[int]:
        with self.lock:
            return {r["id"] for r in self.conn.execute("SELECT id FROM libraries WHERE enabled=1")}

    def add_library(self, path: str) -> sqlite3.Row:
        p = _norm(path)
        with self.lock:
            row = self.conn.execute("SELECT * FROM libraries WHERE path=?", (p,)).fetchone()
            if row:
                self.conn.execute("UPDATE libraries SET enabled=1 WHERE id=?", (row["id"],))
            else:
                self.conn.execute("INSERT INTO libraries(path, added_at, enabled) VALUES(?,?,1)", (p, time.time()))
            self.conn.commit()
            return self.conn.execute("SELECT * FROM libraries WHERE path=?", (p,)).fetchone()

    def set_library_enabled(self, lid: int, enabled: bool) -> None:
        with self.lock:
            self.conn.execute("UPDATE libraries SET enabled=? WHERE id=?", (1 if enabled else 0, lid))
            self.conn.commit()

    def touch_library(self, lid: int) -> None:
        with self.lock:
            self.conn.execute("UPDATE libraries SET last_synced=? WHERE id=?", (time.time(), lid))
            self.conn.commit()

    def remove_library(self, lid: int, delete_data: bool) -> list[tuple[int, float]]:
        """Returns [(file_id, mtime)] of deleted rows so the caller can purge thumbnails."""
        with self.lock:
            if not delete_data:
                self.conn.execute("UPDATE libraries SET enabled=0 WHERE id=?", (lid,))
                self.conn.commit()
                return []
            rows = self.conn.execute("SELECT id, mtime FROM files WHERE library_id=?", (lid,)).fetchall()
            for r in rows:
                self._delete_id(r["id"])
            self.conn.execute("DELETE FROM libraries WHERE id=?", (lid,))
            self.conn.commit()
            return [(r["id"], r["mtime"]) for r in rows]

    def library_stats(self, lid: int) -> dict:
        with self.lock:
            kinds = {r["kind"]: r["n"] for r in self.conn.execute(
                "SELECT kind, COUNT(*) AS n FROM files WHERE library_id=? GROUP BY kind", (lid,))}
            st = {r["status"]: r["n"] for r in self.conn.execute(
                "SELECT status, COUNT(*) AS n FROM files WHERE library_id=? GROUP BY status", (lid,))}
            media = self.conn.execute("SELECT COALESCE(SUM(size),0) FROM files WHERE library_id=?", (lid,)).fetchone()[0]
            emb = self.conn.execute(
                "SELECT COUNT(*), COALESCE(SUM(length(vec)),0) FROM embeddings WHERE file_id IN (SELECT id FROM files WHERE library_id=?)",
                (lid,)).fetchone()
            txt = self.conn.execute(
                "SELECT COALESCE(SUM(length(caption)+length(ocr)),0) FROM files WHERE library_id=?", (lid,)).fetchone()[0]
        return {
            "images": kinds.get("image", 0), "gifs": kinds.get("gif", 0), "videos": kinds.get("video", 0),
            "pending": st.get("pending", 0), "done": st.get("done", 0), "error": st.get("error", 0),
            "total": sum(st.values()), "media_bytes": media, "frames": emb[0],
            "vector_bytes": emb[1], "text_bytes": txt,
        }

    def file_ids_mtimes(self, lid: int) -> list[tuple[int, float]]:
        with self.lock:
            return [(r["id"], r["mtime"]) for r in self.conn.execute("SELECT id, mtime FROM files WHERE library_id=?", (lid,))]

    # ---- files ----------------------------------------------------------
    def all_files_meta(self, lid: int | None = None) -> dict[str, sqlite3.Row]:
        with self.lock:
            if lid is None:
                rows = self.conn.execute("SELECT id, path, size, mtime, status, library_id FROM files").fetchall()
            else:
                rows = self.conn.execute(
                    "SELECT id, path, size, mtime, status, library_id FROM files WHERE library_id=?", (lid,)).fetchall()
        return {r["path"]: r for r in rows}

    def get_file(self, file_id: int) -> sqlite3.Row | None:
        with self.lock:
            return self.conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()

    def get_file_by_path(self, path: str) -> sqlite3.Row | None:
        with self.lock:
            return self.conn.execute("SELECT * FROM files WHERE path=?", (path,)).fetchone()

    def upsert_pending(self, path: str, kind: str, size: int, mtime: float, lid: int) -> int:
        with self.lock:
            self.conn.execute(
                """INSERT INTO files(path, library_id, kind, size, mtime, status)
                   VALUES(?,?,?,?,?,'pending')
                   ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, size=excluded.size, library_id=excluded.library_id,
                       mtime=excluded.mtime, status='pending', error=NULL""",
                (path, lid, kind, size, mtime),
            )
            fid = self.conn.execute("SELECT id FROM files WHERE path=?", (path,)).fetchone()["id"]
            self.conn.commit()
            return fid

    def set_pending(self, file_id: int) -> None:
        with self.lock:
            self.conn.execute("UPDATE files SET status='pending', error=NULL WHERE id=?", (file_id,))
            self.conn.commit()

    def set_all_pending(self, lid: int) -> list[int]:
        with self.lock:
            ids = [r["id"] for r in self.conn.execute("SELECT id FROM files WHERE library_id=?", (lid,))]
            self.conn.execute("UPDATE files SET status='pending', error=NULL WHERE library_id=?", (lid,))
            self.conn.commit()
            return ids

    def mark_error(self, file_id: int, msg: str) -> None:
        with self.lock:
            self.conn.execute("UPDATE files SET status='error', error=? WHERE id=?", (msg[:500], file_id))
            self.conn.commit()

    def _delete_id(self, fid: int) -> None:
        self.conn.execute("DELETE FROM files_fts WHERE rowid=?", (fid,))
        self.conn.execute("DELETE FROM embeddings WHERE file_id=?", (fid,))
        self.conn.execute("DELETE FROM files WHERE id=?", (fid,))

    def delete_path(self, path: str) -> int | None:
        with self.lock:
            row = self.conn.execute("SELECT id FROM files WHERE path=?", (path,)).fetchone()
            if not row:
                return None
            self._delete_id(row["id"])
            self.conn.commit()
            return row["id"]

    def delete_prefix(self, prefix: str) -> list[int]:
        """Remove every file whose path starts with prefix (a moved or deleted directory)."""
        with self.lock:
            rows = self.conn.execute("SELECT id, path FROM files").fetchall()
            ids = [r["id"] for r in rows if r["path"].startswith(prefix)]
            for fid in ids:
                self._delete_id(fid)
            self.conn.commit()
            return ids

    def delete_ids(self, ids: Iterable[int]) -> None:
        with self.lock:
            for fid in ids:
                self._delete_id(fid)
            self.conn.commit()

    def rename_path(self, old: str, new: str) -> int | None:
        with self.lock:
            row = self.conn.execute("SELECT id, caption, ocr FROM files WHERE path=?", (old,)).fetchone()
            if not row:
                return None
            fid = row["id"]
            self.conn.execute("UPDATE files SET path=? WHERE id=?", (new, fid))
            self.conn.execute("DELETE FROM files_fts WHERE rowid=?", (fid,))
            self.conn.execute(
                "INSERT INTO files_fts(rowid, caption, ocr, filename) VALUES(?,?,?,?)",
                (fid, row["caption"] or "", row["ocr"] or "", _fts_filename(new)),
            )
            self.conn.commit()
            return fid

    def store_indexed(
        self, file_id: int, *, path: str, width: int, height: int, duration: float | None,
        caption: str, ocr: str, vectors: np.ndarray,
    ) -> None:
        vecs16 = np.ascontiguousarray(vectors.astype(np.float16))
        with self.lock:
            self.conn.execute("DELETE FROM embeddings WHERE file_id=?", (file_id,))
            self.conn.executemany(
                "INSERT INTO embeddings(file_id, frame_idx, vec) VALUES(?,?,?)",
                [(file_id, i, vecs16[i].tobytes()) for i in range(vecs16.shape[0])],
            )
            self.conn.execute(
                """UPDATE files SET width=?, height=?, duration=?, caption=?, ocr=?,
                   indexed_at=?, status='done', error=NULL WHERE id=?""",
                (width, height, duration, caption, ocr, time.time(), file_id),
            )
            self.conn.execute("DELETE FROM files_fts WHERE rowid=?", (file_id,))
            self.conn.execute(
                "INSERT INTO files_fts(rowid, caption, ocr, filename) VALUES(?,?,?,?)",
                (file_id, caption, ocr, _fts_filename(path)),
            )
            self.conn.commit()

    def pending_ids(self, lid: int | None = None) -> list[int]:
        with self.lock:
            if lid is None:
                rows = self.conn.execute("SELECT id FROM files WHERE status='pending' ORDER BY mtime DESC").fetchall()
            else:
                rows = self.conn.execute(
                    "SELECT id FROM files WHERE status='pending' AND library_id=? ORDER BY mtime DESC", (lid,)).fetchall()
        return [r["id"] for r in rows]

    def counts(self) -> dict[str, int]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT status, COUNT(*) AS n FROM files WHERE library_id IN (SELECT id FROM libraries WHERE enabled=1) GROUP BY status"
            ).fetchall()
        out = {"pending": 0, "done": 0, "error": 0}
        for r in rows:
            out[r["status"]] = r["n"]
        out["total"] = sum(out.values())
        return out

    def counts_by_library(self) -> dict[int, dict[str, int]]:
        with self.lock:
            rows = self.conn.execute("SELECT library_id, status, COUNT(*) AS n FROM files GROUP BY library_id, status").fetchall()
        out: dict[int, dict[str, int]] = {}
        for r in rows:
            d = out.setdefault(r["library_id"], {"pending": 0, "done": 0, "error": 0, "total": 0})
            d[r["status"]] = r["n"]
            d["total"] += r["n"]
        return out

    # ---- vectors --------------------------------------------------------
    def load_all_vectors(self) -> tuple[np.ndarray, np.ndarray]:
        """Return (matrix[N, D] float32, file_ids[N] int64) for enabled libraries only."""
        with self.lock:
            rows = self.conn.execute(
                "SELECT e.file_id, e.vec FROM embeddings e JOIN files f ON f.id=e.file_id "
                "WHERE f.library_id IN (SELECT id FROM libraries WHERE enabled=1)"
            ).fetchall()
        if not rows:
            return np.zeros((0, 0), dtype=np.float32), np.zeros((0,), dtype=np.int64)
        ids = np.fromiter((r["file_id"] for r in rows), dtype=np.int64, count=len(rows))
        mat = np.stack([np.frombuffer(r["vec"], dtype=np.float16) for r in rows]).astype(np.float32)
        return mat, ids

    @staticmethod
    def _browse_where(kind: str | None, lid: int | None) -> tuple[str, list]:
        q = " WHERE status='done' AND library_id IN (SELECT id FROM libraries WHERE enabled=1)"
        args: list = []
        if kind and kind != "all":
            q += " AND kind=?"
            args.append(kind)
        if lid is not None:
            q += " AND library_id=?"
            args.append(lid)
        return q, args

    def recent(self, limit: int, kind: str | None, lid: int | None = None, offset: int = 0) -> list[sqlite3.Row]:
        where, args = self._browse_where(kind, lid)
        q = "SELECT * FROM files" + where + " ORDER BY mtime DESC, id DESC LIMIT ? OFFSET ?"
        args += [limit, offset]
        with self.lock:
            return self.conn.execute(q, args).fetchall()

    def browse_count(self, kind: str | None, lid: int | None = None) -> int:
        where, args = self._browse_where(kind, lid)
        with self.lock:
            return int(self.conn.execute("SELECT COUNT(*) FROM files" + where, args).fetchone()[0])

    def fts_search(self, query: str, limit: int = 200) -> list[tuple[int, float]]:
        """Return [(file_id, score)] with higher = better."""
        q = query.strip()
        if not q:
            return []
        if len(q) < 3:
            like = f"%{q}%"
            with self.lock:
                rows = self.conn.execute(
                    "SELECT id FROM files WHERE status='done' AND (caption LIKE ? OR ocr LIKE ? OR path LIKE ?) LIMIT ?",
                    (like, like, like, limit),
                ).fetchall()
            return [(r["id"], 1.0) for r in rows]
        terms = [t.replace('"', '""') for t in q.split() if len(t) >= 3]
        if not terms:
            terms = [q.replace('"', '""')]
        quoted = [f'"{t}"' for t in terms]

        def run(match: str) -> list[tuple[int, float]]:
            with self.lock:
                try:
                    rows = self.conn.execute(
                        "SELECT rowid, bm25(files_fts, 2.0, 2.0, 1.5) AS s FROM files_fts WHERE files_fts MATCH ? ORDER BY s LIMIT ?",
                        (match, limit),
                    ).fetchall()
                except sqlite3.OperationalError:
                    return []
            return [(r["rowid"], -float(r["s"])) for r in rows]

        strict = run(" AND ".join(quoted))
        if len(quoted) == 1 or len(strict) >= 3:
            return strict
        loose = run(" OR ".join(quoted))
        seen = {fid for fid, _ in strict}
        bonus = max((s for _, s in loose), default=0.0) + 1.0
        return [(fid, s + bonus) for fid, s in strict] + [(fid, s) for fid, s in loose if fid not in seen]

    def rows_by_ids(self, ids: Iterable[int]) -> dict[int, sqlite3.Row]:
        ids = list(ids)
        out: dict[int, sqlite3.Row] = {}
        if not ids:
            return out
        with self.lock:
            for i in range(0, len(ids), 500):
                chunk = ids[i : i + 500]
                marks = ",".join("?" * len(chunk))
                for r in self.conn.execute(f"SELECT * FROM files WHERE id IN ({marks})", chunk):
                    out[r["id"]] = r
        return out
