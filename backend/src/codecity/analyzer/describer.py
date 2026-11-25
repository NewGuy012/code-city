"""Deterministic plain-English + technical building description synthesizer."""

from __future__ import annotations

from pathlib import Path

from codecity.analyzer.treesitter_core import AstFileInfo, AstSymbolInfo
from codecity.models import (
    BuildingArchetype,
    BuildingDescription,
    ExternalDep,
    SymbolSummary,
    ZoneType,
)

_ARCHETYPE_PLAIN_PHRASE: dict[BuildingArchetype, str] = {
    BuildingArchetype.GRAND_TERMINAL: "entryway handling incoming requests or CLI commands",
    BuildingArchetype.CITY_HALL: "central hub coordinating multiple parts of the app",
    BuildingArchetype.ARCHIVE_VAULT: "blueprint defining shared data shapes and contracts",
    BuildingArchetype.TWIN_SILOS: "storage layer reading and saving persistent data",
    BuildingArchetype.FACTORY: "processing engine running core computations and workflows",
    BuildingArchetype.OFFICE_TOWER: "feature module implementing business logic",
    BuildingArchetype.GLASS_PAVILION: "user-facing screen or interactive UI component",
    BuildingArchetype.WATCHTOWER: "configuration, security, or guardrail module",
    BuildingArchetype.CIVIC_KIOSK: "reusable helper toolkit shared across modules",
    BuildingArchetype.PARK_STADIUM: "automated test suite verifying behavior works properly",
}

_PY_STDLIB = frozenset(
    {
        "__future__",
        "abc",
        "argparse",
        "asyncio",
        "collections",
        "concurrent",
        "contextlib",
        "copy",
        "csv",
        "dataclasses",
        "datetime",
        "difflib",
        "enum",
        "functools",
        "hashlib",
        "http",
        "importlib",
        "io",
        "ipaddress",
        "itertools",
        "json",
        "logging",
        "math",
        "os",
        "pathlib",
        "re",
        "shutil",
        "socket",
        "sqlite3",
        "subprocess",
        "sys",
        "tempfile",
        "threading",
        "time",
        "tomllib",
        "typing",
        "unittest",
        "urllib",
        "uuid",
        "warnings",
    }
)


def _cap_text(text: str, limit: int) -> str:
    cleaned = " ".join(text.split()).strip()
    if len(cleaned) <= limit:
        return cleaned
    cut = cleaned[:limit].rsplit(" ", 1)[0].rstrip(",;:")
    return f"{cut}..." if cut else cleaned[:limit]


def _first_sentence(text: str, limit: int = 200) -> str:
    cleaned = " ".join(text.split()).strip()
    if not cleaned:
        return ""
    for sep in (". ", "! ", "? "):
        idx = cleaned.find(sep)
        if 18 <= idx <= limit:
            return cleaned[: idx + 1].strip()
    return _cap_text(cleaned, limit)


def _join_names(names: list[str], *, limit: int = 3) -> str:
    picked = [f"`{n}`" for n in names[:limit] if n]
    if not picked:
        return ""
    if len(picked) == 1:
        return picked[0]
    if len(picked) == 2:
        return f"{picked[0]} and {picked[1]}"
    return f"{', '.join(picked[:-1])}, and {picked[-1]}"


def _extract_external_packages(
    info: AstFileInfo,
    internal_targets: list[str],
    repo_external_deps: list[ExternalDep],
) -> list[str]:
    """Identify third-party packages imported by this specific file."""
    known_pkgs = {d.package_name.lower(): d.package_name for d in repo_external_deps}
    internal_stems = {Path(t).stem.lower() for t in internal_targets}
    internal_tops = {Path(t).parts[0].lower() for t in internal_targets if Path(t).parts}

    pkgs: list[str] = []
    seen: set[str] = set()

    for raw in info.raw_imports:
        imp = raw.strip()
        if not imp or imp.startswith((".", "crate::", "self::", "super::", "mod::", "@/", "~/")):
            continue
        if info.language == "python":
            top = imp.split(".", 1)[0]
            low = top.lower()
            if low in _PY_STDLIB or low in internal_stems or low in internal_tops:
                continue
            cand = known_pkgs.get(low) or known_pkgs.get(low.replace("_", "-")) or top
        elif info.language in {"typescript", "javascript"}:
            if imp.startswith("node:"):
                continue
            parts = imp.split("/")
            pkg = "/".join(parts[:2]) if imp.startswith("@") and len(parts) >= 2 else parts[0]
            low = pkg.lower()
            if low in internal_stems or low in internal_tops:
                continue
            cand = known_pkgs.get(low, pkg)
        elif info.language == "go":
            if "." not in imp.split("/", 1)[0]:
                continue  # Go stdlib packages have no domain dot in first segment
            matched = next(
                (
                    d.package_name
                    for d in repo_external_deps
                    if imp == d.package_name or imp.startswith(f"{d.package_name}/")
                ),
                None,
            )
            if not matched:
                continue
            cand = matched
        elif info.language == "rust":
            top = imp.split("::", 1)[0]
            if top in {"std", "core", "alloc"}:
                continue
            cand = known_pkgs.get(top.lower(), top)
        else:
            continue

        key = cand.lower()
        if key not in seen:
            seen.add(key)
            pkgs.append(cand)
        if len(pkgs) >= 10:
            break

    return pkgs


def _build_responsibilities(
    info: AstFileInfo,
    archetype: BuildingArchetype,
    fan_in: int,
    fan_out: int,
    external_pkgs: list[str],
) -> list[str]:
    """Build crisp plain-English responsibility bullets."""
    items: list[str] = []
    sig = info.signals

    if info.endpoints:
        http_eps = [e for e in info.endpoints if not e.startswith("cli ")]
        cli_eps = [e for e in info.endpoints if e.startswith("cli ")]
        if http_eps:
            items.append(
                f"Handles {len(http_eps)} web/API route{'s' if len(http_eps) != 1 else ''}"
                f" (such as `{http_eps[0]}`)"
            )
        if cli_eps:
            cmds = ", ".join(e.removeprefix("cli ") for e in cli_eps[:4])
            items.append(f"Provides command-line subcommands ({cmds})")
    elif sig.get("route_hints"):
        items.append("Defines request routing or API endpoint handlers")

    if sig.get("ui_hints") or archetype == BuildingArchetype.GLASS_PAVILION:
        comps = [s.name for s in info.symbols if s.kind == "component"]
        if comps:
            items.append(f"Renders the {_join_names(comps, limit=2)} UI view")
        else:
            items.append("Builds user interface layout or styling")

    if sig.get("db_hints") or archetype == BuildingArchetype.TWIN_SILOS:
        items.append("Reads, writes, or queries database and storage records")

    if archetype == BuildingArchetype.ARCHIVE_VAULT:
        types = [
            s.name
            for s in info.symbols
            if s.kind in {"class", "interface", "struct", "type", "enum"}
        ]
        if types:
            items.append(f"Defines structured data models ({_join_names(types, limit=3)})")
        else:
            items.append("Defines shared data schemas and type contracts")

    if sig.get("auth_hints") or archetype == BuildingArchetype.WATCHTOWER:
        items.append("Enforces configuration, security, or runtime guardrails")

    if sig.get("is_test") or archetype == BuildingArchetype.PARK_STADIUM:
        test_count = sum(1 for s in info.symbols if s.name.lower().startswith("test"))
        if test_count:
            items.append(f"Runs {test_count} automated test check{'s' if test_count != 1 else ''}")
        else:
            items.append("Verifies application behavior through automated tests")

    if fan_in >= 3:
        items.append(f"Core building block imported directly by {fan_in} other files")
    if fan_out >= 3:
        items.append(f"Coordinates across {fan_out} internal modules")

    if external_pkgs:
        items.append(f"Uses external libraries ({_join_names(external_pkgs, limit=3)})")

    if not items:
        if info.symbols:
            items.append(
                f"Exposes {_join_names([s.name for s in info.symbols], limit=3)} in {info.language}"
            )
        else:
            items.append(f"Provides {info.language} module support ({info.sloc} lines)")

    return items[:6]


def _build_health_notes(
    info: AstFileInfo,
    *,
    fan_in: int,
    churn_90d: int,
    bugfix_commits_90d: int,
    distinct_authors_90d: int,
) -> list[str]:
    notes: list[str] = []
    if info.most_complex_symbol and info.most_complex_symbol[1] >= 8:
        fn_name, score = info.most_complex_symbol
        notes.append(
            f"Complex logic inside `{fn_name}` (complexity {score}) — worth reading carefully."
        )
    if bugfix_commits_90d >= 2 or churn_90d >= 12:
        notes.append(
            f"Updated often recently ({churn_90d} churn score, "
            f"{bugfix_commits_90d} bugfix commits in 90d)."
        )
    if distinct_authors_90d == 1 and (fan_in >= 3 or info.sloc >= 120):
        notes.append(f"Single recent contributor (Bus Factor 1) with {fan_in} dependent files.")
    return notes[:3]


def _prioritize_symbols(symbols: list[AstSymbolInfo]) -> list[SymbolSummary]:
    kind_rank = {
        "component": 0,
        "class": 1,
        "struct": 1,
        "interface": 2,
        "trait": 2,
        "hook": 3,
        "fn": 4,
        "enum": 5,
        "type": 6,
        "table": 2,
        "section": 4,
        "script": 4,
        "const": 7,
        "config": 8,
        "style": 8,
    }
    ordered = sorted(
        symbols,
        key=lambda s: (
            0 if s.exported else 1,
            kind_rank.get(s.kind, 9),
            0 if s.doc else 1,
            -s.complexity,
            s.start_line,
        ),
    )
    return [
        SymbolSummary(
            name=s.name,
            kind=s.kind,
            exported=s.exported,
            doc=_cap_text(s.doc, 140),
            complexity=s.complexity,
            start_line=s.start_line,
            end_line=s.end_line,
            methods=list(s.methods[:6]),
        )
        for s in ordered[:10]
    ]


def build_file_description(
    info: AstFileInfo,
    *,
    archetype: BuildingArchetype,
    zone: ZoneType,
    fan_in: int,
    fan_out: int,
    internal_targets: list[str],
    external_deps: list[ExternalDep],
    churn_90d: int = 0,
    bugfix_commits_90d: int = 0,
    distinct_authors_90d: int = 1,
    readme_context: str | None = None,
) -> BuildingDescription:
    """Synthesize a plain-English + technical `BuildingDescription` from AST & graph context."""
    fname = Path(info.file_path).name
    role_phrase = _ARCHETYPE_PLAIN_PHRASE.get(archetype, "code module")
    ext_pkgs = _extract_external_packages(info, internal_targets, external_deps)
    key_symbols = _prioritize_symbols(info.symbols)
    exported_names = [s.name for s in key_symbols if s.exported] or [s.name for s in key_symbols]

    # 1. Craft short_summary (plain English, always visible)
    mod_first = _first_sentence(info.module_doc, limit=210)
    if mod_first and len(mod_first) >= 24:
        short_summary = mod_first
    elif info.endpoints:
        short_summary = (
            f"{fname} is an {role_phrase}, exposing {len(info.endpoints)} route/command"
            f"{'s' if len(info.endpoints) != 1 else ''} including `{info.endpoints[0]}`."
        )
    elif exported_names:
        sym_str = _join_names(exported_names, limit=2)
        pkg_hint = f" using {_join_names(ext_pkgs, limit=2)}" if ext_pkgs else ""
        short_summary = f"{fname} acts as a {role_phrase}, providing {sym_str}{pkg_hint}."
    else:
        short_summary = f"{fname} is a {info.language} {role_phrase} ({info.sloc} lines of code)."
    short_summary = _cap_text(short_summary, 240)

    # 2. Craft detailed_overview (plain English narrative when expanded)
    detail_parts: list[str] = []
    if info.module_doc and len(info.module_doc) > len(mod_first) + 12:
        detail_parts.append(_cap_text(info.module_doc, 260))
    else:
        detail_parts.append(short_summary)

    if exported_names:
        detail_parts.append(
            f"Main exported building blocks: {_join_names(exported_names, limit=4)}."
        )

    if internal_targets and fan_in > 0:
        n_in = len(internal_targets)
        detail_parts.append(
            f"It connects to {n_in} internal module{'s' if n_in != 1 else ''} "
            f"and is depended on by {fan_in} other file{'s' if fan_in != 1 else ''}."
        )
    elif internal_targets:
        n_in = len(internal_targets)
        detail_parts.append(
            f"It pulls in functionality from {n_in} internal module{'s' if n_in != 1 else ''}."
        )
    elif fan_in > 0:
        detail_parts.append(
            f"It serves as a core module used by {fan_in} other file{'s' if fan_in != 1 else ''}."
        )

    if ext_pkgs:
        detail_parts.append(f"Relies on {_join_names(ext_pkgs, limit=4)} externally.")

    detailed_overview = _cap_text(" ".join(detail_parts), 620)
    responsibilities = _build_responsibilities(info, archetype, fan_in, fan_out, ext_pkgs)
    health_notes = _build_health_notes(
        info,
        fan_in=fan_in,
        churn_90d=churn_90d,
        bugfix_commits_90d=bugfix_commits_90d,
        distinct_authors_90d=distinct_authors_90d,
    )
    most_complex = (
        {"name": info.most_complex_symbol[0], "complexity": info.most_complex_symbol[1]}
        if info.most_complex_symbol and info.most_complex_symbol[1] >= 5
        else None
    )

    return BuildingDescription(
        short_summary=short_summary,
        detailed_overview=detailed_overview,
        responsibilities=responsibilities,
        key_symbols=key_symbols,
        endpoints=info.endpoints[:8],
        endpoints_total=len(info.endpoints),
        external_packages=ext_pkgs,
        most_complex_symbol=most_complex,
        health_notes=health_notes,
        readme_context=_cap_text(readme_context, 200) if readme_context else None,
        source="docs" if (mod_first or readme_context) else "ast",
    )
