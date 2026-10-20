// Formato .SPR (sprites). Ver docs/FORMATS.md.
//
//   u16 tipo        0x81 = RLE con tamaño por frame, 0x01 = crudo
//   u16 nframes
//   u32 tamaño de datos
//   u8  paleta[256*3]   (VGA 6 bits)
//   nframes × { i16 w, i16 h, i16 x, i16 y }   (x,y = posición en el lienzo de render)
//   frames:
//     0x81: u32 tamaño + RLE: byte c con signo; c<0 => saltar -c píxeles transparentes,
//           c>=0 => copiar c+1 píxeles literales. Las filas se rellenan de izquierda a derecha.
//     0x01: w*h bytes crudos (índice 0 = transparente)

export interface SprFrame {
  w: number;
  h: number;
  x: number;
  y: number;
  /** índices de paleta; 0 = transparente */
  pixels: Uint8Array;
}

export interface Spr {
  name: string;
  type: number;
  /** paleta RGB 8 bits (768 bytes) */
  palette: Uint8Array;
  frames: SprFrame[];
}

export function vga6to8(v: number): number {
  return Math.min(255, (v << 2) | (v >> 4));
}

export function readPalette(dv: DataView, off: number): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 768; i++) pal[i] = vga6to8(dv.getUint8(off + i) & 63);
  return pal;
}

export function parseSpr(name: string, buf: ArrayBuffer): Spr {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const type = dv.getUint16(0, true);
  const n = dv.getUint16(2, true);
  const palette = readPalette(dv, 8);
  const frames: SprFrame[] = [];
  let p = 0x308 + n * 8;
  for (let i = 0; i < n; i++) {
    const t = 0x308 + i * 8;
    const w = dv.getInt16(t, true);
    const h = dv.getInt16(t + 2, true);
    const x = dv.getInt16(t + 4, true);
    const y = dv.getInt16(t + 6, true);
    const size = Math.max(0, w) * Math.max(0, h);
    const pixels = new Uint8Array(size);
    if (type & 0x80) {
      const len = dv.getUint32(p, true);
      p += 4;
      const end = Math.min(p + len, bytes.length);
      let q = p;
      let o = 0;
      while (q < end && o < size) {
        const c = bytes[q++];
        if (c >= 128) {
          o += 256 - c;
        } else {
          const cnt = Math.min(c + 1, size - o, end - q);
          pixels.set(bytes.subarray(q, q + cnt), o);
          q += c + 1;
          o += c + 1;
        }
      }
      p = end;
    } else {
      pixels.set(bytes.subarray(p, Math.min(p + size, bytes.length)));
      p += size;
    }
    frames.push({ w, h, x, y, pixels });
  }
  return { name, type, palette, frames };
}
