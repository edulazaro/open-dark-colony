// Ficheros de layout de interfaz del original (intrface/maine, intrface/lopt…):
//   textmsg <id> <texto…>
//   pushb|checkb|count <id> <desc> <x> <y> <w> <h> <normal> <pulsado> [opciones…]
//   picture <id> <desc> <x> <y> <w> <h> <imagen>
//   group <id> <desc> <miembros…> <panel>
//   in_text <id> <desc> <x> <y> <columnas> <filas> <fuente> …
//   scount <id> <desc> <x> <y> <w> <h> <imagen> …

export interface Widget {
  kind: string;
  id: number;
  desc: number;
  x: number;
  y: number;
  w: number;
  h: number;
  normal: number;
  pushed: number;
  opts: string[];
}

export interface Layout {
  size: [number, number];
  pictures: string;
  background: string;
  fonts: Map<number, string>;
  fontOffset: Map<number, number>;
  text: Map<number, string>;
  widgets: Widget[];
  byId: Map<number, Widget[]>;
  groups: Map<number, { members: number[]; panel: number }>;
}

export function parseLayout(src: string): Layout {
  const L: Layout = {
    size: [640, 480],
    pictures: '',
    background: '',
    fonts: new Map(),
    fontOffset: new Map(),
    text: new Map(),
    widgets: [],
    byId: new Map(),
    groups: new Map(),
  };
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('%')) continue;
    const t = line.split(/\s+/);
    const k = t[0];
    const n = (i: number) => parseInt(t[i], 10);
    switch (k) {
      case 'size':
        L.size = [n(1), n(2)];
        break;
      case 'pictures':
        L.pictures = t[1];
        break;
      case 'background':
        L.background = t[1];
        break;
      case 'font':
        L.fonts.set(n(1), t[2]);
        break;
      case 'font_offset':
        L.fontOffset.set(n(1), n(2));
        break;
      case 'textmsg':
        L.text.set(n(1), line.replace(/^textmsg\s+\d+\s*/, ''));
        break;
      case 'group': {
        const nums = t.slice(3).map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x));
        L.groups.set(n(1), { members: nums.slice(0, -1), panel: nums[nums.length - 1] });
        break;
      }
      case 'pushb':
      case 'checkb':
      case 'count':
      case 'picture':
      case 'scount':
      case 'in_text': {
        const w: Widget = {
          kind: k,
          id: n(1),
          desc: n(2),
          x: n(3),
          y: n(4),
          w: n(5),
          h: n(6),
          normal: n(7),
          pushed: n(8),
          opts: t.slice(9),
        };
        L.widgets.push(w);
        let arr = L.byId.get(w.id);
        if (!arr) L.byId.set(w.id, (arr = []));
        arr.push(w);
        break;
      }
    }
  }
  return L;
}

/** Miembros (recursivos) de un grupo. */
export function groupMembers(L: Layout, id: number, seen = new Set<number>()): number[] {
  const g = L.groups.get(id);
  if (!g || seen.has(id)) return [];
  seen.add(id);
  const out: number[] = [];
  for (const m of g.members) {
    if (L.groups.has(m)) out.push(...groupMembers(L, m, seen));
    else out.push(m);
  }
  return out;
}
