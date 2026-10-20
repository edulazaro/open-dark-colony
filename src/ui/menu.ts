// Menús: principal, escaramuza y campañas, dibujados sobre los fondos originales.
import { fetchBin, fetchText, fileUrl, listDir } from '../data/vfs';
import { parseSpr } from '../data/spr';
import { frameToCanvas, Palette } from '../render/gfx';
import { parseScn } from '../data/scn';
import { HUMAN, ALIEN } from '../game/rules';
import type { GameSetup } from '../game/scenario';
import type { BitmapFont } from './font';

interface Item {
  label: string;
  value?: string;
  action: () => void;
  y?: number;
}

export interface MenuAssets {
  loader: HTMLImageElement;
  story: HTMLImageElement;
  font: BitmapFont;
  fontHi: BitmapFont;
  fontBig: BitmapFont;
  ency?: HTMLImageElement;
  /** dibuja el cursor del juego en (x, y) */
  cursor?: (ctx: CanvasRenderingContext2D, x: number, y: number) => void;
}

interface Mission {
  scn: string;
  title: string;
  place: string;
  base: string;
}

interface MapInfo {
  scn: string;
  title: string;
  players: number;
  terrain: string;
}

const AREA = { x: 112, y: 92, w: 404, h: 270 };

export class MenuScreen {
  private items: Item[] = [];
  private title = '';
  private sel = 0;
  private scroll = 0;
  private maps: MapInfo[] = [];
  private mapIdx = 0;
  private race = HUMAN;
  private money = 10000;
  private aiCount = 1;
  private briefing: string[] | null = null;
  private ency: { name: string; frames: { c: HTMLCanvasElement; x: number; y: number }[]; text: string[]; t0: number } | null = null;
  private audio: HTMLAudioElement | null = null;
  private mx = -10;
  private my = -10;
  private pendingSetup: GameSetup | null = null;
  onStart?: (s: GameSetup) => void;
  /** cargar la partida guardada (si existe) */
  onLoad?: () => void;
  hasSave?: () => boolean;
  /** sólo con datos elegidos en el navegador: olvidarlos y volver a pedirlos */
  onForgetData?: () => void;

  constructor(private ctx: CanvasRenderingContext2D, private a: MenuAssets) {
    this.main();
  }

  /** Vuelve al menú principal (p. ej. tras configurar los callbacks). */
  reset(): void {
    this.main();
  }

  private main(): void {
    this.title = 'OPEN DARK COLONY';
    this.briefing = null;
    this.sel = 0;
    this.scroll = 0;
    this.items = [
      { label: 'Escaramuza', action: () => void this.skirmish() },
      ...(this.hasSave?.() ? [{ label: 'Cargar partida guardada', action: () => this.onLoad?.() }] : []),
      { label: 'Campaña humana (Pan Luma)', action: () => void this.campaign('human') },
      { label: 'Campaña Taar (alienígenas)', action: () => void this.campaign('alien') },
      { label: 'Enciclopedia', action: () => void this.encyclopedia() },
      { label: 'Controles', action: () => this.help() },
      ...(this.onForgetData ? [{ label: 'Cambiar datos del juego', action: () => this.onForgetData?.() }] : []),
    ];
  }

  /** Enciclopedia del original: intrface/encyclo.txt -> encyclo/<x>.spr (giro 3D), .txt y .wav */
  private async encyclopedia(): Promise<void> {
    const lines = (await fetchText('intrface/encyclo.txt')).split(/\r?\n/).map((l) => l.trim());
    const entries: { name: string; path: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^encyclo\//i.test(lines[i])) entries.push({ name: lines[i - 1].replace(/\s*:\s*$/, ''), path: lines[i].toLowerCase() });
    }
    this.title = 'ENCICLOPEDIA';
    this.briefing = null;
    this.ency = null;
    this.sel = 0;
    this.scroll = 0;
    this.items = entries.map((e) => ({ label: e.name, action: () => void this.showEntry(e.name, e.path) }));
    this.items.push({ label: 'Volver', action: () => this.main() });
  }

  private async showEntry(name: string, path: string): Promise<void> {
    try {
      const [buf, txt] = await Promise.all([fetchBin(path + '.spr'), fetchText(path + '.txt')]);
      const spr = parseSpr(name, buf);
      const pal = new Palette(spr.palette).rgba;
      const frames = spr.frames.map((f) => ({ c: frameToCanvas(f, pal), x: f.x, y: f.y }));
      this.ency = { name, frames, text: txt.split(/\r?\n/).map((l) => l.replace(/~\d/g, '').trimEnd()), t0: performance.now() };
      this.audio?.pause();
      this.audio = null;
      try {
        this.audio = new Audio(fileUrl(path + '.wav'));
        void this.audio.play().catch(() => undefined);
      } catch {
        /* entrada sin narración */
      }
    } catch {
      return;
    }
    const back = this.items;
    this.items = [{ label: 'Volver', action: () => { this.ency = null; this.audio?.pause(); this.items = back; } }];
    this.sel = 0;
  }

  private help(): void {
    this.title = 'CONTROLES';
    this.briefing = [
      'Clic izquierdo: seleccionar / mover / atacar',
      'Arrastrar: selección múltiple',
      'Clic derecho: ordenar (mover, atacar, extraer)',
      'Doble clic o Ctrl+clic: todas las del mismo tipo',
      'Ctrl+1..9 crear grupo, 1..9 seleccionar grupo',
      'A: modo mover y atacar   S: alto   D: desplegar',
      'Flechas o bordes: desplazar   H: ir a la ciudad',
      'Espacio: centrar selección   P: pausa   +/-: velocidad',
      'M: sonido   Mayús+clic derecho: puntos de ruta',
      'Panel derecho: 1 construir, 2 investigar, 3 opciones',
      'Clic derecho en un botón de producción: cancelar',
      '',
      'Envía Exploiters/Brozaars a los respiraderos de',
      'Petra-7 para obtener dinero.',
    ];
    this.items = [{ label: 'Volver', action: () => this.main() }];
    this.sel = 0;
  }

  private async skirmish(): Promise<void> {
    if (!this.maps.length) {
      const files = (await listDir('scenario/mplayer')).filter((f) => /\.scn$/i.test(f)).sort();
      const infos = await Promise.all(
        files.map(async (f) => {
          try {
            const scn = parseScn(await fetchText('scenario/mplayer/' + f));
            const players = scn.teams.filter((t) => t.active && (t.slots[0][0] || t.slots[0][1])).length;
            return { scn: 'scenario/mplayer/' + f.toLowerCase(), title: scn.title, players, terrain: scn.tileset.replace('.bts', '') };
          } catch {
            return null;
          }
        }),
      );
      this.maps = infos.filter((x): x is MapInfo => !!x && x.players >= 2);
    }
    this.title = 'ESCARAMUZA';
    this.briefing = null;
    this.refreshSkirmish();
    this.sel = 0;
  }

  private refreshSkirmish(): void {
    const m = this.maps[this.mapIdx];
    const terrains: Record<string, string> = { desert: 'Desierto', jungle: 'Jungla', atlantis: 'Atlantis', htrain: 'Entrenamiento' };
    this.items = [
      {
        label: 'Mapa',
        value: m ? `${m.title} (${m.players}J, ${terrains[m.terrain] ?? m.terrain})` : '—',
        action: () => {
          this.mapIdx = (this.mapIdx + 1) % Math.max(1, this.maps.length);
          this.refreshSkirmish();
        },
      },
      {
        label: 'Bando',
        value: this.race === HUMAN ? 'Humanos' : 'Taar',
        action: () => {
          this.race = this.race === HUMAN ? ALIEN : HUMAN;
          this.refreshSkirmish();
        },
      },
      {
        label: 'Rivales IA',
        value: String(Math.min(this.aiCount, Math.max(1, (m?.players ?? 2) - 1))),
        action: () => {
          const max = Math.max(1, (m?.players ?? 2) - 1);
          this.aiCount = (this.aiCount % max) + 1;
          this.refreshSkirmish();
        },
      },
      {
        label: 'Dinero inicial',
        value: String(this.money),
        action: () => {
          const opts = [5000, 10000, 15000, 25000];
          this.money = opts[(opts.indexOf(this.money) + 1) % opts.length];
          this.refreshSkirmish();
        },
      },
      { label: '>> COMENZAR <<', action: () => this.startSkirmish() },
      { label: 'Volver', action: () => this.main() },
    ];
  }

  private startSkirmish(): void {
    const m = this.maps[this.mapIdx];
    if (!m) return;
    const races: number[] = [];
    const n = Math.min(this.aiCount, m.players - 1);
    races[0] = this.race;
    for (let i = 1; i <= 7; i++) races[i] = i <= n ? (i % 2 === 1 ? 1 - this.race : this.race) : -9;
    this.onStart?.({ scn: m.scn, mode: 'skirmish', playerRace: this.race, races, startMoney: this.money, colours: [1, 2, 4, 3, 5, 6, 0, 7] });
  }

  private async campaign(kind: 'human' | 'alien'): Promise<void> {
    const txt = await fetchText(kind === 'human' ? 'gamestat/hscene.txt' : 'gamestat/gscene.txt');
    const lines = txt.split(/\r?\n/).map((l) => l.trim());
    const missions: Mission[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/\.scn$/i.test(lines[i])) missions.push({ scn: 'scenario/' + lines[i].toLowerCase(), title: lines[i + 1], place: lines[i + 2], base: lines[i + 3] });
    }
    this.title = kind === 'human' ? 'CAMPAÑA HUMANA' : 'CAMPAÑA TAAR';
    this.briefing = null;
    this.sel = 0;
    this.scroll = 0;
    this.items = missions.map((m, i) => ({
      label: `${i + 1}. ${m.title}`,
      value: m.place,
      action: () => void this.brief(m, kind),
    }));
    this.items.push({ label: 'Volver', action: () => this.main() });
  }

  private async brief(m: Mission, kind: 'human' | 'alien'): Promise<void> {
    let text = '';
    try {
      text = await fetchText(m.base + '.txt');
    } catch {
      text = '';
    }
    this.title = m.title;
    this.briefing = wrap(text.replace(/~\d/g, ''), 62);
    this.pendingSetup = { scn: m.scn, mode: 'campaign', playerRace: kind === 'human' ? HUMAN : ALIEN, startMoney: 0 };
    this.items = [
      { label: '>> COMENZAR MISIÓN <<', action: () => this.pendingSetup && this.onStart?.(this.pendingSetup) },
      { label: 'Volver', action: () => void this.campaign(kind) },
    ];
    this.sel = 0;
  }

  private layout(): void {
    if (this.ency) return;
    const top = this.briefing ? AREA.y + 34 + Math.min(14, this.briefing.length) * 12 + 10 : AREA.y + 36;
    const visible = Math.floor((AREA.y + AREA.h - top) / 16);
    if (this.sel < this.scroll) this.scroll = this.sel;
    if (this.sel >= this.scroll + visible) this.scroll = this.sel - visible + 1;
    this.items.forEach((it, i) => {
      const row = i - this.scroll;
      it.y = row >= 0 && row < visible ? top + row * 16 : undefined;
    });
  }

  draw(): void {
    const ctx = this.ctx;
    if (this.ency) return this.drawEntry();
    ctx.drawImage(this.briefing ? this.a.story : this.a.loader, 0, 0);
    if (this.briefing) {
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(AREA.x - 10, AREA.y - 6, AREA.w + 20, AREA.h + 14);
    }
    this.layout();
    this.a.fontBig.draw(ctx, this.title, AREA.x + AREA.w / 2, AREA.y, 'center');
    if (this.briefing) {
      let y = AREA.y + 34;
      for (const l of this.briefing.slice(0, 14)) {
        this.a.font.draw(ctx, l, AREA.x, y);
        y += 12;
      }
    }
    this.items.forEach((it, i) => {
      if (it.y === undefined) return;
      const f = i === this.sel ? this.a.fontHi : this.a.font;
      f.draw(ctx, (i === this.sel ? '> ' : '  ') + it.label, AREA.x, it.y);
      if (it.value) f.draw(ctx, it.value, AREA.x + AREA.w, it.y, 'right');
    });
    this.a.font.draw(ctx, 'Clon de Dark Colony (SSI, 1997) que usa los datos originales', 320, 466, 'center');
    this.a.cursor?.(ctx, this.mx, this.my);
  }

  private drawEntry(): void {
    const ctx = this.ctx;
    const e = this.ency!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 640, 480);
    if (this.a.ency) ctx.drawImage(this.a.ency, 0, 0);
    // pantalla superior derecha de ency.gif: frames 1..n del .spr (el 0 es el croma verde)
    const ox = 310, oy = 12;
    const n = e.frames.length - 1;
    if (n > 0) {
      const f = e.frames[1 + (Math.floor((performance.now() - e.t0) / 90) % n)];
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, 320, 200);
      ctx.clip();
      ctx.drawImage(f.c, ox + f.x, oy + f.y);
      ctx.restore();
    }
    this.a.fontBig.draw(ctx, e.name.toUpperCase(), 153, 28, 'center');
    let y = 110;
    for (const l of e.text) {
      if (y > 456) break;
      if (!l) {
        y += 6;
        continue;
      }
      for (const part of wrap(l, 38)) {
        this.a.font.draw(ctx, part, 24, y);
        y += 11;
      }
    }
    this.items.forEach((it, i) => {
      it.y = 452;
      this.a.fontHi.draw(ctx, (i === this.sel ? '> ' : '  ') + it.label, 330, 452);
    });
    this.a.cursor?.(ctx, this.mx, this.my);
  }

  private hit(x: number, y: number): number {
    if (this.ency) return y >= 440 && x >= 310 && x < 450 ? 0 : -1;
    return this.items.findIndex((it) => it.y !== undefined && y >= it.y - 2 && y < it.y + 14 && x >= AREA.x - 10 && x < AREA.x + AREA.w + 10);
  }

  mouseMove(x: number, y: number): void {
    this.mx = x;
    this.my = y;
    const i = this.hit(x, y);
    if (i >= 0) this.sel = i;
  }

  mouseDown(x: number, y: number): void {
    const i = this.hit(x, y);
    if (i >= 0) this.items[i].action();
  }

  wheel(dy: number): void {
    this.sel = Math.max(0, Math.min(this.items.length - 1, this.sel + Math.sign(dy)));
  }

  keyDown(key: string): void {
    if (key === 'ArrowDown') this.sel = (this.sel + 1) % this.items.length;
    else if (key === 'ArrowUp') this.sel = (this.sel - 1 + this.items.length) % this.items.length;
    else if (key === 'Enter' || key === ' ') this.items[this.sel]?.action();
    else if (key === 'Escape') this.main();
  }
}

function wrap(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if ((line + ' ' + word).trim().length > cols) {
        out.push(line.trim());
        line = word;
      } else line += ' ' + word;
    }
    out.push(line.trim());
  }
  return out;
}
