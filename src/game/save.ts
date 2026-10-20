// Guardar / cargar partida: el estado del mundo se serializa a JSON (el mapa y las reglas se
// vuelven a leer de los ficheros originales al cargar).
import type { AnimDB } from '../render/anims';
import type { Rules } from './rules';
import { loadGame, type GameSetup, type LoadedGame } from './scenario';
import { Entity, type ProdJob, type Team } from './world';

const KEY = 'open-dark-colony:save';

interface SavedEntity {
  id: number;
  type: number;
  team: number;
  kind: Entity['kind'];
  x: number;
  y: number;
  dir: number;
  hp: number;
  maxHp: number;
  state: Entity['state'];
  order: Entity['order'];
  amount: number;
  ventId: number;
  family: number;
  level: number;
  kills: number;
  anim?: string;
  animFrame: number;
  deathTicks: number;
  spawnTicks: number;
}

interface SavedTeam {
  id: number;
  side: number;
  race: number;
  colour: number;
  money: number;
  active: boolean;
  ai: boolean;
  defeated: boolean;
  city: Team['city'];
  rally: Team['rally'];
  queues: { build: [number, number, number][]; unit: [number, number, number][]; research: [number, number, number][] };
  done: number[];
  upgrades: [number, { weapon: number; armor: number }][];
  kills: number;
  losses: number;
}

export interface SaveData {
  version: 1;
  date: string;
  title: string;
  setup: GameSetup;
  tick: number;
  fog: string;
  ents: SavedEntity[];
  teams: SavedTeam[];
}

export function serialize(g: LoadedGame): SaveData {
  const w = g.world;
  const q = (jobs: ProdJob[]) => jobs.map((j) => [j.item.id, j.done, j.total] as [number, number, number]);
  return {
    version: 1,
    date: new Date().toISOString(),
    title: g.scenario.title,
    setup: g.setup,
    tick: w.tick,
    fog: btoa(String.fromCharCode(...w.fog)),
    ents: w.ents
      .filter((e) => e.state !== 'dead')
      .map((e) => ({
        id: e.id,
        type: e.type,
        team: e.team,
        kind: e.kind,
        x: e.x,
        y: e.y,
        dir: e.dir,
        hp: e.hp,
        maxHp: e.maxHp,
        state: e.state === 'fire' ? 'idle' : e.state,
        order: e.order,
        amount: e.amount,
        ventId: e.ventId,
        family: e.family,
        level: e.level,
        kills: e.kills,
        anim: e.anim?.name,
        animFrame: e.animFrame,
        deathTicks: e.deathTicks,
        spawnTicks: e.spawnTicks,
      })),
    teams: w.teams.filter(Boolean).map((t) => ({
      id: t.id,
      side: t.side,
      race: t.race,
      colour: t.colour,
      money: t.money,
      active: t.active,
      ai: t.ai,
      defeated: t.defeated,
      city: t.city,
      rally: t.rally,
      queues: { build: q(t.queues.build), unit: q(t.queues.unit), research: q(t.queues.research) },
      done: [...t.done],
      upgrades: [...t.upgrades],
      kills: t.kills,
      losses: t.losses,
    })),
  };
}

export async function restore(data: SaveData, rules: Rules, anims: AnimDB): Promise<LoadedGame> {
  const g = await loadGame(data.setup, rules, anims);
  const w = g.world;
  for (const e of [...w.ents]) w.remove(e);
  w.tick = data.tick;
  const fog = atob(data.fog);
  for (let i = 0; i < w.fog.length && i < fog.length; i++) w.fog[i] = fog.charCodeAt(i);
  for (const st of data.teams) {
    const t = w.teams[st.id];
    if (!t) continue;
    const jobs = (arr: [number, number, number][]) =>
      arr.flatMap(([id, done, total]) => {
        const item = rules.dependById.get(id);
        return item ? [{ item, done, total }] : [];
      });
    Object.assign(t, {
      side: st.side,
      race: st.race,
      colour: st.colour,
      money: st.money,
      active: st.active,
      ai: st.ai,
      defeated: st.defeated,
      rally: st.rally,
      kills: st.kills,
      losses: st.losses,
      done: new Set(st.done),
      upgrades: new Map(st.upgrades),
      queues: { build: jobs(st.queues.build), unit: jobs(st.queues.unit), research: jobs(st.queues.research) },
    });
  }
  let maxId = 0;
  for (const se of data.ents) {
    const e = w.spawn(se.type, se.team, se.x, se.y, { hp: se.hp, dir: se.dir, amount: se.amount });
    Object.assign(e, {
      kind: se.kind,
      maxHp: se.maxHp,
      hp: se.hp,
      state: se.state,
      order: se.order,
      amount: se.amount,
      ventId: se.ventId,
      family: se.family,
      level: se.level,
      kills: se.kills,
      deathTicks: se.deathTicks,
      spawnTicks: se.spawnTicks,
      animFrame: se.animFrame,
    });
    if (se.anim) {
      const ref = anims.get(se.anim);
      if (ref) {
        e.anim = ref;
        e.animLoop = se.state === 'idle' || se.state === 'move';
        e.animTick = anims.ticks(ref, se.animFrame);
      }
    }
    w.reassignId(e, se.id);
    maxId = Math.max(maxId, se.id);
  }
  w.bumpIds(maxId + 1);
  return g;
}

export function saveToStorage(g: LoadedGame): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(serialize(g)));
    return true;
  } catch {
    return false;
  }
}

export function loadFromStorage(): SaveData | null {
  try {
    const s = localStorage.getItem(KEY);
    return s ? (JSON.parse(s) as SaveData) : null;
  } catch {
    return null;
  }
}
