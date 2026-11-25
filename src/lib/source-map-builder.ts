import { createHash } from 'node:crypto';
import {
  applyInlineEdits,
  type GuideDocument,
  type InlineNode,
  type BlockNode,
  type InlineEdit,
} from '@pvme/guide-parser';
import type { EditableEntry, GuideSourceMap } from './source-map';

export const sourceFingerprint = (source: string) =>
  createHash('sha256').update(source, 'utf8').digest('hex');

/** Identity, not matching offsets, establishes provenance. Derived parses/clones fail closed. */
export function createSourceMapper(doc: GuideDocument, path: string) {
  if (
    !path ||
    /[\\\u0000-\u001f]/.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    /^[a-z]:/i.test(path)
  )
    throw new Error('Expected repository-relative guide path');
  const original = new WeakSet<InlineNode>();
  const visitInline = (nodes: InlineNode[]) => {
    for (const node of nodes) {
      original.add(node);
      // Link children are exclusively addressed through link-label.
      if ('children' in node && node.type !== 'link' && node.type !== 'image')
        visitInline(node.children);
    }
  };
  const visitBlocks = (blocks: BlockNode[]) => {
    for (const block of blocks) {
      if (block.type === 'list')
        block.items.forEach((item) => visitBlocks(item.children));
      else if (block.type === 'blockquote') visitBlocks(block.children);
      else if (
        ['paragraph', 'heading', 'subtext'].includes(block.type) &&
        'children' in block
      )
        visitInline(block.children as InlineNode[]);
    }
  };
  doc.messages.forEach((message) => visitBlocks(message.blocks));
  const candidates = new Map<string, EditableEntry>();
  const reference = (node: InlineNode, kind: InlineEdit['kind']): string => {
    if (!original.has(node)) return '';
    const range =
      kind === 'text'
        ? node.range
        : 'urlRange' in node
          ? kind === 'link-url'
            ? node.urlRange
            : node.labelRange
          : undefined;
    const value =
      node.type === 'text'
        ? node.value
        : node.type === 'link'
          ? kind === 'link-url'
            ? node.url
            : node.children.length === 1 && node.children[0].type === 'text'
              ? node.children[0].value
              : ''
          : '';
    if (!range || !value.trim()) return '';
    const id = `${kind}-${range.start.offset}-${range.end.offset}`;
    candidates.set(id, { id, kind, range, value });
    return ` data-edit-${kind === 'link-url' ? 'url' : 'ref'}="${id}"`;
  };
  const finish = (
    html: string,
  ): { html: string; sourceMap: GuideSourceMap } => {
    const used = new Set(
      Array.from(
        html.matchAll(/ data-edit-(?:ref|url)="([^"]+)"/g),
        (m) => m[1],
      ),
    );
    const entries: EditableEntry[] = [];
    // Let the parser establish eligibility, including ambiguous ranges and protected syntax.
    // Batch no-op validation avoids reparsing a large guide for every text leaf.
    const validate = (batch: EditableEntry[]) => {
      if (!batch.length) return;
      try {
        if (
          applyInlineEdits(
            doc.source,
            batch.map((entry) => ({
              kind: entry.kind,
              range: entry.range,
              replacement: entry.value,
            })),
          ) !== doc.source
        )
          throw new Error('No-op changed source');
        entries.push(...batch);
      } catch {
        if (batch.length > 1) {
          const middle = Math.floor(batch.length / 2);
          validate(batch.slice(0, middle));
          validate(batch.slice(middle));
        }
      }
    };
    // Remove all conflicting candidates, rather than arbitrarily choosing one.
    const sorted = [...candidates.values()]
      .filter((entry) => used.has(entry.id))
      .sort((a, b) => a.range.start.offset - b.range.start.offset);
    const conflicts = new Set<EditableEntry>();
    for (let i = 0; i < sorted.length; i++)
      for (
        let j = i + 1;
        j < sorted.length &&
        sorted[j].range.start.offset < sorted[i].range.end.offset;
        j++
      ) {
        conflicts.add(sorted[i]);
        conflicts.add(sorted[j]);
      }
    validate(sorted.filter((entry) => !conflicts.has(entry)));
    const accepted = new Set(entries.map((entry) => entry.id));
    const seen = new Set<string>();
    html = html.replace(
      /<span data-edit-ref="([^"]+)">([^<]*)<\/span>| data-edit-(?:ref|url)="([^"]+)"/g,
      (
        markup,
        spanId: string | undefined,
        text: string,
        attributeId: string | undefined,
      ) => {
        const id = spanId || attributeId!;
        if (!accepted.has(id) || seen.has(id)) return spanId ? text : '';
        seen.add(id);
        return markup;
      },
    );
    return {
      html,
      sourceMap: {
        schemaVersion: 1,
        path,
        sourceHash: sourceFingerprint(doc.source),
        entries,
      },
    };
  };
  return { reference, finish };
}
