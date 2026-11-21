import {
  Environment,
  Lightformer,
  Line,
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
} from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, N8AO } from "@react-three/postprocessing";
import {
  Component,
  type ComponentRef,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";

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
  type TimeOfDay,
  WORLD_CENTER_X,
  WORLD_CENTER_Z,
  cameraStore,
  useCameraSelector,
} from "./cameraStore";
import { vehicleColor } from "./cityTheme";
import {
  ARCHETYPE_KITS,
  type ArchetypePartSpec,
  buildingColor3D,
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

const WORLD_CX = WORLD_CENTER_X;
const WORLD_CZ = WORLD_CENTER_Z;
const BASE_ORBIT_DISTANCE = 92;
type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

class PostprocessingBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(): void {
    // Gracefully skip postprocessing if minimal WebGL context rejects multi-pass targets
  }
  render(): ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

function CameraRig3D({ onOrbitStart }: { onOrbitStart: () => void }) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const { camera, size } = useThree();
  const syncingFromStoreRef = useRef(false);
  const userInteractingRef = useRef(false);

  useEffect(() => {
    const applyCam = (camState = cameraStore.getState()) => {
      const controls = controlsRef.current;
      if (!controls || userInteractingRef.current) return;

      syncingFromStoreRef.current = true;
      const tx = camState.targetX - WORLD_CX;
      const tz = camState.targetZ - WORLD_CZ;
      controls.target.set(tx, 0, tz);

      const pitchRad = (camState.pitch * Math.PI) / 180;
      const dist = BASE_ORBIT_DISTANCE / Math.max(0.35, camState.zoom);
      const horiz = dist * Math.cos(pitchRad);
      const camY = Math.max(1.8, dist * Math.sin(pitchRad));
      const camX = tx + horiz * Math.sin(camState.yaw);
      const camZ = tz + horiz * Math.cos(camState.yaw);

      camera.position.set(camX, camY, camZ);
      if (camera instanceof THREE.OrthographicCamera) {
        const baseSpan = 65 / Math.max(0.35, camState.zoom);
        const aspect = Math.max(0.5, size.width / Math.max(1, size.height));
        camera.left = -baseSpan * aspect;
        camera.right = baseSpan * aspect;
        camera.top = baseSpan;
        camera.bottom = -baseSpan;
        camera.zoom = 1;
        camera.updateProjectionMatrix();
      }
      controls.update();
      syncingFromStoreRef.current = false;
    };

    applyCam();
    return cameraStore.subscribe(applyCam);
  }, [camera, size.height, size.width]);

  useFrame(() => {
    if (camera.position.y < 1.8) {
      camera.position.y = 1.8;
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      minDistance={16}
      maxDistance={280}
      minPolarAngle={(5 * Math.PI) / 180}
      maxPolarAngle={(78 * Math.PI) / 180}
      onStart={() => {
        userInteractingRef.current = true;
        onOrbitStart();
        cameraStore.cancelTween();
        cameraStore.setState(
          { followVehicleId: null, cinematicOrbit: false },
          { cancelTween: false },
        );
      }}
      onEnd={() => {
        userInteractingRef.current = false;
      }}
      onChange={() => {
        if (syncingFromStoreRef.current || !controlsRef.current || !userInteractingRef.current) {
          return;
        }
        const ctrl = controlsRef.current;
        const offset = new THREE.Vector3().subVectors(camera.position, ctrl.target);
        const dist = Math.max(16, offset.length());
        const yaw = Math.atan2(offset.x, offset.z);
        const horiz = Math.max(0.01, Math.hypot(offset.x, offset.z));
        const pitch = (Math.atan2(Math.max(1.8, offset.y), horiz) * 180) / Math.PI;
        const zoom = BASE_ORBIT_DISTANCE / dist;
        cameraStore.setState(
          {
            targetX: ctrl.target.x + WORLD_CX,
            targetZ: ctrl.target.z + WORLD_CZ,
            yaw,
            pitch,
            zoom,
          },
          { cancelTween: false },
        );
      }}
    />
  );
}

const UNIT_BOX_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const NO_RAYCAST = () => {};

function BuildingHighlightBox3D({
  file,
  color,
  opacity,
}: {
  file: FileMetric;
  color: string;
  opacity: number;
}) {
  const pad = Math.min(0.45, Math.min(file.layout_w, file.layout_d) * 0.14);
  const bw = Math.max(0.8, file.layout_w - pad * 2);
  const bd = Math.max(0.8, file.layout_d - pad * 2);
  const h = buildingHeight3D(file);
  const cx = file.layout_x + file.layout_w * 0.5 - WORLD_CX;
  const cz = file.layout_z + file.layout_d * 0.5 - WORLD_CZ;

  return (
    <group>
      <lineSegments
        geometry={UNIT_BOX_EDGES}
        position={[cx, h * 0.5 + 0.12, cz]}
        scale={[bw + 0.36, h + 0.24, bd + 0.36]}
        raycast={NO_RAYCAST}
      >
        <lineBasicMaterial color={color} transparent opacity={opacity} />
      </lineSegments>
      <mesh position={[cx, 0.18, cz]} rotation={[-Math.PI / 2, 0, 0]} raycast={NO_RAYCAST}>
        <planeGeometry args={[bw + 0.72, bd + 0.72]} />
        <meshBasicMaterial color={color} transparent opacity={0.22} depthWrite={false} />
      </mesh>
    </group>
  );
}

function ArchetypePartMesh({
  part,
  groupFiles,
  dataMap,
  selectedFile,
  impactedHop,
  blackoutFiles,
  timeOfDay,
  activeTool,
  onSelectFile,
  onToolAction,
  onHoverBuilding,
  onLeaveBuilding,
}: {
  part: ArchetypePartSpec;
  groupFiles: FileMetric[];
  dataMap: DataMapMode;
  selectedFile: string | null;
  impactedHop: Map<string, number>;
  blackoutFiles?: Set<string>;
  timeOfDay: TimeOfDay;
  activeTool: string;
  onSelectFile: (filePath: string | null) => void;
  onToolAction?: (file: FileMetric) => void;
  onHoverBuilding: (file: FileMetric, clientX: number, clientY: number) => void;
  onLeaveBuilding: (filePath: string) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const geom = useMemo(() => getSharedPartGeometry(part.geom), [part.geom]);
  const facadeMaps = useMemo(
    () => (part.facadeStyle ? getFacadeTextureSet(part.facadeStyle) : null),
    [part.facadeStyle],
  );
  const turfMap = useMemo(() => (part.role === "turf" ? getTurfTexture() : null), [part.role]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || groupFiles.length === 0) return;

    const dummy = new THREE.Object3D();
    groupFiles.forEach((f, idx) => {
      const pad = Math.min(0.45, Math.min(f.layout_w, f.layout_d) * 0.14);
      const bw = Math.max(0.8, f.layout_w - pad * 2);
      const bd = Math.max(0.8, f.layout_d - pad * 2);
      const h = buildingHeight3D(f);
      const cx = f.layout_x + f.layout_w * 0.5 - WORLD_CX;
      const cz = f.layout_z + f.layout_d * 0.5 - WORLD_CZ;

      const sx = part.fixedXZ ?? bw * part.scale[0];
      const sz = part.fixedXZ ?? bd * part.scale[2];
      const sy = part.fixedY ?? h * part.scale[1];

      dummy.position.set(cx + part.offset[0] * bw, part.offset[1] * h, cz + part.offset[2] * bd);
      dummy.rotation.set(0, part.rotY ?? 0, 0);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    // Recompute spatial bounds after scattering instances so Three.js raycasting & frustum culling stay accurate
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
  }, [groupFiles, part]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || groupFiles.length === 0) return;

    const color = new THREE.Color();
    groupFiles.forEach((f, idx) => {
      const isBlackout = blackoutFiles?.has(f.file_path);
      if (isBlackout) {
        color.set("#1e293b");
      } else if (part.role === "main" || part.role === "turf") {
        color.set(buildingColor3D(f, dataMap, selectedFile, impactedHop));
      } else if (part.tintHex) {
        color.set(part.tintHex);
      } else {
        color.set("#cbd5e1");
      }
      mesh.setColorAt(idx, color);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [blackoutFiles, dataMap, groupFiles, impactedHop, part, selectedFile]);

  function handleClick(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation();
    if (e.delta > 5) return;
    if (e.instanceId !== undefined && groupFiles[e.instanceId]) {
      const f = groupFiles[e.instanceId];
      if (activeTool !== "inspect" && onToolAction) {
        onToolAction(f);
      } else {
        onSelectFile(f.file_path);
      }
    }
  }

  function handlePointerMove(e: ThreeEvent<PointerEvent>) {
    e.stopPropagation();
    if (e.instanceId !== undefined && groupFiles[e.instanceId]) {
      onHoverBuilding(groupFiles[e.instanceId], e.nativeEvent.clientX, e.nativeEvent.clientY);
    }
  }

  function handlePointerOut(e: ThreeEvent<PointerEvent>) {
    if (e.instanceId !== undefined && groupFiles[e.instanceId]) {
      onLeaveBuilding(groupFiles[e.instanceId].file_path);
    }
  }

  const emissiveIntensity =
    part.role === "beacon"
      ? 1.8
      : facadeMaps
        ? timeOfDay === "night"
          ? 1.15
          : timeOfDay === "golden"
            ? 0.55
            : 0.08
        : 0;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geom, undefined, Math.max(1, groupFiles.length)]}
      onClick={handleClick}
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
      castShadow={part.role !== "turf"}
      receiveShadow
    >
      <meshStandardMaterial
        map={facadeMaps?.map ?? turfMap ?? null}
        roughnessMap={facadeMaps?.roughnessMap ?? null}
        bumpMap={facadeMaps?.bumpMap ?? null}
        bumpScale={facadeMaps ? 0.08 : 0}
        emissiveMap={facadeMaps?.emissiveMap ?? null}
        emissive={
          part.role === "beacon" ? (part.tintHex ?? "#fde047") : facadeMaps ? "#fef3c7" : "#000000"
        }
        emissiveIntensity={emissiveIntensity}
        roughness={part.facadeStyle === "glass" ? 0.25 : 0.65}
        metalness={part.facadeStyle === "glass" ? 0.45 : part.role === "trim" ? 0.35 : 0.12}
      />
    </instancedMesh>
  );
}

function MultiPartCityBuildings({
  files,
  dataMap,
  selectedFile,
  hoveredFile,
  blastRadius,
  blackoutFiles,
  timeOfDay,
  activeTool,
  onSelectFile,
  onToolAction,
  onHoverBuilding,
  onLeaveBuilding,
}: {
  files: FileMetric[];
  dataMap: DataMapMode;
  selectedFile: string | null;
  hoveredFile: string | null;
  blastRadius: BlastRadiusResult | null;
  blackoutFiles?: Set<string>;
  timeOfDay: TimeOfDay;
  activeTool: string;
  onSelectFile: (filePath: string | null) => void;
  onToolAction?: (file: FileMetric) => void;
  onHoverBuilding: (file: FileMetric, clientX: number, clientY: number) => void;
  onLeaveBuilding: (filePath: string) => void;
}) {
  const impactedHop = useMemo(() => {
    const map = new Map<string, number>();
    if (blastRadius) {
      for (const n of blastRadius.impacted_files) {
        map.set(n.file_path, n.hop_distance);
      }
    }
    return map;
  }, [blastRadius]);

  const byArchetype = useMemo(() => {
    const map = new Map<BuildingArchetype, FileMetric[]>();
    for (const f of files) {
      const arch = f.building_archetype;
      const arr = map.get(arch) ?? [];
      arr.push(f);
      map.set(arch, arr);
    }
    return Array.from(map.entries());
  }, [files]);

  const selectedFileObj = useMemo(
    () => (selectedFile ? (files.find((f) => f.file_path === selectedFile) ?? null) : null),
    [files, selectedFile],
  );
  const hoveredFileObj = useMemo(
    () =>
      hoveredFile && hoveredFile !== selectedFile
        ? (files.find((f) => f.file_path === hoveredFile) ?? null)
        : null,
    [files, hoveredFile, selectedFile],
  );

  return (
    <group>
      {byArchetype.map(([arch, groupFiles]) => {
        const kit = ARCHETYPE_KITS[arch] ?? ARCHETYPE_KITS.office_tower;
        return (
          <group key={arch}>
            {kit.map((part) => (
              <ArchetypePartMesh
                key={`${arch}-${part.id}-${groupFiles.length}`}
                part={part}
                groupFiles={groupFiles}
                dataMap={dataMap}
                selectedFile={selectedFile}
                impactedHop={impactedHop}
                blackoutFiles={blackoutFiles}
                timeOfDay={timeOfDay}
                activeTool={activeTool}
                onSelectFile={onSelectFile}
                onToolAction={onToolAction}
                onHoverBuilding={onHoverBuilding}
                onLeaveBuilding={onLeaveBuilding}
              />
            ))}
          </group>
        );
      })}
      {selectedFileObj && (
        <BuildingHighlightBox3D file={selectedFileObj} color="#fef08a" opacity={0.95} />
      )}
      {hoveredFileObj && (
        <BuildingHighlightBox3D file={hoveredFileObj} color="#ffffff" opacity={0.8} />
      )}
    </group>
  );
}

function DistrictPlates3D({
  districts,
  plazas,
  streetLines,
}: {
  districts: District[];
  plazas: Array<{ x: number; z: number; w: number; d: number; kind: string }>;
  streetLines?: { xLines: number[]; zLines: number[] };
}) {
  const asphaltTex = useMemo(() => getAsphaltRoadTexture(), []);

  return (
    <group>
      {/* Street strips */}
      {streetLines?.xLines.map((xl, idx) => (
        <mesh key={`sx-${idx}`} position={[xl - WORLD_CX, 0.02, 0]} receiveShadow>
          <boxGeometry args={[2.2, 0.04, 102]} />
          <meshStandardMaterial map={asphaltTex} color="#1e293b" roughness={0.9} />
        </mesh>
      ))}
      {streetLines?.zLines.map((zl, idx) => (
        <mesh
          key={`sz-${idx}`}
          position={[0, 0.02, zl - WORLD_CZ]}
          rotation={[0, Math.PI * 0.5, 0]}
          receiveShadow
        >
          <boxGeometry args={[2.2, 0.04, 138]} />
          <meshStandardMaterial map={asphaltTex} color="#1e293b" roughness={0.9} />
        </mesh>
      ))}

      {/* Concrete Sidewalk + District Neighborhood Plates */}
      {districts.map((d) => (
        <group key={d.district_path}>
          <mesh
            position={[
              d.bounds_x + d.bounds_w * 0.5 - WORLD_CX,
              0.05,
              d.bounds_z + d.bounds_d * 0.5 - WORLD_CZ,
            ]}
            receiveShadow
          >
            <boxGeometry args={[d.bounds_w + 0.8, 0.1, d.bounds_d + 0.8]} />
            <meshStandardMaterial color="#475569" roughness={0.92} />
          </mesh>
          <mesh
            position={[
              d.bounds_x + d.bounds_w * 0.5 - WORLD_CX,
              0.11,
              d.bounds_z + d.bounds_d * 0.5 - WORLD_CZ,
            ]}
            receiveShadow
          >
            <boxGeometry args={[d.bounds_w, 0.08, d.bounds_d]} />
            <meshStandardMaterial color="#1e293b" roughness={0.88} />
          </mesh>
        </group>
      ))}

      {/* Pocket Plazas & Trees */}
      {plazas.map((p, idx) => (
        <group
          key={`plaza-${idx}`}
          position={[p.x + p.w * 0.5 - WORLD_CX, 0.18, p.z + p.d * 0.5 - WORLD_CZ]}
        >
          <mesh receiveShadow>
            <boxGeometry args={[p.w, 0.06, p.d]} />
            <meshStandardMaterial
              color={p.kind === "loading_bay" ? "#57534e" : "#273549"}
              roughness={0.85}
            />
          </mesh>
          {p.kind !== "loading_bay" && (
            <mesh position={[0, 0.65, 0]} castShadow>
              <sphereGeometry args={[0.55, 8, 8]} />
              <meshStandardMaterial color="#22c55e" roughness={0.8} />
            </mesh>
          )}
        </group>
      ))}
    </group>
  );
}

function WaterfrontDocks3D({ deps }: { deps: ExternalDep[] }) {
  const shipsRef = useRef<THREE.Group | null>(null);
  const directDeps = useMemo(() => deps.filter((d) => d.is_direct).slice(0, 8), [deps]);

  useFrame(({ clock }) => {
    if (!shipsRef.current) return;
    const t = clock.getElapsedTime();
    shipsRef.current.children.forEach((child, idx) => {
      child.position.y = -0.08 + Math.sin(t * 1.5 + idx * 1.2) * 0.14;
      child.rotation.z = Math.sin(t * 1.1 + idx) * 0.03;
    });
  });

  if (directDeps.length === 0) return null;

  return (
    <group>
      {directDeps.map((dep, idx) => {
        const dx = 10 + idx * 16 + 5.5 - WORLD_CX;
        const dz = 109.5 - WORLD_CZ;
        return (
          <mesh key={dep.package_name} position={[dx, 0.15, dz]} castShadow receiveShadow>
            <boxGeometry args={[10.5, 0.45, 5.2]} />
            <meshStandardMaterial color="#92400e" roughness={0.85} />
          </mesh>
        );
      })}
      <group ref={shipsRef}>
        {directDeps.map((dep, idx) => {
          const dx = 10 + idx * 16 + 5.5 - WORLD_CX;
          const dz = 114.5 - WORLD_CZ;
          return (
            <mesh key={`ship-${dep.package_name}`} position={[dx, 0, dz]} castShadow>
              <boxGeometry args={[6.4, 0.9, 2.3]} />
              <meshStandardMaterial color="#0284c7" roughness={0.45} metalness={0.25} />
            </mesh>
          );
        })}
      </group>
    </group>
  );
}

function HarborWater3D({ timeOfDay }: { timeOfDay: TimeOfDay }) {
  const bumpTex = useMemo(() => getWaterRippleTexture(), []);

  useFrame((_, delta) => {
    if (bumpTex) {
      bumpTex.offset.x = (bumpTex.offset.x + delta * 0.025) % 1;
      bumpTex.offset.y = (bumpTex.offset.y + delta * 0.018) % 1;
    }
  });

  const waterColor =
    timeOfDay === "golden" ? "#102845" : timeOfDay === "night" ? "#041122" : "#09213c";

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.55, 0]} receiveShadow>
      <planeGeometry args={[460, 460]} />
      <meshStandardMaterial
        color={waterColor}
        bumpMap={bumpTex}
        bumpScale={0.22}
        roughness={0.2}
        metalness={0.62}
      />
    </mesh>
  );
}

function LiveVehiclesAndFires3D({
  vehicles,
  files,
  fireFiles,
}: {
  vehicles: SimVehicleRender[];
  files: FileMetric[];
  fireFiles?: Set<string>;
}) {
  const byPath = useMemo(() => {
    const m = new Map<string, FileMetric>();
    for (const f of files) m.set(f.file_path, f);
    return m;
  }, [files]);

  const burningFiles = useMemo(() => {
    if (!fireFiles || fireFiles.size === 0) return [];
    const list: FileMetric[] = [];
    for (const fp of fireFiles) {
      const f = byPath.get(fp);
      if (f) list.push(f);
    }
    return list;
  }, [byPath, fireFiles]);

  return (
    <group>
      {vehicles.slice(0, 120).map((v) => {
        const col = vehicleColor(v.type, v.jammed);
        return (
          <mesh
            key={v.id}
            position={[v.x - WORLD_CX, v.type === "cargo_ship" ? 0.1 : 0.35, v.z - WORLD_CZ]}
            rotation={[0, -v.heading, 0]}
          >
            <boxGeometry args={v.type === "cargo_ship" ? [2.8, 0.7, 1.3] : [0.85, 0.45, 1.35]} />
            <meshStandardMaterial
              color={col}
              emissive={col}
              emissiveIntensity={v.jammed || v.type === "fire_truck" ? 1.5 : 0.8}
            />
          </mesh>
        );
      })}

      {burningFiles.map((f) => {
        const h = buildingHeight3D(f);
        return (
          <mesh
            key={`fire-${f.file_path}`}
            position={[
              f.layout_x + f.layout_w * 0.5 - WORLD_CX,
              h + 0.9,
              f.layout_z + f.layout_d * 0.5 - WORLD_CZ,
            ]}
          >
            <coneGeometry args={[1.1, 2.4, 8]} />
            <meshStandardMaterial color="#f97316" emissive="#fb923c" emissiveIntensity={2.4} />
          </mesh>
        );
      })}
    </group>
  );
}

function FaultArcs3D({
  files,
  cochanges,
  selectedFile,
  blastRadius,
}: {
  files: FileMetric[];
  cochanges: CochangePair[];
  selectedFile: string | null;
  blastRadius: BlastRadiusResult | null;
}) {
  const byPath = useMemo(() => {
    const m = new Map<string, FileMetric>();
    for (const f of files) m.set(f.file_path, f);
    return m;
  }, [files]);

  const pairs = useMemo(() => {
    if (blastRadius?.fault_lines?.length) return blastRadius.fault_lines;
    if (selectedFile) {
      return cochanges.filter((c) => c.file_a === selectedFile || c.file_b === selectedFile);
    }
    return cochanges.slice(0, 8);
  }, [blastRadius, cochanges, selectedFile]);

  return (
    <group>
      {pairs.map((p) => {
        const fa = byPath.get(p.file_a);
        const fb = byPath.get(p.file_b);
        if (!fa || !fb) return null;
        const ax = fa.layout_x + fa.layout_w * 0.5 - WORLD_CX;
        const az = fa.layout_z + fa.layout_d * 0.5 - WORLD_CZ;
        const ay = buildingHeight3D(fa) + 0.5;
        const bx = fb.layout_x + fb.layout_w * 0.5 - WORLD_CX;
        const bz = fb.layout_z + fb.layout_d * 0.5 - WORLD_CZ;
        const by = buildingHeight3D(fb) + 0.5;
        const midY = Math.max(ay, by) + 10;
        const pts: Array<[number, number, number]> = [
          [ax, ay, az],
          [(ax + bx) * 0.5, midY, (az + bz) * 0.5],
          [bx, by, bz],
        ];
        return (
          <Line
            key={`${p.file_a}-${p.file_b}`}
            points={pts}
            color="#d946ef"
            lineWidth={2}
            dashed
            dashSize={2}
            gapSize={1}
          />
        );
      })}
    </group>
  );
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
  const projection = useCameraSelector((s) => s.projection);
  const timeOfDay = useCameraSelector((s) => s.timeOfDay);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoveredHit, setHoveredHit] = useState<{
    file: FileMetric;
    x: number;
    y: number;
  } | null>(null);

  const handleHoverBuilding = useCallback((file: FileMetric, clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHoveredHit({
      file,
      x: clientX - rect.left,
      y: clientY - rect.top,
    });
  }, []);

  const handleLeaveBuilding = useCallback((filePath: string) => {
    setHoveredHit((prev) => (prev?.file.file_path === filePath ? null : prev));
  }, []);

  const clearHover = useCallback(() => setHoveredHit(null), []);

  const skyBg = timeOfDay === "golden" ? "#1b1433" : timeOfDay === "night" ? "#030712" : "#071121";

  return (
    <div
      ref={containerRef}
      data-testid="city-canvas-3d"
      onPointerLeave={clearHover}
      className={`relative h-full w-full overflow-hidden bg-slate-950 ${
        activeTool !== "inspect"
          ? "cursor-crosshair"
          : hoveredHit
            ? "cursor-pointer"
            : "cursor-grab active:cursor-grabbing"
      }`}
    >
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        onPointerMissed={() => onSelectFile(null)}
      >
        {projection === "orthographic" ? (
          <OrthographicCamera makeDefault near={-400} far={1200} position={[85, 72, 85]} />
        ) : (
          <PerspectiveCamera makeDefault fov={42} near={0.5} far={1000} position={[85, 72, 85]} />
        )}

        <color attach="background" args={[skyBg]} />
        <fog attach="fog" args={[skyBg, 145, 360]} />
        <ambientLight intensity={timeOfDay === "night" ? 0.35 : 0.6} />
        <directionalLight
          position={timeOfDay === "golden" ? [115, 42, 72] : [80, 120, 60]}
          intensity={timeOfDay === "night" ? 0.48 : timeOfDay === "golden" ? 1.65 : 1.4}
          color={timeOfDay === "golden" ? "#fbbf24" : "#ffffff"}
          castShadow
          shadow-mapSize={[1024, 1024]}
          shadow-camera-left={-90}
          shadow-camera-right={90}
          shadow-camera-top={90}
          shadow-camera-bottom={-90}
        />
        <directionalLight position={[-65, 45, -65]} intensity={0.38} color="#38bdf8" />

        <Environment resolution={128}>
          <Lightformer
            form="rect"
            intensity={timeOfDay === "night" ? 0.4 : 1.6}
            color={timeOfDay === "golden" ? "#fb923c" : "#bae6fd"}
            scale={[40, 15, 1]}
            position={[0, 35, -30]}
            rotation={[Math.PI * 0.35, 0, 0]}
          />
          <Lightformer
            form="ring"
            intensity={timeOfDay === "night" ? 0.3 : 1.2}
            color="#38bdf8"
            scale={20}
            position={[25, 22, 25]}
          />
        </Environment>

        <HarborWater3D timeOfDay={timeOfDay} />
        <mesh position={[0, -0.35, 0]} receiveShadow>
          <boxGeometry args={[146, 0.55, 110]} />
          <meshStandardMaterial color="#334155" roughness={0.88} />
        </mesh>
        <mesh position={[0, -0.1, 0]} receiveShadow>
          <boxGeometry args={[142, 0.22, 106]} />
          <meshStandardMaterial color="#0f172a" roughness={0.85} />
        </mesh>

        <DistrictPlates3D districts={districts} plazas={plazas} streetLines={streetLines} />
        <WaterfrontDocks3D deps={deps} />
        <MultiPartCityBuildings
          files={files}
          dataMap={dataMap}
          selectedFile={selectedFile}
          hoveredFile={hoveredHit?.file.file_path ?? null}
          blastRadius={blastRadius}
          blackoutFiles={blackoutFiles}
          timeOfDay={timeOfDay}
          activeTool={activeTool}
          onSelectFile={onSelectFile}
          onToolAction={onToolAction}
          onHoverBuilding={handleHoverBuilding}
          onLeaveBuilding={handleLeaveBuilding}
        />
        <LiveVehiclesAndFires3D vehicles={vehicles} files={files} fireFiles={fireFiles} />
        <FaultArcs3D
          files={files}
          cochanges={cochanges}
          selectedFile={selectedFile}
          blastRadius={blastRadius}
        />
        <CameraRig3D onOrbitStart={clearHover} />

        <PostprocessingBoundary>
          <EffectComposer multisampling={0}>
            <N8AO aoRadius={2.2} intensity={1.4} distanceFalloff={1.2} />
            <Bloom
              luminanceThreshold={0.9}
              mipmapBlur
              intensity={timeOfDay === "night" ? 0.95 : timeOfDay === "golden" ? 0.65 : 0.3}
            />
          </EffectComposer>
        </PostprocessingBoundary>
      </Canvas>

      {hoveredHit && (
        <BuildingTooltip
          file={hoveredHit.file}
          x={hoveredHit.x}
          y={hoveredHit.y}
          containerWidth={containerRef.current?.clientWidth}
        />
      )}
    </div>
  );
}
