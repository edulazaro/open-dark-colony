// Scripts de misión del original: disparadores (.TRO), mensajes (.MSG), casillas trampa (.MTG)
// y textos de final de misión (.001, .002...).
//
// Todo lo que sigue sale de desensamblar DC.EXE (trigger.c, results.c, text.c, research.c):
//   - cargador de .TRO        FUN_0043c2b4 / FUN_0043ae2c   (tabla de 256 disparadores de 16 bytes en 0x4f6c48)
//   - compilador de ecuaciones FUN_004390b0 y descendientes  (genera código en notación polaca inversa)
//   - evaluador               FUN_00439a24                   (pila de 16 bits con centinela 0xFFFF)
//   - ejecutor de acciones    FUN_0043a144                   (lista enlazada: se ejecuta en orden INVERSO)
//   - bucle 'norm'            FUN_0043aca4 (ids 0..127, cada 8 fotogramas)
//   - disparo 'trip'          FUN_0043ad04 (al entrar una unidad en una casilla marcada en el .MTG)
//
// Lenguaje (.TRO):
//   <id> norm|trip <vidas> <condición>        cabecera; id 0..255 (sólo 0..127 se evalúan como 'norm')
//   <verbo> <args...>                          acciones, una por línea
//   end
// Las líneas que empiezan por '%' o con menos de 4 caracteres (contando el salto) se ignoran.
// 'vidas' es el número de veces que puede dispararse (0 = desactivado hasta un 'setlifes').
// Tras ejecutar las acciones se resta una vida (en un byte, así que 0-1 = 255).
import { TILE, TPS, NEUTRAL, type World, type Entity } from './world';
import { VENT, COMMANDERS } from './rules';
import { fetchBin, fetchText } from '../data/vfs';

// ───────────────────────────── tipos ─────────────────────────────

export type TriggerKind = 'norm' | 'trip';

/** Operadores binarios. '&&' y '||' son en realidad AND/OR bit a bit de 16 bits (como el original). */
export type BinOp = '&&' | '||' | '==' | '!=' | '<' | '>' | '+' | '-' | '*' | '/' | '%';

/**
 * Árbol de una expresión. Variables: c (reloj = fotogramas/16), S (equipo de la unidad que pisa la
 * casilla), t (tipo de esa unidad), r (aleatorio 0..32767). Funciones: b(eq,familia), m(x,y),
 * s(eq,stat), s(eq,stat,tipo), u(i), v(x,y,eq). No existe el '!' unario: sólo '!='.
 */
export type Expr =
  | { k: 'num'; v: number }
  | { k: 'var'; name: 'c' | 'S' | 't' | 'r' }
  | { k: 'call'; fn: 'b' | 'm' | 's' | 'u' | 'v'; args: Expr[] }
  | { k: 'bin'; op: BinOp; a: Expr; b: Expr };

export type Verb =
  | 'ai'
  | 'aimsg'
  | 'reinforce'
  | 'reinforce2'
  | 'die'
  | 'noundeploy'
  | 'artifact'
  | 'abduct'
  | 'newrate'
  | 'newtype'
  | 'newrate2'
  | 'setmoney'
  | 'waypoint'
  | 'setarray'
  | 'setlifes'
  | 'exomoney'
  | 'vision'
  | 'nopickup'
  | 'ally'
  | 'dfiddle'
  | 'bail'
  | 'msg';

/**
 * Una acción. `args` ya truncados como los guarda el original (byte sin signo o short con signo).
 * Disposición de `args` por verbo (coordenadas x,y con el eje Y hacia arriba, como el .SCN):
 *   ai        [equipo, modo]                 modo de IA (3 = IA completa, 0 = sin IA)
 *   aimsg     [equipo, n, v1..vn]            mensaje a la IA (n<=5)
 *   reinforce [equipo, x, y, tipo0, n0, ... tipo4, n4]   dropship que aterriza y descarga
 *   reinforce2 (igual)                        aparición inmediata, sin dropship
 *   die, noundeploy  []
 *   artifact  [x, y]                         artefacto aleatorio (tipos 63..67) en el emplazamiento
 *   abduct    [equipoComandante, equipoNave] una nave recoge al comandante
 *   newrate   [caudal, x, y]                 caudal del respiradero (0 = dormido)
 *   newtype   [x, y, tipo]                   cambia el tipo del objeto de esa casilla
 *   newrate2  [x, y] + expr                  newrate con expresión
 *   setmoney  [x, y] + expr                  Petra-7 del respiradero (lo crea si no existe)
 *   waypoint  [x, y, n, x1, y1, ... xn, yn]  ruta (n<=8) para la unidad de la casilla
 *   setarray  [índice] + expr                tabla leída con s(0,2,índice)
 *   setlifes  [disparador] + expr            vidas de otro disparador
 *   exomoney  [equipo, cantidad]             ingreso pasivo cada 16 fotogramas (byte)
 *   vision    [a, b, on]                     visión compartida
 *   nopickup  [equipo]                       sin nave médica para el comandante herido
 *   ally      [a, b, aliados]                alianza (0 = enemigos)
 *   dfiddle   [equipo, ranura, valor]        retoca la lista %Depend del equipo
 *   bail      [resultado, texto]             fin de misión (0 gana, 1 pierde) + fichero .00N
 *   msg       [color, tipo(0), texto, flags, segundos]
 */
export interface Action {
  verb: Verb;
  args: number[];
  expr?: Expr;
  line: number;
  text: string;
}

export interface Trigger {
  id: number;
  kind: TriggerKind;
  lifes: number;
  cond: Expr;
  condText: string;
  /** en orden del fichero (se ejecutan al revés) */
  actions: Action[];
  line: number;
}

export interface TroDiagnostics {
  /** cosas que en el original abortan el juego (error de sintaxis, verbo desconocido...) */
  errors: string[];
  /** rarezas que el original acepta en silencio (p. ej. "(b(1,3)&&==0)" de HUMAN09) */
  quirks: string[];
}

/** Casillas trampa (.MTG): byte ancho, byte alto y un id de disparador por casilla (fila 0 = arriba). */
export interface TripMap {
  w: number;
  h: number;
  ids: Uint8Array;
}

// ───────────────────────────── utilidades ─────────────────────────────

const i16 = (v: number): number => (v << 16) >> 16;
const u8 = (v: number): number => v & 0xff;

/** strtol(s, &end, 10) de C: salta blancos, signo opcional; sin dígitos devuelve 0 y no avanza. */
function strtol(s: string, pos: number): [number, number] {
  let p = pos;
  while (p < s.length && ' \t\n\v\f\r'.includes(s[p])) p++;
  let neg = false;
  if (s[p] === '+' || s[p] === '-') {
    neg = s[p] === '-';
    p++;
  }
  const start = p;
  let v = 0;
  while (p < s.length && s[p] >= '0' && s[p] <= '9') v = (v * 10 + (s.charCodeAt(p++) - 48)) | 0;
  if (p === start) return [0, pos];
  return [neg ? -v | 0 : v, p];
}

// ───────────────────────────── compilador de expresiones ─────────────────────────────

class ExprError extends Error {}

/**
 * Réplica exacta del compilador recursivo del original. La gramática es peculiar:
 *   full := A M C L
 *   A    := P [('+'|'-') P]                 (una sola suma/resta)
 *   M    := [('*'|'/'|'%') P [('+'|'-') P]] (una sola; "a*b+c" = a*(b+c), "a+b*c" = (a+b)*c)
 *   C    := [('=='|'!='|'<'|'>') P [+-P] M]
 *   L    := [('&&'|'||') A M C L]           (asociativo por la derecha, sin precedencia entre && y ||)
 *   P    := '(' full ')' | número | S | t | c | r | b(..) | m(..) | s(..) | u(..) | v(..)
 * Cualquier otro carácter en P se consume sin generar nada (de ahí que "&&==0" funcione).
 * Los espacios se ignoran en cualquier sitio (también dentro de los números).
 */
class ExprCompiler {
  private p = 0;
  private readonly stack: Expr[] = [];
  constructor(
    private readonly s: string,
    private readonly quirk: (msg: string) => void,
  ) {}

  compile(): Expr {
    this.full();
    if (this.get() !== '\0') this.fail();
    if (this.stack.length === 0) {
      this.quirk('expresión vacía (vale -1)');
      return { k: 'num', v: -1 };
    }
    if (this.stack.length > 1) this.quirk('sobran operandos en la pila');
    return this.stack[this.stack.length - 1];
  }

  private fail(): never {
    throw new ExprError(`error en la ecuación cerca de "${this.s.slice(Math.max(0, this.p - 1))}"`);
  }

  /** lee un carácter saltando espacios (FUN_0043901c); al final devuelve '\0' */
  private get(): string {
    let c: string;
    do {
      c = this.p < this.s.length ? this.s[this.p] : '\0';
      this.p++;
    } while (c === ' ');
    return c;
  }

  /** retrocede un carácter (FUN_00439034) */
  private unget(): void {
    do this.p--;
    while (this.p > 0 && this.s[this.p] === ' ');
  }

  private pop(): Expr {
    const e = this.stack.pop();
    if (e) return e;
    // la pila del original tiene debajo un centinela 0xFFFF
    this.quirk('pila vacía: se usa el centinela -1');
    return { k: 'num', v: -1 };
  }

  private bin(op: BinOp): void {
    const b = this.pop();
    const a = this.pop();
    this.stack.push({ k: 'bin', op, a, b });
  }

  private full(): void {
    this.A();
    this.M();
    this.C();
    this.L();
  }

  private A(): void {
    this.P();
    this.addTail();
  }

  private addTail(): void {
    const c = this.get();
    if (c === '+' || c === '-') {
      this.P();
      this.bin(c);
    } else if ('\0!%&)*,/<=>|'.includes(c)) this.unget();
    else this.fail();
  }

  private M(): void {
    const c = this.get();
    if (c === '%' || c === '*' || c === '/') {
      this.P();
      this.addTail();
      this.bin(c);
    } else if ('\0!&),<=>|'.includes(c)) this.unget();
    else this.fail();
  }

  private C(): void {
    const c = this.get();
    let op: BinOp | null = null;
    if (c === '!') {
      this.get(); // el '=' de "!=" no se comprueba
      op = '!=';
    } else if (c === '<') op = '<';
    else if (c === '>') op = '>';
    else if (c === '=') {
      if (this.get() !== '=') this.unget(); // un '=' suelto también vale
      op = '==';
    } else if ('\0&),|'.includes(c)) {
      this.unget();
      return;
    } else this.fail();
    this.P();
    this.addTail();
    this.M();
    this.bin(op);
  }

  private L(): void {
    const c = this.get();
    if (c === '&' || c === '|') {
      this.get(); // segundo '&' o '|', sin comprobar
      this.full();
      this.bin(c === '&' ? '&&' : '||');
    } else if ('\0),'.includes(c)) this.unget();
    else this.fail();
  }

  private expect(ch: string): void {
    if (this.get() !== ch) this.fail();
  }

  private P(): void {
    const c = this.get();
    if (c === '(') {
      this.full();
      this.expect(')');
      return;
    }
    if (c >= '0' && c <= '9') {
      let v = c.charCodeAt(0) - 48;
      for (;;) {
        const d = this.get();
        if (d < '0' || d > '9') break;
        v = (v * 10 + d.charCodeAt(0) - 48) | 0;
      }
      this.unget();
      this.stack.push({ k: 'num', v: i16(v) });
      return;
    }
    switch (c) {
      case 'S':
      case 't':
      case 'c':
      case 'r':
        this.stack.push({ k: 'var', name: c });
        return;
      case 'b':
      case 'm':
      case 's':
      case 'u':
      case 'v': {
        const n = c === 'u' ? 1 : c === 'v' ? 3 : 2;
        this.expect('(');
        for (let i = 0; i < n; i++) {
          if (i > 0) this.expect(',');
          this.full();
        }
        let argc = n;
        if (c === 's') {
          const d = this.get();
          if (d === ',') {
            this.full();
            this.expect(')');
            argc = 3;
          } else if (d !== ')') this.fail();
        } else this.expect(')');
        const args: Expr[] = [];
        for (let i = 0; i < argc; i++) args.unshift(this.pop());
        this.stack.push({ k: 'call', fn: c, args });
        return;
      }
    }
    // carácter desconocido: el original lo consume y no genera nada
    this.quirk(`carácter '${c === '\0' ? '\\0' : c}' ignorado en un operando`);
  }
}

/** Compila una condición o expresión con las reglas exactas del original (lanza Error si no es válida). */
export function compileExpr(src: string, quirks?: string[]): Expr {
  return new ExprCompiler(src, (m) => quirks?.push(m)).compile();
}

/** Texto legible de una expresión (con paréntesis explícitos). */
export function exprToString(e: Expr): string {
  switch (e.k) {
    case 'num':
      return String(e.v);
    case 'var':
      return e.name;
    case 'call':
      return `${e.fn}(${e.args.map(exprToString).join(',')})`;
    case 'bin':
      return `(${exprToString(e.a)}${e.op}${exprToString(e.b)})`;
  }
}

// ───────────────────────────── .TRO ─────────────────────────────

type ArgKind = 'b' | 's';
/** argumentos fijos de cada verbo (b = byte, s = short) y cola especial */
const LAYOUT: Record<Verb, { args: ArgKind[]; tail?: 'expr' | 'cargo' | 'aimsg' | 'path' }> = {
  ai: { args: ['s', 's'] },
  aimsg: { args: ['b', 'b'], tail: 'aimsg' },
  reinforce: { args: ['b', 'b', 'b'], tail: 'cargo' },
  reinforce2: { args: ['b', 'b', 'b'], tail: 'cargo' },
  die: { args: [] },
  noundeploy: { args: [] },
  artifact: { args: ['b', 'b'] },
  abduct: { args: ['b', 'b'] },
  newrate: { args: ['b', 'b', 'b'] },
  newtype: { args: ['b', 'b', 'b'] },
  newrate2: { args: ['b', 'b'], tail: 'expr' },
  setmoney: { args: ['b', 'b'], tail: 'expr' },
  waypoint: { args: ['b', 'b', 'b'], tail: 'path' },
  setarray: { args: ['s'], tail: 'expr' },
  setlifes: { args: ['s'], tail: 'expr' },
  exomoney: { args: ['b', 'b'] },
  vision: { args: ['b', 'b', 'b'] },
  nopickup: { args: ['b'] },
  ally: { args: ['b', 'b', 'b'] },
  dfiddle: { args: ['b', 'b', 'b'] },
  bail: { args: ['b', 'b'] },
  msg: { args: ['b', 'b', 'b', 'b', 'b'] },
};

interface RawLine {
  text: string;
  /** longitud que vería strlen() tras fgets (incluye el salto de línea) */
  len: number;
  no: number;
}

function splitLines(text: string): RawLine[] {
  const out: RawLine[] = [];
  let start = 0;
  let no = 1;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl;
    const raw = text.slice(start, end);
    out.push({ text: raw.replace(/\r+$/, ''), len: raw.length + (nl < 0 ? 0 : 1), no: no++ });
    start = end + 1;
  }
  return out;
}

/** líneas que el original salta entre disparadores y acciones (FUN_0043add4) */
const skippable = (l: RawLine): boolean => l.len < 4 || l.text.startsWith('%');

/**
 * Analiza un .TRO completo. Es tolerante: los errores (que en el original abortan) se anotan en
 * `diag.errors` y el disparador afectado se conserva con condición 0 (nunca se cumple).
 */
export function parseTro(text: string, diag?: TroDiagnostics): Trigger[] {
  const lines = splitLines(text);
  const triggers: Trigger[] = [];
  const err = (no: number, m: string) => diag?.errors.push(`línea ${no}: ${m}`);
  let i = 0;
  const nextLine = (): RawLine | null => {
    while (i < lines.length && skippable(lines[i])) i++;
    return i < lines.length ? lines[i++] : null;
  };
  for (;;) {
    const head = nextLine();
    if (!head) break;
    const s = head.text;
    // <id> <norm|trip> <vidas> <condición>
    const [id, p1] = strtol(s, 0);
    if (p1 === 0 || id < 0 || id > 255) {
      err(head.no, `se esperaba un disparador: "${s}"`);
      continue;
    }
    let p = p1;
    while (s[p] === ' ') p++;
    let q = p;
    while (q < s.length && s[q] !== ' ') q++;
    const word = s.slice(p, q);
    let kind: TriggerKind = 'norm';
    if (word === 'norm' || word === 'NORM') kind = 'norm';
    else if (word === 'trip' || word === 'TRIP') kind = 'trip';
    else err(head.no, `se esperaba norm/trip y hay "${word}"`);
    const [lifesRaw, p2] = strtol(s, Math.min(s.length, q + 1));
    if (lifesRaw < 0) err(head.no, 'vidas negativas');
    const condText = s.slice(p2).trim();
    let cond: Expr = { k: 'num', v: 0 };
    const quirks: string[] = [];
    try {
      cond = compileExpr(s.slice(p2), quirks);
    } catch (e) {
      err(head.no, (e as Error).message);
    }
    for (const qk of quirks) diag?.quirks.push(`línea ${head.no} (disparador ${id}): ${qk}`);
    const trig: Trigger = { id, kind, lifes: u8(lifesRaw), cond, condText, actions: [], line: head.no };
    triggers.push(trig);
    // acciones hasta 'end'
    for (;;) {
      const l = nextLine();
      if (!l) {
        err(head.no, `falta 'end' en el disparador ${id}`);
        break;
      }
      const t = l.text;
      let e = 0;
      while (e < t.length && !' \t\n\r\0'.includes(t[e])) e++;
      const verb = t.slice(0, e);
      if (!verb) continue; // línea que empieza por blanco: el original la ignora
      if (verb === 'end') break;
      const lay = (LAYOUT as Record<string, (typeof LAYOUT)[Verb] | undefined>)[verb];
      if (!lay) {
        err(l.no, `acción desconocida "${verb}"`);
        continue;
      }
      let pos = Math.min(t.length, e + 1);
      const num = (k: ArgKind): number => {
        const [v, np] = strtol(t, pos);
        pos = np;
        return k === 'b' ? u8(v) : i16(v);
      };
      const args = lay.args.map(num);
      const act: Action = { verb: verb as Verb, args, line: l.no, text: t };
      if (lay.tail === 'cargo') for (let k = 0; k < 10; k++) args.push(num('b'));
      else if (lay.tail === 'aimsg') {
        if (args[1] > 5) err(l.no, 'aimsg con más de 5 valores');
        for (let k = 0; k < Math.min(args[1], 5); k++) args.push(num('s'));
      } else if (lay.tail === 'path') {
        if (args[2] < 1 || args[2] > 8) err(l.no, 'waypoint con 0 o más de 8 puntos');
        for (let k = 0; k < Math.min(args[2], 8) * 2; k++) args.push(num('b'));
      } else if (lay.tail === 'expr') {
        const eq: string[] = [];
        try {
          act.expr = compileExpr(t.slice(pos), eq);
        } catch (ex) {
          err(l.no, (ex as Error).message);
          act.expr = { k: 'num', v: 0 };
        }
        for (const qk of eq) diag?.quirks.push(`línea ${l.no}: ${qk}`);
      }
      if (verb === 'msg' && args[1] !== 0) err(l.no, 'msg de tipo distinto de 0');
      trig.actions.push(act);
    }
  }
  return triggers;
}

// ───────────────────────────── .MSG, .MTG, .00N ─────────────────────────────

/** Mensajes de misión: "text N" seguido de una línea con el texto ("sound N" se ignora). */
export function parseMsg(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const lines = text.split('\n').map((l) => l.replace(/\r+$/, ''));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length < 3 || l.startsWith('%')) continue;
    const m = /^\s*(\S+)\s+(-?\d+)/.exec(l);
    if (!m) continue;
    if (m[1].toLowerCase() === 'text') {
      out.set(parseInt(m[2], 10), lines[i + 1] ?? '');
      i++;
    }
  }
  return out;
}

export function parseMtg(buf: ArrayBuffer): TripMap | null {
  const b = new Uint8Array(buf);
  if (b.length < 2) return null;
  const w = b[0], h = b[1];
  if (b.length < 2 + w * h) return null;
  return { w, h, ids: b.slice(2, 2 + w * h) };
}

/** Partes de un texto con códigos de color "~N" (textos de misión y finales). */
export function parseColourText(text: string): { colour: number; text: string }[] {
  const out: { colour: number; text: string }[] = [];
  let colour = 4;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '~' && text[i + 1] >= '0' && text[i + 1] <= '9') {
      if (cur) out.push({ colour, text: cur });
      cur = '';
      colour = text.charCodeAt(++i) - 48;
    } else if (text[i] !== '\r') cur += text[i];
  }
  if (cur) out.push({ colour, text: cur });
  return out;
}

export const stripColours = (text: string): string => text.replace(/~\d/g, '').replace(/\r/g, '');

export interface MissionData {
  /** ruta base, p. ej. "scenario/human/human01" */
  base: string;
  triggers: Trigger[];
  messages: Map<number, string>;
  trip: TripMap | null;
  /** textos .00N por número (los que aparecen en algún 'bail') */
  endTexts: Map<number, string>;
  /** briefing (.TXT), si existe */
  briefing: string;
  diag: TroDiagnostics;
}

const pad3 = (n: number) => String(n).padStart(3, '0');

/** Carga todo lo que necesita el script de una misión (base = ruta del .SCN sin extensión). */
export async function loadMission(base: string): Promise<MissionData> {
  base = base.replace(/\.scn$/i, '');
  const opt = <T>(p: Promise<T>, def: T) => p.catch(() => def);
  const [tro, msg, mtg, briefing] = await Promise.all([
    opt(fetchText(base + '.tro'), ''),
    opt(fetchText(base + '.msg'), ''),
    opt(fetchBin(base + '.mtg'), null),
    opt(fetchText(base + '.txt'), ''),
  ]);
  const diag: TroDiagnostics = { errors: [], quirks: [] };
  const triggers = parseTro(tro, diag);
  const nums = new Set<number>();
  for (const t of triggers) for (const a of t.actions) if (a.verb === 'bail') nums.add(a.args[1]);
  const endTexts = new Map<number, string>();
  await Promise.all(
    [...nums].map(async (n) => {
      const t = await opt(fetchText(`${base}.${pad3(n)}`), null);
      if (t !== null) endTexts.set(n, t);
    }),
  );
  return { base, triggers, messages: parseMsg(msg), trip: mtg ? parseMtg(mtg) : null, endTexts, briefing, diag };
}

// ───────────────────────────── intérprete ─────────────────────────────

export interface MissionResult {
  outcome: 'win' | 'lose';
  /** primer argumento de 'bail' (0 gana) */
  code: number;
  /** número del fichero de texto final (.001, .002...) */
  textNo: number;
  /** contenido del .00N (con códigos ~N) o '' si no se cargó */
  text: string;
}

/** Mensaje de la barra de órdenes (cola de hasta 16, uno visible cada vez). */
export interface ScriptMessage {
  id: number;
  text: string;
  /** índice de color del texto (1.er argumento de msg) */
  colour: number;
  /** parpadea con pitido durante el primer segundo (bit 0 de flags) */
  blink: boolean;
  /** tras caducar se atenúa (flags >= 2) */
  dim: boolean;
  /** segundos mínimos en pantalla antes de pasar al siguiente */
  seconds: number;
  /** fotograma en que se mostró (-1 = en cola) */
  shownAt: number;
  expired: boolean;
}

export type ScriptEvent =
  | { type: 'message'; msg: ScriptMessage }
  | { type: 'dropship'; team: number; x: number; y: number; landAt: number; cargo: [number, number][] }
  | { type: 'landed'; team: number; x: number; y: number; units: Entity[] }
  | { type: 'abduct'; team: number; ship: number; unit: Entity; at: number }
  | { type: 'ai'; team: number; mode: number }
  | { type: 'aimsg'; team: number; values: number[] }
  | { type: 'vent'; vent: Entity; rate: number; erupted: boolean }
  | { type: 'artifact'; x: number; y: number; unit: Entity }
  | { type: 'depend'; team: number; slot: number; value: number }
  | { type: 'bail'; result: MissionResult; at: number };

export interface MissionOptions {
  trip?: TripMap | null;
  endTexts?: Map<number, string>;
  /** cabecera numérica del .SCN ([.., .., noche, mediaJornada, fase, transición]) para el reloj día/noche original */
  scnHeader?: number[];
  /**
   * Opciones globales s(1..6,0). Por defecto las de campaña: 1 = 256 (multiplicador de caudal),
   * 2 = 256 (multiplicador de Petra-7), 3..6 = 0 (opciones de multijugador: 3 respiraderos que
   * aparecen, 4 respiraderos que se regeneran, 6 número de artefactos).
   */
  settings?: Partial<Record<1 | 2 | 3 | 4 | 5 | 6, number>>;
  /** fotogramas hasta que aterriza el dropship (por defecto 4 s) */
  dropDelay?: number;
  /** fotogramas entre 'bail' y el final (el original espera 10 s) */
  bailDelay?: number;
  seed?: number;
  onEvent?(ev: ScriptEvent): void;
}

interface Drop {
  at: number;
  team: number;
  tx: number;
  ty: number;
  cargo: [number, number][];
  slot: number;
}

interface Snap {
  /** [equipo][familia] edificio de la ciudad en pie */
  fam: Uint8Array;
  units: Int32Array;
  byType: Map<number, number>;
}

const MAX_TEAMS = 8;
const STAND = ['STAND', 'SHUF', 'MOVE'];

/**
 * Intérprete de los disparadores de una misión. Llamar a `step()` una vez por tick del mundo,
 * justo DESPUÉS de `world.step()` (15 ticks/s = un fotograma del original a velocidad normal).
 */
export class MissionScript {
  /** fotogramas transcurridos (0x52c del original) */
  frame = 0;
  /** resultado definitivo (tras la espera de 'bail'); la UI termina la misión al verlo */
  result: MissionResult | null = null;
  /** 'bail' ejecutado y esperando la cuenta atrás */
  pending: MissionResult | null = null;
  currentMessage: ScriptMessage | null = null;
  readonly messageLog: ScriptMessage[] = [];
  /** avisos (acciones imposibles que en el original abortarían) */
  readonly warnings: string[] = [];
  noUndeploy = false;
  readonly noPickup = new Set<number>();
  readonly aiMode = new Int32Array(MAX_TEAMS);
  readonly exoMoney = new Int32Array(MAX_TEAMS);
  /** %Depend modificado con dfiddle: [equipo][ranura] */
  readonly depend = new Map<number, Map<number, number>>();

  // tabla de disparadores indexada por id (el último con un id gana, como en el original)
  private readonly kind = new Int8Array(256).fill(-1);
  private readonly lifes = new Uint8Array(256);
  private readonly conds: (Expr | null)[] = new Array(256).fill(null);
  private readonly acts: Action[][] = Array.from({ length: 256 }, () => []);

  private readonly messages: Map<number, string>;
  private readonly trip: TripMap | null;
  private readonly endTexts: Map<number, string>;
  private readonly opts: MissionOptions;
  private readonly dropDelay: number;
  private readonly bailDelay: number;
  private bailAt = 0;
  private seed: number;

  // estadísticas (results.c)
  private readonly globals = new Int32Array(MAX_TEAMS); // STAT[p][0]
  private readonly earned = new Int32Array(9);
  private readonly kills = new Int32Array(9);
  private readonly losses = new Int32Array(9);
  private readonly cmdKills = new Int32Array(9);
  private readonly lossByType = new Map<number, number>();
  private readonly killByType = new Map<number, number>();
  private readonly arrays = new Map<number, number>();
  private readonly lastMoney = new Map<number, number>();
  private snap: Snap | null = null;

  // reloj día/noche del original (0x53c noche, 0x530 fase, 0x534 media jornada, 0x538 transición)
  private night = 0;
  private phase = 0;
  private half = 0;
  private trans = 1;
  private readonly ownClock: boolean;

  private readonly queue: ScriptMessage[] = [];
  private readonly drops: Drop[] = [];
  private readonly dropSlots = new Uint8Array(MAX_TEAMS);
  private readonly pickups: { at: number; unit: Entity }[] = [];
  private readonly paths = new Map<number, { pts: [number, number][]; i: number; order: unknown }>();
  private readonly tiles = new Map<number, number>();
  private readonly allies = new Map<number, boolean>();
  private readonly sharedVision = new Map<number, boolean>();
  private readonly patched: { name: 'kill' | 'enemies'; own: unknown; had: boolean }[] = [];
  private disposed = false;

  constructor(
    readonly world: World,
    triggers: Trigger[],
    messages: Map<number, string> = new Map(),
    opts: MissionOptions = {},
  ) {
    this.messages = messages;
    this.opts = opts;
    this.trip = opts.trip ?? null;
    this.endTexts = opts.endTexts ?? new Map();
    this.dropDelay = opts.dropDelay ?? 4 * TPS;
    this.bailDelay = opts.bailDelay ?? 10 * TPS;
    this.seed = (opts.seed ?? 1) >>> 0;
    for (const t of triggers) {
      this.kind[t.id] = t.kind === 'norm' ? 0 : 1;
      this.lifes[t.id] = t.lifes;
      this.conds[t.id] = t.cond;
      this.acts[t.id] = t.actions;
    }
    // STAT[p][0]: 0 = resultado de bail, 1..6 = opciones, 7 = texto de bail
    const st = opts.settings ?? {};
    this.globals[1] = st[1] ?? 256;
    this.globals[2] = st[2] ?? 256;
    for (const k of [3, 4, 5, 6] as const) this.globals[k] = st[k] ?? 0;
    const h = opts.scnHeader;
    this.ownClock = !!h && h.length >= 6 && h[3] > 0;
    if (this.ownClock && h) {
      this.night = h[2] ? 1 : 0;
      this.half = h[3];
      this.phase = h[4];
      this.trans = Math.max(1, h[5]);
    }
    // posición inicial de todas las unidades: las que ya están sobre una trampa no la disparan
    for (const e of world.ents) if (e.alive && e.kind === 'unit') this.tiles.set(e.id, this.tileIndex(e));
    for (const t of world.teams) if (t) this.lastMoney.set(t.id, t.money);
    this.patchKill();
  }

  /** Quita los parches instalados en el mundo. */
  dispose(): void {
    this.disposed = true;
    for (const p of this.patched.reverse()) {
      const w = this.world as unknown as Record<string, unknown>;
      if (p.had) w[p.name] = p.own;
      else delete w[p.name];
    }
    this.patched.length = 0;
  }

  // ───────────── consultas ─────────────

  /** Vidas actuales de un disparador. */
  lifesOf(id: number): number {
    return this.lifes[id & 0xff];
  }

  /** ¿Es de noche según el reloj del original? (si no hay cabecera, el del mundo) */
  isNight(): boolean {
    return this.ownClock ? this.night === 1 : this.world.isNight();
  }

  /** Oscuridad 0..256 (0x540 del original): sube/baja durante la transición. */
  darkness(): number {
    if (!this.ownClock) return this.world.isNight() ? 256 : 0;
    if (this.phase <= this.trans) {
      const k = Math.floor((this.phase * 256) / this.trans);
      return this.night ? k : 256 - k;
    }
    return this.night ? 256 : 0;
  }

  /** s(p,t): estadísticas por jugador (results.c, LAST_STAT = 12). */
  stat(p: number, t: number): number {
    if (t < 0 || t >= 12 || p < 0 || p >= MAX_TEAMS) return 0;
    switch (t) {
      case 0:
        return this.globals[p];
      case 1:
        return this.earned[p];
      case 2:
        return this.kills[p];
      case 3:
        return this.losses[p];
      case 4:
        return this.world.teams[p]?.side ?? p;
      case 6:
        return this.snapshot().units[p];
      case 10:
        // [0][10] = 1 de día / 0 de noche; [1][10] = posición en la media jornada (0..255)
        if (p === 0) return this.isNight() ? 0 : 1;
        if (p === 1) return this.ownClock ? Math.floor((this.phase * 256) / this.half) : Math.floor(this.world.timeOfDay() * 256);
        return 0;
      case 11:
        return this.cmdKills[p];
      default:
        // 5, 7, 8, 9: contadores internos que ningún script usa
        return 0;
    }
  }

  /** s(p,t,tipo): estadísticas por jugador y tipo (LAST_TSTAT = 4). */
  tstat(p: number, t: number, type: number): number {
    if (t < 0 || t >= 4 || p < 0 || p >= MAX_TEAMS || type < 0 || type >= 800) return 0;
    const k = p * 1024 + type;
    switch (t) {
      case 0:
        return this.lossByType.get(k) ?? 0;
      case 1:
        return this.snapshot().byType.get(k) ?? 0;
      case 2:
        return this.arrays.get(k) ?? 0;
      default:
        return this.killByType.get(k) ?? 0;
    }
  }

  /** Evalúa una expresión (con `unit` = la que pisa la trampa). Resultado de 16 bits con signo. */
  evaluate(e: Expr, unit: Entity | null = null): number {
    switch (e.k) {
      case 'num':
        return i16(e.v);
      case 'var':
        switch (e.name) {
          case 'c':
            return i16(this.frame >> 4);
          case 'r':
            return this.rand();
          case 'S':
            return unit ? unit.team : -1;
          case 't':
            return unit ? unit.type : -1;
        }
        return 0;
      case 'bin': {
        const a = this.evaluate(e.a, unit);
        const b = this.evaluate(e.b, unit);
        switch (e.op) {
          case '&&':
            return i16(a & b);
          case '||':
            return i16(a | b);
          case '==':
            return a === b ? 1 : 0;
          case '!=':
            return a !== b ? 1 : 0;
          case '<':
            return a < b ? 1 : 0;
          case '>':
            return a > b ? 1 : 0;
          case '+':
            return i16(a + b);
          case '-':
            return i16(a - b);
          case '*':
            return i16(Math.imul(a, b));
          case '/':
            return b === 0 ? 0 : i16(Math.trunc(a / b));
          case '%':
            return b === 0 ? 0 : i16(a % b);
        }
        return 0;
      }
      case 'call': {
        const v = e.args.map((x) => this.evaluate(x, unit));
        switch (e.fn) {
          case 'b':
            return this.building(v[0], v[1]);
          case 'm':
            return this.ventAt(v[0], v[1], true) ? 1 : 0;
          case 's':
            // el índice de estadística se trunca a un byte con signo
            return i16(v.length === 3 ? this.tstat(v[0], (v[1] << 24) >> 24, v[2]) : this.stat(v[0], (v[1] << 24) >> 24));
          case 'u':
            // lee una tabla interna del motor que los scripts nunca escriben
            return 0;
          case 'v':
            return this.explored(v[0], v[1], v[2]);
        }
        return 0;
      }
    }
  }

  // ───────────── bucle ─────────────

  step(): void {
    if (this.result || this.disposed) return;
    this.frame++;
    this.snap = null;
    this.trackMoney();
    this.stepClock();
    this.stepDrops();
    this.detectTrips();
    // 0x94c & 7: los disparadores 'norm' se evalúan cada 8 fotogramas
    if ((this.frame & 7) === 0) this.runNorm();
    // 0x94c & 15: ingresos de exomoney (si el equipo tiene el edificio de la familia 0)
    if ((this.frame & 15) === 0) this.exoIncome();
    this.stepPaths();
    this.stepVision();
    this.stepMessages();
    if (this.pending && this.frame >= this.bailAt) this.result = this.pending;
    if ((this.frame & 63) === 0) for (const id of this.tiles.keys()) if (!this.world.get(id)) this.tiles.delete(id);
  }

  private runNorm(): void {
    for (let id = 0; id < 128; id++) {
      if (!this.lifes[id] || this.kind[id] !== 0) continue;
      const c = this.conds[id];
      if (!c || this.evaluate(c, null) === 0) continue;
      this.exec(id);
      this.lifes[id] = (this.lifes[id] - 1) & 0xff;
    }
  }

  /** Una unidad entra en una casilla con trampa `id` (FUN_0043ad04). */
  fireTrip(id: number, unit: Entity): void {
    if (!this.lifes[id] || this.kind[id] !== 1) return;
    const c = this.conds[id];
    if (!c || this.evaluate(c, unit) === 0) return;
    this.exec(id);
    this.lifes[id] = (this.lifes[id] - 1) & 0xff;
  }

  private exec(id: number): void {
    // la lista de acciones del original está enlazada al revés
    const list = this.acts[id];
    for (let i = list.length - 1; i >= 0; i--) this.action(list[i]);
    this.snap = null;
  }

  private detectTrips(): void {
    const trip = this.trip;
    for (const e of this.world.ents) {
      if (!e.alive || e.kind !== 'unit') continue;
      const idx = this.tileIndex(e);
      const prev = this.tiles.get(e.id);
      if (prev === idx) continue;
      this.tiles.set(e.id, idx);
      if (!trip) continue;
      const [tx, ty] = this.world.tileOf(e.x, e.y);
      if (tx >= trip.w || ty >= trip.h) continue;
      const id = trip.ids[ty * trip.w + tx];
      if (id) this.fireTrip(id, e);
    }
  }

  // ───────────── acciones ─────────────

  private action(a: Action): void {
    const g = a.args;
    switch (a.verb) {
      case 'ai': {
        const team = g[0];
        if (team < 0 || team >= MAX_TEAMS) return;
        this.aiMode[team] = g[1];
        const t = this.world.teams[team];
        if (t) t.ai = g[1] !== 0;
        this.emit({ type: 'ai', team, mode: g[1] });
        return;
      }
      case 'aimsg':
        this.emit({ type: 'aimsg', team: g[0], values: g.slice(2) });
        return;
      case 'reinforce':
      case 'reinforce2': {
        const cargo: [number, number][] = [];
        for (let k = 0; k < 5; k++) if (g[4 + k * 2]) cargo.push([g[3 + k * 2], g[4 + k * 2]]);
        if (a.verb === 'reinforce2') this.unload(g[0], g[1], this.row(g[2]), cargo);
        else this.dropship(g[0], g[1], g[2], cargo);
        return;
      }
      case 'die':
        // el original hace assert(0)
        this.warn(a, "'die' aborta el juego original; se ignora");
        return;
      case 'noundeploy':
        this.noUndeploy = true;
        return;
      case 'artifact': {
        // en el original se guarda en el emplazamiento de investigación (x,y); aquí aparece allí, neutral
        const type = 63 + (this.rand() % 5);
        const [x, y] = this.centre(g[0], this.row(g[1]));
        const unit = this.world.spawn(type, NEUTRAL, x, y, { dir: 0 });
        this.emit({ type: 'artifact', x: g[0], y: g[1], unit });
        return;
      }
      case 'abduct':
        this.abduct(g[0], g[1]);
        return;
      case 'newrate':
        this.setRate(g[1], g[2], g[0], a);
        return;
      case 'newrate2':
        this.setRate(g[0], g[1], this.evaluate(a.expr ?? { k: 'num', v: 0 }), a);
        return;
      case 'setmoney':
        this.setMoney(g[0], g[1], this.evaluate(a.expr ?? { k: 'num', v: 0 }));
        return;
      case 'newtype':
        this.newType(g[0], g[1], g[2]);
        return;
      case 'waypoint':
        this.waypoint(g);
        return;
      case 'setarray':
        if (g[0] >= 0 && g[0] < 800) this.arrays.set(g[0], this.evaluate(a.expr ?? { k: 'num', v: 0 }));
        return;
      case 'setlifes':
        if (g[0] >= 0 && g[0] < 256) this.lifes[g[0]] = u8(this.evaluate(a.expr ?? { k: 'num', v: 0 }));
        return;
      case 'exomoney':
        if (g[0] < MAX_TEAMS) this.exoMoney[g[0]] = g[1];
        return;
      case 'vision':
        this.sharedVision.set(g[0] * 16 + g[1], g[2] !== 0);
        this.sharedVision.set(g[1] * 16 + g[0], g[2] !== 0);
        return;
      case 'nopickup':
        this.noPickup.add(g[0]);
        return;
      case 'ally':
        this.patchEnemies();
        this.allies.set(g[0] * 16 + g[1], g[2] !== 0);
        this.allies.set(g[1] * 16 + g[0], g[2] !== 0);
        return;
      case 'dfiddle': {
        let m = this.depend.get(g[0]);
        if (!m) this.depend.set(g[0], (m = new Map()));
        m.set(g[1], g[2]);
        this.emit({ type: 'depend', team: g[0], slot: g[1], value: g[2] });
        return;
      }
      case 'bail': {
        this.globals[0] = g[0];
        this.globals[7] = g[1];
        // cada bail reinicia la cuenta atrás y sustituye el resultado
        this.pending = { outcome: g[0] === 0 ? 'win' : 'lose', code: g[0], textNo: g[1], text: this.endTexts.get(g[1]) ?? '' };
        this.bailAt = this.frame + this.bailDelay;
        this.emit({ type: 'bail', result: this.pending, at: this.bailAt });
        return;
      }
      case 'msg': {
        const text = this.messages.get(g[2]);
        if (text === undefined) {
          this.warn(a, `mensaje ${g[2]} inexistente`);
          return;
        }
        const m: ScriptMessage = { id: g[2], text, colour: g[0], blink: (g[3] & 1) !== 0, dim: g[3] >= 2, seconds: g[4], shownAt: -1, expired: false };
        if (this.queue.length >= 16) this.queue.shift();
        this.queue.push(m);
        return;
      }
    }
  }

  private warn(a: Action, m: string): void {
    this.warnings.push(`línea ${a.line} (${a.text.trim()}): ${m}`);
  }

  private emit(ev: ScriptEvent): void {
    this.opts.onEvent?.(ev);
  }

  /** Dropship (FUN_004180b8): ocupa una de las 8 ranuras del equipo y descarga al aterrizar. */
  private dropship(team: number, x: number, y: number, cargo: [number, number][]): void {
    if (team >= MAX_TEAMS) return;
    let slot = 0;
    while (slot < 8 && this.dropSlots[team] & (1 << slot)) slot++;
    if (slot >= 8) slot = 0;
    this.dropSlots[team] |= 1 << slot;
    const d: Drop = { at: this.frame + this.dropDelay, team, tx: x, ty: this.row(y), cargo, slot };
    this.drops.push(d);
    this.emit({ type: 'dropship', team, x, y, landAt: d.at, cargo });
  }

  private stepDrops(): void {
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      if (this.frame < d.at) continue;
      this.drops.splice(i--, 1);
      this.dropSlots[d.team] &= ~(1 << d.slot);
      this.unload(d.team, d.tx, d.ty, d.cargo);
    }
    for (let i = 0; i < this.pickups.length; i++) {
      const p = this.pickups[i];
      if (this.frame < p.at) continue;
      this.pickups.splice(i--, 1);
      if (p.unit.alive) this.world.remove(p.unit);
    }
  }

  /** Coloca la carga alrededor de la casilla (tx,ty) (fila de pantalla). */
  private unload(team: number, tx: number, ty: number, cargo: [number, number][]): Entity[] {
    const units: Entity[] = [];
    if (team > NEUTRAL) return units;
    const used = new Set<number>();
    const w = this.world;
    for (const [type, n] of cargo) {
      if (type >= w.rules.units.length) continue;
      const def = w.rules.unit(type);
      const air = def.fly === 1 || def.fly === 2;
      for (let k = 0; k < n; k++) {
        const spot = this.freeSpot(tx, ty, air, used);
        const [x, y] = this.centre(spot[0], spot[1]);
        units.push(w.spawn(type, team, x, y, { dir: 0 }));
      }
    }
    this.snap = null;
    this.emit({ type: 'landed', team, x: tx, y: this.world.h - 1 - ty, units });
    return units;
  }

  private freeSpot(tx: number, ty: number, air: boolean, used: Set<number>): [number, number] {
    const w = this.world;
    for (let r = 0; r <= 8; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = tx + dx, y = ty + dy;
          if (x < 0 || y < 0 || x >= w.w || y >= w.h) continue;
          const k = y * w.w + x;
          if (used.has(k) || (!air && !w.grid.passable(x, y))) continue;
          used.add(k);
          return [x, y];
        }
    return [Math.max(0, Math.min(w.w - 1, tx)), Math.max(0, Math.min(w.h - 1, ty))];
  }

  /** abduct a b: una nave del equipo b recoge al comandante del equipo a (si sigue vivo). */
  private abduct(team: number, ship: number): void {
    if (team >= MAX_TEAMS || ship >= MAX_TEAMS) return;
    const unit = this.commander(team);
    if (!unit) return;
    const at = this.frame + this.dropDelay;
    this.pickups.push({ at, unit });
    this.emit({ type: 'abduct', team, ship, unit, at });
  }

  private commander(team: number): Entity | undefined {
    return this.world.ents.find((e) => e.alive && e.team === team && COMMANDERS.includes(e.type));
  }

  /** newrate/newrate2: caudal del respiradero (0 = dormido). */
  private setRate(x: number, y: number, value: number, a: Action): void {
    const v = this.ventAt(x, y, false);
    if (!v) {
      this.warn(a, `no hay respiradero en ${x} ${y}`);
      return;
    }
    const rate = Math.trunc((value * this.globals[1]) / 256);
    const ent = v as Entity & { rate?: number };
    const erupted = !ent.rate && value !== 0;
    ent.rate = rate;
    this.emit({ type: 'vent', vent: v, rate, erupted });
  }

  /** setmoney: Petra-7 del respiradero; si no existe se crea (dormido hasta un newrate). */
  private setMoney(x: number, y: number, value: number): void {
    const amount = Math.trunc((value * this.globals[2]) / 256);
    let v = this.ventAt(x, y, false);
    if (!v) {
      const [px, py] = this.centre(x, this.row(y));
      v = this.world.spawn(VENT, NEUTRAL, px, py, { amount: Math.max(1, amount) });
      (v as Entity & { rate?: number }).rate = 0;
    }
    v.amount = Math.max(0, amount);
    this.snap = null;
  }

  /** newtype: el primer objeto no volador de la casilla cambia de tipo (p. ej. baliza 95 -> 84). */
  private newType(x: number, y: number, type: number): void {
    const e = this.entityAt(x, y, (o) => !o.flying && o.kind !== 'vent');
    if (!e || type >= this.world.rules.units.length) return;
    const def = this.world.rules.unit(type);
    const ratio = e.hp / Math.max(1, e.maxHp);
    e.type = type;
    e.def = def;
    e.maxHp = Math.max(1, def.hp);
    e.hp = Math.max(1, e.maxHp * ratio);
    this.world.setAnim(e, STAND, true);
    if (e.anim) e.box = this.world.anims.bounds(e.anim, 0);
  }

  /** waypoint: ruta para la unidad que esté en la casilla (x,y). */
  private waypoint(g: number[]): void {
    const e = this.entityAt(g[0], g[1], (o) => o.kind === 'unit' && o.def.speed > 0);
    if (!e) return;
    const pts: [number, number][] = [];
    for (let k = 0; k < Math.min(g[2], 8); k++) pts.push(this.centre(g[3 + k * 2], this.row(g[4 + k * 2])));
    this.paths.set(e.id, { pts, i: 0, order: null });
  }

  private stepPaths(): void {
    for (const [id, p] of this.paths) {
      const e = this.world.get(id);
      if (!e || !e.alive) {
        this.paths.delete(id);
        continue;
      }
      if (p.order !== null && e.order !== p.order) {
        // otra orden la ha sustituido: si no ha sido la llegada, se abandona la ruta
        if (e.order.type !== 'idle') {
          this.paths.delete(id);
          continue;
        }
      } else if (p.order !== null) continue;
      if (p.i >= p.pts.length) {
        this.paths.delete(id);
        continue;
      }
      const [x, y] = p.pts[p.i];
      this.quietCommand(e, x, y);
      // si la unidad aún no acepta órdenes (saliendo de la ciudad, desplegándose...) se reintenta
      if (e.order.type !== 'attackmove') continue;
      p.i++;
      p.order = e.order;
    }
  }

  /** world.command sin el sonido de confirmación (son unidades movidas por el script). */
  private quietCommand(e: Entity, x: number, y: number): void {
    const hooks = this.world.hooks;
    const sound = hooks.sound;
    if (e.team !== this.world.player) hooks.sound = undefined;
    try {
      this.world.command([e], { type: 'attackmove', x, y });
    } finally {
      hooks.sound = sound;
    }
  }

  private exoIncome(): void {
    for (let p = 0; p < MAX_TEAMS; p++) {
      const t = this.world.teams[p];
      if (!t || !this.exoMoney[p] || !this.building(p, 0)) continue;
      t.money += this.exoMoney[p];
    }
  }

  private stepVision(): void {
    if (!this.sharedVision.size || this.world.tick % 5 !== 0) return;
    const pl = this.world.player;
    for (let t = 0; t < MAX_TEAMS; t++) if (t !== pl && this.sharedVision.get(pl * 16 + t)) this.reveal(t);
  }

  /** Suma a la niebla del jugador lo que ve el equipo `team` (mismo cálculo que World.updateFog). */
  private reveal(team: number): void {
    const w = this.world;
    for (const e of w.ents) {
      if (e.team !== team || !e.alive) continue;
      const r = w.vision(e) + (e.kind === 'building' ? 2 : 0);
      const [cx, cy] = w.tileOf(e.cx, e.cy);
      const r2 = (r + 0.5) ** 2;
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= w.h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= w.w || dx * dx + dy * dy > r2) continue;
          w.fog[y * w.w + x] = 2;
        }
      }
    }
  }

  /** Cola de mensajes (text.c): uno visible; pasa al siguiente cuando caduca el actual. */
  private stepMessages(): void {
    const cur = this.currentMessage;
    if (cur && !cur.expired && this.frame - cur.shownAt > cur.seconds * TPS) cur.expired = true;
    if ((!cur || cur.expired) && this.queue.length) {
      const m = this.queue.shift()!;
      m.shownAt = this.frame;
      this.currentMessage = m;
      this.messageLog.push(m);
      this.world.hooks.message?.(m.text, this.world.player);
      this.emit({ type: 'message', msg: m });
    }
  }

  private stepClock(): void {
    if (!this.ownClock) return;
    if (++this.phase > this.half) {
      this.phase = 0;
      this.night = 1 - this.night;
    }
  }

  // ───────────── estadísticas ─────────────

  private trackMoney(): void {
    for (const t of this.world.teams) {
      if (!t) continue;
      const last = this.lastMoney.get(t.id) ?? t.money;
      if (t.money > last && t.id < 9) this.earned[t.id] += t.money - last;
      this.lastMoney.set(t.id, t.money);
    }
  }

  /** Bajas y muertes (como el código de daño del original, 0x43dfe9). */
  private onKill(v: Entity, by?: Entity): void {
    const vt = v.team;
    if (by && by.team !== vt && by.team < 9) {
      this.kills[by.team]++;
      const k = by.team * 1024 + v.type;
      this.killByType.set(k, (this.killByType.get(k) ?? 0) + 1);
      // bajas cerca del comandante (20 casillas, distancia Manhattan)
      const c = by.team < MAX_TEAMS ? this.commander(by.team) : undefined;
      if (c && Math.abs(c.x - v.x) / TILE + Math.abs(c.y - v.y) / TILE < 20) this.cmdKills[by.team]++;
    }
    if (vt >= 0 && vt < 9) {
      this.losses[vt]++;
      const k = vt * 1024 + v.type;
      this.lossByType.set(k, (this.lossByType.get(k) ?? 0) + 1);
    }
    this.snap = null;
  }

  private snapshot(): Snap {
    if (this.snap) return this.snap;
    const fam = new Uint8Array(9 * 5);
    const units = new Int32Array(9);
    const byType = new Map<number, number>();
    for (const e of this.world.ents) {
      if (!e.alive || e.team < 0 || e.team > 8) continue;
      if (e.kind === 'building') {
        if (e.family >= 0 && e.family < 5) fam[e.team * 5 + e.family] = 1;
        continue;
      }
      if (e.kind === 'vent') continue;
      units[e.team]++;
      const k = e.team * 1024 + e.type;
      byType.set(k, (byType.get(k) ?? 0) + 1);
    }
    return (this.snap = { fam, units, byType });
  }

  /** b(p,k): ranuras de objetos del jugador; 0..4 = edificios de la ciudad, 7..14 = dropships. */
  private building(p: number, k: number): number {
    if (p < 0 || p >= MAX_TEAMS) return 0;
    if (k >= 0 && k < 5) return this.snapshot().fam[p * 5 + k];
    if (k >= 7 && k < 15) return this.dropSlots[p] & (1 << (k - 7)) ? 1 : 0;
    return 0;
  }

  private explored(x: number, y: number, p: number): number {
    const w = this.world;
    const row = w.h - 1 - y;
    if (x < 0 || x >= w.w || row < 0 || row >= w.h || p !== w.player) return 0;
    return w.fog[row * w.w + x] > 0 ? 1 : 0;
  }

  // ───────────── geometría ─────────────

  /** fila de pantalla a partir de la y del original (eje hacia arriba) */
  private row(y: number): number {
    return this.world.h - 1 - y;
  }

  private centre(tx: number, ty: number): [number, number] {
    return [tx * TILE + 16, ty * TILE + 16];
  }

  private tileIndex(e: Entity): number {
    const [tx, ty] = this.world.tileOf(e.x, e.y);
    return ty * this.world.w + tx;
  }

  /** primer objeto vivo en la casilla (x,y) del original que cumple `pred` */
  private entityAt(x: number, y: number, pred: (e: Entity) => boolean): Entity | undefined {
    const ty = this.row(y);
    for (const e of this.world.ents) {
      if (!e.alive || !pred(e)) continue;
      const [ex, ey] = this.world.tileOf(e.x, e.y);
      if (ex === x && ey === ty) return e;
    }
    return undefined;
  }

  private ventAt(x: number, y: number, withPetra: boolean): Entity | undefined {
    return this.entityAt(x, y, (e) => e.kind === 'vent' && (!withPetra || e.amount > 0));
  }

  /** rand() de la biblioteca C (LCG, 15 bits), como la tabla de 256 valores del original */
  private rand(): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return (this.seed >>> 16) & 0x7fff;
  }

  // ───────────── parches sobre World ─────────────

  /** Envuelve world.kill para llevar las bajas por tipo (s(p,0,tipo), s(p,3,tipo)). */
  private patchKill(): void {
    const w = this.world;
    if (typeof w.kill !== 'function') return;
    const had = Object.prototype.hasOwnProperty.call(w, 'kill');
    const own = had ? w.kill : undefined;
    const base = w.kill.bind(w);
    w.kill = (t: Entity, by?: Entity) => {
      if (t.alive && !this.disposed) this.onKill(t, by);
      base(t, by);
    };
    this.patched.push({ name: 'kill', own, had });
  }

  /** Alianzas por parejas de 'ally' por encima de los bandos del mundo. */
  private patchEnemies(): void {
    if (this.patched.some((p) => p.name === 'enemies')) return;
    const w = this.world;
    const had = Object.prototype.hasOwnProperty.call(w, 'enemies');
    const own = had ? w.enemies : undefined;
    const base = w.enemies.bind(w);
    w.enemies = (a: number, b: number) => {
      const o = this.disposed ? undefined : this.allies.get(a * 16 + b);
      if (o === undefined || a === b || a === NEUTRAL || b === NEUTRAL) return base(a, b);
      return !o;
    };
    this.patched.push({ name: 'enemies', own, had });
  }
}

/** Atajo: crea el intérprete a partir de lo que devuelve `loadMission`. */
export function createMissionScript(world: World, data: MissionData, opts: Omit<MissionOptions, 'trip' | 'endTexts'> = {}): MissionScript {
  return new MissionScript(world, data.triggers, data.messages, { ...opts, trip: data.trip, endTexts: data.endTexts });
}

