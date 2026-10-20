// Acceso a los ficheros del juego original, servidos bajo /dc/ (ver gamedata.mjs).

const binCache = new Map<string, Promise<ArrayBuffer>>();

function url(path: string): string {
  return '/dc/' + path.replace(/\\/g, '/').toLowerCase();
}

export function fetchBin(path: string): Promise<ArrayBuffer> {
  const key = path.toLowerCase();
  let p = binCache.get(key);
  if (!p) {
    p = fetch(url(path)).then((r) => {
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
  try {
    await fetchBin(path);
    return true;
  } catch {
    return false;
  }
}

export async function fetchImage(path: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url(path);
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
  const r = await fetch(url(path.replace(/\/?$/, '/')));
  if (!r.ok) return [];
  try {
    return (await r.json()) as string[];
  } catch {
    return [];
  }
}
