import {
  parseGuide,
  applyInlineEdits,
  applySourceEdits,
  type InlineNode,
  type BlockNode,
  type SourceRange,
  type SourceEdit,
} from '@pvme/guide-parser';
import type { GuideSourceMap } from './source-map';
import { newEmojiToken, inlineTokenFromId, newLinkToken } from './rich-token';
import {
  highlightSourceDiff,
  sourceDiff,
  type SourceEdit as TextEdit,
} from './source-diff';

export const lineMarks = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'spoiler',
] as const;
export type LineMark = (typeof lineMarks)[number];
export type RichPart =
  | { type: 'text'; text: string; marks: LineMark[] }
  | { type: 'token'; id: string; marks: LineMark[] };
export type RichLine = RichPart[][];
export interface LineToken {
  id: string;
  node: InlineNode;
  raw: string;
}
export interface SourceLine {
  id: string;
  range: SourceRange;
  prefix: string;
  raw: string;
  botPrefix?: string;
  newLinks?: string[];
  kind: 'paragraph' | 'heading' | 'subtext';
  bullet: boolean;
  eol: string;
  tokens: LineToken[];
  entryIds: string[];
  model: RichLine;
}
export type TokenSource = (token: LineToken) => string;

export function isBulletPrefix(prefix: string): boolean {
  return /^[ \t]*([⬥•⬩●○▪▫‣►◆★→*+\-]|\d+[.)]|[A-Za-z][.)])[ \t]+$/.test(prefix);
}

export function canToggleBullet(line: SourceLine): boolean {
  return (
    line.kind === 'paragraph' &&
    (isBulletPrefix(line.prefix) || /^[ \t]*$/.test(line.prefix))
  );
}

export const bulletPrefixes = ['⬥ ', '    • ', '        ⬩ '] as const;

export function bulletLevel(prefix: string): number {
  return Math.floor(
    (prefix.match(/^[ \t]*/)?.[0].replace(/\t/g, '    ').length || 0) / 4,
  );
}

/** Retain untouched legacy markers, but every new level uses the PvME hierarchy. */
export function validateLinePrefixes(
  line: SourceLine,
  prefixes: string[],
  rows: number,
): string[] {
  if (!Array.isArray(prefixes) || prefixes.length !== rows)
    throw new Error('Invalid bullet indentation');
  for (const [index, prefix] of prefixes.entries()) {
    if (
      typeof prefix !== 'string' ||
      prefix.length > 1024 ||
      (index > 0 && isBulletPrefix(prefix) && bulletLevel(prefix) > 2) ||
      (prefix !== line.prefix &&
        (!canToggleBullet(line) ||
          (prefix !== '' && !bulletPrefixes.some((value) => value === prefix))))
    )
      throw new Error(
        'Use three bullet levels: ⬥, •, and ⬩. A fourth level is not supported.',
      );
  }
  return [...prefixes];
}

export function shiftBulletPrefix(prefix: string, outdent: boolean): string {
  if (!isBulletPrefix(prefix)) return prefix;
  const level = bulletLevel(prefix);
  const next = level + (outdent ? -1 : 1);
  return next < 0 || next > 2 ? prefix : bulletPrefixes[next];
}

export function normalizeRichLine(model: RichLine): RichLine {
  if (!Array.isArray(model) || !model.length)
    throw new Error('Missing line content');
  return model.map((parts) => {
    if (!Array.isArray(parts)) throw new Error('Invalid line content');
    const result: RichPart[] = [];
    for (const part of parts) {
      if (
        !part ||
        !Array.isArray(part.marks) ||
        part.marks.some((mark) => !lineMarks.includes(mark))
      )
        throw new Error('Unsupported formatting');
      const marks = lineMarks.filter((mark) => part.marks.includes(mark));
      if (part.type === 'text') {
        if (
          typeof part.text !== 'string' ||
          /[\r\n\u0000-\u001f\u007f]/.test(part.text)
        )
          throw new Error(
            'Use Enter to add a line. Control characters are not supported.',
          );
        if (!part.text) continue;
        const previous = result.at(-1);
        if (
          previous?.type === 'text' &&
          JSON.stringify(previous.marks) === JSON.stringify(marks)
        )
          previous.text += part.text;
        else result.push({ type: 'text', text: part.text, marks });
      } else if (part.type === 'token' && typeof part.id === 'string')
        result.push({ type: 'token', id: part.id, marks });
      else throw new Error('Unsupported line content');
    }
    // Markdown delimiters cannot open/close on whitespace. Formatting those
    // spaces has no visual effect; retain only styles shared with neighbours.
    const adjusted: RichPart[] = [];
    const add = (part: RichPart) => {
      if (part.type === 'text' && !part.text) return;
      const previous = adjusted.at(-1);
      if (
        part.type === 'text' &&
        previous?.type === 'text' &&
        JSON.stringify(previous.marks) === JSON.stringify(part.marks)
      )
        previous.text += part.text;
      else adjusted.push(part);
    };
    result.forEach((part, index) => {
      if (part.type !== 'text') {
        add(part);
        return;
      }
      const leading = part.text.match(/^\s*/)?.[0] || '';
      const trailing = part.text.slice(leading.length).match(/\s*$/)?.[0] || '';
      if (leading.length === part.text.length) {
        add({
          ...part,
          marks: part.marks.filter(
            (mark) =>
              result[index - 1]?.marks.includes(mark) &&
              result[index + 1]?.marks.includes(mark),
          ),
        });
        return;
      }
      add({
        ...part,
        text: leading,
        marks: part.marks.filter((mark) =>
          result[index - 1]?.marks.includes(mark),
        ),
      });
      add({
        ...part,
        text: part.text.slice(
          leading.length,
          part.text.length - trailing.length,
        ),
      });
      add({
        ...part,
        text: trailing,
        marks: part.marks.filter((mark) =>
          result[index + 1]?.marks.includes(mark),
        ),
      });
    });
    return adjusted;
  });
}

function flatten(
  nodes: InlineNode[],
  token: (node: InlineNode) => string,
  marks: LineMark[] = [],
): RichPart[] {
  return nodes.flatMap((node): RichPart[] => {
    if (node.type === 'text')
      return [{ type: 'text', text: node.value, marks }];
    if (lineMarks.includes(node.type as LineMark) && 'children' in node)
      return flatten(node.children, token, [...marks, node.type as LineMark]);
    return [{ type: 'token', id: token(node), marks }];
  });
}

/** Only original physical lines containing already verified renderer targets are eligible. */
export function sourceLines(
  source: string,
  map: GuideSourceMap,
  allowEmptyRows = false,
): SourceLine[] {
  const result: SourceLine[] = [];
  const visit = (blocks: BlockNode[], bulletLine?: number) => {
    for (const block of blocks) {
      if (block.type === 'list') {
        for (const item of block.items)
          visit(item.children, item.range.start.line);
      } else if (block.type === 'blockquote') visit(block.children, bulletLine);
      else if (allowEmptyRows && block.type === 'blank') {
        const offset = block.range.start.offset;
        const start = source.lastIndexOf('\n', offset - 1) + 1;
        const prefix = source.slice(start, offset);
        if (
          offset >= source.length ||
          (!isBulletPrefix(prefix) && !/^[ \t]*$/.test(prefix)) ||
          source.slice(offset, block.range.end.offset).trim()
        )
          continue;
        result.push({
          id: `line-${offset}-${offset}`,
          range: {
            ...block.range,
            end: { ...block.range.start },
            endLine: block.range.start.line,
          },
          prefix,
          raw: '',
          kind: 'paragraph',
          bullet: isBulletPrefix(prefix),
          eol:
            source.slice(offset).match(/^[^\r\n]*(\r\n|\n|\r)/)?.[1] ||
            (source.includes('\r\n') ? '\r\n' : '\n'),
          tokens: [],
          entryIds: [],
          model: [[]],
        });
      } else if (
        block.type === 'paragraph' ||
        block.type === 'heading' ||
        block.type === 'subtext'
      ) {
        const groups: InlineNode[][] = [[]];
        for (const node of block.children) {
          if (node.type === 'line-break') groups.push([]);
          else groups.at(-1)!.push(node);
        }
        for (const nodes of groups) {
          if (
            !nodes.length ||
            nodes.some(
              (node) =>
                node.range.start.line !== nodes[0].range.start.line ||
                node.range.end.line !== nodes[0].range.start.line,
            )
          )
            continue;
          const range = {
            start: nodes[0].range.start,
            end: nodes.at(-1)!.range.end,
            startLine: nodes[0].range.start.line,
            endLine: nodes.at(-1)!.range.end.line,
          };
          const entryIds = map.entries
            .filter(
              (entry) =>
                entry.range.start.offset >= range.start.offset &&
                entry.range.end.offset <= range.end.offset,
            )
            .map((entry) => entry.id);
          // A plain Discord heading can lose its only inline mapping because
          // the renderer hides its leading quote marker. The whole physical
          // line remains editable through the existing prefix-preserving model.
          const plainQuoteHeading =
            block.type === 'heading' &&
            nodes.length === 1 &&
            nodes[0].type === 'text' &&
            /^> +\S/.test(nodes[0].value);
          if (!entryIds.length && !plainQuoteHeading) continue;
          const start = source.lastIndexOf('\n', range.start.offset - 1) + 1;
          const prefix = source.slice(start, range.start.offset);
          const raw = source.slice(range.start.offset, range.end.offset);
          if (/[\r\n]/.test(raw) || /[\r\n]/.test(prefix)) continue;
          const id = `line-${range.start.offset}-${range.end.offset}`;
          const tokens: LineToken[] = [];
          const parts = flatten(nodes, (node) => {
            const tokenId = `${id}-token-${tokens.length}`;
            tokens.push({
              id: tokenId,
              node,
              raw: source.slice(node.range.start.offset, node.range.end.offset),
            });
            return tokenId;
          });
          const botPrefix =
            block.type === 'heading' ? raw.match(/^> +/)?.[0] : undefined;
          if (botPrefix && parts[0]?.type === 'text')
            parts[0].text = parts[0].text.slice(botPrefix.length);
          const line: SourceLine = {
            id,
            range,
            prefix,
            raw,
            botPrefix,
            kind: block.type,
            bullet:
              block.type === 'paragraph' && bulletLine === range.start.line,
            eol:
              source
                .slice(range.end.offset)
                .match(/^[^\r\n]*(\r\n|\n|\r)/)?.[1] ||
              (source.includes('\r\n') ? '\r\n' : '\n'),
            tokens,
            entryIds,
            model: [parts],
          };
          try {
            line.model = normalizeRichLine(line.model);
            readRichLine(line, raw, (token) => token.raw);
            result.push(line);
          } catch {
            /* Discontiguous, recovered or transformed lines remain read-only. */
          }
        }
      }
    }
  };
  parseGuide(source).messages.forEach((message) => visit(message.blocks));
  return result;
}

function inlineBody(
  prefix: string,
  body: string,
  kind: SourceLine['kind'],
): InlineNode[] {
  const doc = parseGuide(prefix + body);
  if (
    doc.commands.length ||
    doc.embeds.length ||
    doc.attachments.length ||
    doc.separators.length ||
    doc.metadata ||
    doc.messages.length > 1
  )
    throw new Error(
      'Line edits cannot introduce commands, embeds or new sections',
    );
  let blocks: BlockNode[] = doc.messages
    .flatMap((message) => message.blocks)
    .filter((block) => block.type !== 'blank');
  while (
    blocks.length === 1 &&
    (blocks[0].type === 'blockquote' || blocks[0].type === 'list')
  ) {
    const block = blocks[0];
    if (block.type === 'blockquote') {
      if (!prefix.includes('>'))
        throw new Error('Use the formatting controls to change line type');
      blocks = block.children;
    } else if (block.type === 'list' && block.items.length === 1) {
      if (!isBulletPrefix(prefix.replace(/^(?:[ \t]*>[ \t]*)+/, '')))
        throw new Error('Use the Bullets button to change line type');
      blocks = block.items[0].children;
    } else throw new Error('Use the Bullets control to change list formatting');
  }
  blocks = blocks.filter((block) => block.type !== 'blank');
  if (!body && !blocks.length) return [];
  if (
    blocks.length !== 1 ||
    blocks[0].type !== kind ||
    !('children' in blocks[0])
  )
    throw new Error(
      'Only text, formatting and continuation bullets can change here',
    );
  const nodes = blocks[0].children as InlineNode[];
  if (
    nodes.some(
      (node) => node.range.start.line !== 1 || node.range.end.line !== 1,
    )
  )
    throw new Error('Non-contiguous line');
  return nodes;
}

/** Reparse a proposed line and require every protected source token exactly once, in order. */
export function readRichLine(
  line: SourceLine,
  body: string,
  resolve: TokenSource,
  prefixes?: readonly string[],
): RichLine {
  if (typeof body !== 'string') throw new Error('Invalid line draft');
  const rows = body.split(/\r\n|\n|\r/);
  if (line.kind !== 'paragraph' && rows.length !== 1)
    throw new Error('New lines are only supported in paragraph text');
  let index = 0;
  const model = rows.map((row, rowIndex) => {
    if (rowIndex) {
      if (!row.startsWith(line.prefix))
        throw new Error(
          'Continuation bullets must retain their source marker and indentation',
        );
      row = row.slice(line.prefix.length);
    }
    if (line.botPrefix) {
      if (!row.startsWith(line.botPrefix))
        throw new Error('The Discord heading prefix must be retained');
      row = row.slice(line.botPrefix.length);
    }
    return flatten(
      inlineBody(prefixes?.[rowIndex] ?? line.prefix, row, line.kind),
      (node) => {
        const expected = line.tokens[index];
        if (
          expected &&
          expected.node.type === node.type &&
          resolve(expected) === node.raw
        ) {
          index++;
          return expected.id;
        }
        const emoji = node.type === 'emoji' && newEmojiToken(node.raw);
        if (emoji) return emoji.id;
        const link =
          node.type === 'link' &&
          line.newLinks?.includes(node.raw) &&
          newLinkToken(node.raw);
        if (link) return link.id;
        throw new Error(
          'Links, emojis, references and other protected content must be retained. Edit links through their link control.',
        );
      },
    );
  });
  if (index !== line.tokens.length)
    throw new Error('Protected content cannot be removed or duplicated');
  return normalizeRichLine(model);
}

const delimiters: Record<LineMark, string> = {
  bold: '**',
  italic: '*',
  underline: '__',
  strikethrough: '~~',
  spoiler: '||',
};
const textSource = (value: string) => {
  if (!value) return '';
  const node = parseGuide('text').messages[0].blocks[0];
  if (node.type !== 'paragraph') throw new Error('Parser unavailable');
  return applyInlineEdits('text', [
    { kind: 'text', range: node.children[0].range, replacement: `x${value}x` },
  ]).slice(1, -1);
};

/** Map visible text back to its literal source, including existing escape pairs.
 * A small text edit must not reserialize its surrounding punctuation or styles. */
function patchLineText(
  line: SourceLine,
  model: RichLine,
  resolve: TokenSource,
  escape: boolean,
): string | undefined {
  if (model.length !== 1 || model[0].length !== line.model[0].length) return;
  if (
    model[0].some((part, index) => {
      const original = line.model[0][index];
      return (
        part.type !== original.type ||
        JSON.stringify(part.marks) !== JSON.stringify(original.marks) ||
        (part.type === 'token' &&
          original.type === 'token' &&
          part.id !== original.id)
      );
    })
  )
    return;
  const characters: { start: number; end: number }[] = [];
  let supported = true;
  const visit = (nodes: InlineNode[]) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const decoded = node.raw.replace(
          /\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g,
          '$1',
        );
        if (decoded !== node.value) {
          supported = false;
          return;
        }
        for (let offset = 0; offset < node.raw.length;) {
          const start = offset;
          if (
            node.raw[offset] === '\\' &&
            /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(
              node.raw[offset + 1] || '',
            )
          )
            offset++;
          offset++;
          characters.push({
            start: node.range.start.offset - line.prefix.length + start,
            end: node.range.start.offset - line.prefix.length + offset,
          });
        }
      } else if (
        lineMarks.includes(node.type as LineMark) &&
        'children' in node
      )
        visit(node.children);
    }
  };
  visit(inlineBody(line.prefix, line.raw, line.kind));
  if (!supported) return;
  if (line.botPrefix) characters.splice(0, line.botPrefix.length);
  const edits: SourceEdit[] = [];
  let offset = 0;
  model[0].forEach((part, index) => {
    const original = line.model[0][index];
    if (part.type !== 'text' || original.type !== 'text') return;
    const changes: TextEdit[] = [];
    // Ranges are in the original text: reverse the diff to find replacement spans.
    highlightSourceDiff(sourceDiff(part.text, original.text), changes);
    for (const change of changes) {
      const start =
        change.start === original.text.length
          ? characters[offset + original.text.length - 1]?.end
          : characters[offset + change.start]?.start;
      const end =
        change.end > change.start
          ? characters[offset + change.end - 1]?.end
          : start;
      if (start === undefined || end === undefined) {
        supported = false;
        return;
      }
      edits.push({
        start,
        end,
        original: line.raw.slice(start, end),
        replacement: escape ? textSource(change.original) : change.original,
      });
    }
    offset += original.text.length;
  });
  if (!supported) return;
  for (const token of line.tokens) {
    const replacement = resolve(token);
    if (replacement !== token.raw)
      edits.push({
        start: token.node.range.start.offset - line.range.start.offset,
        end: token.node.range.end.offset - line.range.start.offset,
        original: token.raw,
        replacement,
      });
  }
  return applySourceEdits(line.raw, edits);
}

export function writeRichLine(
  line: SourceLine,
  input: RichLine,
  resolve: TokenSource,
): string {
  const model = normalizeRichLine(input);
  line = {
    ...line,
    newLinks: model
      .flat()
      .flatMap((part) =>
        part.type === 'token' && part.id.startsWith('new-link:')
          ? [inlineTokenFromId(part.id)?.raw || '']
          : [],
      ),
  };
  if (line.kind !== 'paragraph' && model.length > 1)
    throw new Error('New lines are only supported in paragraph text');
  // Identical original and inserted emoji images are indistinguishable. Keep
  // the protected-token order check above, comparing their literal value here.
  const comparable = (value: RichLine) =>
    value.map((parts) =>
      parts.map((part) => {
        if (part.type !== 'token') return part;
        const token =
          line.tokens.find((token) => token.id === part.id) ||
          inlineTokenFromId(part.id);
        return token?.node.type === 'emoji'
          ? { ...part, id: `emoji:${token.raw}` }
          : part;
      }),
    );
  const matches = (body: string) => {
    try {
      return (
        JSON.stringify(comparable(readRichLine(line, body, resolve))) ===
        JSON.stringify(comparable(model))
      );
    } catch {
      return false;
    }
  };
  for (const escape of [false, true]) {
    const patched = patchLineText(line, model, resolve, escape);
    if (patched !== undefined && matches(patched)) return patched;
  }
  const serialize = (escape: boolean) =>
    model
      .map((parts, rowIndex) => {
        if (
          rowIndex === 0 &&
          JSON.stringify(parts) === JSON.stringify(line.model[0])
        ) {
          return applySourceEdits(
            line.raw,
            line.tokens
              .filter((token) => resolve(token) !== token.raw)
              .map((token) => ({
                start: token.node.range.start.offset - line.range.start.offset,
                end: token.node.range.end.offset - line.range.start.offset,
                original: token.raw,
                replacement: resolve(token),
              })),
          );
        }
        let result = '',
          marks: LineMark[] = [];
        for (const part of parts) {
          let common = 0;
          while (
            common < marks.length &&
            common < part.marks.length &&
            marks[common] === part.marks[common]
          )
            common++;
          for (const mark of marks.slice(common).reverse())
            result += delimiters[mark];
          for (const mark of part.marks.slice(common))
            result += delimiters[mark];
          marks = part.marks;
          const token =
            part.type === 'token'
              ? line.tokens.find((token) => token.id === part.id) ||
                inlineTokenFromId(part.id)
              : undefined;
          if (part.type === 'token' && !token)
            throw new Error('Unknown protected content');
          result +=
            part.type === 'text'
              ? escape
                ? textSource(part.text)
                : part.text
              : token!.id.startsWith('new-emoji:') ||
                  token!.id.startsWith('new-link:')
                ? token!.raw
                : resolve(token!);
        }
        for (const mark of [...marks].reverse()) result += delimiters[mark];
        return (rowIndex === 0 ? line.botPrefix || '' : '') + result;
      })
      .join(line.eol + line.prefix);
  const literal = serialize(false);
  if (matches(literal)) return literal;
  const body = serialize(true);
  if (!matches(body))
    throw new Error(
      'This formatting combination cannot be represented safely. Adjust the selection and try again.',
    );
  return body;
}

/** Parser-based batch edits plus a check that nodes outside the authorised regions survive. */
export function applyLineSourceEdits(
  source: string,
  edits: SourceEdit[],
  lineIds: Set<number>,
  allowBlockReflow = false,
): string {
  const result = applySourceEdits(source, edits);
  if (result === source) return result;
  const before = parseGuide(source),
    after = parseGuide(result);
  const diagnostics = (doc: typeof before) =>
    JSON.stringify(
      doc.diagnostics.map(({ code, severity, message }) => ({
        code,
        severity,
        message,
      })),
    );
  if (diagnostics(before) !== diagnostics(after))
    throw new Error('Changes would alter protected parser diagnostics');
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const adjusted = (offset: number) =>
    offset +
    sorted
      .filter((edit) => edit.end <= offset)
      .reduce(
        (delta, edit) =>
          delta + edit.replacement.length - (edit.end - edit.start),
        0,
      );
  const nodes = (
    value: unknown,
    found: { type: string; raw: string; range: SourceRange }[] = [],
  ) => {
    if (!value || typeof value !== 'object') return found;
    if (Array.isArray(value)) {
      value.forEach((child) => nodes(child, found));
      return found;
    }
    const node = value as Record<string, unknown>;
    if (
      typeof node.type === 'string' &&
      typeof node.raw === 'string' &&
      node.range
    )
      found.push(node as never);
    // Do not mistake embed JSON objects for AST nodes.
    for (const key of ['blocks', 'children', 'items'])
      if (node[key]) nodes(node[key], found);
    return found;
  };
  const beforeNodes = before.messages.flatMap((message) =>
    nodes(message.blocks),
  );
  const afterNodes = after.messages.flatMap((message) => nodes(message.blocks));
  const key = (type: string, raw: string, start: number, end: number) =>
    JSON.stringify([type, raw, start, end]);
  const afterKeys = new Set(
    afterNodes.map((node) =>
      key(node.type, node.raw, node.range.start.offset, node.range.end.offset),
    ),
  );
  for (const node of beforeNodes) {
    // List formatting deliberately changes block ancestry; every unaffected inline node
    // below these containers must still survive with identical source and offsets.
    if (
      allowBlockReflow &&
      ['list', 'list-item', 'paragraph'].includes(node.type)
    )
      continue;
    const start = node.range.start.offset,
      end = node.range.end.offset;
    if (
      sorted.some(
        (edit) =>
          (edit.start < end && edit.end > start) ||
          (start === end && edit.start <= start && edit.end >= end),
      )
    )
      continue;
    if (
      !afterKeys.has(key(node.type, node.raw, adjusted(start), adjusted(end)))
    )
      throw new Error('Changes would affect content outside the edited line');
  }
  // A formatting span must not reach out of an edited line into neighbouring content.
  const lineRegions = sorted
    .filter((edit) => lineIds.has(edit.start))
    .map((edit) => {
      const start =
        edit.start +
        sorted
          .filter((other) => other !== edit && other.end <= edit.start)
          .reduce(
            (delta, other) =>
              delta + other.replacement.length - (other.end - other.start),
            0,
          );
      return { start, end: start + edit.replacement.length };
    });
  for (const node of afterNodes) {
    if (!lineMarks.includes(node.type as LineMark)) continue;
    if (
      lineRegions.some(
        (region) =>
          node.range.start.offset < region.end &&
          node.range.end.offset > region.start &&
          (node.range.start.offset < region.start ||
            node.range.end.offset > region.end),
      )
    )
      throw new Error('Formatting cannot cross an original line boundary');
  }
  return result;
}
