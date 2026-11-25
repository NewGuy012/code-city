import * as THREE from "three";

import { buildingPaletteForVariant } from "../src/city/cityTheme";
import {
  ARCHETYPE_VARIANT_KITS,
  computePartTransform,
  computeSliceHeights,
  createBuildingPartMaterial,
  getPartGeometry,
} from "../src/city/geometries3D";
import type { BuildingShaderUniforms } from "../src/city/shaders3D";
import {
  ARCHETYPE_ORDER,
  ATLAS_TIERS,
  EMISSIVE_CELL_H,
  EMISSIVE_CELL_W,
  NATURE_ANCHOR_Y,
  NATURE_CELL_H,
  NATURE_CELL_W,
} from "../src/city/spriteAtlas2D";
import {
  createBroadleafTreeGeometries,
  createCargoShipGeometry,
  createPineCanopyGeometry,
  createSailboatGeometries,
  createSkyEnvironmentTarget,
  createVehicleGeometry,
} from "../src/city/terrain3D";
import { getTurfTexture } from "../src/city/textures3D";
import type { BuildingArchetype } from "../src/types/city";

const TIER_WORLD_SCALE = [5.0, 7.4, 10.6] as const;

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
  renderer.setSize(ATLAS_TIERS[0].cellW, ATLAS_TIERS[0].cellH);
  renderer.shadowMap.enabled = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = createSkyEnvironmentTarget(pmrem, "#5b9ee0", "#d0e6f7", "#6e9158");
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
  const ROWS = ARCHETYPE_ORDER.length;

  const tierTargets = ATLAS_TIERS.map((spec) => {
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

    return { spec, worldScale: TIER_WORLD_SCALE[spec.tier], bCanvas, bCtx, eCanvas, eCtx };
  });

  const turfTex = getTurfTexture();
  const rootGroup = new THREE.Group();
  scene.add(rootGroup);

  const matCache = new Map<
    string,
    {
      material: THREE.MeshStandardMaterial;
      uniforms: BuildingShaderUniforms | null;
      isBeacon: boolean;
    }
  >();
  const meshCache = new Map<string, THREE.InstancedMesh>();

  const getCachedMesh = (
    part: (typeof ARCHETYPE_VARIANT_KITS)[BuildingArchetype][number][number],
  ) => {
    const isTurf = part.role === "turf";
    const isBeacon = part.role === "beacon";
    const matKey = isTurf
      ? "turf"
      : isBeacon
        ? `beacon:${part.tintHex ?? "#fde047"}`
        : `${part.shaderMode}:${part.slice}`;
    let matEntry = matCache.get(matKey);
    if (!matEntry) {
      const created = createBuildingPartMaterial(part, {
        turfTex,
        beaconEmissive: 0.8,
        emissiveScale: 0.02,
        analytical: false,
      });
      matEntry = { ...created, isBeacon };
      matCache.set(matKey, matEntry);
    }
    const meshKey = `${part.geomKey}|${matKey}`;
    let mesh = meshCache.get(meshKey);
    if (!mesh) {
      mesh = new THREE.InstancedMesh(getPartGeometry(part.geomKey), matEntry.material, 1);
      meshCache.set(meshKey, mesh);
    }
    return mesh;
  };

  const dummy = new THREE.Object3D();
  const dummyColor = new THREE.Color();

  for (const { spec, worldScale, bCtx, eCtx } of tierTargets) {
    renderer.setSize(spec.cellW, spec.cellH);
    const diamondWorldW = Math.SQRT2 * worldScale;
    const halfW = diamondWorldW * (spec.cellW / spec.footprintPx) * 0.5;
    const halfH = halfW * (spec.cellH / spec.cellW);
    positionIsoCam(cam, halfW, halfH, spec.anchorY / spec.cellH);

    for (let ai = 0; ai < ARCHETYPE_ORDER.length; ai++) {
      const arch = ARCHETYPE_ORDER[ai];
      const variants = ARCHETYPE_VARIANT_KITS[arch];
      const hRatio = TIER_HEIGHT_RATIO[arch][spec.tier];

      for (let vi = 0; vi < 4; vi++) {
        const isRect = vi === 3;
        const variantIdx = vi % variants.length;
        const kit = variants[variantIdx];
        const pal = buildingPaletteForVariant(arch, variantIdx);
        const localW = (isRect ? 1.34 : 1.0) * worldScale;
        const localD = (isRect ? 0.66 : 1.0) * worldScale;
        const totalH = hRatio * worldScale;
        const slices = computeSliceHeights(arch, totalH);

        for (let rot = 0; rot < 4; rot++) {
          rootGroup.clear();
          rootGroup.rotation.y = -rot * (Math.PI * 0.5);

          for (const part of kit) {
            const mesh = getCachedMesh(part);
            const t = computePartTransform(part, localW, localD, slices, totalH);
            dummy.position.set(t.x, t.y, t.z);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(t.sx, t.sy, t.sz);
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

          scene.environment = envRT.texture;
          hemi.intensity = 1.0;
          sun.intensity = 2.05;
          fill.intensity = 0.38;
          for (const m of matCache.values()) {
            if (m.uniforms) m.uniforms.uEmissiveScale.value = 0.02;
            if (m.isBeacon) m.material.emissiveIntensity = 0.7;
          }
          renderer.render(scene, cam);
          bCtx.drawImage(renderer.domElement, dx, dy, spec.cellW, spec.cellH);

          scene.environment = null;
          hemi.intensity = 0;
          sun.intensity = 0;
          fill.intensity = 0;
          for (const m of matCache.values()) {
            if (m.uniforms) m.uniforms.uEmissiveScale.value = 1.1;
            if (m.isBeacon) m.material.emissiveIntensity = 1.8;
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

  rootGroup.clear();
  rootGroup.rotation.y = 0;
  scene.environment = envRT.texture;
  hemi.intensity = 1.0;
  sun.intensity = 2.05;
  fill.intensity = 0.38;

  renderer.setSize(NATURE_CELL_W, NATURE_CELL_H);
  const natHalfW = 1.85;
  const natHalfH = natHalfW * (NATURE_CELL_H / NATURE_CELL_W);
  positionIsoCam(cam, natHalfW, natHalfH, NATURE_ANCHOR_Y / NATURE_CELL_H);

  const nCanvas = document.createElement("canvas");
  nCanvas.width = 8 * NATURE_CELL_W;
  nCanvas.height = 2 * NATURE_CELL_H;
  const nCtx = nCanvas.getContext("2d")!;

  const { trunk, canopy: broadCanopy } = createBroadleafTreeGeometries();
  const pineCanopy = createPineCanopyGeometry();
  const treeGreens = ["#4c8f43", "#599e4b", "#3d7a39", "#65a651"];

  const drawNatureCell = (col: number, row: number, objs: THREE.Object3D[]) => {
    rootGroup.clear();
    for (const o of objs) rootGroup.add(o);
    renderer.render(scene, cam);
    nCtx.drawImage(
      renderer.domElement,
      col * NATURE_CELL_W,
      row * NATURE_CELL_H,
      NATURE_CELL_W,
      NATURE_CELL_H,
    );
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
  const boatGeoms = createSailboatGeometries();
  const boatHullMat = new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.4 });
  const boatSailMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.7 });
  for (let i = 0; i < 2; i++) {
    const boat = new THREE.Group();
    boat.add(
      new THREE.Mesh(boatGeoms.hull, boatHullMat),
      new THREE.Mesh(boatGeoms.sail, boatSailMat),
    );
    boat.rotation.y = 0.5 + i * 1.4;
    boat.scale.setScalar(0.7);
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
      tiers: ATLAS_TIERS.map((t) => ({ ...t, worldScale: TIER_WORLD_SCALE[t.tier] })),
      emissiveCellW: EMISSIVE_CELL_W,
      emissiveCellH: EMISSIVE_CELL_H,
      natureW: NATURE_CELL_W,
      natureH: NATURE_CELL_H,
      natureAnchorX: Math.round(NATURE_CELL_W * 0.5),
      natureAnchorY: NATURE_ANCHOR_Y,
      archetypes: ARCHETYPE_ORDER,
    },
  };
}

(window as unknown as { __CODECITY_BAKE__: typeof bakeAllAtlases }).__CODECITY_BAKE__ =
  bakeAllAtlases;
