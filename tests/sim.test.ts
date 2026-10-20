// Partida completa IA contra IA sin navegador, con los datos reales del juego.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error módulo JS sin tipos
import { dataDir, resolveGameFile } from '../gamedata.mjs';
import { AnimDB } from '../src/render/anims';
import { Rules, MINING_TOWER } from '../src/game/rules';
import { loadGame } from '../src/game/scenario';
import { AI } from '../src/game/ai';
import { serialize, restore } from '../src/game/save';
import { createMissionScript } from '../src/game/triggers';

const root: string = dataDir();
const have = fs.existsSync(path.join(root, 'GAMESTAT'));

describe.skipIf(!have)('simulación', () => {
  let rules: Rules;
  let anims: AnimDB;
  beforeAll(async () => {
    // fetch('/dc/...') -> fichero del juego
    globalThis.fetch = (async (input: string | URL) => {
      const rel = decodeURIComponent(String(input).replace(/^\/dc\//, ''));
      const file = resolveGameFile(root, rel);
      if (!file || !fs.statSync(file).isFile()) return new Response(null, { status: 404 });
      return new Response(fs.readFileSync(file));
    }) as typeof fetch;
    rules = await Rules.load();
    anims = new AnimDB();
    await anims.load();
  }, 60000);

  it('las animaciones de todas las unidades de GAMESTAT existen', () => {
    const missing = rules.units.filter((u) => u.race >= 0 && !anims.find(u.sprite, ['STAND', 'MOVE', 'SHUF'], 0)).map((u) => `${u.index}:${u.sprite}`);
    // algunos tipos sin uso (artefactos de campaña, tipos de prueba) no tienen animación propia
    expect(missing.length).toBeLessThan(12);
  });

  it('todos los escenarios (multijugador y campaña) cargan y se simulan sin errores', async () => {
    const dirs: [string, 'skirmish' | 'campaign'][] = [['mplayer', 'skirmish'], ['human', 'campaign'], ['alien', 'campaign']];
    let n = 0;
    for (const [dir, mode] of dirs) {
      const files = fs.readdirSync(resolveGameFile(root, `scenario/${dir}`)).filter((f: string) => /\.scn$/i.test(f));
      for (const f of files) {
        let game;
        try {
          game = await loadGame({ scn: `scenario/${dir}/${f.toLowerCase()}`, mode, playerRace: 0, startMoney: 10000 }, rules, anims);
        } catch (err) {
          // DEMO.SCN apunta a un mapa "demo1" que no existe en la instalación
          if (String(err).includes('404')) continue;
          throw err;
        }
        const w = game.world;
        w.autoVictory = mode === 'skirmish';
        const ais = w.teams.filter((t) => t && t.active && t.ai && t.id < 8 && t.aiMode > 0 && t.aiMode <= 3).map((t) => new AI(w, t));
        const script = game.mission ? createMissionScript(w, game.mission, { scnHeader: game.scenario.header, settings: mode === 'skirmish' ? { 3: 1, 4: 1, 6: 2 } : undefined }) : null;
        for (let i = 0; i < 600; i++) {
          for (const ai of ais) ai.step();
          w.step();
          script?.step();
        }
        script?.dispose();
        n++;
      }
    }
    expect(n).toBeGreaterThan(80);
  }, 120000);

  it('guardar y cargar una partida conserva el estado', async () => {
    const setup = { scn: 'scenario/mplayer/j2play01.scn', mode: 'skirmish' as const, playerRace: 1, startMoney: 10000, races: [1, 0, -9, -9, -9, -9, -9, -9] };
    const game = await loadGame(setup, rules, anims);
    const w = game.world;
    const ais = w.teams.filter((t) => t && t.active && t.id < 8).map((t) => new AI(w, t));
    for (let i = 0; i < 1500; i++) {
      for (const ai of ais) ai.step();
      w.step();
    }
    const data = JSON.parse(JSON.stringify(serialize(game)));
    const g2 = await restore(data, rules, anims);
    const w2 = g2.world;
    expect(w2.tick).toBe(w.tick);
    expect(w2.ents.filter((e) => e.alive).length).toBe(w.ents.filter((e) => e.alive).length);
    expect(w2.teams[0].money).toBe(w.teams[0].money);
    expect([...w2.teams[1].done].sort()).toEqual([...w.teams[1].done].sort());
    // las torres siguen ligadas a su respiradero
    for (const t of w2.ents.filter((e) => MINING_TOWER.includes(e.type) && e.ventId)) expect(w2.get(t.ventId)?.kind).toBe('vent');
    const ais2 = w2.teams.filter((t) => t && t.active && t.id < 8).map((t) => new AI(w2, t));
    for (let i = 0; i < 600; i++) {
      for (const ai of ais2) ai.step();
      w2.step();
    }
  }, 60000);

  it('una escaramuza IA contra IA termina con un ganador', async () => {
    const game = await loadGame(
      { scn: 'scenario/mplayer/d2play01.scn', mode: 'skirmish', playerRace: 0, startMoney: 10000, races: [0, 1, -9, -9, -9, -9, -9, -9] },
      rules,
      anims,
    );
    const w = game.world;
    const ais = w.teams.filter((t) => t && t.active && t.id < 8).map((t) => new AI(w, t));
    expect(ais.length).toBe(2);
    let mined = false;
    let towers = false;
    for (let i = 0; i < 15 * 60 * 90 && w.winner === null; i++) {
      for (const ai of ais) ai.step();
      w.step();
      if (!mined && w.ents.some((e) => MINING_TOWER.includes(e.type))) mined = true;
      if (!towers && w.ents.some((e) => e.type === 41 || e.type === 42)) towers = true;
    }
    expect(mined).toBe(true);
    console.log(`torres defensivas desplegadas: ${towers}`);
    expect(w.teams[0].kills + w.teams[1].kills).toBeGreaterThan(5);
    expect(w.winner).not.toBeNull();
    console.log(`escaramuza terminada en ${(w.tick / 900).toFixed(1)} min de juego; ganador ${w.winner}`);
  }, 300000);
});
