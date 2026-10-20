// Datos del juego elegidos por el usuario en el navegador (carpeta, ficheros sueltos o un ZIP)
// y su copia en IndexedDB para no tener que pedirlos en cada visita. Nada sale del navegador.
import { unzip } from 'fflate';
import type { LocalFile } from './vfs';

/** Ruta que identifica la raíz de una instalación de Dark Colony. */
const MARKER = 'gamestat/gamestat.txt';
/** Imprescindibles para arrancar. */
const REQUIRED = [MARKER, 'gamestat/weapstat.txt', 'intrface/intro.gif', 'intrface/maine'];
/** Lo que el motor no usa: vídeos y ejecutables. */
const SKIP = /(^|\/)avi\/|\.(exe|dll)$/i;

export interface FileEntry {
  /** ruta relativa tal cual (p. ej. "DCOLONY/SPRITES/TRSC.SPR") */
  path: string;
  blob: Blob;
}

export interface DataSet {
  files: Map<string, LocalFile>;
  missing: string[];
}

/** Localiza la raíz del juego entre las rutas recibidas y construye el mapa de ficheros. */
export function buildFileMap(entries: FileEntry[]): DataSet {
  const clean = entries.map((e) => ({ path: e.path.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, ''), blob: e.blob }));
  let root: string | null = null;
  for (const e of clean) {
    const low = e.path.toLowerCase();
    if (low === MARKER || low.endsWith('/' + MARKER)) {
      const prefix = e.path.slice(0, e.path.length - MARKER.length);
      if (root === null || prefix.length < root.length) root = prefix;
    }
  }
  const files = new Map<string, LocalFile>();
  if (root !== null) {
    const rootLow = root.toLowerCase();
    for (const e of clean) {
      if (!e.path.toLowerCase().startsWith(rootLow)) continue;
      const rel = e.path.slice(root.length);
      if (!rel || SKIP.test(rel)) continue;
      files.set(rel.toLowerCase(), { path: rel, blob: e.blob });
    }
  }
  return { files, missing: REQUIRED.filter((r) => !files.has(r)) };
}

export function entriesFromFileList(list: ArrayLike<File>): FileEntry[] {
  return Array.from(list, (f) => ({ path: f.webkitRelativePath || f.name, blob: f }));
}

export function isZip(f: File): boolean {
  return /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed';
}

export async function entriesFromZip(file: File): Promise<FileEntry[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  const out = await new Promise<Record<string, Uint8Array>>((ok, ko) =>
    unzip(data, { filter: (f) => !f.name.endsWith('/') && !SKIP.test(f.name) }, (err, res) => (err ? ko(err) : ok(res))),
  );
  return Object.entries(out).map(([path, bytes]) => ({ path, blob: new Blob([bytes]) }));
}

/** Lo que se suelta en la ventana: carpetas (recorridas enteras), ficheros sueltos o un ZIP. */
export async function entriesFromDrop(dt: DataTransfer): Promise<FileEntry[]> {
  const roots = Array.from(dt.items)
    .map((it) => it.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (!roots.length) {
    const files = Array.from(dt.files);
    return files.length === 1 && isZip(files[0]) ? entriesFromZip(files[0]) : entriesFromFileList(files);
  }
  const out: FileEntry[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((ok, ko) => (entry as FileSystemFileEntry).file(ok, ko));
      if (isZip(file) && roots.length === 1) out.push(...(await entriesFromZip(file)));
      else out.push({ path: prefix + entry.name, blob: file });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries devuelve los hijos por tandas hasta una tanda vacía
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((ok, ko) => reader.readEntries(ok, ko));
      if (!batch.length) break;
      for (const child of batch) await walk(child, prefix + entry.name + '/');
    }
  };
  for (const r of roots) await walk(r, '');
  return out;
}

// --- copia en IndexedDB ---

const DB = 'open-dark-colony-data';
const STORE = 'files';

function openDb(): Promise<IDBDatabase> {
  return new Promise((ok, ko) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => ko(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((ok, ko) => {
    tx.oncomplete = () => ok();
    tx.onerror = tx.onabort = () => ko(tx.error);
  });
}

export async function saveCachedFiles(files: Map<string, LocalFile>): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.clear();
    for (const [key, f] of files) store.put(f, key);
    await done(tx);
    db.close();
    return true;
  } catch (err) {
    console.warn('no se pudieron guardar los datos del juego en el navegador', err);
    return false;
  }
}

export async function loadCachedFiles(): Promise<Map<string, LocalFile> | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const [keys, values] = await Promise.all([
      new Promise<IDBValidKey[]>((ok, ko) => {
        const r = store.getAllKeys();
        r.onsuccess = () => ok(r.result);
        r.onerror = () => ko(r.error);
      }),
      new Promise<LocalFile[]>((ok, ko) => {
        const r = store.getAll();
        r.onsuccess = () => ok(r.result as LocalFile[]);
        r.onerror = () => ko(r.error);
      }),
    ]);
    db.close();
    const files = new Map<string, LocalFile>();
    keys.forEach((k, i) => files.set(String(k), values[i]));
    return REQUIRED.every((r) => files.has(r)) ? files : null;
  } catch {
    return null;
  }
}

export async function clearCachedFiles(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await done(tx);
    db.close();
  } catch {
    /* sin IndexedDB no hay nada que borrar */
  }
}
