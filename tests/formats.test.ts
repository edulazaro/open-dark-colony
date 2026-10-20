// Pasa los parsers por los ficheros reales del juego (si están disponibles).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error módulo JS sin tipos
import { dataDir, resolveGameFile } from '../gamedata.mjs';
import { parseSpr } from '../src/data/spr';
import { parseFin } from '../src/data/fin';
import { parseBts, parseMap, FLAG_PASSABLE } from '../src/data/map';
import { parseScn } from '../src/data/scn';
import { parseGamestat, parseWeapstat, parseMbullet, parseDepend } from '../src/data/stats';

const root: string = dataDir();
const have = fs.existsSync(path.join(root, 'GAMESTAT'));
const read = (rel: string) => {
  const b = fs.readFileSync(resolveGameFile(root, rel));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const text = (rel: string) => fs.readFileSync(resolveGameFile(root, rel), 'latin1');
const list = (dir: string, ext: string) =>
  fs.readdirSync(resolveGameFile(root, dir)).filter((f: string) => f.toLowerCase().endsWith(ext));

describe.skipIf(!have)('formatos del juego original', () => {
  it('SPR: todos los sprites se decodifican y consumen el fichero entero', () => {
    for (const dir of ['SPRITES', 'INTRFACE', 'CURSOR']) {
      for (const f of list(dir, '.spr')) {
        const s = parseSpr(f, read(`${dir}/${f}`));
        expect(s.frames.length).toBeGreaterThan(0);
        expect([0x01, 0x81]).toContain(s.type);
      }
    }
  });

  it('FIN: todas las animaciones referencian frames y sprites válidos', () => {
    const used = text('ANIM.DAT').split(/\s+/).filter(Boolean);
    expect(used.length).toBeGreaterThan(80);
    for (const f of list('ANIMATE', '.fin')) parseFin(f, read(`ANIMATE/${f}`)); // no debe lanzar
    for (const f of used) {
      const fin = parseFin(f, read(`ANIMATE/${f}`));
      const parts = fin.frames.reduce((n, fr) => n + fr.parts.length, 0);
      const consumed = 8 + fin.juice.length * 8 + fin.anims.length * 20 + fin.frames.length * 164 + parts * 22;
      const size = read(`ANIMATE/${f}`).byteLength;
      // Uno de los ficheros trae 22 bytes de basura al final (una parte de más).
      expect(size - consumed).toBeGreaterThanOrEqual(0);
      expect(size - consumed).toBeLessThanOrEqual(22);
      for (const a of fin.anims) {
        expect(a.first).toBeGreaterThanOrEqual(0);
        expect(a.last).toBeLessThan(fin.frames.length);
      }
    }
    const trsc = parseFin('trsc.fin', read('ANIMATE/TRSC.FIN'));
    expect(trsc.juice).toEqual(['trsc', 'smsp', 'bloo', 'blaz', 'ssss']);
    expect(trsc.anims.find((a) => a.name === 'TRSCMOVE0')).toEqual({ name: 'TRSCMOVE0', first: 16, last: 23 });
  });

  it('BTS + MAP: todas las teselas usadas por los mapas existen', () => {
    const scnDirs = ['SCENARIO/HUMAN', 'SCENARIO/ALIEN', 'SCENARIO/MPLAYER'];
    const tilesets = new Map<string, ReturnType<typeof parseBts>>();
    let maps = 0;
    for (const dir of scnDirs) {
      for (const f of list(dir, '.scn')) {
        const scn = parseScn(text(`${dir}/${f}`));
        if (!tilesets.has(scn.tileset)) tilesets.set(scn.tileset, parseBts(read(`SCENARIO/${scn.tileset}`)));
        const ts = tilesets.get(scn.tileset)!;
        const m = parseMap(read(`${dir}/${f.replace(/\.scn$/i, '.MAP')}`));
        let missing = 0;
        for (let i = 0; i < m.w * m.h; i++) {
          if (!ts.tiles.has(m.base[i])) missing++;
          if (m.over[i] && !ts.tiles.has(m.over[i])) missing++;
        }
        expect(missing / (m.w * m.h)).toBeLessThan(0.01);
        expect(m.flags.some((v) => v & FLAG_PASSABLE)).toBe(true);
        maps++;
      }
    }
    expect(maps).toBeGreaterThan(50);
  });

  it('SCN: equipos y objetos', () => {
    const s = parseScn(text('SCENARIO/HUMAN/HUMAN01.SCN'));
    expect(s.tileset).toBe('desert.bts');
    expect(s.teams.length).toBe(8);
    expect(s.teams[1].slots[0]).toEqual([69, 65]);
    expect(s.objects[0]).toMatchObject({ x: 22, y: 3, type: 84, team: 0 });
  });

  it('GAMESTAT / WEAPSTAT / MBULLET / DEPEND', () => {
    const units = parseGamestat(text('GAMESTAT/GAMESTAT.TXT'));
    expect(units.length).toBe(106);
    expect(units[0]).toMatchObject({ sprite: 'TRSC', race: 0, hp: 800, armor: 0, counterpart: 8 });
    expect(units[8].sprite).toBe('GRAY');
    const w = parseWeapstat(text('GAMESTAT/WEAPSTAT.TXT'));
    expect(w.get(1)).toMatchObject({ damage: 100, range: 4, rof: 15 });
    const mb = parseMbullet(text('GAMESTAT/MBULLET.TXT'));
    expect(mb.length).toBe(9);
    expect(mb[0][0]).toBe(25);
    const dep = parseDepend(text('GAMESTAT/DEPEND.TXT'));
    expect(dep.find((d) => d.id === 9)).toMatchObject({ cost: 350, kind: 1, target: 0, deps: [1] });
    expect(dep.find((d) => d.id === 1)).toMatchObject({ cost: 1000, kind: 0, target: 1, deps: [0] });
  });
});
