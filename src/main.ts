// Arranque: carga de datos originales, menús y bucle principal.
import { fetchBin, fetchImage, fetchText } from './data/vfs';
import { parseSpr } from './data/spr';
import { AnimDB } from './render/anims';
import { SpriteCache } from './render/gfx';
import { Rules } from './game/rules';
import { loadGame, type GameSetup } from './game/scenario';
import { parseLayout } from './ui/layout';
import { BitmapFont } from './ui/font';
import { GameScreen, type UiAssets } from './ui/game-screen';
import { MenuScreen, type MenuAssets } from './ui/menu';
import { SoundSystem } from './audio/sound';
import { loadFromStorage, restore } from './game/save';
import type { LoadedGame } from './game/scenario';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;
ctx.imageSmoothingEnabled = false;

interface Screen {
  draw(): void;
  update?(dt: number): void;
  mouseMove?(x: number, y: number): void;
  mouseDown?(x: number, y: number, b: number, shift: boolean): void;
  mouseUp?(x: number, y: number, b: number, shift: boolean, ctrl: boolean): void;
  keyDown?(key: string, code: string, ctrl: boolean, shift: boolean): void;
  keyUp?(key: string): void;
  wheel?(dy: number): void;
}

let screen: Screen | null = null;
let sound: SoundSystem | null = null;

function fit(): void {
  const s = Math.max(1, Math.min(window.innerWidth / 640, window.innerHeight / 480));
  const k = s >= 2 ? Math.floor(s) : s;
  canvas.style.width = `${640 * k}px`;
  canvas.style.height = `${480 * k}px`;
}
window.addEventListener('resize', fit);
fit();

function loading(intro: HTMLImageElement | null, text: string, f: number): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 640, 480);
  if (intro) ctx.drawImage(intro, 0, 0);
  ctx.fillStyle = '#300';
  ctx.fillRect(170, 440, 300, 8);
  ctx.fillStyle = '#e44';
  ctx.fillRect(170, 440, 300 * f, 8);
  ctx.fillStyle = '#ccc';
  ctx.font = '12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(text, 320, 432);
}

function toCanvas(ev: MouseEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [Math.floor(((ev.clientX - r.left) / r.width) * 640), Math.floor(((ev.clientY - r.top) / r.height) * 480)];
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousemove', (e) => {
  if (screen && 'hasMouse' in screen) (screen as { hasMouse: boolean }).hasMouse = true;
  screen?.mouseMove?.(...toCanvas(e));
});
canvas.addEventListener('mouseleave', () => {
  if (screen && 'hasMouse' in screen) (screen as { hasMouse: boolean }).hasMouse = false;
});
canvas.addEventListener('mousedown', (e) => {
  sound?.unlock();
  const [x, y] = toCanvas(e);
  screen?.mouseDown?.(x, y, e.button, e.shiftKey);
});
window.addEventListener('mouseup', (e) => {
  const [x, y] = toCanvas(e);
  screen?.mouseUp?.(x, y, e.button, e.shiftKey, e.ctrlKey);
});
canvas.addEventListener('wheel', (e) => {
  screen?.wheel?.(e.deltaY);
  e.preventDefault();
});
window.addEventListener('keydown', (e) => {
  sound?.unlock();
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'F9', 'F10'].includes(e.key) || (e.ctrlKey && /^Digit/.test(e.code))) e.preventDefault();
  screen?.keyDown?.(e.key, e.code, e.ctrlKey, e.shiftKey);
});
window.addEventListener('keyup', (e) => screen?.keyUp?.(e.key));

async function boot(): Promise<void> {
  let intro: HTMLImageElement | null = null;
  try {
    intro = await fetchImage('intrface/intro.gif');
  } catch {
    loading(null, 'No se encuentran los datos de Dark Colony (configura DC_DATA)', 0);
    return;
  }
  loading(intro, 'Cargando reglas...', 0.02);
  const rules = await Rules.load();
  const anims = new AnimDB();
  await anims.load((d, t) => loading(intro, 'Cargando animaciones y sprites...', 0.05 + 0.85 * (d / t)));
  loading(intro, 'Cargando interfaz...', 0.92);
  const [layoutTxt, mainbutBuf, f7, f2, bg, loader, story, unitIdTxt, ency] = await Promise.all([
    fetchText('intrface/maine'),
    fetchBin('intrface/mainbut.spr'),
    fetchBin('intrface/mfonto7.spr'),
    fetchBin('intrface/mfonto2.spr'),
    fetchImage('intrface/intrface.gif'),
    fetchImage('intrface/loader.gif'),
    fetchImage('intrface/story.gif'),
    fetchText('gamestat/unitid.txt'),
    fetchImage('intrface/ency.gif'),
  ]);
  const layout = parseLayout(layoutTxt);
  const fontSpr = parseSpr('mfonto7', f7);
  const font = new BitmapFont(fontSpr, 31);
  const fontHi = new BitmapFont(fontSpr, 31, [255, 220, 120]);
  const fontBig = new BitmapFont(parseSpr('mfonto2', f2), 31);
  // nombres de unidades: UNITID.TXT (tipo -> textmsg) y, si falta, el texto del botón de producción
  const unitNames = new Map<number, string>();
  for (const l of unitIdTxt.split(/\r?\n/)) {
    const v = l.trim().split(/\s+/).map(Number);
    if (v.length >= 4 && v[2] >= 0 && !unitNames.has(v[2])) {
      const t = layout.text.get(v[3]);
      if (t) unitNames.set(v[2], t);
    }
  }
  for (const d of rules.depend) {
    if (d.kind !== 1 || unitNames.has(d.target)) continue;
    const t = layout.text.get(d.msg);
    if (t) unitNames.set(d.target, t.replace(/\s+\d+$/, '').trim());
  }
  try {
    sound = await SoundSystem.load();
  } catch (err) {
    console.warn('sonido no disponible', err);
  }
  const ui: UiAssets = { layout, mainbut: parseSpr('mainbut', mainbutBuf), background: bg, font, fontHi, anims, unitNames };
  const cursorCache = new SpriteCache(null);
  const cursor = (c: CanvasRenderingContext2D, x: number, y: number) => {
    const ref = anims.get('DEFAULT');
    const fr = ref && anims.frame(ref, Math.floor(performance.now() / 120) % anims.frameCount(ref));
    if (!fr) return;
    for (const p of fr.parts) {
      const spr = anims.sprs.get(p.juice);
      const f = spr?.frames[p.sprite];
      const cv = spr && cursorCache.get(spr, p.sprite, 0, p.flip);
      if (f && cv) c.drawImage(cv, x + p.dx + (p.flip ? 0 : f.x), y + p.dy - f.h);
    }
  };
  const menuAssets: MenuAssets = { loader, story, font, fontHi, fontBig, cursor, ency };

  const showMenu = () => {
    const m = new MenuScreen(ctx, menuAssets);
    m.onStart = (setup) => void start(setup);
    m.hasSave = () => loadFromStorage() !== null;
    m.onLoad = () => {
      const data = loadFromStorage();
      if (data) void start(data.setup, () => restore(data, rules, anims));
    };
    m.reset();
    screen = m;
  };
  const start = async (setup: GameSetup, load?: () => Promise<LoadedGame>) => {
    loading(intro, 'Cargando escenario...', 0.5);
    screen = null;
    try {
      const game = load ? await load() : await loadGame(setup, rules, anims);
      const gs = new GameScreen(ctx, ui, game, sound ?? undefined);
      gs.onQuit = showMenu;
      screen = gs;
      (window as unknown as { game: GameScreen }).game = gs;
    } catch (err) {
      console.error(err);
      showMenu();
    }
  };
  showMenu();
  const params = new URLSearchParams(location.search);
  const quick = params.get('map');
  if (quick) void start({ scn: quick, mode: params.get('mode') === 'campaign' ? 'campaign' : 'skirmish', playerRace: Number(params.get('race') ?? 0), startMoney: 10000, colours: [1, 2, 4, 3, 5, 6, 0, 7] });

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(100, now - last);
    last = now;
    if (screen) {
      screen.update?.(dt);
      screen.draw();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void boot();
