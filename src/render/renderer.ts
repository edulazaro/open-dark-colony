// Dibuja el mundo: terreno, entidades (partes ordenadas por profundidad como el original),
// efectos, proyectiles, selección, niebla de guerra y noche.
import type { World, Entity } from '../game/world';
import { TILE } from '../game/world';
import { MINING_TOWER } from '../game/rules';
import type { AnimDB } from './anims';
import type { SpriteCache } from './gfx';
import { TEAM_RAMPS } from './gfx';
import type { TerrainRenderer } from './terrain';
import type { FinFrame } from '../data/fin';

interface DrawItem {
  c: HTMLCanvasElement;
  x: number;
  y: number;
  depth: number;
  mode: 0 | 1 | 2 | 3 | 4; // normal, aditivo (capa 4), sombra, luz, translúcido (capa 5)
  alpha: number;
}

/**
 * Sombra proyectada de las partes de capa 1, como el blitter original (FUN_0045c7b0): la silueta
 * se aplasta a 0x28/256 de su altura y se cizalla 0x80/256 hacia la izquierda desde la base.
 */
interface ShadowItem {
  c: HTMLCanvasElement;
  left: number;
  bottom: number;
  h: number;
}
const SHADOW_SQUASH = 0x28 / 256;
const SHADOW_SHEAR = (0x80 / 256) * (1 + SHADOW_SQUASH);

export class WorldRenderer {
  camX = 0;
  camY = 0;
  viewW = 508;
  viewH = 452;
  private fogCanvas: HTMLCanvasElement;
  private fogImg: ImageData;
  private teamCss: string[] = [];

  constructor(
    private world: World,
    private terrain: TerrainRenderer,
    private anims: AnimDB,
    private cache: SpriteCache,
  ) {
    this.fogCanvas = document.createElement('canvas');
    this.fogCanvas.width = world.w;
    this.fogCanvas.height = world.h;
    this.fogImg = this.fogCanvas.getContext('2d')!.createImageData(world.w, world.h);
    for (let t = 0; t < 9; t++) {
      const team = world.teams[t];
      const ramp = TEAM_RAMPS[(team?.colour ?? t) % TEAM_RAMPS.length];
      this.teamCss[t] = terrain.pal.css(ramp + 1);
    }
  }

  teamColour(team: number): string {
    return this.teamCss[team] ?? '#ccc';
  }

  clampCamera(): void {
    this.camX = Math.max(0, Math.min(this.world.w * TILE - this.viewW, this.camX));
    this.camY = Math.max(0, Math.min(this.world.h * TILE - this.viewH, this.camY));
  }

  centerOn(x: number, y: number): void {
    this.camX = x - this.viewW / 2;
    this.camY = y - this.viewH / 2;
    this.clampCamera();
  }

  private shadows: ShadowItem[] = [];
  private shadowCanvas: HTMLCanvasElement | null = null;

  private pushFrame(items: DrawItem[], frame: FinFrame | undefined, ax: number, ay: number, team: number, depthBias: number, alpha: number, lights: boolean, cast = false): void {
    if (!frame) return;
    for (const p of frame.parts) {
      if (p.layer === 3 && !lights) continue;
      const spr = this.anims.sprs.get(p.juice);
      const f = spr?.frames[p.sprite];
      if (!spr || !f) continue;
      if (cast && p.layer === 1 && alpha >= 1) {
        const sc = this.cache.get(spr, p.sprite, -1, p.flip);
        if (sc) this.shadows.push({ c: sc, left: ax + p.dx + (p.flip ? 0 : f.x), bottom: ay + p.dy, h: f.h });
      }
      const shadow = p.layer === 2;
      const c = this.cache.get(spr, p.sprite, shadow ? -1 : team, p.flip);
      if (!c) continue;
      const left = ax + p.dx + (p.flip ? 0 : f.x);
      const bottom = ay + p.dy;
      items.push({
        c,
        x: Math.round(left),
        y: Math.round(bottom - f.h),
        depth: bottom + depthBias + (shadow ? -2000 : 0),
        mode: p.layer === 4 ? 1 : p.layer >= 5 ? 4 : shadow ? 2 : p.layer === 3 ? 3 : 0,
        alpha,
      });
    }
  }

  render(ctx: CanvasRenderingContext2D, ox: number, oy: number, alphaT: number, selected: Set<Entity>, hover?: Entity): void {
    const w = this.world;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, this.viewW, this.viewH);
    ctx.clip();
    const cx = Math.round(this.camX), cy = Math.round(this.camY);
    this.terrain.draw(ctx, cx, cy, this.viewW, this.viewH, ox, oy);

    const items: DrawItem[] = [];
    const lights: DrawItem[] = [];
    const margin = 260;
    for (const e of w.ents) {
      const x = e.px + (e.x - e.px) * alphaT;
      const y = e.py + (e.y - e.py) * alphaT;
      if (x < cx - margin || x > cx + this.viewW + margin || y < cy - 80 || y > cy + this.viewH + margin * 1.4) continue;
      if (!w.visibleToPlayer(e)) continue;
      if (!e.anim) continue;
      // durante la animación de salida (efecto referido a la ciudad) la unidad aún no se dibuja
      if (e.state === 'spawn' && e.kind === 'unit') continue;
      const frame = this.anims.frame(e.anim, e.animFrame);
      const bias = e.flying ? 100000 : e.state === 'dead' || e.state === 'die' ? (e.kind === 'building' ? 0 : -60) : 0;
      const alpha = e.state === 'die' && e.deathTicks > 15 * 30 ? Math.max(0, 1 - (e.deathTicks - 450) / 150) : 1;
      const colour = w.teams[e.team]?.colour ?? e.team;
      const start = items.length;
      this.pushFrame(items, frame, ox - cx + x, oy - cy + y, colour, bias, alpha, true, !e.flying && e.state !== 'dead');
      // separar las luces para el pase nocturno
      for (let i = items.length - 1; i >= start; i--) if (items[i].mode === 3) lights.push(items.splice(i, 1)[0]);
    }
    for (const f of w.effects) {
      if (f.x < cx - margin || f.x > cx + this.viewW + margin || f.y < cy - margin || f.y > cy + this.viewH + margin) continue;
      const [tx, ty] = w.tileOf(f.x, f.y);
      if (!w.revealAll && w.fog[ty * w.w + tx] !== 2) continue;
      const start = items.length;
      this.pushFrame(items, this.anims.frame(f.anim, f.frame), ox - cx + f.x, oy - cy + f.y, w.teams[f.team]?.colour ?? 0, f.air ? 100000 : 20, 1, true);
      for (let i = items.length - 1; i >= start; i--) if (items[i].mode === 3) lights.push(items.splice(i, 1)[0]);
    }
    this.drawShadows(ctx, ox, oy);
    items.sort((a, b) => a.depth - b.depth);
    for (const it of items) {
      if (it.mode === 1) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = it.alpha * 0.85;
      } else if (it.mode === 4) ctx.globalAlpha = it.alpha * 0.7;
      else if (it.mode === 2) ctx.globalAlpha = it.alpha * 0.35;
      else ctx.globalAlpha = it.alpha;
      ctx.drawImage(it.c, it.x, it.y);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;

    // proyectiles
    for (const p of w.projectiles) {
      if (p.weapon.cls !== 3 && !p.anim) continue;
      const sx = ox - cx + p.x, sy = oy - cy + p.y;
      if (p.anim) {
        const its: DrawItem[] = [];
        this.pushFrame(its, this.anims.frame(p.anim, Math.floor(p.t / 2)), sx, sy, 0, 0, 1, false);
        for (const it of its) {
          if (it.mode === 1 || it.mode === 4) ctx.globalCompositeOperation = 'lighter';
          ctx.drawImage(it.c, it.x, it.y);
          ctx.globalCompositeOperation = 'source-over';
        }
      } else {
        ctx.fillStyle = '#ffd27a';
        ctx.fillRect(sx - 2, sy - 2, 4, 4);
      }
    }

    // selección y vida
    for (const e of selected) this.drawSelection(ctx, e, ox - cx, oy - cy, alphaT, true);
    if (hover && !selected.has(hover)) this.drawSelection(ctx, hover, ox - cx, oy - cy, alphaT, false);

    // noche: oscurecer y añadir las luces
    const dark = this.nightAmount();
    if (dark > 0) {
      ctx.fillStyle = `rgba(4,6,28,${dark * 0.55})`;
      ctx.fillRect(ox, oy, this.viewW, this.viewH);
      ctx.globalCompositeOperation = 'lighter';
      for (const it of lights) {
        ctx.globalAlpha = dark * 0.8;
        ctx.drawImage(it.c, it.x, it.y);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    this.drawFog(ctx, ox - cx, oy - cy);
    ctx.restore();
  }

  /** Todas las sombras en negro sobre una capa aparte y luego una sola mezcla (sin doble oscurecido). */
  private drawShadows(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
    if (!this.shadows.length) return;
    if (!this.shadowCanvas) {
      this.shadowCanvas = document.createElement('canvas');
      this.shadowCanvas.width = this.viewW;
      this.shadowCanvas.height = this.viewH;
    }
    const sctx = this.shadowCanvas.getContext('2d')!;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, this.viewW, this.viewH);
    for (const s of this.shadows) {
      sctx.setTransform(1, 0, SHADOW_SHEAR, SHADOW_SQUASH, s.left - ox - SHADOW_SHEAR * s.h, s.bottom - oy - SHADOW_SQUASH * s.h);
      sctx.drawImage(s.c, 0, 0);
    }
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    this.shadows = [];
    ctx.globalAlpha = 0.38;
    ctx.drawImage(this.shadowCanvas, ox, oy);
    ctx.globalAlpha = 1;
  }

  nightAmount(): number {
    return this.world.darkness();
  }


  private drawSelection(ctx: CanvasRenderingContext2D, e: Entity, ox: number, oy: number, a: number, sel: boolean): void {
    if (!e.alive) return;
    const x = ox + e.px + (e.x - e.px) * a, y = oy + e.py + (e.y - e.py) * a;
    const b = e.box;
    const x0 = Math.round(x + b.x0) - 1, y0 = Math.round(y + b.y0) - 1, x1 = Math.round(x + b.x1) + 1, y1 = Math.round(y + b.y1) + 1;
    ctx.strokeStyle = sel ? (e.team === this.world.player ? '#5f5' : '#f55') : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    const k = Math.min(6, (x1 - x0) / 3);
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]] as const) {
      ctx.moveTo(cx + 0.5 + dx * k, cy + 0.5);
      ctx.lineTo(cx + 0.5, cy + 0.5);
      ctx.lineTo(cx + 0.5, cy + 0.5 + dy * k);
    }
    ctx.stroke();
    if (e.kind === 'vent') {
      this.bar(ctx, x0, y0 - 5, x1 - x0, Math.min(1, e.amount / 15000), '#4cf');
      return;
    }
    if (sel || e.hp < e.maxHp) {
      const f = Math.max(0, e.hp / e.maxHp);
      this.bar(ctx, x0, y0 - 5, x1 - x0, f, f > 0.6 ? '#3e3' : f > 0.3 ? '#ee3' : '#e33');
    }
    if (MINING_TOWER.includes(e.type) && e.ventId) {
      const v = this.world.get(e.ventId);
      if (v) this.bar(ctx, x0, y0 - 9, x1 - x0, Math.min(1, v.amount / 15000), '#4cf');
    }
  }

  private bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, f: number, col: string): void {
    w = Math.max(16, w);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x, y, w, 3);
    ctx.fillStyle = col;
    ctx.fillRect(x, y, Math.round(w * f), 3);
  }

  private drawFog(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
    const w = this.world;
    if (w.revealAll) return;
    const d = this.fogImg.data;
    for (let i = 0; i < w.fog.length; i++) {
      const f = w.fog[i];
      d[i * 4 + 3] = f === 2 ? 0 : f === 1 ? 120 : 255;
    }
    this.fogCanvas.getContext('2d')!.putImageData(this.fogImg, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fogCanvas, 0, 0, w.w, w.h, ox - TILE / 2, oy - TILE / 2, w.w * TILE + TILE, w.h * TILE + TILE);
    ctx.imageSmoothingEnabled = false;
  }
}
