import type { InlineEdit } from '@pvme/guide-parser';

export interface EditableEntry {
  id: string;
  kind: InlineEdit['kind'];
  range: InlineEdit['range'];
  /** Interpreted text, or the original literal URL (never a resolved href). */
  value: string;
}

export interface GuideSourceMap {
  schemaVersion: 1;
  /** Repository-relative path in pvme-guides. */
  path: string;
  /** Lowercase SHA-256 hex of the exact original UTF-8 source. */
  sourceHash: string;
  entries: EditableEntry[];
}

/** Browser-compatible; a mismatch makes every entry unusable. Requires HTTPS/localhost. */
export async function verifySourceVersion(
  source: string,
  map: Pick<GuideSourceMap, 'schemaVersion' | 'sourceHash'>,
): Promise<boolean> {
  if (map.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(map.sourceHash))
    return false;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  );
  const hash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  return hash === map.sourceHash;
}

/** Safe inside an inert application/json script, including hostile closing tags. */
export function serializeSourceMap(map: GuideSourceMap): string {
  return JSON.stringify(map).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
