"""NCERT textbook store: PDF pages -> chunks -> Ollama embeddings -> ChromaDB.

Each textbook gets its own collection (e.g. "ncert_c10_science"), so a search
only ever touches the one book the student confirmed. Chunks also carry
metadata (chapter, chapter_title, page) to narrow it to a chapter.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from pathlib import Path

import chromadb

ROOT = Path(__file__).resolve().parent.parent
DB_DIR = Path(os.environ.get("NCERT_DB", ROOT / "data" / "chroma"))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")
PREFIX = "ncert_"
CHUNK_CHARS = 1000
CHUNK_OVERLAP = 150

_client = None


def client():
    global _client
    if _client is None:
        DB_DIR.mkdir(parents=True, exist_ok=True)
        _client = chromadb.PersistentClient(path=str(DB_DIR))
    return _client


def collection_name(class_num: int, subject: str) -> str:
    return f"{PREFIX}c{class_num}_" + re.sub(r"[^a-z0-9]+", "_", subject.lower()).strip("_")


def book_collection(class_num: int, subject: str, book: str | None = None, create: bool = False):
    """The collection holding one textbook, or None if it isn't indexed."""
    name = collection_name(class_num, subject)
    if create:
        # Embeddings come from Ollama, so Chroma's default embedder is disabled.
        return client().get_or_create_collection(
            name, embedding_function=None,
            metadata={"hnsw:space": "cosine", "class_num": class_num, "subject": subject, "book": book or ""},
        )
    try:
        return client().get_collection(name, embedding_function=None)
    except Exception:  # not indexed
        return None


def book_collections():
    for c in client().list_collections():
        name = getattr(c, "name", c)
        if name.startswith(PREFIX):
            yield client().get_collection(name, embedding_function=None)


def total_chunks() -> int:
    return sum(c.count() for c in book_collections())


def embed(texts: list[str], kind: str = "document") -> list[list[float]]:
    prefix = ("search_query: " if kind == "query" else "search_document: ") if "nomic" in EMBED_MODEL else ""
    out: list[list[float]] = []
    for i in range(0, len(texts), 32):
        body = json.dumps({"model": EMBED_MODEL, "keep_alive": "30m", "input": [prefix + t for t in texts[i : i + 32]]}).encode()
        req = urllib.request.Request(f"{OLLAMA_URL}/api/embed", data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as res:
            out.extend(json.load(res)["embeddings"])
    return out


def clean_page(text: str) -> str:
    text = text.replace("­", "")  # soft hyphens
    text = re.sub(r"-\n(?=[a-z])", "", text)  # re-join words hyphenated across lines
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # Drop the running header/footer lines NCERT prints on every page.
    lines = [l for l in text.split("\n") if not re.fullmatch(r"\s*(\d{1,3}|Reprint \d{4}-\d{2,4}|.*\bNCERT\b.*not to be republished.*)\s*", l, re.I)]
    return "\n".join(lines).strip()


def chunk(text: str) -> list[str]:
    pieces, start = [], 0
    while start < len(text):
        end = min(len(text), start + CHUNK_CHARS)
        if end < len(text):
            window = text[start + CHUNK_CHARS // 2 : end]
            cut = max(window.rfind("\n\n"), window.rfind(". "))
            if cut >= 0:
                end = start + CHUNK_CHARS // 2 + cut + 1
        piece = text[start:end].strip()
        if len(piece) > 60:
            pieces.append(piece)
        if end >= len(text):
            break
        start = max(end - CHUNK_OVERLAP, start + 1)
    return pieces


def guess_chapter_title(first_page: str, fallback: str) -> str:
    """NCERT chapter PDFs open with 'Chapter N' / a number, then the title."""
    lines = [l.strip() for l in first_page.split("\n") if l.strip()]
    for i, line in enumerate(lines[:12]):
        if re.fullmatch(r"(chapter|unit)\s*\d+|\d{1,2}", line, re.I) and i + 1 < len(lines):
            title = lines[i + 1]
            if 3 < len(title) < 90:
                return title.title() if title.isupper() else title
    for line in lines[:6]:
        if 4 < len(line) < 80 and not re.search(r"\d{4}|reprint|ncert", line, re.I):
            return line.title() if line.isupper() else line
    return fallback


def read_pages(path: Path) -> list[str]:
    import dataclasses

    import pypdf
    from pypdf.errors import LimitReachedError

    def extract():
        return [p.extract_text() or "" for p in pypdf.PdfReader(str(path)).pages]

    try:
        return extract()
    except LimitReachedError:
        # Some NCERT PDFs embed huge compressed streams that trip pypdf's
        # zip-bomb guard. These are trusted files, so retry with higher limits.
        limits = {
            f.name: 500_000_000
            for f in dataclasses.fields(pypdf.Configuration)
            if f.name.endswith(("output_length", "buffer_size", "stream_length"))
        }
        with pypdf.apply_configuration(**limits):
            return extract()


def index_pdf(path: Path, *, class_num: int, subject: str, book: str, chapter: int, chapter_title: str | None = None) -> int:
    pages = [clean_page(t) for t in read_pages(path)]
    if not any(pages):
        raise ValueError(f"{path.name}: no extractable text (scanned PDF?)")
    title = chapter_title or guess_chapter_title(pages[0], path.stem)

    col = book_collection(class_num, subject, book, create=True)
    col.delete(where={"chapter": chapter})  # re-indexing replaces

    ids, docs, metas = [], [], []
    for page_no, text in enumerate(pages, start=1):
        for j, piece in enumerate(chunk(text)):
            ids.append(f"{book}-{chapter:02d}-p{page_no}-{j}")
            docs.append(piece)
            metas.append(
                {"class_num": class_num, "subject": subject, "book": book, "chapter": chapter, "chapter_title": title, "page": page_no}
            )
    header = f"Class {class_num} {subject}, Chapter {chapter}: {title}\n"
    vectors = embed([header + d for d in docs])
    for i in range(0, len(ids), 500):
        col.add(ids=ids[i : i + 500], documents=docs[i : i + 500], embeddings=vectors[i : i + 500], metadatas=metas[i : i + 500])
    return len(ids)


def catalog() -> dict:
    """{ "10": { "science": [ {"chapter": 1, "title": "..."} ] } }"""
    result: dict = {}
    for col in book_collections():
        info = col.metadata or {}
        chapters = result.setdefault(str(info["class_num"]), {}).setdefault(info["subject"], {})
        total, offset = col.count(), 0
        while offset < total:
            for m in col.get(include=["metadatas"], limit=5000, offset=offset)["metadatas"]:
                chapters.setdefault(m["chapter"], m["chapter_title"])
            offset += 5000
    return {
        cls: {subj: [{"chapter": c, "title": t} for c, t in sorted(chs.items())] for subj, chs in subjects.items()}
        for cls, subjects in sorted(result.items(), key=lambda kv: int(kv[0]))
    }


def search(query: str, class_num: int, subject: str, k: int = 5, chapter: int | None = None) -> list[dict]:
    """Search one textbook only, optionally just one of its chapters."""
    col = book_collection(class_num, subject)
    if col is None or not col.count():
        return []
    res = col.query(
        query_embeddings=embed([query], "query"), n_results=min(k, col.count()),
        where={"chapter": chapter} if chapter else None, include=["documents", "metadatas", "distances"],
    )
    return [
        {**meta, "text": doc, "score": round(1 - dist, 3)}
        for doc, meta, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0])
    ]
