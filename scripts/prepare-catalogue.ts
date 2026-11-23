import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { generate } from '../catalogue/src/catalogue';

// Resolve inputs from the website root, including workspace commands.
const project = fileURLToPath(new URL('../', import.meta.url));
const catalogueRequire = createRequire(
  new URL('../catalogue/package.json', import.meta.url),
);
if (existsSync(resolve(project, '.env')))
  process.loadEnvFile(resolve(project, '.env'));
const root = resolve(project, process.env.GUIDES_DIR || '../pvme-guides');
const args = process.argv.slice(2);
if (
  args.some(
    (arg) => !['--force', '--include-excluded', '--inspect'].includes(arg),
  )
)
  throw new Error('Usage: npm run catalogue -- [--force] [--include-excluded]');

if (args.includes('--inspect')) {
  const result = spawnSync(
    process.execPath,
    [
      resolve(
        dirname(catalogueRequire.resolve('vite/package.json')),
        'bin/vite.js',
      ),
      '--configLoader',
      'runner',
      '--host',
      '127.0.0.1',
    ],
    {
      cwd: resolve(project, 'catalogue'),
      env: {
        ...process.env,
        GUIDES_DIR: root,
        ...(process.env.CATALOGUE_FILE
          ? { CATALOGUE_FILE: resolve(project, process.env.CATALOGUE_FILE) }
          : {}),
      },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  const file = resolve(
    project,
    process.env.CATALOGUE_FILE || 'catalogue/public/data/catalogue.json',
  );
  // The generator writes a fixed filename together with its inspector/audit exports.
  if (!file.endsWith('catalogue.json'))
    throw new Error(
      'CATALOGUE_FILE must end in catalogue.json for catalogue generation.',
    );
  // Use the inspector's working directory for review state.
  process.chdir(resolve(project, 'catalogue'));
  const result = await generate({
    root,
    output: dirname(file),
    cacheDir: resolve(project, 'catalogue/.cache'),
    force: args.includes('--force'),
    includeExcluded: args.includes('--include-excluded'),
  });
  console.log(
    JSON.stringify({ ...result.stats, run: result.run, output: file }, null, 2),
  );
  console.log(
    `Quick Reference: ${result.quickReferences?.length ?? 0} topics; ${result.referenceAudit?.excluded.length ?? 0} exclusions; ${result.referenceAudit?.warnings.length ?? 0} placeholder/channel findings. Review ${resolve(dirname(file), 'reference-audit.json')}.`,
  );
}
