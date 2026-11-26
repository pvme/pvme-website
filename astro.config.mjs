import { defineConfig } from 'astro/config';
import { existsSync } from 'node:fs';
import { loadEnv } from 'vite';
import { guideApiProxy } from './scripts/guide-api-proxy.mjs';
if (existsSync('.env')) process.loadEnvFile('.env');
export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL || 'https://pvme.github.io',
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'always',
  server: { host: 'localhost', port: 4321 },
  vite: {
    plugins: [
      guideApiProxy({
        ...loadEnv('development', process.cwd(), 'PVME_'),
        ...process.env,
      }),
    ],
    server: { strictPort: true },
  },
});
