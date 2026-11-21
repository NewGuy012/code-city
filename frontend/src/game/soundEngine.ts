import type { MayorToolId } from "./sandboxOverlay";

type ToolSfxNote = [
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  delay: number,
  endFreq?: number,
];

const TOOL_SFX: Record<Exclude<MayorToolId, "inspect">, ToolSfxNote[]> = {
  sweeper: [
    [520, 0.14, "triangle", 0.06, 0, 880],
    [1046, 0.16, "sine", 0.05, 0.08],
  ],
  splitter: [
    [240, 0.09, "square", 0.05, 0, 160],
    [360, 0.12, "triangle", 0.06, 0.11, 540],
  ],
  transit_hub: [
    [440, 0.16, "sine", 0.06, 0],
    [659.25, 0.22, "sine", 0.06, 0.09],
  ],
  proving_park: [
    [523.25, 0.18, "sine", 0.06, 0],
    [659.25, 0.18, "sine", 0.05, 0.06],
    [783.99, 0.24, "sine", 0.05, 0.12],
  ],
  co_maintainer: [
    [587.33, 0.14, "triangle", 0.06, 0],
    [880, 0.22, "sine", 0.06, 0.08],
  ],
  bulldozer: [[110, 0.28, "sawtooth", 0.06, 0, 52]],
};

class SoundEngine {
  private ctx: AudioContext | null = null;
  private enabled = true;

  setEnabled(val: boolean): void {
    this.enabled = val;
  }

  private ensureContext(): AudioContext | null {
    if (!this.enabled || typeof window === "undefined") return null;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    try {
      if (!this.ctx) {
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === "suspended") {
        void this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    } catch {
      return null;
    }
  }

  private tone(
    freq: number,
    durationSec: number,
    type: OscillatorType = "sine",
    gainLevel = 0.08,
    delaySec = 0,
    endFreq?: number,
  ): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime + delaySec;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      if (endFreq !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), now + durationSec);
      }
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(gainLevel, now + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + durationSec + 0.02);
    } catch {
      // Headless browsers can reject Web Audio without user gesture
    }
  }

  playTool(tool: Exclude<MayorToolId, "inspect">): void {
    for (const args of TOOL_SFX[tool]) {
      this.tone(...args);
    }
  }

  playDisaster(): void {
    this.tone(680, 0.22, "sawtooth", 0.05, 0, 440);
    this.tone(440, 0.22, "sawtooth", 0.05, 0.22, 680);
  }

  playMilestone(): void {
    [523.25, 659.25, 783.99, 1046.5].forEach((n, idx) => {
      this.tone(n, 0.24, "triangle", 0.07, idx * 0.09);
    });
  }
}

export const soundEngine = new SoundEngine();
