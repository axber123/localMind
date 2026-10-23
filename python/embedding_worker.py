"""LocalMind embedding worker.

Runs entirely offline. The Electron main process downloads and verifies model
files; this worker only loads the local ONNX model and tokenizer.

Protocol: one JSON object per line on stdin/stdout.
  {"id": 1, "method": "load"}
  {"id": 2, "method": "count_tokens", "params": {"texts": ["..."]}}
  {"id": 3, "method": "embed", "params": {"texts": ["..."], "prefix": "query"}}
Responses are {"id": 1, "ok": true, "result": {...}} or an error object.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MAX_TOKENS = 512
PREFIXES = {"query": "query: ", "passage": "passage: ", "none": ""}


def mean_pool(last_hidden_state: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    mask = attention_mask.astype(np.float32)[..., None]
    summed = (last_hidden_state * mask).sum(axis=1)
    counts = np.clip(mask.sum(axis=1), 1e-9, None)
    return summed / counts


def normalize(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.clip(norms, 1e-12, None)


class EmbeddingModel:
    def __init__(self, model_dir: Path) -> None:
        self.model_dir = model_dir
        tokenizer_path = model_dir / "tokenizer.json"
        model_path = model_dir / "onnx" / "model.onnx"
        if not tokenizer_path.is_file():
            raise FileNotFoundError(f"tokenizer.json not found in {model_dir}")
        if not model_path.is_file():
            raise FileNotFoundError(f"onnx/model.onnx not found in {model_dir}")
        self.tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        threads = int(os.environ.get("LOCALMIND_EMBED_THREADS", "0")) or min(4, os.cpu_count() or 1)
        options.intra_op_num_threads = max(1, threads)
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
        self.input_names = {item.name for item in self.session.get_inputs()}
        self.output_names = [item.name for item in self.session.get_outputs()]
        self.dimensions = 384
        self.pad_id = self.tokenizer.token_to_id("<pad>")
        self.eos_id = self.tokenizer.token_to_id("</s>")

    def count_tokens(self, texts: list[str]) -> list[int]:
        counts: list[int] = []
        for text in texts:
            counts.append(len(self.tokenizer.encode(text, add_special_tokens=True).ids))
        return counts

    def embed(self, texts: list[str], prefix: str) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dimensions), dtype=np.float32)
        prefix_text = PREFIXES.get(prefix, "")
        batch_ids: list[list[int]] = []
        for raw in texts:
            text = prefix_text + raw.replace("\x00", "")
            ids = self.tokenizer.encode(text, add_special_tokens=True).ids
            if len(ids) > MAX_TOKENS:
                if self.eos_id is not None:
                    ids = ids[: MAX_TOKENS - 1] + [self.eos_id]
                else:
                    ids = ids[:MAX_TOKENS]
            batch_ids.append(ids)
        max_len = max(len(ids) for ids in batch_ids)
        pad_id = self.pad_id if self.pad_id is not None else 1
        input_ids = np.full((len(batch_ids), max_len), pad_id, dtype=np.int64)
        attention = np.zeros((len(batch_ids), max_len), dtype=np.int64)
        for row, ids in enumerate(batch_ids):
            input_ids[row, : len(ids)] = ids
            attention[row, : len(ids)] = 1
        feed: dict[str, np.ndarray] = {
            "input_ids": input_ids,
            "attention_mask": attention,
        }
        if "token_type_ids" in self.input_names:
            feed["token_type_ids"] = np.zeros_like(input_ids)
        for name in self.input_names:
            if name not in feed:
                raise ValueError(f"Unsupported ONNX input: {name}")
        outputs = self.session.run(self.output_names, feed)
        hidden = None
        for name, value in zip(self.output_names, outputs):
            array = np.asarray(value)
            if array.ndim == 3:
                hidden = array
                break
        if hidden is None:
            raise ValueError("ONNX model did not return a last_hidden_state tensor")
        vectors = normalize(mean_pool(hidden.astype(np.float32), attention))
        self.dimensions = int(vectors.shape[1])
        return vectors


class Worker:
    def __init__(self, model_dir: Path | None) -> None:
        self.model_dir = model_dir
        self.model: EmbeddingModel | None = None

    def ensure_model(self) -> EmbeddingModel:
        if self.model is None:
            if self.model_dir is None:
                raise ValueError("model directory is required")
            self.model = EmbeddingModel(self.model_dir)
        return self.model

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        try:
            if method == "health":
                return {"id": request_id, "ok": True, "result": {"status": "ok", "loaded": self.model is not None}}
            if method == "load":
                self.ensure_model()
                return {
                    "id": request_id,
                    "ok": True,
                    "result": {"loaded": True, "dimensions": self.model.dimensions, "max_tokens": MAX_TOKENS},
                }
            if method == "count_tokens":
                texts = params.get("texts") or []
                if not isinstance(texts, list):
                    raise ValueError("texts must be a list")
                return {"id": request_id, "ok": True, "result": {"counts": self.ensure_model().count_tokens(texts)}}
            if method == "embed":
                texts = params.get("texts") or []
                if not isinstance(texts, list) or not all(isinstance(item, str) for item in texts):
                    raise ValueError("texts must be a list of strings")
                prefix = params.get("prefix", "passage")
                vectors = self.ensure_model().embed(texts, prefix)
                payload = base64.b64encode(np.ascontiguousarray(vectors, dtype="<f4").tobytes()).decode("ascii")
                return {
                    "id": request_id,
                    "ok": True,
                    "result": {
                        "dimensions": int(vectors.shape[1]),
                        "count": int(vectors.shape[0]),
                        "data": payload,
                    },
                }
            if method == "shutdown":
                return {"id": request_id, "ok": True, "result": {"shutdown": True}}
            raise ValueError(f"unknown method: {method}")
        except Exception as exc:  # noqa: BLE001 - protocol must return a readable error
            return {"id": request_id, "ok": False, "error": {"message": str(exc), "type": type(exc).__name__}}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=str, default="")
    args = parser.parse_args()
    model_dir = Path(args.model_dir) if args.model_dir else None
    worker = Worker(model_dir)
    for raw_line in sys.stdin.buffer:
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            response = {"id": None, "ok": False, "error": {"message": f"invalid json: {exc}", "type": "JSONDecodeError"}}
        else:
            response = worker.handle(request)
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        should_stop = isinstance(request, dict) and request.get("method") == "shutdown"
        if should_stop:
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
