import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// COOP/COEP make the page cross-origin isolated (SharedArrayBuffer for the audio ring).
// Production hosts should send the same headers; GitHub Pages can't, so public/sw.js adds them.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(Date.now().toString(36)) },
  plugins: [preact()],
  worker: { format: 'es' },
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { target: 'es2022', chunkSizeWarningLimit: 800, rollupOptions: { input: { main: 'index.html', bench: 'bench/kaiser.html' } } },
});
