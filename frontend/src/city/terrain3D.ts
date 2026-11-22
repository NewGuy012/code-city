import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { District, FileMetric } from "../types/city";
import { WORLD_CENTER_X, WORLD_CENTER_Z } from "./cameraStore";
import { hashFilePath } from "./cityTheme";
import { getMeadowGrassTexture } from "./textures3D";

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Distance outside the flat urban buildable plateau in centered world coordinates. */
export function plateauEdgeDistance(wx: number, wz: number): number {
  const dx = Math.abs(wx) - 71.2;
  const dz = Math.max(-53.2 - wz, wz - 53.2);
  if (dx <= 0 && dz <= 0) return Math.max(dx, dz);
  return Math.hypot(Math.max(0, dx), Math.max(0, dz));
}

/**
 * Signed coastline distance for the organic CodeCity island in centered world coords.
 * Negative = land; 0 = shoreline; Positive = open bay water.
 */
export function islandSignedDist(wx: number, wz: number): number {
  // Straight dressed-stone harbor seawall along the southern Supply Docks waterfront
  const quayBlend = smoothstep(42, 50, wz) * (1 - smoothstep(61, 69, Math.abs(wx)));
  const harborDist = wz - 53.4;

  // Organic super-ellipse island surrounding the city plateau (wider north/west/east)
  const cx = 0;
  const cz = -6.0;
  const rx = 95.0;
  const rz = 72.0;
  const nx = (wx - cx) / rx;
  const nz = (wz - cz) / rz;
  const angle = Math.atan2(nz, nx);
  const wave =
    0.052 * Math.sin(angle * 5.0 + 0.55) +
    0.032 * Math.cos(angle * 9.0 - 1.1) +
    0.018 * Math.sin(wx * 0.13 + wz * 0.11);
  const radial = Math.hypot(nx, nz) - (1.0 + wave);
  const organicDist = radial * 76.0;

  if (quayBlend <= 0.001) return organicDist;
  return organicDist * (1 - quayBlend) + Math.max(organicDist, harborDist) * quayBlend;
}

/** Natural coastal island heightfield (flat -0.04 plateau inside the city grid). */
export function islandElevation(wx: number, wz: number): number {
  const pDist = plateauEdgeDistance(wx, wz);
  if (pDist <= 0) return -0.04;

  const sd = islandSignedDist(wx, wz);
  const isHarborQuay = wz > 52.4 && Math.abs(wx) < 64.5;

  if (sd >= 0) {
    const steep = isHarborQuay ? 1.15 : 0.24;
    return -3.2 * (1 - Math.exp(-sd * steep)) - 0.04;
  }

  if (isHarborQuay) {
    return -0.04;
  }

  const dIn = -sd;
  const beachBand = smoothstep(0.0, 4.2, dIn);
  const hillMask = smoothstep(0.0, 7.5, pDist) * smoothstep(2.5, 13.0, dIn);
  const ridge =
    (Math.sin(wx * 0.075 + 0.6) * Math.cos(wz * 0.085 - 0.4) * 0.5 + 0.5) * 4.6 +
    (Math.sin(wx * 0.16 - wz * 0.14) * 0.5 + 0.5) * 1.4;
  const northBoost = smoothstep(10, -68, wz) * 1.9;
  const shoreLift = beachBand * 0.42;
  return -0.04 + shoreLift + hillMask * (ridge + northBoost);
}

/** Build the sculpted coastal island terrain mesh with vertex colors + grass texture. */
export function createCoastalIslandMesh(): THREE.Mesh {
  const width = 224;
  const depth = 184;
  const segX = 112;
  const segZ = 92;
  const geom = new THREE.PlaneGeometry(width, depth, segX, segZ);
  geom.rotateX(-Math.PI * 0.5);
  geom.translate(0, 0, -4);

  const pos = geom.attributes.position as THREE.BufferAttribute;
  const count = pos.count;

  for (let i = 0; i < count; i++) {
    const wx = pos.getX(i);
    const wz = pos.getZ(i);
    pos.setY(i, islandElevation(wx, wz));
  }
  geom.computeVertexNormals();

  const norm = geom.attributes.normal as THREE.BufferAttribute;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();
  const cDeep = new THREE.Color("#265261");
  const cSand = new THREE.Color("#dfd0a8");
  const cRock = new THREE.Color("#7b8188");
  const cGrassA = new THREE.Color("#5c9349");
  const cGrassB = new THREE.Color("#487b3b");
  const cPlateau = new THREE.Color("#639850");

  for (let i = 0; i < count; i++) {
    const wx = pos.getX(i);
    const wy = pos.getY(i);
    const wz = pos.getZ(i);
    const ny = norm.getY(i);
    const pDist = plateauEdgeDistance(wx, wz);

    if (pDist <= 0.2) {
      c.copy(cPlateau);
    } else if (wy < -0.55) {
      c.copy(cDeep).lerp(cSand, smoothstep(-1.8, -0.55, wy));
    } else if (wy < 0.22 && ny > 0.84) {
      c.copy(cSand).lerp(cGrassA, smoothstep(0.02, 0.22, wy));
    } else if (ny < 0.82) {
      c.copy(cRock);
    } else {
      const mottle = 0.5 + 0.5 * Math.sin(wx * 0.18 + wz * 0.15);
      c.copy(cGrassA).lerp(cGrassB, mottle * 0.7 + smoothstep(2.0, 6.5, wy) * 0.3);
    }

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const grassTex = getMeadowGrassTexture();
  const mat = new THREE.MeshStandardMaterial({
    map: grassTex,
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.02,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}

/** Build distant scenic bay headlands along the northern/eastern/western horizon. */
export function createDistantHeadlands(): THREE.Group {
  const group = new THREE.Group();
  const specs: Array<[number, number, number, number, number]> = [
    [-255, -235, 110, 16, 60],
    [15, -280, 150, 22, 66],
    [265, -220, 115, 18, 58],
    [-295, 35, 82, 12, 74],
    [300, 45, 88, 13, 78],
  ];
  const mat = new THREE.MeshStandardMaterial({
    color: "#6b8f8c",
    roughness: 0.96,
    metalness: 0.0,
  });
  for (let idx = 0; idx < specs.length; idx++) {
    const [x, z, rx, h, rz] = specs[idx];
    const g = new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.5);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);
      const ridge =
        1 +
        0.24 * Math.sin(px * 5.2 + idx * 1.7) * Math.cos(pz * 4.7 - idx) +
        0.12 * Math.sin((px + pz) * 9.0);
      pos.setXYZ(i, px * rx, py * h * ridge, pz * rz);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, -1.5, z);
    group.add(m);
  }
  return group;
}

/** Build a 128x128 shoreline distance-field DataTexture for the 1-pass Fresnel water shader. */
function buildCoastDistanceTexture(): THREE.DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const spanX = 280;
  const spanZ = 240;

  for (let iy = 0; iy < size; iy++) {
    const wz = ((iy + 0.5) / size - 0.5) * spanZ;
    for (let ix = 0; ix < size; ix++) {
      const wx = ((ix + 0.5) / size - 0.5) * spanX;
      const sd = islandSignedDist(wx, wz);
      const norm = Math.max(0, Math.min(1, sd / 42.0));
      const v = Math.round(norm * 255);
      const idx = (iy * size + ix) * 4;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export interface CoastalOceanHandle {
  mesh: THREE.Mesh;
  uniforms: {
    uTime: { value: number };
    uCoastTex: { value: THREE.DataTexture };
    uShallowColor: { value: THREE.Color };
    uDeepColor: { value: THREE.Color };
    uSkyColor: { value: THREE.Color };
    uSunColor: { value: THREE.Color };
    uSunDir: { value: THREE.Vector3 };
    uFogColor: { value: THREE.Color };
    uFogDensity: { value: number };
  };
}

/** Single-pass Fresnel coastal ocean with shallow turquoise tint, wave normals, sun glint, and surf foam. */
export function createCoastalOcean(): CoastalOceanHandle {
  const coastTex = buildCoastDistanceTexture();
  const uniforms = {
    uTime: { value: 0 },
    uCoastTex: { value: coastTex },
    uShallowColor: { value: new THREE.Color("#32a8be") },
    uDeepColor: { value: new THREE.Color("#13527c") },
    uSkyColor: { value: new THREE.Color("#9fd2f5") },
    uSunColor: { value: new THREE.Color("#fff5d6") },
    uSunDir: { value: new THREE.Vector3(0.5, 0.72, 0.42).normalize() },
    uFogColor: { value: new THREE.Color("#bddaf0") },
    uFogDensity: { value: 0.0022 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying float vViewDepth;
      void main() {
        vec4 wPos = modelMatrix * vec4( position, 1.0 );
        vWorldPos = wPos.xyz;
        vec4 mvPos = viewMatrix * wPos;
        vViewDepth = -mvPos.z;
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform sampler2D uCoastTex;
      uniform vec3 uShallowColor;
      uniform vec3 uDeepColor;
      uniform vec3 uSkyColor;
      uniform vec3 uSunColor;
      uniform vec3 uSunDir;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      varying vec3 vWorldPos;
      varying float vViewDepth;

      void main() {
        vec2 coastUv = vec2(
          clamp( vWorldPos.x / 280.0 + 0.5, 0.004, 0.996 ),
          clamp( vWorldPos.z / 240.0 + 0.5, 0.004, 0.996 )
        );
        float coastDist = texture2D( uCoastTex, coastUv ).r;

        // Animated dual-octave procedural wave normal
        float t = uTime;
        float w1 = sin( vWorldPos.x * 0.42 + t * 1.15 + cos( vWorldPos.z * 0.31 - t * 0.7 ) );
        float w2 = cos( vWorldPos.z * 0.48 - t * 0.95 + sin( vWorldPos.x * 0.27 + t * 0.6 ) );
        vec3 N = normalize( vec3( ( w1 + w2 * 0.6 ) * 0.055, 1.0, ( w2 - w1 * 0.5 ) * 0.055 ) );

        vec3 V = isOrthographic
          ? normalize( vec3( viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2] ) )
          : normalize( cameraPosition - vWorldPos );

        float fresnel = pow( 1.0 - max( dot( N, V ), 0.0 ), 3.5 );
        vec3 baseWater = mix( uShallowColor, uDeepColor, smoothstep( 0.02, 0.42, coastDist ) );
        vec3 col = mix( baseWater, uSkyColor, clamp( fresnel * 0.72 + 0.08, 0.0, 0.85 ) );

        // Sun specular shimmer across ripples
        vec3 H = normalize( uSunDir + V );
        float spec = pow( max( dot( N, H ), 0.0 ), 96.0 );
        col += uSunColor * spec * 0.65;

        // Animated coastal surf foam near shallow shoreline
        float surfWave = 0.5 + 0.5 * sin( coastDist * 75.0 - t * 2.4 + w1 * 1.4 );
        float foamBand = ( 1.0 - smoothstep( 0.0, 0.095, coastDist ) ) * smoothstep( 0.003, 0.025, coastDist );
        float foam = foamBand * smoothstep( 0.45, 0.85, surfWave );
        col = mix( col, vec3( 0.94, 0.97, 1.0 ), foam * 0.68 );

        // Exponential distance fog matching scene.fog
        float fogFactor = 1.0 - exp( -uFogDensity * uFogDensity * vViewDepth * vViewDepth );
        col = mix( col, uFogColor, clamp( fogFactor, 0.0, 1.0 ) );

        gl_FragColor = vec4( col, 1.0 );
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), mat);
  mesh.rotation.x = -Math.PI * 0.5;
  mesh.position.y = -0.35;
  return { mesh, uniforms };
}

/* -------------------------------------------------------------------------- */
/* Low-Poly Merged Vehicles, Ships, Trees, Rocks & Streetlights               */
/* -------------------------------------------------------------------------- */

function prepWithColor(geom: THREE.BufferGeometry, colorHex: string): THREE.BufferGeometry {
  const g = geom.index ? geom.toNonIndexed() : geom;
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    g.setAttribute(
      "uv",
      new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2),
    );
  }
  const col = new THREE.Color(colorHex);
  const count = g.attributes.position.count;
  const cols = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    cols[i * 3] = col.r;
    cols[i * 3 + 1] = col.g;
    cols[i * 3 + 2] = col.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  for (const key of Object.keys(g.attributes)) {
    if (key !== "position" && key !== "normal" && key !== "uv" && key !== "color") {
      g.deleteAttribute(key);
    }
  }
  return g;
}

/** Recognizable low-poly vehicle (colored body + dark glass cabin). */
export function createVehicleGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.92, 0.5, 1.0);
  body.translate(0, 0.25, 0);

  const cabin = new THREE.BoxGeometry(0.76, 0.42, 0.52);
  cabin.translate(0, 0.68, -0.04);

  const merged = mergeGeometries(
    [prepWithColor(body, "#ffffff"), prepWithColor(cabin, "#334155")],
    false,
  );
  body.dispose();
  cabin.dispose();
  return merged ?? new THREE.BoxGeometry(1, 1, 1);
}

/** Low-poly coastal cargo ship (hull + white bridge + colored containers). */
export function createCargoShipGeometry(): THREE.BufferGeometry {
  const hull = new THREE.BoxGeometry(6.4, 0.72, 2.2);
  hull.translate(0, 0.36, 0);
  const bridge = new THREE.BoxGeometry(1.1, 1.1, 1.7);
  bridge.translate(-2.1, 1.25, 0);
  const cargoA = new THREE.BoxGeometry(1.6, 0.68, 1.65);
  cargoA.translate(-0.2, 1.05, 0);
  const cargoB = new THREE.BoxGeometry(1.7, 0.68, 1.65);
  cargoB.translate(1.7, 1.05, 0);

  const merged = mergeGeometries(
    [
      prepWithColor(hull, "#334155"),
      prepWithColor(bridge, "#f1f5f9"),
      prepWithColor(cargoA, "#d97706"),
      prepWithColor(cargoB, "#0284c7"),
    ],
    false,
  );
  hull.dispose();
  bridge.dispose();
  cargoA.dispose();
  cargoB.dispose();
  return merged ?? new THREE.BoxGeometry(6.4, 0.9, 2.3);
}

/** Create merged broadleaf tree canopy (multi-lobe crown) and trunk geometries. */
export function createBroadleafTreeGeometries(): {
  trunk: THREE.BufferGeometry;
  canopy: THREE.BufferGeometry;
} {
  const trunk = new THREE.CylinderGeometry(0.08, 0.13, 0.85, 6);
  trunk.translate(0, 0.425, 0);

  const c1 = new THREE.IcosahedronGeometry(0.56, 1);
  c1.translate(0, 1.18, 0);
  const c2 = new THREE.IcosahedronGeometry(0.42, 1);
  c2.translate(0.26, 0.96, 0.14);
  const c3 = new THREE.IcosahedronGeometry(0.4, 1);
  c3.translate(-0.24, 0.98, -0.15);

  const canopy = mergeGeometries(
    [prepWithColor(c1, "#ffffff"), prepWithColor(c2, "#e8f5e9"), prepWithColor(c3, "#dcedc8")],
    false,
  )!;
  c1.dispose();
  c2.dispose();
  c3.dispose();
  return { trunk, canopy };
}

/** Create layered evergreen pine tree canopy geometry. */
export function createPineCanopyGeometry(): THREE.BufferGeometry {
  const k1 = new THREE.ConeGeometry(0.56, 0.9, 7);
  k1.translate(0, 0.9, 0);
  const k2 = new THREE.ConeGeometry(0.44, 0.8, 7);
  k2.translate(0, 1.38, 0);
  const k3 = new THREE.ConeGeometry(0.3, 0.65, 7);
  k3.translate(0, 1.82, 0);
  const canopy = mergeGeometries(
    [prepWithColor(k1, "#e2e8f0"), prepWithColor(k2, "#f1f5f9"), prepWithColor(k3, "#ffffff")],
    false,
  )!;
  k1.dispose();
  k2.dispose();
  k3.dispose();
  return canopy;
}

export interface TreePlacement {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotY: number;
  color: string;
  isPine: boolean;
}

export interface RockPlacement {
  x: number;
  y: number;
  z: number;
  scale: [number, number, number];
  rotY: number;
}

export interface SailboatPlacement {
  x: number;
  z: number;
  rotY: number;
  scale: number;
}

const TREE_GREENS = ["#4a8c42", "#589c4a", "#3c7a38", "#65a651", "#356e39"];

/** Deterministically scatter coastal forests, avenue/park trees, rocks, streetlights, and bay sailboats. */
export function computeNatureAndStreetPlacements(
  districts: District[],
  files: FileMetric[],
  plazas: Array<{ x: number; z: number; w: number; d: number; kind: string }>,
  streetLines?: { xLines: number[]; zLines: number[] },
): {
  trees: TreePlacement[];
  rocks: RockPlacement[];
  sailboats: SailboatPlacement[];
  streetlights: Array<{ x: number; z: number }>;
} {
  const trees: TreePlacement[] = [];
  const rocks: RockPlacement[] = [];
  const sailboats: SailboatPlacement[] = [];
  const streetlights: Array<{ x: number; z: number }> = [];

  const overlapsLot = (wx: number, wz: number, margin = 0.6): boolean => {
    const lx = wx + WORLD_CENTER_X;
    const lz = wz + WORLD_CENTER_Z;
    for (const f of files) {
      if (
        lx >= f.layout_x - margin &&
        lx <= f.layout_x + f.layout_w + margin &&
        lz >= f.layout_z - margin &&
        lz <= f.layout_z + f.layout_d + margin
      ) {
        return true;
      }
    }
    return false;
  };

  // 1. Coastal hills & outer greenbelt forest (outside the city plateau)
  for (let gx = -94; gx <= 94; gx += 4.8) {
    for (let gz = -76; gz <= 60; gz += 4.8) {
      const h = hashFilePath(`t:${gx}:${gz}`);
      const jx = gx + ((h & 255) / 255 - 0.5) * 3.6;
      const jz = gz + (((h >> 8) & 255) / 255 - 0.5) * 3.6;
      if (plateauEdgeDistance(jx, jz) < 1.2) continue;
      const sd = islandSignedDist(jx, jz);
      if (sd > -1.8) continue;
      if (jz > 49 && Math.abs(jx) < 66) continue;
      const elev = islandElevation(jx, jz);
      if (elev < 0.14) continue;
      if ((h & 7) > 5) continue;

      trees.push({
        x: jx,
        y: elev - 0.05,
        z: jz,
        scale: 0.88 + ((h >> 16) % 55) * 0.015,
        rotY: ((h >> 12) % 360) * (Math.PI / 180),
        color: TREE_GREENS[h % TREE_GREENS.length],
        isPine: elev > 1.8 || (h & 3) === 0,
      });
    }
  }

  // 2. Coastal boulders near rocky edges
  for (let i = 0; i < 38; i++) {
    const ang = (i / 38) * Math.PI * 2;
    const rx = Math.cos(ang) * 89;
    const rz = Math.sin(ang) * 67 - 6;
    if (rz > 44 && Math.abs(rx) < 67) continue;
    const sd = islandSignedDist(rx, rz);
    if (sd > 1.2 || sd < -6.5) continue;
    const elev = islandElevation(rx, rz);
    const h = hashFilePath(`rock:${i}`);
    rocks.push({
      x: rx,
      y: elev - 0.1,
      z: rz,
      scale: [0.8 + (h % 6) * 0.25, 0.55 + (h % 4) * 0.18, 0.8 + ((h >> 4) % 5) * 0.22],
      rotY: (h % 360) * (Math.PI / 180),
    });
  }

  // 3. Park Stadium & Greenbelt District trees
  for (const f of files) {
    if (f.building_archetype === "park_stadium") {
      for (const [ox, oz] of [
        [-0.4, -0.36],
        [0.4, 0.36],
      ]) {
        trees.push({
          x: f.layout_x + f.layout_w * (0.5 + ox) - WORLD_CENTER_X,
          y: 0.25,
          z: f.layout_z + f.layout_d * (0.5 + oz) - WORLD_CENTER_Z,
          scale: 0.85,
          rotY: ox * 2.1,
          color: "#4d9444",
          isPine: false,
        });
      }
    }
  }

  for (const d of districts) {
    if (d.zone_type === "greenbelt_parks") {
      for (let i = 0; i < 6; i++) {
        const h = hashFilePath(`${d.district_path}:gb:${i}`);
        const px =
          d.bounds_x + 1.2 + ((h % 100) / 100) * Math.max(1, d.bounds_w - 2.4) - WORLD_CENTER_X;
        const pz =
          d.bounds_z +
          1.2 +
          (((h >> 8) % 100) / 100) * Math.max(1, d.bounds_d - 2.4) -
          WORLD_CENTER_Z;
        if (!overlapsLot(px, pz, 0.5)) {
          trees.push({
            x: px,
            y: 0.14,
            z: pz,
            scale: 0.82,
            rotY: (h % 6) * 0.9,
            color: TREE_GREENS[h % TREE_GREENS.length],
            isPine: i % 3 === 0,
          });
        }
      }
    }
  }

  // 4. Courtyard/plaza trees
  for (const p of plazas) {
    if (p.kind === "loading_bay") continue;
    trees.push({
      x: p.x + p.w * 0.5 - WORLD_CENTER_X,
      y: 0.2,
      z: p.z + p.d * 0.5 - WORLD_CENTER_Z,
      scale: 0.72,
      rotY: p.x * 0.5,
      color: "#579e4a",
      isPine: false,
    });
  }

  // 5. Boulevard avenue trees & streetlights
  const xLines = streetLines?.xLines ?? [];
  const zLines = streetLines?.zLines ?? [];
  const nearRoad = (wx: number, wz: number): boolean => {
    const lx = wx + WORLD_CENTER_X;
    const lz = wz + WORLD_CENTER_Z;
    return (
      xLines.some((xl) => Math.abs(lx - xl) < 1.35) || zLines.some((zl) => Math.abs(lz - zl) < 1.35)
    );
  };

  for (const xl of xLines) {
    for (let lz = 6; lz <= 98; lz += 7.2) {
      if (zLines.some((zl) => Math.abs(lz - zl) < 2.8)) continue;
      const h = hashFilePath(`ax:${xl}:${lz}`);
      const wx = xl + (h % 2 === 0 ? 1.55 : -1.55) - WORLD_CENTER_X;
      const wz = lz - WORLD_CENTER_Z;
      if (!overlapsLot(wx, wz, 0.45) && !nearRoad(wx, wz)) {
        trees.push({
          x: wx,
          y: 0.12,
          z: wz,
          scale: 0.68 + (h % 4) * 0.06,
          rotY: (h % 6) * 0.9,
          color: TREE_GREENS[h % TREE_GREENS.length],
          isPine: false,
        });
      }
    }
  }
  for (const zl of zLines) {
    for (let lx = 6; lx <= 134; lx += 7.8) {
      if (xLines.some((xl) => Math.abs(lx - xl) < 2.8)) continue;
      const h = hashFilePath(`az:${lx}:${zl}`);
      const wx = lx - WORLD_CENTER_X;
      const wz = zl + (h % 2 === 0 ? 1.55 : -1.55) - WORLD_CENTER_Z;
      if (!overlapsLot(wx, wz, 0.45) && !nearRoad(wx, wz)) {
        trees.push({
          x: wx,
          y: 0.12,
          z: wz,
          scale: 0.68 + (h % 4) * 0.06,
          rotY: (h % 6) * 0.9,
          color: TREE_GREENS[h % TREE_GREENS.length],
          isPine: false,
        });
      }
    }
  }

  // District setback pocket trees
  for (const d of districts) {
    for (let i = 0; i < 4; i++) {
      const h = hashFilePath(`dt:${d.district_path}:${i}`);
      const px =
        d.bounds_x + 0.8 + ((h % 100) / 100) * Math.max(1, d.bounds_w - 1.6) - WORLD_CENTER_X;
      const pz =
        d.bounds_z +
        0.8 +
        (((h >> 8) % 100) / 100) * Math.max(1, d.bounds_d - 1.6) -
        WORLD_CENTER_Z;
      if (!overlapsLot(px, pz, 0.55) && !nearRoad(px, pz)) {
        trees.push({
          x: px,
          y: 0.14,
          z: pz,
          scale: 0.72 + (h % 3) * 0.07,
          rotY: (h % 6) * 1.1,
          color: TREE_GREENS[h % TREE_GREENS.length],
          isPine: (h & 3) === 0,
        });
      }
    }
  }

  for (let xi = 0; xi < xLines.length; xi++) {
    for (let zi = 0; zi < zLines.length; zi++) {
      if ((xi + zi) % 2 !== 0) continue;
      streetlights.push({
        x: xLines[xi] + 1.35 - WORLD_CENTER_X,
        z: zLines[zi] + 1.35 - WORLD_CENTER_Z,
      });
    }
  }

  // 6. Sailboats moored / cruising in the outer bay
  const boatCoords: Array<[number, number, number]> = [
    [-108, 72, 0.5],
    [-68, 86, 1.2],
    [42, 88, -0.7],
    [106, 68, -1.9],
    [122, -18, 2.3],
    [-120, -28, 0.8],
  ];
  for (let i = 0; i < boatCoords.length; i++) {
    const [bx, bz, rot] = boatCoords[i];
    sailboats.push({ x: bx, z: bz, rotY: rot, scale: 0.95 + (i % 3) * 0.18 });
  }

  return { trees, rocks, sailboats, streetlights };
}
