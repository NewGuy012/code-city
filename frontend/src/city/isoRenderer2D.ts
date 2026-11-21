import type {
  BlastRadiusResult,
  BuildingArchetype,
  CochangePair,
  DataMapMode,
  District,
  ExternalDep,
  FileImport,
  FileMetric,
  ZoneType,
} from "../types/city";

export interface Camera2D {
  panX: number;
  panY: number;
  zoom: number;
}

export interface GhostLot {
  file_path: string;
  layout_x: number;
  layout_z: number;
  layout_w: number;
  layout_d: number;
}

export interface RenderCitySceneArgs {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  camera: Camera2D;
  timeSec: number;
  districts: District[];
  files: FileMetric[];
  imports: FileImport[];
  cochanges: CochangePair[];
  deps: ExternalDep[];
  dataMap: DataMapMode;
  selectedFile: string | null;
  hoveredFile: string | null;
  blastRadius: BlastRadiusResult | null;
  addedFiles: Set<string>;
  removedLots: GhostLot[];
  showTraffic: boolean;
}

export interface HitBuilding {
  file: FileMetric;
  screenX: number;
  screenY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const WORLD_CENTER_X = 70;
const WORLD_CENTER_Z = 52;
const ISO_X = 7.4;
const ISO_Y = 3.7;

export function worldToIso(x: number, z: number, y = 0): { x: number; y: number } {
  const dx = x - WORLD_CENTER_X;
  const dz = z - WORLD_CENTER_Z;
  return {
    x: (dx - dz) * ISO_X,
    y: (dx + dz) * ISO_Y - y,
  };
}

export function isoToScreen(
  isoX: number,
  isoY: number,
  width: number,
  height: number,
  camera: Camera2D,
): { x: number; y: number } {
  return {
    x: width * 0.5 + camera.panX + isoX * camera.zoom,
    y: height * 0.52 + camera.panY + isoY * camera.zoom,
  };
}

export function worldToScreen(
  wx: number,
  wz: number,
  wy: number,
  width: number,
  height: number,
  camera: Camera2D,
): { x: number; y: number } {
  const iso = worldToIso(wx, wz, wy);
  return isoToScreen(iso.x, iso.y, width, height, camera);
}

export function screenToWorldGround(
  sx: number,
  sy: number,
  width: number,
  height: number,
  camera: Camera2D,
): { x: number; z: number } {
  const isoX = (sx - width * 0.5 - camera.panX) / camera.zoom;
  const isoY = (sy - height * 0.52 - camera.panY) / camera.zoom;
  const dx = 0.5 * (isoX / ISO_X + isoY / ISO_Y);
  const dz = 0.5 * (isoY / ISO_Y - isoX / ISO_X);
  return {
    x: dx + WORLD_CENTER_X,
    z: dz + WORLD_CENTER_Z,
  };
}

interface ShadePalette {
  roof: string;
  left: string;
  right: string;
  accent: string;
}

const ZONE_GROUND: Record<ZoneType, { fill: string; border: string; label: string }> = {
  harbor_gates: { fill: "#18334e", border: "#38bdf8", label: "Harbor & Gates" },
  downtown_core: { fill: "#1e293b", border: "#fbbf24", label: "Downtown Core" },
  vaults_reservoir: { fill: "#28263b", border: "#a78bfa", label: "Vaults & Reservoir" },
  industrial_quarter: { fill: "#2b251c", border: "#f97316", label: "Industrial Quarter" },
  gallery_storefront: { fill: "#1d2d44", border: "#f472b6", label: "Gallery District" },
  civic_utilities: { fill: "#1a2f35", border: "#2dd4bf", label: "Civic & Utilities" },
  greenbelt_parks: { fill: "#153625", border: "#4ade80", label: "Greenbelt Parks" },
  supply_docks: { fill: "#172b3e", border: "#60a5fa", label: "Supply Docks" },
};

const ARCHETYPE_PALETTES: Record<BuildingArchetype, ShadePalette> = {
  grand_terminal: { roof: "#38bdf8", left: "#0284c7", right: "#075985", accent: "#fef08a" },
  city_hall: { roof: "#fde68a", left: "#d97706", right: "#92400e", accent: "#fffbeb" },
  archive_vault: { roof: "#cbd5e1", left: "#94a3b8", right: "#475569", accent: "#a78bfa" },
  twin_silos: { roof: "#a5b4fc", left: "#6366f1", right: "#3730a3", accent: "#e0e7ff" },
  factory: { roof: "#fdba74", left: "#ea580c", right: "#9a3412", accent: "#fed7aa" },
  office_tower: { roof: "#93c5fd", left: "#3b82f6", right: "#1e40af", accent: "#dbeafe" },
  glass_pavilion: { roof: "#67e8f9", left: "#06b6d4", right: "#155e75", accent: "#f472b6" },
  watchtower: { roof: "#5eead4", left: "#0d9488", right: "#115e59", accent: "#99f6e4" },
  civic_kiosk: { roof: "#94a3b8", left: "#64748b", right: "#334155", accent: "#e2e8f0" },
  park_stadium: { roof: "#4ade80", left: "#16a34a", right: "#14532d", accent: "#bbf7d0" },
};

const LANGUAGE_PALETTES: Record<string, ShadePalette> = {
  python: { roof: "#60a5fa", left: "#2563eb", right: "#1e3a8a", accent: "#fde047" },
  typescript: { roof: "#fde047", left: "#eab308", right: "#854d0e", accent: "#fef9c3" },
  javascript: { roof: "#fcd34d", left: "#d97706", right: "#78350f", accent: "#fef3c7" },
  rust: { roof: "#fdba74", left: "#ea580c", right: "#7c2d12", accent: "#ffedd5" },
  go: { roof: "#67e8f9", left: "#06b6d4", right: "#155e75", accent: "#cffafe" },
  other: { roof: "#cbd5e1", left: "#64748b", right: "#334155", accent: "#f1f5f9" },
};

function buildingPalette(file: FileMetric, dataMap: DataMapMode): ShadePalette {
  if (dataMap === "living") {
    return ARCHETYPE_PALETTES[file.building_archetype] ?? ARCHETYPE_PALETTES.office_tower;
  }
  if (dataMap === "languages") {
    return LANGUAGE_PALETTES[file.language] ?? LANGUAGE_PALETTES.other;
  }
  if (dataMap === "hotspots") {
    if (file.hotspot_score >= 16) {
      return { roof: "#fca5a5", left: "#ef4444", right: "#991b1b", accent: "#fef2f2" };
    }
    if (file.hotspot_score >= 6) {
      return { roof: "#fdba74", left: "#f97316", right: "#9a3412", accent: "#fff7ed" };
    }
    if (file.hotspot_score >= 1.5) {
      return { roof: "#fde68a", left: "#eab308", right: "#854d0e", accent: "#fefce8" };
    }
    return { roof: "#64748b", left: "#475569", right: "#1e293b", accent: "#94a3b8" };
  }
  if (dataMap === "pollution") {
    const debt = file.lint_issue_count + (file.format_drift ? 2 : 0);
    if (debt >= 5) {
      return { roof: "#e879f9", left: "#a855f7", right: "#581c87", accent: "#fae8ff" };
    }
    if (debt >= 1) {
      return { roof: "#fcd34d", left: "#d97706", right: "#78350f", accent: "#fef3c7" };
    }
    return { roof: "#6ee7b7", left: "#10b981", right: "#065f46", accent: "#d1fae5" };
  }
  if (dataMap === "bus_factor") {
    if (file.distinct_authors_90d <= 1) {
      return file.condition_flags?.lone_keeper
        ? { roof: "#fda4af", left: "#e11d48", right: "#881337", accent: "#ffe4e6" }
        : { roof: "#fde047", left: "#ca8a04", right: "#713f12", accent: "#fef9c3" };
    }
    if (file.distinct_authors_90d === 2) {
      return { roof: "#93c5fd", left: "#3b82f6", right: "#1e3a8a", accent: "#dbeafe" };
    }
    return { roof: "#5eead4", left: "#0d9488", right: "#134e4a", accent: "#ccfbf1" };
  }
  // format_drift
  return file.format_drift
    ? { roof: "#f0abfc", left: "#c026d3", right: "#701a75", accent: "#fdf4ff" }
    : { roof: "#7dd3fc", left: "#0284c7", right: "#0c4a6e", accent: "#e0f2fe" };
}

function computeBuildingHeight(file: FileMetric): number {
  if (file.building_archetype === "park_stadium") {
    return 6;
  }
  const slocFactor = Math.log2(Math.max(8, file.sloc)) * 4.2;
  const compFactor = Math.min(26, file.max_complexity * 2.1);
  const symbolFactor = Math.min(12, file.symbol_count * 0.9);
  const roleBoost =
    file.building_archetype === "city_hall"
      ? 14
      : file.building_archetype === "grand_terminal"
        ? 8
        : 0;
  return Math.max(12, Math.min(86, slocFactor + compFactor + symbolFactor + roleBoost));
}

function drawIsoPrism(
  ctx: CanvasRenderingContext2D,
  x: number,
  z: number,
  w: number,
  d: number,
  yBase: number,
  h: number,
  palette: ShadePalette,
  wScreen: number,
  hScreen: number,
  cam: Camera2D,
  strokeColor?: string,
  lineWidth = 1,
): void {
  const p00 = worldToScreen(x, z, yBase + h, wScreen, hScreen, cam);
  const p10 = worldToScreen(x + w, z, yBase + h, wScreen, hScreen, cam);
  const p11 = worldToScreen(x + w, z + d, yBase + h, wScreen, hScreen, cam);
  const p01 = worldToScreen(x, z + d, yBase + h, wScreen, hScreen, cam);

  const b10 = worldToScreen(x + w, z, yBase, wScreen, hScreen, cam);
  const b11 = worldToScreen(x + w, z + d, yBase, wScreen, hScreen, cam);
  const b01 = worldToScreen(x, z + d, yBase, wScreen, hScreen, cam);

  // Left visible face (z + d side)
  ctx.beginPath();
  ctx.moveTo(p01.x, p01.y);
  ctx.lineTo(p11.x, p11.y);
  ctx.lineTo(b11.x, b11.y);
  ctx.lineTo(b01.x, b01.y);
  ctx.closePath();
  ctx.fillStyle = palette.left;
  ctx.fill();
  if (strokeColor) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  // Right visible face (x + w side)
  ctx.beginPath();
  ctx.moveTo(p10.x, p10.y);
  ctx.lineTo(p11.x, p11.y);
  ctx.lineTo(b11.x, b11.y);
  ctx.lineTo(b10.x, b10.y);
  ctx.closePath();
  ctx.fillStyle = palette.right;
  ctx.fill();
  if (strokeColor) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  // Roof face
  ctx.beginPath();
  ctx.moveTo(p00.x, p00.y);
  ctx.lineTo(p10.x, p10.y);
  ctx.lineTo(p11.x, p11.y);
  ctx.lineTo(p01.x, p01.y);
  ctx.closePath();
  ctx.fillStyle = palette.roof;
  ctx.fill();
  if (strokeColor) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function drawGroundQuad(
  ctx: CanvasRenderingContext2D,
  x: number,
  z: number,
  w: number,
  d: number,
  y: number,
  fill: string,
  stroke: string | null,
  wScreen: number,
  hScreen: number,
  cam: Camera2D,
  lineWidth = 1,
): void {
  const a = worldToScreen(x, z, y, wScreen, hScreen, cam);
  const b = worldToScreen(x + w, z, y, wScreen, hScreen, cam);
  const c = worldToScreen(x + w, z + d, y, wScreen, hScreen, cam);
  const e = worldToScreen(x, z + d, y, wScreen, hScreen, cam);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(e.x, e.y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function drawBuildingDetails(
  ctx: CanvasRenderingContext2D,
  file: FileMetric,
  bx: number,
  bz: number,
  bw: number,
  bd: number,
  height: number,
  palette: ShadePalette,
  timeSec: number,
  wScreen: number,
  hScreen: number,
  cam: Camera2D,
  stroke: string,
): void {
  const arch = file.building_archetype;
  const zoom = cam.zoom;

  if (arch === "park_stadium") {
    // Lush green proving park + stadium track + isometric trees
    drawGroundQuad(ctx, bx, bz, bw, bd, 1, "#14532d", "#4ade80", wScreen, hScreen, cam, 1.1);
    const cx = bx + bw * 0.5;
    const cz = bz + bd * 0.5;
    const center = worldToScreen(cx, cz, 2.5, wScreen, hScreen, cam);
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.scale(1, 0.5);
    ctx.beginPath();
    ctx.arc(0, 0, Math.min(bw, bd) * 2.2 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = "#fde68a";
    ctx.lineWidth = Math.max(1, 1.5 * zoom);
    ctx.stroke();
    ctx.restore();

    // Two crisp trees
    for (const [ox, oz] of [
      [0.24, 0.28],
      [0.74, 0.72],
    ]) {
      const tp = worldToScreen(bx + bw * ox, bz + bd * oz, 5 * zoom, wScreen, hScreen, cam);
      ctx.beginPath();
      ctx.arc(tp.x, tp.y, Math.max(2.5, 4.2 * zoom), 0, Math.PI * 2);
      ctx.fillStyle = "#22c55e";
      ctx.fill();
    }
    return;
  }

  // Base structure
  drawIsoPrism(ctx, bx, bz, bw, bd, 0, height * zoom, palette, wScreen, hScreen, cam, stroke, 1);

  if (arch === "city_hall") {
    // Stepped Art-Deco crown + civic spire
    drawIsoPrism(
      ctx,
      bx + bw * 0.22,
      bz + bd * 0.22,
      bw * 0.56,
      bd * 0.56,
      height * zoom,
      height * 0.34 * zoom,
      palette,
      wScreen,
      hScreen,
      cam,
      stroke,
      0.8,
    );
    const tipBase = worldToScreen(
      bx + bw * 0.5,
      bz + bd * 0.5,
      height * 1.34 * zoom,
      wScreen,
      hScreen,
      cam,
    );
    const tipTop = worldToScreen(
      bx + bw * 0.5,
      bz + bd * 0.5,
      (height * 1.34 + 14) * zoom,
      wScreen,
      hScreen,
      cam,
    );
    ctx.beginPath();
    ctx.moveTo(tipBase.x, tipBase.y);
    ctx.lineTo(tipTop.x, tipTop.y);
    ctx.strokeStyle = "#fef08a";
    ctx.lineWidth = Math.max(1.5, 2 * zoom);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tipTop.x, tipTop.y, Math.max(2, 2.8 * zoom), 0, Math.PI * 2);
    ctx.fillStyle = "#fde047";
    ctx.fill();
  } else if (arch === "twin_silos") {
    // Twin roof tanks / domes
    for (const ox of [0.3, 0.7]) {
      drawIsoPrism(
        ctx,
        bx + bw * (ox - 0.14),
        bz + bd * 0.28,
        bw * 0.28,
        bd * 0.44,
        height * zoom,
        height * 0.25 * zoom,
        { ...palette, roof: palette.accent },
        wScreen,
        hScreen,
        cam,
        stroke,
        0.7,
      );
    }
  } else if (arch === "factory") {
    // Sawtooth industrial roof monitor + twin smokestacks
    drawIsoPrism(
      ctx,
      bx + bw * 0.15,
      bz + bd * 0.15,
      bw * 0.32,
      bd * 0.7,
      height * zoom,
      7 * zoom,
      palette,
      wScreen,
      hScreen,
      cam,
      stroke,
      0.7,
    );
    const stackPos = worldToScreen(
      bx + bw * 0.78,
      bz + bd * 0.26,
      height * zoom,
      wScreen,
      hScreen,
      cam,
    );
    const stackTop = worldToScreen(
      bx + bw * 0.78,
      bz + bd * 0.26,
      (height + 11) * zoom,
      wScreen,
      hScreen,
      cam,
    );
    ctx.beginPath();
    ctx.moveTo(stackPos.x, stackPos.y);
    ctx.lineTo(stackTop.x, stackTop.y);
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = Math.max(2.5, 3.5 * zoom);
    ctx.stroke();
  } else if (arch === "grand_terminal") {
    // Arched gateway beacon dome
    drawIsoPrism(
      ctx,
      bx + bw * 0.18,
      bz + bd * 0.18,
      bw * 0.64,
      bd * 0.64,
      height * zoom,
      9 * zoom,
      { ...palette, roof: "#fef08a" },
      wScreen,
      hScreen,
      cam,
      stroke,
      0.8,
    );
  } else if (arch === "archive_vault") {
    // Colonnaded pediment step
    drawIsoPrism(
      ctx,
      bx + bw * 0.1,
      bz + bd * 0.1,
      bw * 0.8,
      bd * 0.8,
      height * zoom,
      5 * zoom,
      { ...palette, roof: "#e2e8f0" },
      wScreen,
      hScreen,
      cam,
      stroke,
      0.8,
    );
  } else if (arch === "watchtower") {
    // Narrow armored turret top
    drawIsoPrism(
      ctx,
      bx + bw * 0.28,
      bz + bd * 0.28,
      bw * 0.44,
      bd * 0.44,
      height * zoom,
      10 * zoom,
      palette,
      wScreen,
      hScreen,
      cam,
      stroke,
      0.8,
    );
  } else if (arch === "office_tower" && height > 30) {
    // Upper setback tier + glowing window bands
    drawIsoPrism(
      ctx,
      bx + bw * 0.18,
      bz + bd * 0.18,
      bw * 0.64,
      bd * 0.64,
      height * zoom,
      height * 0.24 * zoom,
      palette,
      wScreen,
      hScreen,
      cam,
      stroke,
      0.7,
    );
  } else if (arch === "glass_pavilion") {
    // Rooftop terrace strip
    drawIsoPrism(
      ctx,
      bx + bw * 0.16,
      bz + bd * 0.16,
      bw * 0.68,
      bd * 0.68,
      height * zoom,
      5 * zoom,
      { ...palette, roof: "#f472b6" },
      wScreen,
      hScreen,
      cam,
      stroke,
      0.7,
    );
  }

  // Condition Signals: Crane, Smog, Lone-Keeper Lighthouse
  const roofCenter = worldToScreen(
    bx + bw * 0.5,
    bz + bd * 0.5,
    (height + 4) * zoom,
    wScreen,
    hScreen,
    cam,
  );

  if (file.condition_flags?.crane) {
    // Animated construction crane jib!
    const mastTop = { x: roofCenter.x, y: roofCenter.y - 16 * zoom };
    const angle = Math.sin(timeSec * 1.1 + bx) * 0.55;
    const jibLen = 17 * zoom;
    ctx.save();
    ctx.strokeStyle = "#facc15";
    ctx.lineWidth = Math.max(1.5, 2 * zoom);
    ctx.beginPath();
    ctx.moveTo(roofCenter.x, roofCenter.y);
    ctx.lineTo(mastTop.x, mastTop.y);
    ctx.lineTo(mastTop.x + Math.cos(angle) * jibLen, mastTop.y + Math.sin(angle) * 5 * zoom);
    ctx.moveTo(mastTop.x, mastTop.y);
    ctx.lineTo(mastTop.x - Math.cos(angle) * jibLen * 0.4, mastTop.y - Math.sin(angle) * 2 * zoom);
    ctx.stroke();
    // Hanging hook
    const hookX = mastTop.x + Math.cos(angle) * jibLen * 0.78;
    const hookY = mastTop.y + Math.sin(angle) * 3.8 * zoom;
    ctx.beginPath();
    ctx.moveTo(hookX, hookY);
    ctx.lineTo(hookX, hookY + 7 * zoom);
    ctx.strokeStyle = "#fef08a";
    ctx.lineWidth = Math.max(1, 1.2 * zoom);
    ctx.stroke();
    ctx.restore();
  }

  if (file.condition_flags?.smog || file.lint_issue_count >= 3) {
    // Drifting pollution smog puffs
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const phase = timeSec * 0.9 + i * 2.1 + bz;
      const sx = roofCenter.x + Math.sin(phase) * 7 * zoom;
      const sy = roofCenter.y - (8 + ((phase * 6) % 16)) * zoom;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(2.5, (4.8 - i * 0.8) * zoom), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(168, 85, 247, 0.34)";
      ctx.fill();
    }
    ctx.restore();
  }

  if (file.condition_flags?.lone_keeper) {
    // Solitary lighthouse pulse (Bus Factor = 1)
    const pulse = 0.5 + 0.5 * Math.sin(timeSec * 3.4);
    ctx.save();
    ctx.beginPath();
    ctx.arc(roofCenter.x, roofCenter.y - 4 * zoom, (5 + pulse * 6) * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(251, 113, 133, ${0.85 - pulse * 0.55})`;
    ctx.lineWidth = Math.max(1.2, 1.8 * zoom);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(roofCenter.x, roofCenter.y - 4 * zoom, Math.max(2, 2.5 * zoom), 0, Math.PI * 2);
    ctx.fillStyle = "#fb7185";
    ctx.fill();
    ctx.restore();
  }
}

export function renderCityScene(args: RenderCitySceneArgs): HitBuilding[] {
  const {
    ctx,
    width,
    height,
    camera,
    timeSec,
    districts,
    files,
    imports,
    cochanges,
    deps,
    dataMap,
    selectedFile,
    hoveredFile,
    blastRadius,
    addedFiles,
    removedLots,
    showTraffic,
  } = args;

  ctx.clearRect(0, 0, width, height);

  // 1. Deep harbor water backdrop + subtle animated ripples
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, "#050d1a");
  grad.addColorStop(1, "#0b1f38");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.strokeStyle = "rgba(56, 189, 248, 0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 16; i++) {
    const wy = ((i * 58 + timeSec * 8) % (height + 40)) - 20;
    ctx.beginPath();
    ctx.moveTo(0, wy);
    ctx.bezierCurveTo(
      width * 0.3,
      wy + Math.sin(timeSec + i) * 6,
      width * 0.7,
      wy - Math.cos(timeSec + i) * 6,
      width,
      wy,
    );
    ctx.stroke();
  }
  ctx.restore();

  // 2. City Foundation Island Slab (with 3D beveled shoreline)
  drawIsoPrism(
    ctx,
    -2,
    -2,
    144,
    108,
    -5 * camera.zoom,
    5 * camera.zoom,
    { roof: "#0f172a", left: "#1e293b", right: "#0f172a", accent: "#334155" },
    width,
    height,
    camera,
    "rgba(56, 189, 248, 0.35)",
    1.4,
  );

  // 3. Waterfront Supply Docks (direct external dependencies from lockfiles)
  const directDeps = deps.filter((d) => d.is_direct).slice(0, 8);
  if (directDeps.length > 0) {
    directDeps.forEach((dep, idx) => {
      const dockX = 10 + idx * 16;
      const dockZ = 107;
      drawIsoPrism(
        ctx,
        dockX,
        dockZ,
        11,
        5.5,
        -2 * camera.zoom,
        4 * camera.zoom,
        { roof: "#92400e", left: "#78350f", right: "#451a03", accent: "#fbbf24" },
        width,
        height,
        camera,
        "rgba(251, 191, 36, 0.45)",
        0.9,
      );
      if (camera.zoom >= 0.7) {
        const lbl = worldToScreen(dockX + 5.5, dockZ + 3, 5 * camera.zoom, width, height, camera);
        ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
        ctx.font = `${Math.max(8, Math.round(9 * camera.zoom))}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.fillText(dep.package_name.slice(0, 14), lbl.x, lbl.y);
      }
    });
  }

  // 4. Zoned District Neighborhood Plates
  for (const dist of districts) {
    const zStyle = ZONE_GROUND[dist.zone_type] ?? ZONE_GROUND.downtown_core;
    drawGroundQuad(
      ctx,
      dist.bounds_x,
      dist.bounds_z,
      dist.bounds_w,
      dist.bounds_d,
      0.3,
      zStyle.fill,
      zStyle.border,
      width,
      height,
      camera,
      1.1,
    );
  }

  // 5. Ghost Diff Demolished Lots (files present in previous snapshot but removed now)
  for (const lot of removedLots) {
    const pad = 0.25;
    const x = lot.layout_x + pad;
    const z = lot.layout_z + pad;
    const w = Math.max(0.8, lot.layout_w - pad * 2);
    const d = Math.max(0.8, lot.layout_d - pad * 2);
    ctx.save();
    ctx.setLineDash([4, 3]);
    drawGroundQuad(
      ctx,
      x,
      z,
      w,
      d,
      0.8,
      "rgba(239, 68, 68, 0.16)",
      "rgba(248, 113, 113, 0.85)",
      width,
      height,
      camera,
      1.4,
    );
    ctx.restore();
  }

  // Index file coordinates for traffic pulses, blast radius & seismic fault lines
  const fileByPath = new Map<string, FileMetric>();
  for (const f of files) {
    fileByPath.set(f.file_path, f);
  }

  // 6. Animated Import Artery Traffic Pulses
  if (showTraffic && imports.length > 0) {
    ctx.save();
    const maxEdges = Math.min(80, imports.length);
    for (let i = 0; i < maxEdges; i++) {
      const edge = imports[i];
      const src = fileByPath.get(edge.source_file);
      const dst = fileByPath.get(edge.target_file);
      if (!src || !dst) continue;
      const pA = worldToScreen(
        src.layout_x + src.layout_w * 0.5,
        src.layout_z + src.layout_d * 0.5,
        2,
        width,
        height,
        camera,
      );
      const pB = worldToScreen(
        dst.layout_x + dst.layout_w * 0.5,
        dst.layout_z + dst.layout_d * 0.5,
        2,
        width,
        height,
        camera,
      );
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.14)";
      ctx.lineWidth = 1;
      ctx.stroke();

      const t = (timeSec * 0.45 + i * 0.17) % 1;
      const px = pA.x + (pB.x - pA.x) * t;
      const py = pA.y + (pB.y - pA.y) * t;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1.4, 2 * camera.zoom), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(125, 211, 252, 0.78)";
      ctx.fill();
    }
    ctx.restore();
  }

  // Blast radius lookup map
  const impactedHop = new Map<string, number>();
  if (blastRadius) {
    for (const node of blastRadius.impacted_files) {
      impactedHop.set(node.file_path, node.hop_distance);
    }
  }

  // 7. Sort Buildings Back-to-Front (Painter's Algorithm) and Draw!
  const sortedFiles = [...files].sort((a, b) => {
    const da = a.layout_x + a.layout_w * 0.5 + (a.layout_z + a.layout_d * 0.5);
    const db = b.layout_x + b.layout_w * 0.5 + (b.layout_z + b.layout_d * 0.5);
    return da - db;
  });

  const hits: HitBuilding[] = [];
  for (const file of sortedFiles) {
    const pad = Math.min(0.45, Math.min(file.layout_w, file.layout_d) * 0.14);
    const bx = file.layout_x + pad;
    const bz = file.layout_z + pad;
    const bw = Math.max(0.9, file.layout_w - pad * 2);
    const bd = Math.max(0.9, file.layout_d - pad * 2);
    const heightVal = computeBuildingHeight(file);

    const isSelected = selectedFile === file.file_path;
    const isHovered = hoveredFile === file.file_path;
    const hop = impactedHop.get(file.file_path);
    const isAdded = addedFiles.has(file.file_path);

    let palette = buildingPalette(file, dataMap);
    let stroke = "rgba(15, 23, 42, 0.72)";

    if (isAdded) {
      palette = { roof: "#6ee7b7", left: "#10b981", right: "#065f46", accent: "#d1fae5" };
      stroke = "#34d399";
    }

    let alpha = 1.0;
    if (selectedFile && blastRadius) {
      if (isSelected) {
        stroke = "#fef08a";
      } else if (hop === 1) {
        palette = { roof: "#fde047", left: "#f59e0b", right: "#b45309", accent: "#fef9c3" };
        stroke = "#fbbf24";
      } else if (hop !== undefined && hop >= 2) {
        palette = { roof: "#7dd3fc", left: "#0284c7", right: "#0369a1", accent: "#e0f2fe" };
        stroke = "#38bdf8";
      } else {
        alpha = 0.28;
      }
    } else if (isSelected) {
      stroke = "#fef08a";
    } else if (isHovered) {
      stroke = "#ffffff";
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    drawBuildingDetails(
      ctx,
      file,
      bx,
      bz,
      bw,
      bd,
      heightVal,
      palette,
      timeSec,
      width,
      height,
      camera,
      stroke,
    );
    ctx.restore();

    // Compute tight screen bounding box for fast hit-testing
    const topCenter = worldToScreen(
      bx + bw * 0.5,
      bz + bd * 0.5,
      heightVal * camera.zoom,
      width,
      height,
      camera,
    );
    const p00 = worldToScreen(bx, bz, heightVal * camera.zoom, width, height, camera);
    const p10 = worldToScreen(bx + bw, bz, heightVal * camera.zoom, width, height, camera);
    const p11 = worldToScreen(bx + bw, bz + bd, 0, width, height, camera);
    const p01 = worldToScreen(bx, bz + bd, 0, width, height, camera);
    const xs = [p00.x, p10.x, p11.x, p01.x];
    const ys = [p00.y, p10.y, p11.y, p01.y];
    hits.push({
      file,
      screenX: topCenter.x,
      screenY: topCenter.y,
      minX: Math.min(...xs) - 3,
      maxX: Math.max(...xs) + 3,
      minY: Math.min(...ys) - 3,
      maxY: Math.max(...ys) + 3,
    });
  }

  // 8. Dashed Purple Seismic Fault Lines (hidden temporal co-change pairs!)
  const faultSource = blastRadius?.fault_lines?.length
    ? blastRadius.fault_lines
    : selectedFile
      ? cochanges.filter((c) => c.file_a === selectedFile || c.file_b === selectedFile)
      : cochanges.slice(0, 8);

  if (faultSource.length > 0) {
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -timeSec * 16;
    for (const pair of faultSource) {
      const fa = fileByPath.get(pair.file_a);
      const fb = fileByPath.get(pair.file_b);
      if (!fa || !fb) continue;
      const ha = computeBuildingHeight(fa) * camera.zoom;
      const hb = computeBuildingHeight(fb) * camera.zoom;
      const aPt = worldToScreen(
        fa.layout_x + fa.layout_w * 0.5,
        fa.layout_z + fa.layout_d * 0.5,
        ha,
        width,
        height,
        camera,
      );
      const bPt = worldToScreen(
        fb.layout_x + fb.layout_w * 0.5,
        fb.layout_z + fb.layout_d * 0.5,
        hb,
        width,
        height,
        camera,
      );
      ctx.beginPath();
      ctx.moveTo(aPt.x, aPt.y);
      ctx.quadraticCurveTo(
        (aPt.x + bPt.x) * 0.5,
        Math.min(aPt.y, bPt.y) - 24 * camera.zoom,
        bPt.x,
        bPt.y,
      );
      ctx.strokeStyle = selectedFile ? "#e879f9" : "rgba(192, 132, 252, 0.55)";
      ctx.lineWidth = selectedFile ? 2.4 : 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  // 9. District Name Plaques (floating cleanly above largest districts at comfortable zoom)
  if (camera.zoom >= 0.6) {
    ctx.save();
    ctx.textAlign = "center";
    for (const dist of districts) {
      if (dist.bounds_w * dist.bounds_d < 45 && camera.zoom < 1.1) continue;
      const center = worldToScreen(
        dist.bounds_x + dist.bounds_w * 0.5,
        dist.bounds_z + dist.bounds_d * 0.5,
        2,
        width,
        height,
        camera,
      );
      const label =
        dist.display_name.length > 22
          ? `…/${dist.display_name.split("/").slice(-1)[0]}`
          : dist.display_name;
      ctx.font = `600 ${Math.max(9, Math.round(10 * Math.min(1.3, camera.zoom)))}px Inter, sans-serif`;
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = "rgba(7, 11, 20, 0.72)";
      ctx.fillRect(center.x - tw * 0.5, center.y - 8, tw, 15);
      ctx.fillStyle = ZONE_GROUND[dist.zone_type]?.border ?? "#e2e8f0";
      ctx.fillText(label, center.x, center.y + 3);
    }
    ctx.restore();
  }

  return hits;
}
