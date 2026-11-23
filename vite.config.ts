import { rmSync } from 'fs';
import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

import { originForApiServer } from './dev/dev-proxy.js';

const apiTarget = process.env.VITE_DIFIT_API_URL || 'http://localhost:4966';

const apiProxy: ProxyOptions = {
  target: apiTarget,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq, req) => {
      const origin = originForApiServer({
        origin: req.headers.origin,
        host: req.headers.host,
        target: apiTarget,
      });
      if (origin !== undefined) {
        proxyReq.setHeader('origin', origin);
      }
    });
  },
};

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'remove-site-data-from-client-build',
      closeBundle() {
        rmSync(resolve(__dirname, 'dist/client/site-data'), { recursive: true, force: true });
      },
    },
  ],
  root: 'src/client',
  publicDir: '../../public',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/types': resolve(__dirname, 'src/types'),
    },
  },
  css: {
    postcss: './postcss.config.js',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiProxy,
      '^/s/[0-9a-f]{16}/api/': apiProxy,
    },
  },
});
