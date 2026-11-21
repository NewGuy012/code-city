import {
  Bookmark,
  Camera,
  Compass,
  Maximize2,
  Minus,
  Moon,
  MousePointerClick,
  Orbit,
  Plus,
  RotateCcw,
  RotateCw,
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
  cameraStore,
  deleteRepoBookmark,
  loadRepoBookmarks,
  saveRepoBookmark,
  useCameraStore,
} from "../city/cameraStore";

interface CameraControlsHUDProps {
  viewMode: "2d" | "3d";
  repoKey: string;
  showTraffic: boolean;
  onToggleTraffic: () => void;
}

const PRESETS: Array<{ id: CameraPresetId; label: string; hint: string }> = [
  { id: 1, label: "1·Island", hint: "Overview / Fit Island (1)" },
  { id: 2, label: "2·Iso", hint: "Classic Isometric Diorama (2)" },
  { id: 3, label: "3·Street", hint: "Street-Level Avenue View (3)" },
  { id: 4, label: "4·Follow", hint: "Follow Vehicle Cam (4)" },
  { id: 5, label: "5·Orbit", hint: "Cinematic Turntable Orbit (5)" },
];

export function CameraControlsHUD({
  viewMode,
  repoKey,
  showTraffic,
  onToggleTraffic,
}: CameraControlsHUDProps) {
  const cam = useCameraStore();
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<CameraBookmark[]>([]);
  const [bmName, setBmName] = useState("");

  useEffect(() => {
    setBookmarks(loadRepoBookmarks(repoKey));
  }, [repoKey]);

  const compassDeg = Math.round(((cam.yaw - Math.PI * 0.25) * 180) / Math.PI);
  const compassLabel = cameraStore.getCompassLabel();

  const TimeIcon = cam.timeOfDay === "day" ? Sun : cam.timeOfDay === "golden" ? Sunset : Moon;

  return (
    <div
      data-testid="camera-controls-hud"
      className="sim-panel pointer-events-auto flex flex-col gap-1.5 rounded-2xl p-2 text-[11px]"
    >
      {/* Row 1: Compass Rose, Zoom, Fit, Time-of-Day, Projection */}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          data-testid="rotate-ccw-btn"
          onClick={() => cameraStore.rotateCompass(-1)}
          title="Rotate Left 90° (Q)"
          className="rounded-lg p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          data-testid="compass-rose-btn"
          onClick={() => cameraStore.flyTo({ yaw: Math.PI * 0.25, durationMs: 360 })}
          title="Compass Heading — Click to snap North"
          className="flex items-center gap-1 rounded-lg bg-slate-900/90 px-2 py-1 font-mono font-bold text-amber-300 ring-1 ring-slate-700 hover:bg-slate-800"
        >
          <Compass
            className="h-3.5 w-3.5 text-sky-400 transition-transform"
            style={{ transform: `rotate(${-compassDeg}deg)` }}
          />
          <span>{compassLabel}</span>
        </button>

        <button
          type="button"
          data-testid="rotate-cw-btn"
          onClick={() => cameraStore.rotateCompass(1)}
          title="Rotate Right 90° (E)"
          className="rounded-lg p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>

        <div className="mx-0.5 h-4 w-px bg-slate-700" />

        <button
          type="button"
          onClick={() => cameraStore.flyTo({ zoom: Math.min(MAX_ZOOM, cam.zoom * 1.25), durationMs: 220 })}
          title="Zoom In (+)"
          className="rounded-lg p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <span className="sim-pixel-badge min-w-9 text-center font-mono text-slate-200">
          {Math.round(cam.zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => cameraStore.flyTo({ zoom: Math.max(MIN_ZOOM, cam.zoom * 0.8), durationMs: 220 })}
          title="Zoom Out (-)"
          className="rounded-lg p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid="fit-city-btn"
          onClick={() => cameraStore.applyPreset(1)}
          title="Fit City Island (0 / Home)"
          className="rounded-lg p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>

        <div className="mx-0.5 h-4 w-px bg-slate-700" />

        <button
          type="button"
          data-testid="time-of-day-btn"
          onClick={() => cameraStore.cycleTimeOfDay()}
          title="Cycle Lighting: Day / Golden Hour / Night"
          className="flex items-center gap-1 rounded-lg bg-slate-900/90 px-2 py-1 font-medium text-amber-200 hover:bg-slate-800"
        >
          <TimeIcon className="h-3.5 w-3.5 text-amber-400" />
          <span className="capitalize">{cam.timeOfDay}</span>
        </button>

        {viewMode === "3d" && (
          <button
            type="button"
            data-testid="toggle-projection-btn"
            onClick={() => cameraStore.toggleProjection()}
            title="Switch Orthographic <-> Perspective 3D"
            className="flex items-center gap-1 rounded-lg bg-sky-500/15 px-2 py-1 font-semibold text-sky-300 ring-1 ring-sky-400/35 hover:bg-sky-500/25"
          >
            <Camera className="h-3 w-3" />
            <span>{cam.projection === "orthographic" ? "Ortho" : "Persp"}</span>
          </button>
        )}

        <button
          type="button"
          onClick={onToggleTraffic}
          className={`flex items-center gap-1 rounded-lg px-2 py-1 font-medium transition ${
            showTraffic ? "bg-sky-500/20 text-sky-300" : "text-slate-400 hover:bg-slate-800"
          }`}
          title="Toggle live street traffic"
        >
          <Orbit className="h-3 w-3" />
          <span>Traffic</span>
        </button>
      </div>

      {/* Row 2: Camera Presets (1-5), Pitch Slider, Edge Scroll & Bookmarks */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-0.5">
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
                className={`rounded-lg px-1.5 py-0.5 font-mono text-[10px] font-semibold transition ${
                  active
                    ? "bg-amber-500 text-slate-950"
                    : "bg-slate-900/80 text-slate-300 hover:bg-slate-800 hover:text-white"
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <label className="flex items-center gap-1.5 text-[10px] text-slate-300" title="Tilt / Pitch (R / F)">
          <span>Pitch</span>
          <input
            type="range"
            data-testid="pitch-slider"
            min={MIN_PITCH}
            max={MAX_PITCH}
            step={1}
            value={Math.round(cam.pitch)}
            onChange={(e) => cameraStore.setState({ pitch: Number(e.target.value) })}
            className="h-1 w-16 cursor-pointer accent-sky-400"
          />
          <span className="w-6 font-mono text-slate-400">{Math.round(cam.pitch)}°</span>
        </label>

        <button
          type="button"
          onClick={() => cameraStore.setState({ edgeScrollEnabled: !cam.edgeScrollEnabled })}
          title="Toggle screen-edge camera scrolling"
          className={`rounded-lg p-1 ${
            cam.edgeScrollEnabled
              ? "bg-emerald-500/20 text-emerald-300"
              : "text-slate-400 hover:bg-slate-800 hover:text-white"
          }`}
        >
          <MousePointerClick className="h-3.5 w-3.5" />
        </button>

        <div className="relative">
          <button
            type="button"
            data-testid="bookmarks-toggle-btn"
            onClick={() => setBookmarksOpen((v) => !v)}
            title="Saved Viewpoint Bookmarks"
            className={`flex items-center gap-1 rounded-lg px-1.5 py-0.5 ${
              bookmarksOpen
                ? "bg-amber-500/20 text-amber-300"
                : "text-slate-300 hover:bg-slate-800 hover:text-white"
            }`}
          >
            <Bookmark className="h-3.5 w-3.5" />
            <span>{bookmarks.length}</span>
          </button>

          {bookmarksOpen && (
            <div className="sim-panel absolute bottom-9 left-0 z-40 w-64 rounded-xl p-2.5 text-xs">
              <div className="mb-2 font-semibold text-amber-300">Camera Bookmarks</div>
              <div className="flex gap-1">
                <input
                  type="text"
                  value={bmName}
                  onChange={(e) => setBmName(e.target.value)}
                  placeholder="Viewpoint name..."
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => {
                    setBookmarks(saveRepoBookmark(repoKey, bmName));
                    setBmName("");
                  }}
                  className="rounded-lg bg-amber-500 px-2 py-1 text-[11px] font-bold text-slate-950 hover:bg-amber-400"
                >
                  Save
                </button>
              </div>
              <div className="mt-2 max-h-36 space-y-1 overflow-y-auto">
                {bookmarks.length === 0 ? (
                  <p className="text-[11px] text-slate-500">No bookmarks for this repo yet.</p>
                ) : (
                  bookmarks.map((bm) => (
                    <div
                      key={bm.id}
                      className="flex items-center justify-between gap-1 rounded-lg bg-slate-900/90 px-2 py-1"
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
                          setBookmarksOpen(false);
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
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
