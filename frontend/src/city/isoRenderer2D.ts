import type {
  BlastRadiusResult,
  BuildingArchetype,
  CochangePair,
  DataMapMode,
  District,
  ExternalDep,
  FileImport,
  FileMetric,
} from "../types/city";
import {
  DEFAULT_PITCH,
  DEFAULT_YAW,
  type TimeOfDay,
  WORLD_CENTER_X,
  WORLD_CENTER_Z,
  compassStepFromYaw,
} from "./cameraStore";
import {
  type ShadePalette,
  ZONE_PALETTES,
  buildImpactedHopMap,
  buildingPalette,
  computeBuildingHeight,
  hashFilePath,
  isAnalyticalDataMap,
  selectFaultLines,
  vehicleColor,
} from "./cityTheme";
import {
  ATLAS_ANCHOR_X,
  ATLAS_ANCHOR_Y,
  ATLAS_CELL_H,
  ATLAS_CELL_W,
  ATLAS_FOOTPRINT_PX,
  NATURE_ANCHOR_X,
  NATURE_ANCHOR_Y,
  NATURE_CELL_H,
  NATURE_CELL_W,
  spriteAtlas,
} from "./spriteAtlas2D";
import {
  type RockPlacement,
  type SailboatPlacement,
  type TreePlacement,
  computeNatureAndStreetPlacements,
  islandSignedDist,
} from "./islandLayout";

export interface Camera2D {
  panX: number;
  panY: number;
  zoom: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
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
  progress: number;
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
}

export interface HitBuilding {
  file: FileMetric;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface IsoProjector {
  zoom: number;
  yaw: number;
  pitch: number;
  viewX: number;
  viewZ: number;
  heightScale: number;
  compassStep: 0 | 1 | 2 | 3;
  project(wx: number, wz: number, wy: number): { x: number; y: number };
}

const ISO_X = 7.4;
const ISO_Y = 3.7;
const BASE_PITCH_RAD = (DEFAULT_PITCH * Math.PI) / 180;

/** Precompute organic coastal shoreline polygon matching terrain3D's islandSignedDist. */
const COAST_POLYGON: Array<{ x: number; z: number }> = (() => {
  const pts: Array<{ x: number; z: number }> = [];
  const steps = 72;
  const cx = WORLD_CENTER_X;
  const cz = WORLD_CENTER_Z - 6;
  for (let i = 0; i < steps; i++) {
    const ang = (i / steps) * Math.PI * 2;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    let lo = 45;
    let hi = 125;
    for (let it = 0; it < 10; it++) {
      const mid = (lo + hi) * 0.5;
      const sd = islandSignedDist(dx * mid, -6 + dz * mid);
      if (sd < 0) lo = mid;
      else hi = mid;
    }
    const r = (lo + hi) * 0.5;
    pts.push({ x: cx + dx * r, z: cz + dz * r });
  }
  return pts;
})();

let cachedNatureInput: {
  districts: District[];
  files: FileMetric[];
  plazas: Array<{ x: number; z: number; w: number; d: number; kind: string }>;
  streetLines?: { xLines: number[]; zLines: number[] };
  result: {
    trees: TreePlacement[];
    rocks: RockPlacement[];
    sailboats: SailboatPlacement[];
    streetlights: Array<{ x: number; z: number }>;
  };
} | null = null;

function getCachedNaturePlacements(
  districts: District[],
  files: FileMetric[],
  plazas: Array<{ x: number; z: number; w: number; d: number; kind: string }>,
  streetLines?: { xLines: number[]; zLines: number[] },
) {
  if (
    cachedNatureInput &&
    cachedNatureInput.districts === districts &&
    cachedNatureInput.files === files &&
    cachedNatureInput.plazas === plazas &&
    cachedNatureInput.streetLines === streetLines
  ) {
    return cachedNatureInput.result;
  }
  const result = computeNatureAndStreetPlacements(districts, files, plazas, streetLines);
  cachedNatureInput = { districts, files, plazas, streetLines, result };
  return result;
}

function getTiltFactors(pitchDeg = DEFAULT_PITCH): { isoYScale: number; heightScale: number } {
  const rad = (Math.max(12, Math.min(85, pitchDeg)) * Math.PI) / 180;
  return {
    isoYScale: Math.max(0.42, Math.min(1.85, Math.sin(rad) / Math.sin(BASE_PITCH_RAD))),
    heightScale: Math.max(0.12, Math.min(1.22, Math.cos(rad) / Math.cos(BASE_PITCH_RAD))),
  };
}

function makeProjector(width: number, height: number, camera: Camera2D): IsoProjector {
  const yaw = camera.yaw ?? DEFAULT_YAW;
  const pitch = camera.pitch ?? DEFAULT_PITCH;
  const theta = yaw - DEFAULT_YAW;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const { isoYScale, heightScale } = getTiltFactors(pitch);
  const isoYEff = ISO_Y * isoYScale;
  const ox = width * 0.5 + camera.panX;
  const oy = height * 0.52 + camera.panY;
  const zoom = camera.zoom;

  return {
    zoom,
    yaw,
    pitch,
    viewX: Math.sin(yaw),
    viewZ: Math.cos(yaw),
    heightScale,
    compassStep: compassStepFromYaw(yaw),
    project(wx: number, wz: number, wy: number) {
      const dx = wx - WORLD_CENTER_X;
      const dz = wz - WORLD_CENTER_Z;
      const rx = dx * cosT - dz * sinT;
      const rz = dx * sinT + dz * cosT;
      return {
        x: ox + (rx - rz) * ISO_X * zoom,
        y: oy + ((rx + rz) * isoYEff - wy * heightScale) * zoom,
      };
    },
  };
}

function rotatePoint2D(
  x: number,
  y: number,
  cx: number,
  cy: number,
  rad: number,
): { x: number; y: number } {
  if (rad === 0) return { x, y };
  const dx = x - cx;
  const dy = y - cy;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  return {
    x: cx + dx * cosR - dy * sinR,
    y: cy + dx * sinR + dy * cosR,
  };
}

export function cameraFromTarget(
  targetX: number,
  targetZ: number,
  zoom: number,
  yaw = DEFAULT_YAW,
  pitch = DEFAULT_PITCH,
  roll = 0,
): Camera2D {
  const iso = worldToIso(targetX, targetZ, 0, yaw, pitch);
  return { panX: -iso.x * zoom, panY: -iso.y * zoom, zoom, yaw, pitch, roll };
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

export function worldToScreen(
  wx: number,
  wz: number,
  wy: number,
  width: number,
  height: number,
  camera: Camera2D,
): { x: number; y: number } {
  const iso = worldToIso(wx, wz, wy, camera.yaw ?? DEFAULT_YAW, camera.pitch ?? DEFAULT_PITCH);
  const sx = width * 0.5 + camera.panX + iso.x * camera.zoom;
  const sy = height * 0.52 + camera.panY + iso.y * camera.zoom;
  const rollRad = ((camera.roll ?? 0) * Math.PI) / 180;
  return rotatePoint2D(sx, sy, width * 0.5, height * 0.52, rollRad);
}

export function screenToWorldGround(
  sx: number,
  sy: number,
  width: number,
  height: number,
  camera: Camera2D,
): { x: number; z: number } {
  const rollRad = ((camera.roll ?? 0) * Math.PI) / 180;
  const unrolled = rotatePoint2D(sx, sy, width * 0.5, height * 0.52, -rollRad);
  const yaw = camera.yaw ?? DEFAULT_YAW;
  const { isoYScale } = getTiltFactors(camera.pitch ?? DEFAULT_PITCH);
  const isoX = (unrolled.x - width * 0.5 - camera.panX) / camera.zoom;
  const isoY = (unrolled.y - height * 0.52 - camera.panY) / camera.zoom;
  const isoYEff = ISO_Y * isoYScale;
  const rx = 0.5 * (isoX / ISO_X + isoY / isoYEff);
  const rz = 0.5 * (isoY / isoYEff - isoX / ISO_X);
  const theta = yaw - DEFAULT_YAW;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  return {
    x: rx * cosT + rz * sinT + WORLD_CENTER_X,
    z: -rx * sinT + rz * cosT + WORLD_CENTER_Z,
  };
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
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function drawCoastPolygon(
  ctx: CanvasRenderingContext2D,
  proj: IsoProjector,
  scaleFromCenter: number,
  wy: number,
  fill: string,
  stroke?: string | null,
  lineWidth = 1,
  clampHarborQuay = false,
): void {
  ctx.beginPath();
  const cz = WORLD_CENTER_Z - 4;
  for (let i = 0; i < COAST_POLYGON.length; i++) {
    const pt = COAST_POLYGON[i];
    const wx = WORLD_CENTER_X + (pt.x - WORLD_CENTER_X) * scaleFromCenter;
    let wz = cz + (pt.z - cz) * scaleFromCenter;
    if (clampHarborQuay && pt.z > 102 && Math.abs(pt.x - WORLD_CENTER_X) < 62) {
      wz = Math.min(wz, 105.2);
    }
    const p = proj.project(wx, wz, wy);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
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

function drawIsoPrism(
  ctx: CanvasRenderingContext2D,
  proj: IsoProjector,
  x: number,
  z: number,
  w: number,
  d: number,
  yBase: number,
  h: number,
  palette: ShadePalette,
  stroke?: string,
  lineWidth = 1,
): void {
  const p00 = proj.project(x, z, yBase + h);
  const p10 = proj.project(x + w, z, yBase + h);
  const p11 = proj.project(x + w, z + d, yBase + h);
  const p01 = proj.project(x, z + d, yBase + h);
  const b00 = proj.project(x, z, yBase);
  const b10 = proj.project(x + w, z, yBase);
  const b11 = proj.project(x + w, z + d, yBase);
  const b01 = proj.project(x, z + d, yBase);

  const walls = [
    proj.viewZ >= -1e-4
      ? { pts: [p01, p11, b11, b01], midX: (p01.x + p11.x) * 0.5 }
      : { pts: [p10, p00, b00, b10], midX: (p10.x + p00.x) * 0.5 },
    proj.viewX >= -1e-4
      ? { pts: [p10, p11, b11, b10], midX: (p10.x + p11.x) * 0.5 }
      : { pts: [p00, p01, b01, b00], midX: (p00.x + p01.x) * 0.5 },
  ];
  walls.sort((a, b) => a.midX - b.midX);
  drawQuad(ctx, walls[0].pts, palette.left, stroke, lineWidth);
  drawQuad(ctx, walls[1].pts, palette.right, stroke, lineWidth);
  drawQuad(ctx, [p00, p10, p11, p01], palette.roof, stroke, lineWidth);
}

function drawGroundQuad(
  ctx: CanvasRenderingContext2D,
  proj: IsoProjector,
  x: number,
  z: number,
  w: number,
  d: number,
  y: number,
  fill: string,
  stroke: string | null,
  lineWidth = 1,
): void {
  drawQuad(
    ctx,
    [
      proj.project(x, z, y),
      proj.project(x + w, z, y),
      proj.project(x + w, z + d, y),
      proj.project(x, z + d, y),
    ],
    fill,
    stroke,
    lineWidth,
  );
}

function drawCastShadow(
  ctx: CanvasRenderingContext2D,
  proj: IsoProjector,
  bx: number,
  bz: number,
  bw: number,
  bd: number,
  height: number,
  timeOfDay: TimeOfDay,
): void {
  const reach = timeOfDay === "golden" ? 0.34 : timeOfDay === "night" ? 0.14 : 0.22;
  ctx.save();
  ctx.globalAlpha *= timeOfDay === "night" ? 0.2 : 0.26;
  drawGroundQuad(
    ctx,
    proj,
    bx + bw * 0.12 + height * reach,
    bz + bd * 0.12 + height * reach * 0.55,
    bw,
    bd,
    0.35,
    "#0f172a",
    null,
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
  roof: { x: number; y: number },
  isBurning: boolean,
  isBlackout: boolean,
): void {
  if (file.condition_flags?.crane) {
    const mastTop = { x: roof.x, y: roof.y - 16 * zoom };
    const angle = Math.sin(timeSec * 1.1 + bx) * 0.55;
    const jibLen = 17 * zoom;
    ctx.save();
    ctx.strokeStyle = "#facc15";
    ctx.lineWidth = Math.max(1.5, 2 * zoom);
    ctx.beginPath();
    ctx.moveTo(roof.x, roof.y);
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
    ctx.fillStyle = "rgba(168, 85, 247, 0.34)";
    for (let i = 0; i < 3; i++) {
      const phase = timeSec * 0.9 + i * 2.1 + bz;
      ctx.beginPath();
      ctx.arc(
        roof.x + Math.sin(phase) * 7 * zoom,
        roof.y - (8 + ((phase * 6) % 16)) * zoom,
        Math.max(2.5, (4.8 - i * 0.8) * zoom),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();
  }

  if (file.condition_flags?.lone_keeper || isBlackout) {
    const pulse = 0.5 + 0.5 * Math.sin(timeSec * 3.4);
    ctx.save();
    ctx.beginPath();
    ctx.arc(roof.x, roof.y - 4 * zoom, (5 + pulse * 6) * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(251, 113, 133, ${0.85 - pulse * 0.55})`;
    ctx.lineWidth = Math.max(1.2, 1.8 * zoom);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(roof.x, roof.y - 4 * zoom, Math.max(2, 2.5 * zoom), 0, Math.PI * 2);
    ctx.fillStyle = "#fb7185";
    ctx.fill();
    ctx.restore();
  }

  if (isBurning) {
    ctx.save();
    for (let i = 0; i < 4; i++) {
      const flicker = Math.sin(timeSec * 9 + i * 1.9 + bx) * 3.2 * zoom;
      const fy = roof.y - (4 + ((timeSec * 14 + i * 5) % 14)) * zoom;
      ctx.beginPath();
      ctx.arc(roof.x + flicker, fy, Math.max(2.2, (5 - i * 0.8) * zoom), 0, Math.PI * 2);
      ctx.fillStyle = i % 2 === 0 ? "rgba(249, 115, 22, 0.86)" : "rgba(250, 204, 21, 0.78)";
      ctx.fill();
    }
    ctx.restore();
  }
}

interface CrownSpec {
  ox: number;
  oz: number;
  wFrac: number;
  dFrac: number;
  hFrac?: number;
  hFixed?: number;
  roofColor?: string | "accent";
  minH?: number;
  lineWidth?: number;
}

const ROOFTOP_CROWNS: Partial<Record<BuildingArchetype, CrownSpec[]>> = {
  city_hall: [{ ox: 0.22, oz: 0.22, wFrac: 0.56, dFrac: 0.56, hFrac: 0.34 }],
  twin_silos: [
    {
      ox: 0.16,
      oz: 0.28,
      wFrac: 0.28,
      dFrac: 0.44,
      hFrac: 0.25,
      roofColor: "accent",
      lineWidth: 0.7,
    },
    {
      ox: 0.56,
      oz: 0.28,
      wFrac: 0.28,
      dFrac: 0.44,
      hFrac: 0.25,
      roofColor: "accent",
      lineWidth: 0.7,
    },
  ],
  factory: [{ ox: 0.15, oz: 0.15, wFrac: 0.32, dFrac: 0.7, hFixed: 7, lineWidth: 0.7 }],
  grand_terminal: [
    { ox: 0.18, oz: 0.18, wFrac: 0.64, dFrac: 0.64, hFixed: 9, roofColor: "#fef08a" },
  ],
  archive_vault: [{ ox: 0.1, oz: 0.1, wFrac: 0.8, dFrac: 0.8, hFixed: 5, roofColor: "#e2e8f0" }],
  watchtower: [{ ox: 0.28, oz: 0.28, wFrac: 0.44, dFrac: 0.44, hFixed: 10 }],
  office_tower: [
    { ox: 0.18, oz: 0.18, wFrac: 0.64, dFrac: 0.64, hFrac: 0.24, minH: 30, lineWidth: 0.7 },
  ],
  glass_pavilion: [
    {
      ox: 0.16,
      oz: 0.16,
      wFrac: 0.68,
      dFrac: 0.68,
      hFixed: 5,
      roofColor: "#5da05a",
      lineWidth: 0.7,
    },
  ],
};

function drawBuildingDetails(
  ctx: CanvasRenderingContext2D,
  proj: IsoProjector,
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
  stroke: string,
  hasHighlightStroke: boolean,
  isHopHighlight: boolean,
  isAdded: boolean,
  isBurning: boolean,
  isBlackout: boolean,
): void {
  const arch = file.building_archetype;
  const zoom = proj.zoom;

  const snappedYaw = DEFAULT_YAW + proj.compassStep * (Math.PI / 2);
  let yawDeltaFromCardinal = Math.abs(proj.yaw - snappedYaw) % (Math.PI * 2);
  if (yawDeltaFromCardinal > Math.PI) yawDeltaFromCardinal = Math.PI * 2 - yawDeltaFromCardinal;
  const isCardinalYaw = yawDeltaFromCardinal < 0.06;

  const atlas = spriteAtlas.ensureLoaded();
  const canUseSprite =
    atlas.ready &&
    atlas.buildings !== null &&
    isCardinalYaw &&
    proj.pitch <= 58 &&
    !isBlackout &&
    Math.max(bw / Math.max(0.4, bd), bd / Math.max(0.4, bw)) <= 3.3;

  if (canUseSprite && atlas.buildings) {
    if (arch !== "park_stadium") {
      drawCastShadow(ctx, proj, bx, bz, bw, bd, height, timeOfDay);
    }
    const padFill =
      arch === "park_stadium"
        ? "rgba(77, 142, 65, 0.75)"
        : hasHighlightStroke
          ? "rgba(254, 240, 138, 0.28)"
          : isAdded
            ? "rgba(16, 185, 129, 0.14)"
            : "rgba(182, 190, 200, 0.55)";
    const padStroke = hasHighlightStroke
      ? stroke
      : isAdded
        ? "rgba(16, 185, 129, 0.88)"
        : "rgba(100, 116, 139, 0.35)";
    const padWidth = hasHighlightStroke ? 2.0 : isAdded ? 1.5 : 0.7;
    drawGroundQuad(
      ctx,
      proj,
      bx - 0.08,
      bz - 0.08,
      bw + 0.16,
      bd + 0.16,
      0.38,
      padFill,
      padStroke,
      padWidth,
    );

    const spec = spriteAtlas.getSpriteSpecForFile(file, bw, bd, height, proj.compassStep);
    const baseScreen = proj.project(bx + bw * 0.5, bz + bd * 0.5, 0.36);
    const tierMid = height < 26 ? 19 : height < 50 ? 38 : 66;
    const heightNudge = Math.max(0.84, Math.min(1.18, 1 + (height - tierMid) * 0.0045));
    const scaleX = Math.max(0.24, ((bw + bd) * ISO_X * zoom) / ATLAS_FOOTPRINT_PX);
    const scaleY = Math.max(0.22, scaleX * heightNudge * (0.72 + 0.28 * proj.heightScale));
    const dw = ATLAS_CELL_W * scaleX;
    const dh = ATLAS_CELL_H * scaleY;
    const dx = baseScreen.x - ATLAS_ANCHOR_X * scaleX;
    const dy = baseScreen.y - ATLAS_ANCHOR_Y * scaleY;

    const analytical = isAnalyticalDataMap(dataMap);
    let tintHex: string | null = null;
    let tintAlpha = 0.56;
    if (analytical || isHopHighlight) {
      tintHex = palette.left;
      tintAlpha = 0.56;
    } else if (timeOfDay === "night") {
      tintHex = "#0b1930";
      tintAlpha = 0.52;
    } else if (timeOfDay === "golden") {
      tintHex = "#f59e0b";
      tintAlpha = 0.14;
    }

    spriteAtlas.drawTintedSprite(
      ctx,
      atlas.buildings,
      spec.sx,
      spec.sy,
      spec.sw,
      spec.sh,
      dx,
      dy,
      dw,
      dh,
      tintHex,
      tintAlpha,
    );

    if (atlas.emissive && timeOfDay !== "day") {
      ctx.save();
      ctx.globalAlpha *= timeOfDay === "night" ? 0.94 : 0.46;
      ctx.drawImage(atlas.emissive, spec.sx, spec.sy, spec.sw, spec.sh, dx, dy, dw, dh);
      ctx.restore();
    }

    const roof = proj.project(bx + bw * 0.5, bz + bd * 0.5, (height * 0.72 + 6) * zoom);
    drawConditionSignals(ctx, file, bx, bz, zoom, timeSec, roof, isBurning, false);
    return;
  }

  if (arch === "park_stadium") {
    drawGroundQuad(ctx, proj, bx, bz, bw, bd, 1, "#4d8e41", "#86efac", 1.1);
    const center = proj.project(bx + bw * 0.5, bz + bd * 0.5, 2.5);
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.scale(1, 0.5);
    ctx.beginPath();
    ctx.arc(0, 0, Math.min(bw, bd) * 2.2 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = "#d97757";
    ctx.lineWidth = Math.max(1.5, 2.2 * zoom);
    ctx.stroke();
    ctx.restore();
    return;
  }

  drawCastShadow(ctx, proj, bx, bz, bw, bd, height, timeOfDay);
  const effPal = isBlackout
    ? { roof: "#1e293b", left: "#0f172a", right: "#020617", accent: "#475569" }
    : palette;

  drawIsoPrism(ctx, proj, bx, bz, bw, bd, 0, height * zoom, effPal, stroke, 1);

  if (zoom >= 0.75 && height > 14 && !isBlackout) {
    const floors = Math.min(8, Math.max(2, Math.floor(height / 9)));
    ctx.save();
    ctx.strokeStyle =
      timeOfDay === "night"
        ? "rgba(253, 224, 71, 0.72)"
        : timeOfDay === "golden"
          ? "rgba(254, 240, 138, 0.58)"
          : "rgba(224, 242, 254, 0.36)";
    ctx.lineWidth = Math.max(0.8, 1.1 * zoom);
    const vx = proj.viewX >= 0 ? bx + bw : bx;
    const vz = proj.viewZ >= 0 ? bz + bd : bz;
    for (let fl = 1; fl < floors; fl++) {
      const fy = height * (fl / floors) * zoom;
      const pA = proj.project(bx + bw * 0.14, vz, fy);
      const pB = proj.project(bx + bw * 0.86, vz, fy);
      const pC = proj.project(vx, bz + bd * 0.14, fy);
      const pD = proj.project(vx, bz + bd * 0.86, fy);
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.moveTo(pC.x, pC.y);
      ctx.lineTo(pD.x, pD.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  for (const crown of ROOFTOP_CROWNS[arch] ?? []) {
    if (crown.minH && height <= crown.minH) continue;
    const crownPal = crown.roofColor
      ? { ...effPal, roof: crown.roofColor === "accent" ? effPal.accent : crown.roofColor }
      : effPal;
    const crownH = crown.hFrac ? height * crown.hFrac * zoom : (crown.hFixed ?? 6) * zoom;
    drawIsoPrism(
      ctx,
      proj,
      bx + bw * crown.ox,
      bz + bd * crown.oz,
      bw * crown.wFrac,
      bd * crown.dFrac,
      height * zoom,
      crownH,
      crownPal,
      stroke,
      crown.lineWidth ?? 0.8,
    );
  }

  const roof = proj.project(bx + bw * 0.5, bz + bd * 0.5, (height + 4) * zoom);
  drawConditionSignals(ctx, file, bx, bz, zoom, timeSec, roof, isBurning, isBlackout);
}

type DepthDrawable =
  | { depth: number; kind: "building"; file: FileMetric }
  | { depth: number; kind: "tree"; tree: TreePlacement }
  | { depth: number; kind: "rock"; rock: RockPlacement };

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

  const proj = makeProjector(width, height, camera);
  const zoom = proj.zoom;
  const rollRad = ((camera.roll ?? 0) * Math.PI) / 180;
  const pivotX = width * 0.5;
  const pivotY = height * 0.52;
  const analytical = isAnalyticalDataMap(dataMap);

  ctx.clearRect(0, 0, width, height);

  // 1. Sunlit coastal ocean backdrop & gentle water shimmer
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  if (timeOfDay === "golden") {
    grad.addColorStop(0, "#4a617d");
    grad.addColorStop(0.55, "#2b4d6d");
    grad.addColorStop(1, "#183652");
  } else if (timeOfDay === "night") {
    grad.addColorStop(0, "#0b1b33");
    grad.addColorStop(1, "#081426");
  } else {
    grad.addColorStop(0, "#2472a4");
    grad.addColorStop(0.55, "#195a87");
    grad.addColorStop(1, "#11466b");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.strokeStyle =
    timeOfDay === "golden"
      ? "rgba(253, 186, 116, 0.14)"
      : timeOfDay === "night"
        ? "rgba(147, 197, 253, 0.08)"
        : "rgba(224, 242, 254, 0.14)";
  ctx.lineWidth = 1.1;
  for (let i = 0; i < 14; i++) {
    const wy = ((i * 64 + timeSec * 6) % (height + 40)) - 20;
    ctx.beginPath();
    ctx.moveTo(0, wy);
    ctx.bezierCurveTo(
      width * 0.3,
      wy + Math.sin(timeSec * 0.9 + i) * 5,
      width * 0.7,
      wy - Math.cos(timeSec * 0.9 + i) * 5,
      width,
      wy,
    );
    ctx.stroke();
  }
  ctx.restore();

  if (rollRad !== 0) {
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(rollRad);
    ctx.translate(-pivotX, -pivotY);
  }

  // 2. Organic coastal island: turquoise shallows, surf foam, sandy shore, green meadows & harbor quay
  const shallowFill =
    timeOfDay === "night"
      ? "rgba(30, 82, 118, 0.4)"
      : timeOfDay === "golden"
        ? "rgba(56, 152, 176, 0.36)"
        : "rgba(56, 194, 214, 0.42)";
  drawCoastPolygon(ctx, proj, 1.11, -0.8 * zoom, shallowFill, null);

  const surfPulse = 1.028 + Math.sin(timeSec * 2.0) * 0.008;
  drawCoastPolygon(
    ctx,
    proj,
    surfPulse,
    -0.3 * zoom,
    "rgba(255, 255, 255, 0.04)",
    timeOfDay === "night" ? "rgba(186, 230, 253, 0.25)" : "rgba(241, 248, 255, 0.55)",
    Math.max(1.2, 2.0 * zoom),
  );

  // Sandy beach shelf & rocky cliff skirt
  drawCoastPolygon(
    ctx,
    proj,
    1.015,
    -1.2 * zoom,
    timeOfDay === "night" ? "#3b4240" : "#9c947d",
    null,
    1,
    true,
  );
  drawCoastPolygon(
    ctx,
    proj,
    1.012,
    0.0,
    timeOfDay === "night" ? "#4f4c3d" : timeOfDay === "golden" ? "#c9b389" : "#dfd1a9",
    null,
    1,
    true,
  );
  // Green coastal meadow hills
  drawCoastPolygon(
    ctx,
    proj,
    0.965,
    0.1,
    timeOfDay === "night" ? "#203b2a" : timeOfDay === "golden" ? "#55793e" : "#568f45",
    null,
    1,
    true,
  );

  // Southern dressed-stone harbor seawall & graded urban plateau
  drawIsoPrism(
    ctx,
    proj,
    4,
    102.5,
    132,
    3.5,
    -2.5 * zoom,
    2.6 * zoom,
    { roof: "#8c949e", left: "#717882", right: "#575e66", accent: "#cbd5e1" },
    "rgba(51, 65, 85, 0.45)",
    0.9,
  );

  const plateauFill = analytical
    ? timeOfDay === "night"
      ? "#334155"
      : "#cbd5e1"
    : timeOfDay === "night"
      ? "#244430"
      : timeOfDay === "golden"
        ? "#618647"
        : "#629a4f";
  drawGroundQuad(ctx, proj, -1, -1, 142, 106, 0.12, plateauFill, "rgba(100, 116, 139, 0.28)", 0.8);

  // 3. Asphalt avenues, lane markings & crosswalks
  if (streetLines && (streetLines.xLines.length > 0 || streetLines.zLines.length > 0)) {
    const asphaltCol = timeOfDay === "night" ? "#2a3038" : "#495059";
    for (const xl of streetLines.xLines) {
      drawGroundQuad(ctx, proj, xl - 1.1, 0.6, 2.2, 102.8, 0.14, asphaltCol, null);
    }
    for (const zl of streetLines.zLines) {
      drawGroundQuad(ctx, proj, 0.6, zl - 1.1, 138.8, 2.2, 0.14, asphaltCol, null);
    }

    ctx.save();
    ctx.strokeStyle = "rgba(245, 204, 86, 0.72)";
    ctx.lineWidth = Math.max(0.8, 1.1 * zoom);
    ctx.setLineDash([4 * zoom, 4 * zoom]);
    for (const xl of streetLines.xLines) {
      const a = proj.project(xl, 1.2, 0.16);
      const b = proj.project(xl, 102.8, 0.16);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (const zl of streetLines.zLines) {
      const a = proj.project(1.2, zl, 0.16);
      const b = proj.project(138.8, zl, 0.16);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (zoom >= 0.65) {
      for (let xi = 0; xi < streetLines.xLines.length; xi++) {
        for (let zi = 0; zi < streetLines.zLines.length; zi++) {
          const ix = streetLines.xLines[xi];
          const iz = streetLines.zLines[zi];
          drawGroundQuad(ctx, proj, ix - 1.15, iz - 1.15, 2.3, 2.3, 0.15, asphaltCol, null);
          ctx.strokeStyle = "rgba(241, 245, 249, 0.65)";
          ctx.lineWidth = Math.max(0.8, 1.2 * zoom);
          for (const d of [-0.6, 0, 0.6]) {
            const c0 = proj.project(ix + d, iz - 1.55, 0.18);
            const c1 = proj.project(ix + d, iz - 1.15, 0.18);
            ctx.beginPath();
            ctx.moveTo(c0.x, c0.y);
            ctx.lineTo(c1.x, c1.y);
            ctx.stroke();
          }
          if (timeOfDay !== "day") {
            const lamp = proj.project(ix + 1.35, iz + 1.35, 1.5 * zoom);
            ctx.beginPath();
            ctx.arc(lamp.x, lamp.y, Math.max(1.8, 3.2 * zoom), 0, Math.PI * 2);
            ctx.fillStyle = "rgba(253, 224, 71, 0.45)";
            ctx.fill();
          }
        }
      }
    }
    ctx.restore();
  }

  const atlas = spriteAtlas.ensureLoaded();
  const placements = getCachedNaturePlacements(districts, files, plazas, streetLines);

  // 4. Waterfront supply docks, moored cargo ships & outer bay sailboats
  const directDeps = deps.filter((d) => d.is_direct).slice(0, 8);
  directDeps.forEach((dep, idx) => {
    const dockX = 10 + idx * 16;
    const dockZ = 106;
    drawIsoPrism(
      ctx,
      proj,
      dockX,
      dockZ,
      10,
      5.2,
      -1.2 * zoom,
      2.2 * zoom,
      { roof: "#9b7653", left: "#7c5b3e", right: "#5c422c", accent: "#d4b483" },
      "rgba(71, 51, 33, 0.55)",
      0.8,
    );
    drawIsoPrism(
      ctx,
      proj,
      dockX + 0.8,
      dockZ + 0.8,
      2.8,
      1.8,
      1.0 * zoom,
      1.6 * zoom,
      { roof: "#b36247", left: "#cbd5e1", right: "#94a3b8", accent: "#f8fafc" },
      "rgba(51, 65, 85, 0.4)",
      0.7,
    );

    const bobY = Math.sin(timeSec * 1.6 + idx * 1.1) * 0.45 * zoom;
    if (atlas.ready && atlas.nature) {
      const shipSp = proj.project(dockX + 5.2, dockZ + 8.4, bobY);
      const sScale = Math.max(0.35, 0.72 * zoom);
      const rect = spriteAtlas.getNatureSpriteRect(4 + (proj.compassStep % 2), 1);
      ctx.drawImage(
        atlas.nature,
        rect.sx,
        rect.sy,
        rect.sw,
        rect.sh,
        shipSp.x - NATURE_ANCHOR_X * sScale,
        shipSp.y - NATURE_ANCHOR_Y * sScale,
        NATURE_CELL_W * sScale,
        NATURE_CELL_H * sScale,
      );
    } else {
      drawIsoPrism(
        ctx,
        proj,
        dockX + 2.2,
        dockZ + 6.4,
        6.5,
        2.6,
        (-1.0 + bobY) * zoom,
        2.2 * zoom,
        { roof: "#d97706", left: "#334155", right: "#1e293b", accent: "#f1f5f9" },
        "rgba(226, 232, 240, 0.4)",
        0.7,
      );
    }
    if (zoom >= 0.7) {
      const lbl = proj.project(dockX + 5.2, dockZ + 3.2, 4.2 * zoom);
      ctx.fillStyle = "rgba(15, 23, 42, 0.78)";
      const txt = dep.package_name.slice(0, 14);
      ctx.font = `600 ${Math.max(8, Math.round(9 * zoom))}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      const tw = ctx.measureText(txt).width + 6;
      ctx.fillRect(lbl.x - tw * 0.5, lbl.y - 8, tw, 11);
      ctx.fillStyle = "#f1f5f9";
      ctx.fillText(txt, lbl.x, lbl.y);
    }
  });

  if (atlas.ready && atlas.nature) {
    const natureImg = atlas.nature;
    placements.sailboats.forEach((sb, idx) => {
      const bob = Math.sin(timeSec * 1.8 + idx * 1.5) * 0.35 * zoom;
      const p = proj.project(sb.x + WORLD_CENTER_X, sb.z + WORLD_CENTER_Z, bob);
      const sc = Math.max(0.28, 0.48 * sb.scale * zoom);
      const rect = spriteAtlas.getNatureSpriteRect(6 + (idx % 2), 1);
      ctx.drawImage(
        natureImg,
        rect.sx,
        rect.sy,
        rect.sw,
        rect.sh,
        p.x - NATURE_ANCHOR_X * sc,
        p.y - NATURE_ANCHOR_Y * sc,
        NATURE_CELL_W * sc,
        NATURE_CELL_H * sc,
      );
    });
  }

  // 5. Concrete sidewalks, natural zoned districts, plazas & demolished ghost lots
  for (const dist of districts) {
    const zStyle = ZONE_PALETTES[dist.zone_type] ?? ZONE_PALETTES.downtown_core;
    drawGroundQuad(
      ctx,
      proj,
      dist.bounds_x - 0.4,
      dist.bounds_z - 0.4,
      dist.bounds_w + 0.8,
      dist.bounds_d + 0.8,
      0.2,
      timeOfDay === "night" ? "#64748b" : "#cfd5dd",
      "rgba(100, 116, 139, 0.32)",
      0.7,
    );

    const distFill = analytical
      ? timeOfDay === "night"
        ? "#475569"
        : "#dbe0e6"
      : dist.zone_type === "downtown_core"
        ? timeOfDay === "night"
          ? "#555f6b"
          : "#c8ced6"
        : dist.zone_type === "industrial_quarter" || dist.zone_type === "supply_docks"
          ? timeOfDay === "night"
            ? "#4b4b48"
            : "#b4afa5"
          : timeOfDay === "night"
            ? "#244732"
            : zStyle.ground;
    const distStroke = analytical ? zStyle.border : "rgba(100, 116, 139, 0.25)";
    drawGroundQuad(
      ctx,
      proj,
      dist.bounds_x,
      dist.bounds_z,
      dist.bounds_w,
      dist.bounds_d,
      0.3,
      distFill,
      distStroke,
      analytical ? 1.2 : 0.7,
    );
  }

  for (const pz of plazas) {
    const fill =
      pz.kind === "loading_bay" ? "#8c8478" : pz.kind === "courtyard" ? "#5b934c" : "#d0d5dc";
    drawGroundQuad(ctx, proj, pz.x, pz.z, pz.w, pz.d, 0.34, fill, "rgba(100, 116, 139, 0.35)", 0.7);
  }

  for (const lot of removedLots) {
    const pad = 0.25;
    ctx.save();
    ctx.setLineDash([4, 3]);
    drawGroundQuad(
      ctx,
      proj,
      lot.layout_x + pad,
      lot.layout_z + pad,
      Math.max(0.8, lot.layout_w - pad * 2),
      Math.max(0.8, lot.layout_d - pad * 2),
      0.8,
      "rgba(239, 68, 68, 0.16)",
      "rgba(248, 113, 113, 0.85)",
      1.4,
    );
    ctx.restore();
  }

  const fileByPath = new Map(files.map((f) => [f.file_path, f]));

  // 6. Traffic pulses or baked 3D vehicle sprites
  if (showTraffic && imports.length > 0 && vehicles.length === 0) {
    ctx.save();
    const maxEdges = Math.min(60, imports.length);
    for (let i = 0; i < maxEdges; i++) {
      const edge = imports[i];
      const src = fileByPath.get(edge.source_file);
      const dst = fileByPath.get(edge.target_file);
      if (!src || !dst) continue;
      const pA = proj.project(
        src.layout_x + src.layout_w * 0.5,
        src.layout_z + src.layout_d * 0.5,
        2,
      );
      const pB = proj.project(
        dst.layout_x + dst.layout_w * 0.5,
        dst.layout_z + dst.layout_d * 0.5,
        2,
      );
      const t = (timeSec * 0.45 + i * 0.17) % 1;
      ctx.beginPath();
      ctx.arc(
        pA.x + (pB.x - pA.x) * t,
        pA.y + (pB.y - pA.y) * t,
        Math.max(1.4, 2 * zoom),
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
      ctx.fill();
    }
    ctx.restore();
  }

  if (showTraffic && vehicles.length > 0) {
    ctx.save();
    const flash = timeSec % 0.4 >= 0.2;
    for (const v of vehicles) {
      const p = proj.project(v.x, v.z, 0.35);
      if (atlas.ready && atlas.nature && v.type === "request_car" && zoom >= 0.6 && !v.jammed) {
        const carCol = hashFilePath(v.id) % 4;
        const sc = Math.max(0.18, 0.26 * zoom);
        const rect = spriteAtlas.getNatureSpriteRect(carCol, 1);
        ctx.drawImage(
          atlas.nature,
          rect.sx,
          rect.sy,
          rect.sw,
          rect.sh,
          p.x - NATURE_ANCHOR_X * sc,
          p.y - NATURE_ANCHOR_Y * sc,
          NATURE_CELL_W * sc,
          NATURE_CELL_H * sc,
        );
      } else {
        const size = Math.max(2.2, (v.type === "cargo_ship" ? 4.8 : 2.6) * zoom);
        ctx.beginPath();
        if (v.type === "cargo_ship") {
          ctx.rect(p.x - size * 1.4, p.y - size * 0.7, size * 2.8, size * 1.4);
        } else {
          ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        }
        ctx.fillStyle = vehicleColor(v.type, v.jammed, flash);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // 7. Depth-sorted buildings, trees & coastal boulders
  const impactedHop = buildImpactedHopMap(blastRadius);
  const drawables: DepthDrawable[] = [];

  for (const file of files) {
    const depth =
      (file.layout_x + file.layout_w * 0.5 - WORLD_CENTER_X) * proj.viewX +
      (file.layout_z + file.layout_d * 0.5 - WORLD_CENTER_Z) * proj.viewZ;
    drawables.push({ depth, kind: "building", file });
  }
  for (const tree of placements.trees) {
    const depth = tree.x * proj.viewX + tree.z * proj.viewZ;
    drawables.push({ depth, kind: "tree", tree });
  }
  for (const rock of placements.rocks) {
    const depth = rock.x * proj.viewX + rock.z * proj.viewZ;
    drawables.push({ depth, kind: "rock", rock });
  }
  drawables.sort((a, b) => a.depth - b.depth);

  const hits: HitBuilding[] = [];
  for (const item of drawables) {
    if (item.kind === "rock") {
      if (atlas.ready && atlas.nature) {
        const p = proj.project(
          item.rock.x + WORLD_CENTER_X,
          item.rock.z + WORLD_CENTER_Z,
          item.rock.y,
        );
        const sc = Math.max(0.2, 0.34 * zoom);
        const rect = spriteAtlas.getNatureSpriteRect(7, 0);
        ctx.drawImage(
          atlas.nature,
          rect.sx,
          rect.sy,
          rect.sw,
          rect.sh,
          p.x - NATURE_ANCHOR_X * sc,
          p.y - NATURE_ANCHOR_Y * sc,
          NATURE_CELL_W * sc,
          NATURE_CELL_H * sc,
        );
      }
      continue;
    }

    if (item.kind === "tree") {
      const tr = item.tree;
      const p = proj.project(tr.x + WORLD_CENTER_X, tr.z + WORLD_CENTER_Z, Math.max(0.2, tr.y));
      if (atlas.ready && atlas.nature) {
        const h = hashFilePath(`tr:${tr.x.toFixed(1)}:${tr.z.toFixed(1)}`);
        const col = tr.isPine ? 4 + (h % 3) : h % 4;
        const sc = Math.max(0.22, 0.38 * tr.scale * zoom);
        const rect = spriteAtlas.getNatureSpriteRect(col, 0);
        ctx.drawImage(
          atlas.nature,
          rect.sx,
          rect.sy,
          rect.sw,
          rect.sh,
          p.x - NATURE_ANCHOR_X * sc,
          p.y - NATURE_ANCHOR_Y * sc,
          NATURE_CELL_W * sc,
          NATURE_CELL_H * sc,
        );
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y - 3 * zoom, Math.max(2.2, 3.6 * tr.scale * zoom), 0, Math.PI * 2);
        ctx.fillStyle = tr.color;
        ctx.fill();
      }
      continue;
    }

    const file = item.file;
    const pad = Math.min(0.42, Math.min(file.layout_w, file.layout_d) * 0.12);
    const rawW = Math.max(0.85, file.layout_w - pad * 2);
    const rawD = Math.max(0.85, file.layout_d - pad * 2);
    const bw = Math.min(rawW, rawD * 3.2);
    const bd = Math.min(rawD, rawW * 3.2);
    const bx = file.layout_x + (file.layout_w - bw) * 0.5;
    const bz = file.layout_z + (file.layout_d - bd) * 0.5;
    const heightVal = computeBuildingHeight(file);

    const isSelected = selectedFile === file.file_path;
    const isHovered = hoveredFile === file.file_path;
    const isAdded = addedFiles.has(file.file_path);
    const hop = impactedHop.get(file.file_path);

    let palette = buildingPalette(file, dataMap);
    let stroke = isAdded ? "rgba(16, 185, 129, 0.85)" : "rgba(15, 23, 42, 0.65)";
    let hasHighlightStroke = false;
    let isHopHighlight = false;

    let alpha = 1.0;
    if (selectedFile && blastRadius) {
      if (isSelected) {
        stroke = "#fef08a";
        hasHighlightStroke = true;
      } else if (hop === 1) {
        palette = { roof: "#fde047", left: "#f59e0b", right: "#b45309", accent: "#fef9c3" };
        stroke = "#fbbf24";
        hasHighlightStroke = true;
        isHopHighlight = true;
      } else if (hop !== undefined && hop >= 2) {
        palette = { roof: "#7dd3fc", left: "#0284c7", right: "#0369a1", accent: "#e0f2fe" };
        stroke = "#38bdf8";
        hasHighlightStroke = true;
        isHopHighlight = true;
      } else {
        alpha = 0.28;
      }
    } else if (isSelected) {
      stroke = "#fef08a";
      hasHighlightStroke = true;
    } else if (isHovered) {
      stroke = "#ffffff";
      hasHighlightStroke = true;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    drawBuildingDetails(
      ctx,
      proj,
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
      stroke,
      hasHighlightStroke,
      isHopHighlight,
      isAdded,
      fireFiles?.has(file.file_path) ?? false,
      blackoutFiles?.has(file.file_path) ?? false,
    );
    ctx.restore();

    const hz = heightVal * zoom;
    const corners = [
      proj.project(bx, bz, hz),
      proj.project(bx + bw, bz, hz),
      proj.project(bx + bw, bz + bd, hz),
      proj.project(bx, bz + bd, hz),
      proj.project(bx, bz, 0),
      proj.project(bx + bw, bz, 0),
      proj.project(bx + bw, bz + bd, 0),
      proj.project(bx, bz + bd, 0),
    ];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of corners) {
      const pt = rollRad !== 0 ? rotatePoint2D(c.x, c.y, pivotX, pivotY, rollRad) : c;
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
    hits.push({ file, minX: minX - 3, maxX: maxX + 3, minY: minY - 3, maxY: maxY + 3 });
  }

  // 8. Soft drifting daylight cloud shadows across the landscape
  if (timeOfDay === "day") {
    ctx.save();
    ctx.fillStyle = "rgba(15, 23, 42, 0.055)";
    for (let i = 0; i < 4; i++) {
      const cx = ((timeSec * 14 + i * 380) % (width + 520)) - 260;
      const cy = height * (0.18 + i * 0.21) + Math.sin(timeSec * 0.2 + i) * 24;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 175 * zoom, 65 * zoom, -0.22, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // 9. Co-change fault lines (only when selected or blast radius active)
  const faultSource = selectFaultLines(cochanges, selectedFile, blastRadius);
  if (faultSource.length > 0) {
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -timeSec * 16;
    ctx.strokeStyle = selectedFile ? "#e879f9" : "rgba(192, 132, 252, 0.55)";
    ctx.lineWidth = selectedFile ? 2.4 : 1.5;
    for (const pair of faultSource) {
      const fa = fileByPath.get(pair.file_a);
      const fb = fileByPath.get(pair.file_b);
      if (!fa || !fb) continue;
      const aPt = proj.project(
        fa.layout_x + fa.layout_w * 0.5,
        fa.layout_z + fa.layout_d * 0.5,
        computeBuildingHeight(fa) * zoom,
      );
      const bPt = proj.project(
        fb.layout_x + fb.layout_w * 0.5,
        fb.layout_z + fb.layout_d * 0.5,
        computeBuildingHeight(fb) * zoom,
      );
      ctx.beginPath();
      ctx.moveTo(aPt.x, aPt.y);
      ctx.quadraticCurveTo((aPt.x + bPt.x) * 0.5, Math.min(aPt.y, bPt.y) - 24 * zoom, bPt.x, bPt.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 10. District plaques
  if (zoom >= 0.6) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.font = `600 ${Math.max(9, Math.round(10 * Math.min(1.3, zoom)))}px Inter, sans-serif`;
    for (const dist of districts) {
      if (dist.bounds_w * dist.bounds_d < 45 && zoom < 1.1) continue;
      const center = proj.project(
        dist.bounds_x + dist.bounds_w * 0.5,
        dist.bounds_z + dist.bounds_d * 0.5,
        2,
      );
      const label =
        dist.display_name.length > 22
          ? `…/${dist.display_name.split("/").slice(-1)[0]}`
          : dist.display_name;
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = "rgba(15, 23, 42, 0.76)";
      ctx.fillRect(center.x - tw * 0.5, center.y - 8, tw, 15);
      ctx.fillStyle = analytical ? (ZONE_PALETTES[dist.zone_type]?.border ?? "#e2e8f0") : "#f1f5f9";
      ctx.fillText(label, center.x, center.y + 3);
    }
    ctx.restore();
  }

  // 11. Floating stat popups
  if (floatingPopups.length > 0) {
    ctx.save();
    ctx.font = "700 12px Inter, sans-serif";
    ctx.textAlign = "center";
    for (const pop of floatingPopups) {
      const p = proj.project(pop.x, pop.z, 26 * zoom);
      ctx.globalAlpha = Math.max(0, 1 - pop.progress);
      ctx.fillStyle = "rgba(2, 6, 23, 0.75)";
      const tw = ctx.measureText(pop.text).width + 10;
      ctx.fillRect(p.x - tw * 0.5, p.y - 24 * pop.progress - 11, tw, 16);
      ctx.fillStyle = pop.color;
      ctx.fillText(pop.text, p.x, p.y - 24 * pop.progress);
    }
    ctx.restore();
  }

  if (rollRad !== 0) {
    ctx.restore();
  }

  return hits;
}
