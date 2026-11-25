import { memo, useEffect, useRef, useState } from "react";

import type { CitySimulationEngine } from "../game/simEngine";
import type {
  BlastRadiusResult,
  CochangePair,
  DataMapMode,
  District,
  ExternalDep,
  FileImport,
  FileMetric,
} from "../types/city";
import { MAX_ZOOM, MIN_ZOOM, cameraStore, computeMouseYaw, useAltKeyHeld } from "./cameraStore";
import { BuildingTooltip } from "./BuildingTooltip";
import { canvasCursorClass } from "./cityTheme";
import {
  type FloatingStatPopup,
  type GhostLot,
  type HitBuilding,
  type SimVehicleRender,
  cameraFromTarget,
  renderCityScene,
  screenToWorldGround,
} from "./isoRenderer2D";

interface CityCanvas2DProps {
  districts: District[];
  files: FileMetric[];
  imports: FileImport[];
  cochanges: CochangePair[];
  deps: ExternalDep[];
  dataMap: DataMapMode;
  selectedFile: string | null;
  blastRadius: BlastRadiusResult | null;
  addedFiles: Set<string>;
  removedLots: GhostLot[];
  showTraffic: boolean;
  sim?: CitySimulationEngine;
  vehicles?: readonly SimVehicleRender[];
  fireFiles?: ReadonlySet<string>;
  blackoutFiles?: ReadonlySet<string>;
  plazas?: Array<{ x: number; z: number; w: number; d: number; kind: string }>;
  streetLines?: { xLines: number[]; zLines: number[] };
  floatingPopups?: readonly FloatingStatPopup[];
  activeTool?: string;
  onSelectFile: (filePath: string | null) => void;
  onToolAction?: (file: FileMetric) => void;
}

export const CityCanvas2D = memo(function CityCanvas2D({
  districts,
  files,
  imports,
  cochanges,
  deps,
  dataMap,
  selectedFile,
  blastRadius,
  addedFiles,
  removedLots,
  showTraffic,
  sim,
  vehicles = [],
  fireFiles,
  blackoutFiles,
  plazas = [],
  streetLines,
  floatingPopups = [],
  activeTool = "inspect",
  onSelectFile,
  onToolAction,
}: CityCanvas2DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitsRef = useRef<HitBuilding[]>([]);
  const hasAutoFitRef = useRef(false);
  const altHeld = useAltKeyHeld();
  const [yawDragging, setYawDragging] = useState(false);

  const dragRef = useRef<{
    active: boolean;
    mode: "pan" | "paint" | "yaw";
    moved: boolean;
    startX: number;
    startY: number;
    origTargetX: number;
    origTargetZ: number;
    origYaw: number;
    paintedFiles: Set<string>;
  }>({
    active: false,
    mode: "pan",
    moved: false,
    startX: 0,
    startY: 0,
    origTargetX: 70,
    origTargetZ: 52,
    origYaw: Math.PI * 0.25,
    paintedFiles: new Set(),
  });

  const edgeMouseRef = useRef<{ x: number; y: number } | null>(null);
  const [hoveredHit, setHoveredHit] = useState<{
    file: FileMetric;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (hasAutoFitRef.current || !containerRef.current) return;
    const { clientWidth, clientHeight } = containerRef.current;
    if (clientWidth > 0 && clientHeight > 0) {
      hasAutoFitRef.current = true;
      const fitZoom = Math.max(
        0.48,
        Math.min(1.0, Math.min(clientWidth / 1900, clientHeight / 1120)),
      );
      cameraStore.setState({ zoom: Number(fitZoom.toFixed(2)) }, { cancelTween: false });
    }
  }, []);

  const propsRef = useRef({
    districts,
    files,
    imports,
    cochanges,
    deps,
    dataMap,
    selectedFile,
    blastRadius,
    addedFiles,
    removedLots,
    showTraffic,
    sim,
    vehicles,
    fireFiles,
    blackoutFiles,
    plazas,
    streetLines,
    floatingPopups,
    hoveredFile: null as string | null,
  });
  propsRef.current = {
    districts,
    files,
    imports,
    cochanges,
    deps,
    dataMap,
    selectedFile,
    blastRadius,
    addedFiles,
    removedLots,
    showTraffic,
    sim,
    vehicles,
    fireFiles,
    blackoutFiles,
    plazas,
    streetLines,
    floatingPopups,
    hoveredFile: hoveredHit?.file.file_path ?? null,
  };

  useEffect(() => {
    let raf = 0;
    const startMs = performance.now();
    let lastTs = startMs;

    const frame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;

      const canvas = canvasRef.current;
      const box = containerRef.current;
      if (canvas && box) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = box.clientWidth;
        const h = box.clientHeight;
        if (w > 0 && h > 0) {
          if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
          }

          const state = cameraStore.getState();
          if (state.edgeScrollEnabled && edgeMouseRef.current && !dragRef.current.active) {
            const { x: mx, y: my } = edgeMouseRef.current;
            const margin = 28;
            const right = mx < margin ? -1 : mx > w - margin ? 1 : 0;
            const fwd = my < margin ? 1 : my > h - margin ? -1 : 0;
            if (right !== 0 || fwd !== 0) {
              const spd = (32 / Math.max(0.4, state.zoom)) * dt;
              cameraStore.panRelative(right * spd, fwd * spd);
            }
          }

          const latestCam = cameraStore.getState();
          const cam2d = cameraFromTarget(
            latestCam.targetX,
            latestCam.targetZ,
            latestCam.zoom,
            latestCam.yaw,
            latestCam.pitch,
          );

          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.save();
            ctx.scale(dpr, dpr);
            const cur = propsRef.current;
            const simFrame = cur.sim?.getRenderFrame();
            hitsRef.current = renderCityScene({
              ctx,
              width: w,
              height: h,
              camera: cam2d,
              timeSec: (now - startMs) / 1000,
              timeOfDay: latestCam.timeOfDay,
              districts: cur.districts,
              files: cur.files,
              imports: cur.imports,
              cochanges: cur.cochanges,
              deps: cur.deps,
              dataMap: cur.dataMap,
              selectedFile: cur.selectedFile,
              hoveredFile: cur.hoveredFile,
              blastRadius: cur.blastRadius,
              addedFiles: cur.addedFiles,
              removedLots: cur.removedLots,
              showTraffic: cur.showTraffic,
              vehicles: simFrame ? simFrame.vehicles : cur.vehicles,
              fireFiles: simFrame ? simFrame.fireFiles : cur.fireFiles,
              blackoutFiles: simFrame ? simFrame.blackoutFiles : cur.blackoutFiles,
              plazas: cur.plazas,
              streetLines: cur.streetLines,
              floatingPopups: simFrame ? simFrame.floatingPopups : cur.floatingPopups,
            });
            ctx.restore();
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const state = cameraStore.getState();

      if (!e.ctrlKey && (Math.abs(e.deltaX) > 2 || e.shiftKey)) {
        const panSpeed = 0.08 / Math.max(0.35, state.zoom);
        cameraStore.panRelative(e.deltaX * panSpeed, -e.deltaY * panSpeed);
        return;
      }

      const step = e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : e.deltaY < 0 ? 1.12 : 0.89;
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom * step));
      const rect = canvas.getBoundingClientRect();
      const lx = e.clientX - rect.left;
      const ly = e.clientY - rect.top;
      const beforePt = screenToWorldGround(
        lx,
        ly,
        rect.width,
        rect.height,
        cameraFromTarget(state.targetX, state.targetZ, state.zoom, state.yaw, state.pitch),
      );
      const afterPt = screenToWorldGround(
        lx,
        ly,
        rect.width,
        rect.height,
        cameraFromTarget(state.targetX, state.targetZ, nextZoom, state.yaw, state.pitch),
      );
      cameraStore.setState({
        zoom: nextZoom,
        targetX: state.targetX + (beforePt.x - afterPt.x),
        targetZ: state.targetZ + (beforePt.z - afterPt.z),
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  function findHitAt(clientX: number, clientY: number): HitBuilding | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const hits = hitsRef.current;
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (x >= h.minX && x <= h.maxX && y >= h.minY && y <= h.maxY) {
        return h;
      }
    }
    return null;
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const state = cameraStore.getState();
    const isYawRotate = e.altKey && e.button === 0;
    const isSweeperPaint = !isYawRotate && activeTool === "sweeper" && e.button === 0;
    const mode = isYawRotate ? "yaw" : isSweeperPaint ? "paint" : "pan";
    if (isYawRotate) {
      e.preventDefault();
      setYawDragging(true);
      setHoveredHit(null);
      cameraStore.setState({ followVehicleId: null, cinematicOrbit: false });
    } else {
      cameraStore.cancelTween();
    }
    dragRef.current = {
      active: true,
      mode,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      origTargetX: state.targetX,
      origTargetZ: state.targetZ,
      origYaw: state.yaw,
      paintedFiles: new Set(),
    };
    if (isSweeperPaint && onToolAction) {
      const hit = findHitAt(e.clientX, e.clientY);
      if (hit) {
        dragRef.current.paintedFiles.add(hit.file.file_path);
        onToolAction(hit.file);
      }
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      edgeMouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    if (dragRef.current.active) {
      if (dragRef.current.mode === "yaw") {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          dragRef.current.moved = true;
        }
        const h = canvas?.clientHeight || window.innerHeight || 720;
        cameraStore.setState({
          yaw: computeMouseYaw(dragRef.current.origYaw, dx, h),
          cinematicOrbit: false,
        });
        setHoveredHit(null);
        return;
      }

      if (dragRef.current.mode === "paint" && onToolAction) {
        dragRef.current.moved = true;
        const hit = findHitAt(e.clientX, e.clientY);
        if (hit && !dragRef.current.paintedFiles.has(hit.file.file_path)) {
          dragRef.current.paintedFiles.add(hit.file.file_path);
          onToolAction(hit.file);
        }
        return;
      }

      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        dragRef.current.moved = true;
      }
      if (canvas) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const state = cameraStore.getState();
        const baseCam = cameraFromTarget(
          dragRef.current.origTargetX,
          dragRef.current.origTargetZ,
          state.zoom,
          state.yaw,
          state.pitch,
        );
        const pStart = screenToWorldGround(w * 0.5, h * 0.52, w, h, baseCam);
        const pDragged = screenToWorldGround(w * 0.5 - dx, h * 0.52 - dy, w, h, baseCam);
        cameraStore.setState({
          targetX: dragRef.current.origTargetX + (pDragged.x - pStart.x),
          targetZ: dragRef.current.origTargetZ + (pDragged.z - pStart.z),
          followVehicleId: null,
          cinematicOrbit: false,
        });
      }
      setHoveredHit(null);
      return;
    }

    if (e.altKey) {
      setHoveredHit(null);
      return;
    }

    const hit = findHitAt(e.clientX, e.clientY);
    if (hit && canvas) {
      const rect = canvas.getBoundingClientRect();
      setHoveredHit({
        file: hit.file,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    } else {
      setHoveredHit(null);
    }
  }

  function finishDrag(e: React.PointerEvent<HTMLCanvasElement>) {
    dragRef.current.active = false;
    dragRef.current.mode = "pan";
    setYawDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const wasMoved = dragRef.current.moved;
    const wasMode = dragRef.current.mode;
    finishDrag(e);
    if (!wasMoved && wasMode === "pan") {
      const hit = findHitAt(e.clientX, e.clientY);
      if (hit && activeTool !== "inspect" && onToolAction) {
        onToolAction(hit.file);
      } else {
        onSelectFile(hit ? hit.file.file_path : null);
      }
    }
  }

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        data-testid="city-canvas-2d"
        className={`block h-full w-full ${canvasCursorClass(activeTool, Boolean(hoveredHit), altHeld || yawDragging)}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={finishDrag}
        onPointerLeave={() => {
          setHoveredHit(null);
          edgeMouseRef.current = null;
        }}
      />

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
});
