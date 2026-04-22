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
    sourcemap: 'hidden', // Upload to error tracker; not exposed to users
    target: 'es2022',    // Modern browsers only — smaller output
    rollupOptions: {
      output: {
        manualChunks: {
          // Split crypto into its own chunk — it's large and cached long-term
          crypto: [
            './src/crypto/session-manager.ts',
            './src/crypto/group-session-manager.ts',
            './src/crypto/client-crypto.ts',
            './src/crypto/profile-crypto.ts',
            './src/crypto/secure-store.ts',
          ],
        },
      },
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
