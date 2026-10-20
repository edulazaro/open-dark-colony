// Tilesets (.BTS), mapas (.MAP) y alturas (.MTG). Obtenidos decompilando mapit.c
// (FUN_0044e5b8 "kev: remappings" y FUN_0044e720 "map"). Ver docs/FORMATS.md.
import { readPalette } from './spr';

export interface Tileset {
  palette: Uint8Array;
  maxId: number;
  /** id de tesela -> 32×32 índices de paleta (0 = transparente en capas superpuestas) */
  tiles: Map<number, Uint8Array>;
}

/** .BTS: u32 maxId, u32 n, paleta[768], n × { u32 id, u8[1024] } */
export function parseBts(buf: ArrayBuffer): Tileset {
  const dv = new DataView(buf);
  const maxId = dv.getUint32(0, true);
  const n = dv.getUint32(4, true);
  const palette = readPalette(dv, 8);
  const tiles = new Map<number, Uint8Array>();
  let p = 8 + 768;
  for (let i = 0; i < n && p + 1028 <= buf.byteLength; i++, p += 1028) {
    tiles.set(dv.getUint32(p, true), new Uint8Array(buf, p + 4, 1024));
  }
  return { palette, maxId, tiles };
}

export interface GameMap {
  w: number;
  h: number;
  /** tesela base por celda (fila 0 = arriba en pantalla) */
  base: Uint16Array;
  /** tesela superpuesta (0 = ninguna) */
  over: Uint16Array;
  /** flags: bit 7 = transitable, bits 10..14 = tipo de bloque (sonido ambiente) */
  flags: Uint16Array;
}

export const FLAG_PASSABLE = 0x80;

/** .MAP: u32 w, u32 h, w*h × {u16 base, u16 over}, w*h × u16 flags */
export function parseMap(buf: ArrayBuffer): GameMap {
  const dv = new DataView(buf);
  const w = dv.getUint32(0, true);
  const h = dv.getUint32(4, true);
  const n = w * h;
  const base = new Uint16Array(n);
  const over = new Uint16Array(n);
  const flags = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    base[i] = dv.getUint16(8 + i * 4, true);
    over[i] = dv.getUint16(8 + i * 4 + 2, true);
    flags[i] = dv.getUint16(8 + n * 4 + i * 2, true);
  }
  return { w, h, base, over, flags };
}
