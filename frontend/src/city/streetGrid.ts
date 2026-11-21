import type { District, FileMetric } from "../types/city";

export interface PocketPlaza {
  district_path: string;
  x: number;
  z: number;
  w: number;
  d: number;
  kind: "plaza" | "courtyard" | "loading_bay";
}

function clusterAxisLines(rawCoords: number[], minGap = 3.2): number[] {
  if (rawCoords.length === 0) return [];
  const sorted = [...rawCoords].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = clusters[clusters.length - 1];
    if (sorted[i] - cur[cur.length - 1] <= minGap) {
      cur.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }
  return clusters.map((c) => Number((c.reduce((a, b) => a + b, 0) / c.length).toFixed(2)));
}

export function deriveStreetLinesAndPlazas(
  districts: District[],
  files: FileMetric[],
): {
  xLines: number[];
  zLines: number[];
  plazas: PocketPlaza[];
} {
  const rawX = [1.2, 138.8];
  const rawZ = [1.2, 102.8];
  for (const d of districts) {
    rawX.push(Math.max(1.2, d.bounds_x - 1.4));
    rawX.push(Math.min(138.8, d.bounds_x + d.bounds_w + 1.4));
    rawZ.push(Math.max(1.2, d.bounds_z - 1.4));
    rawZ.push(Math.min(102.8, d.bounds_z + d.bounds_d + 1.4));
  }
  const xLines = clusterAxisLines(rawX, 3.2);
  const zLines = clusterAxisLines(rawZ, 3.2);

  const filesByDist = new Map<string, FileMetric[]>();
  for (const f of files) {
    const arr = filesByDist.get(f.district_path) ?? [];
    arr.push(f);
    filesByDist.set(f.district_path, arr);
  }

  const plazas: PocketPlaza[] = [];
  for (const d of districts) {
    if (d.bounds_w < 6 || d.bounds_d < 6) continue;
    const members = filesByDist.get(d.district_path) ?? [];
    const innerX = d.bounds_x + 1.1;
    const innerZ = d.bounds_z + 1.1;
    const innerW = d.bounds_w - 2.2;
    const innerD = d.bounds_d - 2.2;
    if (innerW < 3 || innerD < 3) continue;

    const candidates: Array<[number, number, number, number]> = [
      [innerX + innerW - 2.6, innerZ + innerD - 2.6, 2.2, 2.2],
      [innerX + 0.3, innerZ + innerD - 2.6, 2.2, 2.2],
      [innerX + innerW - 2.6, innerZ + 0.3, 2.2, 2.2],
    ];
    for (let idx = 0; idx < candidates.length; idx++) {
      const [px, pz, pw, pd] = candidates[idx];
      if (px < innerX || pz < innerZ) continue;
      const collides = members.some(
        (f) =>
          !(
            px + pw + 0.25 <= f.layout_x ||
            f.layout_x + f.layout_w + 0.25 <= px ||
            pz + pd + 0.25 <= f.layout_z ||
            f.layout_z + f.layout_d + 0.25 <= pz
          ),
      );
      if (!collides) {
        const kind =
          d.zone_type === "industrial_quarter"
            ? "loading_bay"
            : idx % 2 === 1
              ? "courtyard"
              : "plaza";
        plazas.push({
          district_path: d.district_path,
          x: Number(px.toFixed(2)),
          z: Number(pz.toFixed(2)),
          w: pw,
          d: pd,
          kind,
        });
        break;
      }
    }
  }

  return { xLines, zLines, plazas };
}
