import { defineConfig } from 'vite';
// @ts-expect-error módulo JS sin tipos
import { gameDataMiddleware, dataDir } from './gamedata.mjs';

export default defineConfig({
  // rutas relativas: la versión compilada funciona igual en la raíz o en
  // https://<usuario>.github.io/open-dark-colony/
  base: './',
  server: { port: 5173 },
  plugins: [
    {
      name: 'dark-colony-data',
      configureServer(server) {
        console.log('[dc] datos del juego en', dataDir());
        server.middlewares.use(gameDataMiddleware());
      },
      configurePreviewServer(server) {
        server.middlewares.use(gameDataMiddleware());
      },
    },
  ],
});
