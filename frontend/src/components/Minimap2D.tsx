import { X } from "lucide-react";
import { memo, useCallback, useEffect, useRef } from "react";

import { cameraStore, useCameraStore } from "../city/cameraStore";
import { ZONE_PALETTES } from "../city/cityTheme";
import type { SimVehicleRender } from "../city/isoRenderer2D";
import type { CitySimulationEngine } from "../game/simEngine";
import type { District, FileMetric } from "../types/city";

interface Minimap2DProps {
  districts: District[];
  files: FileMetric[];
  sim?: CitySimulationEngine;
  showTraffic?: boolean;
  vehicles?: SimVehicleRender[];
  fireFiles?: ReadonlySet<string>;
  blackoutFiles?: ReadonlySet<string>;
  onClose?: () => void;
}

const MAP_W = 168;
const MAP_H = 120;
const WORLD_W = 148;
const WORLD_D = 112;
const WORLD_X0 = -4;
const WORLD_Z0 = -4;

function isAmbientVehicle(type: SimVehicleRender["type"]): boolean {
  return type === "request_car" || type === "cycle_car" || type === "cargo_ship";
}

export const Minimap2D = memo(function Minimap2D({
  districts,
  files,
  sim,
  showTraffic = false,
  vehicles = [],
  fireFiles,
  blackoutFiles,
  onClose,
}: Minimap2DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);
  const cam = useCameraStore();

  const latestRef = useRef({
    districts,
    files,
    sim,
    showTraffic,
    vehicles,
    fireFiles,
    blackoutFiles,
    cam,
  });
  latestRef.current = {
    districts,
    files,
    sim,
    showTraffic,
    vehicles,
    fireFiles,
    blackoutFiles,
    cam,
  };

  const drawRadar = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cur = latestRef.current;
    const frame = cur.sim?.getRenderFrame();
    const activeVehicles = frame ? frame.vehicles : cur.vehicles;
    const activeFires = frame ? frame.fireFiles : cur.fireFiles;
    const activeBlackouts = frame ? frame.blackoutFiles : cur.blackoutFiles;
    const curCam = cur.cam;

    const sx = (wx: number) => ((wx - WORLD_X0) / WORLD_W) * MAP_W;
    const sy = (wz: number) => ((wz - WORLD_Z0) / WORLD_D) * MAP_H;

    ctx.clearRect(0, 0, MAP_W, MAP_H);
    const oceanGrad = ctx.createLinearGradient(0, 0, 0, MAP_H);
    oceanGrad.addColorStop(0, "#1d5d86");
    oceanGrad.addColorStop(1, "#134263");
    ctx.fillStyle = oceanGrad;
    ctx.fillRect(0, 0, MAP_W, MAP_H);

    // Coastal shallow halo & organic island base
    const ix = sx(0);
    const iy = sy(0);
    const iw = (140 / WORLD_W) * MAP_W;
    const ih = (104 / WORLD_D) * MAP_H;
    ctx.fillStyle = "rgba(56, 189, 248, 0.24)";
    ctx.beginPath();
    ctx.roundRect(ix - 5, iy - 5, iw + 10, ih + 10, 14);
    ctx.fill();

    ctx.fillStyle = "#c7bc97";
    ctx.beginPath();
    ctx.roundRect(ix - 2, iy - 2, iw + 4, ih + 4, 9);
    ctx.fill();

    ctx.fillStyle = "#4b7d46";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.roundRect(ix, iy, iw, ih, 6);
    ctx.fill();
    ctx.stroke();

    // Districts
    for (const d of cur.districts) {
      const zStyle = ZONE_PALETTES[d.zone_type];
      const col = zStyle?.border ?? "#94a3b8";
      ctx.fillStyle = zStyle ? `${zStyle.ground}cc` : `${col}33`;
      ctx.strokeStyle = `${col}99`;
      ctx.lineWidth = 0.7;
      const x = sx(d.bounds_x);
      const y = sy(d.bounds_z);
      const w = (d.bounds_w / WORLD_W) * MAP_W;
      const h = (d.bounds_d / WORLD_D) * MAP_H;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }

    // Buildings & disaster pings
    for (const f of cur.files) {
      const bx = sx(f.layout_x + f.layout_w * 0.5);
      const by = sy(f.layout_z + f.layout_d * 0.5);
      const isFire = activeFires?.has(f.file_path);
      const isBlackout = activeBlackouts?.has(f.file_path);
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
            ? "#22c55e"
            : "#e2e8f0";
      ctx.fillRect(bx - 1.2, by - 1.2, 2.4, 2.4);
    }

    // Vehicles
    let drawn = 0;
    for (const v of activeVehicles) {
      if (!cur.showTraffic && isAmbientVehicle(v.type)) continue;
      ctx.fillStyle = v.jammed ? "#ef4444" : "#38bdf8";
      ctx.fillRect(sx(v.x) - 0.8, sy(v.z) - 0.8, 1.8, 1.8);
      if (++drawn >= 60) break;
    }

    // Camera viewport box
    const viewSpanW = Math.min(WORLD_W, 95 / Math.max(0.35, curCam.zoom));
    const viewSpanD = Math.min(WORLD_D, 66 / Math.max(0.35, curCam.zoom));
    const vx = sx(curCam.targetX - viewSpanW * 0.5);
    const vy = sy(curCam.targetZ - viewSpanD * 0.5);
    const vw = (viewSpanW / WORLD_W) * MAP_W;
    const vh = (viewSpanD / WORLD_D) * MAP_H;
    ctx.strokeStyle = "#fde047";
    ctx.lineWidth = 1.4;
    ctx.strokeRect(vx, vy, vw, vh);

    // Compass heading arrow at target center
    const cx = sx(curCam.targetX);
    const cy = sy(curCam.targetZ);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - Math.sin(curCam.yaw) * 8, cy - Math.cos(curCam.yaw) * 8);
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, []);

  useEffect(() => {
    drawRadar();
  }, [blackoutFiles, cam, districts, drawRadar, files, fireFiles, showTraffic, vehicles]);

  useEffect(() => {
    if (!sim) return;
    return sim.subscribeRender(drawRadar);
  }, [drawRadar, sim]);

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
      className="sim-panel pointer-events-auto overflow-hidden rounded-xl p-1.5"
      title="City Radar Minimap — Click or drag to jump camera (M to toggle)"
    >
      <div className="mb-1 flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        <span>Radar</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide radar"
            className="rounded p-0.5 text-slate-400 transition hover:bg-white/[0.08] hover:text-white"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <canvas
        ref={canvasRef}
        width={MAP_W}
        height={MAP_H}
        className="block cursor-crosshair rounded-lg border border-white/10"
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
});
