import { defineConfig } from 'astro/config';
import { existsSync } from 'node:fs';
import { developmentInlineEditing } from './scripts/dev-inline-editing.mjs';
if (existsSync('.env')) process.loadEnvFile('.env');
export default defineConfig({
  vite: {
    plugins:
      process.env.PVME_INLINE_EDITING === '1'
        ? [developmentInlineEditing()]
        : [],
  },
  output: 'static',
  site: process.env.SITE_URL || 'https://pvme.github.io',
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'always',
});
