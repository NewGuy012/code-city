import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type {
  BlastRadiusResult,
  BuildingArchetype,
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
  buildImpactedHopMap,
  canvasCursorClass,
  selectFaultLines,
  vehicleColor,
} from "./cityTheme";
import {
  ARCHETYPE_KITS,
  type ArchetypePartSpec,
  buildingColor3D,
  buildingFootprint3D,
  buildingHeight3D,
  getSharedPartGeometry,
} from "./geometries3D";
import type { SimVehicleRender } from "./isoRenderer2D";
import {
  getAsphaltRoadTexture,
  getFacadeTextureSet,
  getTurfTexture,
  getWaterRippleTexture,
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

interface BuildingBatch {
  mesh: THREE.InstancedMesh;
  material: THREE.MeshStandardMaterial;
  part: ArchetypePartSpec;
  files: FileMetric[];
  hasFacade: boolean;
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
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }),
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
  box.edges.position.set(cx, h * 0.5 + 0.12, cz);
  box.edges.scale.set(bw + 0.36, h + 0.24, bd + 0.36);
  box.pad.position.set(cx, 0.18, cz);
  box.pad.scale.set(bw + 0.72, bd + 0.72, 1);
  box.group.visible = true;
}

function facadeEmissive(part: ArchetypePartSpec, hasFacade: boolean, tod: TimeOfDay): number {
  if (part.role === "beacon") return 1.8;
  if (!hasFacade) return 0;
  return tod === "night" ? 1.15 : tod === "golden" ? 0.55 : 0.08;
}

interface SceneHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  districtsGroup: THREE.Group;
  docksGroup: THREE.Group;
  shipsGroup: THREE.Group;
  buildingsGroup: THREE.Group;
  faultsGroup: THREE.Group;
  vehiclesMesh: THREE.InstancedMesh;
  firesMesh: THREE.InstancedMesh;
  selectedBox: HighlightBox;
  hoveredBox: HighlightBox;
  batches: BuildingBatch[];
  sharedPartGeoms: Set<THREE.BufferGeometry>;
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
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const fog = new THREE.Fog("#071121", 145, 360);
    scene.background = new THREE.Color("#071121");
    scene.fog = fog;

    const perspCam = new THREE.PerspectiveCamera(42, aspect, 0.5, 1000);
    const orthoCam = new THREE.OrthographicCamera(-65 * aspect, 65 * aspect, 65, -65, -400, 1200);
    let activeProjection: CameraProjection = cameraStore.getState().projection;
    let activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera =
      activeProjection === "orthographic" ? orthoCam : perspCam;

    const hemi = new THREE.HemisphereLight("#bae6fd", "#0f172a", 0.75);
    const sun = new THREE.DirectionalLight("#ffffff", 1.45);
    sun.position.set(80, 120, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -90;
    sun.shadow.camera.right = 90;
    sun.shadow.camera.top = 90;
    sun.shadow.camera.bottom = -90;
    const fillLight = new THREE.DirectionalLight("#38bdf8", 0.42);
    fillLight.position.set(-65, 45, -65);
    scene.add(hemi, sun, fillLight);

    const waterBump = getWaterRippleTexture();
    const waterMat = new THREE.MeshStandardMaterial({
      color: "#09213c",
      bumpMap: waterBump,
      bumpScale: 0.22,
      roughness: 0.2,
      metalness: 0.62,
    });
    const waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(460, 460), waterMat);
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.y = -0.55;
    waterMesh.receiveShadow = true;

    const seawall = new THREE.Mesh(
      new THREE.BoxGeometry(146, 0.55, 110),
      new THREE.MeshStandardMaterial({ color: "#334155", roughness: 0.88 }),
    );
    seawall.position.y = -0.35;
    seawall.receiveShadow = true;

    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(142, 0.22, 106),
      new THREE.MeshStandardMaterial({ color: "#0f172a", roughness: 0.85 }),
    );
    deck.position.y = -0.1;
    deck.receiveShadow = true;
    scene.add(waterMesh, seawall, deck);

    const districtsGroup = new THREE.Group();
    const docksGroup = new THREE.Group();
    const shipsGroup = new THREE.Group();
    const buildingsGroup = new THREE.Group();
    const faultsGroup = new THREE.Group();
    const selectedBox = makeHighlightBox("#fef08a", 0.95);
    const hoveredBox = makeHighlightBox("#ffffff", 0.8);

    const vehiclesMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.35 }),
      MAX_VEHICLES,
    );
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
      docksGroup,
      shipsGroup,
      buildingsGroup,
      faultsGroup,
      vehiclesMesh,
      firesMesh,
      selectedBox.group,
      hoveredBox.group,
    );

    const sharedPartGeoms = new Set<THREE.BufferGeometry>([
      getSharedPartGeometry("box"),
      getSharedPartGeometry("cylinder"),
      getSharedPartGeometry("cone4"),
      getSharedPartGeometry("sphere"),
      getSharedPartGeometry("arch_shed"),
      getSharedPartGeometry("taper_stack"),
    ]);

    const handle: SceneHandle = {
      renderer,
      scene,
      districtsGroup,
      docksGroup,
      shipsGroup,
      buildingsGroup,
      faultsGroup,
      vehiclesMesh,
      firesMesh,
      selectedBox,
      hoveredBox,
      batches: [],
      sharedPartGeoms,
      applyAtmosphere(tod: TimeOfDay) {
        const sky = tod === "golden" ? "#1b1433" : tod === "night" ? "#030712" : "#071121";
        (scene.background as THREE.Color).set(sky);
        fog.color.set(sky);
        hemi.intensity = tod === "night" ? 0.38 : 0.75;
        hemi.color.set(tod === "golden" ? "#fdba74" : tod === "night" ? "#38bdf8" : "#bae6fd");
        sun.intensity = tod === "night" ? 0.48 : tod === "golden" ? 1.65 : 1.45;
        sun.color.set(tod === "golden" ? "#fbbf24" : "#ffffff");
        if (tod === "golden") sun.position.set(115, 42, 72);
        else sun.position.set(80, 120, 60);
        waterMat.color.set(tod === "golden" ? "#102845" : tod === "night" ? "#041122" : "#09213c");
        for (const b of handle.batches) {
          b.material.emissiveIntensity = facadeEmissive(b.part, b.hasFacade, tod);
        }
      },
      updateBuildingColors() {
        const cur = latestRef.current;
        const impactedHop = buildImpactedHopMap(cur.blastRadius);
        const color = new THREE.Color();
        for (const batch of handle.batches) {
          batch.files.forEach((f, idx) => {
            if (cur.blackoutFiles?.has(f.file_path)) {
              color.set("#1e293b");
            } else if (batch.part.role === "main" || batch.part.role === "turf") {
              color.set(buildingColor3D(f, cur.dataMap, cur.selectedFile, impactedHop));
            } else {
              color.set(batch.part.tintHex ?? "#cbd5e1");
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
      return batch?.files[hit.instanceId] ?? null;
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
      const delta = clock.getDelta();
      const t = clock.elapsedTime;
      if (waterBump) {
        waterBump.offset.x = (waterBump.offset.x + delta * 0.025) % 1;
        waterBump.offset.y = (waterBump.offset.y + delta * 0.018) % 1;
      }
      shipsGroup.children.forEach((child, idx) => {
        child.position.y = -0.08 + Math.sin(t * 1.5 + idx * 1.2) * 0.14;
        child.rotation.z = Math.sin(t * 1.1 + idx) * 0.03;
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
      clearGroup(docksGroup);
      clearGroup(shipsGroup);
      clearGroup(buildingsGroup, sharedPartGeoms);
      clearGroup(faultsGroup);
      waterMesh.geometry.dispose();
      waterMat.dispose();
      seawall.geometry.dispose();
      (seawall.material as THREE.Material).dispose();
      deck.geometry.dispose();
      (deck.material as THREE.Material).dispose();
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

  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    clearGroup(h.districtsGroup);

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
        color: "#1e293b",
        roughness: 0.9,
      });
      for (const xl of xLines) addBox(2.2, 0.04, 102, xl - WORLD_CENTER_X, 0.02, 0, roadMat);
      for (const zl of zLines) {
        addBox(2.2, 0.04, 138, 0, 0.02, zl - WORLD_CENTER_Z, roadMat, Math.PI * 0.5);
      }
    }
    if (districts.length > 0) {
      const walkMat = new THREE.MeshStandardMaterial({ color: "#475569", roughness: 0.92 });
      const plateMat = new THREE.MeshStandardMaterial({ color: "#1e293b", roughness: 0.88 });
      for (const d of districts) {
        const cx = d.bounds_x + d.bounds_w * 0.5 - WORLD_CENTER_X;
        const cz = d.bounds_z + d.bounds_d * 0.5 - WORLD_CENTER_Z;
        addBox(d.bounds_w + 0.8, 0.1, d.bounds_d + 0.8, cx, 0.05, cz, walkMat);
        addBox(d.bounds_w, 0.08, d.bounds_d, cx, 0.11, cz, plateMat);
      }
    }
    for (const p of plazas) {
      const cx = p.x + p.w * 0.5 - WORLD_CENTER_X;
      const cz = p.z + p.d * 0.5 - WORLD_CENTER_Z;
      addBox(
        p.w,
        0.06,
        p.d,
        cx,
        0.18,
        cz,
        new THREE.MeshStandardMaterial({
          color: p.kind === "loading_bay" ? "#57534e" : "#273549",
          roughness: 0.85,
        }),
      );
      if (p.kind !== "loading_bay") {
        const tree = new THREE.Mesh(
          new THREE.SphereGeometry(0.55, 8, 8),
          new THREE.MeshStandardMaterial({ color: "#22c55e", roughness: 0.8 }),
        );
        tree.position.set(cx, 0.83, cz);
        tree.castShadow = true;
        h.districtsGroup.add(tree);
      }
    }
  }, [districts, plazas, streetLines]);

  // Waterfront supply docks & moored cargo ships
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    clearGroup(h.docksGroup);
    clearGroup(h.shipsGroup);
    const directDeps = deps.filter((d) => d.is_direct).slice(0, 8);
    directDeps.forEach((_, idx) => {
      const dx = 10 + idx * 16 + 5.5 - WORLD_CENTER_X;
      const pier = new THREE.Mesh(
        new THREE.BoxGeometry(10.5, 0.45, 5.2),
        new THREE.MeshStandardMaterial({ color: "#92400e", roughness: 0.85 }),
      );
      pier.position.set(dx, 0.15, 109.5 - WORLD_CENTER_Z);
      pier.castShadow = true;
      pier.receiveShadow = true;
      h.docksGroup.add(pier);

      const ship = new THREE.Mesh(
        new THREE.BoxGeometry(6.4, 0.9, 2.3),
        new THREE.MeshStandardMaterial({ color: "#0284c7", roughness: 0.45, metalness: 0.25 }),
      );
      ship.position.set(dx, 0, 114.5 - WORLD_CENTER_Z);
      ship.castShadow = true;
      h.shipsGroup.add(ship);
    });
  }, [deps]);

  // Instanced multi-part archetype buildings
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    clearGroup(h.buildingsGroup, h.sharedPartGeoms);
    h.batches = [];

    const byArchetype = new Map<BuildingArchetype, FileMetric[]>();
    for (const f of files) {
      const arr = byArchetype.get(f.building_archetype) ?? [];
      arr.push(f);
      byArchetype.set(f.building_archetype, arr);
    }

    const dummy = new THREE.Object3D();
    const tod = cameraStore.getState().timeOfDay;

    for (const [arch, groupFiles] of byArchetype) {
      const kit = ARCHETYPE_KITS[arch] ?? ARCHETYPE_KITS.office_tower;
      for (const part of kit) {
        const facade = part.facadeStyle ? getFacadeTextureSet(part.facadeStyle) : null;
        const turf = part.role === "turf" ? getTurfTexture() : null;
        const material = new THREE.MeshStandardMaterial({
          map: facade?.map ?? turf ?? null,
          roughnessMap: facade?.roughnessMap ?? null,
          bumpMap: facade?.bumpMap ?? null,
          bumpScale: facade ? 0.08 : 0,
          emissiveMap: facade?.emissiveMap ?? null,
          emissive: new THREE.Color(
            part.role === "beacon" ? (part.tintHex ?? "#fde047") : facade ? "#fef3c7" : "#000000",
          ),
          emissiveIntensity: facadeEmissive(part, Boolean(facade), tod),
          roughness: part.facadeStyle === "glass" ? 0.25 : 0.65,
          metalness: part.facadeStyle === "glass" ? 0.45 : part.role === "trim" ? 0.35 : 0.12,
        });
        const mesh = new THREE.InstancedMesh(
          getSharedPartGeometry(part.geom),
          material,
          groupFiles.length,
        );
        mesh.castShadow = part.role !== "turf";
        mesh.receiveShadow = true;

        groupFiles.forEach((f, idx) => {
          const fp = buildingFootprint3D(f);
          dummy.position.set(
            fp.cx + part.offset[0] * fp.bw,
            part.offset[1] * fp.h,
            fp.cz + part.offset[2] * fp.bd,
          );
          dummy.rotation.set(0, part.rotY ?? 0, 0);
          dummy.scale.set(
            fp.bw * part.scale[0],
            part.fixedY ?? fp.h * part.scale[1],
            fp.bd * part.scale[2],
          );
          dummy.updateMatrix();
          mesh.setMatrixAt(idx, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        // Recompute bounds after scattering instances so Three.js raycasting & culling stay accurate
        mesh.computeBoundingSphere();
        mesh.computeBoundingBox();

        h.buildingsGroup.add(mesh);
        h.batches.push({ mesh, material, part, files: groupFiles, hasFacade: Boolean(facade) });
      }
    }
    h.updateBuildingColors();
  }, [files]);

  // Building tint & selection highlight updates (no geometry rebuild)
  useEffect(() => {
    handleRef.current?.updateBuildingColors();
  }, [blackoutFiles, blastRadius, dataMap, files, selectedFile]);

  // Live simulation vehicles & fire markers (instanced, zero per-tick allocations)
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
      dummy.position.set(v.x - WORLD_CENTER_X, isShip ? 0.1 : 0.35, v.z - WORLD_CENTER_Z);
      dummy.rotation.set(0, -v.heading, 0);
      dummy.scale.set(isShip ? 2.8 : 0.85, isShip ? 0.7 : 0.45, isShip ? 1.3 : 1.35);
      dummy.updateMatrix();
      h.vehiclesMesh.setMatrixAt(i, dummy.matrix);
      h.vehiclesMesh.setColorAt(i, color.set(vehicleColor(v.type, v.jammed)));
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
          buildingHeight3D(f) + 0.9,
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

  // Dashed seismic co-change fault arcs
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
      className={`relative h-full w-full overflow-hidden bg-slate-950 ${canvasCursorClass(activeTool, Boolean(hoveredHit))}`}
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
