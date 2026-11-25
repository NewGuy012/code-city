import * as THREE from "three";

let cachedAsphalt: THREE.CanvasTexture | null = null;
let cachedSidewalk: THREE.CanvasTexture | null = null;
let cachedGrass: THREE.CanvasTexture | null = null;
let cachedTurf: THREE.CanvasTexture | null = null;
let cachedContactAo: THREE.CanvasTexture | null = null;

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
  clampEdge = false,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = clampEdge ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  tex.wrapT = clampEdge ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function pseudoNoise(x: number, y: number, seed = 17): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Realistic weathered medium-charcoal asphalt road texture with center striping. */
export function getAsphaltRoadTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (cachedAsphalt) return cachedAsphalt;

  const size = 512;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#484f58";
  ctx.fillRect(0, 0, size, size);

  // Subtle tire wear bands
  ctx.fillStyle = "rgba(31, 36, 43, 0.22)";
  ctx.fillRect(size * 0.23, 0, size * 0.16, size);
  ctx.fillRect(size * 0.61, 0, size * 0.16, size);

  // Aggregate mineral speckle
  for (let i = 0; i < 2400; i++) {
    const x = (i * 139 + (i % 17) * 29) % size;
    const y = (i * 251 + (i % 23) * 19) % size;
    ctx.fillStyle = i % 3 === 0 ? "rgba(255,255,255,0.06)" : "rgba(15,23,42,0.12)";
    ctx.fillRect(x, y, 2, 2);
  }

  // Crisp highway yellow dashed centerline & muted white edge lines
  ctx.fillStyle = "rgba(245, 204, 86, 0.78)";
  for (let y = 14; y < size; y += 64) {
    ctx.fillRect(size * 0.5 - 4, y, 8, 34);
  }
  ctx.fillStyle = "rgba(241, 245, 249, 0.55)";
  ctx.fillRect(16, 0, 6, size);
  ctx.fillRect(size - 22, 0, 6, size);

  cachedAsphalt = makeTex(canvas, 1, 22, true);
  return cachedAsphalt;
}

/** Light architectural concrete paver sidewalk texture. */
export function getSidewalkTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (cachedSidewalk) return cachedSidewalk;

  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#d0d6dc";
  ctx.fillRect(0, 0, size, size);

  const step = 32;
  for (let gy = 0; gy < size; gy += step) {
    for (let gx = 0; gx < size; gx += step) {
      const shade = Math.round((pseudoNoise(gx, gy, 5) - 0.5) * 12);
      ctx.fillStyle = `rgb(${208 + shade},${214 + shade},${220 + shade})`;
      ctx.fillRect(gx + 1, gy + 1, step - 2, step - 2);
    }
  }
  ctx.strokeStyle = "rgba(100, 116, 139, 0.28)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= size; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }

  cachedSidewalk = makeTex(canvas, 4, 4, true);
  return cachedSidewalk;
}

/** Sunlit natural meadow grass texture for districts and coastal terrain. */
export function getMeadowGrassTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (cachedGrass) return cachedGrass;

  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#629450";
  ctx.fillRect(0, 0, size, size);

  for (let y = 0; y < size; y += 8) {
    for (let x = 0; x < size; x += 8) {
      const n = pseudoNoise(x * 0.12, y * 0.12, 31);
      const r = Math.round(88 + n * 24);
      const g = Math.round(138 + n * 28);
      const b = Math.round(70 + n * 18);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y, 8, 8);
    }
  }
  // Subtle wildflower & clover speckles
  for (let i = 0; i < 420; i++) {
    const x = (i * 89) % size;
    const y = (i * 157) % size;
    ctx.fillStyle = i % 5 === 0 ? "rgba(254, 240, 138, 0.16)" : "rgba(34, 84, 45, 0.16)";
    ctx.fillRect(x, y, 2, 2);
  }

  cachedGrass = makeTex(canvas, 6, 6, true);
  return cachedGrass;
}

/** Lush mowed athletic turf + terracotta running track oval for park stadiums. */
export function getTurfTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (cachedTurf) return cachedTurf;

  const size = 512;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#4d8e41";
  ctx.fillRect(0, 0, size, size);

  // Mowed grass alternating stripes
  ctx.fillStyle = "rgba(134, 239, 172, 0.14)";
  for (let y = 0; y < size; y += 48) {
    ctx.fillRect(0, y, size, 24);
  }

  // Terracotta running track oval
  ctx.strokeStyle = "#b85d43";
  ctx.lineWidth = 34;
  ctx.beginPath();
  ctx.ellipse(size * 0.5, size * 0.5, size * 0.36, size * 0.28, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(248, 250, 252, 0.72)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(size * 0.5, size * 0.5, size * 0.325, size * 0.245, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(size * 0.5, size * 0.5, size * 0.395, size * 0.315, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Inner pitch chalk lines
  ctx.strokeStyle = "rgba(248, 250, 252, 0.68)";
  ctx.lineWidth = 3;
  ctx.strokeRect(size * 0.28, size * 0.34, size * 0.44, size * 0.32);
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.34);
  ctx.lineTo(size * 0.5, size * 0.66);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(size * 0.5, size * 0.5, size * 0.065, 0, Math.PI * 2);
  ctx.stroke();

  cachedTurf = makeTex(canvas, 1, 1, true);
  return cachedTurf;
}

/** Soft rounded rectangular ground contact-AO decal under building footprints. */
export function getContactAoTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (cachedContactAo) return cachedContactAo;

  const size = 128;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);

  const grad = ctx.createRadialGradient(
    size * 0.5,
    size * 0.5,
    size * 0.16,
    size * 0.5,
    size * 0.5,
    size * 0.52,
  );
  grad.addColorStop(0, "rgba(15, 23, 42, 0.55)");
  grad.addColorStop(0.6, "rgba(15, 23, 42, 0.26)");
  grad.addColorStop(1, "rgba(15, 23, 42, 0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  cachedContactAo = makeTex(canvas, 1, 1, true, true);
  return cachedContactAo;
}
