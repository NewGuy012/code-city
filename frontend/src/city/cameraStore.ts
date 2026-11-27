import { useEffect, useState } from "react";

import { isTypingTarget } from "../components/hudPopover";
import type { CanvasCursorDragIntent } from "./cityTheme";

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

export function computeMouseYaw(origYaw: number, deltaX: number, viewportHeight: number): number {
  return origYaw - (deltaX * Math.PI * 2) / Math.max(320, viewportHeight);
}

export function computeMousePitch(
  origPitch: number,
  deltaY: number,
  viewportHeight: number,
): number {
  return clamp(origPitch + (deltaY * 360) / Math.max(320, viewportHeight), MIN_PITCH, MAX_PITCH);
}

/** Compute next camera ground target when panning in camera-aligned right/forward axes. */
export function computeRelativePanTarget(
  origTargetX: number,
  origTargetZ: number,
  yaw: number,
  rightAmount: number,
  forwardAmount: number,
): { targetX: number; targetZ: number } {
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const fwdX = -Math.sin(yaw);
  const fwdZ = -Math.cos(yaw);
  return {
    targetX: origTargetX + rightX * rightAmount + fwdX * forwardAmount,
    targetZ: origTargetZ + rightZ * rightAmount + fwdZ * forwardAmount,
  };
}

export type CanvasDragMode = "pan" | "orbit" | "yaw" | "paint" | "idle";

/** Resolve canvas pointerdown drag behavior: Space+drag pans, Ctrl+drag rotates, plain drag does not rotate. */
export function resolveCanvasDragMode(opts: {
  button: number;
  spaceHeld: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  activeTool?: string;
  allowSweeperPaint?: boolean;
}): CanvasDragMode {
  const { button, spaceHeld, ctrlKey, altKey, shiftKey, metaKey, activeTool, allowSweeperPaint } =
    opts;
  if (button !== 0 && button !== 1 && button !== 2) return "idle";
  if (spaceHeld) return "pan";
  if (ctrlKey && (button === 0 || button === 2)) return "orbit";
  if (button === 2 || button === 1) return "pan";
  if (altKey && button === 0) return "yaw";
  if (button === 0 && (shiftKey || metaKey)) return "pan";
  if (allowSweeperPaint && activeTool === "sweeper" && button === 0) return "paint";
  return "idle";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  return ((rad % twoPi) + twoPi) % twoPi;
}

function wrapSignedDiff(from: number, to: number, period: number): number {
  let diff = (((to - from) % period) + period) % period;
  if (diff > period * 0.5) diff -= period;
  return diff;
}

const STATIC_PRESETS: Record<
  1 | 2 | 3,
  { targetZOffset: number; zoom?: number; yaw: number; pitch: number; durationMs: number }
> = {
  1: { targetZOffset: 4, yaw: DEFAULT_YAW, pitch: 46, durationMs: 560 },
  2: { targetZOffset: 0, zoom: 0.96, yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, durationMs: 520 },
  3: { targetZOffset: 12, zoom: 2.35, yaw: Math.PI * 0.14, pitch: 14, durationMs: 620 },
};

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
    const next = computeRelativePanTarget(
      this.state.targetX,
      this.state.targetZ,
      this.state.yaw,
      rightAmount,
      forwardAmount,
    );
    this.setState({
      ...next,
      followVehicleId: null,
      cinematicOrbit: false,
    });
  }

  rotateCompass(stepDelta: -1 | 1): void {
    const refYaw = this.tweenDest?.yaw ?? this.state.yaw;
    const snappedBase = Math.round((refYaw - DEFAULT_YAW) / (Math.PI / 2));
    const targetYaw = DEFAULT_YAW + (snappedBase + stepDelta) * (Math.PI / 2);
    this.flyTo({ yaw: targetYaw, durationMs: 320 });
  }

  resetOrientation(durationMs = 340): void {
    this.flyTo({
      yaw: DEFAULT_YAW,
      pitch: DEFAULT_PITCH,
      durationMs,
    });
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
    const stopOrbit = opts.yaw !== undefined;
    this.cancelTween();

    const yawDiff = wrapSignedDiff(start.yaw, endYaw, Math.PI * 2);
    const duration = Math.max(120, opts.durationMs ?? 520);

    if (typeof requestAnimationFrame !== "function" || typeof performance === "undefined") {
      this.setState(
        {
          targetX: endTargetX,
          targetZ: endTargetZ,
          zoom: endZoom,
          yaw: endYaw,
          pitch: endPitch,
          ...(stopOrbit ? { cinematicOrbit: false } : {}),
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
          ...(stopOrbit ? { cinematicOrbit: false } : {}),
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
    if (preset === 1 || preset === 2 || preset === 3) {
      const cfg = STATIC_PRESETS[preset];
      this.setState({ preset, followVehicleId: null, cinematicOrbit: false });
      this.flyTo({
        targetX: WORLD_CENTER_X,
        targetZ: WORLD_CENTER_Z + cfg.targetZOffset,
        zoom: preset === 1 ? (options?.fitZoom ?? 0.68) : cfg.zoom,
        yaw: cfg.yaw,
        pitch: cfg.pitch,
        durationMs: cfg.durationMs,
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
    } else {
      const nextOrbit = !this.state.cinematicOrbit || this.state.preset !== 5;
      this.setState({ preset: 5, followVehicleId: null, cinematicOrbit: nextOrbit });
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

export function useCameraStore(): UnifiedCameraState {
  const [snap, setSnap] = useState<UnifiedCameraState>(() => cameraStore.getState());
  useEffect(() => cameraStore.subscribe(setSnap), []);
  return snap;
}

export interface ModifierKeysState {
  alt: boolean;
  ctrl: boolean;
  space: boolean;
}

export function resolveCursorIntent(
  activeDragMode: CanvasDragMode | null,
  mods: ModifierKeysState,
): { yawMode: boolean; dragIntent: CanvasCursorDragIntent } {
  const activeCameraMode =
    activeDragMode === "pan" || activeDragMode === "orbit" || activeDragMode === "yaw"
      ? activeDragMode
      : null;
  if (activeCameraMode === "yaw" || (!activeCameraMode && mods.alt && !mods.space && !mods.ctrl)) {
    return { yawMode: true, dragIntent: null };
  }
  if (activeCameraMode === "pan") return { yawMode: false, dragIntent: "panning" };
  if (activeCameraMode === "orbit") return { yawMode: false, dragIntent: "orbiting" };
  if (mods.space) return { yawMode: false, dragIntent: "pan" };
  if (mods.ctrl) return { yawMode: false, dragIntent: "orbit" };
  return { yawMode: false, dragIntent: null };
}

let modifierState: ModifierKeysState = { alt: false, ctrl: false, space: false };
const modifierListeners = new Set<(next: ModifierKeysState) => void>();
let modifierCleanup: (() => void) | null = null;

function isSpaceKeyEvent(e: KeyboardEvent): boolean {
  return e.code === "Space" || e.key === " " || e.key === "Spacebar";
}

function isModalOpen(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.getElementById("codecity-modal-root");
  return Boolean(root && root.childElementCount > 0);
}

function setModifierState(patch: Partial<ModifierKeysState>): void {
  const next: ModifierKeysState = {
    alt: patch.alt ?? modifierState.alt,
    ctrl: patch.ctrl ?? modifierState.ctrl,
    space: patch.space ?? modifierState.space,
  };
  if (
    next.alt === modifierState.alt &&
    next.ctrl === modifierState.ctrl &&
    next.space === modifierState.space
  ) {
    return;
  }
  modifierState = next;
  for (const fn of modifierListeners) {
    fn(next);
  }
}

function resetModifiers(): void {
  setModifierState({ alt: false, ctrl: false, space: false });
}

function ensureModifierListeners(): void {
  if (modifierCleanup !== null || typeof window === "undefined") return;

  const onKey = (e: KeyboardEvent) => {
    const typing = isTypingTarget(e.target);
    const patch: Partial<ModifierKeysState> = {
      alt: e.key === "Alt" ? e.type === "keydown" && !typing : e.altKey && !typing,
      ctrl: e.key === "Control" ? e.type === "keydown" && !typing : e.ctrlKey && !typing,
    };
    if (isSpaceKeyEvent(e)) {
      if (e.type === "keydown") {
        if (!typing && !isModalOpen() && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          patch.space = true;
        } else if (typing || isModalOpen()) {
          patch.space = false;
        }
      } else {
        if (modifierState.space && !typing && !isModalOpen()) {
          e.preventDefault();
        }
        patch.space = false;
      }
    }
    setModifierState(patch);
  };

  const onPointer = (e: PointerEvent) => {
    const typing = isTypingTarget(e.target);
    setModifierState({
      alt: e.altKey && !typing,
      ctrl: e.ctrlKey && !typing,
      ...(isModalOpen() ? { space: false } : {}),
    });
  };

  const onFocusIn = (e: FocusEvent) => {
    if (isTypingTarget(e.target) || isModalOpen()) {
      resetModifiers();
    }
  };

  const onVisibility = () => {
    if (typeof document !== "undefined" && document.hidden) {
      resetModifiers();
    }
  };

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  window.addEventListener("pointermove", onPointer, true);
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("focusin", onFocusIn, true);
  window.addEventListener("blur", resetModifiers);
  document.addEventListener("visibilitychange", onVisibility);

  modifierCleanup = () => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    window.removeEventListener("pointermove", onPointer, true);
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("blur", resetModifiers);
    document.removeEventListener("visibilitychange", onVisibility);
    modifierCleanup = null;
    resetModifiers();
  };
}

export function isSpaceKeyHeld(): boolean {
  return modifierState.space;
}

export function useModifierKeysHeld(): ModifierKeysState {
  const [mods, setMods] = useState<ModifierKeysState>(() => modifierState);

  useEffect(() => {
    ensureModifierListeners();
    setMods(modifierState);
    modifierListeners.add(setMods);
    return () => {
      modifierListeners.delete(setMods);
      if (modifierListeners.size === 0 && modifierCleanup) {
        modifierCleanup();
      }
    };
  }, []);

  return mods;
}

export function useAltKeyHeld(): boolean {
  return useModifierKeysHeld().alt;
}

export function useCtrlKeyHeld(): boolean {
  return useModifierKeysHeld().ctrl;
}

export function useSpaceKeyHeld(): boolean {
  return useModifierKeysHeld().space;
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
      const shiftHeld = pressed.has("shift");
      const boost = shiftHeld ? 2.3 : 1.0;
      const rotBoost = shiftHeld ? 2.0 : 1.0;
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

      const cur = cameraStore.getState();
      const orientPatch: Partial<UnifiedCameraState> = {};

      if ((viewMode === "3d" && !shiftHeld) || (viewMode === "2d" && shiftHeld)) {
        let yawDelta = 0;
        if (pressed.has("q")) yawDelta -= 1.6 * dt;
        if (pressed.has("e")) yawDelta += 1.6 * dt;
        if (yawDelta !== 0) {
          orientPatch.yaw = cur.yaw + yawDelta;
          orientPatch.cinematicOrbit = false;
        }
      }

      let pitchDelta = 0;
      if (pressed.has("r")) pitchDelta += 36 * rotBoost * dt;
      if (pressed.has("f")) pitchDelta -= 36 * rotBoost * dt;
      if (pitchDelta !== 0) {
        orientPatch.pitch = cur.pitch + pitchDelta;
      }

      if (Object.keys(orientPatch).length > 0) {
        cameraStore.setState(orientPatch);
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
      if (
        e.target instanceof HTMLInputElement &&
        e.target.type === "range" &&
        key.startsWith("arrow")
      ) {
        return;
      }

      if (e.shiftKey) pressed.add("shift");
      else pressed.delete("shift");

      const shouldSnapYaw = (viewMode === "2d" && !e.shiftKey) || (viewMode === "3d" && e.shiftKey);
      if (key === "q" && shouldSnapYaw) {
        if (!e.repeat) cameraStore.rotateCompass(-1);
        return;
      }
      if (key === "e" && shouldSnapYaw) {
        if (!e.repeat) cameraStore.rotateCompass(1);
        return;
      }
      if (key === "n" && !e.repeat) {
        cameraStore.flyTo({ yaw: DEFAULT_YAW, durationMs: 320 });
        return;
      }
      if (key === "t" && !e.repeat) {
        const curPitch = cameraStore.getState().pitch;
        const nextPitch = curPitch >= 70 ? DEFAULT_PITCH : MAX_PITCH;
        cameraStore.flyTo({ pitch: nextPitch, durationMs: 360 });
        return;
      }
      if (key === "x" && !e.repeat) {
        cameraStore.resetOrientation();
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
      if (!e.shiftKey) pressed.delete("shift");
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

function isValidBookmark(b: unknown): b is CameraBookmark {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    Number.isFinite(o.targetX) &&
    Number.isFinite(o.targetZ) &&
    Number.isFinite(o.zoom) &&
    Number.isFinite(o.yaw) &&
    Number.isFinite(o.pitch) &&
    (o.projection === "perspective" || o.projection === "orthographic") &&
    typeof o.createdAt === "string"
  );
}

function persistBookmarks(repoKey: string, list: CameraBookmark[]): CameraBookmark[] {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(`${BOOKMARK_STORAGE_PREFIX}${repoKey}`, JSON.stringify(list));
    } catch {
      // Ignore storage quota or private-browsing failures
    }
  }
  return list;
}

export function loadRepoBookmarks(repoKey: string): CameraBookmark[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(`${BOOKMARK_STORAGE_PREFIX}${repoKey}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isValidBookmark) : [];
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
  return persistBookmarks(repoKey, [next, ...loadRepoBookmarks(repoKey)].slice(0, 12));
}

export function deleteRepoBookmark(repoKey: string, id: string): CameraBookmark[] {
  return persistBookmarks(
    repoKey,
    loadRepoBookmarks(repoKey).filter((b) => b.id !== id),
  );
}
