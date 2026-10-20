// Tablas de juego en GAMESTAT/*.TXT. Los nombres de campos salen de las cabeceras
// de los propios ficheros, de las cadenas de DC.EXE ("%s %d %d ... %d", 33 enteros)
// y de cotejar valores (ver docs/FORMATS.md).
import { dataLines } from './vfs';

export interface UnitDef {
  index: number;
  sprite: string;
  /** 0 humano, 1 alien (Taar/Gray), -1 neutral */
  race: number;
  turn: number;
  speed: number;
  visDay: number;
  visNight: number;
  /** arma por nivel de mejora (0..2), -1 = sin arma */
  weapons: number[];
  sizeA: number;
  sizeB: number;
  /** columna de MBULLET.TXT (clase de blindaje) */
  armor: number;
  hp: number;
  fly: number;
  raw: number[];
  /** índice de la unidad equivalente del otro bando */
  counterpart: number;
  noSelect: number;
}

export function parseGamestat(text: string): UnitDef[] {
  const lines = dataLines(text);
  const count = parseInt(lines[0], 10);
  const defs: UnitDef[] = [];
  for (const l of lines.slice(1)) {
    const t = l.split(/\s+/);
    if (t.length < 20) continue;
    const v = t.slice(1).map((x) => parseInt(x, 10));
    defs.push({
      index: defs.length,
      sprite: t[0].toUpperCase(),
      race: v[0],
      turn: v[1],
      speed: v[2],
      visDay: v[3],
      visNight: v[4],
      weapons: [v[5], v[6], v[7]],
      sizeA: v[8],
      sizeB: v[9],
      armor: v[10],
      hp: v[11],
      fly: v[12],
      raw: v,
      counterpart: v[v.length - 2],
      noSelect: v[v.length - 1],
    });
    if (defs.length >= count) break;
  }
  return defs;
}

export interface WeaponDef {
  id: number;
  sprite: string;
  /** fila de MBULLET.TXT */
  cls: number;
  sound: number;
  rof: number;
  damage: number;
  speed: number;
  range: number;
  shots: number;
  splash: number;
  raw: number[];
}

export function parseWeapstat(text: string): Map<number, WeaponDef> {
  const m = new Map<number, WeaponDef>();
  for (const l of dataLines(text).slice(1)) {
    const t = l.split(/\s+/);
    if (t.length < 9) continue;
    const id = parseInt(t[0], 10);
    const v = t.slice(2).map((x) => parseInt(x, 10));
    m.set(id, {
      id,
      sprite: t[1].toUpperCase(),
      cls: v[0],
      sound: v[1],
      rof: v[2],
      damage: v[3],
      speed: v[4],
      range: v[5],
      shots: v[6],
      splash: v[9] ?? 0,
      raw: v,
    });
  }
  return m;
}

/** MBULLET.TXT: porcentaje de daño [clase de arma][clase de blindaje] */
export function parseMbullet(text: string): number[][] {
  const nums = dataLines(text).join(' ').split(/\s+/).map((x) => parseInt(x, 10));
  const cols = nums[0];
  const rows = nums[1];
  const t: number[][] = [];
  for (let r = 0; r < rows; r++) t.push(nums.slice(2 + r * cols, 2 + (r + 1) * cols));
  return t;
}

export const enum DepKind {
  Building = 0,
  Unit = 1,
  Upgrade = 2,
}

export interface DependItem {
  id: number;
  cost: number;
  /** id del botón/texto en el layout del HUD (intrface/maine) */
  msg: number;
  kind: DepKind;
  /** edificio: familia; unidad/mejora: índice de unidad */
  target: number;
  level: number;
  /** edificio: raza; mejora: 0 arma / 1 blindaje */
  extra: number;
  deps: number[];
}

export function parseDepend(text: string): DependItem[] {
  const items: DependItem[] = [];
  for (const l of dataLines(text).slice(1)) {
    const v = l.split(/\s+/).map((x) => parseInt(x, 10));
    if (v.length < 5) continue;
    const [id, cost, msg, kind] = v;
    let rest: number[];
    let target = v[4], level = 0, extra = 0;
    if (kind === DepKind.Unit) {
      rest = v.slice(5);
    } else if (kind === DepKind.Building) {
      level = v[5];
      extra = v[6];
      rest = v.slice(7);
    } else {
      extra = v[5];
      level = v[6];
      rest = v.slice(7);
    }
    const end = rest.indexOf(-1);
    items.push({ id, cost, msg, kind, target, level, extra, deps: end >= 0 ? rest.slice(0, end) : rest });
  }
  return items;
}
