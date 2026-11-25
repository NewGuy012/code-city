"""README, ARCHITECTURE, and documentation context extractor for quick codebase understanding."""

from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from codecity.analyzer.plugins.base import safe_read_text
from codecity.models import District, FileMetric

_HTML_TAG_RE = re.compile(
    r"</?(?:div|p|a|img|h[1-6]|br|hr|span|strong|em|b|i|code|pre|ul|ol|li|table|thead|tbody|tr|td|th|center)\b[^>]*>",
    re.I,
)
_MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_GENERIC_STEMS = frozenset(
    {
        "__init__",
        "app",
        "base",
        "cli",
        "config",
        "helpers",
        "index",
        "init",
        "lib",
        "main",
        "mod",
        "models",
        "schema",
        "server",
        "types",
        "utils",
    }
)


@dataclass
class RepoDocsContext:
    """Structured documentation context parsed from README, ARCHITECTURE, docs, and manifests."""

    title: str = ""
    overview: str = ""
    features: list[str] = field(default_factory=list)
    architecture_notes: list[str] = field(default_factory=list)
    readme_excerpt: str = ""
    combined_docs: str = ""


def _clean_markdown_line(line: str) -> str:
    txt = _MD_IMAGE_RE.sub("", line)
    txt = _MD_LINK_RE.sub(r"\1", txt)
    txt = _HTML_TAG_RE.sub(" ", txt)
    txt = txt.replace("&amp;", "&").replace("&bull;", "·").replace("&nbsp;", " ")
    txt = re.sub(r"[`*_]+", "", txt)
    return re.sub(r"\s+", " ", txt).strip()


def _parse_readme_sections(raw_md: str) -> tuple[str, str, list[str], list[str], str]:
    """Extract title, lead overview, feature bullets, architecture notes, and clean excerpt."""
    title = ""
    lead_chunks: list[str] = []
    features: list[str] = []
    arch_notes: list[str] = []
    excerpt_lines: list[str] = []

    section = "lead"
    in_code = False
    in_alert = False
    for raw in raw_md.splitlines():
        stripped = raw.strip()
        if stripped.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        if stripped.startswith("> [!"):
            in_alert = True
            continue
        if in_alert:
            if stripped.startswith(">"):
                continue
            in_alert = False

        if stripped.startswith("# ") and not title:
            title = _clean_markdown_line(stripped[2:])
            continue
        h1_html = re.search(r"<h1[^>]*>(.*?)</h1>", stripped, re.I)
        if h1_html and not title:
            title = _clean_markdown_line(h1_html.group(1))
            continue

        if stripped.startswith(("## ", "### ")):
            heading = _clean_markdown_line(stripped.lstrip("#").strip())
            low = heading.lower()
            if any(k in low for k in ("feature", "capabilit", "what it does", "highlight")):
                section = "features"
            elif any(k in low for k in ("architect", "structure", "module", "layer", "design")):
                section = "arch"
            elif any(k in low for k in ("overview", "about", "intro", "summary")):
                section = "overview"
            else:
                section = "other"
            if heading and len(excerpt_lines) < 30:
                excerpt_lines.append(f"## {heading}")
            continue

        if stripped.startswith(("[![", "![", "---", "===", '<a href="#')):
            continue

        cleaned = _clean_markdown_line(stripped)
        if not cleaned or len(cleaned) < 4:
            continue
        # Skip nav bar lines like "Quickstart · Features · CLI"
        if (cleaned.count("·") >= 1 and len(cleaned) < 45 and cleaned.endswith("·")) or (
            cleaned.count("·") >= 3 and len(cleaned) < 90
        ):
            continue

        is_bullet = stripped.startswith(("- ", "* ", "+ ")) or bool(re.match(r"^\d+\.\s", stripped))
        if is_bullet:
            bullet_txt = cleaned.lstrip("-*+ ").strip()
            if section == "features" and len(features) < 6:
                features.append(bullet_txt[:180])
            elif section == "arch" and len(arch_notes) < 6:
                arch_notes.append(bullet_txt[:180])
        elif stripped.startswith("|"):
            if not re.match(r"^\|[\s:|-]+\|$", stripped):
                cells = [c.strip() for c in cleaned.strip("|").split("|") if c.strip()]
                is_header = len(cells) >= 2 and cells[0].lower() in {"layer", "command", "metric"}
                if len(cells) >= 2 and not is_header:
                    row_txt = " — ".join(cells[:3])
                    if section == "arch" and len(arch_notes) < 6:
                        arch_notes.append(row_txt[:180])
        else:
            if section in {"lead", "overview"} and len(lead_chunks) < 3:
                lead_chunks.append(cleaned)
            elif section == "arch" and len(arch_notes) < 6:
                arch_notes.append(cleaned[:180])

        if len(" ".join(excerpt_lines)) < 1500 and not stripped.startswith("| :---"):
            excerpt_lines.append(cleaned)

    overview = " ".join(lead_chunks)[:420].strip()
    excerpt = "\n".join(excerpt_lines)[:1600].strip()
    return title, overview, features, arch_notes, excerpt


def _manifest_fallback_overview(repo_path: Path) -> tuple[str, str]:
    """Read project name and description from manifests when README is missing or sparse."""
    raw_pkg = safe_read_text(repo_path, repo_path / "package.json")
    if raw_pkg:
        try:
            data = json.loads(raw_pkg)
            if isinstance(data, dict) and data.get("description"):
                return str(data.get("name") or ""), str(data["description"]).strip()
        except Exception:
            pass

    for toml_name, section in (("pyproject.toml", "project"), ("Cargo.toml", "package")):
        raw_toml = safe_read_text(repo_path, repo_path / toml_name)
        if not raw_toml:
            continue
        try:
            tbl = tomllib.loads(raw_toml).get(section)
            if isinstance(tbl, dict) and tbl.get("description"):
                return str(tbl.get("name") or ""), str(tbl["description"]).strip()
        except Exception:
            pass
    return "", ""


def extract_repo_docs_context(repo_path: Path) -> RepoDocsContext:
    """Collect structured README, ARCHITECTURE, docs/, and manifest context from `repo_path`."""
    doc_chunks: list[str] = []
    primary_readme = ""
    for cand in ("README.md", "README.rst", "README.txt", "ARCHITECTURE.md"):
        txt = safe_read_text(repo_path, repo_path / cand)
        if txt:
            doc_chunks.append(txt)
            if not primary_readme:
                primary_readme = txt

    docs_dir = repo_path / "docs"
    if docs_dir.is_dir() and not docs_dir.is_symlink():
        for doc_file in sorted(docs_dir.glob("*.md"))[:5]:
            txt = safe_read_text(repo_path, doc_file)
            if txt:
                doc_chunks.append(txt)

    combined = "\n".join(doc_chunks)
    title, overview, features, arch_notes, excerpt = (
        _parse_readme_sections(primary_readme) if primary_readme else ("", "", [], [], "")
    )
    if not overview:
        m_title, m_desc = _manifest_fallback_overview(repo_path)
        title = title or m_title
        overview = m_desc

    return RepoDocsContext(
        title=title or repo_path.name,
        overview=overview,
        features=features,
        architecture_notes=arch_notes,
        readme_excerpt=excerpt or overview,
        combined_docs=combined,
    )


_COMMON_DISTRICT_WORDS = frozenset(
    {
        "api",
        "app",
        "cmd",
        "common",
        "core",
        "data",
        "lib",
        "pkg",
        "shared",
        "src",
        "test",
        "tests",
        "util",
        "utils",
        "web",
    }
)


def _summarize_doc_for_keyword(doc_text: str, keyword: str) -> str | None:
    # Prefer explicit code-styled (`keyword` or keyword/) mentions so common words like
    # "core" don't falsely match generic prose in sentences describing other districts.
    escaped = re.escape(keyword)
    for pat_str in (
        rf"([^\n]*`{escaped}/?`[^\n]*?(?:\.(?=\s|$)|(?=\n|$)))",
        rf"([^\n]*\b{escaped}/[^\n]*?(?:\.(?=\s|$)|(?=\n|$)))",
    ):
        match = re.compile(pat_str, re.I).search(doc_text)
        if match:
            cleaned = _clean_markdown_line(match.group(1).strip().strip("|"))
            return cleaned[:160] if cleaned else None

    if keyword.lower() in _COMMON_DISTRICT_WORDS:
        return None
    pattern = re.compile(
        rf"([^\n]*\b{escaped}\b[^\n]*?(?:\.(?=\s|$)|(?=\n|$)))",
        re.I,
    )
    match = pattern.search(doc_text)
    if not match:
        return None
    cleaned = _clean_markdown_line(match.group(1).strip().strip("|"))
    return cleaned[:160] if cleaned else None


def match_doc_for_file(docs_ctx: RepoDocsContext, file_path: str) -> str | None:
    """Find a concise README/docs sentence referencing a specific file path or module stem."""
    combined = docs_ctx.combined_docs
    if not combined.strip():
        return None

    # 1. Exact relative path or filename mention
    fname = Path(file_path).name
    for cand in (file_path, fname):
        if len(cand) < 5:
            continue
        pat = re.compile(
            rf"([^\n]*`?{re.escape(cand)}`?[^\n]*?(?:\.(?=\s|$)|(?=\n|$)))",
            re.I,
        )
        m = pat.search(combined)
        if m:
            cleaned = _clean_markdown_line(m.group(1).strip().strip("|"))
            if len(cleaned) >= 12:
                return cleaned[:180]

    # 2. Meaningful stem mention (skip overly generic filenames like utils/index/main)
    stem = Path(file_path).stem
    if len(stem) >= 4 and stem.lower() not in _GENERIC_STEMS:
        return _summarize_doc_for_keyword(combined, stem)
    return None


def enrich_head_districts(
    repo_path: Path,
    districts: list[District],
    docs_ctx: RepoDocsContext | None = None,
) -> None:
    """Enrich district blurbs on HEAD from README/docs markdown."""
    ctx = docs_ctx or extract_repo_docs_context(repo_path)
    if not ctx.combined_docs.strip():
        return

    for dist in districts:
        leaf = dist.district_path.split("/")[-1]
        if len(leaf) < 3:
            continue
        blurb = _summarize_doc_for_keyword(ctx.combined_docs, leaf)
        if blurb and blurb not in dist.summary_blurb:
            dist.summary_blurb = f"{dist.summary_blurb} — {blurb}"


def enrich_head_file_descriptions(
    docs_ctx: RepoDocsContext,
    file_metrics: list[FileMetric],
) -> None:
    """Attach matched README/docs context to HEAD file descriptions when available."""
    if not docs_ctx.combined_docs.strip():
        return

    for fm in file_metrics:
        match = match_doc_for_file(docs_ctx, fm.file_path)
        if not match:
            continue
        desc = fm.role_signals.get("description")
        if isinstance(desc, dict) and not desc.get("readme_context"):
            desc["readme_context"] = match
