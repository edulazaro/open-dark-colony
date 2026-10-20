// Acceso a los ficheros del juego original. Dos orígenes:
// - el servidor (npm run dev / npm start), que los sirve bajo /dc/ (ver gamedata.mjs);
// - ficheros que el usuario elige en el navegador (carpeta o ZIP), para la versión estática
//   de GitHub Pages. Se leen en local y nunca salen del navegador (ver data/local.ts).

/** Fichero local: nombre tal cual en disco y contenido. Clave del mapa: ruta en minúsculas. */
export interface LocalFile {
  path: string;
  blob: Blob;
}

const binCache = new Map<string, Promise<ArrayBuffer>>();
const objectUrls = new Map<string, string>();
let local: Map<string, LocalFile> | null = null;

function norm(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function url(path: string): string {
  return '/dc/' + norm(path);
}

/** Usa a partir de ahora los ficheros elegidos por el usuario en vez del servidor. */
export function useLocalFiles(files: Map<string, LocalFile>): void {
  local = files;
  binCache.clear();
  for (const u of objectUrls.values()) URL.revokeObjectURL(u);
  objectUrls.clear();
}

export function usingLocalFiles(): boolean {
  return local !== null;
}

/** ¿Sirve el servidor los datos del juego? (falso en GitHub Pages o sin instalación) */
export async function serverHasData(): Promise<boolean> {
  try {
    const r = await fetch(url('gamestat/gamestat.txt'));
    if (!r.ok) return false;
    // un servidor estático puede devolver index.html para cualquier ruta
    return !(r.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

function localBlob(path: string): Blob {
  const f = local?.get(norm(path));
  if (!f) throw new Error(`No se pudo cargar ${path} (no está en los ficheros elegidos)`);
  return f.blob;
}

export function fetchBin(path: string): Promise<ArrayBuffer> {
  const key = norm(path);
  let p = binCache.get(key);
  if (!p) {
    p = local
      ? Promise.resolve().then(() => localBlob(path).arrayBuffer())
      : fetch(url(path)).then((r) => {
          if (!r.ok) throw new Error(`No se pudo cargar ${path} (${r.status})`);
          return r.arrayBuffer();
        });
    binCache.set(key, p);
    p.catch(() => binCache.delete(key));
  }
  return p;
}

export async function fetchText(path: string): Promise<string> {
  const buf = await fetchBin(path);
  return new TextDecoder('latin1').decode(buf);
}

export async function exists(path: string): Promise<boolean> {
  if (local) return local.has(norm(path));
  try {
    await fetchBin(path);
    return true;
  } catch {
    return false;
  }
}

/** URL para <img> o <audio>: la del servidor o un blob: del fichero local. */
export function fileUrl(path: string): string {
  if (!local) return url(path);
  const key = norm(path);
  let u = objectUrls.get(key);
  if (!u) {
    u = URL.createObjectURL(localBlob(path));
    objectUrls.set(key, u);
  }
  return u;
}

export async function fetchImage(path: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = fileUrl(path);
  await img.decode();
  return img;
}

/** Lee un fichero de texto del juego y lo parte en líneas, quitando comentarios '%'. */
export function dataLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => {
      const i = l.indexOf('%');
      return (i >= 0 ? l.slice(0, i) : l).trim();
    })
    .filter((l) => l.length > 0);
}

/** Lista un directorio del juego (nombres tal cual en disco). */
export async function listDir(path: string): Promise<string[]> {
  if (local) {
    const dir = norm(path).replace(/\/?$/, '/');
    const names = new Set<string>();
    for (const [key, f] of local) {
      if (!key.startsWith(dir)) continue;
      const rest = f.path.slice(dir.length);
      names.add(rest.split('/')[0]);
    }
    return [...names];
  }
  const r = await fetch(url(path.replace(/\/?$/, '/')));
  if (!r.ok) return [];
  try {
    return (await r.json()) as string[];
  } catch {
    return [];
  }
}
