import type { BuildingArchetype } from "../types/city";

const ARCHETYPE_ROW: Record<BuildingArchetype, number> = {
  grand_terminal: 0,
  city_hall: 1,
  archive_vault: 2,
  twin_silos: 3,
  factory: 4,
  office_tower: 5,
  glass_pavilion: 6,
  watchtower: 7,
  civic_kiosk: 8,
  park_stadium: 9,
};

export const ATLAS_CELL_W = 96;
export const ATLAS_CELL_H = 128;
export const ATLAS_ANCHOR_X = 48;
export const ATLAS_ANCHOR_Y = 114;

export interface LoadedSpriteAtlas {
  ready: boolean;
  buildings: HTMLImageElement | null;
  emissive: HTMLImageElement | null;
}

class SpriteAtlasManager {
  private state: LoadedSpriteAtlas = {
    ready: false,
    buildings: null,
    emissive: null,
  };
  private started = false;
  private tintCanvas: HTMLCanvasElement | null = null;

  ensureLoaded(): LoadedSpriteAtlas {
    if (this.started || typeof Image === "undefined") {
      return this.state;
    }
    this.started = true;

    let loadedCount = 0;
    const loadImg = (src: string, assign: (img: HTMLImageElement) => void) => {
      const img = new Image();
      img.onload = () => {
        assign(img);
        loadedCount += 1;
        if (loadedCount >= 2) this.state.ready = true;
      };
      img.src = src;
    };

    loadImg("./sprites/buildings_atlas.png", (img) => {
      this.state.buildings = img;
    });
    loadImg("./sprites/buildings_emissive.png", (img) => {
      this.state.emissive = img;
    });

    return this.state;
  }

  getBuildingSpriteRect(
    archetype: BuildingArchetype,
    heightVal: number,
    compassStep: 0 | 1 | 2 | 3,
  ): { sx: number; sy: number; sw: number; sh: number } {
    const row = ARCHETYPE_ROW[archetype] ?? 5;
    const tier = heightVal < 26 ? 0 : heightVal < 50 ? 1 : 2;
    const col = tier * 4 + compassStep;
    return {
      sx: col * ATLAS_CELL_W,
      sy: row * ATLAS_CELL_H,
      sw: ATLAS_CELL_W,
      sh: ATLAS_CELL_H,
    };
  }

  /** Draw sprite optionally tinted for DataMap mode using a single reusable scratch canvas. */
  drawTintedSprite(
    ctx: CanvasRenderingContext2D,
    srcImg: HTMLImageElement,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    tintHex: string | null,
  ): void {
    if (!tintHex || typeof document === "undefined") {
      ctx.drawImage(srcImg, sx, sy, sw, sh, dx, dy, dw, dh);
      return;
    }
    if (!this.tintCanvas) {
      this.tintCanvas = document.createElement("canvas");
      this.tintCanvas.width = ATLAS_CELL_W;
      this.tintCanvas.height = ATLAS_CELL_H;
    }
    const tCtx = this.tintCanvas.getContext("2d");
    if (!tCtx) {
      ctx.drawImage(srcImg, sx, sy, sw, sh, dx, dy, dw, dh);
      return;
    }
    tCtx.clearRect(0, 0, ATLAS_CELL_W, ATLAS_CELL_H);
    tCtx.globalCompositeOperation = "source-over";
    tCtx.drawImage(srcImg, sx, sy, sw, sh, 0, 0, ATLAS_CELL_W, ATLAS_CELL_H);
    tCtx.globalCompositeOperation = "source-atop";
    tCtx.fillStyle = tintHex;
    tCtx.globalAlpha = 0.52;
    tCtx.fillRect(0, 0, ATLAS_CELL_W, ATLAS_CELL_H);
    tCtx.globalAlpha = 1.0;
    tCtx.globalCompositeOperation = "source-over";

    ctx.drawImage(this.tintCanvas, 0, 0, ATLAS_CELL_W, ATLAS_CELL_H, dx, dy, dw, dh);
  }
}

export const spriteAtlas = new SpriteAtlasManager();
