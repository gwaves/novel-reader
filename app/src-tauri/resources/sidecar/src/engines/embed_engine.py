"""Embedding engine using local ONNX model (BGE-M3 via optimum)."""

import os
import time
from typing import List, Dict, Any, Optional

import numpy as np


class EmbedEngine:
    def __init__(self):
        self.tokenizer = None
        self.model = None
        self.session = None
        self.model_path: Optional[str] = None

    def load_model(self, model_path: str) -> bool:
        """Load ONNX embedding model."""
        try:
            from optimum.onnxruntime import ORTModelForFeatureExtraction
            from transformers import AutoTokenizer

            self.model_path = model_path
            self.tokenizer = AutoTokenizer.from_pretrained(model_path)
            self.model = ORTModelForFeatureExtraction.from_pretrained(
                model_path, provider="CPUExecutionProvider"
            )
            return True
        except Exception as e:
            print(f"Failed to load embedding model: {e}")
            return False

    def is_loaded(self) -> bool:
        return self.model is not None

    def _normalize(self, vectors: np.ndarray) -> np.ndarray:
        """L2 normalize vectors."""
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        norms = np.where(norms == 0, 1, norms)
        return vectors / norms

    def embed_texts(
        self, texts: List[str], batch_size: int = 32
    ) -> Dict[str, Any]:
        """Embed a list of texts into vectors."""
        if not self.is_loaded():
            raise RuntimeError("Model not loaded. Call load_model() first.")

        start = time.time()
        all_embeddings = []

        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            inputs = self.tokenizer(
                batch,
                padding=True,
                truncation=True,
                max_length=512,
                return_tensors="pt",
            )
            import torch

            with torch.no_grad():
                outputs = self.model(**inputs)
                # Mean pooling
                attention_mask = inputs["attention_mask"]
                token_embeddings = outputs.last_hidden_state
                mask_expanded = (
                    attention_mask.unsqueeze(-1).expand(token_embeddings.size()).float()
                )
                sum_embeddings = torch.sum(token_embeddings * mask_expanded, 1)
                sum_mask = torch.clamp(mask_expanded.sum(1), min=1e-9)
                embeddings = sum_embeddings / sum_mask
                embeddings = embeddings.cpu().numpy()
                all_embeddings.extend(embeddings.tolist())

        elapsed = (time.time() - start) * 1000
        return {
            "vectors": all_embeddings,
            "model": "bge-m3-onnx",
            "inferenceTimeMs": round(elapsed, 2),
        }

    def embed_query(self, text: str) -> Dict[str, Any]:
        """Embed a single query text."""
        result = self.embed_texts([text], batch_size=1)
        result["vectors"] = result["vectors"][0] if result["vectors"] else []
        return result
