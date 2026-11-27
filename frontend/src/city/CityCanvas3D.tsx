import { memo, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { CitySimulationEngine } from "../game/simEngine";
import type {
  BlastRadiusResult,
  CochangePair,
  DataMapMode,
  District,
  ExternalDep,
  FileMetric,
  ZoneType,
} from "../types/city";
import { BuildingTooltip } from "./BuildingTooltip";
import {
  type CameraProjection,
  type CanvasDragMode,
  type TimeOfDay,
  WORLD_CENTER_X,
  WORLD_CENTER_Z,
  cameraStore,
  computeMousePitch,
  computeMouseYaw,
  computeRelativePanTarget,
  isSpaceKeyHeld,
  resolveCanvasDragMode,
  resolveCursorIntent,
  useModifierKeysHeld,
} from "./cameraStore";
import {
  ZONE_PALETTES,
  buildImpactedHopMap,
  canvasCursorClass,
  isAmbientVehicle,
  isAnalyticalDataMap,
  resolveVehicleColor,
  selectFaultLines,
} from "./cityTheme";
import {
  type BuildingBlockPart,
  buildingColor3D,
  buildingFootprint3D,
  buildingHeight3D,
  computeBlockPartTransform,
  getBlockPartsForFile,
  getPrimitiveGeometry,
  isSharedPrimitive,
  lotOrientation,
} from "./geometries3D";

interface CityCanvas3DProps {
  districts: District[];
  files: FileMetric[];
  cochanges: CochangePair[];
  deps?: ExternalDep[];
  dataMap: DataMapMode;
  selectedFile: string | null;
  blastRadius: BlastRadiusResult | null;
  activeTool?: string;
  showTraffic?: boolean;
  sim: CitySimulationEngine;
  plazas?: Array<{ x: number; z: number; w: number; d: number; kind: string }>;
  streetLines?: { xLines: number[]; zLines: number[] };
  onSelectFile: (filePath: string | null) => void;
  onToolAction?: (file: FileMetric) => void;
}

interface BatchEntry {
  file: FileMetric;
  part: BuildingBlockPart;
}

interface BuildingBatch {
  mesh: THREE.InstancedMesh;
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

function clearGroup(
  group: THREE.Group,
  keepPredicate?: (geom: THREE.BufferGeometry) => boolean,
): void {
  const geoms = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    child.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        if (!keepPredicate?.(obj.geometry)) geoms.add(obj.geometry);
        for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) mats.add(m);
      }
    });
  }
  for (const g of geoms) g.dispose();
  for (const m of mats) m.dispose();
}

function makeHighlightBox(
  color: string,
  opacity: number,
  boxEdges: THREE.EdgesGeometry,
  unitPlane: THREE.PlaneGeometry,
): HighlightBox {
  const group = new THREE.Group();
  group.visible = false;
  const edges = new THREE.LineSegments(
    boxEdges,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
  const pad = new THREE.Mesh(
    unitPlane,
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

function districtPlateColor(zone: ZoneType, analytical: boolean): string {
  if (analytical) return "#d1d5db";
  if (zone === "downtown_core") return "#cbd2da";
  if (zone === "industrial_quarter" || zone === "supply_docks") return "#b4afa5";
  return ZONE_PALETTES[zone]?.ground ?? "#629450";
}

interface SceneHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  districtsGroup: THREE.Group;
  docksGroup: THREE.Group;
  buildingsGroup: THREE.Group;
  faultsGroup: THREE.Group;
  vehiclesMesh: THREE.InstancedMesh;
  firesMesh: THREE.InstancedMesh;
  selectedBox: HighlightBox;
  hoveredBox: HighlightBox;
  unitPlane: THREE.PlaneGeometry;
  batches: BuildingBatch[];
  districtPlates: { mesh: THREE.InstancedMesh; zones: ZoneType[] } | null;
  applyAtmosphere: (tod: TimeOfDay) => void;
  updateBuildingColors: () => void;
  updateDynamicActors: () => void;
  requestRender: () => void;
}

const CityCanvas3D = memo(function CityCanvas3D({
  districts,
  files,
  cochanges,
  deps = [],
  dataMap,
  selectedFile,
  blastRadius,
  activeTool = "inspect",
  showTraffic = false,
  sim,
  plazas = [],
  streetLines,
  onSelectFile,
  onToolAction,
}: CityCanvas3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<SceneHandle | null>(null);
  const mods = useModifierKeysHeld();
  const [activeDragMode, setActiveDragMode] = useState<CanvasDragMode | null>(null);
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
    showTraffic,
    sim,
    activeTool,
    onSelectFile,
    onToolAction,
  });
  latestRef.current = {
    files,
    dataMap,
    selectedFile,
    blastRadius,
    showTraffic,
    sim,
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
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);

    const renderer = new THREE.WebGLRenderer({
      antialias: (window.devicePixelRatio || 1) <= 1.5,
      powerPreference: "default",
    });
    renderer.setPixelRatio(dpr);
    renderer.setSize(initW, initH);
    renderer.shadowMap.enabled = false;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const fog = new THREE.Fog("#b4d5ee", 140, 360);
    scene.background = new THREE.Color("#b4d5ee");
    scene.fog = fog;

    const perspCam = new THREE.PerspectiveCamera(42, aspect, 0.5, 600);
    const orthoCam = new THREE.OrthographicCamera(-65 * aspect, 65 * aspect, 65, -65, -400, 900);
    let activeProjection: CameraProjection = cameraStore.getState().projection;
    let activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera =
      activeProjection === "orthographic" ? orthoCam : perspCam;

    const hemi = new THREE.HemisphereLight("#c2e2ff", "#6e8f58", 0.95);
    const sun = new THREE.DirectionalLight("#fff8eb", 1.55);
    sun.position.set(85, 115, 70);
    scene.add(hemi, sun);

    const oceanMat = new THREE.MeshBasicMaterial({ color: "#195a87" });
    const oceanMesh = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), oceanMat);
    oceanMesh.rotation.x = -Math.PI * 0.5;
    oceanMesh.position.y = -0.5;

    const sandMat = new THREE.MeshLambertMaterial({ color: "#dfd1a9" });
    const sandMesh = new THREE.Mesh(new THREE.BoxGeometry(151, 0.36, 115), sandMat);
    sandMesh.position.set(0, -0.32, 0);

    const plateauMat = new THREE.MeshLambertMaterial({ color: "#629a4f" });
    const plateauMesh = new THREE.Mesh(new THREE.BoxGeometry(144, 0.28, 108), plateauMat);
    plateauMesh.position.set(0, -0.06, 0);

    const quayMat = new THREE.MeshLambertMaterial({ color: "#8c939c" });
    const harborQuay = new THREE.Mesh(new THREE.BoxGeometry(130, 1.4, 2.2), quayMat);
    harborQuay.position.set(0, -0.65, 53.0);

    scene.add(oceanMesh, sandMesh, plateauMesh, harborQuay);

    const districtsGroup = new THREE.Group();
    const docksGroup = new THREE.Group();
    const buildingsGroup = new THREE.Group();
    const faultsGroup = new THREE.Group();

    const tmpBox = new THREE.BoxGeometry(1, 1, 1);
    const unitBoxEdges = new THREE.EdgesGeometry(tmpBox);
    tmpBox.dispose();
    const unitPlane = new THREE.PlaneGeometry(1, 1);
    const selectedBox = makeHighlightBox("#fef08a", 0.95, unitBoxEdges, unitPlane);
    const hoveredBox = makeHighlightBox("#ffffff", 0.85, unitBoxEdges, unitPlane);

    const vehicleGeom = new THREE.BoxGeometry(0.85, 0.58, 1.3);
    vehicleGeom.translate(0, 0.29, 0);
    const vehiclesMesh = new THREE.InstancedMesh(
      vehicleGeom,
      new THREE.MeshLambertMaterial({ color: "#ffffff" }),
      MAX_VEHICLES,
    );
    vehiclesMesh.count = 0;
    vehiclesMesh.frustumCulled = false;

    const fireGeom = new THREE.ConeGeometry(0.95, 2.2, 6);
    const firesMesh = new THREE.InstancedMesh(
      fireGeom,
      new THREE.MeshBasicMaterial({ color: "#f97316" }),
      MAX_FIRES,
    );
    firesMesh.count = 0;
    firesMesh.frustumCulled = false;

    scene.add(
      districtsGroup,
      docksGroup,
      buildingsGroup,
      faultsGroup,
      vehiclesMesh,
      firesMesh,
      selectedBox.group,
      hoveredBox.group,
    );

    let raf = 0;
    let lastAtmosphereTod: TimeOfDay | null = null;
    let lastAppliedBlackouts: ReadonlySet<string> | undefined;
    const actorDummy = new THREE.Object3D();
    const actorColor = new THREE.Color();
    let cachedActorFiles: FileMetric[] | null = null;
    let cachedActorFileMap = new Map<string, FileMetric>();

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
    controls.screenSpacePanning = false;
    controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    let activeDrag: {
      mode: "pan" | "orbit" | "yaw";
      pointerId: number;
      startX: number;
      startY: number;
      origTargetX: number;
      origTargetZ: number;
      origYaw: number;
      origPitch: number;
      moved: boolean;
    } | null = null;

    const renderFrame = () => {
      raf = 0;
      if (typeof document !== "undefined" && document.hidden) return;
      const moved = !activeDrag && controls.update();
      if (activeCamera.position.y < 1.8) activeCamera.position.y = 1.8;
      renderer.render(scene, activeCamera);
      if (moved) {
        requestRender();
      }
    };

    const requestRender = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (raf === 0) {
        raf = requestAnimationFrame(renderFrame);
      }
    };

    const handle: SceneHandle = {
      renderer,
      scene,
      districtsGroup,
      docksGroup,
      buildingsGroup,
      faultsGroup,
      vehiclesMesh,
      firesMesh,
      selectedBox,
      hoveredBox,
      unitPlane,
      batches: [],
      districtPlates: null,
      requestRender,
      applyAtmosphere(tod: TimeOfDay) {
        if (lastAtmosphereTod === tod) return;
        lastAtmosphereTod = tod;
        const isNight = tod === "night";
        const isGolden = tod === "golden";

        const bgHex = isGolden ? "#e2b28b" : isNight ? "#0d1b33" : "#b4d5ee";
        (scene.background as THREE.Color).set(bgHex);
        fog.color.set(bgHex);

        oceanMat.color.set(isGolden ? "#28506e" : isNight ? "#09172b" : "#195a87");
        sandMat.color.set(isNight ? "#46453a" : isGolden ? "#c9b389" : "#dfd1a9");
        plateauMat.color.set(isNight ? "#244430" : isGolden ? "#618647" : "#629a4f");

        sun.position.set(isGolden ? 120 : 85, isGolden ? 34 : 115, isGolden ? 60 : 70);
        sun.intensity = isNight ? 0.65 : isGolden ? 1.7 : 1.55;
        sun.color.set(isGolden ? "#ffbd73" : isNight ? "#8ab4f8" : "#fff8eb");

        hemi.intensity = isNight ? 0.58 : isGolden ? 0.85 : 0.95;
        hemi.color.set(isGolden ? "#ffd2a6" : isNight ? "#4b6fa3" : "#c2e2ff");
        hemi.groundColor.set(isNight ? "#1e2e3a" : isGolden ? "#6f7d54" : "#6e8f58");
      },
      updateBuildingColors() {
        const cur = latestRef.current;
        const simBlackouts = cur.sim.getRenderFrame().blackoutFiles;
        lastAppliedBlackouts = simBlackouts;
        const impactedHop = buildImpactedHopMap(cur.blastRadius);
        const analytical = isAnalyticalDataMap(cur.dataMap);
        const color = new THREE.Color();
        const blendCol = new THREE.Color();

        for (const batch of handle.batches) {
          batch.entries.forEach(({ file: f, part }, idx) => {
            if (simBlackouts.has(f.file_path)) {
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
        requestRender();
      },
      updateDynamicActors() {
        const cur = latestRef.current;
        const frame = cur.sim.getRenderFrame();
        if (frame.blackoutFiles !== lastAppliedBlackouts) {
          handle.updateBuildingColors();
        }

        let vCount = 0;
        for (let i = 0; i < frame.vehicles.length && vCount < MAX_VEHICLES; i++) {
          const v = frame.vehicles[i];
          if (!cur.showTraffic && isAmbientVehicle(v.type)) {
            continue;
          }
          const isShip = v.type === "cargo_ship";
          actorDummy.position.set(
            v.x - WORLD_CENTER_X,
            isShip ? -0.15 : 0.14,
            v.z - WORLD_CENTER_Z,
          );
          actorDummy.rotation.set(0, -v.heading, 0);
          actorDummy.scale.set(isShip ? 2.4 : 0.85, isShip ? 0.85 : 0.6, isShip ? 1.3 : 1.0);
          actorDummy.updateMatrix();
          vehiclesMesh.setMatrixAt(vCount, actorDummy.matrix);
          vehiclesMesh.setColorAt(vCount, actorColor.set(resolveVehicleColor(v)));
          vCount++;
        }
        vehiclesMesh.count = vCount;
        vehiclesMesh.instanceMatrix.needsUpdate = true;
        if (vehiclesMesh.instanceColor) vehiclesMesh.instanceColor.needsUpdate = true;

        let fCount = 0;
        if (frame.fireFiles.size > 0) {
          if (cachedActorFiles !== cur.files) {
            cachedActorFiles = cur.files;
            cachedActorFileMap = new Map(cur.files.map((f) => [f.file_path, f]));
          }
          for (const fp of frame.fireFiles) {
            if (fCount >= MAX_FIRES) break;
            const f = cachedActorFileMap.get(fp);
            if (!f) continue;
            actorDummy.position.set(
              f.layout_x + f.layout_w * 0.5 - WORLD_CENTER_X,
              buildingHeight3D(f) + 1.0,
              f.layout_z + f.layout_d * 0.5 - WORLD_CENTER_Z,
            );
            actorDummy.rotation.set(0, 0, 0);
            actorDummy.scale.set(1, 1, 1);
            actorDummy.updateMatrix();
            firesMesh.setMatrixAt(fCount++, actorDummy.matrix);
          }
        }
        firesMesh.count = fCount;
        firesMesh.instanceMatrix.needsUpdate = true;
        requestRender();
      },
    };
    handleRef.current = handle;

    const applyCameraFromStore = (camState = cameraStore.getState()) => {
      if (camState.projection !== activeProjection) {
        activeProjection = camState.projection;
        activeCamera = activeProjection === "orthographic" ? orthoCam : perspCam;
        controls.object = activeCamera;
      }
      handle.applyAtmosphere(camState.timeOfDay);
      if (userInteracting) {
        requestRender();
        return;
      }

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
      const prevDamping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = prevDamping;
      activeCamera.updateMatrixWorld();
      syncingFromStore = false;
      requestRender();
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
      requestRender();
    });
    controls.addEventListener("end", () => {
      userInteracting = false;
      requestRender();
    });
    controls.addEventListener("change", () => {
      if (syncingFromStore) return;
      requestRender();
      if (!userInteracting) return;
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
    let hoverPending: { x: number; y: number } | null = null;
    let hoverRaf = 0;

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

    const dom = renderer.domElement;

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        downPt = { x: e.clientX, y: e.clientY };
        return;
      }
      const mode = resolveCanvasDragMode({
        button: e.button,
        spaceHeld: isSpaceKeyHeld(),
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
      });
      if (mode === "pan" || mode === "orbit" || mode === "yaw") {
        e.preventDefault();
        e.stopImmediatePropagation();
        controls.enabled = false;
        const st = cameraStore.getState();
        activeDrag = {
          mode,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          origTargetX: st.targetX,
          origTargetZ: st.targetZ,
          origYaw: st.yaw,
          origPitch: st.pitch,
          moved: false,
        };
        setActiveDragMode(mode);
        downPt = null;
        positionHighlightBox(hoveredBox, null);
        setHoveredHit(null);
        cameraStore.setState({ followVehicleId: null, cinematicOrbit: false });
        dom.setPointerCapture(e.pointerId);
        return;
      }
      downPt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (activeDrag) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const dx = e.clientX - activeDrag.startX;
        const dy = e.clientY - activeDrag.startY;
        if (!activeDrag.moved && Math.abs(dx) <= 4 && Math.abs(dy) <= 4) {
          return;
        }
        activeDrag.moved = true;
        if (activeDrag.mode === "yaw") {
          cameraStore.setState({
            yaw: computeMouseYaw(activeDrag.origYaw, dx, viewportH),
            cinematicOrbit: false,
          });
        } else if (activeDrag.mode === "orbit") {
          cameraStore.setState({
            yaw: computeMouseYaw(activeDrag.origYaw, dx, viewportH),
            pitch: computeMousePitch(activeDrag.origPitch, dy, viewportH),
            cinematicOrbit: false,
          });
        } else {
          const st = cameraStore.getState();
          const pitchRad = (st.pitch * Math.PI) / 180;
          const worldSpanY =
            activeCamera instanceof THREE.OrthographicCamera
              ? 130 / Math.max(0.35, st.zoom)
              : 2 *
                (BASE_ORBIT_DISTANCE / Math.max(0.35, st.zoom)) *
                Math.tan((perspCam.fov * 0.5 * Math.PI) / 180);
          const worldPerPx = worldSpanY / Math.max(1, viewportH);
          const nextTarget = computeRelativePanTarget(
            activeDrag.origTargetX,
            activeDrag.origTargetZ,
            st.yaw,
            -dx * worldPerPx,
            (dy * worldPerPx) / Math.max(0.35, Math.sin(pitchRad)),
          );
          cameraStore.setState({
            ...nextTarget,
            followVehicleId: null,
            cinematicOrbit: false,
          });
        }
        return;
      }
      if (userInteracting) return;
      if (e.altKey || e.ctrlKey || isSpaceKeyHeld()) {
        if (hoveredBox.group.visible) {
          positionHighlightBox(hoveredBox, null);
          requestRender();
        }
        setHoveredHit((prev) => (prev === null ? prev : null));
        return;
      }

      hoverPending = { x: e.clientX, y: e.clientY };
      if (hoverRaf === 0) {
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0;
          const pt = hoverPending;
          if (!pt || userInteracting || activeDrag || isSpaceKeyHeld()) return;
          const file = pickBuilding(pt.x, pt.y);
          if (file) {
            const rect = dom.getBoundingClientRect();
            const showTarget = file.file_path !== latestRef.current.selectedFile ? file : null;
            positionHighlightBox(hoveredBox, showTarget);
            const nx = pt.x - rect.left;
            const ny = pt.y - rect.top;
            setHoveredHit((prev) =>
              prev && prev.file === file && Math.abs(prev.x - nx) < 2 && Math.abs(prev.y - ny) < 2
                ? prev
                : { file, x: nx, y: ny },
            );
            requestRender();
          } else {
            if (hoveredBox.group.visible) {
              positionHighlightBox(hoveredBox, null);
              requestRender();
            }
            setHoveredHit((prev) => (prev === null ? prev : null));
          }
        });
      }
    };

    const endActiveDrag = (e: PointerEvent): boolean => {
      if (!activeDrag || e.pointerId !== activeDrag.pointerId) return false;
      activeDrag = null;
      controls.enabled = true;
      setActiveDragMode(null);
      downPt = null;
      if (dom.hasPointerCapture(e.pointerId)) {
        dom.releasePointerCapture(e.pointerId);
      }
      e.stopImmediatePropagation();
      return true;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (endActiveDrag(e)) return;
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

    const onPointerCancel = (e: PointerEvent) => {
      endActiveDrag(e);
    };

    const onPointerLeave = () => {
      hoverPending = null;
      if (hoveredBox.group.visible) {
        positionHighlightBox(hoveredBox, null);
        requestRender();
      }
      setHoveredHit(null);
    };

    dom.addEventListener("pointerdown", onPointerDown, true);
    dom.addEventListener("pointermove", onPointerMove, true);
    dom.addEventListener("pointerup", onPointerUp, true);
    dom.addEventListener("pointercancel", onPointerCancel, true);
    dom.addEventListener("pointerleave", onPointerLeave);

    const onResize = () => {
      viewportW = Math.max(1, container.clientWidth);
      viewportH = Math.max(1, container.clientHeight);
      renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
      renderer.setSize(viewportW, viewportH);
      perspCam.aspect = viewportW / viewportH;
      perspCam.updateProjectionMatrix();
      applyCameraFromStore();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    const onVisibility = () => {
      if (!document.hidden) requestRender();
    };
    document.addEventListener("visibilitychange", onVisibility);

    requestRender();

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      if (hoverRaf !== 0) cancelAnimationFrame(hoverRaf);
      unsubCam();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      dom.removeEventListener("pointerdown", onPointerDown, true);
      dom.removeEventListener("pointermove", onPointerMove, true);
      dom.removeEventListener("pointerup", onPointerUp, true);
      dom.removeEventListener("pointercancel", onPointerCancel, true);
      dom.removeEventListener("pointerleave", onPointerLeave);
      controls.dispose();
      clearGroup(districtsGroup);
      clearGroup(docksGroup);
      clearGroup(buildingsGroup, (g) => g === unitPlane || isSharedPrimitive(g));
      clearGroup(faultsGroup);
      oceanMesh.geometry.dispose();
      oceanMat.dispose();
      sandMesh.geometry.dispose();
      sandMat.dispose();
      plateauMesh.geometry.dispose();
      plateauMat.dispose();
      harborQuay.geometry.dispose();
      quayMat.dispose();
      vehiclesMesh.geometry.dispose();
      (vehiclesMesh.material as THREE.Material).dispose();
      firesMesh.geometry.dispose();
      (firesMesh.material as THREE.Material).dispose();
      unitBoxEdges.dispose();
      unitPlane.dispose();
      (selectedBox.edges.material as THREE.Material).dispose();
      (selectedBox.pad.material as THREE.Material).dispose();
      (hoveredBox.edges.material as THREE.Material).dispose();
      (hoveredBox.pad.material as THREE.Material).dispose();
      renderer.dispose();
      dom.remove();
      handleRef.current = null;
    };
  }, []);

  // Instanced streets, district plates, sidewalks, and plazas
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    clearGroup(h.districtsGroup);
    h.districtPlates = null;

    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    const xLines = streetLines?.xLines ?? [];
    const zLines = streetLines?.zLines ?? [];
    const roadCount = xLines.length + zLines.length + xLines.length * zLines.length;
    if (roadCount > 0) {
      const roadMesh = new THREE.InstancedMesh(
        unitBox,
        new THREE.MeshLambertMaterial({ color: "#495059" }),
        roadCount,
      );
      let rIdx = 0;
      for (const xl of xLines) {
        dummy.position.set(xl - WORLD_CENTER_X, 0.095, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(2.2, 0.03, 102);
        dummy.updateMatrix();
        roadMesh.setMatrixAt(rIdx++, dummy.matrix);
      }
      for (const zl of zLines) {
        dummy.position.set(0, 0.098, zl - WORLD_CENTER_Z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(138, 0.03, 2.2);
        dummy.updateMatrix();
        roadMesh.setMatrixAt(rIdx++, dummy.matrix);
      }
      for (const xl of xLines) {
        for (const zl of zLines) {
          dummy.position.set(xl - WORLD_CENTER_X, 0.101, zl - WORLD_CENTER_Z);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(2.3, 0.034, 2.3);
          dummy.updateMatrix();
          roadMesh.setMatrixAt(rIdx++, dummy.matrix);
        }
      }
      roadMesh.instanceMatrix.needsUpdate = true;
      roadMesh.computeBoundingSphere();
      h.districtsGroup.add(roadMesh);
    }

    const totalPadCount = districts.length * 2 + plazas.length;
    if (totalPadCount > 0) {
      const padsMesh = new THREE.InstancedMesh(
        unitBox,
        new THREE.MeshLambertMaterial({ color: "#ffffff" }),
        totalPadCount,
      );
      const analytical = isAnalyticalDataMap(latestRef.current.dataMap);
      const zones: ZoneType[] = [];
      let pIdx = 0;

      for (const d of districts) {
        const cx = d.bounds_x + d.bounds_w * 0.5 - WORLD_CENTER_X;
        const cz = d.bounds_z + d.bounds_d * 0.5 - WORLD_CENTER_Z;

        dummy.position.set(cx, 0.11, cz);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(d.bounds_w + 0.85, 0.06, d.bounds_d + 0.85);
        dummy.updateMatrix();
        padsMesh.setMatrixAt(pIdx, dummy.matrix);
        padsMesh.setColorAt(pIdx++, color.set("#cfd5dd"));

        dummy.position.set(cx, 0.15, cz);
        dummy.scale.set(d.bounds_w, 0.06, d.bounds_d);
        dummy.updateMatrix();
        padsMesh.setMatrixAt(pIdx, dummy.matrix);
        padsMesh.setColorAt(pIdx++, color.set(districtPlateColor(d.zone_type, analytical)));
        zones.push(d.zone_type);
      }

      for (const p of plazas) {
        dummy.position.set(
          p.x + p.w * 0.5 - WORLD_CENTER_X,
          0.185,
          p.z + p.d * 0.5 - WORLD_CENTER_Z,
        );
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(p.w, 0.04, p.d);
        dummy.updateMatrix();
        padsMesh.setMatrixAt(pIdx, dummy.matrix);
        const colHex =
          p.kind === "loading_bay" ? "#8c8478" : p.kind === "courtyard" ? "#5b934c" : "#cbd2db";
        padsMesh.setColorAt(pIdx++, color.set(colHex));
      }

      padsMesh.instanceMatrix.needsUpdate = true;
      if (padsMesh.instanceColor) padsMesh.instanceColor.needsUpdate = true;
      padsMesh.computeBoundingSphere();
      h.districtPlates = { mesh: padsMesh, zones };
      h.districtsGroup.add(padsMesh);
    }

    if (roadCount === 0 && totalPadCount === 0) {
      unitBox.dispose();
    }
    h.requestRender();
  }, [districts, plazas, streetLines]);

  useEffect(() => {
    const h = handleRef.current;
    if (!h || !h.districtPlates) return;
    const analytical = isAnalyticalDataMap(dataMap);
    const color = new THREE.Color();
    h.districtPlates.zones.forEach((zone, idx) => {
      const plateInstanceIdx = idx * 2 + 1;
      h.districtPlates!.mesh.setColorAt(
        plateInstanceIdx,
        color.set(districtPlateColor(zone, analytical)),
      );
    });
    if (h.districtPlates.mesh.instanceColor) h.districtPlates.mesh.instanceColor.needsUpdate = true;
    h.requestRender();
  }, [dataMap]);

  // Waterfront piers & moored block ships
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    clearGroup(h.docksGroup);
    const directDeps = deps.filter((d) => d.is_direct).slice(0, 8);
    if (directDeps.length === 0) {
      h.requestRender();
      return;
    }

    const pierGeom = new THREE.BoxGeometry(8.8, 0.3, 4.8);
    const shedGeom = new THREE.BoxGeometry(2.6, 0.85, 1.8);
    const shipGeom = new THREE.BoxGeometry(6.2, 0.9, 2.1);

    const pierMat = new THREE.MeshLambertMaterial({ color: "#9b7653" });
    const shedMat = new THREE.MeshLambertMaterial({ color: "#b36247" });
    const shipMat = new THREE.MeshLambertMaterial({ color: "#d97706" });

    const pierMesh = new THREE.InstancedMesh(pierGeom, pierMat, directDeps.length);
    const shedMesh = new THREE.InstancedMesh(shedGeom, shedMat, directDeps.length);
    const shipMesh = new THREE.InstancedMesh(shipGeom, shipMat, directDeps.length);
    const dummy = new THREE.Object3D();

    directDeps.forEach((_, idx) => {
      const dx = 10 + idx * 16 + 5.5 - WORLD_CENTER_X;
      dummy.position.set(dx, -0.02, 56.8);
      dummy.updateMatrix();
      pierMesh.setMatrixAt(idx, dummy.matrix);

      dummy.position.set(dx - 2.4, 0.52, 56.0);
      dummy.updateMatrix();
      shedMesh.setMatrixAt(idx, dummy.matrix);

      dummy.position.set(dx, -0.2, 62.2);
      dummy.updateMatrix();
      shipMesh.setMatrixAt(idx, dummy.matrix);
    });

    pierMesh.instanceMatrix.needsUpdate = true;
    shedMesh.instanceMatrix.needsUpdate = true;
    shipMesh.instanceMatrix.needsUpdate = true;
    pierMesh.computeBoundingSphere();
    shedMesh.computeBoundingSphere();
    shipMesh.computeBoundingSphere();
    h.docksGroup.add(pierMesh, shedMesh, shipMesh);
    h.requestRender();
  }, [deps]);

  // Instanced primitive building blocks batched by primitive shape & lit/beacon role
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    clearGroup(h.buildingsGroup, isSharedPrimitive);
    h.batches = [];

    const grouped = new Map<
      string,
      {
        shape: BuildingBlockPart["shape"];
        isBeacon: boolean;
        entries: Array<{
          file: FileMetric;
          part: BuildingBlockPart;
          fp: ReturnType<typeof buildingFootprint3D>;
          ori: ReturnType<typeof lotOrientation>;
        }>;
      }
    >();

    for (const f of files) {
      const fp = buildingFootprint3D(f);
      const ori = lotOrientation(f, fp.bw, fp.bd);
      for (const part of getBlockPartsForFile(f)) {
        const isBeacon = part.role === "beacon";
        const key = `${part.shape}|${isBeacon ? "beacon" : "lit"}`;
        let group = grouped.get(key);
        if (!group) {
          group = { shape: part.shape, isBeacon, entries: [] };
          grouped.set(key, group);
        }
        group.entries.push({ file: f, part, fp, ori });
      }
    }

    const dummy = new THREE.Object3D();
    for (const { shape, isBeacon, entries } of grouped.values()) {
      const geom = getPrimitiveGeometry(shape);
      const material = isBeacon
        ? new THREE.MeshBasicMaterial({ color: "#ffffff" })
        : new THREE.MeshLambertMaterial({ color: "#ffffff" });
      const mesh = new THREE.InstancedMesh(geom, material, entries.length);

      entries.forEach(({ part, fp, ori }, idx) => {
        const t = computeBlockPartTransform(
          part,
          ori.localW,
          ori.localD,
          fp.h,
          0.12,
          fp.cx,
          fp.cz,
          ori.rotY,
        );
        dummy.position.set(t.x, t.y, t.z);
        dummy.rotation.set(0, ori.rotY, 0);
        dummy.scale.set(t.sx, t.sy, t.sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);
      });

      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.computeBoundingBox();

      h.buildingsGroup.add(mesh);
      h.batches.push({
        mesh,
        entries: entries.map(({ file, part }) => ({ file, part })),
      });
    }

    h.updateBuildingColors();
  }, [files]);

  // Building tint & selection highlight updates (no geometry rebuild)
  useEffect(() => {
    handleRef.current?.updateBuildingColors();
  }, [blastRadius, dataMap, selectedFile]);

  // Live simulation vehicles & fire markers (subscribed directly without App re-renders)
  useEffect(() => {
    handleRef.current?.updateDynamicActors();
  }, [files, showTraffic]);

  useEffect(() => {
    handleRef.current?.updateDynamicActors();
    return sim.subscribeRender(() => {
      handleRef.current?.updateDynamicActors();
    });
  }, [sim]);

  // Dashed co-change fault arcs (only when building selected or blast radius active)
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    clearGroup(h.faultsGroup);
    const pairs = selectFaultLines(cochanges, selectedFile, blastRadius);
    if (pairs.length === 0) {
      h.requestRender();
      return;
    }

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
      const geom = new THREE.BufferGeometry().setFromPoints(curve.getPoints(12));
      const mat = new THREE.LineDashedMaterial({ color: "#d946ef", dashSize: 2, gapSize: 1 });
      const line = new THREE.Line(geom, mat);
      line.computeLineDistances();
      h.faultsGroup.add(line);
    }
    h.requestRender();
  }, [blastRadius, cochanges, files, selectedFile]);

  useEffect(() => {
    if (mods.alt || mods.ctrl || mods.space) {
      setHoveredHit((prev) => (prev === null ? prev : null));
      const h = handleRef.current;
      if (h && h.hoveredBox.group.visible) {
        positionHighlightBox(h.hoveredBox, null);
        h.requestRender();
      }
    }
  }, [mods.alt, mods.ctrl, mods.space]);

  const cursorIntent = resolveCursorIntent(activeDragMode, mods);

  return (
    <div
      ref={containerRef}
      data-testid="city-canvas-3d"
      onContextMenu={(e) => e.preventDefault()}
      className={`relative h-full w-full overflow-hidden bg-sky-950 ${canvasCursorClass(activeTool, Boolean(hoveredHit), cursorIntent.yawMode, cursorIntent.dragIntent)}`}
    >
      {hoveredHit && !mods.alt && !mods.ctrl && !mods.space && (
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
});

export default CityCanvas3D;
