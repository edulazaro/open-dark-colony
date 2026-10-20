// Parsers de sonido contra los ficheros reales del juego (si están disponibles).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
// @ts-expect-error módulo JS sin tipos
import { dataDir, resolveGameFile } from '../gamedata.mjs';
import { dataLines } from '../src/data/vfs';
import {
  SOUND_CATEGORIES,
  SoundSystem,
  dsVolumeToGain,
  parseAmbient,
  parseSlist,
  parseSound2,
  parseSoundSet,
  parseWav,
  spatialize,
} from '../src/audio/sound';

const root: string = dataDir();
const resolve = (rel: string): string | null => resolveGameFile(root, rel);
const have = fs.existsSync(root) && !!resolve('sound/slist.dat');
const text = (rel: string) => fs.readFileSync(resolve(rel)!, 'latin1');
const bin = (rel: string) => {
  const b = fs.readFileSync(resolve(rel)!);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const AMB_SETS = ['atlantis', 'desert', 'htrain', 'jungle', 'special'];

describe.skipIf(!have)('sonido: datos originales', () => {
  const sound2 = have ? parseSound2(text('sound/sound2.dat')) : new Map();
  const slist = have ? parseSlist(text('sound/slist.dat')) : new Map();
  const wav = (id: number) => sound2.get(id)?.path;

  it('SOUND2.DAT: 200 entradas con parámetros', () => {
    expect(sound2.size).toBe(200);
    for (let i = 0; i < 200; i++) expect(sound2.has(i)).toBe(true);
    expect(wav(7)).toBe('sound/barrwea.wav');
    expect(wav(0)).toBe('sound/unit.wav');
    expect(sound2.get(8)).toMatchObject({ buffers: 5, volume: 0, loop: false });
    expect(sound2.get(19)).toMatchObject({ path: 'sound/whale.wav', volume: -600, loop: false });
    expect(sound2.get(45)).toMatchObject({ path: 'sound/droplp.wav', buffers: 5, loop: true });
    expect(sound2.get(134)).toMatchObject({ path: 'sound/hum.wav', volume: -1000, loop: true });
    for (const e of sound2.values()) expect(e.flag).toBe(1); // columna sin uso
  });

  it('SOUND2.DAT: todos los WAV existen y son PCM legibles', () => {
    const missing: string[] = [];
    for (const e of sound2.values()) if (!resolve(e.path)) missing.push(`${e.id} ${e.path}`);
    expect(missing).toEqual([]);
    for (const p of new Set([...sound2.values()].map((e) => e.path))) {
      const w = parseWav(bin(p));
      expect(w, p).not.toBeNull();
      expect(w!.frames, p).toBeGreaterThan(0);
      expect(w!.samples[0].every((v) => v >= -1 && v <= 1), p).toBe(true);
    }
  });

  it('SLIST.DAT: categorías, listas y prioridades', () => {
    const seen = new Set<string>();
    for (const [obj, cats] of slist) {
      expect(obj).toBeGreaterThanOrEqual(0);
      expect(obj).toBeLessThan(200);
      for (const [cat, e] of cats) {
        seen.add(cat);
        expect(e.ids.length).toBeLessThanOrEqual(10);
        for (const id of e.ids) expect(sound2.has(id), `${obj} ${cat} ${id}`).toBe(true);
        if (cat === 'ACK' || cat === 'SEL') expect(e.priority).toBeLessThan(200);
      }
    }
    expect([...seen].sort()).toEqual([...SOUND_CATEGORIES].sort());
    expect(slist.get(0)!.get('DEA')!.ids).toEqual([28, 90, 153, 154]);
    expect(slist.get(0)!.get('DEA')!.ids).toContain(28);
    expect(slist.get(0)!.get('SEL')).toEqual({ ids: [81, 83], priority: 4 });
    expect(slist.get(4)!.get('ACK')).toEqual({ ids: [158, 159, 160, 161], priority: 3 });
    expect(slist.get(105)!.get('SEL')).toEqual({ ids: [51], priority: 1 });
    expect(slist.get(1)!.get('XTR')!.ids.map(wav)).toEqual(['sound/erupt.wav']);
  });

  it('WEAPSTAT: la columna sound indexa la categoría GUN de SLIST', () => {
    const weapons = new Map<number, number>();
    for (const l of dataLines(text('gamestat/weapstat.txt')).slice(1)) {
      const t = l.split(/\s+/);
      if (t.length >= 4) weapons.set(parseInt(t[0], 10), parseInt(t[3], 10));
    }
    expect(weapons.size).toBeGreaterThan(50);
    for (const [w, s] of weapons) expect(slist.get(s)?.get('GUN')?.ids.length, `arma ${w} sound ${s}`).toBeGreaterThan(0);
    const gun = (weapon: number) => slist.get(weapons.get(weapon)!)!.get('GUN')!.ids.map(wav);
    expect(gun(10)).toEqual(['sound/barrwea.wav']); // artillería BARR
    expect(new Set(gun(7))).toEqual(new Set(['sound/mechwea.wav', 'sound/mechwea2.wav', 'sound/mechwea3.wav']));
    expect(gun(13)).toEqual(['sound/cywea.wav']); // "Sniper" = arma del ciborg
    expect(gun(15)).toEqual(['sound/gray1wea.wav', 'sound/gray2wea.wav', 'sound/gray3wea.wav']);
    expect(gun(48)).toEqual(['sound/rnatwea.wav', 'sound/rnatwea1.wav']);
    expect(gun(53)).toEqual(['sound/batwea.wav', 'sound/batwea1.wav']);
    // como id directo de SOUND2 no cuadraría: el 10 es una voz de selección
    expect(wav(10)).toBe('sound/gcsel.wav');
  });

  it('*.AMB: listas de ambiente por día/noche y tipo de bloque', () => {
    const desert = parseAmbient(text('sound/desert.amb'));
    expect(desert[0].get(3)).toEqual([20, 23, 61, 61]);
    expect(desert[1].get(3)).toEqual([19, 170, 60, 61, 61, 61]);
    expect(desert[0].get(7)).toEqual([58, 59, 57]);
    const jungle = parseAmbient(text('sound/jungle.amb'));
    expect(jungle[1].get(1)).toEqual([180, 60, 181]);
    const atlantis = parseAmbient(text('sound/atlantis.amb'));
    expect(atlantis[1].size).toBe(0); // sin listas de noche
    expect(atlantis[0].get(14)).toEqual([77, 133, 41, 77, 62, 62, 133, 133]);
    for (const set of AMB_SETS) {
      const t = parseAmbient(text(`sound/${set}.amb`));
      for (const lists of t) {
        for (const ids of lists.values()) {
          expect(ids.length).toBeLessThanOrEqual(10);
          for (const id of ids) {
            expect(sound2.has(id)).toBe(true);
            expect(sound2.get(id)!.loop).toBe(false); // ningún ambiente original es un bucle
          }
        }
      }
    }
  });

  it('NEWSND.DAT: sonidos de menú', () => {
    const s = parseSoundSet(text('sound/newsnd.dat'));
    expect([...s.values()]).toEqual([{ id: 1, path: 'sound/rezin.wav', volume: -1000 }]);
    expect(resolve('sound/rezin.wav')).not.toBeNull();
  });

  it('SoundSystem sin audio: no lanza y prioriza voces SEL/ACK', () => {
    const snd = new SoundSystem(sound2, slist);
    snd.rand = () => 0.5;
    snd.unlock(); // en node no hay AudioContext
    expect(snd.unlocked).toBe(false);
    expect(snd.categories()).toEqual(['GUN', 'ACK', 'SEL', 'DEA', 'AMB', 'DPY', 'EXP', 'XTR']);
    expect(snd.hasUnitSound(0, 'DEA')).toBe(true);
    expect(snd.hasUnitSound(0, 'dea')).toBe(true);
    expect(snd.hasUnitSound(1, 'DEA')).toBe(false);
    snd.setListener(320, 240, 640, 480);
    snd.playId(7, 100, 100);
    snd.playId(9999);
    snd.playUnit(0, 'DEA', 300, 200);
    snd.playWeapon(10, 0, 0);
    snd.playExplosion(1, 0, 0);
    snd.playMenu(1);
    const loop = snd.playLoop(45, 10, 10);
    loop.setPosition(20, 20);
    loop.stop();
    expect(loop.active).toBe(false);
    // selección de un grupo: habla la unidad de mejor prioridad (ciborg = 3)
    snd.playUnit(5, 'SEL'); // VTOL, prioridad 12
    snd.playUnit(4, 'SEL'); // ciborg, prioridad 3
    snd.playUnit(0, 'SEL'); // tropa, prioridad 4: no la sustituye
    snd.playUnit(2, 'ACK');
    expect(snd.pendingVoices()).toEqual({ SEL: 162, ACK: 109 });
    snd.update(0.016);
    expect(snd.pendingVoices()).toEqual({});
    snd.setAmbientTable('desert', parseAmbient(text('sound/desert.amb')));
    snd.setAmbient('DESERT.RMP', true, 3);
    for (let i = 0; i < 1000; i++) snd.update(0.05);
    snd.volume = 2;
    expect(snd.volume).toBe(1);
    snd.muted = true;
    snd.stopAll();
  });
});

describe('sonido: espacialización', () => {
  const view = { x: 1000, y: 1000, w: 640, h: 480 };
  it('volumen DirectSound → ganancia', () => {
    expect(dsVolumeToGain(0)).toBe(1);
    expect(dsVolumeToGain(-600)).toBeCloseTo(0.501, 3);
    expect(dsVolumeToGain(-2000)).toBeCloseTo(0.1, 6);
  });
  it('atenuación y panorama', () => {
    expect(spatialize(1000, 1000, view)).toEqual({ gain: 1, pan: 0 });
    const right = spatialize(1300, 1000, view);
    const left = spatialize(700, 1000, view);
    expect(right.pan).toBeGreaterThan(0);
    expect(left.pan).toBeCloseTo(-right.pan, 9);
    expect(right.gain).toBeGreaterThan(0.9); // en pantalla apenas se atenúa (fórmula original)
    const near = spatialize(1000 + 320 + 100, 1000, view); // fuera, cerca del borde
    expect(near.gain).toBeGreaterThan(0);
    expect(near.gain).toBeLessThan(right.gain);
    expect(spatialize(1000 + 320 + 400, 1000, view).gain).toBe(0); // lejos de la vista
    expect(spatialize(1000, 1000 + 240 + 300, view).gain).toBe(0);
  });
});
