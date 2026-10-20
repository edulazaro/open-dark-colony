// Pantalla de partida: HUD del original (intrface/maine + mainbut.spr), cámara, selección y órdenes.
import type { Spr } from '../data/spr';
import { DepKind, type DependItem } from '../data/stats';
import { dirFromVector, type AnimDB, type AnimRef } from '../render/anims';
import { SpriteCache } from '../render/gfx';
import { TerrainRenderer } from '../render/terrain';
import { WorldRenderer } from '../render/renderer';
import type { LoadedGame } from '../game/scenario';
import { World, TILE, TPS, NEUTRAL, type Entity } from '../game/world';
import { DEPLOY_INTO, MINING_TOWER, MINER, HUMAN } from '../game/rules';
import { AI } from '../game/ai';
import { saveToStorage } from '../game/save';
import { createMissionScript, stripColours, type MissionScript } from '../game/triggers';
import type { Layout, Widget } from './layout';
import type { BitmapFont } from './font';

export interface UiAssets {
  layout: Layout;
  mainbut: Spr;
  background: HTMLImageElement;
  font: BitmapFont;
  fontHi: BitmapFont;
  anims: AnimDB;
  unitNames: Map<number, string>;
}

export interface Sfx {
  playUnit(unitType: number, category: string, x?: number, y?: number): void;
  hasUnitSound(unitType: number, category: string): boolean;
  playWeapon(weaponSound: number, x: number, y: number): void;
  playId(id: number, x?: number, y?: number): void;
  playExplosion(boomType: number, x: number, y: number): void;
  setListener(x: number, y: number, viewW: number, viewH: number): void;
  setAmbient(terrainSet: string, night: boolean, blockType: number): void;
  update(dt: number): void;
  muted: boolean;
}

const VIEW_X = 4, VIEW_Y = 4, VIEW_W = 508, VIEW_H = 452;
const MINI_X = 518, MINI_Y = 6, MINI_W = 96, MINI_H = 84;
const DIGIT0 = 104;

type Tab = 0 | 1 | 2;
interface Btn {
  w: Widget;
  item?: DependItem;
  action?: string;
  enabled: boolean;
  label: string;
  toggled?: boolean;
}

export class GameScreen {
  readonly world: World;
  private renderer: WorldRenderer;
  private cache: SpriteCache;
  private butCache = new Map<number, HTMLCanvasElement>();
  private ais: AI[] = [];
  selected = new Set<Entity>();
  private groups = new Map<number, Entity[]>();
  private tab: Tab = 0;
  private showCommands = false;
  private attackMode = false;
  /** el ratón está sobre el lienzo (para el desplazamiento por los bordes) */
  hasMouse = false;
  private mouse = { x: 320, y: 240, down: false, button: 0, sx: 0, sy: 0, dragging: false, inView: false };
  private keys = new Set<string>();
  private acc = 0;
  speed = 1;
  paused = false;
  private messages: { text: string; t: number }[] = [];
  private status = '';
  private hoverBtn: Btn | null = null;
  private buttons: Btn[] = [];
  private lastClick = { t: 0, id: 0 };
  private cursorTick = 0;
  private overlay: string | null = null;
  onQuit?: () => void;
  private endShown = false;
  /** script de la misión (campaña) */
  readonly mission: MissionScript | null = null;
  private endText: string[] = [];
  /** panel informativo (objetivos de la misión) */
  private info: { title: string; lines: string[] } | null = null;

  constructor(
    private ctx: CanvasRenderingContext2D,
    private ui: UiAssets,
    readonly game: LoadedGame,
    private sfx?: Sfx,
  ) {
    this.world = game.world;
    this.cache = new SpriteCache(game.tileset.palette);
    const terrain = new TerrainRenderer(game.world.map, game.tileset);
    this.renderer = new WorldRenderer(game.world, terrain, ui.anims, this.cache);
    this.renderer.viewW = VIEW_W;
    this.renderer.viewH = VIEW_H;
    this.miniTerrain = terrain.mini;
    for (const t of this.world.teams) if (t && t.active && t.ai && t.id !== NEUTRAL && t.aiMode > 0 && t.aiMode <= 3) this.ais.push(new AI(this.world, t));
    const me = this.world.teams[this.world.player];
    const start = me?.city ?? this.world.ents.find((e) => e.team === this.world.player && e.alive);
    if (start) this.renderer.centerOn(start.x, start.y);
    this.world.hooks = {
      message: (text, team) => {
        if (team === this.world.player) this.message(text);
      },
      sound: (kind, e, extra) => this.onSound(kind, e, extra),
      explode: (boom, x, y) => {
        const [tx, ty] = this.world.tileOf(x, y);
        if (this.world.revealAll || this.world.fog[ty * this.world.w + tx] === 2) this.sfx?.playExplosion(boom, x, y);
      },
    };
    const title = game.scenario.title;
    this.message(`${title} — ${me?.race === HUMAN ? 'Humanos' : 'Taar'}`);
    if (game.mission) {
      const skirmish = game.setup.mode === 'skirmish';
      this.mission = createMissionScript(this.world, game.mission, {
        scnHeader: game.scenario.header,
        // opciones de multijugador: respiraderos que entran en erupción y se regeneran, 2 artefactos
        settings: skirmish ? { 3: 1, 4: 1, 6: 2 } : undefined,
        onEvent: (ev) => {
          switch (ev.type) {
            case 'dropship':
              if (ev.team === this.world.player) this.message(this.world.teams[ev.team]?.race === HUMAN ? 'Nave de desembarco en camino' : 'Teletransporte en curso');
              this.flyIn(ev.team, ev.x * TILE + 16, (this.world.h - 1 - ev.y) * TILE + 16, ev.landAt);
              break;
            case 'vent':
              if (ev.erupted) {
                this.message('Un respiradero de Petra-7 ha entrado en erupción');
                this.sfx?.playUnit(1, 'XTR', ev.vent.x, ev.vent.y);
              }
              break;
            case 'ai': {
              // la acción 'ai' activa o desactiva la IA de un equipo
              const team = this.world.teams[ev.team];
              if (!team || ev.team === this.world.player) break;
              team.aiMode = ev.mode;
              const has = this.ais.findIndex((a) => a.team === team);
              if (ev.mode > 0 && has < 0) this.ais.push(new AI(this.world, team));
              if (ev.mode === 0 && has >= 0) this.ais.splice(has, 1);
              break;
            }
          }
        },
      });
    }
  }

  private miniTerrain: HTMLCanvasElement;
  private miniFog: HTMLCanvasElement | null = null;

  message(text: string): void {
    this.messages.push({ text, t: performance.now() });
    if (this.messages.length > 6) this.messages.shift();
  }

  private onSound(kind: string, e: Entity, extra?: number): void {
    if (!this.sfx) return;
    const visible = this.world.visibleToPlayer(e);
    if (!visible && kind !== 'ack' && kind !== 'select') return;
    switch (kind) {
      case 'fire':
        if (extra !== undefined && extra >= 0) this.sfx.playWeapon(extra, e.x, e.y);
        break;
      case 'die':
        this.sfx.playUnit(e.type, 'DEA', e.x, e.y);
        break;
      case 'ack':
        if (e.team === this.world.player) this.sfx.playUnit(e.type, 'ACK');
        break;
      case 'select':
        this.sfx.playUnit(e.type, 'SEL');
        break;
      case 'build':
        if (e.team === this.world.player) this.sfx.playUnit(e.type, 'SEL');
        break;
      case 'deploy':
        this.sfx.playUnit(e.type, 'DPY', e.x, e.y);
        break;
      case 'capture':
        this.sfx.playUnit(3, 'XTR', e.x, e.y);
        break;
    }
  }

  // ───────────────────────────── bucle ─────────────────────────────

  update(dtMs: number): void {
    this.scrollCamera(dtMs);
    if (!this.paused && this.world.winner === null && !this.mission?.result) {
      this.acc += (dtMs / 1000) * TPS * this.speed;
      let n = 0;
      while (this.acc >= 1 && n < 8) {
        this.acc -= 1;
        n++;
        for (const ai of this.ais) ai.step();
        this.world.step();
        this.mission?.step();
        this.stepDrops();
      }
      if (n === 8) this.acc = 0;
    }
    for (const e of [...this.selected]) if (!e.alive) this.selected.delete(e);
    if (this.selected.size === 0) this.showCommands = false;
    this.cursorTick += dtMs;
    if (this.sfx) {
      const r = this.renderer;
      this.sfx.setListener(r.camX + VIEW_W / 2, r.camY + VIEW_H / 2, VIEW_W, VIEW_H);
      const [tx, ty] = this.world.tileOf(r.camX + VIEW_W / 2, r.camY + VIEW_H / 2);
      this.sfx.setAmbient(this.world.terrainSet, this.world.isNight(), (this.world.map.flags[ty * this.world.w + tx] >> 10) & 31);
      this.sfx.update(dtMs / 1000);
    }
    if (this.mission?.result && !this.endShown) {
      this.endShown = true;
      const r = this.mission.result;
      this.overlay = r.outcome === 'win' ? 'MISIÓN CUMPLIDA' : 'MISIÓN FALLIDA';
      this.endText = stripColours(r.text).split(/\r?\n/).flatMap((l) => wrapText(l.trim(), 72));
    }
    if (this.world.winner !== null && !this.endShown) {
      this.endShown = true;
      this.overlay = this.world.winner === this.world.player ? '¡VICTORIA!' : this.world.winner === -1 && !this.world.teams[this.world.player].defeated ? 'FIN DE LA PARTIDA' : 'DERROTA';
    }
  }

  private quit(): void {
    this.mission?.dispose();
    this.onQuit?.();
  }

  /** Naves de desembarco decorativas: llegan cuando aterriza la carga del script y se van. */
  private drops: { e: Entity; tx: number; ty: number; landAt: number; leaveAt: number }[] = [];

  private flyIn(team: number, tx: number, ty: number, landAt: number): void {
    const race = this.world.teams[team]?.race ?? HUMAN;
    // decorativa y neutral para no alterar los recuentos del script (b()/s())
    const e = this.world.spawn(race === HUMAN ? 92 : 93, NEUTRAL, tx, ty, {});
    e.kind = 'prop';
    e.flying = true;
    const frames = Math.max(1, landAt - (this.mission?.frame ?? 0));
    const dist = frames * Math.max(2, e.def.speed / 8);
    e.x = e.px = tx + dist * 0.6;
    e.y = e.py = ty - dist * 0.8;
    this.drops.push({ e, tx, ty, landAt, leaveAt: landAt + 25 });
  }

  private stepDrops(): void {
    const now = this.mission?.frame ?? 0;
    for (const d of this.drops) {
      const e = d.e;
      e.px = e.x;
      e.py = e.y;
      const leaving = now >= d.leaveAt;
      const gx = leaving ? d.tx - 600 : d.tx, gy = leaving ? d.ty - 800 : d.ty;
      const dx = gx - e.x, dy = gy - e.y;
      const dist = Math.hypot(dx, dy);
      const left = Math.max(1, (leaving ? 40 : d.landAt - now));
      const step = leaving ? Math.max(4, e.def.speed / 8) : dist / left;
      if (dist > 1) {
        e.x += (dx / dist) * Math.min(step, dist);
        e.y += (dy / dist) * Math.min(step, dist);
        e.dir = dirFromVector(dx, dy);
        this.world.setAnim(e, ['MOVE', 'STAND'], true);
      }
      if (leaving && now > d.leaveAt + 60) this.world.remove(e);
    }
    this.drops = this.drops.filter((d) => d.e.state !== 'dead');
  }

  /** Avanza la simulación `ticks` pasos (depuración / pruebas automáticas). */
  simulate(ticks: number): void {
    for (let i = 0; i < ticks && this.world.winner === null && !this.mission?.result; i++) {
      for (const ai of this.ais) ai.step();
      this.world.step();
      this.mission?.step();
      this.stepDrops();
    }
  }

  private scrollCamera(dtMs: number): void {
    const r = this.renderer;
    const sp = (0.7 * dtMs);
    let dx = 0, dy = 0;
    if (this.keys.has('ArrowLeft')) dx -= sp;
    if (this.keys.has('ArrowRight')) dx += sp;
    if (this.keys.has('ArrowUp')) dy -= sp;
    if (this.keys.has('ArrowDown')) dy += sp;
    const m = this.mouse;
    if (this.hasMouse) {
      if (m.x <= 2) dx -= sp;
      if (m.x >= 637) dx += sp;
      if (m.y <= 2) dy -= sp;
      if (m.y >= 477) dy += sp;
    }
    if (dx || dy) {
      r.camX += dx;
      r.camY += dy;
      r.clampCamera();
    }
  }

  // ───────────────────────────── dibujo ─────────────────────────────

  draw(): void {
    const ctx = this.ctx;
    const alpha = this.paused ? 1 : Math.min(1, this.acc);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 640, 480);
    ctx.drawImage(this.ui.background, 0, 0);
    this.renderer.render(ctx, VIEW_X, VIEW_Y, alpha, this.selected, this.hoverEntity());
    this.drawBox();
    this.drawMinimap();
    this.drawPanel();
    this.drawStatus();
    this.drawMessages();
    if (this.info) this.drawInfo();
    else if (this.overlay) this.drawOverlay(this.overlay);
    else if (this.paused) this.drawOverlay('PAUSA');
    this.drawCursor();
  }

  private drawBox(): void {
    const m = this.mouse;
    if (!m.dragging) return;
    const ctx = this.ctx;
    ctx.strokeStyle = '#7f7';
    ctx.lineWidth = 1;
    const x0 = Math.min(m.sx, m.x), y0 = Math.min(m.sy, m.y);
    ctx.strokeRect(Math.max(VIEW_X, x0) + 0.5, Math.max(VIEW_Y, y0) + 0.5, Math.abs(m.x - m.sx), Math.abs(m.y - m.sy));
  }

  private but(frame: number): HTMLCanvasElement | null {
    let c = this.butCache.get(frame);
    if (c === undefined) {
      const spr = this.ui.mainbut;
      c = spr.frames[frame] ? this.cache.get(spr, frame, 0, false) ?? undefined : undefined;
      if (c) this.butCache.set(frame, c);
    }
    return c ?? null;
  }

  private drawButton(b: Btn): void {
    const ctx = this.ctx;
    const c = this.but(b.w.normal);
    const pressed = this.hoverBtn === b && this.mouse.down;
    if (c) ctx.drawImage(c, b.w.x + (pressed ? 1 : 0), b.w.y + (pressed ? 1 : 0));
    if (!b.enabled) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(b.w.x, b.w.y, b.w.w, b.w.h);
    } else if (this.hoverBtn === b) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(b.w.x, b.w.y, b.w.w, b.w.h);
    }
    if (b.toggled) {
      ctx.strokeStyle = '#5f5';
      ctx.strokeRect(b.w.x + 1.5, b.w.y + 1.5, b.w.w - 3, b.w.h - 3);
    }
    if (b.item) {
      const team = this.world.teams[this.world.player];
      const n = this.world.queued(team, b.item);
      const q = this.world.queueOf(team, b.item);
      if (n > 0) {
        this.ui.fontHi.draw(ctx, String(n), b.w.x + b.w.w - 6, b.w.y + 3, 'right');
        if (q[0]?.item.id === b.item.id) {
          const f = q[0].done / q[0].total;
          ctx.fillStyle = '#000';
          ctx.fillRect(b.w.x + 3, b.w.y + b.w.h - 6, b.w.w - 10, 3);
          ctx.fillStyle = '#3c3';
          ctx.fillRect(b.w.x + 3, b.w.y + b.w.h - 6, Math.round((b.w.w - 10) * f), 3);
        }
      }
      if (b.item.kind !== DepKind.Unit && team.done.has(b.item.id)) {
        ctx.fillStyle = 'rgba(0,80,0,0.35)';
        ctx.fillRect(b.w.x, b.w.y, b.w.w, b.w.h);
      }
    }
  }

  private layoutButtons(): Btn[] {
    const L = this.ui.layout;
    const team = this.world.teams[this.world.player];
    const out: Btn[] = [];
    // pestañas
    for (const id of [0, 1, 2]) {
      const w = L.byId.get(id)?.find((x) => x.kind === 'pushb');
      if (w) out.push({ w, action: 'tab' + id, enabled: true, label: L.text.get(id) ?? '', toggled: !this.showCommands && this.tab === id });
    }
    const build = L.byId.get(19)?.[0];
    if (build) out.push({ w: build, action: 'build', enabled: true, label: L.text.get(19) ?? '' });
    if (!team) return out;
    if (this.showCommands) {
      const sel = [...this.selected].filter((e) => e.team === this.world.player);
      const add = (id: number, action: string, enabled = true, toggled = false) => {
        const w = L.byId.get(id)?.[0];
        if (w) out.push({ w, action, enabled, label: L.text.get(id) ?? action, toggled });
      };
      add(150, 'stop');
      add(33, 'move', true, !this.attackMode);
      add(35, 'attackmove', true, this.attackMode);
      const dep = sel.find((e) => DEPLOY_INTO[e.type] !== undefined);
      if (dep) {
        const into = DEPLOY_INTO[dep.type];
        add(MINING_TOWER.includes(into) ? 37 : into === 45 || into === 46 ? 140 : 139, 'deploy');
      }
      return out;
    }
    if (this.tab === 2) {
      const add = (id: number, action: string) => {
        const w = L.byId.get(id)?.[0];
        if (w) out.push({ w, action, enabled: true, label: L.text.get(id) ?? action });
      };
      add(62, 'quit');
      add(63, 'save');
      add(196, 'pause');
      add(202, 'objectives');
      add(64, 'speed');
      return out;
    }
    // construcción / investigación: un botón por posición, el siguiente nivel disponible
    const kinds = this.tab === 0 ? [DepKind.Building, DepKind.Unit] : [DepKind.Upgrade];
    const bySlot = new Map<string, { w: Widget; item: DependItem }[]>();
    for (const item of this.world.rules.buildable(team.race)) {
      if (!kinds.includes(item.kind)) continue;
      const w = L.byId.get(item.msg)?.find((x) => x.kind === 'count');
      if (!w) continue;
      const k = `${w.x},${w.y}`;
      let arr = bySlot.get(k);
      if (!arr) bySlot.set(k, (arr = []));
      arr.push({ w, item });
    }
    for (const arr of bySlot.values()) {
      arr.sort((a, b) => a.item.level - b.item.level || a.item.id - b.item.id);
      const pick = arr.find((x) => !team.done.has(x.item.id) || x.item.kind === DepKind.Unit) ?? arr[arr.length - 1];
      const label = (L.text.get(pick.item.msg) ?? '').replace(/\s+\d+$/, '');
      out.push({ w: pick.w, item: pick.item, enabled: this.world.available(team, pick.item) || this.world.queued(team, pick.item) > 0, label: `${label}  ${pick.item.cost}` });
    }
    return out;
  }

  private drawPanel(): void {
    this.buttons = this.layoutButtons();
    for (const b of this.buttons) this.drawButton(b);
  }

  /** Contador con los dígitos de mainbut.spr (12×17), rellenado con ceros como el original. */
  private drawDigits(n: number, x: number, y: number, digits: number): void {
    const s = String(Math.max(0, Math.min(10 ** digits - 1, Math.floor(n)))).padStart(digits, '0');
    let px = x;
    for (const ch of s) {
      const c = this.but(DIGIT0 + (ch.charCodeAt(0) - 48));
      if (c) this.ctx.drawImage(c, px, y);
      px += 12;
    }
  }

  private drawStatus(): void {
    const ctx = this.ctx;
    const team = this.world.teams[this.world.player];
    if (team) this.drawDigits(team.money, 524, 456, 6);
    this.drawDigits(this.world.day(), 610, 431, 2);
    // reloj de día/noche
    const t = this.world.timeOfDay();
    const a = t * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = this.world.isNight() ? '#88f' : '#fd4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(622, 464);
    ctx.lineTo(622 + Math.cos(a) * 9, 464 + Math.sin(a) * 9);
    ctx.stroke();
    ctx.lineWidth = 1;
    // línea de estado (sobre el botón de construir)
    let s = this.status;
    if (this.hoverBtn) s = this.hoverBtn.label;
    else if (this.selected.size === 1) {
      const e = [...this.selected][0];
      s = this.unitName(e.type);
      if (e.kind === 'vent') s = `Petra-7: ${Math.floor(e.amount)}`;
    } else if (this.selected.size > 1) s = `${this.selected.size} unidades`;
    this.ui.font.draw(ctx, s.slice(0, 22), 521, 405);
  }

  unitName(type: number): string {
    return this.ui.unitNames.get(type) ?? this.world.rules.unit(type).sprite;
  }

  private drawMessages(): void {
    const now = performance.now();
    this.messages = this.messages.filter((m) => now - m.t < 8000);
    const scriptMsg = this.mission?.currentMessage;
    const last = this.messages[this.messages.length - 1];
    if (scriptMsg) this.ui.fontHi.draw(this.ctx, stripColours(scriptMsg.text).slice(0, 72), 52, 463);
    else if (last) this.ui.font.draw(this.ctx, last.text.slice(0, 70), 52, 463);
    // mensajes recientes sobre la vista de juego
    let y = VIEW_Y + 6;
    for (const m of this.messages.slice(-4)) {
      this.ui.fontHi.draw(this.ctx, m.text.slice(0, 70), VIEW_X + 6, y);
      y += 12;
    }
  }

  private drawMinimap(): void {
    const ctx = this.ctx;
    const w = this.world;
    const sc = Math.min(MINI_W / w.w, MINI_H / w.h);
    const mw = w.w * sc, mh = w.h * sc;
    const mx = MINI_X + (MINI_W - mw) / 2, my = MINI_Y + (MINI_H - mh) / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(MINI_X, MINI_Y, MINI_W, MINI_H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.miniTerrain, mx, my, mw, mh);
    ctx.imageSmoothingEnabled = false;
    // niebla (una imagen de 1 píxel por casilla, escalada)
    if (!w.revealAll) {
      if (!this.miniFog) {
        this.miniFog = document.createElement('canvas');
        this.miniFog.width = w.w;
        this.miniFog.height = w.h;
      }
      const fctx = this.miniFog.getContext('2d')!;
      const img = fctx.createImageData(w.w, w.h);
      for (let i = 0; i < w.fog.length; i++) img.data[i * 4 + 3] = w.fog[i] === 2 ? 0 : w.fog[i] === 1 ? 128 : 255;
      fctx.putImageData(img, 0, 0);
      ctx.drawImage(this.miniFog, mx, my, mw, mh);
    }
    for (const e of w.ents) {
      if (!e.alive || !w.visibleToPlayer(e) || e.kind === 'prop') continue;
      const x = mx + (e.x / TILE) * sc, y = my + (e.y / TILE) * sc;
      ctx.fillStyle = e.kind === 'vent' ? '#3cf' : this.renderer.teamColour(e.team);
      const s = e.kind === 'building' ? 4 : 2;
      ctx.fillRect(Math.round(x - s / 2), Math.round(y - s / 2), s, s);
    }
    const r = this.renderer;
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(mx + (r.camX / TILE) * sc + 0.5, my + (r.camY / TILE) * sc + 0.5, (VIEW_W / TILE) * sc, (VIEW_H / TILE) * sc);
  }

  private drawInfo(): void {
    const ctx = this.ctx;
    const info = this.info!;
    const h = 44 + info.lines.length * 12;
    const y0 = VIEW_Y + Math.max(6, VIEW_H / 2 - h / 2);
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(VIEW_X + 8, y0, VIEW_W - 16, h);
    ctx.strokeStyle = '#4a4';
    ctx.strokeRect(VIEW_X + 8.5, y0 + 0.5, VIEW_W - 17, h - 1);
    this.ui.fontHi.draw(ctx, info.title, VIEW_X + VIEW_W / 2, y0 + 8, 'center');
    info.lines.forEach((l, i) => this.ui.font.draw(ctx, l, VIEW_X + 18, y0 + 26 + i * 12));
  }

  private drawOverlay(text: string): void {
    const ctx = this.ctx;
    if (this.endText.length) {
      const h = 50 + this.endText.length * 12;
      const y0 = VIEW_Y + Math.max(10, VIEW_H / 2 - h / 2);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(VIEW_X + 10, y0, VIEW_W - 20, h);
      this.ui.fontHi.draw(ctx, text, VIEW_X + VIEW_W / 2, y0 + 10, 'center');
      this.endText.forEach((l, i) => this.ui.font.draw(ctx, l, VIEW_X + 22, y0 + 30 + i * 12));
      this.ui.font.draw(ctx, 'Pulsa ESC para volver al menú', VIEW_X + VIEW_W / 2, y0 + h - 14, 'center');
      return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(VIEW_X, VIEW_Y + VIEW_H / 2 - 30, VIEW_W, 60);
    this.ui.fontHi.draw(ctx, text, VIEW_X + VIEW_W / 2, VIEW_Y + VIEW_H / 2 - 12, 'center');
    if (this.world.winner !== null || this.mission?.result) this.ui.font.draw(ctx, 'Pulsa ESC para volver al menú', VIEW_X + VIEW_W / 2, VIEW_Y + VIEW_H / 2 + 6, 'center');
    else if (this.overlay) this.ui.font.draw(ctx, 'Pulsa cualquier tecla', VIEW_X + VIEW_W / 2, VIEW_Y + VIEW_H / 2 + 6, 'center');
  }

  private cursorAnim(): AnimRef | undefined {
    const a = this.ui.anims;
    const m = this.mouse;
    if (!this.inView(m.x, m.y)) return a.get('DEFAULT');
    const r = this.renderer;
    if (m.x <= 2 && m.y <= 2) return a.get('PUSHUP&LEFT');
    if (m.x >= 637 && m.y <= 2) return a.get('PUSHUP&RIGHT');
    if (m.x <= 2 && m.y >= 477) return a.get('DOWN&LEFT');
    if (m.x >= 637 && m.y >= 477) return a.get('DOWN&RIGHT');
    if (m.x <= 2) return a.get('PUSHLEFT');
    if (m.x >= 637) return a.get('PUSHRIGHT');
    if (m.y <= 2) return a.get('PUSHUP');
    if (m.y >= 477) return a.get('PUSHDOWN');
    if (m.dragging) return a.get('DRAWBOX');
    const h = this.hoverEntity();
    const mine = [...this.selected].some((e) => e.team === this.world.player && e.kind === 'unit');
    if (h && mine && this.world.enemies(this.world.player, h.team)) return a.get('ATTACK');
    if (h && mine && h.kind === 'vent' && [...this.selected].some((e) => MINER.includes(e.type))) return a.get('DIG');
    if (h && (h.team === this.world.player || h.kind === 'vent')) return a.get('UNITSELECT');
    if (mine) return this.attackMode ? a.get('ATTACK') : a.get('MOVE');
    void r;
    return a.get('DEFAULT');
  }

  private drawCursor(): void {
    const ref = this.cursorAnim();
    const ctx = this.ctx;
    if (!ref) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(this.mouse.x, this.mouse.y, 3, 3);
      return;
    }
    const n = this.ui.anims.frameCount(ref);
    const frame = this.ui.anims.frame(ref, Math.floor(this.cursorTick / 120) % n);
    if (!frame) return;
    for (const p of frame.parts) {
      const spr = this.ui.anims.sprs.get(p.juice);
      const f = spr?.frames[p.sprite];
      if (!spr || !f) continue;
      const c = this.cache.get(spr, p.sprite, 0, p.flip);
      if (c) ctx.drawImage(c, this.mouse.x + p.dx + (p.flip ? 0 : f.x), this.mouse.y + p.dy - f.h);
    }
  }

  // ───────────────────────────── entrada ─────────────────────────────

  private inView(x: number, y: number): boolean {
    return x >= VIEW_X && y >= VIEW_Y && x < VIEW_X + VIEW_W && y < VIEW_Y + VIEW_H;
  }

  private toWorld(x: number, y: number): [number, number] {
    return [x - VIEW_X + this.renderer.camX, y - VIEW_Y + this.renderer.camY];
  }

  private hoverEntity(): Entity | undefined {
    if (!this.inView(this.mouse.x, this.mouse.y) || this.mouse.dragging) return undefined;
    const [wx, wy] = this.toWorld(this.mouse.x, this.mouse.y);
    return this.world.pick(wx, wy);
  }

  private miniToWorld(x: number, y: number): [number, number] | null {
    const w = this.world;
    const sc = Math.min(MINI_W / w.w, MINI_H / w.h);
    const mx = MINI_X + (MINI_W - w.w * sc) / 2, my = MINI_Y + (MINI_H - w.h * sc) / 2;
    if (x < mx || y < my || x > mx + w.w * sc || y > my + w.h * sc) return null;
    return [((x - mx) / sc) * TILE, ((y - my) / sc) * TILE];
  }

  mouseMove(x: number, y: number): void {
    const m = this.mouse;
    m.x = x;
    m.y = y;
    m.inView = this.inView(x, y);
    if (m.down && m.button === 0 && !m.dragging && this.inView(m.sx, m.sy) && Math.hypot(x - m.sx, y - m.sy) > 4) m.dragging = true;
    if (m.down && m.button === 0 && this.miniToWorld(m.sx, m.sy)) {
      const p = this.miniToWorld(x, y);
      if (p) this.renderer.centerOn(p[0], p[1]);
    }
    this.hoverBtn = this.buttons.find((b) => x >= b.w.x && y >= b.w.y && x < b.w.x + b.w.w && y < b.w.y + b.w.h) ?? null;
  }

  mouseDown(x: number, y: number, button: number, shift: boolean): void {
    if (this.info) {
      this.info = null;
      return;
    }
    if (this.overlay && this.world.winner === null && !this.mission?.result) this.overlay = null;
    const m = this.mouse;
    this.mouseMove(x, y);
    m.down = true;
    m.button = button;
    m.sx = x;
    m.sy = y;
    m.dragging = false;
    const mp = this.miniToWorld(x, y);
    if (mp) {
      if (button === 0) this.renderer.centerOn(mp[0], mp[1]);
      else this.orderAt(mp[0], mp[1], undefined, shift);
      return;
    }
    if (!this.inView(x, y)) {
      if (this.hoverBtn) this.clickButton(this.hoverBtn, button);
      return;
    }
    if (button === 2) {
      const [wx, wy] = this.toWorld(x, y);
      this.orderAt(wx, wy, this.world.pick(wx, wy), shift);
    }
  }

  mouseUp(x: number, y: number, button: number, shift: boolean, ctrl: boolean): void {
    const m = this.mouse;
    this.mouseMove(x, y);
    if (!m.down) return;
    m.down = false;
    if (button !== 0 || !this.inView(m.sx, m.sy)) {
      m.dragging = false;
      return;
    }
    if (m.dragging) {
      m.dragging = false;
      const [x0, y0] = this.toWorld(Math.min(m.sx, x), Math.min(m.sy, y));
      const [x1, y1] = this.toWorld(Math.max(m.sx, x), Math.max(m.sy, y));
      const inBox = this.world.ents.filter(
        (e) => e.alive && e.team === this.world.player && e.kind === 'unit' && e.x >= x0 && e.x <= x1 && e.y + e.box.y0 / 2 >= y0 && e.y + e.box.y0 / 2 <= y1,
      );
      if (!shift) this.selected.clear();
      inBox.forEach((e) => this.selected.add(e));
      if (inBox.length) this.afterSelect(inBox[0]);
      return;
    }
    const [wx, wy] = this.toWorld(x, y);
    const e = this.world.pick(wx, wy);
    const now = performance.now();
    if (e && e.team === this.world.player && (ctrl || (now - this.lastClick.t < 350 && this.lastClick.id === e.id))) {
      // doble clic: todas las del mismo tipo en pantalla
      const r = this.renderer;
      for (const o of this.world.ents)
        if (o.alive && o.team === e.team && o.type === e.type && o.x >= r.camX && o.x <= r.camX + VIEW_W && o.y >= r.camY && o.y <= r.camY + VIEW_H) this.selected.add(o);
      this.afterSelect(e);
      return;
    }
    this.lastClick = { t: now, id: e?.id ?? 0 };
    if (!e) {
      // clic izquierdo en el suelo con unidades seleccionadas = mover (como en el original)
      const mine = [...this.selected].filter((s) => s.team === this.world.player && s.kind === 'unit');
      if (mine.length && !shift) {
        this.orderAt(wx, wy, undefined, false);
        return;
      }
      if (!shift) this.selected.clear();
      return;
    }
    if (shift) {
      if (this.selected.has(e)) this.selected.delete(e);
      else this.selected.add(e);
    } else {
      const mine = [...this.selected].filter((s) => s.team === this.world.player && s.kind === 'unit');
      if (mine.length && (this.world.enemies(this.world.player, e.team) || (e.kind === 'vent' && mine.some((u) => MINER.includes(u.type))))) {
        this.orderAt(wx, wy, e, false);
        return;
      }
      this.selected.clear();
      this.selected.add(e);
    }
    this.afterSelect(e);
  }

  private afterSelect(e: Entity): void {
    if (e.team === this.world.player && e.kind === 'unit') {
      this.showCommands = true;
      this.world.hooks.sound?.('select', e);
    }
  }

  private orderAt(wx: number, wy: number, target: Entity | undefined, shift: boolean): void {
    const units = [...this.selected].filter((e) => e.team === this.world.player && e.kind === 'unit' && e.alive);
    if (!units.length) return;
    if (target && this.world.enemies(this.world.player, target.team) && target.alive) {
      this.world.command(units, { type: 'attack', x: target.x, y: target.y, target: target.id });
      this.effect('CONFIRMATACK', target.x, target.y);
      return;
    }
    if (target && target.kind === 'vent') {
      const miners = units.filter((u) => MINER.includes(u.type));
      if (miners.length) {
        this.world.deploy(miners.slice(0, 1), target);
        this.effect('CONFIRMOVE', target.x, target.y);
        const rest = units.filter((u) => u !== miners[0]);
        if (rest.length) this.world.command(rest, { type: 'move', x: wx, y: wy });
        return;
      }
    }
    this.world.command(units, { type: this.attackMode ? 'attackmove' : 'move', x: wx, y: wy }, shift);
    this.effect(shift ? 'WAYPOINTS' : this.attackMode ? 'CONFIRMATACK' : 'CONFIRMOVE', wx, wy);
  }

  private effect(name: string, x: number, y: number): void {
    const ref = this.ui.anims.get(name);
    if (ref) this.world.addEffect(ref, x, y, 0, true);
  }

  private clickButton(b: Btn, button: number): void {
    if (b.action?.startsWith('tab')) {
      this.tab = parseInt(b.action.slice(3), 10) as Tab;
      this.showCommands = false;
      return;
    }
    const sel = [...this.selected].filter((e) => e.team === this.world.player);
    switch (b.action) {
      case 'build':
        this.showCommands = false;
        this.tab = 0;
        return;
      case 'stop':
        this.world.stop(sel);
        return;
      case 'move':
        this.attackMode = false;
        return;
      case 'attackmove':
        this.attackMode = true;
        return;
      case 'deploy':
        this.world.deploy(sel);
        return;
      case 'quit':
        this.quit();
        return;
      case 'pause':
        this.paused = !this.paused;
        return;
      case 'save':
        // el estado interno de los disparadores de campaña no se guarda: sólo escaramuza
        if (this.game.setup.mode === 'campaign') this.message('Guardar sólo está disponible en escaramuza');
        else this.message(saveToStorage(this.game) ? 'Partida guardada' : 'No se pudo guardar la partida');
        return;
      case 'speed':
        this.speed = this.speed >= 3 ? 1 : this.speed + 1;
        this.message(`Velocidad x${this.speed}`);
        return;
      case 'objectives': {
        // briefing de la misión (.TXT) en un panel; se cierra con cualquier tecla o clic
        const brief = this.game.mission?.briefing;
        const lines = brief
          ? stripColours(brief).split(/\r?\n/).flatMap((l) => wrapText(l.trim(), 72))
          : ['Destruye todas las fuerzas enemigas.'];
        this.info = { title: 'OBJETIVOS', lines: lines.slice(0, 28) };
        return;
      }
    }
    if (b.item) {
      const team = this.world.teams[this.world.player];
      if (button === 2) this.world.cancel(team, b.item);
      else if (!this.world.enqueue(team, b.item) && this.world.available(team, b.item) === false) this.message('Requisitos no cumplidos');
    }
  }

  keyDown(key: string, code: string, ctrl: boolean, shift: boolean): void {
    if (this.info) {
      this.info = null;
      return;
    }
    if (this.overlay && this.world.winner === null && !this.mission?.result) {
      this.overlay = null;
      return;
    }
    this.keys.add(key);
    const sel = [...this.selected].filter((e) => e.team === this.world.player);
    if (key === 'Escape') {
      if (this.world.winner !== null || this.mission?.result) this.quit();
      else this.selected.clear();
      return;
    }
    if (/^Digit[0-9]$/.test(code)) {
      const n = parseInt(code.slice(5), 10);
      if (ctrl) {
        this.groups.set(n, sel.filter((e) => e.kind === 'unit'));
        this.message(`Grupo ${n} asignado`);
      } else {
        const g = (this.groups.get(n) ?? []).filter((e) => e.alive);
        if (g.length) {
          if (!shift) this.selected.clear();
          g.forEach((e) => this.selected.add(e));
          this.showCommands = true;
        }
      }
      return;
    }
    switch (key.toLowerCase()) {
      case 's':
        this.world.stop(sel);
        break;
      case 'a':
        this.attackMode = !this.attackMode;
        break;
      case 'd':
        this.world.deploy(sel);
        break;
      case 'p':
      case 'pause':
        this.paused = !this.paused;
        break;
      case ' ': {
        const e = sel[0];
        if (e) this.renderer.centerOn(e.x, e.y);
        break;
      }
      case 'h': {
        const c = this.world.teams[this.world.player]?.city;
        if (c) this.renderer.centerOn(c.x, c.y);
        break;
      }
      case '+':
        this.speed = Math.min(4, this.speed + 1);
        this.message(`Velocidad x${this.speed}`);
        break;
      case '-':
        this.speed = Math.max(1, this.speed - 1);
        this.message(`Velocidad x${this.speed}`);
        break;
      case 'm':
        if (this.sfx) {
          this.sfx.muted = !this.sfx.muted;
          this.message(this.sfx.muted ? 'Sonido desactivado' : 'Sonido activado');
        }
        break;
      case 'f9':
        this.world.revealAll = !this.world.revealAll;
        break;
      case 'f10':
        this.world.teams[this.world.player].money += 5000;
        break;
    }
  }

  keyUp(key: string): void {
    this.keys.delete(key);
  }
}

function wrapText(text: string, cols: number): string[] {
  if (!text) return [''];
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if ((line + ' ' + w).trim().length > cols) {
      out.push(line.trim());
      line = w;
    } else line += ' ' + w;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}
