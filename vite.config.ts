import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist/client',
    sourcemap: true,
    chunkSizeWarningLimit: 1200
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/oauth': { target: 'http://127.0.0.1:3000', changeOrigin: true }
    }
  }
});
