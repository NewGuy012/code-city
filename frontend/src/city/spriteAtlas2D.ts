import type { BuildingArchetype, FileMetric } from "../types/city";
import { buildingVariantIndex, hashFilePath } from "./cityTheme";

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

export const ATLAS_CELL_W = 192;
export const ATLAS_CELL_H = 288;
export const ATLAS_ANCHOR_X = 96;
export const ATLAS_ANCHOR_Y = 249;
export const ATLAS_FOOTPRINT_PX = 117;

export const NATURE_CELL_W = 96;
export const NATURE_CELL_H = 128;
export const NATURE_ANCHOR_X = 48;
export const NATURE_ANCHOR_Y = 108;

export interface LoadedSpriteAtlas {
  ready: boolean;
  buildings: HTMLImageElement | null;
  emissive: HTMLImageElement | null;
  nature: HTMLImageElement | null;
}

class SpriteAtlasManager {
  private state: LoadedSpriteAtlas = {
    ready: false,
    buildings: null,
    emissive: null,
    nature: null,
  };
  private started = false;
  private tintCanvas: HTMLCanvasElement | null = null;

  ensureLoaded(): LoadedSpriteAtlas {
    if (this.started || typeof Image === "undefined") {
      return this.state;
    }
    this.started = true;

    let loadedCount = 0;
    const onLoadOne = () => {
      loadedCount += 1;
      if (loadedCount >= 3) this.state.ready = true;
    };
    const loadImg = (src: string, assign: (img: HTMLImageElement) => void) => {
      const img = new Image();
      img.onload = () => {
        assign(img);
        onLoadOne();
      };
      img.onerror = () => {
        onLoadOne();
      };
      img.src = src;
    };

    loadImg("./sprites/buildings_atlas.webp", (img) => {
      this.state.buildings = img;
    });
    loadImg("./sprites/buildings_emissive.webp", (img) => {
      this.state.emissive = img;
    });
    loadImg("./sprites/nature_atlas.webp", (img) => {
      this.state.nature = img;
    });

    return this.state;
  }

  getBuildingSpriteRect(
    archetype: BuildingArchetype,
    heightVal: number,
    compassStep: 0 | 1 | 2 | 3,
    variantSlot: 0 | 1 | 2 | 3 = 0,
  ): { sx: number; sy: number; sw: number; sh: number } {
    const baseRow = ARCHETYPE_ROW[archetype] ?? 5;
    const row = baseRow * 2 + (variantSlot % 2);
    const colOffset = variantSlot >= 2 ? 12 : 0;
    const tier = heightVal < 26 ? 0 : heightVal < 50 ? 1 : 2;
    const col = colOffset + tier * 4 + compassStep;
    return {
      sx: col * ATLAS_CELL_W,
      sy: row * ATLAS_CELL_H,
      sw: ATLAS_CELL_W,
      sh: ATLAS_CELL_H,
    };
  }

  /** Choose deterministic architectural variant + lot-aligned rotation for 2D sprite rendering. */
  getSpriteSpecForFile(
    file: Pick<FileMetric, "file_path" | "building_archetype">,
    bw: number,
    bd: number,
    heightVal: number,
    compassStep: 0 | 1 | 2 | 3,
  ): { sx: number; sy: number; sw: number; sh: number; rotOffset: number } {
    const h = hashFilePath(file.file_path);
    const aspect = bw / Math.max(0.4, bd);
    let variantSlot: 0 | 1 | 2 | 3;
    let rotOffset: number;

    if (aspect >= 1.45) {
      variantSlot = 3;
      rotOffset = (h & 1) === 0 ? 0 : 2;
    } else if (aspect <= 1 / 1.45) {
      variantSlot = 3;
      rotOffset = (h & 1) === 0 ? 1 : 3;
    } else {
      variantSlot = buildingVariantIndex(file.file_path, 3) as 0 | 1 | 2;
      rotOffset = h & 3;
    }

    const netCompass = (((compassStep + rotOffset) % 4) + 4) % 4;
    const rect = this.getBuildingSpriteRect(
      file.building_archetype,
      heightVal,
      netCompass as 0 | 1 | 2 | 3,
      variantSlot,
    );
    return { ...rect, rotOffset };
  }

  getNatureSpriteRect(col: number, row: 0 | 1): { sx: number; sy: number; sw: number; sh: number } {
    return {
      sx: col * NATURE_CELL_W,
      sy: row * NATURE_CELL_H,
      sw: NATURE_CELL_W,
      sh: NATURE_CELL_H,
    };
  }

  /** Draw sprite optionally tinted for DataMap highlights or Time-of-Day atmosphere. */
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
    tintAlpha = 0.56,
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
    tCtx.globalAlpha = tintAlpha;
    tCtx.fillRect(0, 0, ATLAS_CELL_W, ATLAS_CELL_H);
    tCtx.globalAlpha = 1.0;
    tCtx.globalCompositeOperation = "source-over";

    ctx.drawImage(this.tintCanvas, 0, 0, ATLAS_CELL_W, ATLAS_CELL_H, dx, dy, dw, dh);
  }
}

export const spriteAtlas = new SpriteAtlasManager();
