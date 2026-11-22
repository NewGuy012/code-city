import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";

import type {
  BlastRadiusResult,
  CochangePair,
  DataMapMode,
  District,
  ExternalDep,
  FileMetric,
} from "../types/city";
import { BuildingTooltip } from "./BuildingTooltip";
import {
  type CameraProjection,
  type TimeOfDay,
  WORLD_CENTER_X,
  WORLD_CENTER_Z,
  cameraStore,
} from "./cameraStore";
import {
  ZONE_PALETTES,
  buildImpactedHopMap,
  canvasCursorClass,
  commuterCarColor,
  isAnalyticalDataMap,
  selectFaultLines,
  vehicleColor,
} from "./cityTheme";
import {
  type BuildingPartSpec,
  buildingColor3D,
  buildingFootprint3D,
  buildingHeight3D,
  computeSliceHeights,
  getArchetypeKitForFile,
  getPartGeometry,
  getSharedGeometrySet,
  lotOrientation,
} from "./geometries3D";
import type { SimVehicleRender } from "./isoRenderer2D";
import { type BuildingShaderUniforms, applyBuildingFacadeShader } from "./shaders3D";
import {
  type CoastalOceanHandle,
  computeNatureAndStreetPlacements,
  createBroadleafTreeGeometries,
  createCargoShipGeometry,
  createCoastalIslandMesh,
  createCoastalOcean,
  createDistantHeadlands,
  createPineCanopyGeometry,
  createVehicleGeometry,
} from "./terrain3D";
import {
  getAsphaltRoadTexture,
  getContactAoTexture,
  getMeadowGrassTexture,
  getSidewalkTexture,
  getTurfTexture,
} from "./textures3D";

interface CityCanvas3DProps {
  districts: District[];
  files: FileMetric[];
  cochanges: CochangePair[];
  deps?: ExternalDep[];
  dataMap: DataMapMode;
  selectedFile: string | null;
  blastRadius: BlastRadiusResult | null;
  activeTool?: string;
  vehicles?: SimVehicleRender[];
  fireFiles?: Set<string>;
  blackoutFiles?: Set<string>;
  plazas?: Array<{ x: number; z: number; w: number; d: number; kind: string }>;
  streetLines?: { xLines: number[]; zLines: number[] };
  onSelectFile: (filePath: string | null) => void;
  onToolAction?: (file: FileMetric) => void;
}

interface BatchEntry {
  file: FileMetric;
  part: BuildingPartSpec;
}

interface BuildingBatch {
  mesh: THREE.InstancedMesh;
  material: THREE.MeshStandardMaterial;
  uniforms: BuildingShaderUniforms | null;
  entries: BatchEntry[];
}

interface HighlightBox {
  group: THREE.Group;
  edges: THREE.LineSegments;
  pad: THREE.Mesh;
}

const BASE_ORBIT_DISTANCE = 92;
const MAX_VEHICLES = 120;
const MAX_FIRES = 64;
const UNIT_BOX_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);

function clearGroup(group: THREE.Group, keepGeometries?: Set<THREE.BufferGeometry>): void {
  const mats = new Set<THREE.Material>();
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    child.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        if (!keepGeometries?.has(obj.geometry)) obj.geometry.dispose();
        for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) mats.add(m);
      }
    });
  }
  for (const m of mats) m.dispose();
}

function makeHighlightBox(color: string, opacity: number): HighlightBox {
  const group = new THREE.Group();
  group.visible = false;
  const edges = new THREE.LineSegments(
    UNIT_BOX_EDGES,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
  const pad = new THREE.Mesh(
    UNIT_PLANE,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.24, depthWrite: false }),
  );
  pad.rotation.x = -Math.PI / 2;
  group.add(edges, pad);
  return { group, edges, pad };
}

function positionHighlightBox(box: HighlightBox, file: FileMetric | null): void {
  if (!file) {
    box.group.visible = false;
    return;
  }
  const { bw, bd, h, cx, cz } = buildingFootprint3D(file);
  box.edges.position.set(cx, h * 0.5 + 0.14, cz);
  box.edges.scale.set(bw + 0.36, h + 0.24, bd + 0.36);
  box.pad.position.set(cx, 0.2, cz);
  box.pad.scale.set(bw + 0.72, bd + 0.72, 1);
  box.group.visible = true;
}

function createSkyEnvironmentTarget(
  pmrem: THREE.PMREMGenerator,
  zenithHex: string,
  horizonHex: string,
  groundHex: string,
): THREE.WebGLRenderTarget {
  const envScene = new THREE.Scene();
  const domeGeom = new THREE.SphereGeometry(20, 16, 12);
  const pos = domeGeom.attributes.position as THREE.BufferAttribute;
  const cols = new Float32Array(pos.count * 3);
  const cZen = new THREE.Color(zenithHex);
  const cHor = new THREE.Color(horizonHex);
  const cGnd = new THREE.Color(groundHex);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const ny = pos.getY(i) / 20;
    if (ny >= 0) {
      c.copy(cHor).lerp(cZen, Math.pow(ny, 0.6));
    } else {
      c.copy(cHor).lerp(cGnd, Math.min(1, -ny * 1.8));
    }
    cols[i * 3] = c.r;
    cols[i * 3 + 1] = c.g;
    cols[i * 3 + 2] = c.b;
  }
  domeGeom.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  const domeMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  envScene.add(new THREE.Mesh(domeGeom, domeMat));
  const target = pmrem.fromScene(envScene, 0.04);
  domeGeom.dispose();
  domeMat.dispose();
  return target;
}

function createNightSkyDome(): THREE.Mesh {
  const geom = new THREE.SphereGeometry(420, 24, 16);
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const cols = new Float32Array(pos.count * 3);
  const cTop = new THREE.Color("#071022");
  const cMid = new THREE.Color("#132342");
  const cBot = new THREE.Color("#102038");
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const ny = pos.getY(i) / 420;
    if (ny >= 0) c.copy(cMid).lerp(cTop, Math.pow(ny, 0.65));
    else c.copy(cMid).lerp(cBot, Math.min(1, -ny * 2));
    cols[i * 3] = c.r;
    cols[i * 3 + 1] = c.g;
    cols[i * 3 + 2] = c.b;
  }
  geom.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  return new THREE.Mesh(geom, mat);
}

function sunVecFromAngles(elevDeg: number, azimDeg: number): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - elevDeg);
  const theta = THREE.MathUtils.degToRad(azimDeg);
  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
}

interface SceneHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  districtsGroup: THREE.Group;
  natureGroup: THREE.Group;
  docksGroup: THREE.Group;
  shipsGroup: THREE.Group;
  sailboatsGroup: THREE.Group;
  buildingsGroup: THREE.Group;
  faultsGroup: THREE.Group;
  vehiclesMesh: THREE.InstancedMesh;
  firesMesh: THREE.InstancedMesh;
  selectedBox: HighlightBox;
  hoveredBox: HighlightBox;
  batches: BuildingBatch[];
  sharedPartGeoms: Set<THREE.BufferGeometry>;
  streetlightMat: THREE.MeshStandardMaterial | null;
  applyAtmosphere: (tod: TimeOfDay) => void;
  updateBuildingColors: () => void;
}

export default function CityCanvas3D({
  districts,
  files,
  cochanges,
  deps = [],
  dataMap,
  selectedFile,
  blastRadius,
  activeTool = "inspect",
  vehicles = [],
  fireFiles,
  blackoutFiles,
  plazas = [],
  streetLines,
  onSelectFile,
  onToolAction,
}: CityCanvas3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<SceneHandle | null>(null);
  const [hoveredHit, setHoveredHit] = useState<{
    file: FileMetric;
    x: number;
    y: number;
  } | null>(null);

  const latestRef = useRef({
    files,
    dataMap,
    selectedFile,
    blastRadius,
    blackoutFiles,
    activeTool,
    onSelectFile,
    onToolAction,
  });
  latestRef.current = {
    files,
    dataMap,
    selectedFile,
    blastRadius,
    blackoutFiles,
    activeTool,
    onSelectFile,
    onToolAction,
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initW = Math.max(1, container.clientWidth);
    const initH = Math.max(1, container.clientHeight);
    const aspect = initW / initH;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(initW, initH);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const fog = new THREE.FogExp2("#c6dff2", 0.002);
    scene.background = new THREE.Color("#b4d5ee");
    scene.fog = fog;

    const sky = new Sky();
    sky.scale.setScalar(900);
    const nightDome = createNightSkyDome();
    nightDome.visible = false;
    scene.add(sky, nightDome);

    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    let envTarget: THREE.WebGLRenderTarget | null = null;
    let lastEnvTod: TimeOfDay | null = null;

    const perspCam = new THREE.PerspectiveCamera(42, aspect, 0.5, 1000);
    const orthoCam = new THREE.OrthographicCamera(-65 * aspect, 65 * aspect, 65, -65, -400, 1200);
    let activeProjection: CameraProjection = cameraStore.getState().projection;
    let activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera =
      activeProjection === "orthographic" ? orthoCam : perspCam;

    const hemi = new THREE.HemisphereLight("#a8d6ff", "#7fa866", 0.95);
    const sun = new THREE.DirectionalLight("#fff8eb", 2.05);
    sun.position.set(85, 115, 70);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -95;
    sun.shadow.camera.right = 95;
    sun.shadow.camera.top = 95;
    sun.shadow.camera.bottom = -95;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 320;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.025;
    const fillLight = new THREE.DirectionalLight("#cae4ff", 0.34);
    fillLight.position.set(-70, 50, -65);
    scene.add(hemi, sun, fillLight);

    const ocean: CoastalOceanHandle = createCoastalOcean();
    const islandMesh = createCoastalIslandMesh();
    const headlands = createDistantHeadlands();
    const harborQuay = new THREE.Mesh(
      new THREE.BoxGeometry(130, 1.8, 2.2),
      new THREE.MeshStandardMaterial({ color: "#8c939c", roughness: 0.9, metalness: 0.05 }),
    );
    harborQuay.position.set(0, -0.75, 53.0);
    harborQuay.receiveShadow = true;
    harborQuay.castShadow = true;
    scene.add(ocean.mesh, islandMesh, headlands, harborQuay);

    const districtsGroup = new THREE.Group();
    const natureGroup = new THREE.Group();
    const docksGroup = new THREE.Group();
    const shipsGroup = new THREE.Group();
    const sailboatsGroup = new THREE.Group();
    const buildingsGroup = new THREE.Group();
    const faultsGroup = new THREE.Group();
    const selectedBox = makeHighlightBox("#fef08a", 0.95);
    const hoveredBox = makeHighlightBox("#ffffff", 0.85);

    const vehicleGeom = createVehicleGeometry();
    const vehiclesMesh = new THREE.InstancedMesh(
      vehicleGeom,
      new THREE.MeshStandardMaterial({
        color: "#ffffff",
        vertexColors: true,
        roughness: 0.36,
        metalness: 0.18,
      }),
      MAX_VEHICLES,
    );
    vehiclesMesh.castShadow = true;
    vehiclesMesh.count = 0;

    const firesMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.1, 2.4, 8),
      new THREE.MeshStandardMaterial({
        color: "#f97316",
        emissive: "#fb923c",
        emissiveIntensity: 2.2,
      }),
      MAX_FIRES,
    );
    firesMesh.count = 0;

    scene.add(
      districtsGroup,
      natureGroup,
      docksGroup,
      shipsGroup,
      sailboatsGroup,
      buildingsGroup,
      faultsGroup,
      vehiclesMesh,
      firesMesh,
      selectedBox.group,
      hoveredBox.group,
    );

    const handle: SceneHandle = {
      renderer,
      scene,
      districtsGroup,
      natureGroup,
      docksGroup,
      shipsGroup,
      sailboatsGroup,
      buildingsGroup,
      faultsGroup,
      vehiclesMesh,
      firesMesh,
      selectedBox,
      hoveredBox,
      batches: [],
      sharedPartGeoms: getSharedGeometrySet(),
      streetlightMat: null,
      applyAtmosphere(tod: TimeOfDay) {
        const isNight = tod === "night";
        const isGolden = tod === "golden";

        sky.visible = !isNight;
        nightDome.visible = isNight;

        const sunDir = sunVecFromAngles(isGolden ? 8.5 : isNight ? 32 : 44, isGolden ? 112 : 138);
        if (!isNight) {
          const su = sky.material.uniforms;
          su.turbidity.value = isGolden ? 8.2 : 2.6;
          su.rayleigh.value = isGolden ? 2.6 : 1.15;
          su.mieCoefficient.value = isGolden ? 0.01 : 0.004;
          su.mieDirectionalG.value = isGolden ? 0.86 : 0.82;
          su.sunPosition.value.copy(sunDir).multiplyScalar(400);
          su.cloudCoverage.value = isGolden ? 0.46 : 0.4;
          su.cloudDensity.value = isGolden ? 0.54 : 0.46;
        }

        const fogCol = isGolden ? "#e9b692" : isNight ? "#122340" : "#c6dff2";
        fog.color.set(fogCol);
        fog.density = isGolden ? 0.0023 : isNight ? 0.0025 : 0.0019;
        (scene.background as THREE.Color).set(fogCol);

        sun.position.copy(sunDir).multiplyScalar(160);
        sun.intensity = isNight ? 0.92 : isGolden ? 2.3 : 2.05;
        sun.color.set(isGolden ? "#ffbd73" : isNight ? "#9cc3fa" : "#fff8eb");

        hemi.intensity = isNight ? 0.66 : isGolden ? 0.82 : 0.95;
        hemi.color.set(isGolden ? "#ffd2a6" : isNight ? "#4b6fa3" : "#a8d6ff");
        hemi.groundColor.set(isNight ? "#243440" : isGolden ? "#6f7d54" : "#7da362");

        fillLight.intensity = isNight ? 0.34 : isGolden ? 0.36 : 0.34;
        fillLight.color.set(isNight ? "#587ab0" : isGolden ? "#9cbbe3" : "#cae4ff");

        ocean.uniforms.uShallowColor.value.set(
          isGolden ? "#2c7c8f" : isNight ? "#184669" : "#30a8be",
        );
        ocean.uniforms.uDeepColor.value.set(isGolden ? "#154063" : isNight ? "#0d2945" : "#145582");
        ocean.uniforms.uSkyColor.value.set(isGolden ? "#f5b58a" : isNight ? "#243f66" : "#9bd1f5");
        ocean.uniforms.uSunColor.value.set(isGolden ? "#ffd08a" : isNight ? "#bfd8f8" : "#fff7dc");
        ocean.uniforms.uSunDir.value.copy(sunDir);
        ocean.uniforms.uFogColor.value.set(fogCol);
        ocean.uniforms.uFogDensity.value = fog.density;

        if (lastEnvTod !== tod) {
          lastEnvTod = tod;
          envTarget?.dispose();
          envTarget = createSkyEnvironmentTarget(
            pmrem,
            isGolden ? "#5c6d99" : isNight ? "#142647" : "#4f95d9",
            fogCol,
            isNight ? "#1e2e38" : "#6c8c54",
          );
          scene.environment = envTarget.texture;
          scene.environmentIntensity = isNight ? 0.52 : isGolden ? 0.85 : 0.95;
        }

        const emScale = isNight ? 0.95 : isGolden ? 0.58 : 0.03;
        for (const b of handle.batches) {
          if (b.uniforms) {
            b.uniforms.uEmissiveScale.value = emScale;
          }
          if (b.entries[0]?.part.role === "beacon") {
            b.material.emissiveIntensity = isNight ? 2.4 : isGolden ? 1.6 : 0.7;
          }
        }
        if (handle.streetlightMat) {
          handle.streetlightMat.emissiveIntensity = isNight ? 2.6 : isGolden ? 1.4 : 0.05;
        }
      },
      updateBuildingColors() {
        const cur = latestRef.current;
        const impactedHop = buildImpactedHopMap(cur.blastRadius);
        const analytical = isAnalyticalDataMap(cur.dataMap);
        const color = new THREE.Color();
        const blendCol = new THREE.Color();

        for (const batch of handle.batches) {
          if (batch.uniforms) {
            batch.uniforms.uDataMapMix.value = analytical ? 1.0 : 0.0;
          }
          batch.entries.forEach(({ file: f, part }, idx) => {
            if (cur.blackoutFiles?.has(f.file_path)) {
              color.set("#1e293b");
            } else if (part.role === "main" || part.role === "turf") {
              color.set(buildingColor3D(f, cur.dataMap, cur.selectedFile, impactedHop));
            } else if (analytical && part.role !== "beacon") {
              color.set(part.tintHex ?? "#cbd5e1");
              blendCol.set(buildingColor3D(f, cur.dataMap, cur.selectedFile, impactedHop));
              color.lerp(blendCol, 0.58);
            } else {
              color.set(part.tintHex ?? "#cbd5e1");
            }
            batch.mesh.setColorAt(idx, color);
          });
          if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
        }

        const selObj = cur.selectedFile
          ? (cur.files.find((f) => f.file_path === cur.selectedFile) ?? null)
          : null;
        positionHighlightBox(selectedBox, selObj);
      },
    };
    handleRef.current = handle;

    let syncingFromStore = false;
    let userInteracting = false;
    let viewportW = initW;
    let viewportH = initH;

    const controls = new OrbitControls(activeCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 16;
    controls.maxDistance = 280;
    controls.minPolarAngle = (5 * Math.PI) / 180;
    controls.maxPolarAngle = (78 * Math.PI) / 180;

    const applyCameraFromStore = (camState = cameraStore.getState()) => {
      if (camState.projection !== activeProjection) {
        activeProjection = camState.projection;
        activeCamera = activeProjection === "orthographic" ? orthoCam : perspCam;
        controls.object = activeCamera;
      }
      handle.applyAtmosphere(camState.timeOfDay);
      if (userInteracting) return;

      syncingFromStore = true;
      const tx = camState.targetX - WORLD_CENTER_X;
      const tz = camState.targetZ - WORLD_CENTER_Z;
      controls.target.set(tx, 0, tz);

      const pitchRad = (camState.pitch * Math.PI) / 180;
      const dist = BASE_ORBIT_DISTANCE / Math.max(0.35, camState.zoom);
      const horiz = dist * Math.cos(pitchRad);
      activeCamera.position.set(
        tx + horiz * Math.sin(camState.yaw),
        Math.max(1.8, dist * Math.sin(pitchRad)),
        tz + horiz * Math.cos(camState.yaw),
      );
      if (activeCamera instanceof THREE.OrthographicCamera) {
        const span = 65 / Math.max(0.35, camState.zoom);
        const asp = Math.max(0.5, viewportW / Math.max(1, viewportH));
        activeCamera.left = -span * asp;
        activeCamera.right = span * asp;
        activeCamera.top = span;
        activeCamera.bottom = -span;
        activeCamera.zoom = 1;
        activeCamera.updateProjectionMatrix();
      }
      controls.update();
      if (camState.roll !== 0) {
        activeCamera.rotateZ((camState.roll * Math.PI) / 180);
      }
      activeCamera.updateMatrixWorld();
      syncingFromStore = false;
    };

    const offsetVec = new THREE.Vector3();
    controls.addEventListener("start", () => {
      userInteracting = true;
      positionHighlightBox(hoveredBox, null);
      setHoveredHit(null);
      cameraStore.cancelTween();
      cameraStore.setState(
        { followVehicleId: null, cinematicOrbit: false },
        { cancelTween: false },
      );
    });
    controls.addEventListener("end", () => {
      userInteracting = false;
    });
    controls.addEventListener("change", () => {
      if (syncingFromStore || !userInteracting) return;
      offsetVec.subVectors(activeCamera.position, controls.target);
      const dist = Math.max(16, offsetVec.length());
      const horiz = Math.max(0.01, Math.hypot(offsetVec.x, offsetVec.z));
      cameraStore.setState(
        {
          targetX: controls.target.x + WORLD_CENTER_X,
          targetZ: controls.target.z + WORLD_CENTER_Z,
          yaw: Math.atan2(offsetVec.x, offsetVec.z),
          pitch: (Math.atan2(Math.max(1.8, offsetVec.y), horiz) * 180) / Math.PI,
          zoom: BASE_ORBIT_DISTANCE / dist,
        },
        { cancelTween: false },
      );
    });

    applyCameraFromStore();
    const unsubCam = cameraStore.subscribe(applyCameraFromStore);

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downPt: { x: number; y: number } | null = null;

    const pickBuilding = (clientX: number, clientY: number): FileMetric | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || handle.batches.length === 0) return null;
      ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, activeCamera);
      const hits = raycaster.intersectObjects(
        handle.batches.map((b) => b.mesh),
        false,
      );
      const hit = hits[0];
      if (!hit || hit.instanceId === undefined) return null;
      const batch = handle.batches.find((b) => b.mesh === hit.object);
      return batch?.entries[hit.instanceId]?.file ?? null;
    };

    const onPointerDown = (e: PointerEvent) => {
      downPt = { x: e.clientX, y: e.clientY };
    };
    const onPointerMove = (e: PointerEvent) => {
      if (userInteracting) return;
      const file = pickBuilding(e.clientX, e.clientY);
      if (file) {
        const rect = renderer.domElement.getBoundingClientRect();
        positionHighlightBox(
          hoveredBox,
          file.file_path !== latestRef.current.selectedFile ? file : null,
        );
        setHoveredHit({ file, x: e.clientX - rect.left, y: e.clientY - rect.top });
      } else {
        positionHighlightBox(hoveredBox, null);
        setHoveredHit(null);
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!downPt) return;
      const moved = Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y);
      downPt = null;
      if (moved > 5) return;
      const cur = latestRef.current;
      const file = pickBuilding(e.clientX, e.clientY);
      if (file) {
        if (cur.activeTool !== "inspect" && cur.onToolAction) cur.onToolAction(file);
        else cur.onSelectFile(file.file_path);
      } else {
        cur.onSelectFile(null);
      }
    };
    const onPointerLeave = () => {
      positionHighlightBox(hoveredBox, null);
      setHoveredHit(null);
    };

    const dom = renderer.domElement;
    dom.addEventListener("pointerdown", onPointerDown);
    dom.addEventListener("pointermove", onPointerMove);
    dom.addEventListener("pointerup", onPointerUp);
    dom.addEventListener("pointerleave", onPointerLeave);

    const onResize = () => {
      viewportW = Math.max(1, container.clientWidth);
      viewportH = Math.max(1, container.clientHeight);
      renderer.setSize(viewportW, viewportH);
      perspCam.aspect = viewportW / viewportH;
      perspCam.updateProjectionMatrix();
      applyCameraFromStore();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    let raf = 0;
    const clock = new THREE.Clock();
    const animate = () => {
      clock.getDelta();
      const t = clock.elapsedTime;
      ocean.uniforms.uTime.value = t;
      sky.material.uniforms.time.value = t;
      shipsGroup.children.forEach((child, idx) => {
        child.position.y = -0.25 + Math.sin(t * 1.4 + idx * 1.2) * 0.08;
        child.rotation.z = Math.sin(t * 1.0 + idx) * 0.025;
      });
      sailboatsGroup.children.forEach((child, idx) => {
        child.position.y = -0.25 + Math.sin(t * 1.8 + idx * 1.5) * 0.07;
        child.rotation.z = Math.sin(t * 1.3 + idx) * 0.04;
      });
      if (activeCamera.position.y < 1.8) activeCamera.position.y = 1.8;
      controls.update();
      const rollDeg = cameraStore.getState().roll;
      if (rollDeg !== 0) {
        activeCamera.rotateZ((rollDeg * Math.PI) / 180);
        activeCamera.updateMatrixWorld();
      }
      renderer.render(scene, activeCamera);
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(raf);
      unsubCam();
      ro.disconnect();
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("pointerleave", onPointerLeave);
      controls.dispose();
      clearGroup(districtsGroup);
      clearGroup(natureGroup);
      clearGroup(docksGroup);
      clearGroup(shipsGroup);
      clearGroup(sailboatsGroup);
      clearGroup(buildingsGroup, getSharedGeometrySet());
      clearGroup(faultsGroup);
      clearGroup(headlands);
      ocean.mesh.geometry.dispose();
      (ocean.mesh.material as THREE.Material).dispose();
      ocean.uniforms.uCoastTex.value.dispose();
      islandMesh.geometry.dispose();
      (islandMesh.material as THREE.Material).dispose();
      harborQuay.geometry.dispose();
      (harborQuay.material as THREE.Material).dispose();
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      nightDome.geometry.dispose();
      (nightDome.material as THREE.Material).dispose();
      envTarget?.dispose();
      pmrem.dispose();
      vehiclesMesh.geometry.dispose();
      (vehiclesMesh.material as THREE.Material).dispose();
      firesMesh.geometry.dispose();
      (firesMesh.material as THREE.Material).dispose();
      (selectedBox.edges.material as THREE.Material).dispose();
      (selectedBox.pad.material as THREE.Material).dispose();
      (hoveredBox.edges.material as THREE.Material).dispose();
      (hoveredBox.pad.material as THREE.Material).dispose();
      renderer.dispose();
      dom.remove();
      handleRef.current = null;
    };
  }, []);

  // Districts, concrete sidewalks, asphalt avenues, crosswalks, plazas, nature & streetlights
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    clearGroup(h.districtsGroup);
    clearGroup(h.natureGroup);
    clearGroup(h.sailboatsGroup);

    const analytical = isAnalyticalDataMap(dataMap);

    const addBox = (
      w: number,
      ht: number,
      d: number,
      x: number,
      y: number,
      z: number,
      mat: THREE.Material,
      rotY = 0,
    ) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, ht, d), mat);
      m.position.set(x, y, z);
      m.rotation.y = rotY;
      m.receiveShadow = true;
      h.districtsGroup.add(m);
    };

    const xLines = streetLines?.xLines ?? [];
    const zLines = streetLines?.zLines ?? [];
    if (xLines.length > 0 || zLines.length > 0) {
      const roadMat = new THREE.MeshStandardMaterial({
        map: getAsphaltRoadTexture(),
        color: "#ffffff",
        roughness: 0.88,
        metalness: 0.04,
      });
      const roadIntersectionMat = new THREE.MeshStandardMaterial({
        color: "#484f58",
        roughness: 0.9,
      });
      for (const xl of xLines) addBox(2.2, 0.03, 102, xl - WORLD_CENTER_X, 0.015, 0, roadMat);
      for (const zl of zLines) {
        addBox(2.2, 0.03, 138, 0, 0.018, zl - WORLD_CENTER_Z, roadMat, Math.PI * 0.5);
      }

      if (xLines.length > 0 && zLines.length > 0) {
        const ixCount = xLines.length * zLines.length;
        const ixPatch = new THREE.InstancedMesh(
          new THREE.BoxGeometry(2.3, 0.036, 2.3),
          roadIntersectionMat,
          ixCount,
        );
        ixPatch.receiveShadow = true;

        const stripeMesh = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.28, 0.008, 0.85),
          new THREE.MeshStandardMaterial({ color: "#e2e8f0", roughness: 0.75 }),
          ixCount * 6,
        );

        const dummy = new THREE.Object3D();
        let ixIdx = 0;
        let stIdx = 0;
        for (const xl of xLines) {
          for (const zl of zLines) {
            const wx = xl - WORLD_CENTER_X;
            const wz = zl - WORLD_CENTER_Z;
            dummy.position.set(wx, 0.02, wz);
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix();
            ixPatch.setMatrixAt(ixIdx++, dummy.matrix);
            for (const dx of [-0.65, 0, 0.65]) {
              dummy.position.set(wx + dx, 0.04, wz - 1.55);
              dummy.rotation.set(0, 0, 0);
              dummy.updateMatrix();
              stripeMesh.setMatrixAt(stIdx++, dummy.matrix);

              dummy.position.set(wx - 1.55, 0.04, wz + dx);
              dummy.rotation.set(0, Math.PI * 0.5, 0);
              dummy.updateMatrix();
              stripeMesh.setMatrixAt(stIdx++, dummy.matrix);
            }
          }
        }
        ixPatch.instanceMatrix.needsUpdate = true;
        stripeMesh.instanceMatrix.needsUpdate = true;
        h.districtsGroup.add(ixPatch, stripeMesh);
      }
    }

    if (districts.length > 0) {
      const walkMat = new THREE.MeshStandardMaterial({
        map: getSidewalkTexture(),
        color: "#d4dae0",
        roughness: 0.9,
      });
      const grassPlateMat = new THREE.MeshStandardMaterial({
        map: getMeadowGrassTexture(),
        color: "#ffffff",
        roughness: 0.92,
      });
      const pavedPlateMat = new THREE.MeshStandardMaterial({
        map: getSidewalkTexture(),
        color: "#cbd2da",
        roughness: 0.88,
      });
      const industrialPlateMat = new THREE.MeshStandardMaterial({
        map: getSidewalkTexture(),
        color: "#b4afa5",
        roughness: 0.94,
      });
      const clayPlateMat = new THREE.MeshStandardMaterial({
        color: "#d1d5db",
        roughness: 0.9,
      });

      for (const d of districts) {
        const cx = d.bounds_x + d.bounds_w * 0.5 - WORLD_CENTER_X;
        const cz = d.bounds_z + d.bounds_d * 0.5 - WORLD_CENTER_Z;
        addBox(d.bounds_w + 0.85, 0.08, d.bounds_d + 0.85, cx, 0.04, cz, walkMat);

        const plateMat = analytical
          ? clayPlateMat
          : d.zone_type === "downtown_core"
            ? pavedPlateMat
            : d.zone_type === "industrial_quarter" || d.zone_type === "supply_docks"
              ? industrialPlateMat
              : grassPlateMat;

        addBox(d.bounds_w, 0.06, d.bounds_d, cx, 0.09, cz, plateMat);
      }
    }

    for (const p of plazas) {
      const cx = p.x + p.w * 0.5 - WORLD_CENTER_X;
      const cz = p.z + p.d * 0.5 - WORLD_CENTER_Z;
      addBox(
        p.w,
        0.04,
        p.d,
        cx,
        0.13,
        cz,
        new THREE.MeshStandardMaterial({
          color:
            p.kind === "loading_bay" ? "#8c8478" : p.kind === "courtyard" ? "#5b934c" : "#cbd2db",
          roughness: 0.86,
        }),
      );
    }

    // Coastal forests, park trees, rocks, streetlights & bay sailboats
    const placements = computeNatureAndStreetPlacements(districts, files, plazas, streetLines);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    if (placements.trees.length > 0) {
      const { trunk, canopy: broadCanopy } = createBroadleafTreeGeometries();
      const pineCanopy = createPineCanopyGeometry();

      const trunkMesh = new THREE.InstancedMesh(
        trunk,
        new THREE.MeshStandardMaterial({ color: "#6b4c35", roughness: 0.95 }),
        placements.trees.length,
      );
      trunkMesh.castShadow = true;

      const broadTrees = placements.trees.filter((t) => !t.isPine);
      const pineTrees = placements.trees.filter((t) => t.isPine);

      const broadMesh = new THREE.InstancedMesh(
        broadCanopy,
        new THREE.MeshStandardMaterial({
          color: "#ffffff",
          vertexColors: true,
          roughness: 0.86,
        }),
        Math.max(1, broadTrees.length),
      );
      broadMesh.castShadow = true;
      broadMesh.receiveShadow = true;
      broadMesh.count = broadTrees.length;

      const pineMesh = new THREE.InstancedMesh(
        pineCanopy,
        new THREE.MeshStandardMaterial({
          color: "#ffffff",
          vertexColors: true,
          roughness: 0.88,
        }),
        Math.max(1, pineTrees.length),
      );
      pineMesh.castShadow = true;
      pineMesh.receiveShadow = true;
      pineMesh.count = pineTrees.length;

      placements.trees.forEach((tr, i) => {
        dummy.position.set(tr.x, tr.y, tr.z);
        dummy.rotation.set(0, tr.rotY, 0);
        dummy.scale.setScalar(tr.scale);
        dummy.updateMatrix();
        trunkMesh.setMatrixAt(i, dummy.matrix);
      });
      broadTrees.forEach((tr, i) => {
        dummy.position.set(tr.x, tr.y, tr.z);
        dummy.rotation.set(0, tr.rotY, 0);
        dummy.scale.setScalar(tr.scale);
        dummy.updateMatrix();
        broadMesh.setMatrixAt(i, dummy.matrix);
        broadMesh.setColorAt(i, color.set(tr.color));
      });
      pineTrees.forEach((tr, i) => {
        dummy.position.set(tr.x, tr.y, tr.z);
        dummy.rotation.set(0, tr.rotY, 0);
        dummy.scale.setScalar(tr.scale);
        dummy.updateMatrix();
        pineMesh.setMatrixAt(i, dummy.matrix);
        pineMesh.setColorAt(i, color.set(tr.color).multiplyScalar(0.86));
      });

      trunkMesh.instanceMatrix.needsUpdate = true;
      broadMesh.instanceMatrix.needsUpdate = true;
      if (broadMesh.instanceColor) broadMesh.instanceColor.needsUpdate = true;
      pineMesh.instanceMatrix.needsUpdate = true;
      if (pineMesh.instanceColor) pineMesh.instanceColor.needsUpdate = true;
      h.natureGroup.add(trunkMesh, broadMesh, pineMesh);
    }

    if (placements.rocks.length > 0) {
      const rockMesh = new THREE.InstancedMesh(
        new THREE.DodecahedronGeometry(0.85, 0),
        new THREE.MeshStandardMaterial({ color: "#878d96", roughness: 0.94 }),
        placements.rocks.length,
      );
      rockMesh.castShadow = true;
      rockMesh.receiveShadow = true;
      placements.rocks.forEach((r, i) => {
        dummy.position.set(r.x, r.y, r.z);
        dummy.rotation.set(0.2, r.rotY, 0.1);
        dummy.scale.set(r.scale[0], r.scale[1], r.scale[2]);
        dummy.updateMatrix();
        rockMesh.setMatrixAt(i, dummy.matrix);
      });
      rockMesh.instanceMatrix.needsUpdate = true;
      h.natureGroup.add(rockMesh);
    }

    if (placements.streetlights.length > 0) {
      const poleMesh = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.035, 0.05, 1.35, 6),
        new THREE.MeshStandardMaterial({ color: "#475569", roughness: 0.5, metalness: 0.6 }),
        placements.streetlights.length,
      );
      const tod = cameraStore.getState().timeOfDay;
      const lampMat = new THREE.MeshStandardMaterial({
        color: "#fef3c7",
        emissive: "#fde68a",
        emissiveIntensity: tod === "night" ? 2.6 : tod === "golden" ? 1.4 : 0.05,
      });
      h.streetlightMat = lampMat;
      const lampMesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.11, 6, 6),
        lampMat,
        placements.streetlights.length,
      );
      placements.streetlights.forEach((sl, i) => {
        dummy.position.set(sl.x, 0.68, sl.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        poleMesh.setMatrixAt(i, dummy.matrix);

        dummy.position.set(sl.x, 1.36, sl.z);
        dummy.updateMatrix();
        lampMesh.setMatrixAt(i, dummy.matrix);
      });
      poleMesh.instanceMatrix.needsUpdate = true;
      lampMesh.instanceMatrix.needsUpdate = true;
      h.natureGroup.add(poleMesh, lampMesh);
    } else {
      h.streetlightMat = null;
    }

    for (const sb of placements.sailboats) {
      const boat = new THREE.Group();
      const hull = new THREE.Mesh(
        new THREE.BoxGeometry(2.2, 0.45, 0.9),
        new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.4 }),
      );
      hull.position.y = 0.2;
      const sail = new THREE.Mesh(
        new THREE.ConeGeometry(0.85, 2.5, 3),
        new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.7 }),
      );
      sail.position.set(0.1, 1.55, 0);
      sail.scale.set(0.25, 1, 0.9);
      boat.add(hull, sail);
      boat.position.set(sb.x, -0.25, sb.z);
      boat.rotation.y = sb.rotY;
      boat.scale.setScalar(sb.scale);
      h.sailboatsGroup.add(boat);
    }

    // Also update ZONE_PALETTES reference so unused warning doesn't trip if tree-shaken
    void ZONE_PALETTES;
  }, [dataMap, districts, files, plazas, streetLines]);

  // Waterfront timber & stone piers and moored cargo ships
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    clearGroup(h.docksGroup);
    clearGroup(h.shipsGroup);
    const directDeps = deps.filter((d) => d.is_direct).slice(0, 8);
    const shipGeom = createCargoShipGeometry();
    const shipMat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      vertexColors: true,
      roughness: 0.5,
      metalness: 0.15,
    });
    const pierStoneMat = new THREE.MeshStandardMaterial({ color: "#949ca6", roughness: 0.9 });
    const pierDeckMat = new THREE.MeshStandardMaterial({ color: "#9b7653", roughness: 0.86 });
    const pierShedMat = new THREE.MeshStandardMaterial({ color: "#cbd5e1", roughness: 0.72 });
    const pierRoofMat = new THREE.MeshStandardMaterial({ color: "#b36247", roughness: 0.8 });
    const pilingMat = new THREE.MeshStandardMaterial({ color: "#57412b", roughness: 0.92 });

    directDeps.forEach((_, idx) => {
      const dx = 10 + idx * 16 + 5.5 - WORLD_CENTER_X;
      const apron = new THREE.Mesh(new THREE.BoxGeometry(10.2, 0.25, 2.2), pierStoneMat);
      apron.position.set(dx, 0.02, 54.4);
      apron.receiveShadow = true;

      const pier = new THREE.Mesh(new THREE.BoxGeometry(8.8, 0.28, 4.8), pierDeckMat);
      pier.position.set(dx, 0.04, 57.4);
      pier.castShadow = true;
      pier.receiveShadow = true;

      const shed = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.75, 1.8), pierShedMat);
      shed.position.set(dx - 2.4, 0.55, 56.4);
      shed.castShadow = true;
      const shedRoof = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.14, 2.0), pierRoofMat);
      shedRoof.position.set(dx - 2.4, 0.98, 56.4);

      h.docksGroup.add(apron, pier, shed, shedRoof);

      for (const px of [-3.9, 0, 3.9]) {
        const piling = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 1.3, 6), pilingMat);
        piling.position.set(dx + px, -0.35, 59.6);
        h.docksGroup.add(piling);
      }

      const ship = new THREE.Mesh(shipGeom, shipMat);
      ship.position.set(dx, -0.25, 62.5);
      ship.castShadow = true;
      h.shipsGroup.add(ship);
    });
  }, [deps]);

  // Instanced multi-part architectural buildings with world-space + interior-mapping shaders
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    clearGroup(h.buildingsGroup, h.sharedPartGeoms);
    h.batches = [];

    const grouped = new Map<string, { template: BuildingPartSpec; entries: BatchEntry[] }>();

    for (const f of files) {
      const { parts } = getArchetypeKitForFile(f);
      for (const part of parts) {
        const key = `${part.geomKey}|${part.shaderMode}|${part.slice}|${part.role}`;
        let group = grouped.get(key);
        if (!group) {
          group = { template: part, entries: [] };
          grouped.set(key, group);
        }
        group.entries.push({ file: f, part });
      }
    }

    const dummy = new THREE.Object3D();
    const tod = cameraStore.getState().timeOfDay;
    const emScale = tod === "night" ? 0.95 : tod === "golden" ? 0.58 : 0.03;
    const analytical = isAnalyticalDataMap(latestRef.current.dataMap);
    const aoTex = getContactAoTexture();
    const turfTex = getTurfTexture();

    // Soft ground contact-AO pads under every building footprint
    if (aoTex && files.length > 0) {
      const aoMesh = new THREE.InstancedMesh(
        UNIT_PLANE,
        new THREE.MeshBasicMaterial({
          map: aoTex,
          transparent: true,
          opacity: 0.72,
          depthWrite: false,
        }),
        files.length,
      );
      files.forEach((f, idx) => {
        const fp = buildingFootprint3D(f);
        dummy.position.set(fp.cx, 0.145, fp.cz);
        dummy.rotation.set(-Math.PI * 0.5, 0, 0);
        dummy.scale.set(fp.bw + 0.85, fp.bd + 0.85, 1);
        dummy.updateMatrix();
        aoMesh.setMatrixAt(idx, dummy.matrix);
      });
      aoMesh.instanceMatrix.needsUpdate = true;
      h.buildingsGroup.add(aoMesh);
    }

    for (const { template, entries } of grouped.values()) {
      const isTurf = template.role === "turf";
      const isBeacon = template.role === "beacon";

      const material = new THREE.MeshStandardMaterial({
        map: isTurf ? turfTex : null,
        color: "#ffffff",
        emissive: new THREE.Color(isBeacon ? (template.tintHex ?? "#fde047") : "#000000"),
        emissiveIntensity: isBeacon ? (tod === "night" ? 2.4 : tod === "golden" ? 1.6 : 0.7) : 0,
        roughness: template.shaderMode === "glass" ? 0.22 : 0.78,
        metalness: template.shaderMode === "glass" ? 0.42 : 0.08,
      });

      let uniforms: BuildingShaderUniforms | null = null;
      if (!isTurf && !isBeacon) {
        uniforms = applyBuildingFacadeShader(material, template.shaderMode, template.slice);
        uniforms.uEmissiveScale.value = emScale;
        uniforms.uDataMapMix.value = analytical ? 1.0 : 0.0;
      }

      const geom = getPartGeometry(template.geomKey);
      const mesh = new THREE.InstancedMesh(geom, material, entries.length);
      mesh.castShadow = !isTurf;
      mesh.receiveShadow = true;

      entries.forEach(({ file: f, part }, idx) => {
        const fp = buildingFootprint3D(f);
        const { rotY, localW, localD } = lotOrientation(f, fp.bw, fp.bd);
        const slices = computeSliceHeights(f.building_archetype, fp.h);

        let yBase = 0.12;
        let sliceH = fp.h;
        if (part.slice === "base") {
          yBase = 0.12 + part.offset[1] * slices.baseH;
          sliceH = slices.baseH * part.scale[1];
        } else if (part.slice === "shaft") {
          yBase = 0.12 + slices.baseH + part.offset[1] * slices.shaftH;
          sliceH = slices.shaftH * part.scale[1];
        } else if (part.slice === "crown") {
          yBase = 0.12 + slices.baseH + slices.shaftH + part.offset[1] * slices.crownH;
          sliceH = slices.crownH * part.scale[1];
        } else {
          yBase = 0.12 + part.offset[1] * fp.h;
          sliceH = fp.h * part.scale[1];
        }

        const sx = (part.squareAspect ? Math.min(localW, localD) : localW) * part.scale[0];
        const sz = (part.squareAspect ? Math.min(localW, localD) : localD) * part.scale[2];

        const cosR = Math.cos(rotY);
        const sinR = Math.sin(rotY);
        const oxLocal = part.offset[0] * localW;
        const ozLocal = part.offset[2] * localD;
        const oxWorld = oxLocal * cosR + ozLocal * sinR;
        const ozWorld = -oxLocal * sinR + ozLocal * cosR;

        dummy.position.set(fp.cx + oxWorld, yBase, fp.cz + ozWorld);
        dummy.rotation.set(0, rotY, 0);
        dummy.scale.set(Math.max(0.1, sx), Math.max(0.1, sliceH), Math.max(0.1, sz));
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);
      });

      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.computeBoundingBox();

      h.buildingsGroup.add(mesh);
      h.batches.push({ mesh, material, uniforms, entries });
    }
    h.sharedPartGeoms = getSharedGeometrySet();
    h.updateBuildingColors();
  }, [files]);

  // Building tint & selection highlight updates (no geometry rebuild)
  useEffect(() => {
    handleRef.current?.updateBuildingColors();
  }, [blackoutFiles, blastRadius, dataMap, files, selectedFile]);

  // Live simulation vehicles & fire markers
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    const vCount = Math.min(MAX_VEHICLES, vehicles.length);
    h.vehiclesMesh.count = vCount;
    for (let i = 0; i < vCount; i++) {
      const v = vehicles[i];
      const isShip = v.type === "cargo_ship";
      dummy.position.set(v.x - WORLD_CENTER_X, isShip ? -0.15 : 0.14, v.z - WORLD_CENTER_Z);
      dummy.rotation.set(0, -v.heading, 0);
      dummy.scale.set(isShip ? 2.4 : 0.8, isShip ? 0.85 : 0.58, isShip ? 1.25 : 1.35);
      dummy.updateMatrix();
      h.vehiclesMesh.setMatrixAt(i, dummy.matrix);
      const colHex =
        v.type === "request_car" && !v.jammed
          ? commuterCarColor(v.id)
          : vehicleColor(v.type, v.jammed);
      h.vehiclesMesh.setColorAt(i, color.set(colHex));
    }
    h.vehiclesMesh.instanceMatrix.needsUpdate = true;
    if (h.vehiclesMesh.instanceColor) h.vehiclesMesh.instanceColor.needsUpdate = true;

    let fCount = 0;
    if (fireFiles && fireFiles.size > 0) {
      const byPath = new Map(files.map((f) => [f.file_path, f]));
      for (const fp of fireFiles) {
        if (fCount >= MAX_FIRES) break;
        const f = byPath.get(fp);
        if (!f) continue;
        dummy.position.set(
          f.layout_x + f.layout_w * 0.5 - WORLD_CENTER_X,
          buildingHeight3D(f) + 1.0,
          f.layout_z + f.layout_d * 0.5 - WORLD_CENTER_Z,
        );
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        h.firesMesh.setMatrixAt(fCount++, dummy.matrix);
      }
    }
    h.firesMesh.count = fCount;
    h.firesMesh.instanceMatrix.needsUpdate = true;
  }, [files, fireFiles, vehicles]);

  // Dashed co-change fault arcs (only when building selected or blast radius active)
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    clearGroup(h.faultsGroup);
    const pairs = selectFaultLines(cochanges, selectedFile, blastRadius);
    if (pairs.length === 0) return;

    const byPath = new Map(files.map((f) => [f.file_path, f]));
    for (const p of pairs) {
      const fa = byPath.get(p.file_a);
      const fb = byPath.get(p.file_b);
      if (!fa || !fb) continue;
      const ax = fa.layout_x + fa.layout_w * 0.5 - WORLD_CENTER_X;
      const az = fa.layout_z + fa.layout_d * 0.5 - WORLD_CENTER_Z;
      const ay = buildingHeight3D(fa) + 0.5;
      const bx = fb.layout_x + fb.layout_w * 0.5 - WORLD_CENTER_X;
      const bz = fb.layout_z + fb.layout_d * 0.5 - WORLD_CENTER_Z;
      const by = buildingHeight3D(fb) + 0.5;
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(ax, ay, az),
        new THREE.Vector3((ax + bx) * 0.5, Math.max(ay, by) + 10, (az + bz) * 0.5),
        new THREE.Vector3(bx, by, bz),
      );
      const geom = new THREE.BufferGeometry().setFromPoints(curve.getPoints(16));
      const mat = new THREE.LineDashedMaterial({ color: "#d946ef", dashSize: 2, gapSize: 1 });
      const line = new THREE.Line(geom, mat);
      line.computeLineDistances();
      h.faultsGroup.add(line);
    }
  }, [blastRadius, cochanges, files, selectedFile]);

  return (
    <div
      ref={containerRef}
      data-testid="city-canvas-3d"
      className={`relative h-full w-full overflow-hidden bg-sky-950 ${canvasCursorClass(activeTool, Boolean(hoveredHit))}`}
    >
      {hoveredHit && (
        <BuildingTooltip
          file={hoveredHit.file}
          x={hoveredHit.x}
          y={hoveredHit.y}
          containerWidth={containerRef.current?.clientWidth}
          containerHeight={containerRef.current?.clientHeight}
        />
      )}
    </div>
  );
}
