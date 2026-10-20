import { defineConfig } from 'vite';
// @ts-expect-error módulo JS sin tipos
import { gameDataMiddleware, dataDir } from './gamedata.mjs';

export default defineConfig({
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
