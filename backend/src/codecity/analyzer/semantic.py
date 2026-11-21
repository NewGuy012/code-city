"""Optional `--semantic` HEAD-only README & documentation enrichment."""

from __future__ import annotations

import re
from pathlib import Path

from codecity.analyzer.plugins.base import safe_read_text
from codecity.models import District


def _summarize_doc_for_keyword(doc_text: str, keyword: str) -> str | None:
    pattern = re.compile(rf"([^\n.]*\b{re.escape(keyword)}\b[^\n.]*\.)", re.I)
    match = pattern.search(doc_text)
    if not match:
        return None
    cleaned = re.sub(r"[`*_#\[\]]+", "", match.group(1)).strip()
    return cleaned[:140] if cleaned else None


def enrich_head_districts(repo_path: Path, districts: list[District]) -> None:
    """Enrich district blurbs on HEAD from README/docs markdown when `--semantic` is enabled."""
    doc_chunks: list[str] = []
    for cand in ("README.md", "README.rst", "README.txt", "ARCHITECTURE.md"):
        txt = safe_read_text(repo_path, repo_path / cand)
        if txt:
            doc_chunks.append(txt)
    docs_dir = repo_path / "docs"
    if docs_dir.is_dir() and not docs_dir.is_symlink():
        for doc_file in sorted(docs_dir.glob("*.md"))[:5]:
            txt = safe_read_text(repo_path, doc_file)
            if txt:
                doc_chunks.append(txt)

    combined = "\n".join(doc_chunks)
    if not combined.strip():
        return

    for dist in districts:
        leaf = dist.district_path.split("/")[-1]
        if len(leaf) < 3:
            continue
        blurb = _summarize_doc_for_keyword(combined, leaf)
        if blurb:
            dist.summary_blurb = f"{dist.summary_blurb} — {blurb}"
