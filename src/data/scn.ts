// Escenarios (.SCN, texto). Coordenadas del original con el eje Y hacia arriba
// (fila 0 abajo): se convierten a filas de pantalla al cargar el mundo.
//
// Se lee línea a línea: la fila de %City no siempre tiene 5 parejas (HUMAN03 trae 6) y las
// líneas de respiraderos tienen 5 campos (`x y 40 caudal cantidad`) frente a los 6 del resto
// de objetos (`x y tipo equipo vida flag`).

export interface ScnTeam {
  id: number;
  active: boolean;
  side: number;
  race: number;
  money: number;
  ai: number;
  colours: number[];
  depend: number[];
  allies: number[];
  /** x,y (eje Y hacia arriba): punto de reunión de la IA y centro de la ciudad */
  slots: [number, number][];
  /** 5 familias de edificios: existe / puntos de vida (-1 = completo) */
  city: { has: boolean; hp: number }[];
  upgrades: number[][];
}

export interface ScnObject {
  x: number;
  y: number;
  type: number;
  team: number;
  hp: number;
  flag: number;
  /** respiraderos: caudal (0 = dormido) */
  rate?: number;
}

export interface Scenario {
  tileset: string;
  mapName: string;
  title: string;
  /** [?, ?, empieza de noche, media jornada (ticks), fase inicial, transición] */
  header: number[];
  teams: ScnTeam[];
  objects: ScnObject[];
}

const VENT_TYPE = 40;

export function parseScn(text: string): Scenario {
  const raw = text.split(/\r?\n/);
  const tileset = raw[0].trim().toLowerCase();
  const mapName = raw[1].trim().toLowerCase();
  const title = raw[2].trim();
  // líneas útiles (sin vacías); las etiquetas '%...' se conservan para orientarse
  const lines = raw
    .slice(3)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const nums = (l: string) => l.split(/\s+/).map((t) => parseInt(t, 10)).filter((v) => !Number.isNaN(v));
  let i = 0;
  const header: number[] = [];
  while (i < lines.length && !lines[i].startsWith('TEAM')) header.push(...nums(lines[i++]));

  /** lee enteros (saltando etiquetas) hasta reunir `n` */
  const take = (n: number): number[] => {
    const out: number[] = [];
    while (out.length < n && i < lines.length) {
      if (lines[i].startsWith('%')) {
        i++;
        continue;
      }
      out.push(...nums(lines[i++]));
    }
    return out;
  };
  /** lee una lista terminada en -1 (puede ocupar varias líneas) */
  const list = (): number[] => {
    const out: number[] = [];
    while (i < lines.length) {
      if (lines[i].startsWith('%')) {
        i++;
        continue;
      }
      const v = nums(lines[i++]);
      const end = v.indexOf(-1);
      if (end >= 0) {
        out.push(...v.slice(0, end));
        break;
      }
      out.push(...v);
    }
    return out;
  };
  const skipLabels = () => {
    while (i < lines.length && lines[i].startsWith('%')) i++;
  };

  const teams: ScnTeam[] = [];
  while (i < lines.length && lines[i].startsWith('TEAM')) {
    const [id, active] = nums(lines[i++].slice(4));
    const [side] = take(1);
    const [race] = take(1);
    const [money] = take(1);
    const [ai] = take(1);
    const colours = list();
    const depend = list();
    const allies = list();
    const s = take(4);
    const slots: [number, number][] = [
      [s[0], s[1]],
      [s[2], s[3]],
    ];
    skipLabels();
    // fila de la ciudad: parejas (existe, vida) por familia; sólo cuentan las 5 primeras
    const cityRow = nums(lines[i++] ?? '');
    const city: { has: boolean; hp: number }[] = [];
    for (let k = 0; k < 5; k++) city.push({ has: (cityRow[k * 2] ?? 0) !== 0, hp: cityRow[k * 2 + 1] ?? -1 });
    const upgrades: number[][] = [];
    for (let r = 0; r < 8 && i < lines.length && !lines[i].startsWith('TEAM'); r++) upgrades.push(nums(lines[i++]));
    teams.push({ id, active: active !== 0, side, race, money, ai, colours, depend, allies, slots, city, upgrades });
  }

  const objects: ScnObject[] = [];
  for (; i < lines.length; i++) {
    if (lines[i].startsWith('%')) continue;
    const v = nums(lines[i]);
    if (v.length < 4) continue;
    if (v[2] === VENT_TYPE && v.length === 5) {
      objects.push({ x: v[0], y: v[1], type: VENT_TYPE, team: -1, hp: v[4], flag: 0, rate: v[3] });
      continue;
    }
    objects.push({ x: v[0], y: v[1], type: v[2], team: v[3], hp: v[4] ?? -1, flag: v[5] ?? 0 });
  }
  return { tileset, mapName, title, header, teams, objects };
}
