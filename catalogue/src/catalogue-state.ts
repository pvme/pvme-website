import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { atomicWrite } from './output';
import type { Guide, Issue, Resolution, SavedChange } from './schema';

export interface CatalogueState {
  schemaVersion: 1;
  snapshots: Record<string, { title: string; issues: { issue: Issue; key: string }[] }>;
  resolutions: Resolution[];
  changes: SavedChange[];
}
export const defaultStateFile = (root: string) => resolve('.local', `catalogue-${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16)}.json`);
export async function readCatalogueState(file: string): Promise<CatalogueState> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.schemaVersion !== 1 || !value.snapshots || typeof value.snapshots !== 'object' || Array.isArray(value.snapshots) || !Array.isArray(value.resolutions) || !Array.isArray(value.changes)) throw new Error('Invalid saved catalogue state. Restore the state file before continuing.');
    for (const item of Object.values(value.snapshots) as CatalogueState['snapshots'][string][]) if (!item || typeof item.title !== 'string' || !Array.isArray(item.issues) || item.issues.some(i => !i.issue || typeof i.key !== 'string')) throw new Error('Invalid saved issue history.');
    if (value.resolutions.some((r: Resolution) => !r?.issue || typeof r.path !== 'string' || typeof r.key !== 'string' || typeof r.resolvedAt !== 'string') || value.changes.some((c: SavedChange) => !c || typeof c.id !== 'string' || typeof c.savedAt !== 'string' || typeof c.to !== 'string')) throw new Error('Invalid saved change history.');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, snapshots: {}, resolutions: [], changes: [] };
    throw error;
  }
}
export async function writeCatalogueState(file: string, state: CatalogueState) {
  await mkdir(dirname(file), { recursive: true });
  await atomicWrite(file, state);
}
export function issueKey(guide: Guide, issue: Issue): string {
  const method = [...guide.methods, ...(guide.inspectionCandidates ?? [])].find(m => m.id === issue.methodId);
  return JSON.stringify([issue.type, issue.message, method?.heading.label ?? '', method?.heading.parents ?? []]);
}
export function recordResolutions(state: CatalogueState, guides: Guide[], now = new Date().toISOString()) {
  for (const guide of guides) {
    const issues = guide.issues.map(issue => ({ issue, key: issueKey(guide, issue) }));
    const keys = new Set(issues.map(i => i.key));
    for (const prior of state.snapshots[guide.path]?.issues ?? []) {
      if (keys.has(prior.key)) continue;
      const existing = state.resolutions.find(r => r.path === guide.path && r.key === prior.key && !r.reopenedAt);
      if (!existing) state.resolutions.push({ id: `${prior.issue.id}:${now}`, path: guide.path, title: guide.title, key: prior.key, issue: prior.issue, resolvedAt: now });
    }
    for (const saved of state.resolutions) if (saved.path === guide.path && !saved.reopenedAt && keys.has(saved.key)) saved.reopenedAt = now;
    state.snapshots[guide.path] = { title: guide.title, issues };
  }
  // Missing/deleted guides are not proof that their issues were fixed.
  const paths = new Set(guides.map(g => g.path));
  for (const path of Object.keys(state.snapshots)) if (!paths.has(path)) delete state.snapshots[path];
}
