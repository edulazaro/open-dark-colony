// Sistema de sonido dirigido por los datos originales (SOUND/*.DAT, *.AMB).
// Obtenido desensamblando sound.c de DC.EXE (Watcom, x86); direcciones entre corchetes.
//
// SOUND2.DAT  `id ruta a b c d` (sscanf "%s %s %s %s %s %s", termina en '*', 200 huecos) [0x42d91c]
//   a = nº de buffers DirectSound (1 + DuplicateSoundBuffer) = máx. instancias simultáneas del id;
//       si todos están sonando, la petición se descarta [0x42dea8].
//   b = siempre 1; el motor lo guarda pero nunca lo lee.
//   c = volumen DirectSound en centésimas de dB (0 = máximo, -600 = -6 dB). Solo se aplica cuando se
//       reproduce sin posición (el motor pasa "volumen 1" = usar el de la tabla); en la reproducción
//       posicional el volumen es la atenuación por distancia y `c` se ignora (peculiaridad original).
//   d = 1 → DSBPLAY_LOOPING (DROPLP, NAPALM, ARTDIG, HUM, DROPLPG); hay que pararlo explícitamente.
//
// SLIST.DAT  `objeto CAT ids... -1 [prioridad]` (200 objetos × 8 categorías × máx. 10 ids) [0x42e2d0]
//   Categorías en el orden del motor: GUN ACK SEL DEA AMB DPY EXP XTR ("unknown sound category %s").
//   El índice "objeto" depende de la categoría:
//     GUN = disparo; índice = columna `sound` (4º token) de WEAPSTAT.TXT, NO un id de SOUND2.
//     ACK = confirmación de orden, SEL = selección (índice = tipo de unidad de GAMESTAT). Solo estas dos
//           llevan una prioridad tras el -1 (menor = más importante). No suenan al momento: se encolan y
//           en cada tick suena solo la de mejor prioridad de cada categoría, sin posición y a 0 dB
//           [0x42ef5c, 0x42f0e0]. Así, al seleccionar un grupo habla la unidad más importante.
//     DEA = muerte, DPY = despliegue/acción especial (tipo de unidad).
//     EXP = explosión; índice = tipo de BOOMSTAT.TXT (9º token de WEAPSTAT, `shots` en stats.ts).
//     AMB = sonido propio de un objeto (solo 98 y 99). XTR = eventos varios (1 ERUPT, 2 WATER,
//           3/4 CAPTURE; 5..11 son relleno con SYTH1WEA).
//   Al sonar se usa ids[cursor] y luego cursor = rand() % n (en ACK/SEL se fuerza que cambie).
//
// WEAPSTAT.TXT: la columna `sound` indexa la categoría GUN de SLIST. Comprobado con los datos:
//   arma 10 (BARR, artillería) sound 10 → GUN 10 → [7] BARRWEA.WAV, mientras que SOUND2[10] es GCSEL.WAV;
//   arma 7 (mech) → GUN 7 → MECHWEA/MECHWEA2/MECHWEA3; 13 ("Sniper", en realidad el ciborg) → CYWEA;
//   15..17 (gris) → GRAY1..3WEA; 21..23 → SYTH1/2WEA; 24..26 → ATRILWEA; 48 → RNATWEA; 49 → SPIDWEA;
//   53 → BATWEA. Las armas 27/28 usan sound 40, 40..42 usan 34..36, 44/45 usan 42/43 (compartidos).
//
// Ambiente: sound/<terreno>.amb (el nombre sale del fichero de terreno del mapa sin extensión:
//   atlantis, desert, htrain, jungle, special). Líneas `tod tipoBloque ids... -1` con tod 0 = día,
//   1 = noche, tipo de bloque 0..32, máx. 10 ids [0x42e687]. Cada 5 s y cada 7 s (dos temporizadores
//   con timeGetTime) suena un id de la lista del tipo de bloque dominante en la vista, sin posición y
//   con el volumen `c` de SOUND2 [0x42ee98, 0x42ee28]. Ninguna lista .AMB contiene sonidos en bucle.
//
// Ficheros que el ejecutable NO lee: ALIST.DAT (formato antiguo `set tod btype looped ids -1`, su
//   columna looped siempre es 0), SCENESND.DAT y DESERT/JUNGLE/ATLANTIS/ATRAIN/HTRAIN.DAT (todos con
//   SYTH1WEA/SYTH2WEA de relleno). NEWSND.DAT (`id ruta volumen`, termina en '*') sí se usa: son los
//   sonidos de los menús (ssound.c), cargado como "sound/newsnd" desde el interfaz.
//
// Posición: el motor mide en teselas (32 px) desde el centro de la cámara: volumen = -(dx²+dy²)/2
//   centésimas de dB, y no suena por debajo de -8000; el panorama es ±ese mismo valor (casi
//   inapreciable en pantalla) y además solo suena si la tesela es visible (niebla, lo decide quien
//   llama). Aquí se conserva esa atenuación, se añade un fundido fuera de la vista (silencio a
//   `offscreenMargin` vistas del borde) y un panorama lineal según el desplazamiento horizontal.
import { dataLines, fetchBin, fetchText } from '../data/vfs';

export type SoundCategory = string;

/** Categorías que reconoce el motor, en su orden interno (0..7). */
export const SOUND_CATEGORIES = ['GUN', 'ACK', 'SEL', 'DEA', 'AMB', 'DPY', 'EXP', 'XTR'] as const;

/** NUM_SOUND_OBJECTS / SOUNDS_PER_CATEGORY / prioridad "sin pendiente" del motor. */
export const MAX_SOUND_OBJECTS = 200;
export const MAX_SOUNDS_PER_LIST = 10;
export const NO_PRIORITY = 200;
/** Por debajo de este volumen (centésimas de dB) el motor no reproduce. */
export const MIN_VOLUME_CB = -8000;
export const TILE_PX = 32;

export interface Sound2Entry {
  id: number;
  /** ruta normalizada, p. ej. 'sound/barrwea.wav' */
  path: string;
  /** máx. instancias simultáneas (buffers DirectSound) */
  buffers: number;
  /** columna sin uso (siempre 1) */
  flag: number;
  /** volumen en centésimas de dB (0 = máximo) */
  volume: number;
  loop: boolean;
}

export interface SlistEntry {
  ids: number[];
  /** solo ACK/SEL (menor = más importante); NO_PRIORITY en el resto */
  priority: number;
}

/** objeto → categoría → lista */
export type SlistTable = Map<number, Map<SoundCategory, SlistEntry>>;

/** [día, noche]: tipo de bloque → ids de SOUND2 */
export type AmbientTable = [Map<number, number[]>, Map<number, number[]>];

export interface SoundSetEntry {
  id: number;
  path: string;
  volume: number;
}

export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  frames: number;
  /** muestras por canal en -1..1 */
  samples: Float32Array[];
}

export interface ListenerView {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LoopHandle {
  setPosition(x: number, y: number): void;
  stop(): void;
  readonly active: boolean;
}

// ---------------------------------------------------------------- parsers puros

/** '.\SOUND\UNIT.WAV' → 'sound/unit.wav' */
export function normalizeSoundPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function int(tok: string | undefined, def: number): number {
  const v = parseInt(tok ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

/** Lee ids hasta -1 (o fin de línea); devuelve los ids y el índice del token tras el -1. */
function readIdList(t: string[], from: number): { ids: number[]; next: number } {
  const ids: number[] = [];
  let i = from;
  for (; i < t.length; i++) {
    const v = parseInt(t[i], 10);
    if (!Number.isFinite(v)) break;
    if (v === -1) {
      i++;
      break;
    }
    if (ids.length < MAX_SOUNDS_PER_LIST) ids.push(v);
  }
  return { ids, next: i };
}

export function parseSound2(text: string): Map<number, Sound2Entry> {
  const m = new Map<number, Sound2Entry>();
  for (const line of dataLines(text)) {
    const t = line.split(/\s+/);
    if (t[0] === '*') break;
    if (t.length < 2) continue;
    const id = int(t[0], -1);
    if (id < 0 || id >= MAX_SOUND_OBJECTS) continue;
    m.set(id, {
      id,
      path: normalizeSoundPath(t[1]),
      buffers: Math.max(1, int(t[2], 1)),
      flag: int(t[3], 1),
      volume: int(t[4], 0),
      loop: int(t[5], 0) === 1,
    });
  }
  return m;
}

export function parseSlist(text: string): SlistTable {
  const table: SlistTable = new Map();
  const known = new Set<string>(SOUND_CATEGORIES);
  for (const line of dataLines(text)) {
    if (line.length < 3) continue;
    const t = line.split(/\s+/);
    if (t.length < 2) continue;
    const obj = int(t[0], -1);
    const cat = t[1].toUpperCase();
    if (obj < 0 || obj >= MAX_SOUND_OBJECTS || !known.has(cat)) continue; // el motor aborta aquí
    const { ids, next } = readIdList(t, 2);
    const priority = cat === 'ACK' || cat === 'SEL' ? int(t[next], 0) : NO_PRIORITY;
    let cats = table.get(obj);
    if (!cats) table.set(obj, (cats = new Map()));
    cats.set(cat, { ids, priority }); // una línea repetida sustituye a la anterior
  }
  return table;
}

/** Formato .AMB: `tod tipoBloque ids... -1`. */
export function parseAmbient(text: string): AmbientTable {
  const table: AmbientTable = [new Map(), new Map()];
  for (const line of dataLines(text)) {
    if (line.length < 3) continue;
    const t = line.split(/\s+/);
    const tod = int(t[0], -1);
    const block = int(t[1], -1);
    if ((tod !== 0 && tod !== 1) || block < 0 || block > 32) continue;
    table[tod].set(block, readIdList(t, 2).ids);
  }
  return table;
}

/** Conjuntos de ssound.c (NEWSND.DAT): `id ruta volumen`, termina en '*'. */
export function parseSoundSet(text: string): Map<number, SoundSetEntry> {
  const m = new Map<number, SoundSetEntry>();
  for (const line of dataLines(text)) {
    const t = line.split(/\s+/);
    if (t[0] === '*') break;
    if (t.length < 2) continue;
    const id = int(t[0], -1);
    if (id < 0) continue;
    m.set(id, { id, path: normalizeSoundPath(t[1]), volume: int(t[2], 0) });
  }
  return m;
}

/** WAV PCM 8/16 bits. Tolera tamaños impares sin byte de relleno y chunks finales corruptos. */
export function parseWav(buf: ArrayBuffer): WavData | null {
  const dv = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let p = 12;
  while (p + 8 <= buf.byteLength) {
    const id = tag(p);
    const size = dv.getUint32(p + 4, true);
    if (id === 'fmt ' && p + 24 <= buf.byteLength) {
      fmt = {
        format: dv.getUint16(p + 8, true),
        channels: dv.getUint16(p + 10, true),
        rate: dv.getUint32(p + 12, true),
        bits: dv.getUint16(p + 22, true),
      };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels < 1 || (fmt.bits !== 8 && fmt.bits !== 16)) return null;
      const bytes = fmt.bits / 8;
      const len = Math.min(size, buf.byteLength - (p + 8));
      const frames = Math.floor(len / (bytes * fmt.channels));
      const samples: Float32Array[] = [];
      for (let c = 0; c < fmt.channels; c++) samples.push(new Float32Array(frames));
      let o = p + 8;
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < fmt.channels; c++, o += bytes) {
          samples[c][f] = bytes === 1 ? (dv.getUint8(o) - 128) / 128 : dv.getInt16(o, true) / 32768;
        }
      }
      return { sampleRate: fmt.rate, channels: fmt.channels, bitsPerSample: fmt.bits, frames, samples };
    }
    p += 8 + size + (size & 1);
  }
  return null;
}

/** Volumen DirectSound (centésimas de dB) → ganancia lineal. */
export function dsVolumeToGain(cb: number): number {
  return cb >= 0 ? 1 : Math.pow(10, cb / 2000);
}

/**
 * Ganancia y panorama (-1..1) de un sonido en (x, y) píxeles de mundo para una cámara centrada en
 * `l` (tamaño de la vista en l.w × l.h). gain 0 = no suena.
 */
export function spatialize(x: number, y: number, l: ListenerView, margin = 0.5, maxPan = 0.75): { gain: number; pan: number } {
  const dx = x - l.x;
  const dy = y - l.y;
  const tx = dx / TILE_PX;
  const ty = dy / TILE_PX;
  const cb = -(tx * tx + ty * ty) / 2; // fórmula original, en teselas
  if (!(cb >= MIN_VOLUME_CB)) return { gain: 0, pan: 0 };
  const hw = Math.max(0, l.w) / 2;
  const hh = Math.max(0, l.h) / 2;
  const ex = hw > 0 ? Math.max(0, Math.abs(dx) - hw) / Math.max(1, margin * l.w) : 0;
  const ey = hh > 0 ? Math.max(0, Math.abs(dy) - hh) / Math.max(1, margin * l.h) : 0;
  const fade = 1 - Math.max(ex, ey);
  if (fade <= 0) return { gain: 0, pan: 0 };
  const pan = hw > 0 ? Math.max(-1, Math.min(1, dx / hw)) * maxPan : 0;
  return { gain: dsVolumeToGain(cb) * fade, pan };
}

// ---------------------------------------------------------------- reproducción

interface SoundDef {
  key: string;
  path: string;
  buffers: number;
  volume: number;
}

interface Voice {
  key: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode | null;
  loop: boolean;
}

interface LoopState {
  def: SoundDef;
  x?: number;
  y?: number;
  scale: number;
  voice: Voice | null;
  loading: boolean;
  stopped: boolean;
}

type VoiceCat = 'ACK' | 'SEL';

/** Segundos tras los que un sonido que aún se estaba decodificando ya no merece sonar. */
const LATE_LIMIT = 0.3;
/** Ganancia relativa de los bucles de ambiente. */
const AMBIENT_LOOP_GAIN = 0.35;
/** Temporizadores de ambiente del motor (ms 5000 y 7000). */
const AMB_PERIOD_A = 5;
const AMB_PERIOD_B = 7;

function def2(e: Sound2Entry): SoundDef {
  return { key: String(e.id), path: e.path, buffers: e.buffers, volume: e.volume };
}

export class SoundSystem {
  /** fundido fuera de pantalla: silencio a `offscreenMargin` × tamaño de vista del borde */
  offscreenMargin = 0.5;
  maxVoices = 16;
  /** se ignora una repetición del mismo id antes de este tiempo (s) */
  repeatGuard = 0.06;
  ambientVolume = 1;
  rand: () => number = Math.random;

  private _volume = 0.8;
  private _muted = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bufferByPath = new Map<string, AudioBuffer>();
  private loadingByPath = new Map<string, Promise<AudioBuffer | null>>();
  private voices: Voice[] = [];
  private lastStart = new Map<string, number>();
  private cursors = new Map<string, number>();
  private pending: Record<VoiceCat, { id: number; priority: number } | null> = { ACK: null, SEL: null };
  private listener: ListenerView | null = null;
  private loops = new Set<LoopState>();
  // ambiente
  private ambTables = new Map<string, AmbientTable | null>();
  private ambLoading = new Map<string, Promise<void>>();
  private amb = { set: '', night: false, block: -1 };
  private ambKey = '';
  private ambList: number[] = [];
  private ambLoops = new Map<number, LoopHandle>();
  private ambTimerA = 0;
  private ambTimerB = 0;

  constructor(
    readonly sound2: Map<number, Sound2Entry> = new Map(),
    readonly slist: SlistTable = new Map(),
    readonly menuSounds: Map<number, SoundSetEntry> = new Map(),
  ) {}

  /** Lee SOUND2.DAT, SLIST.DAT y NEWSND.DAT (no decodifica audio). Nunca lanza. */
  static async load(): Promise<SoundSystem> {
    const get = (p: string) => fetchText(p).catch((e: unknown) => {
      console.warn('[sound] no se pudo leer', p, e);
      return '';
    });
    const [s2, sl, ns] = await Promise.all([get('sound/sound2.dat'), get('sound/slist.dat'), get('sound/newsnd.dat')]);
    return new SoundSystem(parseSound2(s2), parseSlist(sl), parseSoundSet(ns));
  }

  get volume(): number {
    return this._volume;
  }
  set volume(v: number) {
    this._volume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    this.applyMaster();
  }
  get muted(): boolean {
    return this._muted;
  }
  set muted(m: boolean) {
    this._muted = !!m;
    this.applyMaster();
  }

  /** Crea/reanuda el AudioContext; llamar en el primer gesto del usuario. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
        const Ctor = g.AudioContext ?? g.webkitAudioContext;
        if (!Ctor) return;
        const ctx = new Ctor();
        const master = ctx.createGain();
        master.connect(ctx.destination);
        this.ctx = ctx;
        this.master = master;
        this.applyMaster();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      for (const st of this.loops) this.startLoop(st);
    } catch {
      this.ctx = null;
      this.master = null;
    }
  }

  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** Decodifica por adelantado (todos los de SOUND2 si no se indican). Requiere unlock(). */
  async preload(ids?: Iterable<number>): Promise<void> {
    if (!this.ctx) return;
    const paths = new Set<string>();
    for (const id of ids ?? this.sound2.keys()) {
      const e = this.sound2.get(id);
      if (e) paths.add(e.path);
    }
    await Promise.all([...paths].map((p) => this.loadBuffer(p)));
  }

  /** Centro de la cámara y tamaño de la vista, en píxeles de mundo. */
  setListener(x: number, y: number, viewW: number, viewH: number): void {
    this.listener = { x, y, w: viewW, h: viewH };
    for (const st of this.loops) this.updateLoop(st);
  }

  playId(id: number, x?: number, y?: number): void {
    const e = this.sound2.get(id);
    if (!e || !this.ctx) return;
    const s = this.placement(x, y);
    if (!s) {
      this.trigger(def2(e), dsVolumeToGain(e.volume), 0);
    } else if (s.gain > 0) {
      this.trigger(def2(e), s.gain, s.pan);
    }
  }

  /** Sonido de SLIST. SEL/ACK se encolan por prioridad y suenan en el siguiente update(). */
  playUnit(unitType: number, category: SoundCategory, x?: number, y?: number): void {
    const cat = category.toUpperCase();
    if (cat === 'ACK' || cat === 'SEL') {
      this.queueVoice(unitType, cat);
      return;
    }
    const e = this.slist.get(unitType)?.get(cat);
    if (!e || e.ids.length === 0) return;
    const s = this.placement(x, y);
    if (s && s.gain <= 0) return; // fuera de alcance: el motor no avanza el cursor
    const id = this.pick(`${unitType}:${cat}`, e.ids);
    this.playId(id, x, y);
  }

  /** `weaponSound` = columna sound de WEAPSTAT.TXT (índice de la categoría GUN). */
  playWeapon(weaponSound: number, x: number, y: number): void {
    this.playUnit(weaponSound, 'GUN', x, y);
  }

  /** `boomType` = tipo de explosión de BOOMSTAT.TXT (9º token de WEAPSTAT). */
  playExplosion(boomType: number, x: number, y: number): void {
    this.playUnit(boomType, 'EXP', x, y);
  }

  /** Sonido de menú de NEWSND.DAT. */
  playMenu(id: number): void {
    const e = this.menuSounds.get(id);
    if (!e || !this.ctx) return;
    this.trigger({ key: 'menu:' + id, path: e.path, buffers: 1, volume: e.volume }, dsVolumeToGain(e.volume), 0);
  }

  /** Reproduce en bucle (sonidos con d = 1 en SOUND2: napalm, nave de descenso...). */
  playLoop(id: number, x?: number, y?: number, gainScale = 1): LoopHandle {
    const e = this.sound2.get(id);
    const st: LoopState = {
      def: e ? def2(e) : { key: '', path: '', buffers: 1, volume: 0 },
      x,
      y,
      scale: gainScale,
      voice: null,
      loading: false,
      stopped: !e,
    };
    if (e) {
      this.loops.add(st);
      this.startLoop(st);
    }
    return {
      setPosition: (nx: number, ny: number) => {
        st.x = nx;
        st.y = ny;
        this.updateLoop(st);
      },
      stop: () => {
        st.stopped = true;
        this.loops.delete(st);
        if (st.voice) this.stopVoice(st.voice);
        st.voice = null;
      },
      get active() {
        return !st.stopped;
      },
    };
  }

  /** Para todas las instancias de un id de SOUND2. */
  stopId(id: number): void {
    const key = String(id);
    for (const v of [...this.voices]) if (v.key === key) this.stopVoice(v);
  }

  stopAll(): void {
    for (const st of [...this.loops]) {
      st.stopped = true;
      this.loops.delete(st);
    }
    this.ambLoops.clear();
    this.ambKey = '';
    this.ambList = [];
    for (const v of [...this.voices]) this.stopVoice(v);
    this.pending.ACK = this.pending.SEL = null;
  }

  hasUnitSound(unitType: number, category: SoundCategory): boolean {
    return (this.slist.get(unitType)?.get(category.toUpperCase())?.ids.length ?? 0) > 0;
  }

  categories(): string[] {
    return [...SOUND_CATEGORIES];
  }

  /** Voces SEL/ACK pendientes (id de SOUND2) hasta el próximo update(). */
  pendingVoices(): { ACK?: number; SEL?: number } {
    const r: { ACK?: number; SEL?: number } = {};
    if (this.pending.ACK) r.ACK = this.pending.ACK.id;
    if (this.pending.SEL) r.SEL = this.pending.SEL.id;
    return r;
  }

  /** Inyecta una tabla de ambiente ya leída (evita la carga de sound/<set>.amb). */
  setAmbientTable(terrainSet: string, table: AmbientTable): void {
    this.ambTables.set(terrainSetName(terrainSet), table);
    if (this.amb.set === terrainSetName(terrainSet)) this.applyAmbient();
  }

  /**
   * Ambiente activo. `terrainSet` = 'desert', 'jungle'... (o el fichero de terreno, se quita la
   * extensión); `blockType` = tipo de bloque dominante en la vista (-1 = ninguno).
   */
  setAmbient(terrainSet: string, night: boolean, blockType: number): void {
    const set = terrainSetName(terrainSet);
    this.amb = { set, night, block: blockType };
    if (!this.ambTables.has(set) && !this.ambLoading.has(set)) {
      const p = fetchText(`sound/${set}.amb`)
        .then((t) => this.ambTables.set(set, parseAmbient(t)))
        .catch(() => this.ambTables.set(set, null))
        .then(() => {
          this.ambLoading.delete(set);
          if (this.amb.set === set) this.applyAmbient();
        });
      this.ambLoading.set(set, p);
    }
    this.applyAmbient();
  }

  /** Llamar cada frame: vuelca las voces SEL/ACK y programa el ambiente. */
  update(dtSeconds: number): void {
    this.flushVoices();
    if (!(dtSeconds > 0)) return;
    this.ambTimerA += dtSeconds;
    this.ambTimerB += dtSeconds;
    if (this.ambTimerA > AMB_PERIOD_A) {
      this.ambTimerA = 0;
      this.playAmbientOnce();
    } else if (this.ambTimerB > AMB_PERIOD_B) {
      this.ambTimerB = 0;
      this.playAmbientOnce();
    }
  }

  /** Reproduce la voz SEL y la ACK pendientes de mejor prioridad (sin posición, a 0 dB). */
  flushVoices(): void {
    for (const cat of ['SEL', 'ACK'] as const) {
      const p = this.pending[cat];
      if (!p) continue;
      this.pending[cat] = null;
      const e = this.sound2.get(p.id);
      if (e && this.ctx) this.trigger(def2(e), 1, 0);
    }
  }

  // ------------------------------------------------------------ interno

  private applyMaster(): void {
    if (this.master) this.master.gain.value = this._muted ? 0 : this._volume;
  }

  /** null = sin posición; si no, ganancia/panorama (gain 0 = inaudible). */
  private placement(x?: number, y?: number): { gain: number; pan: number } | null {
    if (x === undefined || y === undefined || !this.listener) return null;
    return spatialize(x, y, this.listener, this.offscreenMargin);
  }

  /** Usa ids[cursor] y elige un cursor nuevo al azar, como el motor. */
  private pick(key: string, ids: number[]): number {
    const c = Math.min(this.cursors.get(key) ?? 0, ids.length - 1);
    this.cursors.set(key, Math.floor(this.rand() * ids.length) % ids.length);
    return ids[c];
  }

  private queueVoice(unitType: number, cat: VoiceCat): void {
    const e = this.slist.get(unitType)?.get(cat);
    if (!e || e.ids.length === 0) return;
    const cur = this.pending[cat];
    if (cur && e.priority >= cur.priority) return;
    const key = `${unitType}:${cat}`;
    const old = Math.min(this.cursors.get(key) ?? 0, e.ids.length - 1);
    this.pending[cat] = { id: e.ids[old], priority: e.priority };
    let n = old;
    if (e.ids.length > 1) {
      for (let tries = 0; n === old && tries < 32; tries++) n = Math.floor(this.rand() * e.ids.length) % e.ids.length;
      if (n === old) n = (old + 1) % e.ids.length;
    } else n = 0;
    this.cursors.set(key, n);
  }

  private trigger(d: SoundDef, gain: number, pan: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const last = this.lastStart.get(d.key);
    if (last !== undefined && now - last < this.repeatGuard) return;
    let same = 0;
    for (const v of this.voices) if (v.key === d.key) same++;
    if (same >= d.buffers) return; // todos los "buffers" del id ocupados: el motor lo descarta
    this.lastStart.set(d.key, now);
    const buf = this.bufferByPath.get(d.path);
    if (buf) {
      this.startVoice(d.key, buf, gain, pan, false);
      return;
    }
    void this.loadBuffer(d.path).then((b) => {
      if (b && this.ctx && this.ctx.currentTime - now < LATE_LIMIT) this.startVoice(d.key, b, gain, pan, false);
    });
  }

  private loadBuffer(path: string): Promise<AudioBuffer | null> {
    const have = this.bufferByPath.get(path);
    if (have) return Promise.resolve(have);
    let p = this.loadingByPath.get(path);
    if (!p) {
      p = this.decode(path).then((b) => {
        if (b) this.bufferByPath.set(path, b);
        return b;
      });
      this.loadingByPath.set(path, p);
    }
    return p;
  }

  private async decode(path: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    try {
      const raw = await fetchBin(path);
      try {
        // copia: decodeAudioData desconecta el ArrayBuffer y vfs lo guarda en caché
        return await ctx.decodeAudioData(raw.slice(0));
      } catch {
        const w = parseWav(raw);
        if (!w || w.frames === 0) return null;
        const b = ctx.createBuffer(w.channels, w.frames, w.sampleRate);
        for (let c = 0; c < w.channels; c++) b.getChannelData(c).set(w.samples[c]);
        return b;
      }
    } catch {
      return null;
    }
  }

  private startVoice(key: string, buf: AudioBuffer, gain: number, pan: number, loop: boolean): Voice | null {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return null;
    if (this.voices.length >= this.maxVoices) {
      const victim = this.voices.find((v) => !v.loop); // la más antigua que no sea bucle
      if (!victim) return null;
      this.stopVoice(victim);
    }
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = loop;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g);
      let panner: StereoPannerNode | null = null;
      if (typeof ctx.createStereoPanner === 'function') {
        panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        g.connect(panner);
        panner.connect(master);
      } else {
        g.connect(master);
      }
      const v: Voice = { key, src, gain: g, panner, loop };
      src.onended = () => this.removeVoice(v);
      src.start();
      this.voices.push(v);
      return v;
    } catch {
      return null;
    }
  }

  private removeVoice(v: Voice): void {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    try {
      v.src.disconnect();
      v.gain.disconnect();
      v.panner?.disconnect();
    } catch {
      /* ya desconectado */
    }
  }

  private stopVoice(v: Voice): void {
    v.src.onended = null;
    try {
      v.src.stop();
    } catch {
      /* no había empezado */
    }
    this.removeVoice(v);
  }

  private loopParams(st: LoopState): { gain: number; pan: number } {
    const s = this.placement(st.x, st.y);
    if (!s) return { gain: dsVolumeToGain(st.def.volume) * st.scale, pan: 0 };
    return { gain: s.gain * st.scale, pan: s.pan };
  }

  private startLoop(st: LoopState): void {
    if (st.stopped || st.voice || st.loading || !this.ctx) return;
    const buf = this.bufferByPath.get(st.def.path);
    if (buf) {
      const p = this.loopParams(st);
      st.voice = this.startVoice(st.def.key, buf, p.gain, p.pan, true);
      return;
    }
    st.loading = true;
    void this.loadBuffer(st.def.path).then((b) => {
      st.loading = false;
      if (b) this.startLoop(st);
    });
  }

  private updateLoop(st: LoopState): void {
    const v = st.voice;
    const ctx = this.ctx;
    if (!v || !ctx) return;
    const p = this.loopParams(st);
    try {
      v.gain.gain.setTargetAtTime(p.gain, ctx.currentTime, 0.05);
      v.panner?.pan.setTargetAtTime(p.pan, ctx.currentTime, 0.05);
    } catch {
      /* nada */
    }
  }

  private applyAmbient(): void {
    const { set, night, block } = this.amb;
    const table = this.ambTables.get(set);
    const list = table && block >= 0 ? table[night ? 1 : 0].get(block) ?? [] : [];
    const key = `${set}:${night ? 1 : 0}:${block}`;
    if (key === this.ambKey && list === this.ambList) return;
    this.ambKey = key;
    this.ambList = list;
    // los sonidos en bucle de la lista suenan continuamente y bajos (no ocurre con los .AMB originales)
    const loops = new Set(list.filter((id) => this.sound2.get(id)?.loop));
    for (const [id, h] of this.ambLoops) {
      if (!loops.has(id)) {
        h.stop();
        this.ambLoops.delete(id);
      }
    }
    for (const id of loops) {
      if (!this.ambLoops.has(id)) this.ambLoops.set(id, this.playLoop(id, undefined, undefined, AMBIENT_LOOP_GAIN * this.ambientVolume));
    }
  }

  private playAmbientOnce(): void {
    const list = this.ambList;
    if (list.length === 0) return;
    const id = this.pick('amb:' + this.ambKey, list);
    const e = this.sound2.get(id);
    if (!e || e.loop || !this.ctx) return;
    this.trigger(def2(e), dsVolumeToGain(e.volume) * this.ambientVolume, 0);
  }
}

/** 'DESERT.RMP' / 'maps\\jungle' → 'desert' / 'jungle' */
function terrainSetName(s: string): string {
  return s
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^.]*$/, '')
    .toLowerCase();
}
