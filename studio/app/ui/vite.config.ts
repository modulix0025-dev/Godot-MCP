import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Tauri serves the built assets from dist/; a fixed dev port lets src-tauri/tauri.conf.json point at it.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom', include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'] },
});
