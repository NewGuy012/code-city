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
  selectFaultLines,
  vehicleColor,
} from "./cityTheme";
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

export function cameraFromTarget(
  targetX: number,
  targetZ: number,
  zoom: number,
  yaw = DEFAULT_YAW,
  pitch = DEFAULT_PITCH,
): Camera2D {
  const iso = worldToIso(targetX, targetZ, 0, yaw, pitch);
  return { panX: -iso.x * zoom, panY: -iso.y * zoom, zoom, yaw, pitch };
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
  return {
    x: width * 0.5 + camera.panX + iso.x * camera.zoom,
    y: height * 0.52 + camera.panY + iso.y * camera.zoom,
  };
}

export function screenToWorldGround(
  sx: number,
  sy: number,
  width: number,
  height: number,
  camera: Camera2D,
): { x: number; z: number } {
  const yaw = camera.yaw ?? DEFAULT_YAW;
  const { isoYScale } = getTiltFactors(camera.pitch ?? DEFAULT_PITCH);
  const isoX = (sx - width * 0.5 - camera.panX) / camera.zoom;
  const isoY = (sy - height * 0.52 - camera.panY) / camera.zoom;
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
  ctx.globalAlpha *= timeOfDay === "night" ? 0.22 : 0.32;
  drawGroundQuad(
    ctx,
    proj,
    bx + bw * 0.12 + height * reach,
    bz + bd * 0.12 + height * reach * 0.55,
    bw,
    bd,
    0.35,
    "#020617",
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
      roofColor: "#f472b6",
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
  isBurning: boolean,
  isBlackout: boolean,
): void {
  const arch = file.building_archetype;
  const zoom = proj.zoom;

  const atlas = spriteAtlas.ensureLoaded();
  const canUseSprite =
    atlas.ready &&
    atlas.buildings !== null &&
    proj.pitch <= 58 &&
    !isBlackout &&
    Math.max(bw / Math.max(0.4, bd), bd / Math.max(0.4, bw)) <= 1.85;

  if (canUseSprite && atlas.buildings) {
    if (arch !== "park_stadium") {
      drawCastShadow(ctx, proj, bx, bz, bw, bd, height, timeOfDay);
    }
    drawGroundQuad(
      ctx,
      proj,
      bx,
      bz,
      bw,
      bd,
      0.38,
      arch === "park_stadium" ? "#14532d" : "#1e293b",
      stroke,
      stroke.startsWith("#") ? 1.6 : 0.8,
    );

    const rect = spriteAtlas.getBuildingSpriteRect(arch, height, proj.compassStep);
    const baseScreen = proj.project(bx + bw * 0.5, bz + bd * 0.5, 0);
    const scaleX = Math.max(0.28, ((bw + bd) * ISO_X * zoom) / 64.8);
    const scaleY = Math.max(0.24, scaleX * (0.72 + 0.28 * proj.heightScale));
    const dw = ATLAS_CELL_W * scaleX;
    const dh = ATLAS_CELL_H * scaleY;
    const dx = baseScreen.x - ATLAS_ANCHOR_X * scaleX;
    const dy = baseScreen.y - ATLAS_ANCHOR_Y * scaleY;

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
      dataMap === "living" ? null : palette.left,
    );
    if (atlas.emissive && timeOfDay !== "day") {
      ctx.save();
      ctx.globalAlpha *= timeOfDay === "night" ? 0.95 : 0.45;
      ctx.drawImage(atlas.emissive, rect.sx, rect.sy, rect.sw, rect.sh, dx, dy, dw, dh);
      ctx.restore();
    }

    const roof = proj.project(bx + bw * 0.5, bz + bd * 0.5, (height * 0.78 + 6) * zoom);
    drawConditionSignals(ctx, file, bx, bz, zoom, timeSec, roof, isBurning, false);
    return;
  }

  if (arch === "park_stadium") {
    drawGroundQuad(ctx, proj, bx, bz, bw, bd, 1, "#14532d", "#4ade80", 1.1);
    const center = proj.project(bx + bw * 0.5, bz + bd * 0.5, 2.5);
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.scale(1, 0.5);
    ctx.beginPath();
    ctx.arc(0, 0, Math.min(bw, bd) * 2.2 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = "#fde68a";
    ctx.lineWidth = Math.max(1, 1.5 * zoom);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = "#22c55e";
    for (const [ox, oz] of [
      [0.24, 0.28],
      [0.74, 0.72],
    ]) {
      const tp = proj.project(bx + bw * ox, bz + bd * oz, 5 * zoom);
      ctx.beginPath();
      ctx.arc(tp.x, tp.y, Math.max(2.5, 4.2 * zoom), 0, Math.PI * 2);
      ctx.fill();
    }
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
          : "rgba(224, 242, 254, 0.32)";
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

  if (arch === "city_hall") {
    const base = proj.project(bx + bw * 0.5, bz + bd * 0.5, height * 1.34 * zoom);
    const tip = proj.project(bx + bw * 0.5, bz + bd * 0.5, (height * 1.34 + 14) * zoom);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.strokeStyle = "#fef08a";
    ctx.lineWidth = Math.max(1.5, 2 * zoom);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, Math.max(2, 2.8 * zoom), 0, Math.PI * 2);
    ctx.fillStyle = "#fde047";
    ctx.fill();
  } else if (arch === "factory") {
    const base = proj.project(bx + bw * 0.78, bz + bd * 0.26, height * zoom);
    const top = proj.project(bx + bw * 0.78, bz + bd * 0.26, (height + 11) * zoom);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(top.x, top.y);
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = Math.max(2.5, 3.5 * zoom);
    ctx.stroke();
  }

  const roof = proj.project(bx + bw * 0.5, bz + bd * 0.5, (height + 4) * zoom);
  drawConditionSignals(ctx, file, bx, bz, zoom, timeSec, roof, isBurning, isBlackout);
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

  const proj = makeProjector(width, height, camera);
  const zoom = proj.zoom;

  ctx.clearRect(0, 0, width, height);

  // 1. Harbor water backdrop & ripples
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

  // 2. Island seawall, asphalt deck & streets
  drawIsoPrism(
    ctx,
    proj,
    -2.5,
    -2.5,
    145,
    109,
    -5.5 * zoom,
    5.5 * zoom,
    { roof: "#1e293b", left: "#334155", right: "#1e293b", accent: "#475569" },
    "rgba(56, 189, 248, 0.35)",
    1.4,
  );
  drawGroundQuad(ctx, proj, 0, 0, 140, 104, 0.05, "#0f172a", "rgba(148, 163, 184, 0.25)", 1);

  if (streetLines && (streetLines.xLines.length > 0 || streetLines.zLines.length > 0)) {
    ctx.save();
    ctx.strokeStyle = "rgba(250, 204, 21, 0.28)";
    ctx.lineWidth = Math.max(0.8, 1.1 * zoom);
    ctx.setLineDash([4 * zoom, 4 * zoom]);
    for (const xl of streetLines.xLines) {
      const a = proj.project(xl, 1.2, 0.15);
      const b = proj.project(xl, 102.8, 0.15);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (const zl of streetLines.zLines) {
      const a = proj.project(1.2, zl, 0.15);
      const b = proj.project(138.8, zl, 0.15);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (zoom >= 0.72) {
      const phase = Math.floor(timeSec * 0.5) % 2 === 0;
      for (let xi = 0; xi < streetLines.xLines.length; xi++) {
        for (let zi = 0; zi < streetLines.zLines.length; zi++) {
          const ix = streetLines.xLines[xi];
          const iz = streetLines.zLines[zi];
          ctx.strokeStyle = "rgba(226, 232, 240, 0.36)";
          ctx.lineWidth = Math.max(0.8, 1.2 * zoom);
          for (const d of [-0.6, 0, 0.6]) {
            const c0 = proj.project(ix + d, iz - 1.25, 0.18);
            const c1 = proj.project(ix + d, iz - 0.85, 0.18);
            ctx.beginPath();
            ctx.moveTo(c0.x, c0.y);
            ctx.lineTo(c1.x, c1.y);
            ctx.stroke();
          }
          const sig = proj.project(ix + 1.2, iz + 1.2, 2.2 * zoom);
          ctx.beginPath();
          ctx.arc(sig.x, sig.y, Math.max(1.2, 1.8 * zoom), 0, Math.PI * 2);
          ctx.fillStyle = (phase ? (xi + zi) % 2 === 0 : (xi + zi) % 2 === 1)
            ? "#4ade80"
            : "#ef4444";
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // 3. Waterfront supply docks & moored barges
  const directDeps = deps.filter((d) => d.is_direct).slice(0, 8);
  directDeps.forEach((dep, idx) => {
    const dockX = 10 + idx * 16;
    const dockZ = 107;
    drawIsoPrism(
      ctx,
      proj,
      dockX,
      dockZ,
      11,
      5.5,
      -2 * zoom,
      4 * zoom,
      { roof: "#92400e", left: "#78350f", right: "#451a03", accent: "#fbbf24" },
      "rgba(251, 191, 36, 0.45)",
      0.9,
    );
    const bobY = Math.sin(timeSec * 1.6 + idx * 1.1) * 0.7 * zoom;
    drawIsoPrism(
      ctx,
      proj,
      dockX + 2.2,
      dockZ + 6.4,
      6.5,
      2.6,
      (-1.2 + bobY) * zoom,
      2.6 * zoom,
      { roof: "#38bdf8", left: "#0284c7", right: "#075985", accent: "#fde047" },
      "rgba(226, 232, 240, 0.4)",
      0.7,
    );
    if (zoom >= 0.7) {
      const lbl = proj.project(dockX + 5.5, dockZ + 3, 5 * zoom);
      ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
      ctx.font = `${Math.max(8, Math.round(9 * zoom))}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.fillText(dep.package_name.slice(0, 14), lbl.x, lbl.y);
    }
  });

  // 4. Sidewalks, zoned districts, plazas & demolished ghost lots
  for (const dist of districts) {
    const zStyle = ZONE_PALETTES[dist.zone_type] ?? ZONE_PALETTES.downtown_core;
    drawGroundQuad(
      ctx,
      proj,
      dist.bounds_x - 0.35,
      dist.bounds_z - 0.35,
      dist.bounds_w + 0.7,
      dist.bounds_d + 0.7,
      0.2,
      "#334155",
      "rgba(148, 163, 184, 0.28)",
      0.8,
    );
    drawGroundQuad(
      ctx,
      proj,
      dist.bounds_x,
      dist.bounds_z,
      dist.bounds_w,
      dist.bounds_d,
      0.32,
      zStyle.fill,
      zStyle.border,
      1.1,
    );
  }

  for (const pz of plazas) {
    const fill =
      pz.kind === "loading_bay" ? "#3f2e21" : pz.kind === "courtyard" ? "#1b4332" : "#273549";
    drawGroundQuad(ctx, proj, pz.x, pz.z, pz.w, pz.d, 0.38, fill, "rgba(148, 163, 184, 0.35)", 0.7);
    if (zoom >= 0.75 && pz.kind !== "loading_bay") {
      const tp = proj.project(pz.x + pz.w * 0.5, pz.z + pz.d * 0.5, 3.5 * zoom);
      ctx.beginPath();
      ctx.arc(tp.x, tp.y, Math.max(2, 3.2 * zoom), 0, Math.PI * 2);
      ctx.fillStyle = "#22c55e";
      ctx.fill();
    }
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

  // 5. Traffic pulses or simulation vehicles
  if (showTraffic && imports.length > 0 && vehicles.length === 0) {
    ctx.save();
    const maxEdges = Math.min(80, imports.length);
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
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.14)";
      ctx.lineWidth = 1;
      ctx.stroke();

      const t = (timeSec * 0.45 + i * 0.17) % 1;
      ctx.beginPath();
      ctx.arc(
        pA.x + (pB.x - pA.x) * t,
        pA.y + (pB.y - pA.y) * t,
        Math.max(1.4, 2 * zoom),
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = "rgba(125, 211, 252, 0.78)";
      ctx.fill();
    }
    ctx.restore();
  }

  if (showTraffic && vehicles.length > 0) {
    ctx.save();
    const flash = timeSec % 0.4 >= 0.2;
    for (const v of vehicles) {
      const p = proj.project(v.x, v.z, 1.5);
      const size = Math.max(2.2, (v.type === "cargo_ship" ? 4.8 : 2.8) * zoom);
      ctx.beginPath();
      if (v.type === "cargo_ship") {
        ctx.rect(p.x - size * 1.4, p.y - size * 0.7, size * 2.8, size * 1.4);
      } else {
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      }
      ctx.fillStyle = vehicleColor(v.type, v.jammed, flash);
      ctx.fill();
    }
    ctx.restore();
  }

  // 6. Depth-sorted buildings & hitboxes
  const impactedHop = buildImpactedHopMap(blastRadius);
  const sortedFiles = [...files].sort((a, b) => {
    const da =
      (a.layout_x + a.layout_w * 0.5 - WORLD_CENTER_X) * proj.viewX +
      (a.layout_z + a.layout_d * 0.5 - WORLD_CENTER_Z) * proj.viewZ;
    const db =
      (b.layout_x + b.layout_w * 0.5 - WORLD_CENTER_X) * proj.viewX +
      (b.layout_z + b.layout_d * 0.5 - WORLD_CENTER_Z) * proj.viewZ;
    return da - db;
  });

  const hits: HitBuilding[] = [];
  for (const file of sortedFiles) {
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
    const hop = impactedHop.get(file.file_path);

    let palette = buildingPalette(file, dataMap);
    let stroke = "rgba(15, 23, 42, 0.72)";
    if (addedFiles.has(file.file_path)) {
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
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
    }
    hits.push({ file, minX: minX - 3, maxX: maxX + 3, minY: minY - 3, maxY: maxY + 3 });
  }

  // 7. Co-change fault lines
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

  // 8. District plaques
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
      ctx.fillStyle = "rgba(7, 11, 20, 0.72)";
      ctx.fillRect(center.x - tw * 0.5, center.y - 8, tw, 15);
      ctx.fillStyle = ZONE_PALETTES[dist.zone_type]?.border ?? "#e2e8f0";
      ctx.fillText(label, center.x, center.y + 3);
    }
    ctx.restore();
  }

  // 9. Floating stat popups
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

  return hits;
}
