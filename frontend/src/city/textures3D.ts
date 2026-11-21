import * as THREE from "three";

export interface FacadeTextureSet {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  emissiveMap: THREE.CanvasTexture;
}

export type FacadeStyle = "glass" | "stone" | "industrial" | "silo";

const facadeCache = new Map<FacadeStyle, FacadeTextureSet>();
let cachedAsphalt: THREE.CanvasTexture | null = null;
let cachedWaterBump: THREE.CanvasTexture | null = null;
let cachedTurf: THREE.CanvasTexture | null = null;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function makeTex(
  canvas: HTMLCanvasElement,
  repeatX = 1,
  repeatY = 1,
  srgb = true,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export function getFacadeTextureSet(style: FacadeStyle): FacadeTextureSet | null {
  if (typeof document === "undefined") return null;
  const hit = facadeCache.get(style);
  if (hit) return hit;

  const size = 256;
  const colCanvas = makeCanvas(size, size);
  const roughCanvas = makeCanvas(size, size);
  const bumpCanvas = makeCanvas(size, size);
  const emCanvas = makeCanvas(size, size);

  const cCtx = colCanvas.getContext("2d")!;
  const rCtx = roughCanvas.getContext("2d")!;
  const bCtx = bumpCanvas.getContext("2d")!;
  const eCtx = emCanvas.getContext("2d")!;

  cCtx.fillStyle = style === "glass" ? "#94a3b8" : style === "stone" ? "#e2e8f0" : "#cbd5e1";
  cCtx.fillRect(0, 0, size, size);

  rCtx.fillStyle = style === "glass" ? "#b8b8b8" : "#d8d8d8";
  rCtx.fillRect(0, 0, size, size);

  bCtx.fillStyle = "#909090";
  bCtx.fillRect(0, 0, size, size);

  eCtx.fillStyle = "#000000";
  eCtx.fillRect(0, 0, size, size);

  const rows = style === "silo" ? 10 : 8;
  const cols = style === "silo" ? 4 : 6;
  const cellW = size / cols;
  const cellH = size / rows;

  for (let r = 0; r < rows; r++) {
    // Horizontal floor slab band
    cCtx.fillStyle = "rgba(15, 23, 42, 0.28)";
    cCtx.fillRect(0, r * cellH, size, 4);
    bCtx.fillStyle = "#d0d0d0";
    bCtx.fillRect(0, r * cellH, size, 4);

    if (style === "silo") {
      // Ribbed horizontal seams
      cCtx.fillStyle = "rgba(30, 41, 59, 0.35)";
      cCtx.fillRect(0, r * cellH + cellH * 0.5, size, 2);
      continue;
    }

    for (let c = 0; c < cols; c++) {
      const wx = c * cellW + 5;
      const wy = r * cellH + 7;
      const ww = cellW - 10;
      const wh = cellH - 12;

      // Reflective glass pane vs matte frame
      cCtx.fillStyle = style === "glass" ? "#1e3a5f" : style === "stone" ? "#334155" : "#27272a";
      cCtx.fillRect(wx, wy, ww, wh);

      // Glossy low roughness on glass panes
      rCtx.fillStyle = style === "glass" ? "#262626" : "#444444";
      rCtx.fillRect(wx, wy, ww, wh);

      // Recessed window bump
      bCtx.fillStyle = "#353535";
      bCtx.fillRect(wx, wy, ww, wh);

      // Warm or cool lit office windows (~58% lit at night)
      const hash = (r * 13 + c * 7 + style.length * 3) % 7;
      if (hash !== 0 && hash !== 3) {
        eCtx.fillStyle =
          style === "glass"
            ? hash % 2 === 0
              ? "#fef08a"
              : "#bae6fd"
            : style === "industrial"
              ? "#fdba74"
              : "#fde68a";
        eCtx.fillRect(wx + 1, wy + 1, ww - 2, wh - 2);
      }
    }
  }

  const bundle: FacadeTextureSet = {
    map: makeTex(colCanvas, 1, 2, true),
    roughnessMap: makeTex(roughCanvas, 1, 2, false),
    bumpMap: makeTex(bumpCanvas, 1, 2, false),
    emissiveMap: makeTex(emCanvas, 1, 2, true),
  };
  facadeCache.set(style, bundle);
  return bundle;
}

export function getAsphaltRoadTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (cachedAsphalt) return cachedAsphalt;

  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, size, size);

  // Subtle asphalt grain
  for (let i = 0; i < 650; i++) {
    const x = (i * 73) % size;
    const y = (i * 137) % size;
    ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.14)";
    ctx.fillRect(x, y, 2, 2);
  }

  // Lane markings
  ctx.fillStyle = "rgba(250, 204, 21, 0.55)";
  for (let y = 8; y < size; y += 36) {
    ctx.fillRect(size * 0.5 - 2, y, 4, 18);
  }
  ctx.fillStyle = "rgba(226, 232, 240, 0.25)";
  ctx.fillRect(6, 0, 3, size);
  ctx.fillRect(size - 9, 0, 3, size);

  cachedAsphalt = makeTex(canvas, 1, 18, true);
  return cachedAsphalt;
}

export function getWaterRippleTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (cachedWaterBump) return cachedWaterBump;

  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, size, size);

  for (let y = 0; y < size; y += 8) {
    for (let x = 0; x < size; x += 8) {
      const wave =
        Math.sin((x / size) * Math.PI * 4) * 28 + Math.cos((y / size) * Math.PI * 6) * 28;
      const v = Math.max(0, Math.min(255, Math.round(128 + wave)));
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x, y, 8, 8);
    }
  }
  cachedWaterBump = makeTex(canvas, 12, 12, false);
  return cachedWaterBump;
}

export function getTurfTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (cachedTurf) return cachedTurf;

  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#15803d";
  ctx.fillRect(0, 0, size, size);

  // Mowed grass stripes
  ctx.fillStyle = "rgba(74, 222, 128, 0.14)";
  for (let y = 0; y < size; y += 32) {
    ctx.fillRect(0, y, size, 16);
  }
  // Running track oval
  ctx.strokeStyle = "#fde68a";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.ellipse(size * 0.5, size * 0.5, size * 0.36, size * 0.28, 0, 0, Math.PI * 2);
  ctx.stroke();

  cachedTurf = makeTex(canvas, 1, 1, true);
  return cachedTurf;
}
