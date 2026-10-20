// Sirve los ficheros del juego original (Dark Colony) bajo la ruta /dc/.
// Los nombres del juego son de MS-DOS (mayúsculas, sin distinguir), así que la
// búsqueda es insensible a mayúsculas para que funcione también fuera de Windows.
import fs from 'node:fs';
import path from 'node:path';

export function dataDir() {
  const fromEnv = process.env.DC_DATA;
  const candidates = [fromEnv, 'C:/code/DCOLONY', path.resolve('../DCOLONY'), path.resolve('DCOLONY')].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'GAMESTAT'))) return c;
  }
  return fromEnv || 'C:/code/DCOLONY';
}

const dirCache = new Map();
function listDir(dir) {
  let m = dirCache.get(dir);
  if (!m) {
    m = new Map();
    try {
      for (const name of fs.readdirSync(dir)) m.set(name.toLowerCase(), name);
    } catch {
      /* directorio inexistente */
    }
    dirCache.set(dir, m);
  }
  return m;
}

/** Resuelve una ruta relativa del juego ("sprites/trsc.spr") a un fichero real, sin distinguir mayúsculas. */
export function resolveGameFile(root, rel) {
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..');
  let cur = root;
  for (const p of parts) {
    const real = listDir(cur).get(p.toLowerCase());
    if (!real) return null;
    cur = path.join(cur, real);
  }
  return cur;
}

const MIME = { '.gif': 'image/gif', '.bmp': 'image/bmp', '.wav': 'audio/wav', '.avi': 'video/x-msvideo' };

/** Middleware connect/express: GET /dc/<ruta> */
export function gameDataMiddleware(root = dataDir()) {
  return (req, res, next) => {
    if (!req.url || !req.url.startsWith('/dc/')) return next();
    const rel = decodeURIComponent(req.url.slice(4).split('?')[0]);
    const file = resolveGameFile(root, rel);
    if (file && fs.statSync(file).isDirectory()) {
      // listado de un directorio (p. ej. los mapas multijugador)
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(fs.readdirSync(file)));
      return;
    }
    if (!file || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      res.end('not found: ' + rel);
      return;
    }
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'max-age=3600');
    fs.createReadStream(file).pipe(res);
  };
}
