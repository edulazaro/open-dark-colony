// Servidor mínimo para la versión compilada (npm run build && npm start).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { gameDataMiddleware, dataDir } from './gamedata.mjs';

const dist = path.resolve('dist');
const port = Number(process.env.PORT || 8080);
const data = gameDataMiddleware();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

http
  .createServer((req, res) => {
    data(req, res, () => {
      let p = path.join(dist, decodeURIComponent((req.url || '/').split('?')[0]));
      if (!p.startsWith(dist) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(dist, 'index.html');
      res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
      fs.createReadStream(p).pipe(res);
    });
  })
  .listen(port, () => console.log(`Open Dark Colony en http://localhost:${port}  (datos: ${dataDir()})`));
