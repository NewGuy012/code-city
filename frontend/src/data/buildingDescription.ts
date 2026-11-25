import type {
  BuildingArchetype,
  BuildingDescription,
  CityBriefing,
  District,
  DistrictGuide,
  FileMetric,
  RecommendedStart,
  SymbolSummary,
  ZoneType,
} from "../types/city";
import type { CitySnapshotBundle } from "./cityDataClient";

export const ZONE_PLAIN_LABELS: Record<ZoneType, string> = {
  harbor_gates: "Entrypoints & APIs",
  downtown_core: "Core App Logic",
  vaults_reservoir: "Data & Storage",
  industrial_quarter: "Processing & Pipelines",
  gallery_storefront: "User Interface",
  civic_utilities: "Config, Security & Helpers",
  greenbelt_parks: "Automated Tests",
  supply_docks: "External Packages",
};

const ZONE_PLAIN_SUMMARIES: Record<ZoneType, string> = {
  harbor_gates: "Handles incoming requests, web routes, and CLI commands.",
  downtown_core: "Coordinates the main rules and features of the product.",
  vaults_reservoir: "Defines data shapes and saves or loads stored information.",
  industrial_quarter: "Runs heavy background work, parsing, and data pipelines.",
  gallery_storefront: "Renders screens, components, and visual styling for users.",
  civic_utilities: "Provides shared helpers, configuration, and security checks.",
  greenbelt_parks: "Automated checks ensuring the software behaves reliably.",
  supply_docks: "Third-party libraries the project depends on.",
};

export const ARCHETYPE_PLAIN_LABELS: Record<BuildingArchetype, string> = {
  grand_terminal: "Entryway / API Gate",
  city_hall: "Central Coordinator",
  archive_vault: "Data Blueprints & Types",
  twin_silos: "Data & Storage Layer",
  factory: "Processing Engine",
  office_tower: "Feature Logic Module",
  glass_pavilion: "User Interface View",
  watchtower: "Config & Security Guard",
  civic_kiosk: "Shared Helper Toolkit",
  park_stadium: "Automated Test Suite",
};

export const METRIC_PLAIN_EXPLANATIONS: Record<string, string> = {
  SLOC: "Source lines of code (excluding blanks/comments) — drives building height.",
  Complexity: "Maximum decision branching inside a single function — higher takes longer to read.",
  Hotspot: "Combines recent edits, bug fixes, and complexity to flag active change zones.",
  "90d Churn": "How heavily this file has been edited over the past 90 days.",
  "Bus Factor": "Number of distinct recent authors — 1 means only one person touched it lately.",
  "Lint Debt": "Recorded code-quality warnings (+f indicates formatting drift).",
};

function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asSymbols(val: unknown): SymbolSummary[] {
  if (!Array.isArray(val)) return [];
  const out: SymbolSummary[] = [];
  for (const item of val) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== "string" || !obj.name) continue;
    out.push({
      name: obj.name,
      kind: typeof obj.kind === "string" ? obj.kind : "fn",
      exported: Boolean(obj.exported ?? true),
      doc: typeof obj.doc === "string" ? obj.doc : "",
      complexity: Number(obj.complexity ?? 1),
      start_line: Number(obj.start_line ?? 1),
      end_line: Number(obj.end_line ?? obj.start_line ?? 1),
      methods: asStringArray(obj.methods),
    });
  }
  return out;
}

export function extractBuildingDescription(file: FileMetric): BuildingDescription | null {
  const raw = file.role_signals?.description;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as unknown as Record<string, unknown>;
  const shortSummary = typeof obj.short_summary === "string" ? obj.short_summary.trim() : "";
  if (!shortSummary) return null;

  const detailedOverview =
    typeof obj.detailed_overview === "string" && obj.detailed_overview.trim()
      ? obj.detailed_overview.trim()
      : shortSummary;

  const rawComplex = obj.most_complex_symbol;
  const mostComplex =
    rawComplex &&
    typeof rawComplex === "object" &&
    typeof (rawComplex as Record<string, unknown>).name === "string"
      ? {
          name: String((rawComplex as Record<string, unknown>).name),
          complexity: Number((rawComplex as Record<string, unknown>).complexity ?? 1),
        }
      : null;

  return {
    short_summary: shortSummary,
    detailed_overview: detailedOverview,
    responsibilities: asStringArray(obj.responsibilities),
    key_symbols: asSymbols(obj.key_symbols),
    endpoints: asStringArray(obj.endpoints),
    endpoints_total: Number(obj.endpoints_total ?? asStringArray(obj.endpoints).length),
    external_packages: asStringArray(obj.external_packages),
    most_complex_symbol: mostComplex,
    health_notes: asStringArray(obj.health_notes),
    readme_context:
      typeof obj.readme_context === "string" && obj.readme_context.trim()
        ? obj.readme_context.trim()
        : null,
    source: typeof obj.source === "string" ? obj.source : "ast",
    model: typeof obj.model === "string" ? obj.model : null,
  };
}

export function synthesizeFallbackDescription(
  file: FileMetric,
  opts: {
    district?: District | null;
    outgoingImports: string[];
    incomingCount: number;
  },
): BuildingDescription {
  const fname = file.file_path.split("/").pop() ?? file.file_path;
  const roleLabel =
    ARCHETYPE_PLAIN_LABELS[file.building_archetype] ?? file.building_archetype.replace(/_/g, " ");
  const zoneLabel = ZONE_PLAIN_LABELS[file.zone_type] ?? file.zone_type.replace(/_/g, " ");
  const reasons = Array.isArray(file.role_signals?.reasons)
    ? file.role_signals.reasons.filter((r): r is string => typeof r === "string")
    : [];

  const shortSummary = `${fname} acts as a ${roleLabel.toLowerCase()} inside ${file.district_path}/ (${zoneLabel}).`;

  const detailParts = [
    reasons[0]
      ? `${reasons[0]}.`
      : `${fname} is a ${file.language} module spanning ${file.sloc} lines of code.`,
  ];
  if (opts.outgoingImports.length > 0 || opts.incomingCount > 0) {
    detailParts.push(
      `It connects to ${opts.outgoingImports.length} internal dependency module${
        opts.outgoingImports.length === 1 ? "" : "s"
      } and is used by ${opts.incomingCount} file${opts.incomingCount === 1 ? "" : "s"}.`,
    );
  }
  if (opts.district?.summary_blurb) {
    detailParts.push(`Neighborhood context: ${opts.district.summary_blurb}.`);
  }

  const healthNotes: string[] = [];
  if (file.max_complexity >= 8) {
    healthNotes.push(
      `Contains high branching logic (max complexity ${file.max_complexity}) — take a moment when reading.`,
    );
  }
  if (file.distinct_authors_90d === 1 && (opts.incomingCount >= 3 || file.sloc >= 120)) {
    healthNotes.push(
      `Single recent contributor (Bus Factor 1) with ${opts.incomingCount} dependent files.`,
    );
  }

  return {
    short_summary: shortSummary,
    detailed_overview: detailParts.join(" "),
    responsibilities: [
      ...reasons.slice(0, 2),
      `Contains ${file.symbol_count} code symbol${file.symbol_count === 1 ? "" : "s"} in ${file.language}`,
    ],
    key_symbols: [],
    endpoints: [],
    endpoints_total: 0,
    external_packages: [],
    most_complex_symbol: null,
    health_notes: healthNotes,
    readme_context: null,
    source: "fallback",
    model: null,
  };
}

export function buildFallbackCityBriefing(
  repoName: string,
  bundle: CitySnapshotBundle,
): CityBriefing {
  const { snapshot, districts, files, imports } = bundle;
  const langs = Object.entries(snapshot.language_breakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([l]) => l);
  const langPhrase = langs.length > 0 ? langs.join(", ") : "polyglot";

  const sortedDistricts = [...districts].sort((a, b) => {
    const aTest = a.zone_type === "greenbelt_parks" ? 1 : 0;
    const bTest = b.zone_type === "greenbelt_parks" ? 1 : 0;
    if (aTest !== bTest) return aTest - bTest;
    return b.file_count - a.file_count;
  });

  const districtGuides: DistrictGuide[] = sortedDistricts.slice(0, 8).map((d) => ({
    district_path: d.district_path,
    display_name: d.display_name,
    zone_type: d.zone_type,
    plain_label: ZONE_PLAIN_LABELS[d.zone_type] ?? "Module Group",
    summary: d.summary_blurb.includes(" — ")
      ? d.summary_blurb.split(" — ", 2)[1]
      : (ZONE_PLAIN_SUMMARIES[d.zone_type] ?? d.summary_blurb),
    file_count: d.file_count,
  }));

  const used = new Set<string>();
  const recommended: RecommendedStart[] = [];
  const pickStart = (title: string, fallbackReason: string, candidates: FileMetric[]) => {
    const chosen = [...candidates]
      .sort((a, b) => {
        const fiA = Number(a.condition_flags?.fan_in ?? 0);
        const fiB = Number(b.condition_flags?.fan_in ?? 0);
        return fiB !== fiA ? fiB - fiA : b.sloc - a.sloc;
      })
      .find((f) => !used.has(f.file_path));
    if (!chosen) return;
    used.add(chosen.file_path);
    const desc = extractBuildingDescription(chosen);
    recommended.push({
      file_path: chosen.file_path,
      title,
      reason: desc?.short_summary ?? fallbackReason,
      archetype: chosen.building_archetype,
    });
  };

  pickStart(
    "Front Door & Entrypoint",
    "Where requests or CLI commands enter the app.",
    files.filter((f) => f.building_archetype === "grand_terminal"),
  );
  pickStart(
    "Main User Interface",
    "Primary screen or interactive component users see.",
    files.filter((f) => f.building_archetype === "glass_pavilion"),
  );
  pickStart(
    "Core Brain & Coordinator",
    "Central logic coordinating the main workflows.",
    files.filter(
      (f) =>
        f.building_archetype === "city_hall" ||
        f.building_archetype === "factory" ||
        f.building_archetype === "office_tower",
    ),
  );
  pickStart(
    "Data & Storage Foundation",
    "Defines shared schemas or reads/writes persistent data.",
    files.filter(
      (f) => f.building_archetype === "twin_silos" || f.building_archetype === "archive_vault",
    ),
  );

  return {
    repo_name: repoName,
    headline: `Mayor's Briefing: ${repoName}`,
    mayor_welcome: `Welcome to ${repoName} (${snapshot.city_archetype_title} · Grade ${snapshot.health_grade})! Each building represents a file and neighborhoods group related features. Click any building for a plain-English summary, details, and source code.`,
    overview: `${repoName} is a ${langPhrase} codebase spanning ${snapshot.total_files} files across ${districts.length} neighborhoods (${imports.length} internal module connections).`,
    architecture_summary:
      districtGuides.length > 0
        ? `Main neighborhoods cover ${districtGuides
            .slice(0, 4)
            .map((g) => `${g.district_path}/ (${g.plain_label})`)
            .join(", ")}.`
        : "Organized by functional folders and module roles.",
    district_guides: districtGuides,
    recommended_starts: recommended.slice(0, 4),
    readme_excerpt: null,
    source: "fallback",
    model: null,
  };
}

export function sourceBadgeMeta(
  source: string,
  model?: string | null,
): { label: string; title: string; toneClass: string } {
  if (source === "llamacpp") {
    return {
      label: "Local AI",
      title: `Plain-English summary generated locally by llama.cpp${model ? ` (${model})` : ""}`,
      toneClass: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30",
    };
  }
  if (source === "gemini") {
    return {
      label: "Gemini AI",
      title: `Plain-English summary generated by Gemini${model ? ` (${model})` : ""}`,
      toneClass: "bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/30",
    };
  }
  if (source === "docs") {
    return {
      label: "Docs + AST",
      title: "Synthesized from file docstrings, README docs, and code structure",
      toneClass: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30",
    };
  }
  if (source === "sandbox") {
    return {
      label: "Sandbox",
      title: "Simulated refactor building created in Mayor Play Mode",
      toneClass: "bg-purple-500/15 text-purple-300 ring-1 ring-purple-400/30",
    };
  }
  return {
    label: "AST",
    title: "Synthesized automatically from code symbols, imports, and structure",
    toneClass: "bg-white/10 text-slate-300",
  };
}
