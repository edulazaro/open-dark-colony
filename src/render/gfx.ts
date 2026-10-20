// Conversión de sprites paletizados a lienzos RGBA, con remapeo de color de equipo.
import type { Spr, SprFrame } from '../data/spr';

/** Rampa de 6 tonos que el juego usa como color de equipo ("teal"), índices 138..143. */
export const TEAM_RAMP_START = 138;
export const TEAM_RAMP_LEN = 6;

/** Colores de equipo: primer índice de cada rampa de 6 tonos en la paleta de terreno. */
export const TEAM_RAMPS = [138, 96, 102, 108, 120, 126, 114, 132];
export const TEAM_NAMES = ['cian', 'rojo', 'azul', 'amarillo', 'verde', 'naranja', 'violeta', 'marrón'];

/** Entrada de paleta "vacía" (45,0,63)·4 que los .SPR dejan para que la rellene el terreno. */
function isPlaceholder(p: Uint8Array, i: number): boolean {
  return p[i * 3] === 182 && p[i * 3 + 1] === 0 && p[i * 3 + 2] === 255;
}

export class Palette {
  /** RGBA empaquetado (little endian: 0xAABBGGRR) */
  readonly rgba = new Uint32Array(256);
  constructor(rgb: Uint8Array) {
    for (let i = 0; i < 256; i++) {
      this.rgba[i] = (255 << 24) | (rgb[i * 3 + 2] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3];
    }
  }
  css(i: number): string {
    const v = this.rgba[i];
    return `rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})`;
  }
}

/**
 * Construye la paleta efectiva de un sprite: la suya propia, con los huecos rellenados
 * desde la paleta del terreno y la rampa de equipo sustituida por la del equipo.
 */
export function spritePalette(spr: Spr, terrain: Uint8Array | null, team: number): Uint32Array {
  const out = new Uint32Array(256);
  const src = spr.palette;
  const rgbAt = (pal: Uint8Array, i: number) => (255 << 24) | (pal[i * 3 + 2] << 16) | (pal[i * 3 + 1] << 8) | pal[i * 3];
  for (let i = 0; i < 256; i++) {
    out[i] = terrain && isPlaceholder(src, i) ? rgbAt(terrain, i) : rgbAt(src, i);
  }
  const ramp = TEAM_RAMPS[team % TEAM_RAMPS.length];
  if (ramp !== TEAM_RAMP_START) {
    const from = terrain ?? src;
    for (let k = 0; k < TEAM_RAMP_LEN; k++) out[TEAM_RAMP_START + k] = rgbAt(from, ramp + k);
  } else {
    for (let k = 0; k < TEAM_RAMP_LEN; k++) out[TEAM_RAMP_START + k] = rgbAt(src, TEAM_RAMP_START + k);
  }
  return out;
}

export function frameToCanvas(f: SprFrame, pal: Uint32Array, flip = false): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, f.w);
  c.height = Math.max(1, f.h);
  if (f.w <= 0 || f.h <= 0) return c;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(f.w, f.h);
  const out = new Uint32Array(img.data.buffer);
  const px = f.pixels;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const v = px[y * f.w + x];
      if (v) out[y * f.w + (flip ? f.w - 1 - x : x)] = pal[v];
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Caché de lienzos por (sprite, frame, equipo, espejo). */
export class SpriteCache {
  private cache = new Map<string, HTMLCanvasElement>();
  private pals = new Map<string, Uint32Array>();
  constructor(private terrain: Uint8Array | null) {}

  setTerrainPalette(p: Uint8Array) {
    this.terrain = p;
    this.cache.clear();
    this.pals.clear();
  }

  get(spr: Spr, frame: number, team: number, flip: boolean): HTMLCanvasElement | null {
    const f = spr.frames[frame];
    if (!f || f.w <= 0 || f.h <= 0) return null;
    const key = `${spr.name}|${frame}|${team}|${flip ? 1 : 0}`;
    let c = this.cache.get(key);
    if (!c) {
      const pk = `${spr.name}|${team}`;
      let pal = this.pals.get(pk);
      if (!pal) {
        // equipo -1 = silueta negra (sombras)
        pal = team < 0 ? new Uint32Array(256).fill(0xff000000) : spritePalette(spr, this.terrain, team);
        this.pals.set(pk, pal);
      }
      c = frameToCanvas(f, pal, flip);
      this.cache.set(key, c);
    }
    return c;
  }
}
