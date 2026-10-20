import { describe, it, expect } from 'vitest';
import { buildFileMap } from '../src/data/local';
import { exists, fetchText, listDir, useLocalFiles, usingLocalFiles } from '../src/data/vfs';

const blob = (s: string) => new Blob([s]);

describe('datos elegidos en el navegador', () => {
  const entries = [
    { path: 'Juegos/DCOLONY/GAMESTAT/GAMESTAT.TXT', blob: blob('gamestat') },
    { path: 'Juegos/DCOLONY/GAMESTAT/WEAPSTAT.TXT', blob: blob('weapstat') },
    { path: 'Juegos/DCOLONY/INTRFACE/INTRO.GIF', blob: blob('gif') },
    { path: 'Juegos/DCOLONY/INTRFACE/MAINE', blob: blob('maine') },
    { path: 'Juegos/DCOLONY/SCENARIO/MPLAYER/D2PLAY01.SCN', blob: blob('scn1') },
    { path: 'Juegos/DCOLONY/SCENARIO/MPLAYER/J2PLAY01.SCN', blob: blob('scn2') },
    { path: 'Juegos/DCOLONY/AVI/INTRO.AVI', blob: blob('video') },
    { path: 'Juegos/DCOLONY/DC.EXE', blob: blob('exe') },
    { path: 'Juegos/otro.txt', blob: blob('fuera') },
  ];

  it('encuentra la raíz del juego y descarta vídeos, ejecutables y lo de fuera', () => {
    const { files, missing } = buildFileMap(entries);
    expect(missing).toEqual([]);
    expect([...files.keys()].sort()).toEqual([
      'gamestat/gamestat.txt',
      'gamestat/weapstat.txt',
      'intrface/intro.gif',
      'intrface/maine',
      'scenario/mplayer/d2play01.scn',
      'scenario/mplayer/j2play01.scn',
    ]);
    expect(files.get('intrface/maine')?.path).toBe('INTRFACE/MAINE');
  });

  it('acepta rutas con barras invertidas (ZIP de Windows) y avisa de lo que falta', () => {
    const { files, missing } = buildFileMap([{ path: 'DCOLONY\\GAMESTAT\\GAMESTAT.TXT', blob: blob('x') }]);
    expect(files.has('gamestat/gamestat.txt')).toBe(true);
    expect(missing).toEqual(['gamestat/weapstat.txt', 'intrface/intro.gif', 'intrface/maine']);
    expect(buildFileMap([{ path: 'fotos/a.jpg', blob: blob('x') }]).files.size).toBe(0);
  });

  it('vfs lee de los ficheros elegidos sin distinguir mayúsculas', async () => {
    useLocalFiles(buildFileMap(entries).files);
    expect(usingLocalFiles()).toBe(true);
    expect(await fetchText('GameStat/WEAPSTAT.txt')).toBe('weapstat');
    expect(await exists('scenario/mplayer/d2play01.scn')).toBe(true);
    expect(await exists('avi/intro.avi')).toBe(false);
    expect((await listDir('scenario/mplayer')).sort()).toEqual(['D2PLAY01.SCN', 'J2PLAY01.SCN']);
    expect(await listDir('scenario')).toEqual(['MPLAYER']);
    await expect(fetchText('sprites/nada.spr')).rejects.toThrow();
  });
});
