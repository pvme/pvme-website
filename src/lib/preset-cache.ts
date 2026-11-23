import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
export interface PreviewRecord {
  checkedAt: number;
  path?: string;
  imageUrl?: string;
  width?: number;
  height?: number;
}
const file = resolve('.cache/preset-previews.json');
let stamp = 0;
let records: Record<string, PreviewRecord> = {};
export function presetPreviewCache() {
  const next = existsSync(file) ? statSync(file).mtimeMs : 0;
  if (next !== stamp) {
    stamp = next;
    try {
      records = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      records = {};
    }
  }
  return records;
}
export function previewVersion() {
  presetPreviewCache();
  return stamp;
}
