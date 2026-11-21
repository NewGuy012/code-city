"""Optional `--semantic` HEAD-only README & documentation enrichment."""

from __future__ import annotations

import re
from pathlib import Path

from codecity.models import District, Snapshot


def _extract_markdown_text(path: Path) -> str:
    try:
        from markitdown import MarkItDown  # type: ignore[import-untyped]

        md = MarkItDown()
        res = md.convert(str(path))
        if res and getattr(res, "text_content", None):
            return str(res.text_content)
    except Exception:
        pass
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def _summarize_doc_for_keyword(doc_text: str, keyword: str) -> str | None:
    pattern = re.compile(rf"([^\n.]*\b{re.escape(keyword)}\b[^\n.]*\.)", re.I)
    match = pattern.search(doc_text)
    if not match:
        return None
    cleaned = re.sub(r"[`*_#\[\]]+", "", match.group(1)).strip()
    return cleaned[:140] if cleaned else None


def enrich_head_districts(
    repo_path: Path,
    snapshot: Snapshot,
    districts: list[District],
) -> None:
    """Enrich district blurbs on HEAD from README/docs markdown when `--semantic` is enabled."""
    doc_chunks: list[str] = []
    for cand in ("README.md", "README.rst", "README.txt", "ARCHITECTURE.md"):
        p = repo_path / cand
        if p.exists():
            doc_chunks.append(_extract_markdown_text(p))
    docs_dir = repo_path / "docs"
    if docs_dir.is_dir():
        for doc_file in sorted(docs_dir.glob("*.md"))[:5]:
            doc_chunks.append(_extract_markdown_text(doc_file))

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
