// Reglas del juego derivadas de GAMESTAT/*.TXT y del layout del HUD (intrface/maine).
import { fetchText } from '../data/vfs';
import {
  parseDepend,
  parseGamestat,
  parseMbullet,
  parseWeapstat,
  DepKind,
  type DependItem,
  type UnitDef,
  type WeaponDef,
} from '../data/stats';

export const HUMAN = 0;
export const ALIEN = 1;

/** Familias de edificios de la ciudad (orden de %City en los .SCN y de DEPEND.TXT). */
export const FAMILY_NAMES = ['Centro', 'Cuartel', 'Fábrica', 'Ciencia', 'Investigación'];

/** Índices de GAMESTAT de los edificios de cada raza: [familia][nivel] */
export const BUILDINGS: number[][][] = [
  // humanos: EXCOPOD, BRRKPOD, ROBOPOD/ROBOPOD2, SCNCPOD/SCNCPOD2, RSCHPOD
  [[16], [17], [18, 19], [20, 21], [22]],
  // aliens: BIOHIV, WARHIVE, BRDRHIV/BRDRHIV2, MINDHIV/MNDHIV2, RSCHIV
  [[28], [29], [30, 31], [32, 33], [34]],
];

export const VENT = 40;
export const MINING_TOWER = [47, 48];
export const MINER = [6, 14];
export const COMMANDERS = [69, 70, 71, 72, 73, 74, 75, 76];
/** artefactos (Lens, Maktor, Lunatek, Pinball, Tektarra, Ultimate): neutrales hasta que alguien los toca */
export const ARTIFACTS = [63, 64, 65, 66, 67, 68];
/** emplazamiento de artefacto (decorado) */
export const ARTIFACT_SITE = 37;

/** Unidades que se despliegan (Exploiter/Slug sobre respiraderos, torretas, minas…): tipo -> tipo desplegado */
export const DEPLOY_INTO: Record<number, number> = {
  6: 47, // Exploiter -> torre de extracción humana
  14: 48, // Slug/Brozaar -> torre de extracción alien
  1: 41, // Sentinel (constructor de torre) -> torre móvil desplegada
  9: 42, // Xenowort -> torre alien
  43: 45, // Firestorm -> mina humana
  44: 46, // Slom -> mina alien
};

export class Rules {
  units: UnitDef[] = [];
  weapons = new Map<number, WeaponDef>();
  mbullet: number[][] = [];
  depend: DependItem[] = [];
  dependById = new Map<number, DependItem>();

  static async load(): Promise<Rules> {
    const r = new Rules();
    const [gs, ws, mb, dp] = await Promise.all([
      fetchText('gamestat/gamestat.txt'),
      fetchText('gamestat/weapstat.txt'),
      fetchText('gamestat/mbullet.txt'),
      fetchText('gamestat/depend.txt'),
    ]);
    r.units = parseGamestat(gs);
    r.weapons = parseWeapstat(ws);
    r.mbullet = parseMbullet(mb);
    r.depend = parseDepend(dp);
    for (const d of r.depend) r.dependById.set(d.id, d);
    return r;
  }

  unit(i: number): UnitDef {
    return this.units[i] ?? this.units[0];
  }

  isBuilding(i: number): boolean {
    return (i >= 16 && i <= 22) || (i >= 28 && i <= 35);
  }

  buildingFamily(i: number): { race: number; family: number; level: number } | null {
    for (let race = 0; race < 2; race++)
      for (let f = 0; f < 5; f++) {
        const lv = BUILDINGS[race][f].indexOf(i);
        if (lv >= 0) return { race, family: f, level: lv };
      }
    return null;
  }

  isStatic(i: number): boolean {
    const d = this.unit(i);
    return this.isBuilding(i) || d.speed === 0;
  }

  weaponFor(i: number, level = 0): WeaponDef | undefined {
    const d = this.unit(i);
    const w = d.weapons[Math.min(2, Math.max(0, level))];
    return w >= 0 ? this.weapons.get(w) : undefined;
  }

  /** Daño efectivo según MBULLET.TXT (porcentaje por clase de arma × clase de blindaje). */
  damage(w: WeaponDef, armor: number): number {
    const row = this.mbullet[Math.max(0, Math.min(this.mbullet.length - 1, w.cls))];
    const pct = row ? row[Math.max(0, Math.min(row.length - 1, armor))] : 100;
    return (w.damage * pct) / 100;
  }

  /** Elementos de DEPEND.TXT construibles por una raza. */
  buildable(race: number): DependItem[] {
    return this.depend.filter((d) => {
      if (d.kind === DepKind.Building) return d.extra === race;
      return this.unit(d.target).race === race;
    });
  }

  buildingType(race: number, family: number, level: number): number {
    const f = BUILDINGS[race][family];
    return f[Math.min(level, f.length - 1)];
  }
}
