"""Tests for RankEngine - BM25 ranking."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from engines.rank_engine import RankEngine


class TestBM25Rank:
    def test_basic_ranking(self):
        engine = RankEngine()
        docs = [
            {"id": "d1", "text": "韩立修炼了长春功，这是木属性功法"},
            {"id": "d2", "text": "李逍遥在蜀山修炼剑诀"},
            {"id": "d3", "text": "青云门弟子修炼太极玄清道"},
        ]
        results = engine.bm25_rank("韩立 功法", docs, top_k=3)
        assert len(results) == 3
        # d1 should rank highest because it contains both keywords
        assert results[0]['id'] == 'd1'

    def test_empty_query(self):
        engine = RankEngine()
        docs = [{"id": "d1", "text": "some text"}]
        results = engine.bm25_rank("", docs, top_k=5)
        assert len(results) == 1

    def test_no_match(self):
        engine = RankEngine()
        docs = [{"id": "d1", "text": "completely unrelated text"}]
        results = engine.bm25_rank("nonexistent keyword", docs, top_k=5)
        assert len(results) == 1
        assert results[0]['id'] == 'd1'

    def test_top_k_limit(self):
        engine = RankEngine()
        docs = [
            {"id": f"d{i}", "text": f"document number {i}"}
            for i in range(10)
        ]
        results = engine.bm25_rank("document", docs, top_k=5)
        assert len(results) == 5
