// Simulación: entidades, órdenes, combate, economía, producción y niebla de guerra.
import { FLAG_PASSABLE, type GameMap } from '../data/map';
import type { UnitDef, WeaponDef, DependItem } from '../data/stats';
import { DepKind } from '../data/stats';
import { AnimDB, dirFromVector, dirDelta, type AnimRef } from '../render/anims';
import { PathGrid } from './pathfind';
import { Rules, DEPLOY_INTO, MINING_TOWER, VENT, ARTIFACTS, COMMANDERS } from './rules';

export const TILE = 32;
/** minas desplegadas (humana / alien) */
const MINES = [45, 46];
/** unidades sanadoras (Medi-craft / Zisp) */
const HEALERS = [49, 50];
export const TPS = 15;
export const NEUTRAL = 8;

export type EntKind = 'unit' | 'building' | 'vent' | 'prop';
export type State = 'idle' | 'move' | 'fire' | 'die' | 'dead' | 'spawn' | 'deploy';

export interface Order {
  type: 'idle' | 'move' | 'attack' | 'attackmove' | 'deploy';
  x: number;
  y: number;
  target?: number;
}

export interface Hooks {
  sound?(kind: 'fire' | 'die' | 'select' | 'ack' | 'build' | 'deploy' | 'capture', e: Entity, extra?: number): void;
  /** explosión de tipo BOOMSTAT (9.º campo de WEAPSTAT) */
  explode?(boom: number, x: number, y: number): void;
  message?(text: string, team: number): void;
}

export class Entity {
  id = 0;
  def: UnitDef;
  kind: EntKind = 'unit';
  x = 0;
  y = 0;
  px = 0;
  py = 0;
  dir = 0;
  hp = 1;
  maxHp = 1;
  state: State = 'idle';
  order: Order = { type: 'idle', x: 0, y: 0 };
  path: [number, number][] = [];
  repathIn = 0;
  stuck = 0;
  cooldown = 0;
  targetId = 0;
  acquireIn = 0;
  // animación
  anim: AnimRef | undefined;
  animFrame = 0;
  animTick = 0;
  animLoop = true;
  animDone = false;
  deathTicks = 0;
  /** respiraderos: Petra-7 restante; torres: id del respiradero */
  amount = 0;
  /** respiraderos: caudal (0 = dormido; los scripts de misión lo cambian con newrate) */
  rate = 20;
  ventId = 0;
  flying = false;
  /** caja del cuerpo relativa al ancla (para selección y blancos) */
  box = { x0: -12, y0: -36, x1: 12, y1: 2 };
  radius = 10;
  family = -1;
  level = 0;
  spawnTicks = 0;
  hitFlash = 0;
  lastAttacker = 0;
  /** bajas causadas por esta unidad (ascensos del comandante) */
  kills = 0;
  /** órdenes de movimiento encoladas (puntos de ruta) */
  waypoints: Order[] = [];
  constructor(public type: number, def: UnitDef, public team: number) {
    this.def = def;
  }
  get alive(): boolean {
    return this.state !== 'die' && this.state !== 'dead';
  }
  get cx(): number {
    return this.x + (this.box.x0 + this.box.x1) / 2;
  }
  get cy(): number {
    return this.y + (this.box.y0 + this.box.y1) / 2;
  }
}

export interface ProdJob {
  item: DependItem;
  done: number;
  total: number;
}

export interface Team {
  id: number;
  /** bando: equipos del mismo bando son aliados */
  side: number;
  race: number;
  colour: number;
  money: number;
  active: boolean;
  ai: boolean;
  /** modo de IA del original (%AI del .SCN / acción 'ai' del script): 0 ninguna, 3 completa */
  aiMode: number;
  defeated: boolean;
  city: { x: number; y: number; tx: number; ty: number } | null;
  rally: { x: number; y: number } | null;
  queues: { build: ProdJob[]; unit: ProdJob[]; research: ProdJob[] };
  /** DEPEND ids completados (edificios en pie y mejoras investigadas) */
  done: Set<number>;
  upgrades: Map<number, { weapon: number; armor: number }>;
  kills: number;
  losses: number;
}

export interface Effect {
  anim: AnimRef;
  x: number;
  y: number;
  frame: number;
  tick: number;
  team: number;
  air: boolean;
}

export interface Projectile {
  x: number;
  y: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  t: number;
  dur: number;
  arc: number;
  weapon: WeaponDef;
  team: number;
  owner: number;
  targetId: number;
  anim?: AnimRef;
}

const ACT_STAND = ['STAND', 'SHUF', 'MOVE'];
const ACT_MOVE = ['MOVE', 'MOVEC', 'STAND'];
const ACT_FIRE = ['FIREA', 'FIRE', 'FIREB', 'FIG', 'FIREC', 'STAND'];
const ACT_DIE = [['DIEA', 'DIE', 'DIEB', 'DIEC'], ['DIEB', 'DIE', 'DIEA'], ['DIEC', 'DIEA', 'DIE']];

export class World {
  readonly w: number;
  readonly h: number;
  readonly grid: PathGrid;
  /** casillas bloqueadas por edificios (contador) */
  private occupied: Uint16Array;
  ents: Entity[] = [];
  private byId = new Map<number, Entity>();
  private nextId = 1;
  teams: Team[] = [];
  effects: Effect[] = [];
  projectiles: Projectile[] = [];
  tick = 0;
  /**
   * Reloj día/noche del original (cabecera del .SCN): media jornada en ticks, fase inicial,
   * si empieza de noche y ticks de transición. La fase avanza 1 por tick; al superar la media
   * jornada vuelve a 0 y alterna día/noche (mismo reloj que MissionScript).
   */
  clock = { half: 6750, phase0: 0, night0: 0, trans: 75 };
  player = 0;
  /** niebla del jugador: 0 sin explorar, 1 explorado, 2 visible */
  fog: Uint8Array;
  revealAll = false;
  hooks: Hooks = {};
  private bucket = new Map<number, Entity[]>();
  winner: number | null = null;
  /** en campaña la victoria la decide el script de la misión (.TRO) */
  autoVictory = true;

  constructor(
    readonly rules: Rules,
    readonly anims: AnimDB,
    readonly map: GameMap,
    readonly terrainSet: string,
  ) {
    this.w = map.w;
    this.h = map.h;
    this.grid = new PathGrid(this.w, this.h);
    this.occupied = new Uint16Array(this.w * this.h);
    for (let i = 0; i < this.w * this.h; i++) this.grid.open[i] = map.flags[i] & FLAG_PASSABLE ? 1 : 0;
    this.fog = new Uint8Array(this.w * this.h);
  }

  // ───────────────────────────── utilidades ─────────────────────────────

  get(id: number): Entity | undefined {
    const e = this.byId.get(id);
    return e && e.state !== 'dead' ? e : undefined;
  }

  setClock(header: number[]): void {
    if (header.length >= 6 && header[3] > 0) this.clock = { half: header[3], phase0: header[4], night0: header[2] ? 1 : 0, trans: Math.max(1, header[5]) };
  }

  private clockState(): { phase: number; night: number; cycles: number } {
    const { half, phase0, night0 } = this.clock;
    const total = phase0 + this.tick;
    const cycles = Math.floor(total / (half + 1));
    return { phase: total % (half + 1), night: night0 ^ (cycles & 1), cycles };
  }

  isNight(): boolean {
    return this.clockState().night === 1;
  }

  /** Oscuridad 0..1 con la transición gradual del original. */
  darkness(): number {
    const { phase, night } = this.clockState();
    const trans = this.clock.trans;
    if (phase <= trans) {
      const k = phase / trans;
      return night ? k : 1 - k;
    }
    return night;
  }

  /** 0..1 a lo largo del ciclo de día/noche */
  timeOfDay(): number {
    const { phase, night } = this.clockState();
    return (night ? 0.5 : 0) + (phase / (this.clock.half + 1)) * 0.5;
  }

  day(): number {
    const { cycles } = this.clockState();
    return Math.floor((cycles + this.clock.night0) / 2) + 1;
  }

  enemies(a: number, b: number): boolean {
    if (a === b) return false;
    if (a === NEUTRAL || b === NEUTRAL) return false;
    return (this.teams[a]?.side ?? a) !== (this.teams[b]?.side ?? b);
  }

  tileOf(x: number, y: number): [number, number] {
    return [Math.max(0, Math.min(this.w - 1, Math.floor(x / TILE))), Math.max(0, Math.min(this.h - 1, Math.floor(y / TILE)))];
  }

  visibleToPlayer(e: Entity): boolean {
    if (this.revealAll || e.team === this.player) return true;
    // las minas enemigas son invisibles (en el original sólo S.A.R.G.E. y Gorrem las detectan)
    if (MINES.includes(e.type) && !this.ents.some((d) => d.team === this.player && d.alive && (d.type === 4 || d.type === 12) && Math.hypot(d.x - e.x, d.y - e.y) < 5 * TILE)) return false;
    const [tx, ty] = this.tileOf(e.cx, e.cy);
    const f = this.fog[ty * this.w + tx];
    if (e.kind === 'building' || e.kind === 'vent' || e.kind === 'prop') return f >= 1;
    return f === 2;
  }

  vision(e: Entity): number {
    const night = this.isNight();
    return Math.max(2, night ? e.def.visNight : e.def.visDay);
  }

  weapon(e: Entity): WeaponDef | undefined {
    const up = this.teams[e.team]?.upgrades.get(e.type);
    return this.rules.weaponFor(e.type, up?.weapon ?? 0);
  }

  // ───────────────────────────── creación ─────────────────────────────

  addTeam(t: Partial<Team> & { id: number; race: number }): Team {
    const team: Team = {
      side: t.id,
      colour: t.id,
      money: 0,
      active: true,
      ai: false,
      aiMode: 0,
      defeated: false,
      city: null,
      rally: null,
      queues: { build: [], unit: [], research: [] },
      done: new Set(),
      upgrades: new Map(),
      kills: 0,
      losses: 0,
      ...t,
    };
    this.teams[t.id] = team;
    return team;
  }

  spawn(type: number, team: number, x: number, y: number, opts: { hp?: number; dir?: number; amount?: number; rate?: number } = {}): Entity {
    const def = this.rules.unit(type);
    const e = new Entity(type, def, team);
    e.id = this.nextId++;
    e.x = e.px = x;
    e.y = e.py = y;
    e.dir = opts.dir ?? 0;
    e.maxHp = Math.max(1, def.hp);
    e.hp = opts.hp && opts.hp > 0 ? Math.min(opts.hp, e.maxHp) : e.maxHp;
    // el campo vale 1 también en los edificios (capa alta del dibujo): sólo cuenta en unidades móviles
    e.flying = (def.fly === 1 || def.fly === 2) && def.speed > 0 && !this.rules.isBuilding(type);
    if (type === VENT) {
      e.kind = 'vent';
      e.amount = opts.amount && opts.amount > 0 ? opts.amount : 15000;
      e.rate = opts.rate ?? 20;
      e.team = NEUTRAL;
    } else if (this.rules.isBuilding(type)) {
      e.kind = 'building';
      const bf = this.rules.buildingFamily(type);
      if (bf) {
        e.family = bf.family;
        e.level = bf.level;
      }
    } else if (def.race < 0 || def.noSelect) {
      e.kind = 'prop';
    }
    this.setAnim(e, ACT_STAND, true);
    e.box = this.anims.bounds(e.anim ?? this.anims.find(def.sprite, ACT_STAND)!, 0);
    if (e.anim) e.box = this.anims.bounds(e.anim, 0);
    e.radius = Math.max(8, Math.min(48, (e.box.x1 - e.box.x0) / 2));
    if (e.kind === 'building') e.radius = Math.max(e.radius, 40);
    this.ents.push(e);
    this.byId.set(e.id, e);
    return e;
  }

  /** Coloca la ciudad de un equipo y bloquea la plataforma. */
  setCity(team: Team, tx: number, ty: number): void {
    team.city = { tx, ty, x: tx * TILE + 16, y: ty * TILE + 16 };
    team.rally = { x: team.city.x, y: team.city.y + 110 };
    for (let dy = -3; dy <= 2; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        if ((dx / 3.6) ** 2 + ((dy + 0.5) / 2.6) ** 2 > 1) continue;
        const x = tx + dx, y = ty + dy;
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        this.occupied[y * this.w + x]++;
        this.grid.open[y * this.w + x] = 0;
      }
  }

  /** Crea (o mejora) un edificio de la ciudad. */
  placeBuilding(team: Team, family: number, level: number, animate: boolean, hp = -1): Entity | null {
    if (!team.city) return null;
    const type = this.rules.buildingType(team.race, family, level);
    const old = this.ents.find((e) => e.team === team.id && e.kind === 'building' && e.family === family && e.alive);
    if (old) this.remove(old);
    const e = this.spawn(type, team.id, team.city.x, team.city.y, { hp });
    e.family = family;
    e.level = level;
    if (animate) {
      const b = this.anims.find(e.def.sprite, ['BUILD'], 0);
      if (b) {
        e.state = 'spawn';
        this.playAnim(e, b, false);
      }
    }
    this.refreshDone(team);
    return e;
  }

  /** Para cargar partidas: conserva los ids guardados (órdenes y torres los referencian). */
  reassignId(e: Entity, id: number): void {
    this.byId.delete(e.id);
    e.id = id;
    this.byId.set(id, e);
  }

  bumpIds(next: number): void {
    this.nextId = Math.max(this.nextId, next);
  }

  remove(e: Entity): void {
    e.state = 'dead';
    e.hp = 0;
    this.byId.delete(e.id);
    this.ents = this.ents.filter((x) => x !== e);
  }

  // ───────────────────────────── animación ─────────────────────────────

  playAnim(e: Entity, ref: AnimRef | undefined, loop: boolean): void {
    if (!ref) return;
    if (e.anim === ref && loop && e.animLoop) return;
    e.anim = ref;
    e.animFrame = 0;
    e.animTick = this.anims.ticks(ref, 0);
    e.animLoop = loop;
    e.animDone = false;
  }

  setAnim(e: Entity, actions: string[], loop: boolean): void {
    const d = Math.round(e.dir) & 15;
    let ref = this.anims.find(e.def.sprite, actions, d, actions === ACT_STAND);
    // si el original no tiene esa dirección para el movimiento, se usa la par más cercana
    if (!ref && actions !== ACT_STAND) ref = this.anims.find(e.def.sprite, ACT_STAND, d);
    this.playAnim(e, ref, loop);
  }

  private stepAnim(e: Entity): void {
    if (!e.anim || e.animDone) return;
    if (--e.animTick > 0) return;
    const n = this.anims.frameCount(e.anim);
    if (e.animFrame + 1 >= n) {
      if (e.animLoop) e.animFrame = 0;
      else {
        e.animDone = true;
        return;
      }
    } else e.animFrame++;
    e.animTick = this.anims.ticks(e.anim, e.animFrame);
  }

  addEffect(ref: AnimRef | undefined, x: number, y: number, team = 0, air = false): void {
    if (!ref) return;
    this.effects.push({ anim: ref, x, y, frame: 0, tick: this.anims.ticks(ref, 0), team, air });
  }

  // ───────────────────────────── órdenes ─────────────────────────────

  command(units: Entity[], order: Order, append = false): void {
    const mobile = units.filter((u) => u.alive && u.kind === 'unit' && u.def.speed > 0 && u.state !== 'spawn' && u.state !== 'deploy');
    if (!mobile.length) return;
    // formación: repartir destinos en una rejilla alrededor del punto
    const n = mobile.length;
    const cols = Math.ceil(Math.sqrt(n));
    const spacing = 26;
    mobile.forEach((u, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const ox = (c - (cols - 1) / 2) * spacing;
      const oy = (r - (Math.ceil(n / cols) - 1) / 2) * spacing;
      const o: Order = { ...order };
      if (order.type === 'move' || order.type === 'attackmove') {
        o.x = order.x + (n > 1 ? ox : 0);
        o.y = order.y + (n > 1 ? oy : 0);
      }
      // con Mayús, las órdenes de movimiento se encolan como puntos de ruta
      if (append && u.order.type !== 'idle' && (o.type === 'move' || o.type === 'attackmove')) {
        u.waypoints.push(o);
        return;
      }
      u.waypoints = [];
      u.order = o;
      u.targetId = order.type === 'attack' ? (order.target ?? 0) : 0;
      u.path = [];
      u.repathIn = 0;
      u.stuck = 0;
      if (u.state === 'fire') u.state = 'idle';
    });
    this.hooks.sound?.('ack', mobile[0]);
  }

  stop(units: Entity[]): void {
    for (const u of units) {
      if (u.kind !== 'unit' || !u.alive) continue;
      u.waypoints = [];
      u.order = { type: 'idle', x: u.x, y: u.y };
      u.targetId = 0;
      u.path = [];
    }
  }

  /** Orden de despliegue (mineros sobre respiraderos, torretas, minas). */
  deploy(units: Entity[], vent?: Entity): void {
    for (const u of units) {
      if (!u.alive || DEPLOY_INTO[u.type] === undefined) continue;
      if (MINING_TOWER.includes(DEPLOY_INTO[u.type])) {
        const v = vent ?? this.nearestFreeVent(u.x, u.y);
        if (!v) {
          this.hooks.message?.('No hay respiraderos libres de Petra-7', u.team);
          continue;
        }
        u.order = { type: 'deploy', x: v.x, y: v.y, target: v.id };
      } else {
        if (this.nearCity(u.x, u.y, u.team)) {
          this.hooks.message?.('No se puede desplegar tan cerca de la ciudad', u.team);
          continue;
        }
        u.order = { type: 'deploy', x: u.x, y: u.y };
      }
      u.path = [];
      u.repathIn = 0;
    }
  }

  nearCity(x: number, y: number, team: number): boolean {
    const c = this.teams[team]?.city;
    return !!c && Math.hypot(x - c.x, y - c.y) < 5 * TILE;
  }

  nearestFreeVent(x: number, y: number, activeOnly = false): Entity | undefined {
    let best: Entity | undefined;
    let bd = 1e12;
    for (const v of this.ents) {
      if (v.kind !== 'vent' || v.amount <= 0 || (activeOnly && v.rate <= 0)) continue;
      if (this.ents.some((t) => t.alive && t.ventId === v.id)) continue;
      if (this.ents.some((u) => u.alive && u.order.type === 'deploy' && u.order.target === v.id && Math.hypot(u.x - x, u.y - y) > 1)) continue;
      const d = (v.x - x) ** 2 + (v.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  // ───────────────────────────── producción ─────────────────────────────

  /** ¿Cumple el equipo los requisitos de un elemento de DEPEND.TXT? */
  available(team: Team, item: DependItem): boolean {
    if (item.kind === DepKind.Building) {
      if (item.extra !== team.race || !team.city) return false;
      if (team.done.has(item.id)) return false;
      // un nivel 1 requiere el nivel 0 de la misma familia
      if (item.level > 0 && !this.hasBuilding(team, item.target, item.level - 1)) return false;
      if (item.level === 0 && this.hasBuilding(team, item.target, 0)) return false;
    } else if (item.kind === DepKind.Upgrade) {
      if (team.done.has(item.id)) return false;
      if (this.rules.unit(item.target).race !== team.race) return false;
    } else if (this.rules.unit(item.target).race !== team.race || !team.city) return false;
    return item.deps.every((d) => team.done.has(d));
  }

  hasBuilding(team: Team, family: number, minLevel = 0): boolean {
    return this.ents.some((e) => e.team === team.id && e.kind === 'building' && e.family === family && e.level >= minLevel && e.alive && e.state !== 'spawn');
  }

  private refreshDone(team: Team): void {
    for (const d of this.rules.depend) {
      if (d.kind !== DepKind.Building || d.extra !== team.race) continue;
      if (this.hasBuilding(team, d.target, d.level) || this.ents.some((e) => e.team === team.id && e.kind === 'building' && e.family === d.target && e.level >= d.level && e.alive)) team.done.add(d.id);
      else team.done.delete(d.id);
    }
  }

  queueOf(team: Team, item: DependItem): ProdJob[] {
    return item.kind === DepKind.Building ? team.queues.build : item.kind === DepKind.Unit ? team.queues.unit : team.queues.research;
  }

  enqueue(team: Team, item: DependItem): boolean {
    if (!this.available(team, item)) return false;
    const q = this.queueOf(team, item);
    if (item.kind !== DepKind.Unit && q.some((j) => j.item.id === item.id)) return false;
    if (q.length >= 12) return false;
    if (team.money < item.cost) {
      this.hooks.message?.('Fondos insuficientes', team.id);
      return false;
    }
    team.money -= item.cost;
    const total = Math.max(TPS * 3, Math.round((item.cost * (item.kind === DepKind.Unit ? 0.22 : 0.18))));
    q.push({ item, done: 0, total });
    return true;
  }

  cancel(team: Team, item: DependItem): boolean {
    const q = this.queueOf(team, item);
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].item.id === item.id) {
        team.money += item.cost;
        q.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  queued(team: Team, item: DependItem): number {
    return this.queueOf(team, item).filter((j) => j.item.id === item.id).length;
  }

  private stepProduction(team: Team): void {
    for (const q of [team.queues.build, team.queues.unit, team.queues.research]) {
      const job = q[0];
      if (!job) continue;
      if (!team.city || (job.item.kind !== DepKind.Upgrade && !this.hasBuilding(team, 0))) continue;
      if (++job.done < job.total) continue;
      q.shift();
      const it = job.item;
      if (it.kind === DepKind.Building) {
        this.placeBuilding(team, it.target, it.level, true);
        this.hooks.message?.(`Edificio completado`, team.id);
      } else if (it.kind === DepKind.Upgrade) {
        team.done.add(it.id);
        const u = team.upgrades.get(it.target) ?? { weapon: 0, armor: 0 };
        if (it.extra === 0) u.weapon = Math.max(u.weapon, it.level);
        else u.armor = Math.max(u.armor, it.level);
        team.upgrades.set(it.target, u);
        // la mejora aplica también al equivalente del otro bando por si se convierten
        this.hooks.message?.('Investigación completada', team.id);
      } else {
        this.spawnFromCity(team, it.target);
      }
    }
  }

  /** Hace aparecer una unidad recién fabricada en la ciudad, con su animación de salida si existe. */
  spawnFromCity(team: Team, type: number): Entity | null {
    if (!team.city) return null;
    const def = this.rules.unit(type);
    const build = this.anims.find(def.sprite, ['BUILD'], 0);
    let sx = team.city.x + (Math.random() - 0.5) * 40;
    let sy = team.city.y + 96;
    if (build) {
      const b = this.anims.bounds(build, this.anims.frameCount(build) - 1);
      sx = team.city.x + (b.x0 + b.x1) / 2;
      sy = team.city.y + b.y1 - 4;
    }
    const [tx, ty] = this.tileOf(sx, sy);
    const o = this.grid.nearestOpen(tx, ty, 6);
    if (o && !def.fly) {
      if (!this.grid.passable(tx, ty)) {
        sx = o[0] * TILE + 16;
        sy = o[1] * TILE + 16;
      }
    }
    const e = this.spawn(type, team.id, sx, sy, { dir: 0 });
    if (build) {
      e.state = 'spawn';
      e.spawnTicks = 0;
      // la animación de salida está referida al ancla de la ciudad
      this.addEffect(build, team.city.x, team.city.y, team.colour);
      e.spawnTicks = this.animLength(build);
    }
    if (team.rally && e.state !== 'spawn') this.command([e], { type: 'move', x: team.rally.x, y: team.rally.y });
    this.hooks.sound?.('build', e);
    return e;
  }

  animLength(ref: AnimRef): number {
    let t = 0;
    for (let i = 0; i < this.anims.frameCount(ref); i++) t += this.anims.ticks(ref, i);
    return t;
  }

  // ───────────────────────────── simulación ─────────────────────────────

  step(): void {
    this.tick++;
    this.rebuildBuckets();
    for (const t of this.teams) if (t && t.active && !t.defeated) this.stepProduction(t);
    for (const e of [...this.ents]) {
      e.px = e.x;
      e.py = e.y;
      if (e.hitFlash > 0) e.hitFlash--;
      this.stepEntity(e);
      this.stepAnim(e);
    }
    this.stepProjectiles();
    this.stepEffects();
    this.stepEconomy();
    if (this.tick % 10 === 0) this.captureArtifacts();
    if (this.tick % 5 === 0) this.updateFog();
    if (this.tick % 30 === 0 && this.autoVictory) this.checkVictory();
  }

  private rebuildBuckets(): void {
    this.bucket.clear();
    for (const e of this.ents) {
      if (!e.alive) continue;
      const k = (Math.floor(e.x / 128) << 16) | Math.floor(e.y / 128);
      let b = this.bucket.get(k);
      if (!b) this.bucket.set(k, (b = []));
      b.push(e);
    }
  }

  /** Entidades vivas en un radio (px). */
  near(x: number, y: number, r: number): Entity[] {
    const out: Entity[] = [];
    const x0 = Math.floor((x - r) / 128), x1 = Math.floor((x + r) / 128);
    const y0 = Math.floor((y - r) / 128), y1 = Math.floor((y + r) / 128);
    for (let bx = x0; bx <= x1; bx++)
      for (let by = y0; by <= y1; by++) {
        const b = this.bucket.get((bx << 16) | by);
        if (b) for (const e of b) if ((e.x - x) ** 2 + (e.y - y) ** 2 <= (r + e.radius) ** 2) out.push(e);
      }
    return out;
  }

  private stepEntity(e: Entity): void {
    switch (e.state) {
      case 'dead':
        return;
      case 'die':
        e.deathTicks++;
        if (e.animDone || !e.anim) {
          if (e.kind === 'building' || e.deathTicks > TPS * 40) this.remove(e);
        }
        return;
      case 'spawn':
        if (e.kind === 'building') {
          if (e.animDone || !e.anim) {
            e.state = 'idle';
            this.setAnim(e, ACT_STAND, true);
            const t = this.teams[e.team];
            if (t) this.refreshDone(t);
          }
        } else if (--e.spawnTicks <= 0) {
          e.state = 'idle';
          const t = this.teams[e.team];
          if (t?.rally) this.command([e], { type: 'move', x: t.rally.x + (Math.random() - 0.5) * 60, y: t.rally.y + (Math.random() - 0.5) * 30 });
        }
        return;
      case 'deploy':
        if (e.animDone || !e.anim) this.finishDeploy(e);
        return;
    }
    if (e.kind === 'vent' || e.kind === 'prop' || e.team === NEUTRAL) return;
    if (e.cooldown > 0) e.cooldown--;
    const w = this.weapon(e);
    if (MINES.includes(e.type)) {
      this.stepMine(e);
      return;
    }
    if (HEALERS.includes(e.type) && this.tick % 15 === e.id % 15) this.heal(e);
    if (e.kind === 'building' || e.def.speed === 0) {
      // estructuras con arma (torretas desplegadas)
      if (w) this.guard(e, w);
      if (e.state === 'fire' && e.animDone) {
        e.state = 'idle';
        this.setAnim(e, ACT_STAND, true);
      }
      return;
    }
    const o = e.order;
    switch (o.type) {
      case 'idle': {
        if (w) this.guard(e, w);
        if (e.state === 'move') {
          e.state = 'idle';
          this.setAnim(e, ACT_STAND, true);
        }
        break;
      }
      case 'move':
        if (this.moveTo(e, o.x, o.y, 6)) this.nextOrder(e);
        break;
      case 'attackmove': {
        if (w && this.guard(e, w)) break;
        if (this.moveTo(e, o.x, o.y, 8)) this.nextOrder(e);
        break;
      }
      case 'attack': {
        const t = this.get(o.target ?? 0);
        if (!t || !t.alive || !w) {
          e.order = { type: 'idle', x: e.x, y: e.y };
          break;
        }
        this.engage(e, t, w, true);
        break;
      }
      case 'deploy': {
        const v = o.target ? this.get(o.target) : undefined;
        const tx = v ? v.x : o.x, ty = v ? v.y : o.y;
        if (v && (v.amount <= 0 || this.ents.some((t) => t.alive && t.ventId === v.id))) {
          e.order = { type: 'idle', x: e.x, y: e.y };
          break;
        }
        if (this.moveTo(e, tx, ty, 4)) this.startDeploy(e, v);
        break;
      }
    }
    if (e.state === 'fire' && e.animDone) {
      e.state = 'idle';
      this.setAnim(e, ACT_STAND, true);
    }
  }

  /** Pasa al siguiente punto de ruta encolado o queda en reposo. */
  private nextOrder(e: Entity): void {
    const next = e.waypoints.shift();
    e.order = next ?? { type: 'idle', x: e.x, y: e.y };
    e.path = [];
    e.repathIn = 0;
  }

  /** Busca y ataca enemigos cercanos. Devuelve true si está combatiendo. */
  private guard(e: Entity, w: WeaponDef): boolean {
    let t = e.targetId ? this.get(e.targetId) : undefined;
    const vis = this.vision(e) * TILE;
    const static_ = e.def.speed === 0 || e.kind === 'building';
    const reach = Math.max(vis, w.range * TILE);
    if (t && (!t.alive || Math.hypot(t.cx - e.cx, t.cy - e.cy) > reach + t.radius + 32)) t = undefined;
    if (!t && --e.acquireIn <= 0) {
      e.acquireIn = 6 + (e.id % 5);
      t = this.findTarget(e, static_ ? w.range * TILE + 16 : reach);
    }
    e.targetId = t ? t.id : 0;
    if (!t) return false;
    return this.engage(e, t, w, !static_);
  }

  findTarget(e: Entity, r: number): Entity | undefined {
    let best: Entity | undefined;
    let bd = 1e12;
    const w = this.weapon(e);
    for (const o of this.near(e.cx, e.cy, r)) {
      if (!o.alive || !this.enemies(e.team, o.team) || o.kind === 'vent' || o.kind === 'prop') continue;
      if (o.state === 'spawn' && o.kind !== 'building') continue;
      if (w && w.cls !== 2 && w.cls !== 5 && o.flying && w.cls === 1) continue; // cuerpo a cuerpo no alcanza aéreos
      let d = (o.cx - e.cx) ** 2 + (o.cy - e.cy) ** 2;
      if (o.kind === 'building') d *= 1.6; // prioriza unidades
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /** Se acerca a distancia de tiro y dispara. */
  private engage(e: Entity, t: Entity, w: WeaponDef, canMove: boolean): boolean {
    const dx = t.cx - e.cx, dy = t.cy - e.cy;
    const dist = Math.hypot(dx, dy) - t.radius * 0.6;
    const range = Math.max(1, w.range) * TILE + 8;
    if (dist > range) {
      if (!canMove) return false;
      if (--e.repathIn <= 0 || !e.path.length) {
        e.repathIn = 0;
      }
      this.moveTo(e, t.x, t.y, 0, true);
      return true;
    }
    // en rango: girar y disparar
    e.path = [];
    const want = dirFromVector(dx, dy);
    if (!this.turnTowards(e, want)) {
      if (e.state !== 'fire') this.setAnim(e, ACT_STAND, true);
      return true;
    }
    if (e.cooldown <= 0) this.fire(e, t, w);
    else if (e.state !== 'fire') {
      e.state = 'idle';
      this.setAnim(e, ACT_STAND, true);
    }
    return true;
  }

  private turnTowards(e: Entity, want: number): boolean {
    const d = dirDelta(e.dir, want);
    const rate = Math.max(0.5, (e.def.turn || 10) / 12);
    if (Math.abs(d) <= rate) {
      e.dir = want;
      return true;
    }
    e.dir = (e.dir + Math.sign(d) * rate + 16) % 16;
    return Math.abs(d) <= 2;
  }

  private fire(e: Entity, t: Entity, w: WeaponDef): void {
    e.cooldown = Math.max(6, w.rof);
    e.state = 'fire';
    e.dir = dirFromVector(t.cx - e.cx, t.cy - e.cy);
    this.setAnim(e, ACT_FIRE, false);
    if (e.anim && !e.anim.name.includes('FIR') && !e.anim.name.includes('FIG')) e.animDone = true;
    this.hooks.sound?.('fire', e, w.sound);
    const bullet = this.anims.find(w.sprite, ['BULLET'], 0) ?? (w.cls === 3 ? this.anims.find('BARR', ['BULLET'], 0) : undefined);
    const dist = Math.hypot(t.cx - e.cx, t.cy - e.cy);
    if (bullet || w.cls === 3) {
      const speed = Math.max(4, w.speed / 8);
      this.projectiles.push({
        x: e.cx, y: e.cy - 10, sx: e.cx, sy: e.cy - 10, tx: t.cx, ty: t.cy,
        t: 0, dur: Math.max(4, Math.round(dist / speed)), arc: w.cls === 3 ? Math.min(90, dist * 0.35) : 0,
        weapon: w, team: e.team, owner: e.id, targetId: t.id, anim: bullet,
      });
    } else {
      // impacto casi inmediato (balas, láser, cuerpo a cuerpo)
      this.projectiles.push({
        x: t.cx, y: t.cy, sx: t.cx, sy: t.cy, tx: t.cx, ty: t.cy, t: 0, dur: 3, arc: 0,
        weapon: w, team: e.team, owner: e.id, targetId: t.id,
      });
    }
  }

  private stepProjectiles(): void {
    const keep: Projectile[] = [];
    for (const p of this.projectiles) {
      p.t++;
      const k = Math.min(1, p.t / p.dur);
      // las balas guiadas siguen al objetivo
      const tgt = this.get(p.targetId);
      if (tgt && p.weapon.cls !== 3) {
        p.tx = tgt.cx;
        p.ty = tgt.cy;
      }
      p.x = p.sx + (p.tx - p.sx) * k;
      p.y = p.sy + (p.ty - p.sy) * k - Math.sin(k * Math.PI) * p.arc;
      if (k < 1) {
        keep.push(p);
        continue;
      }
      this.impact(p);
    }
    this.projectiles = keep;
  }

  impact(p: Projectile): void {
    const w = p.weapon;
    const splash = w.cls === 3 || w.cls === 6 ? 44 : 0;
    const owner = this.get(p.owner);
    const hit = (t: Entity, f: number) => {
      if (!t.alive || t.kind === 'vent' || t.kind === 'prop') return;
      if (!this.enemies(p.team, t.team) && splash === 0) return;
      const up = this.teams[t.team]?.upgrades.get(t.type);
      const armorMul = 1 - 0.15 * (up?.armor ?? 0);
      const dmg = this.rules.damage(w, t.def.armor) * f * armorMul * DAMAGE_SCALE;
      this.damage(t, dmg, owner);
    };
    if (splash) {
      for (const t of this.near(p.tx, p.ty, splash)) {
        const d = Math.hypot(t.cx - p.tx, t.cy - p.ty);
        hit(t, Math.max(0.25, 1 - d / (splash + t.radius)));
      }
      const ex = this.anims.find(w.sprite, ['EXPLODE', 'BEXPLODE'], 0) ?? this.anims.get('SMOKEXPLODE0') ?? this.anims.get('TURREXPLODE0');
      this.addEffect(ex, p.tx, p.ty + 8);
      this.hooks.explode?.(w.shots, p.tx, p.ty);
    } else {
      const t = this.get(p.targetId);
      if (t && Math.hypot(t.cx - p.tx, t.cy - p.ty) < t.radius + 24) hit(t, 1);
    }
  }

  /**
   * Ascenso del comandante: GAMESTAT 69..72 (humanos) y 73..76 (Taar) son los rangos teniente,
   * capitán, mayor y coronel; la columna 23 de cada rango es el umbral de bajas (12, 28, 44, 60).
   */
  private promote(e: Entity): void {
    if (!e.alive || !COMMANDERS.includes(e.type) || e.type === 72 || e.type === 76) return;
    if (e.kills < (e.def.raw[23] ?? 999)) return;
    const next = e.type + 1;
    const ratio = e.hp / e.maxHp;
    e.type = next;
    e.def = this.rules.unit(next);
    e.maxHp = Math.max(1, e.def.hp);
    e.hp = e.maxHp * Math.max(ratio, 0.5);
    const ranks = ['Teniente', 'Capitán', 'Mayor', 'Coronel'];
    this.hooks.message?.(`Comandante ascendido a ${ranks[COMMANDERS.indexOf(next) % 4]}`, e.team);
  }

  damage(t: Entity, dmg: number, by?: Entity): void {
    if (!t.alive) return;
    t.hp -= dmg;
    t.hitFlash = 3;
    if (by) t.lastAttacker = by.id;
    if (Math.random() < 0.35 && t.kind !== 'building') {
      const letters = 'ABCDEFG';
      const blood = this.anims.find(t.def.sprite, ['BLOOD' + letters[(Math.random() * 7) | 0], 'BLOODA'], 0);
      this.addEffect(blood, t.x, t.y, t.team, t.flying);
    }
    // contraataque automático si estaba ocioso
    if (by && t.kind === 'unit' && t.order.type === 'idle' && !t.targetId && this.weapon(t)) t.targetId = by.id;
    if (t.hp <= 0) this.kill(t, by);
  }

  kill(t: Entity, by?: Entity): void {
    if (!t.alive) return;
    t.hp = 0;
    t.state = 'die';
    t.deathTicks = 0;
    t.path = [];
    t.order = { type: 'idle', x: t.x, y: t.y };
    const killer = by ? this.teams[by.team] : undefined;
    if (killer && by!.team !== t.team) {
      killer.kills++;
      by!.kills++;
      this.promote(by!);
    }
    const victim = this.teams[t.team];
    if (victim) victim.losses++;
    this.hooks.sound?.('die', t);
    // las torres de extracción liberan su respiradero
    t.ventId = 0;
    const dies = ACT_DIE[(Math.random() * ACT_DIE.length) | 0];
    if (t.kind === 'building') {
      const ref = this.anims.find(t.def.sprite, ['DIE', 'BURN'], 0);
      if (ref) this.playAnim(t, ref, false);
      else t.anim = undefined;
      this.addEffect(this.anims.get('TURREXPLODE0'), t.cx, t.cy + 20);
      const team = this.teams[t.team];
      if (team) this.refreshDone(team);
    } else {
      const ref = this.anims.find(t.def.sprite, dies, Math.round(t.dir) & 15);
      if (ref) this.playAnim(t, ref, false);
      else {
        t.anim = undefined;
        this.addEffect(this.anims.get('SMOKEXPLODE0'), t.x, t.y);
      }
      if (t.flying) this.addEffect(this.anims.get('TURREXPLODE0'), t.x, t.y);
    }
  }

  /** Movimiento hacia un punto; devuelve true al llegar. */
  private moveTo(e: Entity, x: number, y: number, tol: number, chasing = false): boolean {
    if (Math.hypot(x - e.x, y - e.y) <= Math.max(tol, 3)) {
      e.path = [];
      return true;
    }
    if (e.flying) {
      e.path = [[Math.floor(x / TILE), Math.floor(y / TILE)]];
      return this.stepAlong(e, x, y, tol);
    }
    if (!e.path.length || e.repathIn <= 0) {
      const [sx, sy] = this.tileOf(e.x, e.y);
      const [tx, ty] = this.tileOf(x, y);
      e.path = this.grid.find(sx, sy, tx, ty, chasing ? 2500 : 6000);
      e.repathIn = chasing ? 20 : 120;
      if (!e.path.length) {
        // destino inalcanzable o ya en la casilla
        if (sx === tx && sy === ty) return this.stepAlong(e, x, y, tol);
        e.repathIn = 30;
        if (!chasing) return true;
        return false;
      }
    }
    e.repathIn--;
    const last = e.path.length === 1;
    const [ntx, nty] = e.path[0];
    const wx = last ? x : ntx * TILE + 16;
    const wy = last ? y : nty * TILE + 16;
    const arrived = this.stepAlong(e, wx, wy, last ? tol : 10);
    if (arrived) {
      e.path.shift();
      if (!e.path.length) return Math.hypot(x - e.x, y - e.y) <= Math.max(tol, 12) || last;
    }
    return false;
  }

  private stepAlong(e: Entity, wx: number, wy: number, tol: number): boolean {
    const dx = wx - e.x, dy = wy - e.y;
    const d = Math.hypot(dx, dy);
    if (d <= Math.max(tol, 2)) return true;
    const want = dirFromVector(dx, dy);
    const facing = this.turnTowards(e, want);
    const speed = Math.max(0.6, e.def.speed / 8) * (e.flying ? 1 : this.slope(e));
    if (facing) {
      const s = Math.min(speed, d);
      let nx = e.x + (dx / d) * s, ny = e.y + (dy / d) * s;
      // separación entre unidades terrestres
      if (!e.flying) {
        for (const o of this.near(nx, ny, 14)) {
          if (o === e || o.flying || o.kind !== 'unit' || !o.alive) continue;
          const ox = nx - o.x, oy = ny - o.y;
          const od = Math.hypot(ox, oy);
          if (od > 0.01 && od < 14) {
            nx += (ox / od) * 0.8;
            ny += (oy / od) * 0.8;
          }
        }
        const [tx, ty] = this.tileOf(nx, ny);
        if (!this.grid.passable(tx, ty)) {
          const [cx, cy] = this.tileOf(e.x, e.y);
          if (this.grid.passable(cx, cy)) {
            // deslizar por los ejes
            if (this.grid.passable(...this.tileOf(nx, e.y))) ny = e.y;
            else if (this.grid.passable(...this.tileOf(e.x, ny))) nx = e.x;
            else {
              nx = e.x;
              ny = e.y;
            }
          }
        }
      }
      const moved = Math.hypot(nx - e.x, ny - e.y);
      e.x = Math.max(4, Math.min(this.w * TILE - 4, nx));
      e.y = Math.max(4, Math.min(this.h * TILE - 4, ny));
      if (moved < speed * 0.25) {
        if (++e.stuck > 25) {
          e.stuck = 0;
          e.repathIn = 0;
          e.path = [];
          return tol > 20 || d < 24;
        }
      } else e.stuck = 0;
    }
    if (e.state !== 'move') {
      e.state = 'move';
    }
    this.setAnim(e, ACT_MOVE, true);
    return false;
  }

  private slope(_e: Entity): number {
    return 1;
  }

  /** Mina: explota cuando un enemigo terrestre pasa por encima. */
  private stepMine(e: Entity): void {
    if (this.tick % 3) return;
    const victim = this.near(e.x, e.y, 20).find((o) => o.alive && o.kind === 'unit' && !o.flying && this.enemies(e.team, o.team));
    if (!victim) return;
    const w = this.weapon(e);
    if (w) this.impact({ x: e.x, y: e.y, sx: e.x, sy: e.y, tx: e.x, ty: e.y, t: 0, dur: 0, arc: 0, weapon: w, team: e.team, owner: e.id, targetId: victim.id });
    this.addEffect(this.anims.get('TURREXPLODE0'), e.x, e.y + 10);
    this.kill(e);
    this.remove(e);
  }

  /** Unidades sanadoras (Medi-craft / Zisp): curan a los aliados cercanos. */
  private heal(e: Entity): void {
    for (const o of this.near(e.x, e.y, 2.5 * TILE)) {
      if (o === e || !o.alive || o.kind !== 'unit' || this.enemies(e.team, o.team) || o.hp >= o.maxHp) continue;
      o.hp = Math.min(o.maxHp, o.hp + 40);
    }
  }

  private startDeploy(e: Entity, vent?: Entity): void {
    if (vent) {
      e.x = vent.x;
      e.y = vent.y;
      e.ventId = vent.id;
    }
    e.order = { type: 'idle', x: e.x, y: e.y };
    e.path = [];
    e.state = 'deploy';
    this.hooks.sound?.('deploy', e);
    const ref = this.anims.find(e.def.sprite, ['DEPLOY'], Math.round(e.dir) & 15);
    if (ref) {
      e.dir = ref.dir >= 0 ? ref.dir : e.dir;
      this.playAnim(e, ref, false);
    } else e.anim = undefined;
  }

  private finishDeploy(e: Entity): void {
    const into = DEPLOY_INTO[e.type];
    if (into === undefined) {
      e.state = 'idle';
      return;
    }
    const def = this.rules.unit(into);
    const ratio = e.hp / e.maxHp;
    e.type = into;
    e.def = def;
    e.maxHp = Math.max(1, def.hp);
    e.hp = e.maxHp * ratio;
    e.state = 'idle';
    e.kind = 'unit';
    this.setAnim(e, ACT_STAND, true);
    if (e.anim) e.box = this.anims.bounds(e.anim, 0);
    this.hooks.message?.(MINING_TOWER.includes(into) ? 'Extracción de Petra-7 iniciada' : 'Unidad desplegada', e.team);
  }

  private stepEconomy(): void {
    if (this.tick % 3 !== 0) return;
    for (const e of this.ents) {
      if (!e.alive || !e.ventId || !MINING_TOWER.includes(e.type)) continue;
      const v = this.get(e.ventId);
      const team = this.teams[e.team];
      if (!v || !team || v.amount <= 0 || v.rate <= 0) continue;
      const take = Math.min(v.amount, Math.max(1, Math.round(v.rate * MINING_RATE)));
      v.amount -= take;
      team.money += take;
      if (v.amount <= 0) this.hooks.message?.('Un respiradero de Petra-7 se ha agotado', e.team);
    }
  }

  /** Un artefacto neutral pasa al equipo de la primera unidad terrestre que lo toca. */
  private captureArtifacts(): void {
    for (const a of this.ents) {
      if (a.team !== NEUTRAL || !a.alive || !ARTIFACTS.includes(a.type)) continue;
      const u = this.near(a.x, a.y, 20).find((o) => o !== a && o.alive && o.kind === 'unit' && o.team !== NEUTRAL && !o.flying && !ARTIFACTS.includes(o.type));
      if (!u) continue;
      a.team = u.team;
      a.kind = 'unit';
      this.hooks.message?.('Artefacto capturado', u.team);
      this.hooks.sound?.('capture', a);
    }
  }

  private stepEffects(): void {
    const keep: Effect[] = [];
    for (const f of this.effects) {
      if (--f.tick <= 0) {
        f.frame++;
        if (f.frame >= this.anims.frameCount(f.anim)) continue;
        f.tick = this.anims.ticks(f.anim, f.frame);
      }
      keep.push(f);
    }
    this.effects = keep;
  }

  updateFog(): void {
    const fog = this.fog;
    for (let i = 0; i < fog.length; i++) if (fog[i] === 2) fog[i] = 1;
    for (const e of this.ents) {
      if (e.team !== this.player || !e.alive) continue;
      const r = this.vision(e) + (e.kind === 'building' ? 2 : 0);
      const [cx, cy] = this.tileOf(e.cx, e.cy);
      const r2 = (r + 0.5) ** 2;
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= this.h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= this.w || dx * dx + dy * dy > r2) continue;
          fog[y * this.w + x] = 2;
        }
      }
    }
  }

  /** Un equipo pierde cuando no le quedan edificios ni unidades de combate. */
  private checkVictory(): void {
    for (const t of this.teams) {
      if (!t || !t.active || t.defeated) continue;
      const alive = this.ents.some((e) => e.team === t.id && e.alive && (e.kind === 'building' || (e.kind === 'unit' && !MINING_TOWER.includes(e.type))));
      if (!alive) {
        t.defeated = true;
        this.hooks.message?.(`El equipo ${t.id + 1} ha sido derrotado`, this.player);
      }
    }
    const left = this.teams.filter((t) => t && t.active && !t.defeated);
    if (this.winner === null && left.length <= 1) this.winner = left[0]?.id ?? -1;
    if (this.winner === null && this.teams[this.player]?.defeated) this.winner = -1;
  }

  // ───────────────────────────── consultas para la UI ─────────────────────────────

  /** Entidad bajo un punto del mundo (prioriza unidades sobre edificios). */
  pick(x: number, y: number): Entity | undefined {
    let best: Entity | undefined;
    let bestScore = -1e9;
    for (const e of this.ents) {
      if (!e.alive || e.kind === 'prop' || !this.visibleToPlayer(e)) continue;
      const b = e.box;
      if (x < e.x + b.x0 || x > e.x + b.x1 || y < e.y + b.y0 || y > e.y + b.y1) continue;
      const score = (e.kind === 'unit' ? 1000 : 0) + e.y - (e.kind === 'building' ? 500 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  buildingsOf(team: number): Entity[] {
    return this.ents.filter((e) => e.team === team && e.kind === 'building' && e.alive);
  }
}

/** Ajuste global del daño (el original es bastante lento con 15 ticks/s). */
export const DAMAGE_SCALE = 2.5;
/** Petra-7 extraída por torre cada 3 ticks, por unidad de caudal del respiradero (caudal típico 15..25). */
export const MINING_RATE = 0.5;
