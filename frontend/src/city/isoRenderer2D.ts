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
  commuterCarColor,
  computeBuildingHeight,
  isAnalyticalDataMap,
  selectFaultLines,
  vehicleColor,
} from "./cityTheme";

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

export interface RenderStaticCityArgs {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  camera: Camera2D;
  timeOfDay?: TimeOfDay;
  districts: District[];
  files: FileMetric[];
  cochanges: CochangePair[];
  deps: ExternalDep[];
  dataMap: DataMapMode;
  selectedFile: string | null;
  hoveredFile: string | null;
  blastRadius: BlastRadiusResult | null;
  addedFiles: Set<string>;
  removedLots: GhostLot[];
  blackoutFiles?: ReadonlySet<string>;
  plazas?: Array<{ x: number; z: number; w: number; d: number; kind: string }>;
  streetLines?: { xLines: number[]; zLines: number[] };
}

export interface RenderDynamicOverlayArgs {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  camera: Camera2D;
  timeSec: number;
  files: FileMetric[];
  imports: FileImport[];
  showTraffic: boolean;
  vehicles?: readonly SimVehicleRender[];
  fireFiles?: ReadonlySet<string>;
  floatingPopups?: readonly FloatingStatPopup[];
}

export interface RenderCitySceneArgs extends RenderStaticCityArgs {
  timeSec: number;
  imports: FileImport[];
  showTraffic: boolean;
  vehicles?: readonly SimVehicleRender[];
  fireFiles?: ReadonlySet<string>;
  floatingPopups?: readonly FloatingStatPopup[];
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

function projectIsoCore(
  wx: number,
  wz: number,
  wy: number,
  cosT: number,
  sinT: number,
  isoYEff: number,
  heightScale: number,
): { x: number; y: number } {
  const dx = wx - WORLD_CENTER_X;
  const dz = wz - WORLD_CENTER_Z;
  const rx = dx * cosT - dz * sinT;
  const rz = dx * sinT + dz * cosT;
  return {
    x: (rx - rz) * ISO_X,
    y: (rx + rz) * isoYEff - wy * heightScale,
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
      const p = projectIsoCore(wx, wz, wy, cosT, sinT, isoYEff, heightScale);
      return { x: ox + p.x * zoom, y: oy + p.y * zoom };
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
  const theta = yaw - DEFAULT_YAW;
  const { isoYScale, heightScale } = getTiltFactors(pitch);
  return projectIsoCore(x, z, y, Math.cos(theta), Math.sin(theta), ISO_Y * isoYScale, heightScale);
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

const hexBlendCache = new Map<string, string>();

function blendHex(hex: string, targetHex: string, t: number): string {
  const key = `${hex}|${targetHex}|${t}`;
  const cached = hexBlendCache.get(key);
  if (cached) return cached;
  const parse = (h: string): [number, number, number] => {
    const clean = h.startsWith("#") ? h.slice(1) : h;
    if (clean.length !== 6) return [148, 163, 184];
    return [
      Number.parseInt(clean.slice(0, 2), 16),
      Number.parseInt(clean.slice(2, 4), 16),
      Number.parseInt(clean.slice(4, 6), 16),
    ];
  };
  const [r1, g1, b1] = parse(hex);
  const [r2, g2, b2] = parse(targetHex);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  const out = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  if (hexBlendCache.size > 256) hexBlendCache.clear();
  hexBlendCache.set(key, out);
  return out;
}

function shadeForTimeOfDay(pal: ShadePalette, tod: TimeOfDay): ShadePalette {
  if (tod === "day") return pal;
  if (tod === "golden") {
    return {
      roof: blendHex(pal.roof, "#f59e0b", 0.14),
      left: blendHex(pal.left, "#d97706", 0.16),
      right: blendHex(pal.right, "#78350f", 0.2),
      accent: pal.accent,
    };
  }
  return {
    roof: blendHex(pal.roof, "#0b1930", 0.42),
    left: blendHex(pal.left, "#0b1930", 0.48),
    right: blendHex(pal.right, "#060e1d", 0.52),
    accent: pal.accent,
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

function drawStaticConditionSignals(
  ctx: CanvasRenderingContext2D,
  file: FileMetric,
  bx: number,
  zoom: number,
  roof: { x: number; y: number },
  isBlackout: boolean,
): void {
  if (file.condition_flags?.crane) {
    const mastTop = { x: roof.x, y: roof.y - 14 * zoom };
    const angle = ((bx * 37) % 10) * 0.05;
    const jibLen = 15 * zoom;
    ctx.strokeStyle = "#facc15";
    ctx.lineWidth = Math.max(1.4, 1.8 * zoom);
    ctx.beginPath();
    ctx.moveTo(roof.x, roof.y);
    ctx.lineTo(mastTop.x, mastTop.y);
    ctx.lineTo(mastTop.x + Math.cos(angle) * jibLen, mastTop.y + Math.sin(angle) * 4 * zoom);
    ctx.moveTo(mastTop.x, mastTop.y);
    ctx.lineTo(mastTop.x - Math.cos(angle) * jibLen * 0.35, mastTop.y - Math.sin(angle) * 2 * zoom);
    ctx.stroke();
  }

  if (file.condition_flags?.smog || file.lint_issue_count >= 3) {
    ctx.fillStyle = "rgba(168, 85, 247, 0.42)";
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.arc(
        roof.x + (i === 0 ? -3 : 4) * zoom,
        roof.y - (7 + i * 5) * zoom,
        Math.max(2.2, (4.2 - i * 0.8) * zoom),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }

  if (file.condition_flags?.lone_keeper || isBlackout) {
    ctx.beginPath();
    ctx.arc(roof.x, roof.y - 4 * zoom, Math.max(3, 4.5 * zoom), 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(251, 113, 133, 0.78)";
    ctx.lineWidth = Math.max(1.2, 1.5 * zoom);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(roof.x, roof.y - 4 * zoom, Math.max(1.8, 2.2 * zoom), 0, Math.PI * 2);
    ctx.fillStyle = "#fb7185";
    ctx.fill();
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
  city_hall: [{ ox: 0.22, oz: 0.22, wFrac: 0.56, dFrac: 0.56, hFrac: 0.32 }],
  factory: [
    {
      ox: 0.14,
      oz: 0.14,
      wFrac: 0.22,
      dFrac: 0.22,
      hFixed: 9,
      roofColor: "#475569",
      lineWidth: 0.7,
    },
    {
      ox: 0.44,
      oz: 0.18,
      wFrac: 0.38,
      dFrac: 0.64,
      hFixed: 4,
      roofColor: "accent",
      lineWidth: 0.7,
    },
  ],
  grand_terminal: [
    { ox: 0.18, oz: 0.18, wFrac: 0.58, dFrac: 0.58, hFixed: 5, roofColor: "accent" },
    { ox: 0.68, oz: 0.12, wFrac: 0.22, dFrac: 0.22, hFixed: 12, roofColor: "#fef08a" },
  ],
  archive_vault: [{ ox: 0.1, oz: 0.1, wFrac: 0.8, dFrac: 0.8, hFixed: 4.5, roofColor: "accent" }],
  watchtower: [{ ox: 0.22, oz: 0.22, wFrac: 0.56, dFrac: 0.56, hFixed: 8, roofColor: "accent" }],
  office_tower: [
    { ox: 0.18, oz: 0.18, wFrac: 0.64, dFrac: 0.64, hFrac: 0.2, minH: 28, lineWidth: 0.7 },
  ],
  glass_pavilion: [
    {
      ox: 0.16,
      oz: 0.16,
      wFrac: 0.68,
      dFrac: 0.68,
      hFixed: 4.2,
      roofColor: "#5da05a",
      lineWidth: 0.7,
    },
  ],
  civic_kiosk: [{ ox: 0.14, oz: 0.14, wFrac: 0.72, dFrac: 0.72, hFixed: 3.6, roofColor: "accent" }],
};

function drawWindowBands(
  ctx: CanvasRenderingContext2D,
  proj: IsoProjector,
  bx: number,
  bz: number,
  bw: number,
  bd: number,
  height: number,
  timeOfDay: TimeOfDay,
): void {
  const zoom = proj.zoom;
  if (zoom < 0.85 || height <= 14) return;
  const floors = Math.min(7, Math.max(2, Math.floor(height / 10)));
  ctx.strokeStyle =
    timeOfDay === "night"
      ? "rgba(253, 224, 71, 0.78)"
      : timeOfDay === "golden"
        ? "rgba(254, 240, 138, 0.58)"
        : "rgba(224, 242, 254, 0.34)";
  ctx.lineWidth = Math.max(0.8, 1.05 * zoom);
  const vx = proj.viewX >= 0 ? bx + bw : bx;
  const vz = proj.viewZ >= 0 ? bz + bd : bz;
  ctx.beginPath();
  for (let fl = 1; fl < floors; fl++) {
    const fy = height * (fl / floors) * zoom;
    const pA = proj.project(bx + bw * 0.14, vz, fy);
    const pB = proj.project(bx + bw * 0.86, vz, fy);
    const pC = proj.project(vx, bz + bd * 0.14, fy);
    const pD = proj.project(vx, bz + bd * 0.86, fy);
    ctx.moveTo(pA.x, pA.y);
    ctx.lineTo(pB.x, pB.y);
    ctx.moveTo(pC.x, pC.y);
    ctx.lineTo(pD.x, pD.y);
  }
  ctx.stroke();
}

function drawBlockBuilding(
  ctx: CanvasRenderingContext2D,
  proj: IsoProjector,
  file: FileMetric,
  bx: number,
  bz: number,
  bw: number,
  bd: number,
  height: number,
  palette: ShadePalette,
  timeOfDay: TimeOfDay,
  stroke: string,
  hasHighlightStroke: boolean,
  isBlackout: boolean,
): void {
  const arch = file.building_archetype;
  const zoom = proj.zoom;

  if (arch === "park_stadium") {
    drawGroundQuad(
      ctx,
      proj,
      bx,
      bz,
      bw,
      bd,
      1,
      timeOfDay === "night" ? "#265231" : "#4d8e41",
      hasHighlightStroke ? stroke : "#86efac",
      hasHighlightStroke ? 1.8 : 1.1,
    );
    const center = proj.project(bx + bw * 0.5, bz + bd * 0.5, 2.2);
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.scale(1, 0.5);
    ctx.beginPath();
    ctx.arc(0, 0, Math.min(bw, bd) * 2.1 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = "#d97757";
    ctx.lineWidth = Math.max(1.4, 2.0 * zoom);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const effPal = isBlackout
    ? { roof: "#1e293b", left: "#0f172a", right: "#020617", accent: "#475569" }
    : shadeForTimeOfDay(palette, timeOfDay);
  const strokeW = hasHighlightStroke ? 1.8 : 0.85;

  if (arch === "twin_silos") {
    const splitX = bw >= bd;
    const gap = (splitX ? bw : bd) * 0.14;
    const sw = splitX ? (bw - gap) * 0.5 : bw * 0.9;
    const sd = splitX ? bd * 0.9 : (bd - gap) * 0.5;
    const s1x = bx + (splitX ? 0 : bw * 0.05);
    const s1z = bz + (splitX ? bd * 0.05 : 0);
    const s2x = splitX ? bx + sw + gap : s1x;
    const s2z = splitX ? s1z : bz + sd + gap;
    const silos = [
      {
        x: s1x,
        z: s1z,
        depth:
          (s1x + sw * 0.5 - WORLD_CENTER_X) * proj.viewX +
          (s1z + sd * 0.5 - WORLD_CENTER_Z) * proj.viewZ,
      },
      {
        x: s2x,
        z: s2z,
        depth:
          (s2x + sw * 0.5 - WORLD_CENTER_X) * proj.viewX +
          (s2z + sd * 0.5 - WORLD_CENTER_Z) * proj.viewZ,
      },
    ];
    silos.sort((a, b) => a.depth - b.depth);
    for (const s of silos) {
      drawIsoPrism(ctx, proj, s.x, s.z, sw, sd, 0, height * zoom, effPal, stroke, strokeW);
      drawIsoPrism(
        ctx,
        proj,
        s.x + sw * 0.18,
        s.z + sd * 0.18,
        sw * 0.64,
        sd * 0.64,
        height * zoom,
        3.2 * zoom,
        { ...effPal, roof: effPal.accent },
        stroke,
        0.7,
      );
    }
    const roof = proj.project(bx + bw * 0.5, bz + bd * 0.5, (height + 5) * zoom);
    drawStaticConditionSignals(ctx, file, bx, zoom, roof, isBlackout);
    return;
  }

  drawIsoPrism(ctx, proj, bx, bz, bw, bd, 0, height * zoom, effPal, stroke, strokeW);
  if (!isBlackout) {
    drawWindowBands(ctx, proj, bx, bz, bw, bd, height, timeOfDay);
  }

  for (const crown of ROOFTOP_CROWNS[arch] ?? []) {
    if (crown.minH && height <= crown.minH) continue;
    const crownPal = crown.roofColor
      ? { ...effPal, roof: crown.roofColor === "accent" ? effPal.accent : crown.roofColor }
      : effPal;
    const crownH = crown.hFrac ? height * crown.hFrac * zoom : (crown.hFixed ?? 5) * zoom;
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
      crown.lineWidth ?? 0.75,
    );
  }

  if (arch === "city_hall" || arch === "watchtower") {
    const mastBase = proj.project(bx + bw * 0.5, bz + bd * 0.5, (height * 1.25 + 3) * zoom);
    ctx.strokeStyle = arch === "city_hall" ? "#fde047" : "#5eead4";
    ctx.lineWidth = Math.max(1.2, 1.6 * zoom);
    ctx.beginPath();
    ctx.moveTo(mastBase.x, mastBase.y);
    ctx.lineTo(mastBase.x, mastBase.y - 7 * zoom);
    ctx.stroke();
  }

  const roof = proj.project(bx + bw * 0.5, bz + bd * 0.5, (height + 4) * zoom);
  drawStaticConditionSignals(ctx, file, bx, zoom, roof, isBlackout);
}

function drawOceanAndIsland(
  ctx: CanvasRenderingContext2D,
  proj: IsoProjector,
  width: number,
  height: number,
  timeOfDay: TimeOfDay,
  analytical: boolean,
): void {
  const zoom = proj.zoom;
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

  // Shallow harbor rim + sand shelf + meadow island slab + harbor seawall
  const shallowFill =
    timeOfDay === "night"
      ? "rgba(30, 82, 118, 0.35)"
      : timeOfDay === "golden"
        ? "rgba(56, 152, 176, 0.32)"
        : "rgba(56, 194, 214, 0.36)";
  drawGroundQuad(ctx, proj, -10, -10, 160, 124, -0.5 * zoom, shallowFill, null);

  const sandFill =
    timeOfDay === "night" ? "#46453a" : timeOfDay === "golden" ? "#c9b389" : "#dfd1a9";
  drawGroundQuad(ctx, proj, -5.5, -5.5, 151, 115, -0.15 * zoom, sandFill, null);

  const meadowFill =
    timeOfDay === "night" ? "#203b2a" : timeOfDay === "golden" ? "#55793e" : "#568f45";
  drawGroundQuad(ctx, proj, -3.5, -3.5, 147, 111, 0.04, meadowFill, null);

  drawIsoPrism(
    ctx,
    proj,
    4,
    102.5,
    132,
    3.5,
    -2.2 * zoom,
    2.3 * zoom,
    { roof: "#8c949e", left: "#717882", right: "#575e66", accent: "#cbd5e1" },
    "rgba(51, 65, 85, 0.4)",
    0.8,
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
}

function drawRoadsAndCrosswalks(
  ctx: CanvasRenderingContext2D,
  proj: IsoProjector,
  streetLines: { xLines: number[]; zLines: number[] } | undefined,
  timeOfDay: TimeOfDay,
): void {
  if (!streetLines || (streetLines.xLines.length === 0 && streetLines.zLines.length === 0)) return;
  const zoom = proj.zoom;
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
  ctx.beginPath();
  for (const xl of streetLines.xLines) {
    const a = proj.project(xl, 1.2, 0.16);
    const b = proj.project(xl, 102.8, 0.16);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  for (const zl of streetLines.zLines) {
    const a = proj.project(1.2, zl, 0.16);
    const b = proj.project(138.8, zl, 0.16);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  if (zoom >= 0.65) {
    for (let xi = 0; xi < streetLines.xLines.length; xi++) {
      for (let zi = 0; zi < streetLines.zLines.length; zi++) {
        const ix = streetLines.xLines[xi];
        const iz = streetLines.zLines[zi];
        drawGroundQuad(ctx, proj, ix - 1.15, iz - 1.15, 2.3, 2.3, 0.15, asphaltCol, null);
        ctx.strokeStyle = "rgba(241, 245, 249, 0.62)";
        ctx.lineWidth = Math.max(0.8, 1.1 * zoom);
        ctx.beginPath();
        for (const d of [-0.6, 0, 0.6]) {
          const c0 = proj.project(ix + d, iz - 1.55, 0.18);
          const c1 = proj.project(ix + d, iz - 1.15, 0.18);
          ctx.moveTo(c0.x, c0.y);
          ctx.lineTo(c1.x, c1.y);
        }
        ctx.stroke();
        if (timeOfDay !== "day") {
          const lamp = proj.project(ix + 1.35, iz + 1.35, 1.4 * zoom);
          ctx.beginPath();
          ctx.arc(lamp.x, lamp.y, Math.max(1.8, 3.0 * zoom), 0, Math.PI * 2);
          ctx.fillStyle = "rgba(253, 224, 71, 0.45)";
          ctx.fill();
        }
      }
    }
  }
  ctx.restore();
}

function drawSupplyDocks(
  ctx: CanvasRenderingContext2D,
  proj: IsoProjector,
  deps: ExternalDep[],
): void {
  const zoom = proj.zoom;
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
    drawIsoPrism(
      ctx,
      proj,
      dockX + 2.2,
      dockZ + 6.4,
      6.5,
      2.6,
      -1.0 * zoom,
      2.1 * zoom,
      { roof: "#d97706", left: "#334155", right: "#1e293b", accent: "#f1f5f9" },
      "rgba(226, 232, 240, 0.35)",
      0.7,
    );
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
}

export function renderStaticCityLayer(args: RenderStaticCityArgs): HitBuilding[] {
  const {
    ctx,
    width,
    height,
    camera,
    timeOfDay = "day",
    districts,
    files,
    cochanges,
    deps,
    dataMap,
    selectedFile,
    hoveredFile,
    blastRadius,
    addedFiles,
    removedLots,
    blackoutFiles,
    plazas = [],
    streetLines,
  } = args;

  const proj = makeProjector(width, height, camera);
  const zoom = proj.zoom;
  const analytical = isAnalyticalDataMap(dataMap);

  ctx.clearRect(0, 0, width, height);
  drawOceanAndIsland(ctx, proj, width, height, timeOfDay, analytical);
  drawRoadsAndCrosswalks(ctx, proj, streetLines, timeOfDay);
  drawSupplyDocks(ctx, proj, deps);

  // Districts, plazas & demolished ghost lots
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

  if (removedLots.length > 0) {
    ctx.save();
    ctx.setLineDash([4, 3]);
    for (const lot of removedLots) {
      const pad = 0.25;
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
    }
    ctx.restore();
  }

  // Depth-sorted geometric building blocks
  const impactedHop = buildImpactedHopMap(blastRadius);
  const sortedFiles = files
    .map((file) => ({
      file,
      depth:
        (file.layout_x + file.layout_w * 0.5 - WORLD_CENTER_X) * proj.viewX +
        (file.layout_z + file.layout_d * 0.5 - WORLD_CENTER_Z) * proj.viewZ,
    }))
    .sort((a, b) => a.depth - b.depth);

  const fileByPath = new Map<string, FileMetric>();
  const hits: HitBuilding[] = [];

  for (const { file } of sortedFiles) {
    fileByPath.set(file.file_path, file);
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
    let alpha = 1.0;

    if (selectedFile && blastRadius) {
      if (isSelected) {
        stroke = "#fef08a";
        hasHighlightStroke = true;
      } else if (hop === 1) {
        palette = { roof: "#fde047", left: "#f59e0b", right: "#b45309", accent: "#fef9c3" };
        stroke = "#fbbf24";
        hasHighlightStroke = true;
      } else if (hop !== undefined && hop >= 2) {
        palette = { roof: "#7dd3fc", left: "#0284c7", right: "#0369a1", accent: "#e0f2fe" };
        stroke = "#38bdf8";
        hasHighlightStroke = true;
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

    if (alpha < 1) {
      ctx.save();
      ctx.globalAlpha = alpha;
    }
    drawBlockBuilding(
      ctx,
      proj,
      file,
      bx,
      bz,
      bw,
      bd,
      heightVal,
      palette,
      timeOfDay,
      stroke,
      hasHighlightStroke,
      blackoutFiles?.has(file.file_path) ?? false,
    );
    if (alpha < 1) {
      ctx.restore();
    }

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

  // Co-change fault lines (static dashed magenta arcs when building selected or blast radius active)
  const faultSource = selectFaultLines(cochanges, selectedFile, blastRadius);
  if (faultSource.length > 0) {
    ctx.save();
    ctx.setLineDash([7, 5]);
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

  // District plaques
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

  return hits;
}

export function renderDynamicCityOverlay(args: RenderDynamicOverlayArgs): void {
  const {
    ctx,
    width,
    height,
    camera,
    timeSec,
    files,
    imports,
    showTraffic,
    vehicles = [],
    fireFiles,
    floatingPopups = [],
  } = args;

  const hasFires = Boolean(fireFiles && fireFiles.size > 0);
  const hasPopups = floatingPopups.length > 0;
  const hasTrafficPulses = showTraffic && imports.length > 0 && vehicles.length === 0;
  const hasVehicles = vehicles.length > 0;
  if (!hasFires && !hasPopups && !hasTrafficPulses && !hasVehicles) return;

  const proj = makeProjector(width, height, camera);
  const zoom = proj.zoom;

  const needsFileMap = hasFires || hasTrafficPulses;
  const fileByPath = needsFileMap ? new Map(files.map((f) => [f.file_path, f])) : null;

  if (hasTrafficPulses && fileByPath) {
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

  if (hasVehicles) {
    ctx.save();
    const flash = timeSec % 0.4 >= 0.2;
    for (const v of vehicles) {
      if (
        !showTraffic &&
        (v.type === "request_car" || v.type === "cycle_car" || v.type === "cargo_ship")
      ) {
        continue;
      }
      const p = proj.project(v.x, v.z, 0.35);
      const size = Math.max(2.2, (v.type === "cargo_ship" ? 4.8 : 2.6) * zoom);
      ctx.beginPath();
      if (v.type === "cargo_ship") {
        ctx.rect(p.x - size * 1.4, p.y - size * 0.7, size * 2.8, size * 1.4);
      } else {
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      }
      ctx.fillStyle =
        v.type === "request_car" && !v.jammed
          ? commuterCarColor(v.id)
          : vehicleColor(v.type, v.jammed, flash);
      ctx.fill();
    }
    ctx.restore();
  }

  if (hasFires && fireFiles && fileByPath) {
    ctx.save();
    for (const fp of fireFiles) {
      const f = fileByPath.get(fp);
      if (!f) continue;
      const h = computeBuildingHeight(f);
      const roof = proj.project(
        f.layout_x + f.layout_w * 0.5,
        f.layout_z + f.layout_d * 0.5,
        h * zoom,
      );
      for (let i = 0; i < 4; i++) {
        const flicker = Math.sin(timeSec * 9 + i * 1.9 + f.layout_x) * 3.0 * zoom;
        const fy = roof.y - (4 + ((timeSec * 14 + i * 5) % 14)) * zoom;
        ctx.beginPath();
        ctx.arc(roof.x + flicker, fy, Math.max(2.2, (5 - i * 0.8) * zoom), 0, Math.PI * 2);
        ctx.fillStyle = i % 2 === 0 ? "rgba(249, 115, 22, 0.86)" : "rgba(250, 204, 21, 0.78)";
        ctx.fill();
      }
    }
    ctx.restore();
  }

  if (hasPopups) {
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
}

export function renderCityScene(args: RenderCitySceneArgs): HitBuilding[] {
  const hits = renderStaticCityLayer(args);
  renderDynamicCityOverlay(args);
  return hits;
}
