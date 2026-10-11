"""Hybrid ranking: SigLIP visual similarity fused with FTS over caption/OCR/filename."""
from __future__ import annotations

import sqlite3

import numpy as np

from .db import DB
from .indexer import VectorStore
from .models import Embedder

VIS_WEIGHT = 0.65
TEXT_WEIGHT = 0.35
BOTH_BONUS = 0.08


def row_to_dict(r: sqlite3.Row, score: float | None = None, vis: float | None = None, txt: float | None = None) -> dict:
    d = {
        "id": r["id"],
        "library_id": r["library_id"],
        "path": r["path"],
        "name": r["path"].replace("\\", "/").rsplit("/", 1)[-1],
        "kind": r["kind"],
        "size": r["size"],
        "mtime": r["mtime"],
        "width": r["width"],
        "height": r["height"],
        "duration": r["duration"],
        "caption": r["caption"] or "",
        "ocr": r["ocr"] or "",
        "thumb": f"/thumb/{r['id']}",
        "preview": f"/preview/{r['id']}" if r["kind"] in ("gif", "video") else None,
    }
    if score is not None:
        d["score"] = round(float(score), 4)
        d["vis"] = round(float(vis or 0), 4)
        d["txt"] = round(float(txt or 0), 4)
    return d


class Searcher:
    def __init__(self, db: DB, embedder: Embedder, store: VectorStore):
        self.db = db
        self.embedder = embedder
        self.store = store

    def search(self, q: str, kind: str = "all", limit: int = 60, library: int | None = None) -> list[dict]:
        q = q.strip()
        if not q:
            return [row_to_dict(r) for r in self.db.recent(limit, kind, library)]
        enabled = self.db.enabled_library_ids()

        # 1. visual: max-pool frame similarity per file
        vis: dict[int, float] = {}
        mat, ids = self.store.get()
        if len(ids):
            qv = self.embedder.embed_text([q])[0]
            sims = mat @ qv  # cosine, vectors are normalised
            # SigLIP cosine values are small (~0.0-0.3); rescale softly to 0..1
            for fid, s in zip(ids.tolist(), sims.tolist()):
                if s > vis.get(fid, -1):
                    vis[fid] = s
        if vis:
            arr = np.fromiter(vis.values(), dtype=np.float32)
            lo, hi = float(arr.min()), float(arr.max())
            span = (hi - lo) or 1.0
            # keep absolute signal too: a query nothing matches shouldn't make noise look great
            vis_norm = {fid: 0.5 * ((s - lo) / span) + 0.5 * min(max((s - 0.0) / 0.25, 0.0), 1.0) for fid, s in vis.items()}
        else:
            vis_norm = {}

        # 2. text: bm25 over caption/ocr/filename
        txt_raw = self.db.fts_search(q, limit=300)
        txt_norm: dict[int, float] = {}
        if txt_raw:
            scores = np.array([s for _, s in txt_raw], dtype=np.float32)
            lo, hi = float(scores.min()), float(scores.max())
            span = (hi - lo) or 1.0
            for (fid, s) in txt_raw:
                txt_norm[fid] = 0.6 + 0.4 * ((s - lo) / span) if span > 0 else 1.0

        # 3. fuse
        fused: dict[int, float] = {}
        for fid in set(vis_norm) | set(txt_norm):
            v = vis_norm.get(fid, 0.0)
            t = txt_norm.get(fid, 0.0)
            score = VIS_WEIGHT * v + TEXT_WEIGHT * t
            if fid in vis_norm and fid in txt_norm:
                score += BOTH_BONUS
            fused[fid] = score

        top = sorted(fused.items(), key=lambda kv: kv[1], reverse=True)
        # over-fetch so kind filtering still fills the page
        cand_ids = [fid for fid, _ in top[: limit * 3]]
        rows = self.db.rows_by_ids(cand_ids)
        out: list[dict] = []
        for fid, score in top:
            r = rows.get(fid)
            if not r or r["status"] != "done":
                continue
            if kind != "all" and r["kind"] != kind:
                continue
            if r["library_id"] not in enabled or (library is not None and r["library_id"] != library):
                continue
            out.append(row_to_dict(r, score, vis.get(fid), txt_norm.get(fid)))
            if len(out) >= limit:
                break
        return out

    def similar(self, file_id: int, limit: int = 30) -> list[dict]:
        mat, ids = self.store.get()
        if not len(ids):
            return []
        mask = ids == file_id
        if not mask.any():
            return []
        qv = mat[mask].mean(axis=0)
        qv /= np.linalg.norm(qv) or 1.0
        sims = mat @ qv
        best: dict[int, float] = {}
        for fid, s in zip(ids.tolist(), sims.tolist()):
            if fid != file_id and s > best.get(fid, -1):
                best[fid] = s
        top = sorted(best.items(), key=lambda kv: kv[1], reverse=True)[:limit]
        rows = self.db.rows_by_ids([f for f, _ in top])
        return [row_to_dict(rows[f], s, s, 0) for f, s in top if f in rows]
