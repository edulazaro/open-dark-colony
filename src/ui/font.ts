// Fuentes bitmap del original (intrface/mfonto*.spr): frame = código - desplazamiento (31),
// el frame 0 guarda la celda (ancho/alto) de la fuente.
import type { Spr } from '../data/spr';
import { frameToCanvas } from '../render/gfx';

export class BitmapFont {
  private glyphs: (HTMLCanvasElement | null)[] = [];
  readonly cellW: number;
  readonly cellH: number;

  constructor(private spr: Spr, private offset = 31, tint?: [number, number, number]) {
    const pal = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = spr.palette[i * 3], g = spr.palette[i * 3 + 1], b = spr.palette[i * 3 + 2];
      if (tint) {
        const l = (r + g + b) / 765;
        r = tint[0] * l;
        g = tint[1] * l;
        b = tint[2] * l;
      }
      pal[i] = (255 << 24) | (b << 16) | (g << 8) | r;
    }
    this.cellW = spr.frames[0]?.w ?? 6;
    this.cellH = spr.frames[0]?.h ?? 10;
    this.glyphs = spr.frames.map((f) => (f.w > 0 && f.h > 0 ? frameToCanvas(f, pal) : null));
  }

  private frame(ch: number) {
    return this.spr.frames[ch - this.offset];
  }

  /** La fuente original no tiene acentos ni eñe: se normalizan a ASCII. */
  static ascii(text: string): string {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[¡¿]/g, '');
  }

  width(text: string): number {
    text = BitmapFont.ascii(text);
    let w = 0;
    for (const ch of text) w += this.advance(ch.charCodeAt(0));
    return w;
  }

  private advance(code: number): number {
    const f = this.frame(code);
    if (!f || f.w <= 0) return Math.ceil(this.cellW * 0.7);
    return f.x + f.w + 1;
  }

  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: 'left' | 'center' | 'right' = 'left'): number {
    const up = BitmapFont.ascii(text);
    let px = align === 'left' ? x : align === 'center' ? x - this.width(up) / 2 : x - this.width(up);
    px = Math.round(px);
    for (const ch of up) {
      const code = ch.charCodeAt(0);
      const f = this.frame(code);
      const g = this.glyphs[code - this.offset];
      if (f && g) ctx.drawImage(g, px + f.x, y + f.y);
      px += this.advance(code);
    }
    return px;
  }
}
