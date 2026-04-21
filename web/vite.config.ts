import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  resolve: {
    alias: {
      '@rocchat/shared': resolve(__dirname, '../shared'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: {
      // Disable the inline polyfill injection so no inline scripts appear in
      // the built HTML. All supported browsers have native modulepreload.
      polyfill: false,
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
