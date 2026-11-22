import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `npm run dev` serves the app on :5173 and forwards API, media and the live
// socket to the dashboard container on :80.
const backend = process.env.DASHBOARD_URL || 'http://localhost';

export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api/v1/live': { target: backend.replace(/^http/, 'ws'), ws: true },
      '/api': backend,
      '/media': backend,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
