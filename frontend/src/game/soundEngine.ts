import type { MayorToolId } from "./sandboxOverlay";

class SoundEngine {
  private ctx: AudioContext | null = null;
  private enabled = true;
  private ambientOn = false;
  private ambientOsc: OscillatorNode | null = null;
  private ambientGain: GainNode | null = null;

  isEnabled(): boolean {
    return this.enabled;
  }

  isAmbientOn(): boolean {
    return this.ambientOn;
  }

  setEnabled(val: boolean): void {
    this.enabled = val;
    if (!val && this.ambientOn) {
      this.stopAmbient();
    }
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
      // Ignore audio errors in headless environments
    }
  }

  playTool(tool: Exclude<MayorToolId, "inspect">): void {
    if (tool === "sweeper") {
      this.tone(520, 0.14, "triangle", 0.06, 0, 880);
      this.tone(1046, 0.16, "sine", 0.05, 0.08);
    } else if (tool === "splitter") {
      this.tone(240, 0.09, "square", 0.05, 0, 160);
      this.tone(360, 0.12, "triangle", 0.06, 0.11, 540);
    } else if (tool === "transit_hub") {
      this.tone(440, 0.16, "sine", 0.06, 0);
      this.tone(659.25, 0.22, "sine", 0.06, 0.09);
    } else if (tool === "proving_park") {
      this.tone(523.25, 0.18, "sine", 0.06, 0);
      this.tone(659.25, 0.18, "sine", 0.05, 0.06);
      this.tone(783.99, 0.24, "sine", 0.05, 0.12);
    } else if (tool === "co_maintainer") {
      this.tone(587.33, 0.14, "triangle", 0.06, 0);
      this.tone(880, 0.22, "sine", 0.06, 0.08);
    } else {
      // bulldozer rumble
      this.tone(110, 0.28, "sawtooth", 0.06, 0, 52);
    }
  }

  playDisaster(): void {
    this.tone(680, 0.22, "sawtooth", 0.05, 0, 440);
    this.tone(440, 0.22, "sawtooth", 0.05, 0.22, 680);
  }

  playMilestone(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((n, idx) => {
      this.tone(n, 0.24, "triangle", 0.07, idx * 0.09);
    });
  }

  toggleAmbient(): boolean {
    if (this.ambientOn) {
      this.stopAmbient();
      return false;
    }
    const ctx = this.ensureContext();
    if (!ctx) {
      this.ambientOn = false;
      return false;
    }
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 110;
      gain.gain.value = 0.018;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      this.ambientOsc = osc;
      this.ambientGain = gain;
      this.ambientOn = true;
      return true;
    } catch {
      this.ambientOn = false;
      return false;
    }
  }

  stopAmbient(): void {
    try {
      this.ambientOsc?.stop();
      this.ambientOsc?.disconnect();
      this.ambientGain?.disconnect();
    } catch {
      // ignore
    }
    this.ambientOsc = null;
    this.ambientGain = null;
    this.ambientOn = false;
  }
}

export const soundEngine = new SoundEngine();
