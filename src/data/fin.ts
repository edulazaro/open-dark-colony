// Formato .FIN (animaciones). Obtenido decompilando con REA/Ghidra la función que
// referencia "animate/%s" (FUN_004230ac, animate.c). Ver docs/FORMATS.md.
//
//   u16 versión (29), u16 nframes, u16 nanims, u16 njuice
//   njuice × char[8]                 nombres de .SPR ("juice files")
//   nanims × { char[16] nombre, i16 primer frame, i16 último frame }
//   nframes × { i16 npartes, i16 retardo, 8 × { char[16] evento, i16, i16 } }
//   Σnpartes × { char[8] spr, i16 sprite, i16 dx, i16 dy, i16 z, i16 ?, i16 capa, i16 espejo }

export interface FinPart {
  juice: string;
  sprite: number;
  dx: number;
  dy: number;
  z: number;
  layer: number;
  flip: boolean;
}

export interface FinFrame {
  delay: number;
  events: string[];
  parts: FinPart[];
}

export interface FinAnim {
  name: string;
  first: number;
  last: number;
}

export interface Fin {
  name: string;
  juice: string[];
  anims: FinAnim[];
  frames: FinFrame[];
}

function cstr(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = b[off + i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function parseFin(name: string, buf: ArrayBuffer): Fin {
  const dv = new DataView(buf);
  const b = new Uint8Array(buf);
  if (b.length < 8) return { name, juice: [], anims: [], frames: [] };
  const nframes = dv.getUint16(2, true);
  const nanims = dv.getUint16(4, true);
  const njuice = dv.getUint16(6, true);
  let p = 8;
  const juice: string[] = [];
  for (let i = 0; i < njuice && p + 8 <= b.length; i++, p += 8) juice.push(cstr(b, p, 8).toLowerCase());
  const anims: FinAnim[] = [];
  for (let i = 0; i < nanims && p + 20 <= b.length; i++, p += 20) {
    anims.push({ name: cstr(b, p, 16).toUpperCase(), first: dv.getInt16(p + 16, true), last: dv.getInt16(p + 18, true) });
  }
  const counts: number[] = [];
  const frames: FinFrame[] = [];
  for (let i = 0; i < nframes && p + 164 <= b.length; i++, p += 164) {
    counts.push(dv.getInt16(p, true));
    const events: string[] = [];
    for (let k = 0; k < 8; k++) {
      const e = cstr(b, p + 4 + k * 20, 16);
      if (e && e !== 'NONAME') events.push(e);
    }
    frames.push({ delay: dv.getInt16(p + 2, true), events, parts: [] });
  }
  // Algunos .FIN de desarrollo que no figuran en ANIM.DAT están truncados.
  for (let i = 0; i < nframes; i++) {
    for (let k = 0; k < counts[i] && p + 22 <= b.length; k++, p += 22) {
      frames[i].parts.push({
        juice: cstr(b, p, 8).toLowerCase(),
        sprite: dv.getInt16(p + 8, true),
        dx: dv.getInt16(p + 10, true),
        dy: dv.getInt16(p + 12, true),
        z: dv.getInt16(p + 14, true),
        layer: dv.getInt16(p + 18, true),
        flip: dv.getInt16(p + 20, true) !== 0,
      });
    }
  }
  return { name, juice, anims, frames };
}

/** Duración de un frame en ticks de 15 Hz, como en el original: ((retardo o 15) + 3) * 15 / 100. */
export function frameTicks(delay: number): number {
  const d = delay || 15;
  return Math.max(1, Math.floor(((d + 3) * 15) / 100));
}
