import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { generate } from './catalogue';
try { loadEnvFile('.env'); } catch { /* Optional configuration. */ }
const args = process.argv.slice(2);
const allowed = new Set(['--force', '--include-excluded']);
if (args.some(a => !allowed.has(a))) { console.error('Usage: npm run catalogue -- [--force] [--include-excluded]'); process.exitCode = 1; }
else {
  try {
    const result = await generate({ root: resolve(process.env.GUIDES_DIR || '../../pvme-guides'), force: args.includes('--force'), includeExcluded: args.includes('--include-excluded') });
    console.log(JSON.stringify({ ...result.stats, reviewSummary: result.reviewSummary, run: result.run, output: 'public/data/{catalogue.json,inspector.json,audit.json,audit.md}' }, null, 2));
  } catch (error) { console.error(`Catalogue generation failed: ${String(error)}`); process.exitCode = 1; }
}
