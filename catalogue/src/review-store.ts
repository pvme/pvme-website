import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stableId } from './detect';
import { atomicWrite } from './output';
import type { Decisions } from './schema';

export const defaultReviewFile = (root: string) => resolve('.local', `reviews-${stableId(resolve(root))}.json`);
export async function readDecisions(path: string): Promise<Decisions> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data.schemaVersion !== 1 || !data.decisions || typeof data.decisions !== 'object') throw new Error('Invalid review decision file');
    const records: Decisions = Object.create(null);
    for (const [id, item] of Object.entries(data.decisions)) {
      const r = item as Decisions[string];
      if (!r || !['reviewed', 'dismissed'].includes(r.decision) || typeof r.sourceHash !== 'string' || typeof r.updatedAt !== 'string') throw new Error('Invalid review decision record');
      records[id] = r;
    }
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as Decisions;
    throw error; // Never silently overwrite a damaged decision store.
  }
}
export async function writeDecisions(path: string, decisions: Decisions) {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, { schemaVersion: 1, decisions });
}
