import {
  parseGuide,
  type BlockNode,
  type InlineNode,
} from '@pvme/guide-parser';
import { basename } from 'node:path';

export interface QuickReference {
  id: string;
  types: ['quick-reference'];
  path: string;
  title: string;
  aliases: string[];
  category?: string;
  keywords: string[];
  payload: string;
}
export interface ReferenceOverride {
  include?: boolean;
  reason?: string;
  title?: string;
  aliases?: string[];
  category?: string;
}
export interface ReferenceFinding {
  path: string;
  reason: string;
}
export interface ReferenceRecord {
  entry?: QuickReference;
  excluded?: string;
  warnings: string[];
}
export const isReferencePath = (path: string) => path.startsWith('commands/');

const discordOnly: Record<string, string> = {
  applications: 'PvME role applications',
  commandsheet: 'Discord bot command inventory',
  contributor: 'Server contributor recruitment',
  emojis: 'Discord emoji server navigation',
  nav: 'Discord server navigation',
  newuser: 'Discord server welcome and navigation',
  nodming: 'Discord moderation rule',
  notrading: 'Discord moderation rule',
  outdated: 'Discord editorial feedback workflow',
  pins: 'Discord pinned-message navigation',
  pvmehelp: 'Discord bot usage instructions',
  pvmhelp: 'Discord help-channel navigation',
  startediting: 'Discord editorial contribution workflow',
  submissions: 'Discord role and achievement submissions',
  'suggestion-thank-you': 'Discord bot acknowledgement',
  suggestion: 'Discord server suggestion workflow',
  website: 'Website navigation announcement',
};
const inlineText = (nodes: InlineNode[]): string =>
  nodes
    .map((node) =>
      'children' in node
        ? inlineText(node.children)
        : node.type === 'text'
          ? node.value
          : '',
    )
    .join('');
export function referenceText(value: string): string {
  return parseGuide(value)
    .messages.flatMap((m) => m.blocks)
    .map((b) =>
      'children' in b && Array.isArray(b.children)
        ? inlineText(b.children as InlineNode[])
        : '',
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function analyseReference(
  source: string,
  path: string,
  override: ReferenceOverride = {},
): ReferenceRecord {
  const name = basename(path).replace(/\.txt$/i, '');
  const excluded =
    override.include === false
      ? override.reason || 'Excluded by catalogue override'
      : override.include === true
        ? undefined
        : discordOnly[name];
  if (excluded) return { excluded, warnings: [] };
  const doc = parseGuide(source);
  const titles: string[] = [],
    text: string[] = [];
  let readable = false;
  const embed = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(embed);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (
        typeof item === 'string' &&
        ['title', 'description', 'content', 'name', 'value'].includes(key)
      ) {
        const plain = referenceText(item);
        if (key === 'title' && plain) titles.push(plain);
        text.push(plain);
        if (plain) readable = true;
      } else if (key === 'image' || key === 'thumbnail') {
        readable = true;
      } else if (typeof item === 'object') embed(item);
    }
  };
  const visit = (blocks: BlockNode[]) =>
    blocks.forEach((block) => {
      if (block.type === 'embed') {
        if (block.valid) embed(block.value);
      } else if (
        block.type === 'heading' ||
        block.type === 'paragraph' ||
        block.type === 'subtext'
      ) {
        const plain = inlineText(block.children).trim();
        if (block.type === 'heading' && plain) titles.push(plain);
        text.push(plain);
        if (plain) readable = true;
      } else if (block.type === 'attachment') readable = true;
      else if (block.type === 'list')
        block.items.forEach((item) => visit(item.children));
      else if (block.type === 'blockquote') visit(block.children);
      else if (block.type === 'codeblock' && block.value.trim()) {
        readable = true;
        text.push(block.value);
      }
    });
  visit(doc.messages.flatMap((m) => m.blocks));
  if (!readable)
    return {
      excluded: 'No supported readable content; review source formatting',
      warnings: [],
    };
  // Most display titles come directly from the first source embed or heading.
  const sourceTitle = titles[0]
    ?.replace(/^Link to (?:PvME\s+)?/i, '')
    .replace(/\s+Command$/i, '');
  const title =
    override.title ||
    sourceTitle ||
    name.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const id = path
    .slice('commands/'.length)
    .replace(/\.txt$/i, '')
    .replace(/\//g, '--')
    .toLowerCase();
  const aliases = [
    ...new Set([
      name,
      `!${name}`,
      `/command ${name}`,
      ...(override.aliases ?? []),
    ]),
  ];
  const warnings = [...new Set(source.match(/\$data_pvme:[^$]+\$/g) ?? [])].map(
    (token) => `Unresolved live-data placeholder ${token}`,
  );
  const channels = [...new Set(source.match(/<#\d+>/g) ?? [])];
  warnings.push(
    ...channels.map(
      (channel) =>
        `Discord channel ${channel}: resolve only through verified channel metadata; otherwise retain Discord link`,
    ),
  );
  const keywords = [
    ...new Set(
      text
        .join(' ')
        .toLowerCase()
        .replace(/\$data_pvme:[^$]+\$/g, '')
        .match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? [],
    ),
  ].slice(0, 70);
  return {
    entry: {
      id,
      types: ['quick-reference'],
      path,
      title,
      aliases,
      ...(override.category ? { category: override.category } : {}),
      keywords,
      payload: `/reference-content/${encodeURIComponent(id)}.json`,
    },
    warnings,
  };
}
