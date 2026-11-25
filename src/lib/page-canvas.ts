import { patchJsonProperty, jsonSource } from './json-source';
import {
  parseGuide,
  applySourceEdits,
  type BlockNode,
  type InlineNode,
} from '@pvme/guide-parser';

export type CanvasKind =
  | 'text'
  | 'heading'
  | 'list'
  | 'embed'
  | 'image'
  | 'preset'
  | 'video'
  | 'code'
  | 'divider'
  | 'settings'
  | 'source';
export interface CanvasBlock {
  id: string;
  kind: CanvasKind;
  start: number;
  end: number;
  source: string;
  node?: BlockNode;
}
export interface CanvasMessage extends CanvasBlock {
  blocks: CanvasBlock[];
}

/** Explicit parser-owned separators delimit the author's original messages.
 * Attachment-induced preview messages must not split the editing unit. */
export function canvasMessages(source: string): CanvasMessage[] {
  const parsed = parseGuide(source);
  const blocks = canvasBlocks(source);
  const frontmatter =
    /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source)?.[0]
      .length || 0;
  const result: CanvasMessage[] = [];
  let start = frontmatter;
  for (const boundary of [
    ...parsed.separators,
    { start: { offset: source.length }, end: { offset: source.length } },
  ]) {
    const end = boundary.start.offset;
    const members = blocks.filter(
      (block) =>
        block.kind !== 'divider' && block.start >= start && block.end <= end,
    );
    if (source.slice(start, end).trim())
      result.push({
        id: `message-${start}-${end}`,
        kind: 'text',
        start,
        end,
        source: source.slice(start, end),
        blocks: members,
      });
    start = boundary.end.offset;
    // The separator's own line ending is structural, rather than an empty
    // text row at the beginning of the next editable message.
    start += source.slice(start).match(/^(?:\r\n|\n|\r)/)?.[0].length || 0;
  }
  return result;
}
export const canvasLabels: Record<CanvasKind, string> = {
  text: 'Text',
  heading: 'Heading',
  list: 'Bullet list',
  embed: 'Embed',
  image: 'Image',
  preset: 'Preset',
  video: 'Video',
  code: 'Code',
  divider: 'Message break',
  settings: 'Guide settings',
  source: 'Source section',
};
export const canvasPalette: CanvasKind[] = [
  'text',
  'heading',
  'list',
  'image',
  'preset',
  'video',
  'embed',
  'code',
  'divider',
];
export const sourceEol = (source: string) =>
  source.includes('\r\n') ? '\r\n' : '\n';

export function inlineNodes(block: BlockNode): InlineNode[] {
  if (block.type === 'list')
    return block.items.flatMap((item) => item.children.flatMap(inlineNodes));
  if (block.type === 'blockquote') return block.children.flatMap(inlineNodes);
  return 'children' in block ? block.children : [];
}
export function allInline(nodes: InlineNode[]): InlineNode[] {
  return nodes.flatMap((node) => [
    node,
    ...('children' in node && node.type !== 'link' && node.type !== 'image'
      ? allInline(node.children)
      : []),
  ]);
}
function kind(node: BlockNode): CanvasKind {
  if (node.type === 'embed') return 'embed';
  if (node.type === 'attachment')
    return node.kind === 'image' ? 'image' : 'source';
  if (node.type === 'command' || node.type === 'unknown-command')
    return 'settings';
  if (node.type === 'codeblock') return 'code';
  if (node.type === 'heading' || node.type === 'list') return node.type;
  const links = allInline(inlineNodes(node));
  if (links.some((link) => link.type === 'image')) return 'image';
  if (
    links.some(
      (link) => link.type === 'link' && /presets\.pvme\./i.test(link.url),
    )
  )
    return 'preset';
  if (
    links.some(
      (link) =>
        link.type === 'link' && /(?:youtube\.com|youtu\.be)/i.test(link.url),
    )
  )
    return 'video';
  return 'text';
}

/** Every byte belongs either to a source-backed block or an untouched gap. */
export function canvasBlocks(source: string): CanvasBlock[] {
  const parsed = parseGuide(source);
  const candidates: {
    start: number;
    end: number;
    node?: BlockNode;
    kind: CanvasKind;
  }[] = parsed.messages
    .flatMap((message) => message.blocks)
    .filter((node) => node.type !== 'blank')
    .map((node) => ({
      start: node.range.start.offset,
      end: node.range.end.offset,
      node,
      kind: kind(node),
    }));
  candidates.push(
    ...parsed.separators.map((range) => ({
      start: range.start.offset,
      end: range.end.offset,
      node: undefined,
      kind: 'divider' as const,
    })),
  );
  candidates.sort(
    (a, b) =>
      a.start - b.start ||
      b.end - a.end ||
      (a.node?.type === 'attachment' ? -1 : 1),
  );
  const result: CanvasBlock[] = [];
  let end = 0;
  const add = (
    start: number,
    finish: number,
    type: CanvasKind,
    node?: BlockNode,
  ) =>
    result.push({
      id: `block-${start}-${finish}`,
      kind: type,
      start,
      end: finish,
      source: source.slice(start, finish),
      node,
    });
  for (const candidate of candidates) {
    if (candidate.start < end || candidate.end <= candidate.start) continue;
    if (source.slice(end, candidate.start).trim())
      add(
        end,
        candidate.start,
        end === 0 && parsed.metadata ? 'settings' : 'source',
      );
    add(candidate.start, candidate.end, candidate.kind, candidate.node);
    end = candidate.end;
  }
  if (source.slice(end).trim()) add(end, source.length, 'source');
  return result;
}

/** Full-document edits are intentional structural operations, still applied by the shared parser. */
export function validatePageSource(original: string, content: string): string {
  if (
    typeof content !== 'string' ||
    content.length > 2_000_000 ||
    content.includes('\0')
  )
    throw new Error('Invalid or oversized guide source');
  const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(
    original,
  )?.[0];
  if (frontmatter && !content.startsWith(frontmatter))
    throw new Error(
      'YAML frontmatter must remain at the start of the guide; edit it separately',
    );
  const errors = (source: string) => {
    const counts = new Map<string, number>();
    for (const diagnostic of parseGuide(source).diagnostics.filter(
      (item) => item.severity === 'error',
    )) {
      const start = diagnostic.range.start.offset,
        end = diagnostic.range.end.offset;
      const raw =
        source.slice(start, end) ||
        source.slice(
          source.lastIndexOf('\n', start - 1) + 1,
          source.indexOf('\n', start) < 0
            ? source.length
            : source.indexOf('\n', start),
        );
      const identity = diagnostic.code + ':' + diagnostic.message + ':' + raw;
      counts.set(identity, (counts.get(identity) || 0) + 1);
    }
    return counts;
  };
  const before = errors(original);
  for (const [code, count] of errors(content))
    if (count > (before.get(code) || 0))
      throw new Error(
        `This change introduces a guide error: ${code.split(':')[0]}. Correct it before applying.`,
      );
  return applySourceEdits(original, [
    { start: 0, end: original.length, original, replacement: content },
  ]);
}

export function replaceCanvasBlock(
  source: string,
  block: CanvasBlock,
  replacement: string,
): string {
  if (source.slice(block.start, block.end) !== block.source)
    throw new Error('This section changed. Select it again.');
  return applySourceEdits(source, [
    { start: block.start, end: block.end, original: block.source, replacement },
  ]);
}
export function insertCanvasBlock(
  source: string,
  offset: number,
  content: string,
): string {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length)
    throw new Error('Invalid insertion point');
  const eol = sourceEol(source);
  return applySourceEdits(source, [
    {
      start: offset,
      end: offset,
      original: '',
      replacement: `${offset ? eol + eol : ''}${content}${offset < source.length ? eol + eol : ''}`,
    },
  ]);
}
export function moveCanvasBlock(
  source: string,
  block: CanvasBlock,
  offset: number,
): string {
  if (block.kind === 'settings' || block.kind === 'source')
    throw new Error(
      'Move the complete heading section to keep its commands and metadata together',
    );
  if (block.kind === 'heading') {
    block = canvasSection(source, block);
    if (offset >= block.start && offset <= block.end) return source;
    const removed = replaceCanvasBlock(source, block, '');
    const target =
      offset > block.end ? offset - (block.end - block.start) : offset;
    const before = removed.slice(0, target),
      after = removed.slice(target);
    const eol = sourceEol(source);
    return (
      before +
      (before && !/[\r\n]$/.test(before) ? eol + eol : '') +
      block.source +
      (after && !/[\r\n]$/.test(block.source) ? eol + eol : '') +
      after
    );
  }
  if (offset >= block.start && offset <= block.end) return source;
  if (block.kind === 'embed') {
    const message = parseGuide(source).messages.find((message) =>
      message.blocks.some(
        (node) =>
          node.type === 'embed' && node.range.start.offset === block.start,
      ),
    );
    if (
      message &&
      message.blocks.every((node) =>
        ['embed', 'blank', 'command', 'unknown-command'].includes(node.type),
      )
    ) {
      const start = message.range.start.offset,
        end = message.range.end.offset;
      block = { ...block, start, end, source: source.slice(start, end) };
      if (offset >= start && offset <= end) return source;
    }
  }
  const removed = replaceCanvasBlock(source, block, '');
  const eol = sourceEol(source);
  const content =
    block.kind === 'embed' || block.node?.type === 'attachment'
      ? `.${eol}${block.source}${eol}.`
      : block.source;
  return insertCanvasBlock(
    removed,
    offset > block.end ? offset - (block.end - block.start) : offset,
    content,
  );
}

/** A heading owns its descendants, commands, attachments and message boundaries. */
export function canvasSection(
  source: string,
  heading: CanvasBlock,
): CanvasBlock {
  if (heading.node?.type !== 'heading') return heading;
  const blocks = canvasBlocks(source);
  const next = blocks.find(
    (candidate) =>
      candidate.start > heading.start &&
      candidate.node?.type === 'heading' &&
      candidate.node.level <= (heading.node as { level: number }).level,
  );
  const boundary = (offset: number) => {
    const preceding = source.slice(0, offset);
    const separator = /(?:^|\r?\n)\.[ \t]*(?:\r?\n)[\s]*$/.exec(preceding);
    return separator
      ? separator.index +
          (preceding[separator.index] === '\r'
            ? 2
            : preceding[separator.index] === '\n'
              ? 1
              : 0)
      : offset;
  };
  const start = boundary(heading.start),
    end = next ? boundary(next.start) : source.length;
  return { ...heading, start, end, source: source.slice(start, end) };
}
export function canvasTemplate(type: CanvasKind, source: string): string {
  const templates: Partial<Record<CanvasKind, string>> = {
    text: 'Write your text here.',
    heading: '## New section',
    list: '⬥ First item\n    • Child item',
    image: '![Image description](https://example.com/image.png)',
    preset: '[New preset](https://presets.pvme.io/?id=replace-me)',
    video: '[Video title](https://www.youtube.com/watch?v=replace-me)',
    embed:
      '.\n{\n  "embed": {\n    "title": "New embed",\n    "description": "Write your description here.",\n    "fields": []\n  }\n}\n.embed:json\n.',
    code: '```\nYour code here\n```',
    divider: '.',
  };
  return (templates[type] || 'New section').replace(/\n/g, sourceEol(source));
}

export interface CanvasField {
  label: string;
  value: string;
  type: 'text' | 'url' | 'number' | 'boolean' | 'null';
  path?: (string | number)[];
  start?: number;
  end?: number;
  node?: InlineNode;
}
export function embedFields(
  value: unknown,
  path: (string | number)[] = [],
): CanvasField[] {
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, child]) =>
      embedFields(child, [...path, Array.isArray(value) ? Number(key) : key]),
    );
  return [
    {
      label:
        path
          .map((key) =>
            typeof key === 'number'
              ? `Item ${key + 1}`
              : key.replace(/_/g, ' '),
          )
          .join(' › ') || 'Value',
      value: value === null ? 'null' : String(value),
      type:
        value === null
          ? 'null'
          : typeof value === 'number'
            ? 'number'
            : typeof value === 'boolean'
              ? 'boolean'
              : /url$/i.test(String(path.at(-1)))
                ? 'url'
                : 'text',
      path,
    },
  ];
}
export function changeEmbedField(
  value: unknown,
  field: CanvasField,
  input: string,
): unknown {
  const result = JSON.parse(JSON.stringify(value));
  if (field.type === 'boolean' && !['true', 'false'].includes(input))
    throw new Error('Use true or false for this field');
  const path = field.path!;
  let parent = result;
  for (const key of path.slice(0, -1)) {
    if (!parent || !Object.hasOwn(parent, key))
      throw new Error('Embed field no longer exists');
    parent = parent[key];
  }
  const replacement =
    field.type === 'number'
      ? Number(input)
      : field.type === 'boolean'
        ? input === 'true'
        : field.type === 'null'
          ? JSON.parse(input)
          : input;
  if (
    field.type === 'number' &&
    (!input.trim() || !Number.isFinite(replacement))
  )
    throw new Error('Enter a valid number');
  if (!path.length) return replacement;
  Object.defineProperty(parent, path.at(-1)!, {
    value: replacement,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return result;
}
export function blockFields(block: CanvasBlock): CanvasField[] {
  if (block.node?.type === 'embed' && block.node.valid)
    return embedFields(block.node.value);
  if (block.node?.type === 'attachment') {
    const start = block.source.indexOf(block.node.url);
    return [
      {
        label: block.kind === 'image' ? 'Image URL' : 'File URL',
        value: block.node.url,
        type: 'url',
        start,
        end: start + block.node.url.length,
      },
    ];
  }
  if (!block.node) return [];
  return allInline(inlineNodes(block.node)).flatMap((node): CanvasField[] => {
    if (node.type !== 'link' && node.type !== 'image') return [];
    const fields: CanvasField[] = [];
    if (node.urlRange)
      fields.push({
        label:
          node.type === 'image'
            ? 'Image URL'
            : /presets\.pvme\./i.test(node.url)
              ? 'Preset URL'
              : /youtu/i.test(node.url)
                ? 'YouTube URL'
                : 'Link URL',
        value: node.url,
        type: 'url',
        start: node.urlRange.start.offset,
        end: node.urlRange.end.offset,
        node,
      });
    if (
      node.labelRange &&
      node.children.length === 1 &&
      node.children[0].type === 'text'
    )
      fields.push({
        label: node.type === 'image' ? 'Image description' : 'Link label',
        value: node.children[0].value,
        type: 'text',
        start: node.labelRange.start.offset,
        end: node.labelRange.end.offset,
        node,
      });
    return fields;
  });
}
export function changeBlockField(
  block: CanvasBlock,
  field: CanvasField,
  value: string,
): string {
  if (field.type === 'url' && value && !/^https?:\/\/[^\s<>"']+$/i.test(value))
    throw new Error('Enter an HTTP or HTTPS URL without spaces');
  if (field.path && block.node?.type === 'embed') {
    const changed = changeEmbedField(block.node.value, field, value);
    let replacement = changed;
    for (const key of field.path) replacement = (replacement as any)[key];
    if (
      JSON.stringify(jsonSource(block.source).value) !==
      JSON.stringify(block.node.value)
    )
      throw new Error('This embed requires advanced source editing');
    return patchJsonProperty(block.source, field.path, replacement);
  }
  if (field.type === 'url' && !/^https?:\/\/[^\s<>"']+$/i.test(value))
    throw new Error('Enter an HTTP or HTTPS URL without spaces');
  const offset = block.node?.type === 'attachment' ? 0 : block.start;
  if (/[\r\n]/.test(value))
    throw new Error('Link labels must stay on one line');
  const start = field.start! - offset,
    end = field.end! - offset;
  const replacement =
    field.type === 'url' ? value : value.replace(/[\\\[\]*_~|`]/g, '\\$&');
  const result = applySourceEdits(block.source, [
    { start, end, original: block.source.slice(start, end), replacement },
  ]);
  if (
    field.type === 'url' &&
    !canvasBlocks(result).some((candidate) =>
      blockFields(candidate).some(
        (item) => item.type === 'url' && item.value === value,
      ),
    )
  )
    throw new Error(
      'This URL cannot be represented by this link. Use its source editor.',
    );
  return result;
}
