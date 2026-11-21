import { Line, OrbitControls } from "@react-three/drei";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import type {
  BlastRadiusResult,
  CochangePair,
  DataMapMode,
  District,
  FileMetric,
} from "../types/city";
import { buildingColor3D, buildingHeight3D } from "./geometries3D";

interface CityCanvas3DProps {
  districts: District[];
  files: FileMetric[];
  cochanges: CochangePair[];
  dataMap: DataMapMode;
  selectedFile: string | null;
  blastRadius: BlastRadiusResult | null;
  onSelectFile: (filePath: string | null) => void;
}

const WORLD_CX = 70;
const WORLD_CZ = 52;

function InstancedBuildings({
  files,
  dataMap,
  selectedFile,
  blastRadius,
  onSelectFile,
}: {
  files: FileMetric[];
  dataMap: DataMapMode;
  selectedFile: string | null;
  blastRadius: BlastRadiusResult | null;
  onSelectFile: (filePath: string | null) => void;
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
      onSelectFile(files[e.instanceId].file_path);
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
  onSelectFile,
}: CityCanvas3DProps) {
  return (
    <div data-testid="city-canvas-3d" className="h-full w-full bg-slate-950">
      <Canvas
        shadows
        camera={{ position: [92, 78, 92], fov: 42, near: 0.5, far: 1000 }}
        onPointerMissed={() => onSelectFile(null)}
      >
        <color attach="background" args={["#060c18"]} />
        <fog attach="fog" args={["#060c18", 130, 320]} />
        <ambientLight intensity={0.65} />
        <directionalLight position={[80, 120, 60]} intensity={1.35} castShadow />
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
          onSelectFile={onSelectFile}
        />
        <FaultArcs3D
          files={files}
          cochanges={cochanges}
          selectedFile={selectedFile}
          blastRadius={blastRadius}
        />
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          maxPolarAngle={Math.PI * 0.47}
        />
      </Canvas>
    </div>
  );
}
