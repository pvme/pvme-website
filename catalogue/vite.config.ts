import { dirname, resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { localEditor } from './src/local/api';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'GUIDES_DIR');
  return {
    build: { target: 'es2022' },
    server: { host: '127.0.0.1', cors: false },
    plugins: [localEditor({ root: resolve(process.env.GUIDES_DIR || env.GUIDES_DIR || '../../pvme-guides'), output: process.env.CATALOGUE_FILE ? dirname(process.env.CATALOGUE_FILE) : 'public/data' })],
  };
});
