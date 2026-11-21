import { useEffect, useRef } from "react";

import type { District, FileMetric } from "../types/city";
import { ZONE_PALETTES } from "../city/cityTheme";
import { cameraStore, useCameraStore } from "../city/cameraStore";
import type { SimVehicleRender } from "../city/isoRenderer2D";

interface Minimap2DProps {
  districts: District[];
  files: FileMetric[];
  vehicles?: SimVehicleRender[];
  fireFiles?: Set<string>;
  blackoutFiles?: Set<string>;
}

const MAP_W = 176;
const MAP_H = 128;
const WORLD_W = 148;
const WORLD_D = 112;
const WORLD_X0 = -4;
const WORLD_Z0 = -4;

export function Minimap2D({
  districts,
  files,
  vehicles = [],
  fireFiles,
  blackoutFiles,
}: Minimap2DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);
  const cam = useCameraStore();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const sx = (wx: number) => ((wx - WORLD_X0) / WORLD_W) * MAP_W;
    const sy = (wz: number) => ((wz - WORLD_Z0) / WORLD_D) * MAP_H;

    ctx.clearRect(0, 0, MAP_W, MAP_H);
    ctx.fillStyle = "#040b17";
    ctx.fillRect(0, 0, MAP_W, MAP_H);

    // Island outline
    ctx.fillStyle = "#0f172a";
    ctx.strokeStyle = "rgba(56, 189, 248, 0.35)";
    ctx.lineWidth = 1;
    ctx.fillRect(sx(0), sy(0), (140 / WORLD_W) * MAP_W, (104 / WORLD_D) * MAP_H);
    ctx.strokeRect(sx(0), sy(0), (140 / WORLD_W) * MAP_W, (104 / WORLD_D) * MAP_H);

    // Districts
    for (const d of districts) {
      const col = ZONE_PALETTES[d.zone_type]?.border ?? "#94a3b8";
      ctx.fillStyle = `${col}26`;
      ctx.strokeStyle = `${col}88`;
      ctx.lineWidth = 0.8;
      const x = sx(d.bounds_x);
      const y = sy(d.bounds_z);
      const w = (d.bounds_w / WORLD_W) * MAP_W;
      const h = (d.bounds_d / WORLD_D) * MAP_H;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }

    // Buildings & disaster pings
    for (const f of files) {
      const bx = sx(f.layout_x + f.layout_w * 0.5);
      const by = sy(f.layout_z + f.layout_d * 0.5);
      const isFire = fireFiles?.has(f.file_path);
      const isBlackout = blackoutFiles?.has(f.file_path);
      if (isFire || isBlackout) {
        ctx.beginPath();
        ctx.arc(bx, by, 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = isFire ? "#fb923c" : "#f43f5e";
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
      ctx.fillStyle = isFire
        ? "#f97316"
        : isBlackout
          ? "#ef4444"
          : f.building_archetype === "park_stadium"
            ? "#4ade80"
            : "#cbd5e1";
      ctx.fillRect(bx - 1.2, by - 1.2, 2.4, 2.4);
    }

    // Vehicles
    for (const v of vehicles.slice(0, 60)) {
      ctx.fillStyle = v.jammed ? "#ef4444" : "#38bdf8";
      ctx.fillRect(sx(v.x) - 0.8, sy(v.z) - 0.8, 1.8, 1.8);
    }

    // Camera viewport box
    const viewSpanW = Math.min(WORLD_W, 95 / Math.max(0.35, cam.zoom));
    const viewSpanD = Math.min(WORLD_D, 66 / Math.max(0.35, cam.zoom));
    const vx = sx(cam.targetX - viewSpanW * 0.5);
    const vy = sy(cam.targetZ - viewSpanD * 0.5);
    const vw = (viewSpanW / WORLD_W) * MAP_W;
    const vh = (viewSpanD / WORLD_D) * MAP_H;
    ctx.strokeStyle = "#fde047";
    ctx.lineWidth = 1.4;
    ctx.strokeRect(vx, vy, vw, vh);

    // Compass heading arrow at target center
    const cx = sx(cam.targetX);
    const cy = sy(cam.targetZ);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - Math.sin(cam.yaw) * 8, cy - Math.cos(cam.yaw) * 8);
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [blackoutFiles, cam, districts, files, fireFiles, vehicles]);

  function jumpToClientPos(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const rx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const ry = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const wx = WORLD_X0 + rx * WORLD_W;
    const wz = WORLD_Z0 + ry * WORLD_D;
    cameraStore.setState({
      targetX: wx,
      targetZ: wz,
      followVehicleId: null,
      cinematicOrbit: false,
    });
  }

  return (
    <div
      data-testid="minimap-radar"
      className="sim-panel pointer-events-auto hidden overflow-hidden rounded-xl p-1.5 sm:block"
      title="SimCity Radar Minimap — Click or drag to jump camera"
    >
      <div className="mb-1 flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        <span>Radar</span>
        <span className="font-mono text-amber-300">{cameraStore.getCompassLabel()}</span>
      </div>
      <canvas
        ref={canvasRef}
        width={MAP_W}
        height={MAP_H}
        className="block cursor-crosshair rounded-lg border border-slate-700/70"
        onPointerDown={(e) => {
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          jumpToClientPos(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) {
            jumpToClientPos(e.clientX, e.clientY);
          }
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      />
    </div>
  );
}
