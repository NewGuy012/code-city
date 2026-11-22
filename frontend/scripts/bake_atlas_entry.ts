import * as THREE from "three";

import { buildingPaletteForVariant } from "../src/city/cityTheme";
import {
  ARCHETYPE_VARIANT_KITS,
  computeSliceHeights,
  getPartGeometry,
} from "../src/city/geometries3D";
import {
  type BuildingShaderUniforms,
  type BuildingSliceKind,
  type ShaderFacadeMode,
  applyBuildingFacadeShader,
} from "../src/city/shaders3D";
import {
  createBroadleafTreeGeometries,
  createCargoShipGeometry,
  createPineCanopyGeometry,
  createVehicleGeometry,
} from "../src/city/terrain3D";
import { getTurfTexture } from "../src/city/textures3D";
import type { BuildingArchetype } from "../src/types/city";

export const ARCHETYPES: BuildingArchetype[] = [
  "grand_terminal",
  "city_hall",
  "archive_vault",
  "twin_silos",
  "factory",
  "office_tower",
  "glass_pavilion",
  "watchtower",
  "civic_kiosk",
  "park_stadium",
];

interface TierSpec {
  tier: 0 | 1 | 2;
  cellW: number;
  cellH: number;
  anchorX: number;
  anchorY: number;
  footprintPx: number;
  worldScale: number;
}

const TIER_SPECS: readonly TierSpec[] = [
  {
    tier: 0,
    cellW: 256,
    cellH: 384,
    anchorX: 128,
    anchorY: 332,
    footprintPx: 156,
    worldScale: 5.0,
  },
  {
    tier: 1,
    cellW: 384,
    cellH: 576,
    anchorX: 192,
    anchorY: 498,
    footprintPx: 234,
    worldScale: 7.4,
  },
  {
    tier: 2,
    cellW: 448,
    cellH: 672,
    anchorX: 224,
    anchorY: 581,
    footprintPx: 273,
    worldScale: 10.6,
  },
];

const NATURE_W = 128;
const NATURE_H = 160;
const EMISSIVE_CELL_W = 160;
const EMISSIVE_CELL_H = 240;

const TIER_HEIGHT_RATIO: Record<BuildingArchetype, [number, number, number]> = {
  office_tower: [1.1, 1.7, 2.38],
  city_hall: [1.05, 1.5, 2.02],
  watchtower: [1.1, 1.6, 2.1],
  twin_silos: [0.95, 1.35, 1.78],
  glass_pavilion: [0.72, 1.02, 1.34],
  archive_vault: [0.68, 0.96, 1.24],
  grand_terminal: [0.7, 0.96, 1.26],
  factory: [0.58, 0.82, 1.08],
  civic_kiosk: [0.54, 0.76, 0.98],
  park_stadium: [0.28, 0.34, 0.4],
};

function createSkyEnv(pmrem: THREE.PMREMGenerator): THREE.WebGLRenderTarget {
  const s = new THREE.Scene();
  const geom = new THREE.SphereGeometry(20, 16, 12);
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const cols = new Float32Array(pos.count * 3);
  const cZen = new THREE.Color("#5b9ee0");
  const cHor = new THREE.Color("#d0e6f7");
  const cGnd = new THREE.Color("#6e9158");
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const ny = pos.getY(i) / 20;
    if (ny >= 0) c.copy(cHor).lerp(cZen, Math.pow(ny, 0.6));
    else c.copy(cHor).lerp(cGnd, Math.min(1, -ny * 1.8));
    cols[i * 3] = c.r;
    cols[i * 3 + 1] = c.g;
    cols[i * 3 + 2] = c.b;
  }
  geom.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  s.add(new THREE.Mesh(geom, mat));
  const rt = pmrem.fromScene(s, 0.04);
  geom.dispose();
  mat.dispose();
  return rt;
}

function positionIsoCam(
  cam: THREE.OrthographicCamera,
  halfW: number,
  halfH: number,
  anchorNormY: number,
): void {
  const elev = Math.PI / 6;
  const azim = Math.PI * 0.25;
  const dist = 60;
  cam.position.set(
    dist * Math.cos(elev) * Math.sin(azim),
    dist * Math.sin(elev),
    dist * Math.cos(elev) * Math.cos(azim),
  );
  cam.lookAt(0, 0, 0);
  cam.left = -halfW;
  cam.right = halfW;
  cam.top = halfH * (anchorNormY * 2);
  cam.bottom = -halfH * ((1 - anchorNormY) * 2);
  cam.near = 1;
  cam.far = 200;
  cam.updateProjectionMatrix();
}

function cleanEmissiveRowAlpha(
  ctx: CanvasRenderingContext2D,
  y: number,
  w: number,
  h: number,
): void {
  const img = ctx.getImageData(0, y, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const m = Math.max(d[i], d[i + 1], d[i + 2]);
    d[i + 3] = m < 12 ? 0 : Math.min(255, m * 2);
  }
  ctx.putImageData(img, 0, y);
}

export function bakeAllAtlases(): {
  buildings_t0: string;
  buildings_t1: string;
  buildings_t2: string;
  emissive_t0: string;
  emissive_t1: string;
  emissive_t2: string;
  nature: string;
  manifest: Record<string, unknown>;
} {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(TIER_SPECS[0].cellW, TIER_SPECS[0].cellH);
  renderer.shadowMap.enabled = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = createSkyEnv(pmrem);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.95;

  const hemi = new THREE.HemisphereLight("#b5dcff", "#7fa664", 1.0);
  const sun = new THREE.DirectionalLight("#fff8eb", 2.05);
  sun.position.set(-14, 24, 18);
  const fill = new THREE.DirectionalLight("#cbe5ff", 0.38);
  fill.position.set(14, 10, -14);
  scene.add(hemi, sun, fill);

  const cam = new THREE.OrthographicCamera();
  const COLS = 16;
  const ROWS = ARCHETYPES.length;

  const tierTargets = TIER_SPECS.map((spec) => {
    const bCanvas = document.createElement("canvas");
    bCanvas.width = COLS * spec.cellW;
    bCanvas.height = ROWS * spec.cellH;
    const bCtx = bCanvas.getContext("2d")!;
    bCtx.imageSmoothingEnabled = true;
    bCtx.imageSmoothingQuality = "high";

    const eCanvas = document.createElement("canvas");
    eCanvas.width = COLS * EMISSIVE_CELL_W;
    eCanvas.height = ROWS * EMISSIVE_CELL_H;
    const eCtx = eCanvas.getContext("2d")!;
    eCtx.imageSmoothingEnabled = true;
    eCtx.imageSmoothingQuality = "high";

    return { spec, bCanvas, bCtx, eCanvas, eCtx };
  });

  const turfTex = getTurfTexture();
  const rootGroup = new THREE.Group();
  scene.add(rootGroup);

  // Cache materials & InstancedMesh handles across all 480 sprite renders
  const matCache = new Map<
    string,
    { mat: THREE.MeshStandardMaterial; uniforms: BuildingShaderUniforms | null; isBeacon: boolean }
  >();
  const meshCache = new Map<string, THREE.InstancedMesh>();

  const getCachedMat = (
    shaderMode: ShaderFacadeMode,
    slice: BuildingSliceKind,
    isTurf: boolean,
    isBeacon: boolean,
    beaconHex: string,
  ) => {
    const key = isTurf ? "turf" : isBeacon ? `beacon:${beaconHex}` : `${shaderMode}:${slice}`;
    let entry = matCache.get(key);
    if (!entry) {
      const mat = new THREE.MeshStandardMaterial({
        map: isTurf ? turfTex : null,
        color: "#ffffff",
        emissive: new THREE.Color(isBeacon ? beaconHex : "#000000"),
        emissiveIntensity: isBeacon ? 0.8 : 0,
        roughness: shaderMode === "glass" ? 0.22 : 0.78,
        metalness: shaderMode === "glass" ? 0.42 : 0.08,
      });
      const uniforms =
        !isTurf && !isBeacon ? applyBuildingFacadeShader(mat, shaderMode, slice) : null;
      entry = { mat, uniforms, isBeacon };
      matCache.set(key, entry);
    }
    return entry;
  };

  const getCachedMesh = (
    geomKey: string,
    shaderMode: ShaderFacadeMode,
    slice: BuildingSliceKind,
    isTurf: boolean,
    isBeacon: boolean,
    beaconHex: string,
  ) => {
    const key = `${geomKey}|${isTurf ? "turf" : isBeacon ? `beacon:${beaconHex}` : `${shaderMode}:${slice}`}`;
    let mesh = meshCache.get(key);
    if (!mesh) {
      const { mat } = getCachedMat(shaderMode, slice, isTurf, isBeacon, beaconHex);
      mesh = new THREE.InstancedMesh(getPartGeometry(geomKey), mat, 1);
      meshCache.set(key, mesh);
    }
    return mesh;
  };

  const dummy = new THREE.Object3D();
  const dummyColor = new THREE.Color();

  for (const { spec, bCtx, eCtx } of tierTargets) {
    renderer.setSize(spec.cellW, spec.cellH);
    const diamondWorldW = Math.SQRT2 * spec.worldScale;
    const halfW = diamondWorldW * (spec.cellW / spec.footprintPx) * 0.5;
    const halfH = halfW * (spec.cellH / spec.cellW);
    positionIsoCam(cam, halfW, halfH, spec.anchorY / spec.cellH);

    for (let ai = 0; ai < ARCHETYPES.length; ai++) {
      const arch = ARCHETYPES[ai];
      const variants = ARCHETYPE_VARIANT_KITS[arch];
      const hRatio = TIER_HEIGHT_RATIO[arch][spec.tier];

      for (let vi = 0; vi < 4; vi++) {
        const isRect = vi === 3;
        const variantIdx = vi % variants.length;
        const kit = variants[variantIdx];
        const pal = buildingPaletteForVariant(arch, variantIdx);
        const localW = isRect ? 1.34 * spec.worldScale : 1.0 * spec.worldScale;
        const localD = isRect ? 0.66 * spec.worldScale : 1.0 * spec.worldScale;
        const totalH = hRatio * spec.worldScale;
        const slices = computeSliceHeights(arch, totalH);

        for (let rot = 0; rot < 4; rot++) {
          rootGroup.clear();
          rootGroup.rotation.y = -rot * (Math.PI * 0.5);

          for (const part of kit) {
            const isTurf = part.role === "turf";
            const isBeacon = part.role === "beacon";
            const mesh = getCachedMesh(
              part.geomKey,
              part.shaderMode,
              part.slice,
              isTurf,
              isBeacon,
              part.tintHex ?? "#fde047",
            );

            let yBase = 0;
            let sliceH = totalH;
            if (part.slice === "base") {
              yBase = part.offset[1] * slices.baseH;
              sliceH = slices.baseH * part.scale[1];
            } else if (part.slice === "shaft") {
              yBase = slices.baseH + part.offset[1] * slices.shaftH;
              sliceH = slices.shaftH * part.scale[1];
            } else if (part.slice === "crown") {
              yBase = slices.baseH + slices.shaftH + part.offset[1] * slices.crownH;
              sliceH = slices.crownH * part.scale[1];
            } else {
              yBase = part.offset[1] * totalH;
              sliceH = totalH * part.scale[1];
            }

            const sx = (part.squareAspect ? Math.min(localW, localD) : localW) * part.scale[0];
            const sz = (part.squareAspect ? Math.min(localW, localD) : localD) * part.scale[2];
            dummy.position.set(part.offset[0] * localW, yBase, part.offset[2] * localD);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(Math.max(0.1, sx), Math.max(0.1, sliceH), Math.max(0.1, sz));
            dummy.updateMatrix();
            mesh.setMatrixAt(0, dummy.matrix);

            const colHex =
              part.role === "main" || part.role === "turf" ? pal.left : (part.tintHex ?? "#cbd5e1");
            mesh.setColorAt(0, dummyColor.set(colHex));
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            rootGroup.add(mesh);
          }

          const col = vi * 4 + rot;
          const dx = col * spec.cellW;
          const dy = ai * spec.cellH;

          // Beauty daylight pass
          scene.environment = envRT.texture;
          hemi.intensity = 1.0;
          sun.intensity = 2.05;
          fill.intensity = 0.38;
          for (const m of matCache.values()) {
            if (m.uniforms) m.uniforms.uEmissiveScale.value = 0.02;
            if (m.isBeacon) m.mat.emissiveIntensity = 0.7;
          }
          renderer.render(scene, cam);
          bCtx.drawImage(renderer.domElement, dx, dy, spec.cellW, spec.cellH);

          // Emissive night pass
          scene.environment = null;
          hemi.intensity = 0;
          sun.intensity = 0;
          fill.intensity = 0;
          for (const m of matCache.values()) {
            if (m.uniforms) m.uniforms.uEmissiveScale.value = 1.1;
            if (m.isBeacon) m.mat.emissiveIntensity = 1.8;
          }
          renderer.render(scene, cam);
          eCtx.drawImage(
            renderer.domElement,
            0,
            0,
            spec.cellW,
            spec.cellH,
            col * EMISSIVE_CELL_W,
            ai * EMISSIVE_CELL_H,
            EMISSIVE_CELL_W,
            EMISSIVE_CELL_H,
          );
        }
      }
    }

    for (let r = 0; r < ROWS; r++) {
      cleanEmissiveRowAlpha(eCtx, r * EMISSIVE_CELL_H, COLS * EMISSIVE_CELL_W, EMISSIVE_CELL_H);
    }
  }

  // Render Nature & Vehicle Sprites (8 cols x 2 rows at 96x128)
  rootGroup.clear();
  rootGroup.rotation.y = 0;
  scene.environment = envRT.texture;
  hemi.intensity = 1.0;
  sun.intensity = 2.05;
  fill.intensity = 0.38;

  renderer.setSize(NATURE_W, NATURE_H);
  const natHalfW = 1.85;
  const natHalfH = natHalfW * (NATURE_H / NATURE_W);
  const natureAnchorY = 135;
  positionIsoCam(cam, natHalfW, natHalfH, natureAnchorY / NATURE_H);

  const nCanvas = document.createElement("canvas");
  nCanvas.width = 8 * NATURE_W;
  nCanvas.height = 2 * NATURE_H;
  const nCtx = nCanvas.getContext("2d")!;

  const { trunk, canopy: broadCanopy } = createBroadleafTreeGeometries();
  const pineCanopy = createPineCanopyGeometry();
  const treeGreens = ["#4c8f43", "#599e4b", "#3d7a39", "#65a651"];

  const drawNatureCell = (col: number, row: number, objs: THREE.Object3D[]) => {
    rootGroup.clear();
    for (const o of objs) rootGroup.add(o);
    renderer.render(scene, cam);
    nCtx.drawImage(renderer.domElement, col * NATURE_W, row * NATURE_H, NATURE_W, NATURE_H);
  };

  for (let i = 0; i < 4; i++) {
    const tMesh = new THREE.Mesh(
      trunk,
      new THREE.MeshStandardMaterial({ color: "#6b4c35", roughness: 0.92 }),
    );
    const cMesh = new THREE.Mesh(
      broadCanopy,
      new THREE.MeshStandardMaterial({
        color: treeGreens[i],
        vertexColors: true,
        roughness: 0.85,
      }),
    );
    const grp = new THREE.Group();
    grp.add(tMesh, cMesh);
    grp.rotation.y = i * 1.1;
    grp.scale.setScalar(1.35);
    drawNatureCell(i, 0, [grp]);
  }
  for (let i = 0; i < 3; i++) {
    const tMesh = new THREE.Mesh(
      trunk,
      new THREE.MeshStandardMaterial({ color: "#5e432e", roughness: 0.92 }),
    );
    const cMesh = new THREE.Mesh(
      pineCanopy,
      new THREE.MeshStandardMaterial({
        color: i === 1 ? "#356d38" : "#407f40",
        vertexColors: true,
        roughness: 0.88,
      }),
    );
    const grp = new THREE.Group();
    grp.add(tMesh, cMesh);
    grp.rotation.y = i * 0.9;
    grp.scale.setScalar(1.3);
    drawNatureCell(4 + i, 0, [grp]);
  }
  const rockGrp = new THREE.Group();
  const rMat = new THREE.MeshStandardMaterial({ color: "#8d939c", roughness: 0.94 });
  const r1 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.65, 0), rMat);
  r1.scale.set(1.2, 0.72, 1.0);
  r1.position.set(0, 0.28, 0);
  const r2 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.45, 0), rMat);
  r2.position.set(0.48, 0.2, 0.25);
  rockGrp.add(r1, r2);
  drawNatureCell(7, 0, [rockGrp]);

  const carGeom = createVehicleGeometry();
  const carColors = ["#dc2626", "#2563eb", "#e2e8f0", "#f59e0b"];
  for (let i = 0; i < 4; i++) {
    const car = new THREE.Mesh(
      carGeom,
      new THREE.MeshStandardMaterial({
        color: carColors[i],
        vertexColors: true,
        roughness: 0.35,
        metalness: 0.2,
      }),
    );
    car.rotation.y = i * (Math.PI * 0.5);
    car.scale.set(1.05, 0.95, 1.55);
    drawNatureCell(i, 1, [car]);
  }
  const shipGeom = createCargoShipGeometry();
  for (let i = 0; i < 2; i++) {
    const ship = new THREE.Mesh(
      shipGeom,
      new THREE.MeshStandardMaterial({
        color: "#ffffff",
        vertexColors: true,
        roughness: 0.5,
        metalness: 0.15,
      }),
    );
    ship.rotation.y = i * (Math.PI * 0.5);
    ship.scale.setScalar(0.38);
    drawNatureCell(4 + i, 1, [ship]);
  }
  for (let i = 0; i < 2; i++) {
    const boat = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.32, 0.6),
      new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.4 }),
    );
    hull.position.y = 0.16;
    const sail = new THREE.Mesh(
      new THREE.ConeGeometry(0.6, 1.8, 3),
      new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.7 }),
    );
    sail.position.set(0.05, 1.15, 0);
    sail.scale.set(0.22, 1, 0.9);
    boat.add(hull, sail);
    boat.rotation.y = 0.5 + i * 1.4;
    drawNatureCell(6 + i, 1, [boat]);
  }

  envRT.dispose();
  pmrem.dispose();
  renderer.dispose();

  return {
    buildings_t0: tierTargets[0].bCanvas.toDataURL("image/webp", 0.91),
    buildings_t1: tierTargets[1].bCanvas.toDataURL("image/webp", 0.91),
    buildings_t2: tierTargets[2].bCanvas.toDataURL("image/webp", 0.91),
    emissive_t0: tierTargets[0].eCanvas.toDataURL("image/webp", 0.86),
    emissive_t1: tierTargets[1].eCanvas.toDataURL("image/webp", 0.86),
    emissive_t2: tierTargets[2].eCanvas.toDataURL("image/webp", 0.86),
    nature: nCanvas.toDataURL("image/webp", 0.9),
    manifest: {
      cols: COLS,
      rows: ROWS,
      tiers: TIER_SPECS,
      emissiveCellW: EMISSIVE_CELL_W,
      emissiveCellH: EMISSIVE_CELL_H,
      natureW: NATURE_W,
      natureH: NATURE_H,
      natureAnchorX: Math.round(NATURE_W * 0.5),
      natureAnchorY,
      archetypes: ARCHETYPES,
    },
  };
}

(window as unknown as { __CODECITY_BAKE__: typeof bakeAllAtlases }).__CODECITY_BAKE__ =
  bakeAllAtlases;
