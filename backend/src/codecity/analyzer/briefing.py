"""High-level Mayor's Welcome Briefing builder for onboarding non-technical & new teammates."""

from __future__ import annotations

from collections import Counter

from codecity.analyzer.semantic import RepoDocsContext
from codecity.models import (
    BuildingArchetype,
    CityBriefing,
    District,
    DistrictGuide,
    FileImport,
    FileMetric,
    RecommendedStart,
    ZoneType,
)

ZONE_PLAIN_LABELS: dict[ZoneType, str] = {
    ZoneType.HARBOR_GATES: "Entrypoints & APIs",
    ZoneType.DOWNTOWN_CORE: "Core App Logic",
    ZoneType.VAULTS_RESERVOIR: "Data & Storage",
    ZoneType.INDUSTRIAL_QUARTER: "Processing & Pipelines",
    ZoneType.GALLERY_STOREFRONT: "User Interface",
    ZoneType.CIVIC_UTILITIES: "Config, Security & Helpers",
    ZoneType.GREENBELT_PARKS: "Automated Tests",
    ZoneType.SUPPLY_DOCKS: "External Packages",
}

ZONE_PLAIN_DESCRIPTIONS: dict[ZoneType, str] = {
    ZoneType.HARBOR_GATES: "Handles incoming requests, web routes, and CLI commands.",
    ZoneType.DOWNTOWN_CORE: "Coordinates the main rules and features of the product.",
    ZoneType.VAULTS_RESERVOIR: "Defines data shapes and saves or loads stored information.",
    ZoneType.INDUSTRIAL_QUARTER: "Runs heavy background work, parsing, and data pipelines.",
    ZoneType.GALLERY_STOREFRONT: "Renders screens, components, and visual styling for users.",
    ZoneType.CIVIC_UTILITIES: "Provides shared helpers, configuration, and security checks.",
    ZoneType.GREENBELT_PARKS: "Automated checks ensuring the software behaves reliably.",
    ZoneType.SUPPLY_DOCKS: "Third-party libraries the project depends on.",
}


def _file_short_summary(fm: FileMetric) -> str:
    desc = fm.role_signals.get("description")
    if isinstance(desc, dict) and isinstance(desc.get("short_summary"), str):
        return desc["short_summary"]
    return (
        f"{fm.building_archetype.value.replace('_', ' ')} in {fm.district_path}/ ({fm.sloc} lines)."
    )


def _clean_district_blurb(dist: District, members: list[FileMetric]) -> str:
    # Prefer any README sentence attached after " — " in summary_blurb
    if " — " in dist.summary_blurb:
        _, doc_part = dist.summary_blurb.split(" — ", 1)
        if doc_part.strip():
            return doc_part.strip()[:180]
    zone_desc = ZONE_PLAIN_DESCRIPTIONS.get(dist.zone_type, "Application modules.")
    top_langs = [lang for lang, _ in Counter(m.language for m in members).most_common(2)]
    lang_note = f" Built primarily in {' & '.join(top_langs)}." if top_langs else ""
    return f"{zone_desc}{lang_note}"[:180]


def _pick_recommended_starts(files: list[FileMetric]) -> list[RecommendedStart]:
    if not files:
        return []
    used: set[str] = set()
    picks: list[RecommendedStart] = []

    def _score_hub(f: FileMetric) -> tuple[int, int]:
        fan_in = int(f.condition_flags.get("fan_in", 0) or 0)
        return (fan_in, f.sloc)

    def _choose(
        title: str,
        fallback_reason: str,
        candidates: list[FileMetric],
        key_fn=_score_hub,
    ) -> None:
        ordered = sorted(candidates, key=key_fn, reverse=True)
        chosen = next((f for f in ordered if f.file_path not in used), None)
        if chosen is None:
            return
        used.add(chosen.file_path)
        summary = _file_short_summary(chosen)
        reason = summary if len(summary) >= 20 else fallback_reason
        picks.append(
            RecommendedStart(
                file_path=chosen.file_path,
                title=title,
                reason=reason[:200],
                archetype=chosen.building_archetype,
            )
        )

    _choose(
        "Front Door & Entrypoint",
        "Where requests or CLI commands enter the application.",
        [f for f in files if f.building_archetype == BuildingArchetype.GRAND_TERMINAL],
        key_fn=lambda f: (int(f.condition_flags.get("fan_out", 0) or 0), f.sloc),
    )
    _choose(
        "Main User Interface",
        "Primary screen or UI component users interact with.",
        [f for f in files if f.building_archetype == BuildingArchetype.GLASS_PAVILION],
        key_fn=lambda f: (int(f.condition_flags.get("fan_out", 0) or 0), f.sloc),
    )
    _choose(
        "Core Brain & Coordinator",
        "Central logic hub connecting features together.",
        [
            f
            for f in files
            if f.building_archetype
            in {
                BuildingArchetype.CITY_HALL,
                BuildingArchetype.FACTORY,
                BuildingArchetype.OFFICE_TOWER,
            }
        ],
    )
    _choose(
        "Data & Storage Foundation",
        "Defines data shapes or reads/writes persistent storage.",
        [
            f
            for f in files
            if f.building_archetype
            in {BuildingArchetype.TWIN_SILOS, BuildingArchetype.ARCHIVE_VAULT}
        ],
    )

    if len(picks) < 3:
        _choose(
            "Key Module",
            "One of the largest or most connected modules in this codebase.",
            [f for f in files if f.building_archetype != BuildingArchetype.PARK_STADIUM],
        )
    return picks[:4]


def build_city_briefing(
    repo_name: str,
    docs_ctx: RepoDocsContext,
    districts: list[District],
    files: list[FileMetric],
    imports: list[FileImport],
    *,
    city_title: str = "",
    health_grade: str = "A",
) -> CityBriefing:
    """Synthesize a plain-English `CityBriefing` from README docs and city structure."""
    title = docs_ctx.title or repo_name
    lang_counts = Counter(
        f.language for f in files if f.language not in {"other", "config", "markdown"}
    )
    top_langs = [lang for lang, _ in lang_counts.most_common(3)]

    if docs_ctx.overview:
        overview = docs_ctx.overview
    else:
        lang_phrase = ", ".join(top_langs) if top_langs else "multiple languages"
        overview = (
            f"{title} is a {lang_phrase} codebase organized into {len(districts)} "
            f"main neighborhoods and {len(files)} files."
        )

    if docs_ctx.features:
        feature_lead = "; ".join(f.split(" — ", 1)[0].strip() for f in docs_ctx.features[:3])
        if feature_lead and feature_lead.lower() not in overview.lower():
            overview = f"{overview} Key capabilities include: {feature_lead}."

    overview = overview[:520].strip()

    if docs_ctx.architecture_notes:
        arch_summary = " ".join(docs_ctx.architecture_notes[:3])[:380]
    else:
        zone_counts = Counter(
            ZONE_PLAIN_LABELS.get(d.zone_type, d.zone_type.value) for d in districts
        )
        layers = ", ".join(name for name, _ in zone_counts.most_common(4))
        arch_summary = (
            f"Code is grouped into clear neighborhoods ({layers}) with {len(imports)} internal "
            f"connections linking requests, core logic, and data."
            if layers
            else f"Contains {len(files)} files across {len(districts)} districts."
        )

    members_by_dist: dict[str, list[FileMetric]] = {}
    for fm in files:
        members_by_dist.setdefault(fm.district_path, []).append(fm)

    sorted_districts = sorted(
        districts,
        key=lambda d: (
            1 if d.zone_type == ZoneType.GREENBELT_PARKS else 0,
            -d.file_count,
            d.district_path,
        ),
    )
    guides = [
        DistrictGuide(
            district_path=d.district_path,
            display_name=d.display_name,
            zone_type=d.zone_type,
            plain_label=ZONE_PLAIN_LABELS.get(d.zone_type, "Module Group"),
            summary=_clean_district_blurb(d, members_by_dist.get(d.district_path, [])),
            file_count=d.file_count,
        )
        for d in sorted_districts[:8]
    ]

    recommended = _pick_recommended_starts(files)
    mayor_welcome = (
        f"Welcome to {title}! In this city map, every building represents a source file "
        f"(taller buildings have more code) and neighborhoods group files that share a job. "
        f"Click any building for a plain-English summary, details, and source code."
    )
    if city_title:
        mayor_welcome = (
            f"Welcome to {title} ({city_title} · Grade {health_grade})! "
            f"Every building is a file and neighborhoods group related features. "
            f"Click any building for a plain-English summary, detailed breakdown, and source code."
        )

    return CityBriefing(
        repo_name=repo_name,
        headline=f"Mayor's Briefing: {title}",
        mayor_welcome=mayor_welcome,
        overview=overview,
        architecture_summary=arch_summary,
        district_guides=guides,
        recommended_starts=recommended,
        readme_excerpt=docs_ctx.readme_excerpt[:600] if docs_ctx.readme_excerpt else None,
        source="docs" if docs_ctx.overview else "ast",
    )
