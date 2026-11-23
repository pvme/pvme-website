import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, readFile, link, unlink, open, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseGuide } from '@pvme/guide-parser';
import { isMap, isScalar, parseDocument } from 'yaml';

export class LocalError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export const hashBytes = (source: Buffer) => createHash('sha256').update(source).digest('hex');
export function validateSegment(value: string) {
  if (!value || value === '.' || value === '..' || value.length > 200 || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) || value.startsWith('.')) throw new LocalError('Use a normal filename/folder name without reserved characters, hidden names, or traversal.');
}
export function validateRelative(path: string, file = true) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\') || path.length > 1000 || (file && !path.endsWith('.txt'))) throw new LocalError('Use a repository-relative path with / separators and a .txt extension.');
  if (!file && path === '') return;
  for (const segment of path.split('/')) validateSegment(segment);
}
export async function safePath(root: string, path: string, kind: 'file' | 'folder' | 'new-file' = 'file'): Promise<string> {
  validateRelative(path, kind !== 'folder');
  const canonicalRoot = await realpath(root);
  if ((await lstat(root)).isSymbolicLink() || canonicalRoot.toLowerCase() !== resolve(root).toLowerCase()) throw new LocalError('The configured repository root changed or is a symlink. Restart the inspector with its real directory.');
  const target = resolve(canonicalRoot, path);
  const rel = relative(canonicalRoot, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new LocalError('Path escapes the configured repository.');
  let current = canonicalRoot;
  const parts = path ? path.split('/') : [];
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const last = i === parts.length - 1;
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && last && kind === 'new-file') return target;
      throw new LocalError('Source file or destination folder no longer exists.', 409);
    }
    if (stat.isSymbolicLink() || (await realpath(current)).toLowerCase() !== resolve(current).toLowerCase()) throw new LocalError('Symlinks and junctions are not allowed in edit paths.');
    if (!last && !stat.isDirectory()) throw new LocalError('A parent path is not a directory.');
    if (last && kind === 'new-file') throw new LocalError('A file or directory already exists at the destination.', 409);
    if (last && kind === 'file' && !stat.isFile()) throw new LocalError('Source must be a regular .txt file.');
    if (last && kind === 'folder' && !stat.isDirectory()) throw new LocalError('Destination must be an existing directory.');
  }
  return target;
}
export async function existingFolders(root: string): Promise<string[]> {
  const result = [''];
  async function visit(prefix: string) {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      try { await safePath(root, path, 'folder'); } catch { continue; }
      result.push(path); await visit(path);
    }
  }
  await visit(''); return result.sort();
}
export interface ReferenceHit { path: string; line: number; text: string }
export async function pathReferences(root: string, sourcePath: string): Promise<ReferenceHit[]> {
  const hits: ReferenceHit[] = [];
  const needles = [sourcePath, sourcePath.replaceAll('/', '\\'), encodeURI(sourcePath), sourcePath.replace(/\.txt$/, '')];
  async function visit(prefix: string) {
    for (const e of await readdir(join(root, prefix), { withFileTypes: true })) {
      if (e.isSymbolicLink() || e.name === '.git' || e.name === 'node_modules') continue;
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      // Reference reads include hidden config folders, but never follow symlinks.
      if (e.isDirectory()) { await visit(path); continue; }
      if (!e.isFile() || path === sourcePath) continue;
      const bytes = await readFile(join(root, path));
      if (bytes.includes(0)) continue;
      const lines = bytes.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i];
        // Also catch same-folder filename references. This may over-warn, so
        // hits are presented as potential references, never rewritten.
        if ([...needles, basename(sourcePath)].some(n => text.toLowerCase().includes(n.toLowerCase()))) hits.push({ path, line: i + 1, text: text.slice(0, 400) });
      }
    }
  }
  await visit(''); return hits;
}
export interface FrontmatterParts { yaml: string; body: Buffer; hasFrontmatter: boolean; eol: string }
export function splitFrontmatter(source: Buffer): FrontmatterParts {
  const text = source.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(source)) throw new LocalError('Metadata editing requires valid UTF-8; source bytes were not changed.');
  if (text.startsWith('\uFEFF')) throw new LocalError('A UTF-8 BOM is present. Inspect the source encoding in VS Code before editing metadata.');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const start = /^(?:---)(?:\r?\n|$)/.exec(text);
  if (!start) return { yaml: '', body: source, hasFrontmatter: false, eol };
  const close = /^---(?:\r?\n|$)/gm;
  close.lastIndex = start[0].length;
  const match = close.exec(text);
  if (!match) throw new LocalError('Frontmatter is unclosed. Close the existing block in VS Code before using this editor.');
  const offset = Buffer.byteLength(text.slice(0, match.index + match[0].length), 'utf8');
  return { yaml: text.slice(start[0].length, match.index).replace(/\r?\n$/, ''), body: source.subarray(offset), hasFrontmatter: true, eol };
}
const metadataDiagnostics = (source: string) => parseGuide(source).diagnostics.filter(d => d.code.includes('FRONTMATTER'));
export function replaceMetadata(source: Buffer, yaml: string | null): Buffer {
  const parts = splitFrontmatter(source);
  if (yaml === null || !yaml.trim()) return parts.body;
  if (Buffer.byteLength(yaml) > 64 * 1024 || /^---\s*$/m.test(yaml)) throw new LocalError('Enter metadata fields without --- delimiters (maximum 64 KiB).');
  // Only frontmatter line endings are normalized; the body Buffer is untouched.
  const normalized = yaml.replace(/\r?\n/g, parts.eol).replace(/(?:\r?\n)+$/, '');
  const header = `---${parts.eol}${normalized}${parts.eol}---${parts.eol}`;
  const errors = metadataDiagnostics(header);
  if (errors.length) throw new LocalError(`Invalid YAML: ${errors.map(e => e.message).join(' ')}`);
  return Buffer.concat([Buffer.from(header), parts.body]);
}
export type MetadataPatch = Record<string, string | string[] | null>;
export function patchMetadata(source: Buffer, patch: MetadataPatch): string | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new LocalError('Metadata patch must be an object of optional field changes.');
  const parts = splitFrontmatter(source);
  if (parts.hasFrontmatter && metadataDiagnostics(`---\n${parts.yaml}\n---\n`).length) throw new LocalError('Existing metadata is invalid; repair it in the advanced YAML editor first.');
  const doc = parseDocument(parts.hasFrontmatter ? parts.yaml : '{}');
  for (const [key, value] of Object.entries(patch)) {
    if (!['title', 'category', 'boss', 'creature', 'subject', 'styles'].includes(key)) throw new LocalError('Unsupported simple metadata field. Use the advanced YAML editor.');
    if (value === null) {
      // YAML attaches a preceding comment to the next key. Preserve such
      // comments at the document end when that optional field is removed.
      const pair = isMap(doc.contents) ? doc.contents.items.find(p => isScalar(p.key) && p.key.value === key) : undefined;
      const comments = [pair?.key, pair?.value].flatMap(node => node ? [node.commentBefore, node.comment].filter((v): v is string => typeof v === 'string') : []);
      if (comments.length) doc.comment = [doc.comment, ...comments].filter(Boolean).join('\n');
      doc.delete(key);
    }
    else if (key === 'styles' ? Array.isArray(value) && value.every(v => typeof v === 'string') : typeof value === 'string') doc.set(key, value);
    else throw new LocalError('Invalid metadata field value.');
  }
  const yaml = doc.toString();
  replaceMetadata(source, yaml); // Validate with the published guide parser too.
  return yaml;
}
export async function relocate(root: string, from: string, to: string, expectedHash: string) {
  const source = await safePath(root, from);
  const target = await safePath(root, to, 'new-file');
  if (hashBytes(await readFile(source)) !== expectedHash) throw new LocalError('Source changed after preview. Create a new preview.', 409);
  // Hard-link creation is exclusive: unlike rename(), it cannot overwrite a
  // destination that appears between the collision check and the operation.
  await link(source, target);
  try { await unlink(source); }
  catch (error) { await unlink(target); throw error; }
}
export async function writeMetadata(root: string, path: string, bytes: Buffer, expectedHash: string) {
  const source = await safePath(root, path);
  const stat = await lstat(source);
  if (hashBytes(await readFile(source)) !== expectedHash) throw new LocalError('Source changed after preview. Create a new preview.', 409);
  const temporary = join(dirname(source), `.catalogue-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', stat.mode);
  try {
    await file.writeFile(bytes); await file.sync(); await file.close();
    await safePath(root, path);
    if (hashBytes(await readFile(source)) !== expectedHash) throw new LocalError('Source changed during the edit. Create a new preview.', 409);
    await rename(temporary, source);
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
