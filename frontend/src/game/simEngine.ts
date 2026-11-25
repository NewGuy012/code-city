import type { CitySnapshotBundle } from "../data/cityDataClient";
import type { FloatingStatPopup, SimVehicleRender } from "../city/isoRenderer2D";
import type { FileImport, FileMetric } from "../types/city";
import {
  type RoadGraph,
  type RoadNode,
  buildRoadGraph,
  detectImportCycles,
  findStreetPath,
} from "./roadGraph";

export function computeImpactedFiles(targetFile: string, imports: FileImport[]): string[] {
  const revAdj = new Map<string, string[]>();
  for (const imp of imports) {
    const arr = revAdj.get(imp.target_file);
    if (arr) arr.push(imp.source_file);
    else revAdj.set(imp.target_file, [imp.source_file]);
  }
  const visited = new Set<string>();
  const queue = [targetFile];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const src of revAdj.get(cur) ?? []) {
      if (src !== targetFile && !visited.has(src)) {
        visited.add(src);
        queue.push(src);
      }
    }
  }
  return [...visited];
}

export type SimSpeed = 0 | 1 | 2 | 3;

export type CityMilestone =
  "Frontier Outpost" | "Bustling Harbor Town" | "Civic Metropolis" | "A+ Sunlit Smart City";

export type ActiveDisasterKind =
  "power_outage" | "bus_factor_vacation" | "crunch_storm" | "supply_dock_storm";

export interface ActiveDisasterState {
  kind: ActiveDisasterKind;
  title: string;
  detail: string;
  targetLabel: string;
  startedTick: number;
  resolved: boolean;
}

export interface SimVehicle extends SimVehicleRender {
  waypoints: Array<{ x: number; z: number }>;
  wpIdx: number;
  speed: number;
  loop: boolean;
  targetFile?: string;
}

export interface SimRenderFrame {
  vehicles: readonly SimVehicleRender[];
  fireFiles: ReadonlySet<string>;
  blackoutFiles: ReadonlySet<string>;
  floatingPopups: readonly FloatingStatPopup[];
}

export interface SimStateSnapshot {
  tick: number;
  speed: SimSpeed;
  sprintNumber: number;
  sprintProgress: number;
  velocityTreasury: number;
  incomePerSprint: number;
  upkeepPerSprint: number;
  happiness: number;
  cityLevel: CityMilestone;
  jammedCount: number;
  cycleCount: number;
  vehicles: SimVehicleRender[];
  fireFiles: Set<string>;
  blackoutFiles: Set<string>;
  activeDisaster: ActiveDisasterState | null;
  floatingPopups: FloatingStatPopup[];
  milestoneEvent: CityMilestone | null;
}

const TICKS_PER_SPRINT = 40; // 4 seconds per sprint at 1x (10Hz)

function computeCityMilestone(
  healthScore: number,
  totalFiles: number,
  happiness: number,
): CityMilestone {
  const composite = healthScore * 0.65 + happiness * 0.35;
  if (composite >= 88 && totalFiles >= 6) return "A+ Sunlit Smart City";
  if (composite >= 76 && totalFiles >= 4) return "Civic Metropolis";
  if (composite >= 60) return "Bustling Harbor Town";
  return "Frontier Outpost";
}

export class CitySimulationEngine {
  private tickCount = 0;
  private speed: SimSpeed = 1;
  private sprintNumber = 1;
  private sprintTicks = 0;
  private velocityTreasury = 180;
  private incomePerSprint = 45;
  private upkeepPerSprint = 12;
  private happiness = 82;
  private cityLevel: CityMilestone = "Bustling Harbor Town";
  private milestoneEvent: CityMilestone | null = null;

  private graph: RoadGraph | null = null;
  private bottleneckNodes: RoadNode[] = [];
  private lastBundle: CitySnapshotBundle | null = null;
  private bundleStats = {
    totalLint: 0,
    complexPenalty: 0,
    greenbeltBoost: 0,
    smogCount: 0,
    featureFiles: [] as string[],
  };
  private cycles: string[][] = [];
  private vehicles: SimVehicle[] = [];
  private fireFiles = new Set<string>();
  private blackoutFiles = new Set<string>();
  private brownoutFiles = new Set<string>();
  private activeDisaster: ActiveDisasterState | null = null;
  private floatingPopups: FloatingStatPopup[] = [];
  private nextId = 1;

  private hudVersion = 0;
  private fireSnapVersion = 0;
  private cachedFireSnapVersion = -1;
  private cachedFireSnap = new Set<string>();
  private blackoutSnapVersion = 0;
  private cachedBlackoutSnapVersion = -1;
  private cachedBlackoutSnap = new Set<string>();
  private renderListeners = new Set<() => void>();

  subscribeRender(fn: () => void): () => void {
    this.renderListeners.add(fn);
    return () => {
      this.renderListeners.delete(fn);
    };
  }

  private emitRender(): void {
    for (const fn of this.renderListeners) {
      fn();
    }
  }

  private getStableFireFiles(): Set<string> {
    if (this.cachedFireSnapVersion !== this.fireSnapVersion) {
      this.cachedFireSnap = new Set(this.fireFiles);
      this.cachedFireSnapVersion = this.fireSnapVersion;
    }
    return this.cachedFireSnap;
  }

  private getStableBlackoutFiles(): Set<string> {
    if (this.cachedBlackoutSnapVersion !== this.blackoutSnapVersion) {
      this.cachedBlackoutSnap = new Set<string>([...this.blackoutFiles, ...this.brownoutFiles]);
      this.cachedBlackoutSnapVersion = this.blackoutSnapVersion;
    }
    return this.cachedBlackoutSnap;
  }

  getHudVersion(): number {
    return this.hudVersion;
  }

  getRenderFrame(): SimRenderFrame {
    return {
      vehicles: this.vehicles,
      fireFiles: this.getStableFireFiles(),
      blackoutFiles: this.getStableBlackoutFiles(),
      floatingPopups: this.floatingPopups,
    };
  }

  getSpeed(): SimSpeed {
    return this.speed;
  }

  setSpeed(speed: SimSpeed): void {
    if (this.speed !== speed) {
      this.speed = speed;
      this.hudVersion += 1;
    }
  }

  clearMilestoneEvent(): void {
    if (this.milestoneEvent !== null) {
      this.milestoneEvent = null;
      this.hudVersion += 1;
    }
  }

  addVelocity(amount: number): void {
    const next = Math.max(0, Math.round(this.velocityTreasury + amount));
    if (next !== this.velocityTreasury) {
      this.velocityTreasury = next;
      this.hudVersion += 1;
    }
  }

  spawnFloatingPopup(x: number, z: number, text: string, color = "#4ade80"): void {
    this.floatingPopups.push({
      id: `pop-${this.nextId++}`,
      x,
      z,
      text,
      color,
      progress: 0,
    });
    this.emitRender();
  }

  private ensureGraph(bundle: CitySnapshotBundle): void {
    if (this.graph && this.lastBundle === bundle) return;

    this.lastBundle = bundle;
    this.graph = buildRoadGraph(bundle.districts, bundle.files, bundle.imports);
    this.bottleneckNodes = this.graph.nodes.filter((n) => n.bottleneckWeight > 0);
    this.cycles = detectImportCycles(bundle.imports);
    let totalLint = 0;
    let complexCount = 0;
    let greenbeltFiles = 0;
    let smogCount = 0;
    const featureFiles: string[] = [];
    for (const f of bundle.files) {
      totalLint += f.lint_issue_count;
      if (f.max_complexity >= 12) complexCount++;
      if (f.building_archetype === "park_stadium") greenbeltFiles++;
      if (f.condition_flags?.smog || f.format_drift) smogCount++;
      if (
        (f.zone_type === "harbor_gates" ||
          f.zone_type === "downtown_core" ||
          f.zone_type === "gallery_storefront") &&
        f.lint_issue_count < 3
      ) {
        featureFiles.push(f.file_path);
      }
    }
    this.bundleStats = {
      totalLint,
      complexPenalty: complexCount * 2,
      greenbeltBoost: Math.min(18, greenbeltFiles * 4.5),
      smogCount,
      featureFiles,
    };
    this.seedTraffic(bundle);
  }

  reset(): void {
    this.clearDisaster();
    if (this.brownoutFiles.size > 0) {
      this.brownoutFiles.clear();
      this.blackoutSnapVersion += 1;
    }
    this.floatingPopups = [];
    this.vehicles = [];
    this.graph = null;
    this.bottleneckNodes = [];
    this.lastBundle = null;
    this.hudVersion += 1;
    this.emitRender();
  }

  private seedTraffic(bundle: CitySnapshotBundle): void {
    if (!this.graph || bundle.files.length === 0) {
      this.vehicles = [];
      return;
    }

    const preservedService = this.vehicles.filter(
      (v) => v.type === "sweeper" || v.type === "fire_truck" || v.type === "crew",
    );
    const nextVehicles: SimVehicle[] = [...preservedService];

    const byPath = new Map<string, FileMetric>();
    for (const f of bundle.files) byPath.set(f.file_path, f);

    const gates = bundle.files.filter((f) => f.building_archetype === "grand_terminal");
    const vaults = bundle.files.filter(
      (f) => f.building_archetype === "twin_silos" || f.building_archetype === "archive_vault",
    );
    const targets = vaults.length > 0 ? vaults : bundle.files;
    const sources = gates.length > 0 ? gates : bundle.files.slice(0, 4);

    // Spawn A* street-routed request cars along imports or gate -> vault corridors
    const maxCars = Math.min(24, Math.max(6, Math.floor(bundle.files.length * 0.7)));
    for (let i = 0; i < maxCars; i++) {
      const imp = bundle.imports.length > 0 ? bundle.imports[i % bundle.imports.length] : null;
      const srcFile = (imp && byPath.get(imp.source_file)) || sources[i % sources.length];
      const dstFile = (imp && byPath.get(imp.target_file)) || targets[(i * 3) % targets.length];
      if (!srcFile || !dstFile) continue;

      const startId = this.graph.fileToNode.get(srcFile.file_path) ?? this.graph.harborNodeIds[0];
      const goalId = this.graph.fileToNode.get(dstFile.file_path) ?? this.graph.nodes[0]?.id;
      if (!startId || !goalId) continue;

      const pathOut = findStreetPath(this.graph, startId, goalId);
      const pathBack = findStreetPath(this.graph, goalId, startId);
      const full = [...pathOut.waypoints, ...pathBack.waypoints.slice(1)];
      if (full.length < 2) continue;

      const startIdx = i % Math.max(1, full.length - 1);
      nextVehicles.push({
        id: `car-${i}`,
        type: "request_car",
        x: full[startIdx].x,
        z: full[startIdx].z,
        heading: 0,
        waypoints: full,
        wpIdx: (startIdx + 1) % full.length,
        speed: 1.45 + (i % 3) * 0.25,
        loop: true,
      });
    }

    // Spawn roundabout cycle cars on circular imports
    this.cycles.slice(0, 6).forEach((cyc, idx) => {
      const pts: Array<{ x: number; z: number }> = [];
      for (let j = 0; j < cyc.length; j++) {
        const fa = this.graph!.fileToNode.get(cyc[j]);
        const fb = this.graph!.fileToNode.get(cyc[(j + 1) % cyc.length]);
        if (fa && fb) {
          const seg = findStreetPath(this.graph!, fa, fb);
          pts.push(...seg.waypoints);
        }
      }
      if (pts.length >= 2) {
        nextVehicles.push({
          id: `cycle-${idx}`,
          type: "cycle_car",
          x: pts[0].x,
          z: pts[0].z,
          heading: 0,
          waypoints: pts,
          wpIdx: 1,
          speed: 1.9,
          loop: true,
        });
      }
    });

    // Spawn cargo ships along Waterfront Supply Docks
    const dockShips = Math.min(4, Math.max(1, bundle.deps.filter((d) => d.is_direct).length));
    for (let s = 0; s < dockShips; s++) {
      const x0 = 6 + s * 22;
      const x1 = Math.min(134, x0 + 36);
      const zShip = 115 + (s % 2) * 3;
      nextVehicles.push({
        id: `ship-${s}`,
        type: "cargo_ship",
        x: x0,
        z: zShip,
        heading: Math.PI * 0.5,
        waypoints: [
          { x: x0, z: zShip },
          { x: x1, z: zShip },
          { x: x0, z: zShip },
        ],
        wpIdx: 1,
        speed: 0.45,
        loop: true,
      });
    }

    this.vehicles = nextVehicles;
  }

  dispatchServiceUnit(
    type: "sweeper" | "fire_truck" | "crew",
    targetFile: FileMetric,
    bundle: CitySnapshotBundle,
  ): void {
    this.ensureGraph(bundle);
    if (!this.graph) return;

    const goalId = this.graph.fileToNode.get(targetFile.file_path) ?? this.graph.nodes[0]?.id;
    const startId =
      this.graph.harborNodeIds[this.nextId % Math.max(1, this.graph.harborNodeIds.length)] ??
      this.graph.nodes[0]?.id;
    if (!startId || !goalId) return;

    const path = findStreetPath(this.graph, startId, goalId);
    const waypoints = [
      ...path.waypoints,
      {
        x: targetFile.layout_x + targetFile.layout_w * 0.5,
        z: targetFile.layout_z + targetFile.layout_d * 0.5,
      },
    ];
    if (waypoints.length < 2) return;

    this.vehicles.push({
      id: `${type}-${this.nextId++}`,
      type,
      x: waypoints[0].x,
      z: waypoints[0].z,
      heading: 0,
      waypoints,
      wpIdx: 1,
      speed: type === "fire_truck" ? 3.2 : 2.3,
      loop: false,
      targetFile: targetFile.file_path,
    });
    this.emitRender();
  }

  triggerPowerOutage(
    sourceFile: string,
    impactedFiles: string[],
    greenbeltProtected: Set<string>,
  ): void {
    this.blackoutFiles.clear();
    this.blackoutFiles.add(sourceFile);
    for (const fp of impactedFiles) {
      if (!greenbeltProtected.has(fp)) {
        this.blackoutFiles.add(fp);
      }
    }
    this.blackoutSnapVersion += 1;
    this.activeDisaster = {
      kind: "power_outage",
      title: "Cascading Power Outage",
      detail: `${this.blackoutFiles.size} modules blacked out from ${sourceFile} (Greenbelt-shielded blocks contained spread).`,
      targetLabel: sourceFile,
      startedTick: this.tickCount,
      resolved: false,
    };
    this.hudVersion += 1;
    this.emitRender();
  }

  triggerBusFactorVacation(authorLabel: string, affectedFiles: string[]): void {
    this.blackoutFiles = new Set(affectedFiles);
    this.blackoutSnapVersion += 1;
    this.activeDisaster = {
      kind: "bus_factor_vacation",
      title: `Bus Factor Vacation: ${authorLabel}`,
      detail: `${affectedFiles.length} sole-maintainer modules went dark with warning sirens.`,
      targetLabel: authorLabel,
      startedTick: this.tickCount,
      resolved: affectedFiles.length === 0,
    };
    this.hudVersion += 1;
    this.emitRender();
  }

  triggerCrunchStorm(bundle: CitySnapshotBundle): void {
    this.fireFiles.clear();
    const hot = [...bundle.files]
      .filter((f) => f.building_archetype !== "park_stadium")
      .sort((a, b) => b.hotspot_score - a.hotspot_score)
      .slice(0, 6);
    const greenbeltDistricts = new Set(
      bundle.files
        .filter((f) => f.building_archetype === "park_stadium")
        .map((f) => f.district_path),
    );
    for (const f of hot) {
      if (!greenbeltDistricts.has(f.district_path) || this.fireFiles.size < 2) {
        this.fireFiles.add(f.file_path);
        this.dispatchServiceUnit("fire_truck", f, bundle);
      }
    }
    this.fireSnapVersion += 1;
    this.activeDisaster = {
      kind: "crunch_storm",
      title: "Release Crunch Storm",
      detail: `${this.fireFiles.size} untested hotspot towers ignited! Fire trucks dispatched.`,
      targetLabel: hot[0]?.file_path ?? "Hotspots",
      startedTick: this.tickCount,
      resolved: this.fireFiles.size === 0,
    };
    this.hudVersion += 1;
    this.emitRender();
  }

  triggerSupplyDockStorm(depName: string, bundle: CitySnapshotBundle): void {
    const harborAndVault = bundle.files
      .filter(
        (f) =>
          f.zone_type === "harbor_gates" ||
          f.zone_type === "vaults_reservoir" ||
          f.zone_type === "industrial_quarter",
      )
      .slice(0, 6);
    this.blackoutFiles = new Set(harborAndVault.map((f) => f.file_path));
    this.blackoutSnapVersion += 1;
    this.activeDisaster = {
      kind: "supply_dock_storm",
      title: `Supply Dock Storm: ${depName}`,
      detail: `Waterfront dependency disruption rippling into ${this.blackoutFiles.size} importing modules.`,
      targetLabel: depName,
      startedTick: this.tickCount,
      resolved: false,
    };
    this.hudVersion += 1;
    this.emitRender();
  }

  clearDisaster(): void {
    const hadFire = this.fireFiles.size > 0;
    const hadBlackout = this.blackoutFiles.size > 0;
    const hadDisaster = this.activeDisaster !== null;
    if (hadFire) {
      this.fireFiles.clear();
      this.fireSnapVersion += 1;
    }
    if (hadBlackout) {
      this.blackoutFiles.clear();
      this.blackoutSnapVersion += 1;
    }
    this.activeDisaster = null;
    if (hadFire || hadBlackout || hadDisaster) {
      this.hudVersion += 1;
      this.emitRender();
    }
  }

  clearFloatingPopups(): void {
    if (this.floatingPopups.length > 0) {
      this.floatingPopups = [];
      this.emitRender();
    }
  }

  private advanceVehicles(): void {
    const nodeLoad = new Map<string, number>();
    if (this.graph) {
      for (const v of this.vehicles) {
        if (v.type === "cargo_ship") continue;
        for (const n of this.graph.nodes) {
          if (Math.hypot(v.x - n.x, v.z - n.z) < 4.5) {
            nodeLoad.set(n.id, (nodeLoad.get(n.id) ?? 0) + 1);
          }
        }
      }
    }

    const remainingVehicles: SimVehicle[] = [];
    for (const v of this.vehicles) {
      const tgt = v.waypoints[v.wpIdx];
      if (!tgt) continue;

      let localSpeed = v.speed;
      let isJammed = false;
      if (this.bottleneckNodes.length > 0 && v.type !== "cargo_ship" && v.type !== "fire_truck") {
        for (const n of this.bottleneckNodes) {
          if (Math.hypot(v.x - n.x, v.z - n.z) < 5.5) {
            const load = nodeLoad.get(n.id) ?? 1;
            if (load >= 2 || n.bottleneckWeight >= 1.4) {
              localSpeed *= 0.35;
              isJammed = true;
              break;
            }
          }
        }
      }
      v.jammed = isJammed;

      const dx = tgt.x - v.x;
      const dz = tgt.z - v.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= localSpeed) {
        v.x = tgt.x;
        v.z = tgt.z;
        if (v.wpIdx + 1 < v.waypoints.length) {
          v.wpIdx += 1;
          remainingVehicles.push(v);
        } else if (v.loop) {
          v.wpIdx = 0;
          remainingVehicles.push(v);
        } else if (v.type === "fire_truck" && v.targetFile && this.fireFiles.has(v.targetFile)) {
          this.fireFiles.delete(v.targetFile);
          this.fireSnapVersion += 1;
          this.hudVersion += 1;
          this.spawnFloatingPopup(v.x, v.z, "🔥 Fire Contained", "#4ade80");
          if (this.fireFiles.size === 0 && this.activeDisaster?.kind === "crunch_storm") {
            this.activeDisaster = { ...this.activeDisaster, resolved: true };
          }
        }
      } else {
        v.x += (dx / dist) * localSpeed;
        v.z += (dz / dist) * localSpeed;
        v.heading = Math.atan2(dx, dz);
        remainingVehicles.push(v);
      }
    }
    this.vehicles = remainingVehicles;
  }

  /** Advance ambient traffic without building a full snapshot or bumping HUD state. */
  stepAmbient(bundle: CitySnapshotBundle): void {
    this.ensureGraph(bundle);
    this.advanceVehicles();
    this.emitRender();
  }

  step(bundle: CitySnapshotBundle, options?: { ambientOnly?: boolean }): SimStateSnapshot {
    this.ensureGraph(bundle);

    if (options?.ambientOnly) {
      this.advanceVehicles();
      this.emitRender();
      return this.getSnapshot();
    }

    if (this.speed > 0) {
      this.tickCount += 1;
      this.sprintTicks += 1;

      // Advance floating popups
      this.floatingPopups = this.floatingPopups
        .map((p) => ({ ...p, progress: p.progress + 0.055 }))
        .filter((p) => p.progress < 1);

      const { totalLint, complexPenalty, greenbeltBoost, smogCount, featureFiles } =
        this.bundleStats;
      let healthyFeatures = 0;
      for (const fp of featureFiles) {
        if (!this.blackoutFiles.has(fp) && !this.fireFiles.has(fp)) healthyFeatures++;
      }
      const firePenalty = this.fireFiles.size * 5;
      const income = Math.max(15, 22 + healthyFeatures * 4);
      const upkeep = Math.round(
        totalLint * 0.65 + complexPenalty + firePenalty + this.cycles.length * 4,
      );
      this.incomePerSprint = income;
      this.upkeepPerSprint = upkeep;

      if (this.sprintTicks >= TICKS_PER_SPRINT) {
        this.sprintTicks = 0;
        this.sprintNumber += 1;
        this.velocityTreasury = Math.max(0, this.velocityTreasury + (income - upkeep));
      }

      this.advanceVehicles();

      const jammedCount = this.vehicles.filter((v) => v.jammed).length;
      const targetHappiness = Math.max(
        18,
        Math.min(
          99,
          76 +
            greenbeltBoost -
            smogCount * 2.5 -
            jammedCount * 1.4 -
            this.fireFiles.size * 6 -
            this.blackoutFiles.size * 3.5 -
            this.cycles.length * 3,
        ),
      );
      this.happiness = Math.round((this.happiness * 0.85 + targetHappiness * 0.15) * 10) / 10;

      // Brownouts when overloaded hubs push happiness below 52
      const nextBrownouts = this.happiness < 54 ? (this.graph?.bottleneckFilePaths ?? null) : null;
      const nextSize = nextBrownouts ? nextBrownouts.size : 0;
      let brownoutChanged = nextSize !== this.brownoutFiles.size;
      if (!brownoutChanged && nextBrownouts) {
        for (const fp of nextBrownouts) {
          if (!this.brownoutFiles.has(fp)) {
            brownoutChanged = true;
            break;
          }
        }
      }
      if (brownoutChanged) {
        this.brownoutFiles.clear();
        if (nextBrownouts) {
          for (const fp of nextBrownouts) this.brownoutFiles.add(fp);
        }
        this.blackoutSnapVersion += 1;
      }

      const nextLevel = computeCityMilestone(
        bundle.snapshot.health_score,
        bundle.files.length,
        this.happiness,
      );
      const rank = [
        "Frontier Outpost",
        "Bustling Harbor Town",
        "Civic Metropolis",
        "A+ Sunlit Smart City",
      ];
      if (rank.indexOf(nextLevel) > rank.indexOf(this.cityLevel)) {
        this.milestoneEvent = nextLevel;
      }
      this.cityLevel = nextLevel;
      this.hudVersion += 1;
      this.emitRender();
    }

    return this.getSnapshot();
  }

  getFollowedVehicle(preferredId: string | null): SimVehicleRender | null {
    if (this.vehicles.length === 0) return null;
    if (preferredId && preferredId !== "auto") {
      const exact = this.vehicles.find((v) => v.id === preferredId);
      if (exact) return exact;
    }
    const car = this.vehicles.find((v) => v.type !== "cargo_ship");
    return car ?? this.vehicles[0] ?? null;
  }

  getSnapshot(): SimStateSnapshot {
    return {
      tick: this.tickCount,
      speed: this.speed,
      sprintNumber: this.sprintNumber,
      sprintProgress: this.sprintTicks / TICKS_PER_SPRINT,
      velocityTreasury: this.velocityTreasury,
      incomePerSprint: this.incomePerSprint,
      upkeepPerSprint: this.upkeepPerSprint,
      happiness: Math.round(this.happiness),
      cityLevel: this.cityLevel,
      jammedCount: this.vehicles.filter((v) => v.jammed).length,
      cycleCount: this.cycles.length,
      vehicles: this.vehicles.map((v) => ({
        id: v.id,
        type: v.type,
        x: v.x,
        z: v.z,
        heading: v.heading,
        jammed: v.jammed,
      })),
      fireFiles: this.getStableFireFiles(),
      blackoutFiles: this.getStableBlackoutFiles(),
      activeDisaster: this.activeDisaster,
      floatingPopups: [...this.floatingPopups],
      milestoneEvent: this.milestoneEvent,
    };
  }
}
