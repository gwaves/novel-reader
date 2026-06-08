"""Tests for ParseEngine - document parsing."""

import os
import tempfile
import pytest

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from engines.parse_engine import ParseEngine, detect_encoding, chunk_paragraphs


class TestDetectEncoding:
    def test_utf8(self):
        with tempfile.NamedTemporaryFile(mode='wb', delete=False, suffix='.txt') as f:
            f.write("你好世界".encode('utf-8'))
            path = f.name
        try:
            assert detect_encoding(path) == 'utf-8'
        finally:
            os.unlink(path)

    def test_gbk(self):
        with tempfile.NamedTemporaryFile(mode='wb', delete=False, suffix='.txt') as f:
            f.write("你好世界".encode('gbk'))
            path = f.name
        try:
            enc = detect_encoding(path)
            assert enc and enc.upper() in ('GBK', 'GB2312', 'GB18030')
        finally:
            os.unlink(path)


class TestChunkParagraphs:
    def test_simple_chunk(self):
        paragraphs = ["第一句。", "第二句很长的一句话。", "第三句。"]
        chunks = chunk_paragraphs(paragraphs, chunk_size=20, overlap=5)
        assert len(chunks) >= 1
        assert all('text' in c and 'char_count' in c for c in chunks)

    def test_empty(self):
        assert chunk_paragraphs([], chunk_size=100) == []


class TestParseTxt:
    def test_simple_txt(self):
        engine = ParseEngine()
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.txt', encoding='utf-8') as f:
            f.write("第一章 起始\n")
            f.write("这是第一段内容。\n")
            f.write("这是第二段。\n")
            f.write("\n")
            f.write("第二章 发展\n")
            f.write("新的章节开始了。\n")
            path = f.name

        try:
            result = engine.parse_document(path, 'txt')
            assert result['title'] == '第一章 起始' or '第一章' in str(result['title'])
            assert len(result['chapters']) >= 1
            assert len(result['paragraphs']) >= 1
            # Check paragraphs have required fields
            for p in result['paragraphs']:
                assert 'index' in p
                assert 'text' in p
                assert 'chapter_index' in p
        finally:
            os.unlink(path)

    def test_chapter_detection(self):
        engine = ParseEngine()
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.txt', encoding='utf-8') as f:
            f.write("第一章 山村小子\n")
            f.write("正文内容A\n")
            f.write("第二章 修炼\n")
            f.write("正文内容B\n")
            path = f.name

        try:
            result = engine.parse_document(path, 'txt')
            titles = [c['title'] for c in result['chapters']]
            assert any('第一章' in t for t in titles)
            assert any('第二章' in t for t in titles)
        finally:
            os.unlink(path)


class TestParsePdf:
    def test_pdf_text_extraction(self):
        engine = ParseEngine()
        # Create a simple PDF using PyMuPDF
        import fitz
        with tempfile.NamedTemporaryFile(mode='wb', delete=False, suffix='.pdf') as f:
            path = f.name

        try:
            doc = fitz.open()
            page = doc.new_page()
            page.insert_text((50, 50), "Test PDF Content")
            doc.save(path)
            doc.close()

            result = engine.parse_document(path, 'pdf')
            assert 'Test PDF Content' in str(result.get('paragraphs', []))
            assert len(result['chapters']) >= 1
        finally:
            os.unlink(path)
