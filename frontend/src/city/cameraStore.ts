import { useEffect, useState } from "react";

import { isTypingTarget } from "../components/hudPopover";

export type CameraProjection = "perspective" | "orthographic";
export type TimeOfDay = "day" | "golden" | "night";
export type CameraPresetId = 1 | 2 | 3 | 4 | 5;

export interface CameraBookmark {
  id: string;
  name: string;
  targetX: number;
  targetZ: number;
  zoom: number;
  yaw: number;
  pitch: number;
  projection: CameraProjection;
  createdAt: string;
}

export interface UnifiedCameraState {
  targetX: number;
  targetZ: number;
  zoom: number;
  yaw: number;
  pitch: number;
  projection: CameraProjection;
  timeOfDay: TimeOfDay;
  preset: CameraPresetId;
  followVehicleId: string | null;
  cinematicOrbit: boolean;
  edgeScrollEnabled: boolean;
}

export interface FlyToOptions {
  targetX?: number;
  targetZ?: number;
  zoom?: number;
  yaw?: number;
  pitch?: number;
  durationMs?: number;
}

export const WORLD_CENTER_X = 70;
export const WORLD_CENTER_Z = 52;
export const DEFAULT_YAW = Math.PI * 0.25; // 45 deg SE isometric camera
export const DEFAULT_PITCH = 35; // maps to 2:1 isometric ratio in 2D
export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 4.0;
export const MIN_PITCH = 12;
export const MAX_PITCH = 85;

export function compassStepFromYaw(yaw: number): 0 | 1 | 2 | 3 {
  return (((Math.round((yaw - DEFAULT_YAW) / (Math.PI / 2)) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  return ((rad % twoPi) + twoPi) % twoPi;
}

function shortestAngleDiff(from: number, to: number): number {
  const twoPi = Math.PI * 2;
  let diff = (((to - from) % twoPi) + twoPi) % twoPi;
  if (diff > Math.PI) diff -= twoPi;
  return diff;
}

type Listener = (state: UnifiedCameraState) => void;

class CameraStore {
  private state: UnifiedCameraState = {
    targetX: WORLD_CENTER_X,
    targetZ: WORLD_CENTER_Z,
    zoom: 0.78,
    yaw: DEFAULT_YAW,
    pitch: DEFAULT_PITCH,
    projection: "perspective",
    timeOfDay: "day",
    preset: 2,
    followVehicleId: null,
    cinematicOrbit: false,
    edgeScrollEnabled: false,
  };

  private listeners = new Set<Listener>();
  private tweenRaf: number | null = null;
  private tweenDest: {
    targetX: number;
    targetZ: number;
    zoom: number;
    yaw: number;
    pitch: number;
  } | null = null;

  getState(): UnifiedCameraState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) {
      fn(this.state);
    }
  }

  cancelTween(): void {
    if (this.tweenRaf !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.tweenRaf);
      this.tweenRaf = null;
    }
    this.tweenDest = null;
  }

  setState(patch: Partial<UnifiedCameraState>, options?: { cancelTween?: boolean }): void {
    if (options?.cancelTween !== false) {
      this.cancelTween();
    }
    const next: UnifiedCameraState = {
      ...this.state,
      ...patch,
    };
    next.targetX = clamp(next.targetX, -15, 155);
    next.targetZ = clamp(next.targetZ, -15, 125);
    next.zoom = clamp(next.zoom, MIN_ZOOM, MAX_ZOOM);
    next.yaw = normalizeAngle(next.yaw);
    next.pitch = clamp(next.pitch, MIN_PITCH, MAX_PITCH);
    this.state = next;
    this.emit();
  }

  panWorld(dx: number, dz: number): void {
    this.setState({
      targetX: this.state.targetX + dx,
      targetZ: this.state.targetZ + dz,
      followVehicleId: null,
      cinematicOrbit: false,
    });
  }

  /** Pan in camera-aligned screen/ground axes: forward (+1 = up/away), right (+1 = right). */
  panRelative(rightAmount: number, forwardAmount: number): void {
    const { yaw } = this.state;
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    this.panWorld(
      rightX * rightAmount + fwdX * forwardAmount,
      rightZ * rightAmount + fwdZ * forwardAmount,
    );
  }

  rotateCompass(stepDelta: -1 | 1): void {
    const refYaw = this.tweenDest?.yaw ?? this.state.yaw;
    const snappedBase = Math.round((refYaw - DEFAULT_YAW) / (Math.PI / 2));
    const targetYaw = DEFAULT_YAW + (snappedBase + stepDelta) * (Math.PI / 2);
    this.flyTo({ yaw: targetYaw, durationMs: 320 });
  }

  getCompassLabel(): "N" | "E" | "S" | "W" {
    return (["N", "E", "S", "W"] as const)[compassStepFromYaw(this.state.yaw)];
  }

  flyTo(opts: FlyToOptions): void {
    const base = this.tweenDest ?? this.state;
    const start = { ...this.state };
    const endTargetX = opts.targetX ?? base.targetX;
    const endTargetZ = opts.targetZ ?? base.targetZ;
    const endZoom = clamp(opts.zoom ?? base.zoom, MIN_ZOOM, MAX_ZOOM);
    const endYaw = normalizeAngle(opts.yaw ?? base.yaw);
    const endPitch = clamp(opts.pitch ?? base.pitch, MIN_PITCH, MAX_PITCH);
    this.cancelTween();

    const yawDiff = shortestAngleDiff(start.yaw, endYaw);
    const duration = Math.max(120, opts.durationMs ?? 520);

    if (typeof requestAnimationFrame !== "function" || typeof performance === "undefined") {
      this.setState(
        {
          targetX: endTargetX,
          targetZ: endTargetZ,
          zoom: endZoom,
          yaw: endYaw,
          pitch: endPitch,
        },
        { cancelTween: false },
      );
      return;
    }

    this.tweenDest = {
      targetX: endTargetX,
      targetZ: endTargetZ,
      zoom: endZoom,
      yaw: endYaw,
      pitch: endPitch,
    };
    const t0 = performance.now();
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / duration);
      const ease = 1 - Math.pow(1 - u, 3);
      this.setState(
        {
          targetX: start.targetX + (endTargetX - start.targetX) * ease,
          targetZ: start.targetZ + (endTargetZ - start.targetZ) * ease,
          zoom: start.zoom + (endZoom - start.zoom) * ease,
          yaw: start.yaw + yawDiff * ease,
          pitch: start.pitch + (endPitch - start.pitch) * ease,
        },
        { cancelTween: false },
      );
      if (u < 1) {
        this.tweenRaf = requestAnimationFrame(step);
      } else {
        this.tweenRaf = null;
        this.tweenDest = null;
      }
    };
    this.tweenRaf = requestAnimationFrame(step);
  }

  applyPreset(
    preset: CameraPresetId,
    options?: { fitZoom?: number; vehicleId?: string | null },
  ): void {
    if (preset === 1) {
      this.setState({ preset: 1, followVehicleId: null, cinematicOrbit: false });
      this.flyTo({
        targetX: WORLD_CENTER_X,
        targetZ: WORLD_CENTER_Z + 4,
        zoom: options?.fitZoom ?? 0.68,
        yaw: DEFAULT_YAW,
        pitch: 46,
        durationMs: 560,
      });
    } else if (preset === 2) {
      this.setState({ preset: 2, followVehicleId: null, cinematicOrbit: false });
      this.flyTo({
        targetX: WORLD_CENTER_X,
        targetZ: WORLD_CENTER_Z,
        zoom: 0.96,
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        durationMs: 520,
      });
    } else if (preset === 3) {
      this.setState({ preset: 3, followVehicleId: null, cinematicOrbit: false });
      this.flyTo({
        targetX: WORLD_CENTER_X,
        targetZ: WORLD_CENTER_Z + 12,
        zoom: 2.35,
        yaw: Math.PI * 0.14,
        pitch: 14,
        durationMs: 620,
      });
    } else if (preset === 4) {
      this.setState({
        preset: 4,
        followVehicleId: options?.vehicleId ?? this.state.followVehicleId ?? "auto",
        cinematicOrbit: false,
      });
      this.flyTo({
        zoom: Math.max(1.85, this.state.zoom),
        pitch: 22,
        durationMs: 420,
      });
    } else if (preset === 5) {
      const nextOrbit = !this.state.cinematicOrbit || this.state.preset !== 5;
      this.setState({
        preset: 5,
        followVehicleId: null,
        cinematicOrbit: nextOrbit,
      });
      if (nextOrbit) {
        this.flyTo({
          targetX: WORLD_CENTER_X,
          targetZ: WORLD_CENTER_Z,
          zoom: 0.92,
          pitch: 28,
          durationMs: 550,
        });
      }
    }
  }

  toggleProjection(): void {
    this.setState({
      projection: this.state.projection === "perspective" ? "orthographic" : "perspective",
    });
  }
}

export const cameraStore = new CameraStore();

export function useCameraSelector<T>(selector: (state: UnifiedCameraState) => T): T {
  const [val, setVal] = useState<T>(() => selector(cameraStore.getState()));
  useEffect(
    () =>
      cameraStore.subscribe((next) => {
        const picked = selector(next);
        setVal((prev) => (Object.is(prev, picked) ? prev : picked));
      }),
    [selector],
  );
  return val;
}

export function useCameraStore(): UnifiedCameraState {
  const [snap, setSnap] = useState<UnifiedCameraState>(() => cameraStore.getState());
  useEffect(() => cameraStore.subscribe(setSnap), []);
  return snap;
}

const MOVEMENT_KEYS = new Set([
  "w",
  "a",
  "s",
  "d",
  "q",
  "e",
  "r",
  "f",
  "shift",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
]);

export function useUnifiedCameraHotkeys(viewMode: "2d" | "3d"): void {
  useEffect(() => {
    const pressed = new Set<string>();
    let raf = 0;
    let lastTs = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;

      if (pressed.size === 0) {
        raf = 0;
        return;
      }

      const cam = cameraStore.getState();
      const boost = pressed.has("shift") ? 2.3 : 1.0;
      const speed = (38 / Math.max(0.35, cam.zoom)) * boost * dt;
      let fwd = 0;
      let right = 0;
      if (pressed.has("w") || pressed.has("arrowup")) fwd += 1;
      if (pressed.has("s") || pressed.has("arrowdown")) fwd -= 1;
      if (pressed.has("d") || pressed.has("arrowright")) right += 1;
      if (pressed.has("a") || pressed.has("arrowleft")) right -= 1;
      if (fwd !== 0 || right !== 0) {
        cameraStore.panRelative(right * speed, fwd * speed);
      }

      if (viewMode === "3d") {
        let yawDelta = 0;
        if (pressed.has("q")) yawDelta -= 1.6 * dt;
        if (pressed.has("e")) yawDelta += 1.6 * dt;
        if (yawDelta !== 0) {
          cameraStore.setState({ yaw: cam.yaw + yawDelta, cinematicOrbit: false });
        }
      }

      let pitchDelta = 0;
      if (pressed.has("r")) pitchDelta += 36 * dt;
      if (pressed.has("f")) pitchDelta -= 36 * dt;
      if (pitchDelta !== 0) {
        cameraStore.setState({ pitch: cam.pitch + pitchDelta });
      }

      raf = requestAnimationFrame(tick);
    };

    const ensureLoop = () => {
      if (raf === 0 && pressed.size > 0) {
        lastTs = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();

      if (key === "q" && viewMode === "2d" && !e.repeat) {
        cameraStore.rotateCompass(-1);
        return;
      }
      if (key === "e" && viewMode === "2d" && !e.repeat) {
        cameraStore.rotateCompass(1);
        return;
      }
      if (key === "=" || key === "+") {
        cameraStore.flyTo({
          zoom: Math.min(MAX_ZOOM, cameraStore.getState().zoom * 1.22),
          durationMs: 200,
        });
        return;
      }
      if (key === "-" || key === "_") {
        cameraStore.flyTo({
          zoom: Math.max(MIN_ZOOM, cameraStore.getState().zoom * 0.82),
          durationMs: 200,
        });
        return;
      }
      if (key === "0" || key === "home") {
        cameraStore.applyPreset(1);
        return;
      }
      if (key === "1" || key === "2" || key === "3" || key === "4" || key === "5") {
        cameraStore.applyPreset(Number(key) as CameraPresetId);
        return;
      }

      if (MOVEMENT_KEYS.has(key)) {
        pressed.add(key);
        ensureLoop();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      pressed.delete(e.key.toLowerCase());
    };
    const onBlur = () => {
      pressed.clear();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [viewMode]);
}

const BOOKMARK_STORAGE_PREFIX = "codecity_bookmarks_v2:";

export function loadRepoBookmarks(repoKey: string): CameraBookmark[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(`${BOOKMARK_STORAGE_PREFIX}${repoKey}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CameraBookmark[]) : [];
  } catch {
    return [];
  }
}

export function saveRepoBookmark(repoKey: string, name: string): CameraBookmark[] {
  const cam = cameraStore.getState();
  const next: CameraBookmark = {
    id: `bm-${Date.now().toString(36)}`,
    name: name.trim() || `Viewpoint ${new Date().toLocaleTimeString()}`,
    targetX: Number(cam.targetX.toFixed(2)),
    targetZ: Number(cam.targetZ.toFixed(2)),
    zoom: Number(cam.zoom.toFixed(3)),
    yaw: Number(cam.yaw.toFixed(3)),
    pitch: Number(cam.pitch.toFixed(1)),
    projection: cam.projection,
    createdAt: new Date().toISOString(),
  };
  const list = [next, ...loadRepoBookmarks(repoKey)].slice(0, 12);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(`${BOOKMARK_STORAGE_PREFIX}${repoKey}`, JSON.stringify(list));
  }
  return list;
}

export function deleteRepoBookmark(repoKey: string, id: string): CameraBookmark[] {
  const list = loadRepoBookmarks(repoKey).filter((b) => b.id !== id);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(`${BOOKMARK_STORAGE_PREFIX}${repoKey}`, JSON.stringify(list));
  }
  return list;
}
