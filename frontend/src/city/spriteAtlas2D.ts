import type { BuildingArchetype, FileMetric } from "../types/city";
import { buildingVariantIndex, hashFilePath } from "./cityTheme";

export const ARCHETYPE_ORDER: readonly BuildingArchetype[] = [
  "grand_terminal",
  "city_hall",
  "archive_vault",
  "twin_silos",
  "factory",
  "office_tower",
  "glass_pavilion",
  "watchtower",
  "civic_kiosk",
  "park_stadium",
];

const ARCHETYPE_ROW: Record<BuildingArchetype, number> = Object.fromEntries(
  ARCHETYPE_ORDER.map((a, idx) => [a, idx]),
) as Record<BuildingArchetype, number>;

export interface AtlasTierMetrics {
  readonly tier: 0 | 1 | 2;
  readonly cellW: number;
  readonly cellH: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly footprintPx: number;
}

export const ATLAS_TIERS: readonly [AtlasTierMetrics, AtlasTierMetrics, AtlasTierMetrics] = [
  { tier: 0, cellW: 256, cellH: 384, anchorX: 128, anchorY: 332, footprintPx: 156 },
  { tier: 1, cellW: 384, cellH: 576, anchorX: 192, anchorY: 498, footprintPx: 234 },
  { tier: 2, cellW: 448, cellH: 672, anchorX: 224, anchorY: 581, footprintPx: 273 },
];

export const NATURE_CELL_W = 128;
export const NATURE_CELL_H = 160;
export const NATURE_ANCHOR_X = 64;
export const NATURE_ANCHOR_Y = 135;

export const EMISSIVE_CELL_W = 160;
export const EMISSIVE_CELL_H = 240;

export interface LoadedSpriteAtlas {
  ready: boolean;
  buildings: [HTMLImageElement | null, HTMLImageElement | null, HTMLImageElement | null];
  emissive: [HTMLImageElement | null, HTMLImageElement | null, HTMLImageElement | null];
  nature: HTMLImageElement | null;
}

export interface BuildingSpriteSpec {
  tier: 0 | 1 | 2;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  esx: number;
  esy: number;
  esw: number;
  esh: number;
  anchorX: number;
  anchorY: number;
  footprintPx: number;
  rotOffset: number;
}

class SpriteAtlasManager {
  private state: LoadedSpriteAtlas = {
    ready: false,
    buildings: [null, null, null],
    emissive: [null, null, null],
    nature: null,
  };
  private started = false;
  private tintCache = new Map<string, HTMLCanvasElement>();

  ensureLoaded(): LoadedSpriteAtlas {
    if (this.started || typeof Image === "undefined") {
      return this.state;
    }
    this.started = true;

    const loadImg = (src: string, assign: (img: HTMLImageElement) => void) => {
      const img = new Image();
      img.onload = () => {
        assign(img);
        this.state.ready = true;
      };
      img.src = src;
    };

    for (const t of [0, 1, 2] as const) {
      loadImg(`./sprites/buildings_t${t}.webp`, (img) => {
        this.state.buildings[t] = img;
      });
      loadImg(`./sprites/buildings_emissive_t${t}.webp`, (img) => {
        this.state.emissive[t] = img;
      });
    }
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
  ): Omit<BuildingSpriteSpec, "rotOffset"> {
    const tier: 0 | 1 | 2 = heightVal < 26 ? 0 : heightVal < 50 ? 1 : 2;
    const tm = ATLAS_TIERS[tier];
    const row = ARCHETYPE_ROW[archetype] ?? 5;
    const col = variantSlot * 4 + compassStep;
    return {
      tier,
      sx: col * tm.cellW,
      sy: row * tm.cellH,
      sw: tm.cellW,
      sh: tm.cellH,
      esx: col * EMISSIVE_CELL_W,
      esy: row * EMISSIVE_CELL_H,
      esw: EMISSIVE_CELL_W,
      esh: EMISSIVE_CELL_H,
      anchorX: tm.anchorX,
      anchorY: tm.anchorY,
      footprintPx: tm.footprintPx,
    };
  }

  /** Choose deterministic architectural variant + lot-aligned rotation for 2D sprite rendering. */
  getSpriteSpecForFile(
    file: Pick<FileMetric, "file_path" | "building_archetype">,
    bw: number,
    bd: number,
    heightVal: number,
    compassStep: 0 | 1 | 2 | 3,
  ): BuildingSpriteSpec {
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

  /** Draw sprite optionally tinted with cached offscreen tiles for 60fps Night/Golden/DataMap modes. */
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
    const cacheKey = `${sw}:${sx}:${sy}:${tintHex}:${Math.round(tintAlpha * 100)}`;
    let tile = this.tintCache.get(cacheKey);
    if (!tile) {
      const cw = Math.min(sw, 384);
      const ch = Math.min(sh, 576);
      tile = document.createElement("canvas");
      tile.width = cw;
      tile.height = ch;
      const tCtx = tile.getContext("2d");
      if (!tCtx) {
        ctx.drawImage(srcImg, sx, sy, sw, sh, dx, dy, dw, dh);
        return;
      }
      tCtx.globalCompositeOperation = "source-over";
      tCtx.drawImage(srcImg, sx, sy, sw, sh, 0, 0, cw, ch);
      tCtx.globalCompositeOperation = "source-atop";
      tCtx.fillStyle = tintHex;
      tCtx.globalAlpha = tintAlpha;
      tCtx.fillRect(0, 0, cw, ch);
      tCtx.globalAlpha = 1.0;
      tCtx.globalCompositeOperation = "source-over";

      if (this.tintCache.size >= 140) {
        const oldest = this.tintCache.keys().next().value;
        if (oldest !== undefined) this.tintCache.delete(oldest);
      }
      this.tintCache.set(cacheKey, tile);
    }

    ctx.drawImage(tile, 0, 0, tile.width, tile.height, dx, dy, dw, dh);
  }
}

export const spriteAtlas = new SpriteAtlasManager();
