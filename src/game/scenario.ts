// Carga un escenario original (.SCN + .MAP + .BTS) en un World.
import { parseScn, type Scenario } from '../data/scn';
import { parseBts, parseMap, type Tileset } from '../data/map';
import { fetchBin, fetchText } from '../data/vfs';
import type { AnimDB } from '../render/anims';
import { HUMAN, ALIEN, Rules, VENT, ARTIFACTS, ARTIFACT_SITE } from './rules';
import { World, TILE, NEUTRAL, type Team } from './world';
import { loadMission, type MissionData } from './triggers';

export interface GameSetup {
  /** ruta del .SCN, p. ej. "scenario/mplayer/d2play01.scn" */
  scn: string;
  mode: 'skirmish' | 'campaign';
  playerRace: number;
  /** equipos activos (skirmish): índice de equipo -> raza */
  races?: number[];
  startMoney: number;
  colours?: number[];
}

export interface LoadedGame {
  world: World;
  tileset: Tileset;
  scenario: Scenario;
  setup: GameSetup;
  /** campaña: disparadores (.TRO), mensajes (.MSG), trampas (.MTG) y textos finales */
  mission?: MissionData;
}

export const MONEY_TABLE = [5000, 7500, 10000, 15000, 20000, 30000];

export async function loadGame(setup: GameSetup, rules: Rules, anims: AnimDB): Promise<LoadedGame> {
  const scn = parseScn(await fetchText(setup.scn));
  const dir = setup.scn.replace(/[^/]*$/, '');
  const [mapBuf, btsBuf] = await Promise.all([fetchBin(dir + scn.mapName + '.map'), fetchBin('scenario/' + scn.tileset)]);
  const map = parseMap(mapBuf);
  const tileset = parseBts(btsBuf);
  const world = new World(rules, anims, map, scn.tileset.replace('.bts', ''));
  const H = map.h;
  const toPx = (x: number, y: number): [number, number] => [x * TILE + 16, (H - 1 - y) * TILE + 16];
  world.setClock(scn.header);

  // ¿qué equipos juegan? En escaramuza, los que tienen ciudad o unidades iniciales y están activos.
  const skirmish = setup.mode === 'skirmish';
  const teamsWithStuff = new Set(scn.objects.filter((o) => o.team >= 0 && o.type !== VENT).map((o) => o.team));
  scn.teams.forEach((st) => {
    const playing = skirmish ? st.active && (st.city[0]?.has || teamsWithStuff.has(st.id)) : st.active;
    let race = skirmish ? (setup.races?.[st.id] ?? (st.id === 0 ? setup.playerRace : ALIEN - setup.playerRace)) : st.side === 1 ? ALIEN : HUMAN;
    if (race !== HUMAN && race !== ALIEN) race = HUMAN;
    const t: Team = world.addTeam({
      id: st.id,
      race,
      active: playing,
      ai: st.id !== 0,
      colour: setup.colours?.[st.id] ?? st.id,
      // %Money es un índice; todos los jugadores de campaña tienen 0 (= la cantidad base)
      money: skirmish ? setup.startMoney : MONEY_TABLE[Math.max(0, Math.min(MONEY_TABLE.length - 1, st.money))],
    });
    t.side = skirmish ? st.id : st.side;
    // escaramuza: IA completa en los rivales; campaña: el %AI del escenario (0 = ninguna)
    t.aiMode = skirmish ? (st.id === 0 ? 0 : 3) : st.id === 0 ? 0 : st.ai;
    // %AISlots: la 2.ª pareja es el centro de la plataforma de la ciudad (coincide con la
    // tesela central del pentágono); la 1.ª es el punto de reunión de la IA.
    const [rx, ry] = st.slots[0];
    const [cx, cy] = st.slots[1][0] || st.slots[1][1] ? st.slots[1] : st.slots[0];
    if (playing && (cx > 0 || cy > 0) && (st.city.some((c) => c.has) || skirmish)) {
      world.setCity(t, cx, H - 1 - cy);
      // la IA se reúne en su AISlot; el jugador, delante de la ciudad
      if (t.ai && (rx > 0 || ry > 0)) t.rally = { x: rx * TILE + 16, y: (H - 1 - ry) * TILE + 16 };
      st.city.forEach((c, fam) => {
        if (c.has) world.placeBuilding(t, fam, 0, false, c.hp);
      });
      if (skirmish && !st.city[0].has) world.placeBuilding(t, 0, 0, false);
    }
  });
  world.addTeam({ id: NEUTRAL, race: -1, active: false });

  for (const o of scn.objects) {
    const [x, y] = toPx(o.x, o.y);
    if (o.type === VENT) {
      world.spawn(VENT, NEUTRAL, x, y, { amount: o.hp, rate: o.rate ?? 20 });
      continue;
    }
    if (o.type < 0 || o.type >= rules.units.length) continue;
    const neutralObj = ARTIFACTS.includes(o.type) || o.type === ARTIFACT_SITE;
    const team = o.team >= 0 && o.team < 8 && !neutralObj ? world.teams[o.team] : world.teams[NEUTRAL];
    if (!team) continue;
    if (skirmish && !neutralObj && o.team >= 0 && o.team < 8 && !team.active) continue;
    let type = o.type;
    const def = rules.unit(type);
    // en escaramuza las unidades iniciales se convierten a la raza elegida
    if (skirmish && def.race >= 0 && team.race >= 0 && def.race !== team.race && def.counterpart >= 0) type = def.counterpart;
    if (rules.isBuilding(type)) continue;
    let [px, py] = [x, y];
    // las unidades terrestres que caen sobre la plataforma de la ciudad se apartan a la casilla libre más cercana
    if (!rules.unit(type).fly && rules.unit(type).speed > 0) {
      const free = world.grid.nearestOpen(Math.floor(x / TILE), Math.floor(y / TILE), 8);
      if (free && (free[0] !== Math.floor(x / TILE) || free[1] !== Math.floor(y / TILE))) [px, py] = [free[0] * TILE + 16, free[1] * TILE + 16];
    }
    world.spawn(type, team.id, px, py, { hp: o.hp, dir: 0 });
  }
  world.player = 0;
  world.updateFog();
  // scripts de misión: en campaña deciden el final; en escaramuza (mapas multijugador) sólo
  // gestionan erupciones de respiraderos y artefactos
  const mission: MissionData | undefined = await loadMission(setup.scn);
  if (!skirmish && mission.triggers.some((t) => t.actions.some((a) => a.verb === 'bail'))) world.autoVictory = false;
  return { world, tileset, scenario: scn, setup, mission };
}
