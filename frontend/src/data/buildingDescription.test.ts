import { describe, expect, test } from "bun:test";

import type { District, FileMetric, Snapshot } from "../types/city";
import {
  buildFallbackCityBriefing,
  extractBuildingDescription,
  sourceBadgeMeta,
  synthesizeFallbackDescription,
} from "./buildingDescription";
import type { CitySnapshotBundle } from "./cityDataClient";
import { tokenizeCodeLines } from "./codeHighlight";

function makeMetric(overrides: Partial<FileMetric> = {}): FileMetric {
  return {
    snapshot_idx: 0,
    file_path: "api/routes.py",
    district_path: "api",
    language: "python",
    zone_type: "harbor_gates",
    building_archetype: "grand_terminal",
    role_confidence: 0.9,
    role_signals: {},
    sloc: 120,
    symbol_count: 5,
    max_complexity: 4,
    type_or_doc_ratio: 0.6,
    lint_issue_count: 0,
    format_drift: false,
    lint_by_category: {},
    churn_90d: 3,
    bugfix_commits_90d: 0,
    distinct_authors_90d: 2,
    hotspot_score: 4,
    condition_flags: { fan_in: 2, fan_out: 3 },
    layout_x: 10,
    layout_z: 10,
    layout_w: 6,
    layout_d: 6,
    ...overrides,
  };
}

describe("buildingDescription & codeHighlight", () => {
  test("extracts stored description and falls back cleanly for legacy metrics", () => {
    const legacy = makeMetric({
      role_signals: { reasons: ["Entrypoint, HTTP router, or CLI handler"] },
    });
    expect(extractBuildingDescription(legacy)).toBeNull();

    const district: District = {
      snapshot_idx: 0,
      district_path: "api",
      display_name: "api",
      zone_type: "harbor_gates",
      bounds_x: 0,
      bounds_z: 0,
      bounds_w: 20,
      bounds_d: 20,
      file_count: 3,
      avg_health: 92,
      summary_blurb: "3 modules · primary grand terminal",
    };
    const fallback = synthesizeFallbackDescription(legacy, {
      district,
      outgoingImports: ["core/engine.py"],
      incomingCount: 2,
    });
    expect(fallback.short_summary).toContain("routes.py");
    expect(fallback.detailed_overview).toContain("1 internal dependency module");
    expect(fallback.source).toBe("fallback");

    const stored = makeMetric({
      role_signals: {
        description: {
          short_summary: "Handles HTTP endpoints.",
          detailed_overview: "Routes requests to backend handlers.",
          responsibilities: ["Exposes REST endpoints"],
          key_symbols: [
            {
              name: "list_items",
              kind: "fn",
              exported: true,
              doc: "Return items.",
              complexity: 2,
              start_line: 10,
              end_line: 15,
              methods: [],
            },
          ],
          endpoints: ["GET /items"],
          endpoints_total: 1,
          external_packages: ["fastapi"],
          health_notes: [],
          source: "llamacpp",
          model: "qwen2.5-coder",
        },
      },
    });
    const extracted = extractBuildingDescription(stored);
    expect(extracted?.short_summary).toBe("Handles HTTP endpoints.");
    expect(extracted?.key_symbols[0]?.start_line).toBe(10);
    expect(sourceBadgeMeta("llamacpp", "qwen2.5-coder").label).toBe("Local AI");
    expect(sourceBadgeMeta("gemini", "gemini-2.5-flash").label).toBe("Gemini AI");
  });

  test("synthesizes fallback city briefing when snapshot lacks city_briefing", () => {
    const snap: Snapshot = {
      snapshot_idx: 0,
      commit_sha: "abc1234",
      committed_at: "2026-01-01T00:00:00Z",
      git_tag: null,
      total_files: 2,
      total_sloc: 240,
      total_lint_issues: 0,
      language_breakdown: { python: 1, typescript: 1 },
      health_score: 94,
      health_grade: "A+",
      city_archetype_title: "Sunlit Civic Metropolis",
      advisor_alerts: [],
    };
    const bundle: CitySnapshotBundle = {
      snapshot: snap,
      districts: [
        {
          snapshot_idx: 0,
          district_path: "api",
          display_name: "api",
          zone_type: "harbor_gates",
          bounds_x: 0,
          bounds_z: 0,
          bounds_w: 20,
          bounds_d: 20,
          file_count: 1,
          avg_health: 95,
          summary_blurb: "1 module — routes web traffic",
        },
      ],
      files: [makeMetric()],
      imports: [],
      cochanges: [],
      deps: [],
    };
    const briefing = buildFallbackCityBriefing("acme/demo", bundle);
    expect(briefing.mayor_welcome).toContain("Welcome to acme/demo");
    expect(briefing.district_guides[0]?.plain_label).toBe("Entrypoints & APIs");
    expect(briefing.recommended_starts[0]?.file_path).toBe("api/routes.py");
  });

  test("tokenizes Python and TSX safely without losing characters", () => {
    const pyCode = '"""Doc."""\ndef run(x: int) -> int:\n    # comment\n    return x + 1';
    const pyLines = tokenizeCodeLines(pyCode, "python");
    expect(pyLines.length).toBe(4);
    expect(pyLines.map((ln) => ln.map((t) => t.text).join("")).join("\n")).toBe(pyCode);
    expect(pyLines[1]?.some((t) => t.kind === "keyword" && t.text === "def")).toBe(true);
    expect(pyLines[2]?.some((t) => t.kind === "comment")).toBe(true);

    const tsxCode = 'export function Card() { return <div className="x">Hi</div>; }';
    const tsxLines = tokenizeCodeLines(tsxCode, "typescript");
    expect(tsxLines[0]?.map((t) => t.text).join("")).toBe(tsxCode);
    expect(tsxLines[0]?.some((t) => t.kind === "type" && t.text === "Card")).toBe(true);
  });
});
