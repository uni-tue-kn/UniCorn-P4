import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    host: '0.0.0.0', port: 3000,
    proxy: {
      '/api': { target: process.env.BACKEND_URL || 'http://127.0.0.1:5000', rewrite: path => path.replace(/^\/api/, '') },
      '/netsim': { target: process.env.NETSIM_URL || 'http://127.0.0.1:5001', ws: true, rewrite: path => path.replace(/^\/netsim/, '') },
    },
  },
  test: { environment: 'jsdom', setupFiles: './src/setupTests.jsx', css: false, restoreMocks: true, maxWorkers: 2, testTimeout: 10000 },
});
