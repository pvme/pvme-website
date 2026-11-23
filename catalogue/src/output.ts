import { rename, writeFile } from 'node:fs/promises';

export async function atomicWrite(path: string, data: unknown, raw = false) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, raw ? String(data) : JSON.stringify(data, null, 2) + '\n', 'utf8');
  await rename(temporary, path);
}
