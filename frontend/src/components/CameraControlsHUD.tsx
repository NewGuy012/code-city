import {
  Bookmark,
  Camera,
  Compass,
  Map,
  Maximize2,
  Minus,
  Moon,
  MousePointerClick,
  Orbit,
  Plus,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sun,
  Sunset,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  type CameraBookmark,
  type CameraPresetId,
  MAX_PITCH,
  MAX_ZOOM,
  MIN_PITCH,
  MIN_ZOOM,
  type TimeOfDay,
  cameraStore,
  deleteRepoBookmark,
  loadRepoBookmarks,
  saveRepoBookmark,
  useCameraStore,
} from "../city/cameraStore";

interface CameraControlsHUDProps {
  viewMode: "2d" | "3d";
  onToggleViewMode: () => void;
  repoKey: string;
  showTraffic: boolean;
  onToggleTraffic: () => void;
  radarOpen: boolean;
  onToggleRadar: () => void;
  hasRadarAlert?: boolean;
  isViewPopoverOpen: boolean;
  onToggleViewPopover: () => void;
}

const PRESETS: Array<{ id: CameraPresetId; label: string; hint: string }> = [
  { id: 1, label: "1·Island", hint: "Overview / Fit Island (1)" },
  { id: 2, label: "2·Iso", hint: "Classic Isometric Diorama (2)" },
  { id: 3, label: "3·Street", hint: "Street-Level Avenue View (3)" },
  { id: 4, label: "4·Follow", hint: "Follow Vehicle Cam (4)" },
  { id: 5, label: "5·Orbit", hint: "Cinematic Turntable Orbit (5)" },
];

const LIGHTING_MODES: Array<{ id: TimeOfDay; label: string; icon: typeof Sun }> = [
  { id: "day", label: "Day", icon: Sun },
  { id: "golden", label: "Golden", icon: Sunset },
  { id: "night", label: "Night", icon: Moon },
];

export function CameraControlsHUD({
  viewMode,
  onToggleViewMode,
  repoKey,
  showTraffic,
  onToggleTraffic,
  radarOpen,
  onToggleRadar,
  hasRadarAlert = false,
  isViewPopoverOpen,
  onToggleViewPopover,
}: CameraControlsHUDProps) {
  const cam = useCameraStore();
  const [bookmarks, setBookmarks] = useState<CameraBookmark[]>([]);
  const [bmName, setBmName] = useState("");

  useEffect(() => {
    setBookmarks(loadRepoBookmarks(repoKey));
  }, [repoKey]);

  const compassDeg = Math.round(((cam.yaw - Math.PI * 0.25) * 180) / Math.PI);
  const compassLabel = cameraStore.getCompassLabel();
  const hasCustomView =
    cam.timeOfDay !== "day" ||
    cam.cinematicOrbit ||
    Boolean(cam.followVehicleId) ||
    !showTraffic ||
    bookmarks.length > 0;

  return (
    <div
      data-testid="camera-controls-hud"
      className="sim-panel pointer-events-auto relative flex h-9 items-center gap-1 rounded-xl px-1.5 text-[11px]"
    >
      {/* 2D | 3D Segmented Switch */}
      <button
        type="button"
        data-testid="toggle-2d-3d"
        onClick={onToggleViewMode}
        title="Switch between 2D Isometric and 3D WebGL view"
        className="flex h-6 items-center rounded-lg bg-slate-950/60 p-0.5 font-mono text-[10px] font-bold ring-1 ring-white/10"
      >
        <span
          className={`rounded-md px-1.5 py-0.5 transition ${
            viewMode === "2d" ? "bg-sky-500/25 text-sky-300" : "text-slate-400"
          }`}
        >
          2D
        </span>
        <span
          className={`rounded-md px-1.5 py-0.5 transition ${
            viewMode === "3d" ? "bg-sky-500/25 text-sky-300" : "text-slate-400"
          }`}
        >
          3D
        </span>
      </button>

      <div className="mx-0.5 h-4 w-px bg-white/10" />

      {/* Zoom Controls & Fit Island */}
      <button
        type="button"
        onClick={() =>
          cameraStore.flyTo({ zoom: Math.max(MIN_ZOOM, cam.zoom * 0.8), durationMs: 220 })
        }
        title="Zoom Out (-)"
        aria-label="Zoom out"
        className="rounded-lg p-1 text-slate-300 transition hover:bg-white/[0.08] hover:text-white"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        data-testid="fit-city-btn"
        onClick={() => cameraStore.applyPreset(1)}
        title="Fit City Island (0 / Home)"
        className="sim-pixel-badge min-w-10 rounded-lg px-1 py-0.5 text-center font-mono text-slate-200 transition hover:bg-white/[0.08] hover:text-white"
      >
        {Math.round(cam.zoom * 100)}%
      </button>
      <button
        type="button"
        onClick={() =>
          cameraStore.flyTo({ zoom: Math.min(MAX_ZOOM, cam.zoom * 1.25), durationMs: 220 })
        }
        title="Zoom In (+)"
        aria-label="Zoom in"
        className="rounded-lg p-1 text-slate-300 transition hover:bg-white/[0.08] hover:text-white"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>

      {/* Compass North Button */}
      <button
        type="button"
        data-testid="compass-rose-btn"
        onClick={() => cameraStore.flyTo({ yaw: Math.PI * 0.25, durationMs: 360 })}
        title="Compass Heading — Click to snap North (Q / E to rotate)"
        className="flex h-6 items-center gap-1 rounded-lg bg-white/[0.06] px-1.5 font-mono font-bold text-slate-200 transition hover:bg-white/[0.12] hover:text-white"
      >
        <Compass
          className="h-3.5 w-3.5 text-sky-400 transition-transform"
          style={{ transform: `rotate(${-compassDeg}deg)` }}
        />
        <span>{compassLabel}</span>
      </button>

      <div className="mx-0.5 h-4 w-px bg-white/10" />

      {/* View & Camera Popover */}
      <div data-popover-id="view" className="relative">
        <button
          type="button"
          data-testid="camera-view-btn"
          onClick={onToggleViewPopover}
          title="Camera presets, rotation, pitch, lighting, traffic & bookmarks"
          aria-label="View settings"
          className={`relative flex h-7 w-7 items-center justify-center rounded-lg transition ${
            isViewPopoverOpen
              ? "bg-white/[0.12] text-white ring-1 ring-white/15"
              : "text-slate-300 hover:bg-white/[0.08] hover:text-white"
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {hasCustomView && !isViewPopoverOpen && (
            <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-amber-400" />
          )}
        </button>

        {isViewPopoverOpen && (
          <div
            data-testid="camera-view-popover"
            className="sim-popover absolute right-0 bottom-11 z-40 w-72 space-y-3 rounded-2xl p-3 text-xs"
          >
            {/* Camera Presets */}
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Camera Presets
              </div>
              <div className="grid grid-cols-5 gap-1">
                {PRESETS.map((p) => {
                  const active =
                    cam.preset === p.id &&
                    (p.id !== 5 || cam.cinematicOrbit) &&
                    (p.id !== 4 || Boolean(cam.followVehicleId));
                  return (
                    <button
                      key={p.id}
                      type="button"
                      data-testid={`cam-preset-${p.id}`}
                      onClick={() => cameraStore.applyPreset(p.id)}
                      title={p.hint}
                      className={`rounded-lg py-1 font-mono text-[10px] font-semibold transition ${
                        active
                          ? "bg-amber-400 text-slate-950"
                          : "bg-white/[0.06] text-slate-300 hover:bg-white/[0.12] hover:text-white"
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Rotation & Pitch */}
            <div className="space-y-2 border-t border-white/10 pt-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-300">Orientation</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="rotate-ccw-btn"
                    onClick={() => cameraStore.rotateCompass(-1)}
                    title="Rotate Left 90° (Q)"
                    className="rounded-lg bg-white/[0.06] p-1 text-slate-300 hover:bg-white/[0.12] hover:text-white"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => cameraStore.applyPreset(1)}
                    title="Fit Island (0 / Home)"
                    className="rounded-lg bg-white/[0.06] p-1 text-slate-300 hover:bg-white/[0.12] hover:text-white"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    data-testid="rotate-cw-btn"
                    onClick={() => cameraStore.rotateCompass(1)}
                    title="Rotate Right 90° (E)"
                    className="rounded-lg bg-white/[0.06] p-1 text-slate-300 hover:bg-white/[0.12] hover:text-white"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <label className="flex items-center justify-between gap-2 text-[11px] text-slate-300">
                <span>Pitch</span>
                <input
                  type="range"
                  data-testid="pitch-slider"
                  min={MIN_PITCH}
                  max={MAX_PITCH}
                  step={1}
                  value={Math.round(cam.pitch)}
                  onChange={(e) => cameraStore.setState({ pitch: Number(e.target.value) })}
                  className="h-1 flex-1 cursor-pointer accent-sky-400"
                />
                <span className="w-7 text-right font-mono text-slate-400">
                  {Math.round(cam.pitch)}°
                </span>
              </label>
            </div>

            {/* Atmosphere & Scene */}
            <div className="space-y-2 border-t border-white/10 pt-2.5">
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-950/60 p-0.5 ring-1 ring-white/10">
                {LIGHTING_MODES.map((m) => {
                  const Icon = m.icon;
                  const active = cam.timeOfDay === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      data-testid={`time-of-day-${m.id}`}
                      onClick={() => cameraStore.setState({ timeOfDay: m.id })}
                      className={`flex items-center justify-center gap-1 rounded-lg py-1 text-[11px] font-medium transition ${
                        active
                          ? "bg-white/[0.12] text-amber-300"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      <Icon className="h-3 w-3" />
                      <span>{m.label}</span>
                    </button>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={onToggleTraffic}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition ${
                    showTraffic
                      ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-400/30"
                      : "bg-white/[0.05] text-slate-400 hover:text-white"
                  }`}
                >
                  <Orbit className="h-3 w-3" />
                  <span>Traffic</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    cameraStore.setState({ edgeScrollEnabled: !cam.edgeScrollEnabled })
                  }
                  title="Toggle screen-edge camera scrolling"
                  className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition ${
                    cam.edgeScrollEnabled
                      ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/30"
                      : "bg-white/[0.05] text-slate-400 hover:text-white"
                  }`}
                >
                  <MousePointerClick className="h-3 w-3" />
                  <span>Edge Pan</span>
                </button>

                {viewMode === "3d" && (
                  <button
                    type="button"
                    data-testid="toggle-projection-btn"
                    onClick={() => cameraStore.toggleProjection()}
                    title="Switch Orthographic <-> Perspective 3D"
                    className="flex items-center justify-center gap-1 rounded-lg bg-white/[0.07] px-2 py-1 text-[11px] font-semibold text-sky-300 hover:bg-white/[0.12]"
                  >
                    <Camera className="h-3 w-3" />
                    <span>{cam.projection === "orthographic" ? "Ortho" : "Persp"}</span>
                  </button>
                )}
              </div>
            </div>

            {/* Saved Viewpoints */}
            <div className="border-t border-white/10 pt-2.5">
              <div className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                <Bookmark className="h-3 w-3 text-amber-300" />
                <span>Viewpoint Bookmarks ({bookmarks.length})</span>
              </div>
              <div className="flex gap-1">
                <input
                  type="text"
                  value={bmName}
                  onChange={(e) => setBmName(e.target.value)}
                  placeholder="Viewpoint name..."
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/80 px-2 py-1 text-[11px] text-slate-100 placeholder-slate-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    setBookmarks(saveRepoBookmark(repoKey, bmName));
                    setBmName("");
                  }}
                  className="rounded-lg bg-amber-400 px-2.5 py-1 text-[11px] font-bold text-slate-950 hover:bg-amber-300"
                >
                  Save
                </button>
              </div>
              {bookmarks.length > 0 && (
                <div className="sim-scrollbar mt-2 max-h-28 space-y-1 overflow-y-auto">
                  {bookmarks.map((bm) => (
                    <div
                      key={bm.id}
                      className="flex items-center justify-between gap-1 rounded-lg bg-white/[0.05] px-2 py-1"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          cameraStore.setState({
                            projection: bm.projection,
                            followVehicleId: null,
                            cinematicOrbit: false,
                          });
                          cameraStore.flyTo({
                            targetX: bm.targetX,
                            targetZ: bm.targetZ,
                            zoom: bm.zoom,
                            yaw: bm.yaw,
                            pitch: bm.pitch,
                          });
                        }}
                        className="truncate text-left text-[11px] text-slate-200 hover:text-amber-300"
                      >
                        {bm.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => setBookmarks(deleteRepoBookmark(repoKey, bm.id))}
                        className="text-slate-500 hover:text-rose-400"
                        title="Delete bookmark"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Radar Minimap Toggle */}
      <button
        type="button"
        data-testid="toggle-radar-btn"
        onClick={onToggleRadar}
        title="Toggle Radar Minimap (M)"
        aria-label="Toggle Radar"
        className={`relative flex h-7 w-7 items-center justify-center rounded-lg transition ${
          radarOpen
            ? "bg-white/[0.12] text-sky-300 ring-1 ring-white/15"
            : "text-slate-300 hover:bg-white/[0.08] hover:text-white"
        }`}
      >
        <Map className="h-3.5 w-3.5" />
        {!radarOpen && hasRadarAlert && (
          <span className="absolute top-1 right-1 h-1.5 w-1.5 animate-ping rounded-full bg-rose-400" />
        )}
      </button>
    </div>
  );
}
