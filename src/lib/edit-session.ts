import {
  applyInlineEdits,
  parseGuide,
  type InlineEdit,
  type InlineNode,
  type BlockNode,
  type SourceEdit,
} from '@pvme/guide-parser';
import {
  sourceLines,
  readRichLine,
  writeRichLine,
  normalizeRichLine,
  applyLineSourceEdits,
  validateLinePrefixes,
  type SourceLine,
  type RichLine,
  type LineToken,
} from './source-lines';
import {
  verifySourceVersion,
  type GuideSourceMap,
  type EditableEntry,
} from './source-map';
import type { LoadedGuideSource } from './guide-source-provider';
import { validatePageSource } from './page-canvas';
import { inlineTokenFromId, newLinkToken } from './emoji-token';

export interface PendingChange {
  entryId: string;
  replacement: string;
  kind?: 'line' | 'document';
  prefixes?: string[];
  links?: string[];
}
export interface GuideUpdatePayload {
  type: 'update';
  repo: 'pvme/pvme-guides';
  baseBranch: 'master';
  path: string;
  originalContent: string;
  content: string;
  title: string;
  notes: string;
  source: LoadedGuideSource['source'];
  branch: string;
  existingReviewBranch: string;
  replaceExistingReview: false;
}

/** Metadata is public/untrusted input. No coercion of unsupported schemas or edit kinds. */
export function readSourceMap(value: unknown): GuideSourceMap {
  if (!value || typeof value !== 'object')
    throw new Error('Missing source map');
  const map = value as GuideSourceMap;
  if (
    map.schemaVersion !== 1 ||
    typeof map.path !== 'string' ||
    !map.path ||
    /[\\:\u0000-\u001f]/.test(map.path) ||
    map.path.startsWith('/') ||
    map.path
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    typeof map.sourceHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(map.sourceHash) ||
    !Array.isArray(map.entries)
  )
    throw new Error('Unsupported source map');
  const ids = new Set<string>();
  for (const entry of map.entries) {
    if (
      !entry ||
      !['text', 'link-label', 'link-url'].includes(entry.kind) ||
      typeof entry.value !== 'string' ||
      !entry.value.trim() ||
      !entry.range ||
      !entry.range.start ||
      !entry.range.end
    )
      throw new Error('Invalid editing target');
    const { start, end, startLine, endLine } = entry.range;
    if (
      ![
        start.line,
        start.column,
        end.line,
        end.column,
        startLine,
        endLine,
      ].every((n) => Number.isInteger(n) && n > 0) ||
      ![start.offset, end.offset].every((n) => Number.isInteger(n) && n >= 0) ||
      end.offset <= start.offset ||
      startLine !== start.line ||
      endLine !== end.line ||
      entry.id !== `${entry.kind}-${start.offset}-${end.offset}` ||
      ids.has(entry.id)
    )
      throw new Error('Invalid or duplicate editing range');
    ids.add(entry.id);
  }
  return JSON.parse(JSON.stringify(map));
}

export class EditSession {
  readonly map: GuideSourceMap;
  readonly loaded: Readonly<LoadedGuideSource>;
  #pending = new Map<string, InlineEdit>();
  #entries = new Map<string, EditableEntry>();
  #lineChanges = new Map<string, string>();
  #linePrefixes = new Map<string, string[]>();
  #lineLinks = new Map<string, string[]>();
  #documentDraft?: string;
  readonly lines: readonly SourceLine[];
  private constructor(
    map: GuideSourceMap,
    loaded: LoadedGuideSource,
    private readonly bareUrlIds: ReadonlySet<string>,
    allowEmptyRows = false,
  ) {
    this.map = map;
    this.loaded = Object.freeze({ ...loaded });
    this.lines = sourceLines(loaded.originalText, map, allowEmptyRows);
    for (const entry of map.entries) {
      this.#entries.set(entry.id, entry);
      Object.freeze(entry.range.start);
      Object.freeze(entry.range.end);
      Object.freeze(entry.range);
      Object.freeze(entry);
    }
    Object.freeze(map.entries);
    Object.freeze(map);
  }

  static async create(
    input: unknown,
    loaded: LoadedGuideSource,
    options: { allowEmptyRows?: boolean } = {},
  ): Promise<EditSession> {
    const map = readSourceMap(input);
    if (
      loaded.path !== map.path ||
      loaded.repo !== 'pvme/pvme-guides' ||
      loaded.baseBranch !== 'master' ||
      !['master', 'user-pr'].includes(loaded.source) ||
      !loaded.branch ||
      (loaded.source === 'master' && loaded.branch !== 'master') ||
      typeof loaded.originalText !== 'string'
    )
      throw new Error('Loaded guide identity does not match this page');
    if (!(await verifySourceVersion(loaded.originalText, map)))
      throw new Error(
        'This page uses an older source snapshot. Reload the page or use Guide Editor; no edits were applied.',
      );
    const rangeKey = (range: InlineEdit['range']) =>
      JSON.stringify([
        range.start.offset,
        range.end.offset,
        range.start.line,
        range.start.column,
        range.end.line,
        range.end.column,
        range.startLine,
        range.endLine,
      ]);
    const targets = new Map<string, string>();
    const bareUrlIds = new Set<string>();
    const visitInline = (nodes: InlineNode[]) => {
      for (const node of nodes) {
        if (node.type === 'text')
          targets.set(`text:${rangeKey(node.range)}`, node.value);
        else if (node.type === 'link') {
          if (node.urlRange && !node.labelRange)
            bareUrlIds.add(
              `link-url-${node.urlRange.start.offset}-${node.urlRange.end.offset}`,
            );
          if (node.urlRange)
            targets.set(`link-url:${rangeKey(node.urlRange)}`, node.url);
          if (
            node.labelRange &&
            node.children.length === 1 &&
            node.children[0].type === 'text'
          )
            targets.set(
              `link-label:${rangeKey(node.labelRange)}`,
              node.children[0].value,
            );
        } else if ('children' in node && node.type !== 'image')
          visitInline(node.children);
      }
    };
    const visitBlocks = (blocks: BlockNode[]) => {
      for (const block of blocks) {
        if (block.type === 'list')
          block.items.forEach((item) => visitBlocks(item.children));
        else if (block.type === 'blockquote') visitBlocks(block.children);
        else if (
          block.type === 'heading' ||
          block.type === 'paragraph' ||
          block.type === 'subtext'
        )
          visitInline(block.children);
      }
    };
    parseGuide(loaded.originalText).messages.forEach((message) =>
      visitBlocks(message.blocks),
    );
    for (const entry of map.entries)
      if (targets.get(`${entry.kind}:${rangeKey(entry.range)}`) !== entry.value)
        throw new Error(
          'Source-map range or value does not match the original parse',
        );
    // The parser verifies provenance and syntax; a no-op must preserve the exact snapshot.
    if (
      applyInlineEdits(
        loaded.originalText,
        map.entries.map((entry) => ({
          kind: entry.kind,
          range: entry.range,
          replacement: entry.value,
        })),
      ) !== loaded.originalText
    )
      throw new Error('Source-map values do not match the guide');
    return new EditSession(map, loaded, bareUrlIds, options.allowEmptyRows);
  }

  get path() {
    return this.map.path;
  }
  get sourceHash() {
    return this.map.sourceHash;
  }
  get originalContent() {
    return this.loaded.originalText;
  }
  get count() {
    return this.#documentDraft !== undefined
      ? 1
      : this.#pending.size + this.#lineChanges.size;
  }
  get hasDocumentDraft() {
    return this.#documentDraft !== undefined;
  }
  setDocument(content: string) {
    const validated = validatePageSource(this.originalContent, content);
    this.#pending.clear();
    this.#lineChanges.clear();
    this.#linePrefixes.clear();
    this.#lineLinks.clear();
    this.#documentDraft =
      validated === this.originalContent ? undefined : validated;
  }
  isBareUrl(id: string) {
    return this.bareUrlIds.has(id);
  }
  get changes(): PendingChange[] {
    if (this.#documentDraft !== undefined)
      return [
        {
          kind: 'document',
          entryId: 'document',
          replacement: this.#documentDraft,
        },
      ];
    return [...this.#pending]
      .map(([entryId, edit]): PendingChange => ({
        entryId,
        replacement: edit.replacement,
      }))
      .concat(
        [...this.#lineChanges].map(([entryId, replacement]) => ({
          kind: 'line' as const,
          entryId,
          replacement,
          ...(this.#lineLinks.has(entryId)
            ? { links: [...this.#lineLinks.get(entryId)!] }
            : {}),
          ...(this.#linePrefixes.has(entryId)
            ? { prefixes: [...this.#linePrefixes.get(entryId)!] }
            : {}),
        })),
      );
  }
  entry(id: string): EditableEntry {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error('Unsupported editing target');
    return entry;
  }
  value(id: string): string {
    return this.#pending.get(id)?.replacement ?? this.entry(id).value;
  }
  line(id: string): SourceLine {
    const line = this.lines.find((line) => line.id === id);
    if (!line) throw new Error('Unsupported source line');
    return this.#lineLinks.has(id)
      ? { ...line, newLinks: this.#lineLinks.get(id) }
      : line;
  }
  changeEntry(id: string) {
    if (id === 'document')
      return {
        id,
        kind: 'page',
        range: parseGuide(this.originalContent).range,
        value: this.originalContent,
      };
    const line = this.lines.find((line) => line.id === id);
    return line
      ? { id, kind: 'line', range: line.range, value: line.raw }
      : this.entry(id);
  }
  private literalEdits(pending: Map<string, InlineEdit>): SourceEdit[] {
    applyInlineEdits(this.originalContent, [...pending.values()]);
    return [...pending.values()].map((edit) => {
      const updated = applyInlineEdits(this.originalContent, [edit]);
      const start = edit.range.start.offset,
        end = edit.range.end.offset;
      return {
        start,
        end,
        original: this.originalContent.slice(start, end),
        replacement: updated.slice(
          start,
          updated.length - (this.originalContent.length - end),
        ),
      };
    });
  }
  private tokenSource(token: LineToken, pending = this.#pending): string {
    if (token.id.startsWith('new-link:')) return token.raw;
    const start = token.node.range.start.offset,
      end = token.node.range.end.offset;
    const applicable = new Map(
      [...pending].filter(
        ([, edit]) =>
          edit.range.start.offset >= start && edit.range.end.offset <= end,
      ),
    );
    if (!applicable.size) return token.raw;
    const edits = this.literalEdits(applicable).map((edit) => ({
      ...edit,
      start: edit.start - start,
      end: edit.end - start,
    }));
    // All literal source edits continue to go through the shared parser API.
    return applyLineSourceEdits(token.raw, edits, new Set());
  }
  private baseLineValue(line: SourceLine, pending = this.#pending): string {
    const applicable = new Map(
      [...pending].filter(
        ([, edit]) =>
          edit.range.start.offset >= line.range.start.offset &&
          edit.range.end.offset <= line.range.end.offset,
      ),
    );
    if (!applicable.size) return line.raw;
    // Extract the exact changed interval without rebasing any original ranges.
    const updated = applyInlineEdits(this.originalContent, [
      ...applicable.values(),
    ]);
    return updated.slice(
      line.range.start.offset,
      updated.length - (this.originalContent.length - line.range.end.offset),
    );
  }
  lineValue(id: string): string {
    return this.#lineChanges.get(id) ?? this.baseLineValue(this.line(id));
  }
  lineModel(id: string): RichLine {
    if (this.#linePrefixes.get(id)?.length === 0) return [];
    const line = this.line(id);
    return readRichLine(line, this.lineValue(id), (token) =>
      this.tokenSource(token),
    );
  }
  tokenValue(token: LineToken): string {
    return this.tokenSource(token);
  }
  isLineChanged(id: string) {
    return this.#lineChanges.has(id);
  }
  linePrefixes(id: string, rows = this.lineModel(id).length): string[] {
    const current = this.#linePrefixes.get(id) || [];
    return Array.from(
      { length: rows },
      (_, index) => current[index] ?? current.at(-1) ?? this.line(id).prefix,
    );
  }
  lineChange(
    id: string,
    model: RichLine,
    prefixes = this.linePrefixes(id, model.length),
  ): PendingChange {
    const line = this.line(id);
    if (!model.length)
      return { kind: 'line', entryId: id, replacement: '', prefixes: [] };
    const normalized = normalizeRichLine(model);
    const original = readRichLine(line, this.baseLineValue(line), (token) =>
      this.tokenSource(token),
    );
    const replacement =
      JSON.stringify(normalized) === JSON.stringify(original)
        ? this.baseLineValue(line)
        : writeRichLine(line, normalized, (token) => this.tokenSource(token));
    const links = normalized
      .flat()
      .flatMap((part) =>
        part.type === 'token' && part.id.startsWith('new-link:')
          ? [inlineTokenFromId(part.id)?.raw || '']
          : [],
      );
    return {
      kind: 'line',
      entryId: id,
      replacement,
      prefixes,
      ...(links.length ? { links } : {}),
    };
  }
  setLine(id: string, model: RichLine, prefixes?: string[]) {
    this.setChanges([this.lineChange(id, model, prefixes)]);
  }

  /** Atomic: invalid new changes never replace the last valid batch. */
  setChanges(changes: readonly PendingChange[]): void {
    if (changes.some((change) => change?.kind === 'document')) {
      if (
        changes.length !== 1 ||
        changes[0].entryId !== 'document' ||
        changes[0].prefixes !== undefined
      )
        throw new Error('A page draft must be one complete source snapshot');
      this.setDocument(changes[0].replacement);
      return;
    }
    if (this.hasDocumentDraft)
      throw new Error('Edit this draft in the page canvas');
    const next = new Map(this.#pending);
    const nextLines = new Map(this.#lineChanges);
    const nextPrefixes = new Map(this.#linePrefixes);
    const nextLinks = new Map(this.#lineLinks);
    for (const change of changes) {
      if (change.links !== undefined) {
        if (
          change.kind !== 'line' ||
          !Array.isArray(change.links) ||
          change.links.some(
            (raw) => typeof raw !== 'string' || !newLinkToken(raw),
          )
        )
          throw new Error('Invalid new links');
        nextLinks.set(change.entryId, [...change.links]);
      } else if (change.kind === 'line') nextLinks.delete(change.entryId);
    }
    const seen = new Set<string>();
    for (const change of changes) {
      if (
        !change ||
        typeof change.entryId !== 'string' ||
        typeof change.replacement !== 'string' ||
        seen.has(change.entryId)
      )
        throw new Error('Invalid or repeated editing operation');
      seen.add(change.entryId);
      if (change.kind === 'line') continue;
      if (change.prefixes !== undefined)
        throw new Error('Indentation requires a source line');
      if (change.kind !== undefined)
        throw new Error('Unsupported editing operation');
      const entry = this.entry(change.entryId);
      const owner = this.lines.find((line) => line.entryIds.includes(entry.id));
      if (owner && nextLines.has(owner.id) && entry.kind === 'text')
        throw new Error('Edit this content through its whole-line editor');
      if (change.replacement === entry.value) next.delete(entry.id);
      else
        next.set(entry.id, {
          kind: entry.kind,
          range: entry.range,
          replacement: change.replacement,
        });
    }
    // Fold link-dialog edits into any existing line operation without replacing its text/formatting.
    for (const [id, body] of nextLines) {
      if (
        changes.some(
          (change) => change.kind === 'line' && change.entryId === id,
        )
      )
        continue;
      const line = this.line(id),
        model = readRichLine(line, body, (token) => this.tokenSource(token));
      if (
        line.tokens.some(
          (token) => this.tokenSource(token) !== this.tokenSource(token, next),
        )
      )
        nextLines.set(
          id,
          writeRichLine(line, model, (token) => this.tokenSource(token, next)),
        );
    }
    for (const change of changes.filter((change) => change.kind === 'line')) {
      const line = {
        ...this.line(change.entryId),
        newLinks: nextLinks.get(change.entryId),
      };
      if (change.prefixes?.length === 0) {
        if (
          change.replacement !== '' ||
          line.kind !== 'paragraph' ||
          line.tokens.length
        )
          throw new Error('Only unprotected empty text rows can be removed');
        nextPrefixes.set(line.id, []);
        nextLines.set(line.id, '');
        for (const id of line.entryIds) next.delete(id);
        continue;
      }
      readRichLine(line, change.replacement, (token) =>
        this.tokenSource(token, next),
      );
      const rows = change.replacement.split(/\r\n|\n|\r/).length;
      const prefixes = validateLinePrefixes(
        line,
        change.prefixes ?? Array(rows).fill(line.prefix),
        rows,
      );
      const indented = prefixes.some((prefix) => prefix !== line.prefix);
      if (indented) nextPrefixes.set(line.id, prefixes);
      else nextPrefixes.delete(line.id);
      for (const id of line.entryIds)
        if (next.get(id)?.kind === 'text') next.delete(id);
      if (!indented && change.replacement === this.baseLineValue(line, next))
        nextLines.delete(line.id);
      else nextLines.set(line.id, change.replacement);
    }
    this.buildContent(next, nextLines, nextPrefixes, nextLinks);
    this.#pending = next;
    this.#lineChanges = nextLines;
    this.#linePrefixes = nextPrefixes;
    this.#lineLinks = nextLinks;
  }
  replaceChanges(changes: readonly PendingChange[]) {
    const pending = this.#pending,
      lines = this.#lineChanges,
      prefixes = this.#linePrefixes,
      links = this.#lineLinks,
      document = this.#documentDraft;
    this.#pending = new Map();
    this.#lineChanges = new Map();
    this.#linePrefixes = new Map();
    this.#lineLinks = new Map();
    this.#documentDraft = undefined;
    try {
      this.setChanges(changes);
    } catch (error) {
      this.#pending = pending;
      this.#lineChanges = lines;
      this.#linePrefixes = prefixes;
      this.#lineLinks = links;
      this.#documentDraft = document;
      throw error;
    }
  }
  undo(id: string) {
    if (id === 'document') {
      this.discard();
      return;
    }
    if (this.#lineChanges.has(id)) {
      this.#lineChanges.delete(id);
      this.#linePrefixes.delete(id);
      this.#lineLinks.delete(id);
      return;
    }
    this.entry(id);
    this.setChanges([{ entryId: id, replacement: this.entry(id).value }]);
  }
  discard() {
    this.#pending.clear();
    this.#lineChanges.clear();
    this.#linePrefixes.clear();
    this.#lineLinks.clear();
    this.#documentDraft = undefined;
  }
  content(): string {
    if (this.#documentDraft !== undefined) return this.#documentDraft;
    return this.buildContent(
      this.#pending,
      this.#lineChanges,
      this.#linePrefixes,
    );
  }
  private buildContent(
    pending: Map<string, InlineEdit>,
    lines: Map<string, string>,
    prefixes: Map<string, string[]>,
    links = this.#lineLinks,
  ): string {
    if (!lines.size)
      return applyInlineEdits(this.originalContent, [...pending.values()]);
    const lineRanges = [...lines].map(([id, body]) => {
      const line = { ...this.line(id), newLinks: links.get(id) };
      if (prefixes.get(id)?.length === 0) {
        const start = line.range.start.offset - line.prefix.length;
        const tail =
          this.originalContent
            .slice(line.range.end.offset)
            .match(/^(?:\r\n|\n|\r)/)?.[0] || '';
        return {
          start,
          end: line.range.end.offset + tail.length,
          original: this.originalContent.slice(
            start,
            line.range.end.offset + tail.length,
          ),
          replacement: '',
        };
      }
      readRichLine(line, body, (token) => this.tokenSource(token, pending));
      const rowPrefixes = prefixes.get(id);
      if (rowPrefixes)
        readRichLine(
          line,
          body,
          (token) => this.tokenSource(token, pending),
          rowPrefixes,
        );
      const includePrefix = !!rowPrefixes && rowPrefixes[0] !== line.prefix;
      const start =
        line.range.start.offset - (includePrefix ? line.prefix.length : 0);
      const replacement = rowPrefixes
        ? body
            .split(/\r\n|\n|\r/)
            .map((row, index) =>
              index
                ? rowPrefixes[index] + row.slice(line.prefix.length)
                : (includePrefix ? rowPrefixes[0] : '') + row,
            )
            .join(line.eol)
        : body;
      return {
        start,
        end: line.range.end.offset,
        original: this.originalContent.slice(start, line.range.end.offset),
        replacement,
      };
    });
    const leafEdits = this.literalEdits(pending).filter(
      (edit) =>
        !lineRanges.some(
          (line) => edit.start >= line.start && edit.end <= line.end,
        ),
    );
    return applyLineSourceEdits(
      this.originalContent,
      [...leafEdits, ...lineRanges],
      new Set(lineRanges.map((line) => line.start)),
      prefixes.size > 0 ||
        lineRanges.some((line) => /[\r\n]/.test(line.replacement)),
    );
  }
  diagnostics() {
    return parseGuide(this.content()).diagnostics;
  }

  async prepareUpdate(
    description: { title: string; notes: string },
    currentSource: LoadedGuideSource,
  ): Promise<GuideUpdatePayload> {
    if (!this.count) throw new Error('No pending changes');
    if (
      !description.title.trim() ||
      description.title.trim().length > 120 ||
      !description.notes.trim() ||
      description.notes.trim().length > 2000
    )
      throw new Error(
        'Add a title (up to 120 characters) and a reason (up to 2000 characters)',
      );
    if (
      currentSource.path !== this.path ||
      currentSource.source !== this.loaded.source ||
      currentSource.branch !== this.loaded.branch ||
      currentSource.repo !== this.loaded.repo ||
      currentSource.baseBranch !== this.loaded.baseBranch ||
      (currentSource.existingReviewBranch || '') !==
        (this.loaded.existingReviewBranch || '') ||
      !(await verifySourceVersion(currentSource.originalText, this.map))
    )
      throw new Error(
        'Source or review metadata changed. Keep this draft and reload before preparing an update.',
      );
    const content = this.content();
    if (content === this.originalContent) throw new Error('No source changes');
    return {
      type: 'update',
      repo: 'pvme/pvme-guides',
      baseBranch: 'master',
      path: this.path,
      originalContent: this.originalContent,
      content,
      title: description.title.trim(),
      notes: description.notes.trim(),
      source: this.loaded.source,
      branch: this.loaded.branch,
      existingReviewBranch: this.loaded.existingReviewBranch || '',
      replaceExistingReview: false,
    };
  }
}
