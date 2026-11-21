import {
  Line,
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
} from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import type {
  BlastRadiusResult,
  CochangePair,
  DataMapMode,
  District,
  FileMetric,
} from "../types/city";
import {
  WORLD_CENTER_X,
  WORLD_CENTER_Z,
  cameraStore,
  useCameraStore,
} from "./cameraStore";
import { buildingColor3D, buildingHeight3D } from "./geometries3D";
import type { FocusTarget } from "./CityCanvas2D";

interface CityCanvas3DProps {
  districts: District[];
  files: FileMetric[];
  cochanges: CochangePair[];
  dataMap: DataMapMode;
  selectedFile: string | null;
  blastRadius: BlastRadiusResult | null;
  focusTarget?: FocusTarget | null;
  activeTool?: string;
  onSelectFile: (filePath: string | null) => void;
  onToolAction?: (file: FileMetric) => void;
}

const WORLD_CX = WORLD_CENTER_X;
const WORLD_CZ = WORLD_CENTER_Z;
const BASE_ORBIT_DISTANCE = 92;

function CameraRig3D() {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const { camera, size } = useThree();
  const camState = useCameraStore();
  const syncingFromStoreRef = useRef(false);
  const userInteractingRef = useRef(false);

  // Push store -> Three camera & OrbitControls whenever store updates (when not actively dragging)
  useEffect(() => {
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
  }, [camState, camera, size.height, size.width]);

  // Ground collision guard & smooth sync on frame
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
        cameraStore.cancelTween();
        cameraStore.setState({ followVehicleId: null, cinematicOrbit: false }, { cancelTween: false });
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

function InstancedBuildings({
  files,
  dataMap,
  selectedFile,
  blastRadius,
  activeTool,
  onSelectFile,
  onToolAction,
}: {
  files: FileMetric[];
  dataMap: DataMapMode;
  selectedFile: string | null;
  blastRadius: BlastRadiusResult | null;
  activeTool: string;
  onSelectFile: (filePath: string | null) => void;
  onToolAction?: (file: FileMetric) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);

  const impactedHop = useMemo(() => {
    const map = new Map<string, number>();
    if (blastRadius) {
      for (const n of blastRadius.impacted_files) {
        map.set(n.file_path, n.hop_distance);
      }
    }
    return map;
  }, [blastRadius]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    files.forEach((f, idx) => {
      const pad = Math.min(0.45, Math.min(f.layout_w, f.layout_d) * 0.14);
      const bw = Math.max(0.8, f.layout_w - pad * 2);
      const bd = Math.max(0.8, f.layout_d - pad * 2);
      const h = buildingHeight3D(f);
      const cx = f.layout_x + f.layout_w * 0.5 - WORLD_CX;
      const cz = f.layout_z + f.layout_d * 0.5 - WORLD_CZ;

      dummy.position.set(cx, h * 0.5, cz);
      dummy.scale.set(bw, h, bd);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);

      color.set(buildingColor3D(f, dataMap, selectedFile, impactedHop));
      mesh.setColorAt(idx, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [dataMap, files, impactedHop, selectedFile]);

  function handleClick(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation();
    if (e.instanceId !== undefined && files[e.instanceId]) {
      const f = files[e.instanceId];
      if (activeTool !== "inspect" && onToolAction) {
        onToolAction(f);
      } else {
        onSelectFile(f.file_path);
      }
    }
  }

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, Math.max(1, files.length)]}
      onClick={handleClick}
      castShadow
      receiveShadow
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.55} metalness={0.18} />
    </instancedMesh>
  );
}

function DistrictPlates3D({ districts }: { districts: District[] }) {
  return (
    <group>
      {districts.map((d) => (
        <mesh
          key={d.district_path}
          position={[
            d.bounds_x + d.bounds_w * 0.5 - WORLD_CX,
            0.06,
            d.bounds_z + d.bounds_d * 0.5 - WORLD_CZ,
          ]}
          receiveShadow
        >
          <boxGeometry args={[d.bounds_w, 0.12, d.bounds_d]} />
          <meshStandardMaterial color="#1e293b" roughness={0.9} />
        </mesh>
      ))}
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
  dataMap,
  selectedFile,
  blastRadius,
  focusTarget,
  activeTool = "inspect",
  onSelectFile,
  onToolAction,
}: CityCanvas3DProps) {
  const cam = useCameraStore();

  useEffect(() => {
    if (!focusTarget) return;
    cameraStore.flyTo({
      targetX: focusTarget.x,
      targetZ: focusTarget.z,
      zoom: focusTarget.zoom ?? Math.max(1.25, cameraStore.getState().zoom),
      durationMs: 480,
    });
  }, [focusTarget]);

  const skyBg =
    cam.timeOfDay === "golden" ? "#1b1433" : cam.timeOfDay === "night" ? "#030712" : "#060c18";

  return (
    <div data-testid="city-canvas-3d" className="h-full w-full bg-slate-950">
      <Canvas shadows onPointerMissed={() => onSelectFile(null)}>
        {cam.projection === "orthographic" ? (
          <OrthographicCamera makeDefault near={-400} far={1200} position={[85, 72, 85]} />
        ) : (
          <PerspectiveCamera makeDefault fov={42} near={0.5} far={1000} position={[85, 72, 85]} />
        )}

        <color attach="background" args={[skyBg]} />
        <fog attach="fog" args={[skyBg, 130, 340]} />
        <ambientLight intensity={cam.timeOfDay === "night" ? 0.32 : 0.65} />
        <directionalLight
          position={cam.timeOfDay === "golden" ? [110, 48, 70] : [80, 120, 60]}
          intensity={cam.timeOfDay === "night" ? 0.45 : cam.timeOfDay === "golden" ? 1.55 : 1.35}
          color={cam.timeOfDay === "golden" ? "#fbbf24" : "#ffffff"}
          castShadow
        />
        <directionalLight position={[-60, 40, -60]} intensity={0.35} color="#38bdf8" />

        {/* Harbor water + city island */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.6, 0]}>
          <planeGeometry args={[420, 420]} />
          <meshStandardMaterial color="#091d34" roughness={0.3} metalness={0.4} />
        </mesh>
        <mesh position={[0, -0.25, 0]} receiveShadow>
          <boxGeometry args={[144, 0.5, 108]} />
          <meshStandardMaterial color="#0f172a" roughness={0.85} />
        </mesh>

        <DistrictPlates3D districts={districts} />
        <InstancedBuildings
          files={files}
          dataMap={dataMap}
          selectedFile={selectedFile}
          blastRadius={blastRadius}
          activeTool={activeTool}
          onSelectFile={onSelectFile}
          onToolAction={onToolAction}
        />
        <FaultArcs3D
          files={files}
          cochanges={cochanges}
          selectedFile={selectedFile}
          blastRadius={blastRadius}
        />
        <CameraRig3D />
      </Canvas>
    </div>
  );
}
