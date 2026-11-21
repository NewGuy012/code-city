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
import {
  DEFAULT_PITCH,
  DEFAULT_YAW,
  type TimeOfDay,
  WORLD_CENTER_X,
  WORLD_CENTER_Z,
} from "./cameraStore";
import {
  ATLAS_ANCHOR_X,
  ATLAS_ANCHOR_Y,
  ATLAS_CELL_H,
  ATLAS_CELL_W,
  spriteAtlas,
} from "./spriteAtlas2D";

export interface Camera2D {
  panX: number;
  panY: number;
  zoom: number;
  yaw?: number;
  pitch?: number;
}

export interface GhostLot {
  file_path: string;
  layout_x: number;
  layout_z: number;
  layout_w: number;
  layout_d: number;
}

export interface SimVehicleRender {
  id: string;
  type: "request_car" | "cycle_car" | "sweeper" | "fire_truck" | "crew" | "cargo_ship";
  x: number;
  z: number;
  heading: number;
  jammed?: boolean;
}

export interface FloatingStatPopup {
  id: string;
  x: number;
  z: number;
  text: string;
  color: string;
  progress: number; // 0..1
}

export interface RenderCitySceneArgs {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  camera: Camera2D;
  timeSec: number;
  timeOfDay?: TimeOfDay;
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
  vehicles?: SimVehicleRender[];
  fireFiles?: Set<string>;
  blackoutFiles?: Set<string>;
  plazas?: Array<{ x: number; z: number; w: number; d: number; kind: string }>;
  streetLines?: { xLines: number[]; zLines: number[] };
  floatingPopups?: FloatingStatPopup[];
  /** Optional hook allowing sprite atlas drawing in Phase B+ */
  drawSpriteOverride?: boolean;
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

const ISO_X = 7.4;
const ISO_Y = 3.7;

export function getTiltFactors(pitchDeg = DEFAULT_PITCH): {
  isoYScale: number;
  heightScale: number;
} {
  const clamped = Math.max(12, Math.min(85, pitchDeg));
  const baseRad = (DEFAULT_PITCH * Math.PI) / 180;
  const rad = (clamped * Math.PI) / 180;
  return {
    isoYScale: Math.max(0.42, Math.min(1.85, Math.sin(rad) / Math.sin(baseRad))),
    heightScale: Math.max(0.12, Math.min(1.22, Math.cos(rad) / Math.cos(baseRad))),
  };
}

export function cameraFromTarget(
  targetX: number,
  targetZ: number,
  zoom: number,
  yaw = DEFAULT_YAW,
  pitch = DEFAULT_PITCH,
): Camera2D {
  const iso = worldToIso(targetX, targetZ, 0, yaw, pitch);
  return {
    panX: -iso.x * zoom,
    panY: -iso.y * zoom,
    zoom,
    yaw,
    pitch,
  };
}

export function worldToIso(
  x: number,
  z: number,
  y = 0,
  yaw = DEFAULT_YAW,
  pitch = DEFAULT_PITCH,
): { x: number; y: number } {
  const dx = x - WORLD_CENTER_X;
  const dz = z - WORLD_CENTER_Z;
  const theta = yaw - DEFAULT_YAW;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const rx = dx * cosT - dz * sinT;
  const rz = dx * sinT + dz * cosT;
  const { isoYScale, heightScale } = getTiltFactors(pitch);
  return {
    x: (rx - rz) * ISO_X,
    y: (rx + rz) * (ISO_Y * isoYScale) - y * heightScale,
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
  const iso = worldToIso(wx, wz, wy, camera.yaw ?? DEFAULT_YAW, camera.pitch ?? DEFAULT_PITCH);
  return isoToScreen(iso.x, iso.y, width, height, camera);
}

export function screenToWorldGround(
  sx: number,
  sy: number,
  width: number,
  height: number,
  camera: Camera2D,
): { x: number; z: number } {
  const yaw = camera.yaw ?? DEFAULT_YAW;
  const pitch = camera.pitch ?? DEFAULT_PITCH;
  const { isoYScale } = getTiltFactors(pitch);
  const isoX = (sx - width * 0.5 - camera.panX) / camera.zoom;
  const isoY = (sy - height * 0.52 - camera.panY) / camera.zoom;
  const isoYEff = ISO_Y * isoYScale;
  const rx = 0.5 * (isoX / ISO_X + isoY / isoYEff);
  const rz = 0.5 * (isoY / isoYEff - isoX / ISO_X);
  const theta = yaw - DEFAULT_YAW;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const dx = rx * cosT + rz * sinT;
  const dz = -rx * sinT + rz * cosT;
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

export function buildingPalette(file: FileMetric, dataMap: DataMapMode): ShadePalette {
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
  return file.format_drift
    ? { roof: "#f0abfc", left: "#c026d3", right: "#701a75", accent: "#fdf4ff" }
    : { roof: "#7dd3fc", left: "#0284c7", right: "#0c4a6e", accent: "#e0f2fe" };
}

export function computeBuildingHeight(file: FileMetric): number {
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

function drawQuad(
  ctx: CanvasRenderingContext2D,
  pts: Array<{ x: number; y: number }>,
  fill: string,
  stroke?: string | null,
  lineWidth = 1,
): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

export function drawIsoPrism(
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
  const yaw = cam.yaw ?? DEFAULT_YAW;
  const p00 = worldToScreen(x, z, yBase + h, wScreen, hScreen, cam);
  const p10 = worldToScreen(x + w, z, yBase + h, wScreen, hScreen, cam);
  const p11 = worldToScreen(x + w, z + d, yBase + h, wScreen, hScreen, cam);
  const p01 = worldToScreen(x, z + d, yBase + h, wScreen, hScreen, cam);

  const b00 = worldToScreen(x, z, yBase, wScreen, hScreen, cam);
  const b10 = worldToScreen(x + w, z, yBase, wScreen, hScreen, cam);
  const b11 = worldToScreen(x + w, z + d, yBase, wScreen, hScreen, cam);
  const b01 = worldToScreen(x, z + d, yBase, wScreen, hScreen, cam);

  const viewX = Math.sin(yaw);
  const viewZ = Math.cos(yaw);

  // Determine the 2 front-facing walls for any camera yaw
  const candidates: Array<{ pts: Array<{ x: number; y: number }>; midX: number }> = [];
  if (viewZ >= -1e-4) {
    // +Z wall
    candidates.push({ pts: [p01, p11, b11, b01], midX: (p01.x + p11.x) * 0.5 });
  } else {
    // -Z wall
    candidates.push({ pts: [p10, p00, b00, b10], midX: (p10.x + p00.x) * 0.5 });
  }
  if (viewX >= -1e-4) {
    // +X wall
    candidates.push({ pts: [p10, p11, b11, b10], midX: (p10.x + p11.x) * 0.5 });
  } else {
    // -X wall
    candidates.push({ pts: [p00, p01, b01, b00], midX: (p00.x + p01.x) * 0.5 });
  }

  candidates.sort((a, b) => a.midX - b.midX);
  if (candidates[0]) {
    drawQuad(ctx, candidates[0].pts, palette.left, strokeColor, lineWidth);
  }
  if (candidates[1]) {
    drawQuad(ctx, candidates[1].pts, palette.right, strokeColor, lineWidth);
  }

  drawQuad(ctx, [p00, p10, p11, p01], palette.roof, strokeColor, lineWidth);
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
  drawQuad(ctx, [a, b, c, e], fill, stroke, lineWidth);
}

function drawCastShadow(
  ctx: CanvasRenderingContext2D,
  bx: number,
  bz: number,
  bw: number,
  bd: number,
  height: number,
  timeOfDay: TimeOfDay,
  wScreen: number,
  hScreen: number,
  cam: Camera2D,
): void {
  const shadowReach = timeOfDay === "golden" ? 0.34 : timeOfDay === "night" ? 0.14 : 0.22;
  const sx = bx + bw * 0.12 + height * shadowReach;
  const sz = bz + bd * 0.12 + height * shadowReach * 0.55;
  ctx.save();
  ctx.globalAlpha *= timeOfDay === "night" ? 0.22 : 0.32;
  drawGroundQuad(
    ctx,
    sx,
    sz,
    bw,
    bd,
    0.35,
    "#020617",
    null,
    wScreen,
    hScreen,
    cam,
  );
  ctx.restore();
}

function drawConditionSignals(
  ctx: CanvasRenderingContext2D,
  file: FileMetric,
  bx: number,
  bz: number,
  zoom: number,
  timeSec: number,
  roofCenter: { x: number; y: number },
  isBurning: boolean,
  isBlackout: boolean,
): void {
  if (file.condition_flags?.crane) {
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

  if (file.condition_flags?.lone_keeper || isBlackout) {
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

  if (isBurning) {
    ctx.save();
    for (let i = 0; i < 4; i++) {
      const flicker = Math.sin(timeSec * 9 + i * 1.9 + bx) * 3.2 * zoom;
      const fy = roofCenter.y - (4 + ((timeSec * 14 + i * 5) % 14)) * zoom;
      ctx.beginPath();
      ctx.arc(
        roofCenter.x + flicker,
        fy,
        Math.max(2.2, (5 - i * 0.8) * zoom),
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = i % 2 === 0 ? "rgba(249, 115, 22, 0.86)" : "rgba(250, 204, 21, 0.78)";
      ctx.fill();
    }
    ctx.restore();
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
  dataMap: DataMapMode,
  timeSec: number,
  timeOfDay: TimeOfDay,
  wScreen: number,
  hScreen: number,
  cam: Camera2D,
  stroke: string,
  isBurning: boolean,
  isBlackout: boolean,
): void {
  const arch = file.building_archetype;
  const zoom = cam.zoom;
  const pitch = cam.pitch ?? DEFAULT_PITCH;

  // Try pre-rendered 30-sprite isometric atlas when ready & in isometric pitch range
  const atlas = spriteAtlas.ensureLoaded();
  const compassStep = ((((Math.round(((cam.yaw ?? DEFAULT_YAW) - DEFAULT_YAW) / (Math.PI / 2)) % 4) + 4) % 4) as
    | 0
    | 1
    | 2
    | 3);
  const canUseSprite =
    atlas.ready &&
    atlas.buildings !== null &&
    pitch <= 58 &&
    !isBlackout &&
    Math.max(bw / Math.max(0.4, bd), bd / Math.max(0.4, bw)) <= 1.85;

  if (canUseSprite && atlas.buildings) {
    // Ground lot pad + cast shadow
    if (arch !== "park_stadium") {
      drawCastShadow(ctx, bx, bz, bw, bd, height, timeOfDay, wScreen, hScreen, cam);
    }
    drawGroundQuad(
      ctx,
      bx,
      bz,
      bw,
      bd,
      0.38,
      arch === "park_stadium" ? "#14532d" : "#1e293b",
      stroke,
      wScreen,
      hScreen,
      cam,
      stroke.startsWith("#") ? 1.6 : 0.8,
    );

    const rect = spriteAtlas.getBuildingSpriteRect(arch, height, compassStep);
    const baseScreen = worldToScreen(bx + bw * 0.5, bz + bd * 0.5, 0, wScreen, hScreen, cam);
    const { heightScale } = getTiltFactors(pitch);
    const lotSpanPx = (bw + bd) * ISO_X * zoom;
    const scaleX = Math.max(0.28, lotSpanPx / 64.8);
    const scaleY = Math.max(0.24, scaleX * (0.72 + 0.28 * heightScale));
    const dw = ATLAS_CELL_W * scaleX;
    const dh = ATLAS_CELL_H * scaleY;
    const dx = baseScreen.x - ATLAS_ANCHOR_X * scaleX;
    const dy = baseScreen.y - ATLAS_ANCHOR_Y * scaleY;

    const tintHex = dataMap === "living" ? null : palette.left;
    spriteAtlas.drawTintedSprite(
      ctx,
      atlas.buildings,
      rect.sx,
      rect.sy,
      rect.sw,
      rect.sh,
      dx,
      dy,
      dw,
      dh,
      tintHex,
    );

    if (atlas.emissive && timeOfDay !== "day") {
      ctx.save();
      ctx.globalAlpha *= timeOfDay === "night" ? 0.95 : 0.45;
      ctx.drawImage(atlas.emissive, rect.sx, rect.sy, rect.sw, rect.sh, dx, dy, dw, dh);
      ctx.restore();
    }

    // Condition overlays (crane, smog, lone-keeper, fire) on top of sprite
    const roofCenter = worldToScreen(
      bx + bw * 0.5,
      bz + bd * 0.5,
      (height * 0.78 + 6) * zoom,
      wScreen,
      hScreen,
      cam,
    );
    drawConditionSignals(ctx, file, bx, bz, zoom, timeSec, roofCenter, isBurning, false);
    return;
  }

  if (arch === "park_stadium") {
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

  // Directional cast ground shadow
  drawCastShadow(ctx, bx, bz, bw, bd, height, timeOfDay, wScreen, hScreen, cam);

  const effectivePalette = isBlackout
    ? { roof: "#1e293b", left: "#0f172a", right: "#020617", accent: "#475569" }
    : palette;

  drawIsoPrism(
    ctx,
    bx,
    bz,
    bw,
    bd,
    0,
    height * zoom,
    effectivePalette,
    wScreen,
    hScreen,
    cam,
    stroke,
    1,
  );

  // Floor window bands when zoomed in comfortably
  if (zoom >= 0.75 && height > 14 && !isBlackout) {
    const floors = Math.min(8, Math.max(2, Math.floor(height / 9)));
    ctx.save();
    const winColor =
      timeOfDay === "night"
        ? "rgba(253, 224, 71, 0.72)"
        : timeOfDay === "golden"
          ? "rgba(254, 240, 138, 0.58)"
          : "rgba(224, 242, 254, 0.32)";
    ctx.strokeStyle = winColor;
    ctx.lineWidth = Math.max(0.8, 1.1 * zoom);
    const yaw = cam.yaw ?? DEFAULT_YAW;
    const vx = Math.sin(yaw) >= 0 ? bx + bw : bx;
    const vz = Math.cos(yaw) >= 0 ? bz + bd : bz;
    for (let fl = 1; fl < floors; fl++) {
      const fy = (height * (fl / floors)) * zoom;
      const pA = worldToScreen(bx + bw * 0.14, vz, fy, wScreen, hScreen, cam);
      const pB = worldToScreen(bx + bw * 0.86, vz, fy, wScreen, hScreen, cam);
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.stroke();

      const pC = worldToScreen(vx, bz + bd * 0.14, fy, wScreen, hScreen, cam);
      const pD = worldToScreen(vx, bz + bd * 0.86, fy, wScreen, hScreen, cam);
      ctx.beginPath();
      ctx.moveTo(pC.x, pC.y);
      ctx.lineTo(pD.x, pD.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (arch === "city_hall") {
    drawIsoPrism(
      ctx,
      bx + bw * 0.22,
      bz + bd * 0.22,
      bw * 0.56,
      bd * 0.56,
      height * zoom,
      height * 0.34 * zoom,
      effectivePalette,
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
    for (const ox of [0.3, 0.7]) {
      drawIsoPrism(
        ctx,
        bx + bw * (ox - 0.14),
        bz + bd * 0.28,
        bw * 0.28,
        bd * 0.44,
        height * zoom,
        height * 0.25 * zoom,
        { ...effectivePalette, roof: effectivePalette.accent },
        wScreen,
        hScreen,
        cam,
        stroke,
        0.7,
      );
    }
  } else if (arch === "factory") {
    drawIsoPrism(
      ctx,
      bx + bw * 0.15,
      bz + bd * 0.15,
      bw * 0.32,
      bd * 0.7,
      height * zoom,
      7 * zoom,
      effectivePalette,
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
    drawIsoPrism(
      ctx,
      bx + bw * 0.18,
      bz + bd * 0.18,
      bw * 0.64,
      bd * 0.64,
      height * zoom,
      9 * zoom,
      { ...effectivePalette, roof: "#fef08a" },
      wScreen,
      hScreen,
      cam,
      stroke,
      0.8,
    );
  } else if (arch === "archive_vault") {
    drawIsoPrism(
      ctx,
      bx + bw * 0.1,
      bz + bd * 0.1,
      bw * 0.8,
      bd * 0.8,
      height * zoom,
      5 * zoom,
      { ...effectivePalette, roof: "#e2e8f0" },
      wScreen,
      hScreen,
      cam,
      stroke,
      0.8,
    );
  } else if (arch === "watchtower") {
    drawIsoPrism(
      ctx,
      bx + bw * 0.28,
      bz + bd * 0.28,
      bw * 0.44,
      bd * 0.44,
      height * zoom,
      10 * zoom,
      effectivePalette,
      wScreen,
      hScreen,
      cam,
      stroke,
      0.8,
    );
  } else if (arch === "office_tower" && height > 30) {
    drawIsoPrism(
      ctx,
      bx + bw * 0.18,
      bz + bd * 0.18,
      bw * 0.64,
      bd * 0.64,
      height * zoom,
      height * 0.24 * zoom,
      effectivePalette,
      wScreen,
      hScreen,
      cam,
      stroke,
      0.7,
    );
  } else if (arch === "glass_pavilion") {
    drawIsoPrism(
      ctx,
      bx + bw * 0.16,
      bz + bd * 0.16,
      bw * 0.68,
      bd * 0.68,
      height * zoom,
      5 * zoom,
      { ...effectivePalette, roof: "#f472b6" },
      wScreen,
      hScreen,
      cam,
      stroke,
      0.7,
    );
  }

  const roofCenter = worldToScreen(
    bx + bw * 0.5,
    bz + bd * 0.5,
    (height + 4) * zoom,
    wScreen,
    hScreen,
    cam,
  );
  drawConditionSignals(ctx, file, bx, bz, zoom, timeSec, roofCenter, isBurning, isBlackout);
}

export function renderCityScene(args: RenderCitySceneArgs): HitBuilding[] {
  const {
    ctx,
    width,
    height,
    camera,
    timeSec,
    timeOfDay = "day",
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
    vehicles = [],
    fireFiles,
    blackoutFiles,
    plazas = [],
    streetLines,
    floatingPopups = [],
  } = args;

  ctx.clearRect(0, 0, width, height);

  // 1. Deep harbor water backdrop + time-of-day gradient & animated ripples
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  if (timeOfDay === "golden") {
    grad.addColorStop(0, "#1c1938");
    grad.addColorStop(0.55, "#282348");
    grad.addColorStop(1, "#0f2942");
  } else if (timeOfDay === "night") {
    grad.addColorStop(0, "#020611");
    grad.addColorStop(1, "#061326");
  } else {
    grad.addColorStop(0, "#050d1a");
    grad.addColorStop(1, "#0b1f38");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.strokeStyle =
    timeOfDay === "golden" ? "rgba(251, 191, 36, 0.10)" : "rgba(56, 189, 248, 0.08)";
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

  // 2. Stepped Stone Seawall + Asphalt Foundation Island Slab
  drawIsoPrism(
    ctx,
    -2.5,
    -2.5,
    145,
    109,
    -5.5 * camera.zoom,
    5.5 * camera.zoom,
    { roof: "#1e293b", left: "#334155", right: "#1e293b", accent: "#475569" },
    width,
    height,
    camera,
    "rgba(56, 189, 248, 0.35)",
    1.4,
  );

  // Inner paved city asphalt deck
  drawGroundQuad(
    ctx,
    0,
    0,
    140,
    104,
    0.05,
    "#0f172a",
    "rgba(148, 163, 184, 0.25)",
    width,
    height,
    camera,
    1,
  );

  // Explicit avenue/street centerlines, crosswalks & corner traffic signals
  if (streetLines && (streetLines.xLines.length > 0 || streetLines.zLines.length > 0)) {
    ctx.save();
    ctx.strokeStyle = "rgba(250, 204, 21, 0.28)";
    ctx.lineWidth = Math.max(0.8, 1.1 * camera.zoom);
    ctx.setLineDash([4 * camera.zoom, 4 * camera.zoom]);
    for (const xl of streetLines.xLines) {
      const a = worldToScreen(xl, 1.2, 0.15, width, height, camera);
      const b = worldToScreen(xl, 102.8, 0.15, width, height, camera);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (const zl of streetLines.zLines) {
      const a = worldToScreen(1.2, zl, 0.15, width, height, camera);
      const b = worldToScreen(138.8, zl, 0.15, width, height, camera);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Zebra crosswalk ticks & traffic signal beacons at intersections when zoomed in
    if (camera.zoom >= 0.72) {
      const phase = Math.floor(timeSec * 0.5) % 2 === 0;
      for (let xi = 0; xi < streetLines.xLines.length; xi++) {
        for (let zi = 0; zi < streetLines.zLines.length; zi++) {
          const ix = streetLines.xLines[xi];
          const iz = streetLines.zLines[zi];
          // Zebra stripes
          ctx.strokeStyle = "rgba(226, 232, 240, 0.36)";
          ctx.lineWidth = Math.max(0.8, 1.2 * camera.zoom);
          for (const d of [-0.6, 0, 0.6]) {
            const c0 = worldToScreen(ix + d, iz - 1.25, 0.18, width, height, camera);
            const c1 = worldToScreen(ix + d, iz - 0.85, 0.18, width, height, camera);
            ctx.beginPath();
            ctx.moveTo(c0.x, c0.y);
            ctx.lineTo(c1.x, c1.y);
            ctx.stroke();
          }
          // Traffic signal corner dot
          const sig = worldToScreen(ix + 1.2, iz + 1.2, 2.2 * camera.zoom, width, height, camera);
          ctx.beginPath();
          ctx.arc(sig.x, sig.y, Math.max(1.2, 1.8 * camera.zoom), 0, Math.PI * 2);
          ctx.fillStyle = (phase ? (xi + zi) % 2 === 0 : (xi + zi) % 2 === 1) ? "#4ade80" : "#ef4444";
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // 3. Waterfront Supply Docks (timber piers + bobbing cargo barges)
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
      // Bobbing cargo barge moored beside the timber pier
      const bobY = Math.sin(timeSec * 1.6 + idx * 1.1) * 0.7 * camera.zoom;
      drawIsoPrism(
        ctx,
        dockX + 2.2,
        dockZ + 6.4,
        6.5,
        2.6,
        (-1.2 + bobY) * camera.zoom,
        2.6 * camera.zoom,
        { roof: "#38bdf8", left: "#0284c7", right: "#075985", accent: "#fde047" },
        width,
        height,
        camera,
        "rgba(226, 232, 240, 0.4)",
        0.7,
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

  // 4. Concrete Sidewalk Plates & Zoned District Neighborhoods
  for (const dist of districts) {
    const zStyle = ZONE_GROUND[dist.zone_type] ?? ZONE_GROUND.downtown_core;
    drawGroundQuad(
      ctx,
      dist.bounds_x - 0.35,
      dist.bounds_z - 0.35,
      dist.bounds_w + 0.7,
      dist.bounds_d + 0.7,
      0.2,
      "#334155",
      "rgba(148, 163, 184, 0.28)",
      width,
      height,
      camera,
      0.8,
    );
    drawGroundQuad(
      ctx,
      dist.bounds_x,
      dist.bounds_z,
      dist.bounds_w,
      dist.bounds_d,
      0.32,
      zStyle.fill,
      zStyle.border,
      width,
      height,
      camera,
      1.1,
    );
  }

  // Urban Pocket Plazas & Courtyards
  for (const pz of plazas) {
    const fill =
      pz.kind === "loading_bay" ? "#3f2e21" : pz.kind === "courtyard" ? "#1b4332" : "#273549";
    drawGroundQuad(
      ctx,
      pz.x,
      pz.z,
      pz.w,
      pz.d,
      0.38,
      fill,
      "rgba(148, 163, 184, 0.35)",
      width,
      height,
      camera,
      0.7,
    );
    if (camera.zoom >= 0.75 && pz.kind !== "loading_bay") {
      const tp = worldToScreen(
        pz.x + pz.w * 0.5,
        pz.z + pz.d * 0.5,
        3.5 * camera.zoom,
        width,
        height,
        camera,
      );
      ctx.beginPath();
      ctx.arc(tp.x, tp.y, Math.max(2, 3.2 * camera.zoom), 0, Math.PI * 2);
      ctx.fillStyle = "#22c55e";
      ctx.fill();
    }
  }

  // 5. Ghost Diff Demolished Lots
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

  const fileByPath = new Map<string, FileMetric>();
  for (const f of files) {
    fileByPath.set(f.file_path, f);
  }

  // 6. Animated Import Artery Traffic Pulses (when no sim vehicles or traffic overlay active)
  if (showTraffic && imports.length > 0 && vehicles.length === 0) {
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

  // Street-routed Simulation Vehicles
  if (showTraffic && vehicles.length > 0) {
    ctx.save();
    for (const v of vehicles) {
      const p = worldToScreen(v.x, v.z, 1.5, width, height, camera);
      const size = Math.max(2.2, (v.type === "cargo_ship" ? 4.8 : 2.8) * camera.zoom);
      ctx.beginPath();
      if (v.type === "cargo_ship") {
        ctx.rect(p.x - size * 1.4, p.y - size * 0.7, size * 2.8, size * 1.4);
      } else {
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      }
      ctx.fillStyle = v.jammed
        ? "#ef4444"
        : v.type === "fire_truck"
          ? timeSec % 0.4 < 0.2
            ? "#f43f5e"
            : "#fef08a"
          : v.type === "sweeper"
            ? "#4ade80"
            : v.type === "crew"
              ? "#fb923c"
              : v.type === "cycle_car"
                ? "#e879f9"
                : v.type === "cargo_ship"
                  ? "#fbbf24"
                  : "#7dd3fc";
      ctx.fill();
    }
    ctx.restore();
  }

  const impactedHop = new Map<string, number>();
  if (blastRadius) {
    for (const node of blastRadius.impacted_files) {
      impactedHop.set(node.file_path, node.hop_distance);
    }
  }

  // 7. Sort Buildings Back-to-Front relative to Camera Yaw
  const yaw = camera.yaw ?? DEFAULT_YAW;
  const viewSin = Math.sin(yaw);
  const viewCos = Math.cos(yaw);
  const sortedFiles = [...files].sort((a, b) => {
    const da =
      (a.layout_x + a.layout_w * 0.5 - WORLD_CENTER_X) * viewSin +
      (a.layout_z + a.layout_d * 0.5 - WORLD_CENTER_Z) * viewCos;
    const db =
      (b.layout_x + b.layout_w * 0.5 - WORLD_CENTER_X) * viewSin +
      (b.layout_z + b.layout_d * 0.5 - WORLD_CENTER_Z) * viewCos;
    return da - db;
  });

  const hits: HitBuilding[] = [];
  for (const file of sortedFiles) {
    const pad = Math.min(0.42, Math.min(file.layout_w, file.layout_d) * 0.12);
    const rawW = Math.max(0.85, file.layout_w - pad * 2);
    const rawD = Math.max(0.85, file.layout_d - pad * 2);
    const maxRatio = 3.2;
    const bw = rawW > rawD * maxRatio ? rawD * maxRatio : rawW;
    const bd = rawD > rawW * maxRatio ? rawW * maxRatio : rawD;
    const bx = file.layout_x + (file.layout_w - bw) * 0.5;
    const bz = file.layout_z + (file.layout_d - bd) * 0.5;
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
      dataMap,
      timeSec,
      timeOfDay,
      width,
      height,
      camera,
      stroke,
      fireFiles?.has(file.file_path) ?? false,
      blackoutFiles?.has(file.file_path) ?? false,
    );
    ctx.restore();

    const topCenter = worldToScreen(
      bx + bw * 0.5,
      bz + bd * 0.5,
      heightVal * camera.zoom,
      width,
      height,
      camera,
    );
    const corners = [
      worldToScreen(bx, bz, heightVal * camera.zoom, width, height, camera),
      worldToScreen(bx + bw, bz, heightVal * camera.zoom, width, height, camera),
      worldToScreen(bx + bw, bz + bd, heightVal * camera.zoom, width, height, camera),
      worldToScreen(bx, bz + bd, heightVal * camera.zoom, width, height, camera),
      worldToScreen(bx, bz, 0, width, height, camera),
      worldToScreen(bx + bw, bz, 0, width, height, camera),
      worldToScreen(bx + bw, bz + bd, 0, width, height, camera),
      worldToScreen(bx, bz + bd, 0, width, height, camera),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
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

  // 8. Dashed Purple Seismic Fault Lines
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

  // 9. District Name Plaques
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

  // 10. Floating Stat Popups (+Health / -Smog / +Velocity)
  if (floatingPopups.length > 0) {
    ctx.save();
    ctx.font = "700 12px Inter, sans-serif";
    ctx.textAlign = "center";
    for (const pop of floatingPopups) {
      const p = worldToScreen(pop.x, pop.z, 26 * camera.zoom, width, height, camera);
      ctx.globalAlpha = Math.max(0, 1 - pop.progress);
      ctx.fillStyle = "rgba(2, 6, 23, 0.75)";
      const tw = ctx.measureText(pop.text).width + 10;
      ctx.fillRect(p.x - tw * 0.5, p.y - 24 * pop.progress - 11, tw, 16);
      ctx.fillStyle = pop.color;
      ctx.fillText(pop.text, p.x, p.y - 24 * pop.progress);
    }
    ctx.restore();
  }

  return hits;
}
