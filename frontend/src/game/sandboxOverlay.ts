import type { CitySnapshotBundle } from "../data/cityDataClient";
import type { GhostLot } from "../city/isoRenderer2D";
import type { CochangePair, FileImport, FileMetric } from "../types/city";

export type MayorToolId =
  | "inspect"
  | "sweeper"
  | "splitter"
  | "transit_hub"
  | "proving_park"
  | "co_maintainer"
  | "bulldozer";

export interface SandboxActionRecord {
  action_id: string;
  action_seq: number;
  tool: Exclude<MayorToolId, "inspect">;
  target_path: string;
  secondary_path: string | null;
  district_path: string;
  summary: string;
  velocity_cost: number;
  active: boolean;
  created_at: string;
}

export interface OverlayApplyResult {
  bundle: CitySnapshotBundle;
  addedFiles: Set<string>;
  demolishedLots: GhostLot[];
  protectedDistricts: Set<string>;
}

export interface ToolValidationResult {
  ok: boolean;
  reason?: string;
  secondaryPath?: string | null;
  cost: number;
}

export const TOOL_COSTS: Record<Exclude<MayorToolId, "inspect">, number> = {
  sweeper: 10,
  splitter: 35,
  transit_hub: 30,
  proving_park: 25,
  co_maintainer: 15,
  bulldozer: 5,
};

export function validateToolOnFile(
  tool: Exclude<MayorToolId, "inspect">,
  file: FileMetric,
  bundle: CitySnapshotBundle,
  pendingSecondaryStart: string | null,
): ToolValidationResult {
  const cost = TOOL_COSTS[tool];

  if (tool === "sweeper") {
    if (file.lint_issue_count === 0 && !file.format_drift && !file.condition_flags?.smog) {
      return { ok: false, reason: `${file.file_path} is already spotless!`, cost };
    }
    return { ok: true, cost };
  }

  if (tool === "splitter") {
    if (file.sloc <= 400 && file.max_complexity <= 15) {
      return {
        ok: false,
        reason: `Tower Splitter targets monoliths (SLOC > 400 or Cx > 15). ${file.file_path} is ${file.sloc} SLOC, Cx ${file.max_complexity}.`,
        cost,
      };
    }
    return { ok: true, cost };
  }

  if (tool === "transit_hub") {
    if (pendingSecondaryStart && pendingSecondaryStart !== file.file_path) {
      return { ok: true, secondaryPath: pendingSecondaryStart, cost };
    }
    // Auto-detect cyclic partner or top co-change partner if single-click
    const cyclic = bundle.imports.find(
      (a) =>
        a.source_file === file.file_path &&
        bundle.imports.some(
          (b) => b.source_file === a.target_file && b.target_file === file.file_path,
        ),
    );
    if (cyclic) {
      return { ok: true, secondaryPath: cyclic.target_file, cost };
    }
    const co = bundle.cochanges.find(
      (c) => c.file_a === file.file_path || c.file_b === file.file_path,
    );
    if (co) {
      const other = co.file_a === file.file_path ? co.file_b : co.file_a;
      return { ok: true, secondaryPath: other, cost };
    }
    return {
      ok: false,
      reason: `Select a 2nd building to link with ${file.file_path} via a Transit Interface Hub.`,
      cost,
    };
  }

  if (tool === "proving_park") {
    return { ok: true, cost };
  }

  if (tool === "co_maintainer") {
    if (file.distinct_authors_90d > 1 && !file.condition_flags?.lone_keeper) {
      return {
        ok: false,
        reason: `${file.file_path} already has ${file.distinct_authors_90d} maintainers.`,
        cost,
      };
    }
    return { ok: true, cost };
  }

  // bulldozer
  const fanIn = bundle.imports.filter((i) => i.target_file === file.file_path).length;
  if (fanIn > 0) {
    return {
      ok: false,
      reason: `Cannot bulldoze ${file.file_path}: ${fanIn} modules still import it (fan-in > 0).`,
      cost,
    };
  }
  if (file.building_archetype === "grand_terminal" || file.building_archetype === "park_stadium") {
    return {
      ok: false,
      reason: `Protected civic asset: cannot bulldoze ${file.building_archetype.replace("_", " ")}.`,
      cost,
    };
  }
  return { ok: true, cost };
}

function gradeFromScore(score: number): string {
  if (score >= 92) return "A+";
  if (score >= 85) return "A";
  if (score >= 80) return "A-";
  if (score >= 74) return "B+";
  if (score >= 68) return "B";
  if (score >= 60) return "C+";
  if (score >= 50) return "C";
  return "D";
}

export function applySandboxOverlay(
  baseBundle: CitySnapshotBundle,
  actions: SandboxActionRecord[],
): OverlayApplyResult {
  const activeActions = actions.filter((a) => a.active);
  const addedFiles = new Set<string>();
  const demolishedLots: GhostLot[] = [];
  const protectedDistricts = new Set<string>();

  for (const f of baseBundle.files) {
    if (f.building_archetype === "park_stadium") {
      protectedDistricts.add(f.district_path);
    }
  }

  if (activeActions.length === 0) {
    return {
      bundle: baseBundle,
      addedFiles,
      demolishedLots,
      protectedDistricts,
    };
  }

  let files: FileMetric[] = baseBundle.files.map((f) => ({
    ...f,
    condition_flags: { ...f.condition_flags },
    lint_by_category: { ...f.lint_by_category },
  }));
  let districts = baseBundle.districts.map((d) => ({ ...d }));
  let imports: FileImport[] = baseBundle.imports.map((i) => ({ ...i }));
  let cochanges: CochangePair[] = baseBundle.cochanges.map((c) => ({ ...c }));

  for (const act of activeActions) {
    if (act.tool === "sweeper") {
      files = files.map((f) => {
        if (f.file_path !== act.target_path) return f;
        const reducedHotspot = Math.max(
          0,
          Number((f.hotspot_score - f.lint_issue_count * 0.35).toFixed(2)),
        );
        return {
          ...f,
          lint_issue_count: 0,
          format_drift: false,
          lint_by_category: {},
          hotspot_score: reducedHotspot,
          condition_flags: {
            ...f.condition_flags,
            smog: false,
            format_drift: false,
          },
        };
      });
    } else if (act.tool === "splitter") {
      const target = files.find((f) => f.file_path === act.target_path);
      if (!target) continue;
      const partsCount = target.sloc > 850 ? 3 : 2;
      const dotIdx = target.file_path.lastIndexOf(".");
      const stem = dotIdx >= 0 ? target.file_path.slice(0, dotIdx) : target.file_path;
      const ext = dotIdx >= 0 ? target.file_path.slice(dotIdx) : "";
      const suffixes = ["_core", "_service", "_adapter"].slice(0, partsCount);

      const horizontal = target.layout_w >= target.layout_d;
      const gap = 0.45;
      const children: FileMetric[] = suffixes.map((suf, idx) => {
        const childPath = `${stem}${suf}${ext}`;
        addedFiles.add(childPath);
        const pw = horizontal
          ? (target.layout_w - gap * (partsCount - 1)) / partsCount
          : target.layout_w;
        const pd = horizontal
          ? target.layout_d
          : (target.layout_d - gap * (partsCount - 1)) / partsCount;
        const px = horizontal ? target.layout_x + idx * (pw + gap) : target.layout_x;
        const pz = horizontal ? target.layout_z : target.layout_z + idx * (pd + gap);
        return {
          ...target,
          file_path: childPath,
          sloc: Math.max(40, Math.round(target.sloc / partsCount)),
          symbol_count: Math.max(2, Math.ceil(target.symbol_count / partsCount)),
          max_complexity: Math.max(3, Math.ceil(target.max_complexity * 0.48)),
          hotspot_score: Number((target.hotspot_score * 0.42).toFixed(2)),
          condition_flags: {
            ...target.condition_flags,
            high_complexity: false,
          },
          layout_x: Number(px.toFixed(3)),
          layout_z: Number(pz.toFixed(3)),
          layout_w: Number(Math.max(0.8, pw).toFixed(3)),
          layout_d: Number(Math.max(0.8, pd).toFixed(3)),
        };
      });

      files = files.filter((f) => f.file_path !== target.file_path).concat(children);
      imports = imports.map((imp) => ({
        ...imp,
        source_file: imp.source_file === target.file_path ? children[0].file_path : imp.source_file,
        target_file:
          imp.target_file === target.file_path
            ? children[Math.min(1, children.length - 1)].file_path
            : imp.target_file,
      }));
    } else if (act.tool === "transit_hub") {
      const fA = files.find((f) => f.file_path === act.target_path);
      const fB = act.secondary_path ? files.find((f) => f.file_path === act.secondary_path) : null;
      if (!fA) continue;
      const ext = fA.language === "python" ? ".py" : ".ts";
      const hubPath = `${fA.district_path}/interface_hub_${act.action_seq}${ext}`;
      if (!files.some((f) => f.file_path === hubPath)) {
        const dist = districts.find((d) => d.district_path === fA.district_path);
        const hx = dist
          ? dist.bounds_x + dist.bounds_w * 0.5 - 1.5
          : fA.layout_x + fA.layout_w + 0.5;
        const hz = dist ? dist.bounds_z + dist.bounds_d - 3.6 : fA.layout_z;
        addedFiles.add(hubPath);
        files.push({
          ...fA,
          file_path: hubPath,
          zone_type: "civic_utilities",
          building_archetype: "civic_kiosk",
          sloc: 48,
          symbol_count: 3,
          max_complexity: 2,
          lint_issue_count: 0,
          format_drift: false,
          hotspot_score: 0.5,
          distinct_authors_90d: 2,
          condition_flags: { fan_in: 2, fan_out: 0 },
          layout_x: Number(hx.toFixed(2)),
          layout_z: Number(hz.toFixed(2)),
          layout_w: 2.8,
          layout_d: 2.8,
        });
      }
      if (fB) {
        // Break circular imports and fault lines between fA and fB via interface hub
        imports = imports.filter(
          (i) =>
            !(
              (i.source_file === fA.file_path && i.target_file === fB.file_path) ||
              (i.source_file === fB.file_path && i.target_file === fA.file_path)
            ),
        );
        imports.push(
          {
            snapshot_idx: baseBundle.snapshot.snapshot_idx,
            source_file: fA.file_path,
            target_file: hubPath,
          },
          {
            snapshot_idx: baseBundle.snapshot.snapshot_idx,
            source_file: fB.file_path,
            target_file: hubPath,
          },
        );
        cochanges = cochanges.filter(
          (c) =>
            !(
              (c.file_a === fA.file_path && c.file_b === fB.file_path) ||
              (c.file_a === fB.file_path && c.file_b === fA.file_path)
            ),
        );
      }
    } else if (act.tool === "proving_park") {
      const target = files.find((f) => f.file_path === act.target_path);
      const dist = districts.find((d) => d.district_path === act.district_path);
      const isPy = target?.language === "python";
      const parkPath = isPy
        ? `tests/test_${act.district_path.replace(/\//g, "_")}_park_${act.action_seq}.py`
        : `tests/${act.district_path.replace(/\//g, "_")}_${act.action_seq}.test.ts`;
      protectedDistricts.add(act.district_path);
      addedFiles.add(parkPath);

      const px = dist ? Math.max(2, dist.bounds_x + 0.6) : (target?.layout_x ?? 10);
      const pz = dist ? Math.max(2, dist.bounds_z + dist.bounds_d - 3.6) : (target?.layout_z ?? 10);
      files.push({
        snapshot_idx: baseBundle.snapshot.snapshot_idx,
        file_path: parkPath,
        district_path: act.district_path,
        language: target?.language ?? "python",
        zone_type: "greenbelt_parks",
        building_archetype: "park_stadium",
        role_confidence: 1,
        role_signals: { reasons: ["Sandbox Proving Park planted by Mayor"] },
        sloc: 95,
        symbol_count: 4,
        max_complexity: 2,
        type_or_doc_ratio: 1,
        lint_issue_count: 0,
        format_drift: false,
        lint_by_category: {},
        churn_90d: 1,
        bugfix_commits_90d: 0,
        distinct_authors_90d: 2,
        hotspot_score: 0.2,
        condition_flags: {},
        layout_x: Number(px.toFixed(2)),
        layout_z: Number(pz.toFixed(2)),
        layout_w: 3.4,
        layout_d: 3.4,
      });
    } else if (act.tool === "co_maintainer") {
      files = files.map((f) =>
        f.file_path === act.target_path
          ? {
              ...f,
              distinct_authors_90d: Math.max(2, f.distinct_authors_90d + 1),
              condition_flags: { ...f.condition_flags, lone_keeper: false },
            }
          : f,
      );
    } else if (act.tool === "bulldozer") {
      const victim = files.find((f) => f.file_path === act.target_path);
      if (victim) {
        demolishedLots.push({
          file_path: victim.file_path,
          layout_x: victim.layout_x,
          layout_z: victim.layout_z,
          layout_w: victim.layout_w,
          layout_d: victim.layout_d,
        });
        files = files.filter((f) => f.file_path !== victim.file_path);
        imports = imports.filter(
          (i) => i.source_file !== victim.file_path && i.target_file !== victim.file_path,
        );
      }
    }
  }

  // Recompute Snapshot health metrics from updated files
  const totalFiles = files.length;
  const totalSloc = files.reduce((acc, f) => acc + f.sloc, 0);
  const totalLint = files.reduce((acc, f) => acc + f.lint_issue_count, 0);
  const fmtDriftCount = files.filter((f) => f.format_drift).length;
  const testSloc = files
    .filter((f) => f.building_archetype === "park_stadium")
    .reduce((acc, f) => acc + f.sloc, 0);
  const avgComp = files.reduce((acc, f) => acc + f.max_complexity, 0) / Math.max(1, totalFiles);
  const testRatio = testSloc / Math.max(1, totalSloc);

  const lintPenalty = Math.min(30, (totalLint / Math.max(1, totalFiles)) * 6.5);
  const driftPenalty = Math.min(10, (fmtDriftCount / Math.max(1, totalFiles)) * 18);
  const compPenalty = Math.min(20, Math.max(0, avgComp - 4) * 2.2);
  const greenBonus = Math.min(10, testRatio * 30);
  const healthScore = Number(
    Math.max(15, Math.min(99, 92 - lintPenalty - driftPenalty - compPenalty + greenBonus)).toFixed(
      1,
    ),
  );
  const healthGrade = gradeFromScore(healthScore);
  const cityTitle =
    healthScore >= 84 && totalLint <= 15
      ? "Sunlit Civic Metropolis"
      : healthScore >= 70
        ? "Bustling Harbor District"
        : "High-Voltage Refactor Zone";

  districts = districts.map((d) => {
    const members = files.filter((f) => f.district_path === d.district_path);
    const avgLintD =
      members.reduce((a, m) => a + m.lint_issue_count, 0) / Math.max(1, members.length);
    const avgCompD =
      members.reduce((a, m) => a + m.max_complexity, 0) / Math.max(1, members.length);
    const avgH = Number(
      Math.max(25, 100 - avgLintD * 4.5 - Math.max(0, avgCompD - 5) * 2.2).toFixed(1),
    );
    return {
      ...d,
      file_count: members.length,
      avg_health: avgH,
    };
  });

  return {
    bundle: {
      snapshot: {
        ...baseBundle.snapshot,
        total_files: totalFiles,
        total_sloc: totalSloc,
        total_lint_issues: totalLint,
        health_score: healthScore,
        health_grade: healthGrade,
        city_archetype_title: cityTitle,
      },
      districts,
      files,
      imports,
      cochanges,
      deps: baseBundle.deps,
    },
    addedFiles,
    demolishedLots,
    protectedDistricts,
  };
}

export function generateRefactorBlueprintMarkdown(
  repoLabel: string,
  actions: SandboxActionRecord[],
  baseBundle: CitySnapshotBundle,
  effectiveBundle: CitySnapshotBundle,
): string {
  const active = actions.filter((a) => a.active);
  const baseS = baseBundle.snapshot;
  const effS = effectiveBundle.snapshot;
  const lines = [
    `# Mayor's Refactor Blueprint — ${repoLabel}`,
    "",
    `> Generated from CodeCity Refactor Sandbox (${active.length} planned interventions)`,
    "",
    "## Projected City Health Delta",
    "",
    "| Metric | Baseline (HEAD) | Projected Blueprint | Delta |",
    "| :--- | :---: | :---: | :---: |",
    `| **City Grade** | ${baseS.health_grade} (${baseS.health_score.toFixed(1)}) | **${effS.health_grade}** (${effS.health_score.toFixed(1)}) | ${effS.health_score - baseS.health_score >= 0 ? "+" : ""}${(effS.health_score - baseS.health_score).toFixed(1)} |`,
    `| **Lint Issues** | ${baseS.total_lint_issues} | ${effS.total_lint_issues} | ${effS.total_lint_issues - baseS.total_lint_issues} |`,
    `| **Modules** | ${baseS.total_files} | ${effS.total_files} | ${effS.total_files - baseS.total_files >= 0 ? "+" : ""}${effS.total_files - baseS.total_files} |`,
    "",
    "## Actionable GitHub Issue Checklist",
    "",
  ];

  if (active.length === 0) {
    lines.push(
      "- [ ] No sandbox interventions queued yet. Use Mayor Toolbar tools to plan refactors.",
    );
  } else {
    active.forEach((act, idx) => {
      const extra = act.secondary_path ? ` ↔ \`${act.secondary_path}\`` : "";
      lines.push(
        `- [ ] **#${idx + 1} [${act.tool.toUpperCase()}]** \`${act.target_path}\`${extra} — ${act.summary}`,
      );
    });
  }

  lines.push("", "---", "_Exported by CodeCity v2_");
  return lines.join("\n");
}
