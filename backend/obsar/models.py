"""Lazy-loaded local models: SigLIP2 for embeddings, Qwen2.5-VL for caption + OCR.
Also the first-run downloader with byte-level progress for the Setup screen."""
from __future__ import annotations

import logging
import re
import threading

import numpy as np
from PIL import Image

from . import config

log = logging.getLogger(__name__)

CAPTION_PROMPT = (
    "Look at this image. Reply in exactly this format and nothing else:\n"
    "CAPTION: <one detailed sentence describing the scene, subjects, colors, mood, any famous people or characters, and whether it looks like a meme or screenshot>\n"
    "TEXT: <all visible text transcribed verbatim, or NONE>"
)


def _device():
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


def _from_pretrained(cls, name: str, **kw):
    """Load from the local HF cache first (fast, no network); fall back to downloading."""
    try:
        return cls.from_pretrained(name, local_files_only=True, **kw)
    except Exception:
        log.info("%s not in local cache, downloading...", name)
        return cls.from_pretrained(name, **kw)


def _feats(out):
    """transformers>=5 returns an output object from get_*_features; older returns a tensor."""
    if hasattr(out, "pooler_output") and out.pooler_output is not None:
        return out.pooler_output
    if hasattr(out, "image_embeds"):
        return out.image_embeds
    if hasattr(out, "text_embeds"):
        return out.text_embeds
    return out


# ---- download progress ----------------------------------------------------
class DownloadProgress:
    """Shared counters that /status reports while models download."""

    def __init__(self):
        self.lock = threading.Lock()
        self.state: dict[str, dict] = {}  # name -> {state, done, total, error}

    def snapshot(self) -> dict[str, dict]:
        with self.lock:
            return {k: dict(v) for k, v in self.state.items()}

    def set(self, name: str, **kw) -> None:
        with self.lock:
            self.state.setdefault(name, {"state": "missing", "done": 0, "total": 0, "error": None}).update(kw)

    def add(self, name: str, n: int) -> None:
        with self.lock:
            d = self.state.setdefault(name, {"state": "downloading", "done": 0, "total": 0, "error": None})
            d["done"] += n


PROGRESS = DownloadProgress()


def _watch_disk(name: str, stop: threading.Event) -> None:
    """Report bytes on disk for the model as 'done' while a download runs. Exact, no double counting."""
    from . import storage

    d = storage._model_dir(name)
    while not stop.wait(1.0):
        PROGRESS.set(name, done=storage.dir_size(d, ttl=0))


def model_total_bytes(name: str) -> int:
    from huggingface_hub import HfApi

    info = HfApi().model_info(name, files_metadata=True)
    return sum((s.size or 0) for s in (info.siblings or []))


def ensure_model(name: str) -> None:
    """Download one model into HF_HOME with progress; no-op when present."""
    from . import storage

    if storage.model_present(name):
        storage.prune_incomplete(name)
        PROGRESS.set(name, state="ready", done=0, total=0)
        return
    PROGRESS.set(name, state="downloading", done=0, total=0, error=None)
    try:
        try:
            PROGRESS.set(name, total=model_total_bytes(name))
        except Exception:
            pass
        from huggingface_hub import snapshot_download

        stop = threading.Event()
        threading.Thread(target=_watch_disk, args=(name, stop), daemon=True).start()
        try:
            snapshot_download(name, max_workers=4)
        finally:
            stop.set()
        storage.prune_incomplete(name)
        PROGRESS.set(name, state="ready", done=storage.dir_size(storage._model_dir(name), ttl=0))
        log.info("model ready: %s", name)
    except Exception as e:
        log.exception("download failed: %s", name)
        PROGRESS.set(name, state="error", error=str(e)[:300])
        raise


# ---- models ---------------------------------------------------------------
class Embedder:
    def __init__(self, name: str = config.EMBED_MODEL):
        self.name = name
        self._lock = threading.RLock()
        self._model = None
        self._proc = None
        self.dim: int | None = None

    def load(self) -> None:
        with self._lock:
            if self._model is not None:
                return
            import torch
            from transformers import AutoModel, AutoProcessor

            log.info("loading embedder %s", self.name)
            dev = _device()
            dtype = torch.float16 if dev == "cuda" else torch.float32
            self._model = _from_pretrained(AutoModel, self.name, dtype=dtype).to(dev).eval()
            self._proc = _from_pretrained(AutoProcessor, self.name)
            self._dev, self._dtype = dev, dtype
            self.dim = int(self.embed_text(["warmup"]).shape[1])
            log.info("embedder ready, dim=%d device=%s", self.dim, dev)

    @staticmethod
    def _norm(x: np.ndarray) -> np.ndarray:
        n = np.linalg.norm(x, axis=1, keepdims=True)
        n[n == 0] = 1
        return x / n

    def embed_images(self, images: list[Image.Image]) -> np.ndarray:
        self.load()
        import torch

        outs = []
        for i in range(0, len(images), config.EMBED_BATCH):
            batch = images[i : i + config.EMBED_BATCH]
            inputs = self._proc(images=batch, return_tensors="pt").to(self._dev)
            inputs["pixel_values"] = inputs["pixel_values"].to(self._dtype)
            with torch.inference_mode():
                feats = _feats(self._model.get_image_features(**inputs))
            outs.append(feats.float().cpu().numpy())
        return self._norm(np.concatenate(outs, axis=0))

    def embed_text(self, texts: list[str]) -> np.ndarray:
        self.load()
        import torch

        inputs = self._proc(text=texts, padding="max_length", max_length=64, truncation=True, return_tensors="pt").to(
            self._dev
        )
        with torch.inference_mode():
            feats = _feats(self._model.get_text_features(**inputs))
        return self._norm(feats.float().cpu().numpy())


class Captioner:
    def __init__(self, name: str = config.CAPTION_MODEL):
        self.name = name
        self._lock = threading.RLock()
        self._model = None
        self._proc = None

    def load(self) -> None:
        with self._lock:
            if self._model is not None:
                return
            import torch
            from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

            log.info("loading captioner %s", self.name)
            dev = _device()
            dtype = torch.bfloat16 if dev == "cuda" else torch.float32
            self._model = _from_pretrained(
                Qwen2_5_VLForConditionalGeneration, self.name, dtype=dtype, device_map=dev
            ).eval()
            self._proc = _from_pretrained(AutoProcessor, self.name, min_pixels=128 * 28 * 28, max_pixels=640 * 28 * 28)
            self._dev = dev
            log.info("captioner ready on %s", dev)

    def unload(self) -> None:
        with self._lock:
            self._model = None
            self._proc = None
            try:
                import gc

                import torch

                gc.collect()
                torch.cuda.empty_cache()
            except Exception:
                pass

    def describe(self, images: list[Image.Image]) -> tuple[str, str]:
        """Caption + OCR for one media item given 1..3 representative frames."""
        self.load()
        import torch

        content = [{"type": "image", "image": im} for im in images[:3]]
        prompt = CAPTION_PROMPT
        if len(images) > 1:
            prompt = "These are frames from one video or GIF. " + prompt
        content.append({"type": "text", "text": prompt})
        messages = [{"role": "user", "content": content}]
        text = self._proc.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self._proc(text=[text], images=images[:3], padding=True, return_tensors="pt").to(self._dev)
        with torch.inference_mode():
            gen = self._model.generate(**inputs, max_new_tokens=160, do_sample=False)
        gen = gen[:, inputs["input_ids"].shape[1] :]
        out = self._proc.batch_decode(gen, skip_special_tokens=True)[0]
        return parse_caption(out)


def parse_caption(out: str) -> tuple[str, str]:
    caption, ocr = "", ""
    m = re.search(r"CAPTION:\s*(.*?)(?:\n\s*TEXT:|\Z)", out, re.S | re.I)
    if m:
        caption = m.group(1).strip()
    m = re.search(r"TEXT:\s*(.*)\Z", out, re.S | re.I)
    if m:
        ocr = m.group(1).strip()
    if not caption and not ocr:
        caption = out.strip()
    if ocr.strip().upper() in {"NONE", "NONE.", "N/A", "NO TEXT", "NO TEXT."}:
        ocr = ""
    return caption, ocr


class ModelManager:
    """Owns the embedder and the optional captioner; captions can be toggled at runtime."""

    def __init__(self, captions: bool):
        self.embedder = Embedder()
        self.captioner: Captioner | None = Captioner() if captions else None
        self.loaded = False
        self._lock = threading.RLock()

    @property
    def captions(self) -> bool:
        return self.captioner is not None

    def load(self) -> None:
        with self._lock:
            ensure_model(self.embedder.name)
            self.embedder.load()
            if self.captioner:
                ensure_model(self.captioner.name)
                self.captioner.load()
            self.loaded = True

    def set_captions(self, on: bool) -> None:
        with self._lock:
            if on and self.captioner is None:
                self.captioner = Captioner()
                if self.loaded:
                    ensure_model(self.captioner.name)
                    self.captioner.load()
            elif not on and self.captioner is not None:
                c, self.captioner = self.captioner, None
                c.unload()
