"""Ranking engine - BM25 and cross-encoder reranking."""

from typing import List, Dict, Any
from rank_bm25 import BM25Okapi


class RankEngine:
    def bm25_rank(
        self, query: str, documents: List[Dict[str, Any]], top_k: int = 5
    ) -> List[Dict[str, Any]]:
        """Rank documents using BM25."""
        if not documents:
            return []

        tokenized_docs = [doc["text"].split() for doc in documents]
        bm25 = BM25Okapi(tokenized_docs)
        tokenized_query = query.split()
        scores = bm25.get_scores(tokenized_query)

        indexed = list(enumerate(scores))
        indexed.sort(key=lambda x: x[1], reverse=True)

        results = []
        for idx, score in indexed[:top_k]:
            results.append({
                "id": documents[idx].get("id", str(idx)),
                "score": float(score),
                "text": documents[idx]["text"][:200],
            })
        return results
