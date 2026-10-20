// Índice de animaciones (.FIN) y dibujo de frames compuestos.
//
// Regla de colocación obtenida del renderizador original (FUN_0044f95c / FUN_00432dec):
//   izquierda = x + dx + (espejo ? 0 : spr.x)
//   abajo     = y + dy            (el sprite se apoya por su borde inferior)
// Capas: 0 normal, 1 normal (con sombra), 2 sólo sombra, 3 luz (mapa de luz nocturno),
//        4/5 efectos translúcidos/aditivos.
import { parseFin, frameTicks, type Fin, type FinAnim, type FinFrame } from '../data/fin';
import { parseSpr, type Spr } from '../data/spr';
import { fetchBin, fetchText } from '../data/vfs';
import type { SpriteCache } from './gfx';

export interface AnimRef {
  fin: Fin;
  anim: FinAnim;
  name: string;
  dir: number;
}

/** Direcciones del original: 0 = sur, 4 = oeste, 8 = norte, 12 = este (16 en total). */
export function dirFromVector(vx: number, vy: number): number {
  const a = Math.atan2(-vx, vy);
  return ((Math.round((a / (Math.PI * 2)) * 16) % 16) + 16) % 16;
}

export function dirDelta(a: number, b: number): number {
  let d = (b - a) % 16;
  if (d > 8) d -= 16;
  if (d < -8) d += 16;
  return d;
}

export class AnimDB {
  readonly fins: Fin[] = [];
  readonly sprs = new Map<string, Spr>();
  /** base (nombre sin dígitos finales) -> dirección -> referencia (-1 = sin dirección) */
  private byBase = new Map<string, Map<number, AnimRef>>();
  private byName = new Map<string, AnimRef>();

  async load(onProgress?: (done: number, total: number) => void): Promise<void> {
    const list = (await fetchText('ANIM.DAT')).split(/\s+/).filter(Boolean);
    let done = 0;
    const total = list.length * 2;
    await Promise.all(
      list.map(async (f) => {
        const fin = parseFin(f, await fetchBin('animate/' + f));
        this.fins.push(fin);
        onProgress?.(++done, total);
      }),
    );
    const juices = new Set<string>();
    for (const fin of this.fins) for (const j of fin.juice) juices.add(j);
    const jt = juices.size;
    let jd = 0;
    await Promise.all(
      [...juices].map(async (j) => {
        try {
          this.sprs.set(j, parseSpr(j, await fetchBin(`sprites/${j}.spr`)));
        } catch {
          /* sprite ausente: se ignora */
        }
        onProgress?.(list.length + Math.round((++jd / jt) * list.length), total);
      }),
    );
    // Índice por nombre: el último fichero cargado no pisa a uno anterior con el mismo nombre.
    for (const fin of this.fins) {
      for (const anim of fin.anims) {
        const m = /^(.*?)(\d*)$/.exec(anim.name)!;
        const base = m[1].trim();
        const dir = m[2] === '' ? -1 : parseInt(m[2], 10);
        const ref: AnimRef = { fin, anim, name: anim.name, dir };
        if (!this.byName.has(anim.name)) this.byName.set(anim.name, ref);
        let dm = this.byBase.get(base);
        if (!dm) this.byBase.set(base, (dm = new Map()));
        if (!dm.has(dir)) dm.set(dir, ref);
      }
    }
  }

  get(name: string): AnimRef | undefined {
    return this.byName.get(name.toUpperCase());
  }

  has(base: string): boolean {
    return this.byBase.has(base.toUpperCase());
  }

  /**
   * Busca la primera acción disponible y la dirección más cercana a `dir`. Con `exactFirst`
   * se prefiere cualquier acción que tenga exactamente esa dirección (p. ej. SHUF en las impares).
   */
  find(prefix: string, actions: string[], dir = 0, exactFirst = false): AnimRef | undefined {
    if (exactFirst) {
      for (const act of actions) {
        const ref = this.byBase.get((prefix + act).toUpperCase())?.get(dir);
        if (ref) return ref;
      }
    }
    for (const act of actions) {
      const dm = this.byBase.get((prefix + act).toUpperCase());
      if (!dm) continue;
      if (dm.has(dir)) return dm.get(dir);
      let best: AnimRef | undefined;
      let bestD = 99;
      for (const [d, ref] of dm) {
        const dd = d < 0 ? 50 : Math.abs(dirDelta(dir, d));
        if (dd < bestD) {
          bestD = dd;
          best = ref;
        }
      }
      if (best) return best;
    }
    return undefined;
  }

  frameCount(ref: AnimRef): number {
    return Math.max(1, ref.anim.last - ref.anim.first + 1);
  }

  frame(ref: AnimRef, i: number): FinFrame | undefined {
    const n = this.frameCount(ref);
    return ref.fin.frames[ref.anim.first + (((i % n) + n) % n)];
  }

  ticks(ref: AnimRef, i: number): number {
    const f = this.frame(ref, i);
    return f ? frameTicks(f.delay) : 2;
  }

  /** Caja (relativa al ancla) que ocupan las partes de cuerpo de un frame. */
  bounds(ref: AnimRef, i = 0): { x0: number; y0: number; x1: number; y1: number } {
    const f = this.frame(ref, i);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    if (f) {
      for (const p of f.parts) {
        if (p.layer === 3 || p.layer >= 4) continue;
        const spr = this.sprs.get(p.juice);
        const c = spr?.frames[p.sprite];
        if (!c || c.w <= 0) continue;
        const left = p.dx + (p.flip ? 0 : c.x);
        const bottom = p.dy;
        x0 = Math.min(x0, left);
        x1 = Math.max(x1, left + c.w);
        y0 = Math.min(y0, bottom - c.h);
        y1 = Math.max(y1, bottom);
      }
    }
    if (x0 > x1) return { x0: -12, y0: -30, x1: 12, y1: 2 };
    return { x0, y0, x1, y1 };
  }
}

export interface DrawOpts {
  team: number;
  /** omitir capas de luz (3) */
  lights?: boolean;
  alpha?: number;
}

/** Dibuja un frame compuesto con el ancla en (ax, ay) (coordenadas de lienzo). */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  db: AnimDB,
  cache: SpriteCache,
  frame: FinFrame,
  ax: number,
  ay: number,
  o: DrawOpts,
): void {
  const a0 = o.alpha ?? 1;
  ctx.globalAlpha = a0;
  const parts = frame.parts;
  for (let pass = 0; pass < 2; pass++) {
    for (const p of parts) {
      const effect = p.layer >= 4;
      if ((pass === 0) === effect) continue;
      if (p.layer === 3 && !o.lights) continue;
      const spr = db.sprs.get(p.juice);
      if (!spr) continue;
      const f = spr.frames[p.sprite];
      if (!f) continue;
      const shadow = p.layer === 2;
      const c = cache.get(spr, p.sprite, shadow ? -1 : o.team, p.flip);
      if (!c) continue;
      const left = ax + p.dx + (p.flip ? 0 : f.x);
      const top = ay + p.dy - f.h;
      if (effect || p.layer === 3) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = a0 * 0.9;
        ctx.drawImage(c, left, top);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = a0;
      } else if (shadow) {
        ctx.globalAlpha = a0 * 0.4;
        ctx.drawImage(c, left, top);
        ctx.globalAlpha = a0;
      } else {
        ctx.drawImage(c, left, top);
      }
    }
  }
  ctx.globalAlpha = 1;
}
