"""Document parsing engine - supports txt, epub, pdf."""

import chardet
try:
    import fitz  # PyMuPDF
    HAS_FITZ = True
except ImportError:
    HAS_FITZ = False
from ebooklib import epub
from bs4 import BeautifulSoup
from pathlib import Path
from typing import List, Dict, Any, Optional
import re


def detect_encoding(file_path: str) -> str:
    """Detect file encoding, fallback to utf-8."""
    with open(file_path, "rb") as f:
        raw = f.read(4096)
    result = chardet.detect(raw)
    return result.get("encoding") or "utf-8"


def split_text_into_paragraphs(text: str) -> List[str]:
    """Split text into paragraphs, filter empty lines."""
    paragraphs = []
    for line in text.split("\n"):
        line = line.strip()
        if line:
            paragraphs.append(line)
    return paragraphs


def chunk_paragraphs(
    paragraphs: List[str], chunk_size: int = 512, overlap: int = 64
) -> List[Dict[str, Any]]:
    """Merge paragraphs into chunks with overlap."""
    chunks = []
    current = []
    current_len = 0
    sep = "\n"

    for p in paragraphs:
        p_len = len(p)
        if current_len + p_len + len(sep) > chunk_size and current:
            chunks.append({"text": sep.join(current), "char_count": current_len})
            # Keep overlap
            overlap_text = ""
            overlap_len = 0
            for item in reversed(current):
                if overlap_len + len(item) + len(sep) <= overlap:
                    overlap_text = item + (sep + overlap_text if overlap_text else "")
                    overlap_len += len(item) + len(sep)
                else:
                    break
            current = overlap_text.split(sep) if overlap_text else []
            current_len = overlap_len
        current.append(p)
        current_len += p_len + len(sep)

    if current:
        chunks.append({"text": sep.join(current), "char_count": current_len})
    return chunks


class ParseEngine:
    def parse_document(self, file_path: str, file_format: str) -> Dict[str, Any]:
        """Parse a document into structured chapters and paragraphs."""
        fmt = file_format.lower()
        if fmt == "txt":
            return self._parse_txt(file_path)
        elif fmt == "epub":
            return self._parse_epub(file_path)
        elif fmt == "pdf":
            return self._parse_pdf(file_path)
        else:
            raise ValueError(f"Unsupported format: {fmt}")

    def _parse_txt(self, file_path: str) -> Dict[str, Any]:
        encoding = detect_encoding(file_path)
        with open(file_path, "r", encoding=encoding, errors="ignore") as f:
            text = f.read()

        title = Path(file_path).stem
        # Try to extract title from first non-empty line
        lines = text.split("\n")
        for line in lines:
            stripped = line.strip()
            if stripped:
                title = stripped[:50]
                break

        # Chapter splitting heuristic: look for "第X章" patterns
        chapter_pattern = re.compile(r"^(第[一二三四五六七八九十百千零\d]+章[\s:：]|Chapter\s+\d+)")
        chapters = []
        current_title = "序章"
        current_texts = []
        global_paragraphs = []
        para_idx = 0

        for line in lines:
            line = line.strip()
            if not line:
                continue
            if chapter_pattern.match(line):
                if current_texts:
                    paragraphs = split_text_into_paragraphs("\n".join(current_texts))
                    for p in paragraphs:
                        global_paragraphs.append({
                            "index": para_idx,
                            "chapter_index": len(chapters),
                            "text": p,
                        })
                        para_idx += 1
                    chapters.append({
                        "index": len(chapters),
                        "title": current_title,
                        "level": 1,
                        "char_count": sum(len(p) for p in current_texts),
                        "start_paragraph_index": para_idx - len(paragraphs),
                        "end_paragraph_index": para_idx - 1,
                    })
                current_title = line
                current_texts = []
            else:
                current_texts.append(line)

        # Last chapter
        if current_texts:
            paragraphs = split_text_into_paragraphs("\n".join(current_texts))
            for p in paragraphs:
                global_paragraphs.append({
                    "index": para_idx,
                    "chapter_index": len(chapters),
                    "text": p,
                })
                para_idx += 1
            chapters.append({
                "index": len(chapters),
                "title": current_title,
                "level": 1,
                "char_count": sum(len(p) for p in current_texts),
                "start_paragraph_index": para_idx - len(paragraphs),
                "end_paragraph_index": para_idx - 1,
            })

        return {
            "title": title,
            "author": None,
            "chapters": chapters,
            "paragraphs": global_paragraphs,
        }

    def _parse_epub(self, file_path: str) -> Dict[str, Any]:
        book = epub.read_epub(file_path)
        title = book.get_metadata("DC", "title")
        author = book.get_metadata("DC", "creator")
        title_str = title[0][0] if title else Path(file_path).stem
        author_str = author[0][0] if author else None

        chapters = []
        global_paragraphs = []
        para_idx = 0

        # Get reading order from spine
        spine_ids = [item[0] for item in book.spine]
        items = {item.id: item for item in book.get_items() if item.get_type() == 9}  # ITEM_DOCUMENT

        for idx, item_id in enumerate(spine_ids):
            item = items.get(item_id)
            if not item:
                continue
            content = item.get_content().decode("utf-8", errors="ignore")
            soup = BeautifulSoup(content, "html.parser")

            # Extract title from h1/h2
            heading = soup.find(["h1", "h2", "h3"])
            chapter_title = heading.get_text(strip=True) if heading else f"第{idx+1}章"

            # Extract paragraphs
            texts = []
            for p in soup.find_all("p"):
                text = p.get_text(strip=True)
                if text:
                    texts.append(text)

            paragraphs = split_text_into_paragraphs("\n".join(texts))
            start_idx = para_idx
            for p in paragraphs:
                global_paragraphs.append({
                    "index": para_idx,
                    "chapter_index": idx,
                    "text": p,
                })
                para_idx += 1

            chapters.append({
                "index": idx,
                "title": chapter_title,
                "level": 1,
                "char_count": sum(len(p) for p in paragraphs),
                "start_paragraph_index": start_idx,
                "end_paragraph_index": para_idx - 1,
            })

        return {
            "title": title_str,
            "author": author_str,
            "chapters": chapters,
            "paragraphs": global_paragraphs,
        }

    def _parse_pdf(self, file_path: str) -> Dict[str, Any]:
        if not HAS_FITZ:
            raise ValueError("PDF support not available: PyMuPDF not installed. Please install it manually with: pip install PyMuPDF")
        doc = fitz.open(file_path)
        title = Path(file_path).stem
        author = doc.metadata.get("author")

        # Try to extract title from first page text
        if doc.page_count > 0:
            first_text = doc[0].get_text()[:200]
            lines = [l.strip() for l in first_text.split("\n") if l.strip()]
            if lines:
                title = lines[0][:50]

        # Each page as a chapter for simplicity
        chapters = []
        global_paragraphs = []
        para_idx = 0

        for page_idx in range(doc.page_count):
            page = doc[page_idx]
            text = page.get_text()
            paragraphs = split_text_into_paragraphs(text)
            start_idx = para_idx
            for p in paragraphs:
                global_paragraphs.append({
                    "index": para_idx,
                    "chapter_index": page_idx,
                    "text": p,
                })
                para_idx += 1

            chapters.append({
                "index": page_idx,
                "title": f"第{page_idx + 1}页",
                "level": 1,
                "char_count": sum(len(p) for p in paragraphs),
                "start_paragraph_index": start_idx,
                "end_paragraph_index": para_idx - 1,
            })

        doc.close()
        return {
            "title": title,
            "author": author,
            "chapters": chapters,
            "paragraphs": global_paragraphs,
        }
