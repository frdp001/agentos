import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Relative base is required because Electron loads the bundle via file://.
export default defineConfig({
  root: path.resolve(__dirname, 'renderer'),
  base: './',
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, 'renderer', 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome120',
  },
});
