import { Compass, Maximize2, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  BlastRadiusResult,
  CochangePair,
  DataMapMode,
  District,
  ExternalDep,
  FileImport,
  FileMetric,
} from "../types/city";
import {
  type Camera2D,
  type GhostLot,
  type HitBuilding,
  renderCityScene,
  worldToIso,
} from "./isoRenderer2D";

export interface FocusTarget {
  x: number;
  z: number;
  zoom?: number;
  nonce: number;
}

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
  focusTarget: FocusTarget | null;
  onSelectFile: (filePath: string | null) => void;
}

export function CityCanvas2D({
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
  focusTarget,
  onSelectFile,
}: CityCanvas2DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitsRef = useRef<HitBuilding[]>([]);
  const cameraRef = useRef<Camera2D>({ panX: 0, panY: -10, zoom: 0.92 });
  const targetCameraRef = useRef<Camera2D | null>(null);
  const dragRef = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    origPanX: number;
    origPanY: number;
  }>({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    origPanX: 0,
    origPanY: 0,
  });

  const [hoveredHit, setHoveredHit] = useState<{
    file: FileMetric;
    x: number;
    y: number;
  } | null>(null);
  const [showTraffic, setShowTraffic] = useState(true);
  const [zoomLabel, setZoomLabel] = useState(92);

  // Fly smoothly to guided tour / advisor target
  useEffect(() => {
    if (!focusTarget) return;
    const iso = worldToIso(focusTarget.x, focusTarget.z, 10);
    const nextZoom = focusTarget.zoom ?? Math.max(1.25, cameraRef.current.zoom);
    targetCameraRef.current = {
      panX: -iso.x * nextZoom,
      panY: -iso.y * nextZoom,
      zoom: nextZoom,
    };
  }, [focusTarget]);

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
    hoveredFile: hoveredHit?.file.file_path ?? null,
  };

  useEffect(() => {
    let raf = 0;
    const startMs = performance.now();

    const frame = (now: number) => {
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

          if (targetCameraRef.current) {
            const tgt = targetCameraRef.current;
            const cur = cameraRef.current;
            cur.panX += (tgt.panX - cur.panX) * 0.14;
            cur.panY += (tgt.panY - cur.panY) * 0.14;
            cur.zoom += (tgt.zoom - cur.zoom) * 0.14;
            if (
              Math.abs(tgt.panX - cur.panX) < 0.4 &&
              Math.abs(tgt.panY - cur.panY) < 0.4 &&
              Math.abs(tgt.zoom - cur.zoom) < 0.005
            ) {
              cameraRef.current = { ...tgt };
              targetCameraRef.current = null;
              setZoomLabel(Math.round(cameraRef.current.zoom * 100));
            }
          }

          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.save();
            ctx.scale(dpr, dpr);
            const cur = propsRef.current;
            hitsRef.current = renderCityScene({
              ctx,
              width: w,
              height: h,
              camera: cameraRef.current,
              timeSec: (now - startMs) / 1000,
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
    targetCameraRef.current = null;
    dragRef.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      origPanX: cameraRef.current.panX,
      origPanY: cameraRef.current.panY,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (dragRef.current.active) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        dragRef.current.moved = true;
      }
      cameraRef.current.panX = dragRef.current.origPanX + dx;
      cameraRef.current.panY = dragRef.current.origPanY + dy;
      setHoveredHit(null);
      return;
    }

    const hit = findHitAt(e.clientX, e.clientY);
    if (hit) {
      const rect = e.currentTarget.getBoundingClientRect();
      setHoveredHit({
        file: hit.file,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    } else {
      setHoveredHit(null);
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const wasMoved = dragRef.current.moved;
    dragRef.current.active = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (!wasMoved) {
      const hit = findHitAt(e.clientX, e.clientY);
      onSelectFile(hit ? hit.file.file_path : null);
    }
  }

  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    targetCameraRef.current = null;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const oldZoom = cameraRef.current.zoom;
    const nextZoom = Math.max(0.35, Math.min(3.5, oldZoom * factor));
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width * 0.5;
    const cy = e.clientY - rect.top - rect.height * 0.52;
    const scale = nextZoom / oldZoom;
    cameraRef.current.panX = cx - (cx - cameraRef.current.panX) * scale;
    cameraRef.current.panY = cy - (cy - cameraRef.current.panY) * scale;
    cameraRef.current.zoom = nextZoom;
    setZoomLabel(Math.round(nextZoom * 100));
  }

  function zoomBy(factor: number) {
    const nextZoom = Math.max(0.35, Math.min(3.5, cameraRef.current.zoom * factor));
    targetCameraRef.current = {
      ...cameraRef.current,
      zoom: nextZoom,
    };
  }

  function fitCity() {
    targetCameraRef.current = { panX: 0, panY: -10, zoom: 0.92 };
  }

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        data-testid="city-canvas-2d"
        className="block h-full w-full cursor-grab active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => setHoveredHit(null)}
        onWheel={handleWheel}
      />

      {/* Hover Tooltip */}
      {hoveredHit && (
        <div
          className="pointer-events-none absolute z-20 max-w-xs rounded-xl border border-slate-600/50 bg-slate-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur"
          style={{
            left: Math.min(window.innerWidth - 260, hoveredHit.x + 14),
            top: Math.max(12, hoveredHit.y - 68),
          }}
        >
          <div className="truncate font-mono font-semibold text-amber-300">
            {hoveredHit.file.file_path}
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-slate-300">
            <span className="rounded bg-slate-800 px-1.5 py-0.5 capitalize">
              {hoveredHit.file.building_archetype.replace("_", " ")}
            </span>
            <span>{hoveredHit.file.sloc} SLOC</span>
            <span>Cx {hoveredHit.file.max_complexity}</span>
            <span>Hotspot {hoveredHit.file.hotspot_score.toFixed(1)}</span>
          </div>
          {(hoveredHit.file.lint_issue_count > 0 ||
            hoveredHit.file.condition_flags?.crane ||
            hoveredHit.file.condition_flags?.lone_keeper) && (
            <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
              {hoveredHit.file.condition_flags?.crane && (
                <span className="text-amber-400">🏗️ Active Churn</span>
              )}
              {hoveredHit.file.lint_issue_count > 0 && (
                <span className="text-purple-300">🌫️ {hoveredHit.file.lint_issue_count} lints</span>
              )}
              {hoveredHit.file.condition_flags?.lone_keeper && (
                <span className="text-rose-400">🚨 Bus Factor 1</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Bottom-left Camera Controls */}
      <div className="sim-panel absolute bottom-20 left-4 z-10 flex items-center gap-1 rounded-xl p-1.5 text-xs">
        <button
          type="button"
          onClick={() => zoomBy(1.22)}
          title="Zoom In"
          className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          <Plus className="h-4 w-4" />
        </button>
        <span className="sim-pixel-badge min-w-11 text-center font-mono text-slate-300">
          {zoomLabel}%
        </span>
        <button
          type="button"
          onClick={() => zoomBy(0.82)}
          title="Zoom Out"
          className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={fitCity}
          title="Fit City Skyline"
          className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
        <div className="mx-0.5 h-4 w-px bg-slate-700" />
        <button
          type="button"
          onClick={() => setShowTraffic((v) => !v)}
          className={`flex items-center gap-1 rounded-lg px-2 py-1 font-medium transition ${
            showTraffic
              ? "bg-sky-500/20 text-sky-300"
              : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          }`}
          title="Toggle import traffic pulses"
        >
          <Compass className="h-3.5 w-3.5" />
          Traffic
        </button>
      </div>
    </div>
  );
}
