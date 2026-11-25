import { deriveStreetLinesAndPlazas } from "../city/streetGrid";
import type { District, FileImport, FileMetric } from "../types/city";

export interface RoadNode {
  id: string;
  x: number;
  z: number;
  bottleneckWeight: number;
}

export interface RoadEdge {
  toId: string;
  length: number;
  kind: "avenue" | "street";
}

export interface RoadGraph {
  nodes: RoadNode[];
  nodeById: Map<string, RoadNode>;
  adj: Map<string, RoadEdge[]>;
  fileToNode: Map<string, string>;
  harborNodeIds: string[];
  bottleneckFilePaths: Set<string>;
}

export interface StreetPathResult {
  waypoints: Array<{ x: number; z: number }>;
}

export function buildRoadGraph(
  districts: District[],
  files: FileMetric[],
  imports: FileImport[],
): RoadGraph {
  const { xLines, zLines } = deriveStreetLinesAndPlazas(districts, files);
  const safeX = xLines.length >= 2 ? xLines : [1.2, 70, 138.8];
  const safeZ = zLines.length >= 2 ? zLines : [1.2, 52, 102.8];

  const nodes: RoadNode[] = [];
  const nodeById = new Map<string, RoadNode>();
  const grid: RoadNode[][] = [];
  const harborNodeIds: string[] = [];

  for (let zi = 0; zi < safeZ.length; zi++) {
    const row: RoadNode[] = [];
    for (let xi = 0; xi < safeX.length; xi++) {
      const isHarbor = zi === safeZ.length - 1;
      const node: RoadNode = {
        id: `n_${xi}_${zi}`,
        x: safeX[xi],
        z: safeZ[zi],
        bottleneckWeight: 0,
      };
      nodes.push(node);
      nodeById.set(node.id, node);
      row.push(node);
      if (isHarbor) harborNodeIds.push(node.id);
    }
    grid.push(row);
  }

  const adj = new Map<string, RoadEdge[]>();
  for (const n of nodes) adj.set(n.id, []);

  const overlapsDistrictInterior = (x0: number, z0: number, x1: number, z1: number): boolean => {
    const mx = (x0 + x1) * 0.5;
    const mz = (z0 + z1) * 0.5;
    return districts.some(
      (d) =>
        mx > d.bounds_x + 0.6 &&
        mx < d.bounds_x + d.bounds_w - 0.6 &&
        mz > d.bounds_z + 0.6 &&
        mz < d.bounds_z + d.bounds_d - 0.6,
    );
  };

  const addUndirectedEdge = (a: RoadNode, b: RoadNode, kind: "avenue" | "street") => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    adj.get(a.id)!.push({ toId: b.id, length: len, kind });
    adj.get(b.id)!.push({ toId: a.id, length: len, kind });
  };

  for (let zi = 0; zi < safeZ.length; zi++) {
    for (let xi = 0; xi < safeX.length - 1; xi++) {
      const a = grid[zi][xi];
      const b = grid[zi][xi + 1];
      const isPerim = zi === 0 || zi === safeZ.length - 1;
      if (!isPerim && overlapsDistrictInterior(a.x, a.z, b.x, b.z)) continue;
      addUndirectedEdge(a, b, isPerim ? "avenue" : "street");
    }
  }
  for (let xi = 0; xi < safeX.length; xi++) {
    for (let zi = 0; zi < safeZ.length - 1; zi++) {
      const a = grid[zi][xi];
      const b = grid[zi + 1][xi];
      const isPerim = xi === 0 || xi === safeX.length - 1;
      if (!isPerim && overlapsDistrictInterior(a.x, a.z, b.x, b.z)) continue;
      addUndirectedEdge(a, b, isPerim ? "avenue" : "street");
    }
  }

  // Ensure every node is connected (connect isolated grid nodes to perimeter neighbors if needed)
  for (let zi = 0; zi < safeZ.length; zi++) {
    for (let xi = 0; xi < safeX.length; xi++) {
      const n = grid[zi][xi];
      if ((adj.get(n.id)?.length ?? 0) === 0) {
        if (xi + 1 < safeX.length) addUndirectedEdge(n, grid[zi][xi + 1], "street");
        if (zi + 1 < safeZ.length) addUndirectedEdge(n, grid[zi + 1][xi], "street");
      }
    }
  }

  // Compute fan-in & hub bottlenecks
  const fanIn = new Map<string, number>();
  for (const imp of imports) {
    fanIn.set(imp.target_file, (fanIn.get(imp.target_file) ?? 0) + 1);
  }

  const fileToNode = new Map<string, string>();
  const bottleneckFilePaths = new Set<string>();
  const connectedNodes = nodes.filter((n) => (adj.get(n.id)?.length ?? 0) > 0);
  const pool = connectedNodes.length > 0 ? connectedNodes : nodes;

  for (const f of files) {
    const cx = f.layout_x + f.layout_w * 0.5;
    const cz = f.layout_z + f.layout_d * 0.5;
    let best = pool[0];
    let bestDist = Infinity;
    for (const n of pool) {
      const d = Math.hypot(n.x - cx, n.z - cz);
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    if (best) {
      fileToNode.set(f.file_path, best.id);
      const fi = fanIn.get(f.file_path) ?? Number(f.condition_flags?.fan_in ?? 0);
      if (fi >= 3 || f.max_complexity >= 10 || f.hotspot_score >= 12) {
        const w = Math.min(3.0, 0.6 + fi * 0.25 + f.max_complexity * 0.08);
        best.bottleneckWeight = Math.max(best.bottleneckWeight, w);
        bottleneckFilePaths.add(f.file_path);
      }
    }
  }

  return {
    nodes,
    nodeById,
    adj,
    fileToNode,
    harborNodeIds,
    bottleneckFilePaths,
  };
}

export function findStreetPath(
  graph: RoadGraph,
  startId: string,
  goalId: string,
): StreetPathResult {
  const startNode = graph.nodeById.get(startId);
  const goalNode = graph.nodeById.get(goalId);
  if (!startNode || !goalNode) {
    return { waypoints: [] };
  }
  if (startId === goalId) {
    return { waypoints: [{ x: startNode.x, z: startNode.z }] };
  }

  const open = new Set<string>([startId]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[startId, 0]]);
  const fScore = new Map<string, number>([
    [startId, Math.hypot(goalNode.x - startNode.x, goalNode.z - startNode.z)],
  ]);

  while (open.size > 0) {
    let current = "";
    let bestF = Infinity;
    for (const id of open) {
      const f = fScore.get(id) ?? Infinity;
      if (f < bestF) {
        bestF = f;
        current = id;
      }
    }
    if (!current) break;
    if (current === goalId) {
      const rev: string[] = [current];
      while (cameFrom.has(current)) {
        current = cameFrom.get(current)!;
        rev.push(current);
      }
      rev.reverse();
      return {
        waypoints: rev
          .map((id) => graph.nodeById.get(id))
          .filter((n): n is RoadNode => Boolean(n))
          .map((n) => ({ x: n.x, z: n.z })),
      };
    }

    open.delete(current);
    const curG = gScore.get(current) ?? Infinity;
    for (const edge of graph.adj.get(current) ?? []) {
      const nextNode = graph.nodeById.get(edge.toId);
      if (!nextNode) continue;
      // Prefer avenues slightly and penalize heavily congested intersections lightly
      const costFactor = (edge.kind === "avenue" ? 0.92 : 1.0) + nextNode.bottleneckWeight * 0.45;
      const tentativeG = curG + edge.length * costFactor;
      if (tentativeG < (gScore.get(edge.toId) ?? Infinity)) {
        cameFrom.set(edge.toId, current);
        gScore.set(edge.toId, tentativeG);
        const h = Math.hypot(goalNode.x - nextNode.x, goalNode.z - nextNode.z);
        fScore.set(edge.toId, tentativeG + h);
        open.add(edge.toId);
      }
    }
  }

  // Fallback direct line if disconnected
  return {
    waypoints: [
      { x: startNode.x, z: startNode.z },
      { x: goalNode.x, z: goalNode.z },
    ],
  };
}

export function detectImportCycles(imports: FileImport[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const imp of imports) {
    if (imp.source_file === imp.target_file) continue;
    const arr = adj.get(imp.source_file) ?? [];
    arr.push(imp.target_file);
    adj.set(imp.source_file, arr);
  }

  const cycles: string[][] = [];
  const visitedGlobal = new Set<string>();
  const seenSig = new Set<string>();

  for (const start of adj.keys()) {
    if (visitedGlobal.has(start)) continue;
    const stack: string[] = [start];
    const inStack = new Map<string, number>([[start, 0]]);

    const dfs = (u: string, depth: number) => {
      if (depth > 8 || cycles.length >= 12) return;
      for (const v of adj.get(u) ?? []) {
        if (inStack.has(v)) {
          const idx = inStack.get(v)!;
          const cyc = stack.slice(idx);
          if (cyc.length >= 2) {
            const sig = [...cyc].sort().join("|");
            if (!seenSig.has(sig)) {
              seenSig.add(sig);
              cycles.push(cyc);
            }
          }
        } else if (!visitedGlobal.has(v)) {
          inStack.set(v, stack.length);
          stack.push(v);
          dfs(v, depth + 1);
          stack.pop();
          inStack.delete(v);
        }
      }
      visitedGlobal.add(u);
    };

    dfs(start, 0);
  }

  return cycles;
}
