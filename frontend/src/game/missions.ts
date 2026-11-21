import type { CityDataClient, CitySnapshotBundle } from "../data/cityDataClient";
import { detectImportCycles } from "./roadGraph";

export interface AdvisorMission {
  id: "transit" | "air_quality" | "greenbelt" | "bus_factor";
  advisorName: string;
  advisorRole: string;
  icon: string;
  title: string;
  description: string;
  sqlQuery: string;
  sqlFact: string;
  progressLabel: string;
  progressPct: number;
  completed: boolean;
  rewardVelocity: number;
  targetFile: string | null;
}

interface SqlMissionBaseline {
  sqlTopComplex: string;
  sqlBaseSmog: number;
  sqlBaseGreenPct: number;
  sqlLoneCount: number;
}

const baselineCache = new WeakMap<CityDataClient, Map<string, SqlMissionBaseline>>();

export async function evaluateAdvisorMissions(
  client: CityDataClient,
  effectiveBundle: CitySnapshotBundle,
): Promise<AdvisorMission[]> {
  const snapIdx = effectiveBundle.snapshot.snapshot_idx;
  const cacheKey = `${effectiveBundle.snapshot.commit_sha}:${snapIdx}`;

  // Parameterized DuckDB-Wasm SQL queries over base snapshot tables
  const transitSql = `SELECT file_path, max_complexity, hotspot_score FROM file_metrics WHERE snapshot_idx = ? ORDER BY max_complexity DESC, hotspot_score DESC LIMIT 3;`;
  const airSql = `SELECT COUNT(*) AS smog_files, COALESCE(SUM(lint_issue_count), 0) AS total_lints FROM file_metrics WHERE snapshot_idx = ? AND (lint_issue_count > 0 OR format_drift = true);`;
  const greenSql = `SELECT COALESCE(SUM(CASE WHEN building_archetype = 'park_stadium' THEN sloc ELSE 0 END), 0) AS park_sloc, COALESCE(SUM(sloc), 1) AS total_sloc FROM file_metrics WHERE snapshot_idx = ?;`;
  const busSql = `SELECT file_path, sloc FROM file_metrics WHERE snapshot_idx = ? AND distinct_authors_90d <= 1 AND sloc >= 40 ORDER BY hotspot_score DESC LIMIT 5;`;

  let clientCache = baselineCache.get(client);
  if (!clientCache) {
    clientCache = new Map();
    baselineCache.set(client, clientCache);
  }

  let base = clientCache.get(cacheKey);
  if (!base) {
    base = { sqlTopComplex: "", sqlBaseSmog: 0, sqlBaseGreenPct: 0, sqlLoneCount: 0 };
    try {
      const [tRows, aRows, gRows, bRows] = await Promise.all([
        client.runReadSql(transitSql, [snapIdx]),
        client.runReadSql(airSql, [snapIdx]),
        client.runReadSql(greenSql, [snapIdx]),
        client.runReadSql(busSql, [snapIdx]),
      ]);
      if (tRows[0]) {
        base.sqlTopComplex = `${String(tRows[0].file_path)} (Cx ${Number(tRows[0].max_complexity)})`;
      }
      if (aRows[0]) base.sqlBaseSmog = Number(aRows[0].smog_files ?? 0);
      if (gRows[0]) {
        base.sqlBaseGreenPct = Math.round(
          (100 * Number(gRows[0].park_sloc ?? 0)) / Math.max(1, Number(gRows[0].total_sloc ?? 1)),
        );
      }
      base.sqlLoneCount = bRows.length;
      if (clientCache.size >= 32) clientCache.clear();
      clientCache.set(cacheKey, base);
    } catch {
      // Graceful fallback when running pure unit tests without Wasm worker
    }
  }
  const { sqlTopComplex, sqlBaseSmog, sqlBaseGreenPct, sqlLoneCount } = base;

  // Evaluate live status over effectiveBundle (including Sandbox interventions!)
  const files = effectiveBundle.files;
  const cycles = detectImportCycles(effectiveBundle.imports);
  const monoliths = files.filter((f) => f.sloc > 400 || f.max_complexity > 15);
  const transitRemaining = cycles.length + monoliths.length;
  const transitTarget =
    files.find((f) => monoliths.includes(f))?.file_path ??
    cycles[0]?.[0] ??
    files[0]?.file_path ??
    null;
  const transitCompleted = transitRemaining === 0;
  const transitPct = transitCompleted
    ? 100
    : Math.max(15, Math.round(100 / (1 + transitRemaining)));

  const smogFiles = files.filter((f) => f.lint_issue_count > 0 || f.format_drift);
  const totalLintNow = files.reduce((acc, f) => acc + f.lint_issue_count, 0);
  const airDenom = Math.max(1, sqlBaseSmog, smogFiles.length);
  const airCompleted = smogFiles.length === 0;
  const airPct = airCompleted
    ? 100
    : Math.max(8, Math.round(((airDenom - smogFiles.length) / airDenom) * 100));
  const worstSmog = [...smogFiles].sort((a, b) => b.lint_issue_count - a.lint_issue_count)[0];

  const totalSloc = Math.max(
    1,
    files.reduce((a, f) => a + f.sloc, 0),
  );
  const parkSloc = files
    .filter((f) => f.building_archetype === "park_stadium")
    .reduce((a, f) => a + f.sloc, 0);
  const greenPctNow = Math.round((100 * parkSloc) / totalSloc);
  const greenCompleted = greenPctNow >= 20;
  const greenProgress = Math.min(100, Math.round((greenPctNow / 20) * 100));
  const unparkedDistrictFile =
    files.find(
      (f) =>
        f.building_archetype !== "park_stadium" &&
        !files.some(
          (p) => p.building_archetype === "park_stadium" && p.district_path === f.district_path,
        ),
    ) ?? files[0];

  const loneHubs = files.filter(
    (f) => f.condition_flags?.lone_keeper || (f.distinct_authors_90d <= 1 && f.sloc >= 40),
  );
  const busDenom = Math.max(1, sqlLoneCount, loneHubs.length);
  const busCompleted = loneHubs.length === 0;
  const busPct = busCompleted
    ? 100
    : Math.max(10, Math.round(((busDenom - loneHubs.length) / busDenom) * 100));
  const topLone = [...loneHubs].sort((a, b) => b.hotspot_score - a.hotspot_score)[0];

  return [
    {
      id: "transit",
      advisorName: "Chief Elena",
      advisorRole: "Transit Chief",
      icon: "🚦",
      title: "Untangle Downtown Gridlock",
      description:
        "Break circular import roundabouts with Transit Interface Hubs and split mega-towers (SLOC > 400 or Cx > 15).",
      sqlQuery: transitSql,
      sqlFact: sqlTopComplex ? `SQL Peak: ${sqlTopComplex}` : `${monoliths.length} monoliths`,
      progressLabel: transitCompleted
        ? "All cycles & monoliths resolved!"
        : `${cycles.length} cycles · ${monoliths.length} monoliths remaining`,
      progressPct: transitPct,
      completed: transitCompleted,
      rewardVelocity: 75,
      targetFile: transitTarget,
    },
    {
      id: "air_quality",
      advisorName: "Officer Kai",
      advisorRole: "Air Quality Officer",
      icon: "🌫️",
      title: "Clear Air Act",
      description:
        "Deploy the Street Sweeper to eliminate format drift and lint smog across all city blocks.",
      sqlQuery: airSql,
      sqlFact: `SQL Baseline: ${sqlBaseSmog} polluted modules`,
      progressLabel: airCompleted
        ? "Zero lint smog & format drift!"
        : `${smogFiles.length} dirty modules (${totalLintNow} lints)`,
      progressPct: airPct,
      completed: airCompleted,
      rewardVelocity: 60,
      targetFile: worstSmog?.file_path ?? null,
    },
    {
      id: "greenbelt",
      advisorName: "Warden Maya",
      advisorRole: "QA / Greenbelt Warden",
      icon: "🌳",
      title: "Greenbelt Expansion (>= 20%)",
      description:
        "Plant Proving Parks beside production districts to reach 20% test coverage and shield blocks from Disasters.",
      sqlQuery: greenSql,
      sqlFact: `SQL Baseline: ${sqlBaseGreenPct}% Greenbelt ratio`,
      progressLabel: `${greenPctNow}% / 20% Greenbelt ratio`,
      progressPct: greenProgress,
      completed: greenCompleted,
      rewardVelocity: 65,
      targetFile: unparkedDistrictFile?.file_path ?? null,
    },
    {
      id: "bus_factor",
      advisorName: "Director Sam",
      advisorRole: "Bus-Factor HR",
      icon: "🚨",
      title: "Succession & Resilience Plan",
      description:
        "Assign Co-Maintainers to every Bus Factor = 1 hub so the city survives a developer vacation.",
      sqlQuery: busSql,
      sqlFact: `SQL At-Risk: ${sqlLoneCount} sole-author hubs`,
      progressLabel: busCompleted
        ? "All key hubs have >= 2 maintainers!"
        : `${loneHubs.length} single-maintainer hubs at risk`,
      progressPct: busPct,
      completed: busCompleted,
      rewardVelocity: 70,
      targetFile: topLone?.file_path ?? null,
    },
  ];
}
