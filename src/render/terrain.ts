// Render del terreno a lienzos por bloques de 16×16 casillas, más la imagen del minimapa.
import type { GameMap, Tileset } from '../data/map';
import { Palette } from './gfx';

const CHUNK = 16;
const TS = 32;

export class TerrainRenderer {
  private chunks: (HTMLCanvasElement | null)[];
  readonly cw: number;
  readonly ch: number;
  readonly pal: Palette;
  /** minimapa: 1 píxel por casilla */
  readonly mini: HTMLCanvasElement;

  constructor(private map: GameMap, private ts: Tileset) {
    this.pal = new Palette(ts.palette);
    this.cw = Math.ceil(map.w / CHUNK);
    this.ch = Math.ceil(map.h / CHUNK);
    this.chunks = new Array(this.cw * this.ch).fill(null);
    this.mini = this.buildMini();
  }

  private renderChunk(cx: number, cy: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = CHUNK * TS;
    c.height = CHUNK * TS;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(c.width, c.height);
    const out = new Uint32Array(img.data.buffer);
    const rgba = this.pal.rgba;
    const { w, h, base, over } = this.map;
    for (let ty = 0; ty < CHUNK; ty++) {
      const my = cy * CHUNK + ty;
      if (my >= h) break;
      for (let tx = 0; tx < CHUNK; tx++) {
        const mx = cx * CHUNK + tx;
        if (mx >= w) break;
        const i = my * w + mx;
        const b = this.ts.tiles.get(base[i]);
        const o = over[i] ? this.ts.tiles.get(over[i]) : undefined;
        for (let y = 0; y < TS; y++) {
          let p = (ty * TS + y) * c.width + tx * TS;
          for (let x = 0; x < TS; x++, p++) {
            const k = y * TS + x;
            const v = o && o[k] ? o[k] : b ? b[k] : 0;
            out[p] = rgba[v];
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  private chunk(cx: number, cy: number): HTMLCanvasElement {
    const i = cy * this.cw + cx;
    let c = this.chunks[i];
    if (!c) c = this.chunks[i] = this.renderChunk(cx, cy);
    return c;
  }

  /** Dibuja la zona del mundo [x, y, w, h] en ctx con origen (ox, oy). */
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ox: number, oy: number): void {
    const S = CHUNK * TS;
    const x0 = Math.max(0, Math.floor(x / S)), x1 = Math.min(this.cw - 1, Math.floor((x + w) / S));
    const y0 = Math.max(0, Math.floor(y / S)), y1 = Math.min(this.ch - 1, Math.floor((y + h) / S));
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++) ctx.drawImage(this.chunk(cx, cy), ox + cx * S - x, oy + cy * S - y);
  }

  private buildMini(): HTMLCanvasElement {
    const { w, h, base, over } = this.map;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    const pal = this.ts.palette;
    for (let i = 0; i < w * h; i++) {
      const t = (over[i] && this.ts.tiles.get(over[i])) || this.ts.tiles.get(base[i]);
      let r = 0, g = 0, b = 0, n = 0;
      if (t)
        for (let k = 0; k < 1024; k += 37) {
          const v = t[k];
          if (!v) continue;
          r += pal[v * 3];
          g += pal[v * 3 + 1];
          b += pal[v * 3 + 2];
          n++;
        }
      n = n || 1;
      img.data[i * 4] = r / n;
      img.data[i * 4 + 1] = g / n;
      img.data[i * 4 + 2] = b / n;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
}
