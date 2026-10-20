// Scripts de misión (.TRO/.MSG/.MTG): análisis de todos los ficheros reales y semántica del intérprete.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error módulo JS sin tipos
import { dataDir, resolveGameFile } from '../gamedata.mjs';
import { Entity, type World, type Order } from '../src/game/world';
import type { UnitDef } from '../src/data/stats';
import {
  compileExpr,
  exprToString,
  parseTro,
  parseMsg,
  parseMtg,
  parseColourText,
  stripColours,
  loadMission,
  createMissionScript,
  MissionScript,
  type TroDiagnostics,
  type TripMap,
  type ScriptEvent,
} from '../src/game/triggers';

// ───────────── mundo falso mínimo ─────────────

function def(i: number, extra: Partial<UnitDef> = {}): UnitDef {
  return { index: i, sprite: 'X', race: 0, speed: 10, hp: 100, fly: 0, visDay: 5, visNight: 3, ...extra } as unknown as UnitDef;
}

class FakeWorld {
  w = 100;
  h = 80;
  tick = 0;
  player = 0;
  ents: Entity[] = [];
  teams = Array.from({ length: 9 }, (_, id) => ({ id, side: id, money: 1000, ai: id !== 0 }));
  hooks: { message?(t: string, team: number): void; sound?(): void } = {};
  fog = new Uint8Array(100 * 80);
  rules = { units: Array.from({ length: 106 }, (_, i) => def(i, i === 40 ? { speed: 0 } : {})), unit: (i: number) => this.rules.units[i] };
  grid = { passable: () => true };
  anims = { bounds: () => ({ x0: -1, y0: -1, x1: 1, y1: 1 }) };
  commands: { ids: number[]; order: Order }[] = [];
  private next = 1;
  tileOf(x: number, y: number): [number, number] {
    return [Math.floor(x / 32), Math.floor(y / 32)];
  }
  spawn(type: number, team: number, x: number, y: number, opts: { amount?: number } = {}): Entity {
    const e = new Entity(type, this.rules.unit(type), team);
    e.id = this.next++;
    e.x = x;
    e.y = y;
    e.hp = e.maxHp = 100;
    if (type === 40) {
      e.kind = 'vent';
      e.amount = opts.amount ?? 15000;
    }
    this.ents.push(e);
    return e;
  }
  get(id: number) {
    return this.ents.find((e) => e.id === id && e.state !== 'dead');
  }
  remove(e: Entity) {
    e.state = 'dead';
    this.ents = this.ents.filter((x) => x !== e);
  }
  kill(t: Entity) {
    t.state = 'die';
  }
  enemies(a: number, b: number) {
    return a !== b && a !== 8 && b !== 8 && this.teams[a].side !== this.teams[b].side;
  }
  command(units: Entity[], order: Order) {
    for (const u of units) u.order = { ...order };
    this.commands.push({ ids: units.map((u) => u.id), order });
  }
  setAnim() {}
  vision() {
    return 3;
  }
  isNight() {
    return false;
  }
  timeOfDay() {
    return 0;
  }
  /** casilla con Y hacia arriba (coordenadas del .TRO) -> píxel */
  at(x: number, y: number): [number, number] {
    return [x * 32 + 16, (this.h - 1 - y) * 32 + 16];
  }
  building(team: number, family: number) {
    const e = this.spawn(16 + family, team, 0, 0);
    e.kind = 'building';
    e.family = family;
    return e;
  }
}

function script(src: string, opts: ConstructorParameters<typeof MissionScript>[3] = {}, msgs = 'text 1\nUNO\n\ntext 2\nDOS\n') {
  const w = new FakeWorld();
  const diag: TroDiagnostics = { errors: [], quirks: [] };
  const trig = parseTro(src, diag);
  expect(diag.errors).toEqual([]);
  const shown: string[] = [];
  w.hooks.message = (t) => shown.push(t);
  const s = new MissionScript(w as unknown as World, trig, parseMsg(msgs), opts);
  return { w, s, shown, run: (n: number) => { for (let i = 0; i < n; i++) s.step(); } };
}

// ───────────── expresiones ─────────────

describe('compilador de ecuaciones', () => {
  const ev = (src: string) => {
    const { s } = script('');
    return s.evaluate(compileExpr(src));
  };

  it('reproduce la precedencia peculiar del original', () => {
    expect(ev('1+2*3')).toBe(9); // (1+2)*3
    expect(ev('2*3+1')).toBe(8); // 2*(3+1)
    expect(ev('7%4')).toBe(3);
    expect(ev('(c+90)+(5%3)')).toBe(92);
    expect(ev('1==1&&0==0')).toBe(1);
    expect(ev('0||1&&0')).toBe(0); // 0 | (1 & 0)
    expect(ev('3&&5')).toBe(1); // AND bit a bit
    expect(ev('2>1')).toBe(1);
    expect(ev('2<1')).toBe(0);
    expect(ev('2!=1')).toBe(1);
    expect(ev('30000+30000')).toBe(-5536); // 16 bits
  });

  it('árbol y texto', () => {
    const e = compileExpr('((c+90)+(r%210))');
    expect(exprToString(e)).toBe('((c+90)+(r%210))');
    expect(compileExpr(' ( s ( 0 , 0 , 69 ) == 1 ) ')).toEqual({
      k: 'bin',
      op: '==',
      a: { k: 'call', fn: 's', args: [{ k: 'num', v: 0 }, { k: 'num', v: 0 }, { k: 'num', v: 69 }] },
      b: { k: 'num', v: 1 },
    });
    expect(() => compileExpr('1+2+3')).toThrow();
    expect(() => compileExpr('(1')).toThrow();
  });

  it('acepta "&&==0" de HUMAN09 igual que el original', () => {
    const quirks: string[] = [];
    const bad = compileExpr('((b(1,0)==0)&&(b(1,3)&&==0)&&(b(1,4)==0))', quirks);
    const good = compileExpr('((b(1,0)==0)&&(b(1,3)==0)&&(b(1,4)==0))');
    expect(quirks.length).toBeGreaterThan(0);
    for (const fams of [[], [0], [3], [4], [0, 3, 4]]) {
      const { w, s } = script('');
      for (const f of fams) w.building(1, f);
      expect(s.evaluate(bad)).toBe(s.evaluate(good));
    }
  });
});

describe('ficheros auxiliares', () => {
  it('MSG, MTG y textos con color', () => {
    const m = parseMsg('text 1\nHOLA\n\ntext 5.\nWARNING\n% comentario\nsound 3\n');
    expect(m.get(1)).toBe('HOLA');
    expect(m.get(5)).toBe('WARNING');
    expect(m.size).toBe(2);
    const t = parseMtg(new Uint8Array([3, 2, 0, 1, 0, 0, 0, 7]).buffer)!;
    expect([t.w, t.h, t.ids[1], t.ids[5]]).toEqual([3, 2, 1, 7]);
    expect(parseColourText('~4Good ~2BEACONS~4 ok')).toEqual([
      { colour: 4, text: 'Good ' },
      { colour: 2, text: 'BEACONS' },
      { colour: 4, text: ' ok' },
    ]);
    expect(stripColours('~1A~2B')).toBe('AB');
  });

  it('cabecera sin vidas (ALIEN02 "8 norm (s(1,0,86)>2)") y bytes truncados', () => {
    const t = parseTro('8 norm (s(1,0,86)>2)\nexomoney 0 920\nend\n');
    expect(t[0].lifes).toBe(0);
    expect(exprToString(t[0].cond)).toBe('(s(1,0,86)>2)');
    expect(t[0].actions[0].args).toEqual([0, 920 & 255]);
  });
});

// ───────────── intérprete ─────────────

describe('intérprete', () => {
  it('norm: cada 8 fotogramas, c = fotogramas/16, acciones al revés', () => {
    const { s, shown, run } = script('0 norm 1 (c>0)\nmsg 2 0 1 3 1\nmsg 2 0 2 3 1\nend\n');
    run(15);
    expect(shown).toEqual([]);
    run(1); // fotograma 16: c = 1
    expect(shown).toEqual(['DOS']);
    expect(s.lifesOf(0)).toBe(0);
    run(16); // el primero dura 1 s
    expect(shown).toEqual(['DOS', 'UNO']);
    expect(s.currentMessage?.id).toBe(1);
  });

  it('vidas, setlifes y orden por id dentro de la misma pasada', () => {
    const { s, run } = script(
      '0 norm 3 (c>0)\nsetarray 0 (s(0,2,0)+1)\nend\n' +
        '1 norm 1 (c>0)\nsetlifes 2 1\nend\n' +
        '2 norm 0 (c>0)\nsetarray 1 7\nend\n' +
        '3 norm 1 (c>0)\nsetlifes 3 2\nend\n',
    );
    run(16);
    expect(s.tstat(0, 2, 1)).toBe(7); // el 2 se activó y disparó en la misma pasada
    expect(s.lifesOf(3)).toBe(1); // se pone a 2 y luego se resta 1
    run(24);
    expect(s.tstat(0, 2, 0)).toBe(3);
    expect(s.lifesOf(0)).toBe(0);
  });

  it('trip: dispara al entrar en la casilla, con S y t de la unidad', () => {
    const trip: TripMap = { w: 100, h: 80, ids: new Uint8Array(100 * 80) };
    const { w, s, run } = script('5 trip 1 ((S==0)&&(t==8))\nsetarray 0 1\nend\n', { trip });
    const [px, py] = w.at(10, 20);
    trip.ids[Math.floor(py / 32) * 100 + 10] = 5;
    const enemy = w.spawn(8, 2, px - 64, py);
    const mine = w.spawn(8, 0, px - 64, py);
    run(1);
    enemy.x = px;
    run(1);
    expect(s.lifesOf(5)).toBe(1);
    mine.x = px;
    run(1);
    expect(s.lifesOf(5)).toBe(0);
    expect(s.tstat(0, 2, 0)).toBe(1);
  });

  it('bail: resultado tras 10 s con el texto .00N', () => {
    const { s, run } = script('0 norm 1 (c>0)\nbail 1 2\nend\n', { endTexts: new Map([[2, '~4Too slow']]) });
    run(16);
    expect(s.result).toBeNull();
    expect(s.pending?.outcome).toBe('lose');
    expect(s.stat(0, 0)).toBe(1);
    expect(s.stat(7, 0)).toBe(2);
    run(150);
    expect(s.result).toEqual({ outcome: 'lose', code: 1, textNo: 2, text: '~4Too slow' });
  });

  it('b(), bajas por tipo con world.kill y comandante herido', () => {
    const { w, s, run } = script(
      '1 norm 1 ((b(1,0)==0)&&(b(1,1)==0))\nsetarray 0 1\nend\n' + '2 norm 1 ((s(0,0,69)==1)||(s(0,0,70)==1))\nsetarray 1 1\nend\n',
    );
    const hq = w.building(1, 0);
    const cmd = w.spawn(69, 0, 100, 100);
    const alien = w.spawn(8, 2, 120, 100);
    run(16);
    expect(s.tstat(0, 2, 0)).toBe(0);
    (w as unknown as World).kill(hq);
    (w as unknown as World).kill(cmd, alien);
    run(8);
    expect(s.tstat(0, 2, 0)).toBe(1);
    expect(s.tstat(0, 2, 1)).toBe(1);
    expect(s.stat(2, 2)).toBe(1); // bajas causadas por el equipo 2
    expect(s.stat(0, 3)).toBe(1);
    expect(s.tstat(2, 3, 69)).toBe(1);
    s.dispose();
    expect(Object.prototype.hasOwnProperty.call(w, 'kill')).toBe(false);
  });

  it('reinforce (dropship), reinforce2, exomoney, newtype, waypoint, ally, setmoney/newrate', () => {
    const events: ScriptEvent[] = [];
    const { w, s, run } = script(
      '0 norm 1 (c>0)\n' +
        'reinforce 0 22 2 0 4 69 1 0 0 0 0 0 0\n' +
        'reinforce2 3 50 50 8 2 0 0 0 0 0 0 0 0\n' +
        'exomoney 0 10\n' +
        'newtype 54 17 84\n' +
        'waypoint 63 18 2 53 15 55 19\n' +
        'ally 0 1 0\n' +
        // se ejecutan al revés: setmoney crea el respiradero y después newrate lo activa
        'newrate 20 30 30\n' +
        'setmoney 30 30 15000\n' +
        'end\n',
      { onEvent: (e) => events.push(e), dropDelay: 30 },
    );
    const beacon = w.spawn(95, 1, ...w.at(54, 17));
    const gray = w.spawn(8, 2, ...w.at(63, 18));
    w.building(0, 0);
    run(16);
    // reinforce2 inmediato; dropship pendiente
    expect(w.ents.filter((e) => e.team === 3 && e.type === 8).length).toBe(2);
    expect(w.ents.some((e) => e.type === 69)).toBe(false);
    expect(beacon.type).toBe(84);
    expect(w.commands[0].ids).toEqual([gray.id]);
    expect(w.commands[0].order).toMatchObject({ type: 'attackmove', x: 53 * 32 + 16, y: (80 - 1 - 15) * 32 + 16 });
    expect((w as unknown as World).enemies(0, 1)).toBe(true);
    expect((w as unknown as World).enemies(0, 2)).toBe(true);
    const vent = w.ents.find((e) => e.kind === 'vent')!;
    expect(vent.amount).toBe(15000);
    expect((vent as Entity & { rate?: number }).rate).toBe(20);
    expect(s.evaluate(compileExpr('m(30,30)'))).toBe(1);
    run(30);
    const cmd = w.ents.find((e) => e.type === 69)!;
    expect(w.tileOf(cmd.x, cmd.y)[0]).toBeGreaterThanOrEqual(21);
    expect(w.ents.filter((e) => e.team === 0 && e.type === 0).length).toBe(4);
    expect(events.map((e) => e.type)).toContain('landed');
    // exomoney cada 16 fotogramas con edificio de la familia 0
    const before = w.teams[0].money;
    run(16);
    expect(w.teams[0].money).toBe(before + 10);
    // la unidad llega al primer punto y sigue con el segundo
    gray.order = { type: 'idle', x: gray.x, y: gray.y };
    run(1);
    expect(w.commands.length).toBe(2);
    expect(w.commands[1].order).toMatchObject({ x: 55 * 32 + 16 });
  });

  it('reloj día/noche del .SCN y s(0,10)', () => {
    const { s, run } = script('0 norm 1 (s(0,10)==1)\nbail 1 2\nend\n', { scnHeader: [12, 1, 1, 100, 50, 10] });
    expect(s.isNight()).toBe(true);
    run(48);
    expect(s.pending).toBeNull();
    run(8); // la fase supera 100 en el fotograma 51: amanece
    expect(s.isNight()).toBe(false);
    expect(s.pending?.outcome).toBe('lose');
  });
});

// ───────────── ficheros reales ─────────────

const root: string = dataDir();
const have = fs.existsSync(path.join(root, 'SCENARIO', 'HUMAN'));
const text = (rel: string) => fs.readFileSync(resolveGameFile(root, rel), 'latin1');
const exists = (rel: string) => !!resolveGameFile(root, rel);

describe.skipIf(!have)('scripts del juego original', () => {
  // el cuerpo de un describe saltado se ejecuta igualmente al recoger los tests
  const dirs = have ? ['HUMAN', 'ALIEN', 'TEST', 'MPLAYER'] : [];
  const files = dirs.flatMap((d) =>
    fs
      .readdirSync(resolveGameFile(root, `SCENARIO/${d}`))
      .filter((f: string) => f.toLowerCase().endsWith('.tro'))
      .map((f: string) => `SCENARIO/${d}/${f}`),
  );

  it('todos los .TRO se analizan sin errores', () => {
    expect(files.length).toBeGreaterThan(90);
    const quirky: string[] = [];
    let triggers = 0;
    for (const f of files) {
      const diag: TroDiagnostics = { errors: [], quirks: [] };
      const t = parseTro(text(f), diag);
      expect(diag.errors, f).toEqual([]);
      expect(t.length, f).toBeGreaterThan(0);
      if (diag.quirks.length) quirky.push(path.basename(f).toUpperCase());
      triggers += t.length;
      for (const tr of t) {
        expect(tr.id).toBeLessThan(128);
        if (tr.kind === 'trip') expect(tr.id).toBeGreaterThan(0);
      }
    }
    expect(triggers).toBeGreaterThan(2000);
    expect(quirky).toEqual(['HUMAN09.TRO']);
  });

  it('HUMAN01: estructura', () => {
    const t = parseTro(text('SCENARIO/HUMAN/HUMAN01.TRO'));
    expect(t.map((x) => x.id)).toEqual([0, 1, 2, 4, 5, 7, 8, 9, 11]);
    const t1 = t.find((x) => x.id === 1)!;
    expect(t1.kind).toBe('trip');
    expect(t1.lifes).toBe(1);
    expect(exprToString(t1.cond)).toBe('(S==0)');
    expect(t1.actions.map((a) => a.verb)).toEqual(['newtype', ...Array(6).fill('waypoint'), 'reinforce', 'msg']);
    expect(t1.actions[0].args).toEqual([54, 17, 84]);
    expect(t1.actions[1].args).toEqual([63, 18, 2, 53, 15, 55, 19]);
    expect(t1.actions[7].args).toEqual([0, 54, 19, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0]);
    const t4 = t.find((x) => x.id === 4)!;
    expect([t4.kind, t4.lifes, exprToString(t4.cond)]).toEqual(['norm', 0, '(s(4,3)>2)']);
    expect(t4.actions.at(-1)).toMatchObject({ verb: 'bail', args: [0, 1] });
  });

  it('los msg referencian textos existentes y los bail sus .00N', () => {
    for (const f of files.filter((x) => !x.includes('MPLAYER'))) {
      const base = f.replace(/\.tro$/i, '');
      const msgs = exists(base + '.MSG') ? parseMsg(text(base + '.MSG')) : new Map();
      for (const tr of parseTro(text(f)))
        for (const a of tr.actions) {
          if (a.verb === 'msg') expect(msgs.has(a.args[2]), `${f}:${a.line}`).toBe(true);
          // HTRAIN6 usa un .004 que no existe en el disco original
          if (a.verb === 'bail' && !f.includes('HTRAIN6')) expect(exists(`${base}.${String(a.args[1]).padStart(3, '0')}`), `${f}:${a.line}`).toBe(true);
        }
    }
  });

  it('los .MTG coinciden con el mapa y apuntan a disparadores trip', () => {
    let hits = 0;
    for (const f of files.filter((x) => !x.includes('MPLAYER'))) {
      const base = f.replace(/\.tro$/i, '');
      if (!exists(base + '.MTG')) continue;
      const b = fs.readFileSync(resolveGameFile(root, base + '.MTG'));
      const m = parseMtg(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)!;
      const map = fs.readFileSync(resolveGameFile(root, base + '.MAP'));
      expect([m.w, m.h]).toEqual([map.readUInt32LE(0), map.readUInt32LE(4)]);
      const trips = new Set(parseTro(text(f)).filter((t) => t.kind === 'trip').map((t) => t.id));
      const used = new Set(m.ids.filter((v) => v));
      // algunas casillas apuntan a disparadores norm o inexistentes (el original las ignora)
      hits += [...used].filter((v) => trips.has(v)).length;
      if (path.basename(f).toUpperCase() === 'HUMAN01.TRO') expect([...used].sort((a, b) => a - b)).toEqual([1, 2, 7, 11]);
    }
    expect(hits).toBeGreaterThan(40);
  });
});

describe.skipIf(!fs.existsSync(path.join(root, 'GAMESTAT')))('misión real (HUMAN01)', () => {
  beforeAll(() => {
    globalThis.fetch = (async (input: string | URL) => {
      const rel = decodeURIComponent(String(input).replace(/^\/dc\//, ''));
      const file = resolveGameFile(root, rel);
      if (!file || !fs.statSync(file).isFile()) return new Response(null, { status: 404 });
      return new Response(fs.readFileSync(file));
    }) as typeof fetch;
  });

  it('el comandante llega en el dropship y suenan los primeros mensajes', async () => {
    const { Rules } = await import('../src/game/rules');
    const { AnimDB } = await import('../src/render/anims');
    const { loadGame } = await import('../src/game/scenario');
    const rules = await Rules.load();
    const anims = new AnimDB();
    await anims.load();
    const game = await loadGame({ scn: 'scenario/human/human01.scn', mode: 'campaign', playerRace: 0, startMoney: 0 }, rules, anims);
    const mission = await loadMission('scenario/human/human01');
    expect(mission.diag.errors).toEqual([]);
    expect(mission.trip?.w).toBe(game.world.w);
    expect(mission.endTexts.get(1)).toContain('DROPSHIP BEACONS');
    const shown: string[] = [];
    game.world.hooks.message = (t) => shown.push(t);
    const s = createMissionScript(game.world, mission, { scnHeader: game.scenario.header });
    for (let i = 0; i < 16 + 4 * 15 + 1; i++) {
      game.world.step();
      s.step();
    }
    expect(s.messageLog[0].text).toBe('SENSORS LOCKED TO THE BEACON...PREPARE FOR LANDING');
    expect(shown).toContain('SENSORS LOCKED TO THE BEACON...PREPARE FOR LANDING');
    const cmd = game.world.ents.find((e) => e.team === 0 && e.type === 69 && e.alive);
    expect(cmd).toBeDefined();
    const [tx, ty] = game.world.tileOf(cmd!.x, cmd!.y);
    expect(Math.abs(tx - 22) + Math.abs(game.world.h - 1 - ty - 2)).toBeLessThan(6);
    expect(s.exoMoney[0]).toBe(0);
    expect(s.result).toBeNull();
    s.dispose();
  }, 120000);

  it('todas las misiones de campaña y entrenamiento corren un minuto sin excepciones', async () => {
    const { Rules } = await import('../src/game/rules');
    const { AnimDB } = await import('../src/render/anims');
    const { loadGame } = await import('../src/game/scenario');
    const rules = await Rules.load();
    const anims = new AnimDB();
    await anims.load();
    let missions = 0;
    for (const dir of ['human', 'alien', 'test']) {
      const scns = fs.readdirSync(resolveGameFile(root, `scenario/${dir}`)).filter((f: string) => /^(human|alien|atrain|htrain)\d+\.scn$/i.test(f));
      for (const f of scns) {
        const scn = `scenario/${dir}/${f.toLowerCase()}`;
        const game = await loadGame({ scn, mode: 'campaign', playerRace: 0, startMoney: 0 }, rules, anims);
        const mission = await loadMission(scn);
        expect(mission.diag.errors, f).toEqual([]);
        const s = createMissionScript(game.world, mission, { scnHeader: game.scenario.header });
        for (let i = 0; i < 15 * 60 && !s.result; i++) {
          game.world.step();
          s.step();
        }
        s.dispose();
        missions++;
      }
    }
    expect(missions).toBe(44);
  }, 120000);
});
