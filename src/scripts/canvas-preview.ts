import {
  parseGuide,
  applyInlineEdits,
  type InlineNode,
  type BlockNode,
} from '@pvme/guide-parser';
import { EditSession } from '../lib/edit-session';
import type { EditableEntry } from '../lib/source-map';
import type { CanvasBlock } from '../lib/page-canvas';
import type { LoadedGuideSource } from '../lib/guide-source-provider';
import { pageLinkTitle } from '../lib/page-link-title';

const safeUrl = (value: string) =>
  /^(https?:\/\/|#|\/(?!\/))/i.test(value) && !/[\u0000-\u001f]/.test(value)
    ? value
    : '';
const tags: Record<string, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strikethrough: 'del',
  spoiler: 'span',
};

/** A controlled DOM preview: source/JSON never enters innerHTML or executable attributes. */
export function renderCanvasPreview(
  doc: Document,
  block: CanvasBlock,
  entries?: EditableEntry[],
  links: LoadedGuideSource['previewLinks'] = {},
): HTMLElement {
  const root = doc.createElement('div');
  root.className = 'canvas-block-preview guide-content';
  const entry = (node: InlineNode, type: EditableEntry['kind']) => {
    const range =
      type === 'text'
        ? node.range
        : 'urlRange' in node
          ? type === 'link-url'
            ? node.urlRange
            : node.labelRange
          : undefined;
    const value =
      node.type === 'text'
        ? node.value
        : node.type === 'link'
          ? type === 'link-url'
            ? node.url
            : node.children.length === 1 && node.children[0].type === 'text'
              ? node.children[0].value
              : ''
          : '';
    if (!entries || !range || !value.trim()) return undefined;
    const id = `${type}-${range.start.offset}-${range.end.offset}`;
    entries.push({ id, kind: type, range, value });
    return id;
  };
  const inline = (
    nodes: InlineNode[],
    parent: HTMLElement,
    heading = false,
  ) => {
    for (const [index, node] of nodes.entries()) {
      if (node.type === 'text') {
        const span = doc.createElement('span');
        span.textContent =
          heading && index === 0 ? node.value.replace(/^> +/, '') : node.value;
        const id = entry(node, 'text');
        if (id) span.dataset.editRef = id;
        parent.append(span);
      } else if (node.type === 'link') {
        const a = doc.createElement('a');
        a.href = safeUrl(links[node.url]?.href || node.url);
        a.rel = 'noopener noreferrer';
        const label = entry(node, 'link-label'),
          url = entry(node, 'link-url');
        if (label) a.dataset.editRef = label;
        if (url) a.dataset.editUrl = url;
        // Link labels are one protected object in the line editor.
        const labelNodes = node.children;
        if (labelNodes.length === 1 && labelNodes[0].type === 'text')
          a.textContent = labelNodes[0].value;
        else {
          const before = entries?.length;
          inline(labelNodes, a);
          if (entries && before !== undefined) entries.splice(before);
          a.querySelectorAll('[data-edit-ref]').forEach((element) =>
            element.removeAttribute('data-edit-ref'),
          );
        }
        parent.append(a);
      } else if (node.type === 'image') {
        const image = doc.createElement('img');
        image.alt =
          node.children
            .map((child) => (child.type === 'text' ? child.value : ''))
            .join('') || 'Guide image';
        if (safeUrl(node.url)) image.src = safeUrl(node.url);
        image.loading = 'lazy';
        parent.append(image);
      } else if (node.type === 'emoji' && node.id) {
        const image = doc.createElement('img');
        image.className = 'emoji';
        image.alt = `:${node.name}:`;
        image.src = `https://cdn.discordapp.com/emojis/${node.id}.${node.animated ? 'gif' : 'png'}?size=48`;
        image.width = image.height = 24;
        parent.append(image);
      } else if (node.type in tags && 'children' in node) {
        const el = doc.createElement(tags[node.type]);
        if (node.type === 'spoiler') el.className = 'spoiler';
        inline(node.children, el);
        parent.append(el);
      } else if (node.type === 'mention' && node.kind === 'channel') {
        const link = doc.createElement('a');
        const raw = `https://discord.com/channels/534508796639182860/${node.target}`;
        const resolved = links[raw];
        link.href = safeUrl(resolved?.href || raw);
        link.textContent = resolved?.href.startsWith('/')
          ? pageLinkTitle(resolved.title || 'Related guide')
          : 'Discord Channel ↗';
        parent.append(link);
      } else if (node.type === 'line-break')
        parent.append(doc.createElement('br'));
      else if (node.type === 'inline-code') {
        const code = doc.createElement('code');
        code.textContent = node.value;
        parent.append(code);
      } else {
        const span = doc.createElement('span');
        span.textContent = node.raw;
        parent.append(span);
      }
    }
  };
  const markdown = (text: string, parent: HTMLElement) =>
    blocks(
      parseGuide(text).messages.flatMap((message) => message.blocks),
      parent,
    );
  const inlineMarkdown = (text: string, parent: HTMLElement) => {
    const nodes = parseGuide(text).messages.flatMap(
      (message) => message.blocks,
    );
    if (
      nodes.length === 1 &&
      ['paragraph', 'heading', 'subtext'].includes(nodes[0].type) &&
      'children' in nodes[0]
    )
      inline(nodes[0].children as InlineNode[], parent);
    else parent.textContent = text;
  };
  const editable = (
    text: string,
    parent: HTMLElement,
    path: (string | number)[],
  ) => {
    const target = doc.createElement('div');
    target.dataset.embedText = JSON.stringify(path);
    target.tabIndex = 0;
    target.setAttribute('aria-label', `Edit ${String(path.at(-1))}`);
    markdown(text, target);
    if (!target.childNodes.length) target.append(doc.createElement('br'));
    parent.append(target);
  };
  const embed = (
    value: unknown,
    parent: HTMLElement,
    path: (string | number)[] = [],
  ) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => embed(child, parent, [...path, index]));
      return;
    }
    if (!value || typeof value !== 'object') {
      const text = doc.createElement('p');
      text.textContent = String(value ?? '');
      parent.append(text);
      return;
    }
    const data = value as Record<string, any>;
    if (data.embed || data.embeds) {
      if (typeof data.content === 'string')
        editable(data.content, parent, [...path, 'content']);
      if (data.embed) embed(data.embed, parent, [...path, 'embed']);
      if (data.embeds) embed(data.embeds, parent, [...path, 'embeds']);
      return;
    }
    if (
      typeof data.title === 'string' &&
      /table of contents/i.test(data.title)
    ) {
      root.dataset.canvasSuppressed = '';
      return;
    }
    const aside = doc.createElement('aside');
    aside.className = 'guide-embed';
    if (typeof data.content === 'string')
      editable(data.content, aside, [...path, 'content']);
    if (typeof data.title === 'string') {
      const title = doc.createElement('h3');
      title.dataset.embedText = JSON.stringify([...path, 'title']);
      title.tabIndex = 0;
      inlineMarkdown(data.title, title);
      aside.append(title);
    }
    if (typeof data.description === 'string')
      editable(data.description, aside, [...path, 'description']);
    aside.dataset.embedContainer = JSON.stringify(path);
    if (Array.isArray(data.fields))
      data.fields.forEach((field: any, index: number) => {
        const container = doc.createElement('div');
        container.className = 'canvas-embed-field';
        container.dataset.embedField = JSON.stringify([
          ...path,
          'fields',
          index,
        ]);
        const title = doc.createElement('strong');
        title.dataset.embedText = JSON.stringify([
          ...path,
          'fields',
          index,
          'name',
        ]);
        title.tabIndex = 0;
        inlineMarkdown(String(field.name ?? ''), title);
        container.append(title);
        if (typeof field.value === 'string')
          editable(field.value, container, [...path, 'fields', index, 'value']);
        aside.append(container);
      });
    for (const media of [data.image, data.thumbnail])
      if (typeof media?.url === 'string' && safeUrl(media.url)) {
        const image = doc.createElement('img');
        image.src = safeUrl(media.url);
        image.alt = String(data.title || 'Embed image');
        image.loading = 'lazy';
        aside.append(image);
      }
    for (const [key, property] of [
      ['author', 'name'],
      ['footer', 'text'],
    ])
      if (typeof data[key]?.[property] === 'string')
        editable(data[key][property], aside, [...path, key, property]);
    if (typeof data.url === 'string') {
      const link = doc.createElement('a');
      link.href = safeUrl(data.url);
      link.textContent = data.url;
      aside.append(link);
    }
    if (!aside.childNodes.length) {
      const pre = doc.createElement('pre');
      pre.textContent = JSON.stringify(value, null, 2);
      aside.append(pre);
    }
    parent.append(aside);
  };
  const blocks = (nodes: BlockNode[], parent: HTMLElement) => {
    for (const node of nodes) {
      if (
        node.type === 'paragraph' ||
        node.type === 'heading' ||
        node.type === 'subtext'
      ) {
        const el = doc.createElement(
          node.type === 'heading'
            ? `h${Math.min(6, Math.max(2, node.level))}`
            : 'p',
        );
        if (node.type === 'heading' && node.level === 1)
          el.className = 'guide-document-title';
        if (node.type === 'paragraph') {
          const plain = node.children.map((child) => child.raw).join('');
          if (
            /\btable of contents\b/i.test(plain) &&
            /\b(?:pins|pinned messages?)\b/i.test(plain)
          ) {
            root.dataset.canvasSuppressed = '';
            continue;
          }
        }
        inline(node.children, el, node.type === 'heading');
        parent.append(el);
      } else if (node.type === 'list') {
        const list = doc.createElement(node.ordered ? 'ol' : 'ul');
        for (const item of node.items) {
          const li = doc.createElement('li');
          blocks(item.children, li);
          list.append(li);
        }
        parent.append(list);
      } else if (node.type === 'blockquote') {
        const quote = doc.createElement('blockquote');
        blocks(node.children, quote);
        parent.append(quote);
      } else if (node.type === 'codeblock') {
        const pre = doc.createElement('pre');
        const code = doc.createElement('code');
        code.textContent = node.value;
        pre.append(code);
        parent.append(pre);
      } else if (
        node.type === 'blank' &&
        entries &&
        node.range.start.offset < block.source.length
      ) {
        const paragraph = doc.createElement('p');
        paragraph.dataset.emptySourceLine = String(node.range.start.offset);
        paragraph.append(doc.createElement('br'));
        parent.append(paragraph);
      } else if (node.type === 'embed') embed(node.value, parent);
      else if (node.type === 'attachment') {
        if (node.kind === 'image' && safeUrl(node.url)) {
          const image = doc.createElement('img');
          image.src = safeUrl(node.url);
          image.alt = 'Guide illustration';
          image.loading = 'lazy';
          parent.append(image);
        } else {
          const a = doc.createElement('a');
          a.href = safeUrl(node.url);
          a.textContent = node.url;
          parent.append(a);
        }
      }
    }
  };
  // Reparse fragments so local text-editing offsets never reference the full page.
  const parsed = parseGuide(block.source);
  blocks(
    parsed.messages.flatMap((message) => message.blocks),
    root,
  );
  if (!root.childNodes.length && !root.hasAttribute('data-canvas-suppressed')) {
    const pre = doc.createElement('pre');
    pre.textContent = block.kind === 'divider' ? 'New message' : block.source;
    root.append(pre);
  }
  return root;
}

let sequence = 0;
export async function canvasTextSession(
  doc: Document,
  block: CanvasBlock,
  links?: LoadedGuideSource['previewLinks'],
) {
  const entries: EditableEntry[] = [];
  const preview = renderCanvasPreview(doc, block, entries, links);
  const accepted: EditableEntry[] = [];
  const validate = (batch: EditableEntry[]) => {
    if (!batch.length) return;
    try {
      applyInlineEdits(
        block.source,
        batch.map((item) => ({
          kind: item.kind,
          range: item.range,
          replacement: item.value,
        })),
      );
      accepted.push(...batch);
    } catch {
      if (batch.length > 1) {
        const middle = Math.floor(batch.length / 2);
        validate(batch.slice(0, middle));
        validate(batch.slice(middle));
      }
    }
  };
  validate(entries);
  const ids = new Set(accepted.map((item) => item.id));
  for (const element of preview.querySelectorAll<HTMLElement>(
    '[data-edit-ref],[data-edit-url]',
  )) {
    if (!ids.has(element.dataset.editRef || '')) delete element.dataset.editRef;
    if (!ids.has(element.dataset.editUrl || '')) delete element.dataset.editUrl;
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(block.source),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const path = `canvas/section-${++sequence}.txt`;
  const session = await EditSession.create(
    { schemaVersion: 1, path, sourceHash: hash, entries: accepted },
    {
      path,
      originalText: block.source,
      name: 'Canvas section',
      repo: 'pvme/pvme-guides',
      baseBranch: 'master',
      source: 'master',
      branch: 'master',
    },
    { allowEmptyRows: true },
  );
  const article = doc.createElement('article');
  article.className = 'guide-content canvas-text-surface';
  article.dataset.guideSource = path;
  article.dataset.guideSourceHash = hash;
  article.append(preview);
  return { session, article };
}
