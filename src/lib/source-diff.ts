export interface DiffLine {
  kind: 'context' | 'remove' | 'add';
  text: string;
  parts?: { text: string; changed: boolean; editIndex?: number }[];
}

/** Exact line tokens retain LF, CRLF, lone CR and the missing final newline. */
const lines = (source: string): string[] =>
  source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) || [];

/** Textareas normalize newlines to LF. Restore untouched source line endings;
 * changed rows inherit the replaced row's ending and new rows the file default. */
export function preserveSourceLineEndings(
  original: string,
  edited: string,
): string {
  const normalize = (value: string) => value.replace(/\r\n|\r/g, '\n');
  if (normalize(original) === normalize(edited)) return original;
  const raw = lines(original);
  const fallback = original.match(/\r\n|\r|\n/)?.[0] || '\n';
  const diff = sourceDiff(normalize(original), normalize(edited));
  let index = 0,
    result = '';
  for (let position = 0; position < diff.length;) {
    if (diff[position].kind === 'context') {
      result += raw[index++];
      position++;
      continue;
    }
    const endings: string[] = [],
      added: string[] = [];
    while (position < diff.length && diff[position].kind !== 'context') {
      const line = diff[position++];
      if (line.kind === 'remove')
        endings.push(raw[index++].match(/(?:\r\n|\r|\n)$/)?.[0] || fallback);
      else added.push(line.text);
    }
    result += added
      .map((line, offset) =>
        line.endsWith('\n')
          ? line.slice(0, -1) + (endings[offset] || fallback)
          : line,
      )
      .join('');
  }
  return result;
}

/** Myers shortest-edit-path line diff. No quadratic table or rendering-HTML comparison. */
export function sourceDiff(before: string, after: string): DiffLine[] {
  return tokenDiff(lines(before), lines(after));
}

/** Exact draft ranges for independently reverting each changed section. */
export function sourceDiffChanges(before: string, after: string) {
  const changes: { start: number; end: number; original: string }[] = [];
  const diff = sourceDiff(before, after);
  let offset = 0;
  for (let index = 0; index < diff.length;) {
    if (diff[index].kind === 'context') {
      offset += diff[index++].text.length;
      continue;
    }
    const start = offset;
    let original = '';
    while (index < diff.length && diff[index].kind !== 'context') {
      const line = diff[index++];
      if (line.kind === 'remove') original += line.text;
      else offset += line.text.length;
    }
    changes.push({ start, end: offset, original });
  }
  return changes;
}

function tokenDiff(a: string[], b: string[], limit = 512): DiffLine[] {
  if (a.length === b.length && a.every((text, index) => text === b[index]))
    return a.map((text) => ({ kind: 'context', text }));
  const trace: Map<number, number>[] = [];
  let frontier = new Map<number, number>([[1, 0]]);
  for (let distance = 0; distance <= a.length + b.length; distance++) {
    // Bound worst-case memory for completely different large sources. A whole-file
    // removal/addition is still an exact diff and reconstructs both snapshots.
    if (distance > limit)
      return [
        ...a.map((text): DiffLine => ({ kind: 'remove', text })),
        ...b.map((text): DiffLine => ({ kind: 'add', text })),
      ];
    trace.push(new Map(frontier));
    const next = new Map<number, number>();
    for (let k = -distance; k <= distance; k += 2) {
      let x =
        k === -distance ||
        (k !== distance &&
          (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1))
          ? (frontier.get(k + 1) ?? 0)
          : (frontier.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
      }
      next.set(k, x);
      if (x >= a.length && y >= b.length) {
        const result: DiffLine[] = [];
        let bx = a.length,
          by = b.length;
        for (let d = distance; d >= 0; d--) {
          const v = trace[d],
            diagonal = bx - by;
          const previousK =
            diagonal === -d ||
            (diagonal !== d &&
              (v.get(diagonal - 1) ?? -1) < (v.get(diagonal + 1) ?? -1))
              ? diagonal + 1
              : diagonal - 1;
          const previousX = v.get(previousK) ?? 0,
            previousY = previousX - previousK;
          while (bx > previousX && by > previousY) {
            result.push({ kind: 'context', text: a[--bx] });
            by--;
          }
          if (d > 0) {
            if (bx === previousX) result.push({ kind: 'add', text: b[--by] });
            else result.push({ kind: 'remove', text: a[--bx] });
          }
        }
        return result.reverse();
      }
    }
    frontier = next;
  }
  return [];
}

export interface SourceEdit {
  start: number;
  end: number;
  original: string;
}

/** Refine each changed hunk without pairing unrelated rows.
 * Trimming shared ends makes long JSON lines cheap; cap work for large rewrites. */
export function highlightSourceDiff(
  diff: DiffLine[],
  edits: SourceEdit[] = [],
): DiffLine[] {
  const result: DiffLine[] = [];
  let draftOffset = 0;
  for (let index = 0; index < diff.length;) {
    if (diff[index].kind === 'context') {
      draftOffset += diff[index].text.length;
      result.push(diff[index++]);
      continue;
    }
    const hunk: DiffLine[] = [];
    while (index < diff.length && diff[index].kind !== 'context')
      hunk.push(diff[index++]);
    const before = hunk
      .filter((line) => line.kind === 'remove')
      .map((line) => line.text)
      .join('');
    const after = hunk
      .filter((line) => line.kind === 'add')
      .map((line) => line.text)
      .join('');
    let prefix = 0,
      suffix = 0;
    while (
      prefix < before.length &&
      prefix < after.length &&
      before[prefix] === after[prefix]
    )
      prefix++;
    // Never split a surrogate pair at a highlighted boundary.
    if (prefix && /[\uDC00-\uDFFF]/.test(before[prefix] || '')) prefix--;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - suffix - 1] === after[after.length - suffix - 1]
    )
      suffix++;
    if (suffix && /[\uDC00-\uDFFF]/.test(before[before.length - suffix] || ''))
      suffix--;
    const oldMiddle = before.slice(prefix, before.length - suffix);
    const newMiddle = after.slice(prefix, after.length - suffix);
    const refined: DiffLine[] =
      oldMiddle.length + newMiddle.length > 20000
        ? [
            { kind: 'remove', text: oldMiddle },
            { kind: 'add', text: newMiddle },
          ]
        : tokenDiff(Array.from(oldMiddle), Array.from(newMiddle), 128);
    const removed: [number, number, number][] = [],
      added: [number, number, number][] = [];
    let oldOffset = prefix,
      newOffset = prefix;
    let activeEdit: number | undefined;
    const append = (
      ranges: [number, number, number][],
      start: number,
      end: number,
      id: number,
    ) => {
      if (start === end) return;
      const last = ranges.at(-1);
      if (last?.[1] === start && last[2] === id) last[1] = end;
      else ranges.push([start, end, id]);
    };
    for (const part of refined) {
      if (part.kind === 'context') activeEdit = undefined;
      else {
        if (activeEdit === undefined) {
          activeEdit = edits.length;
          edits.push({
            start: draftOffset + newOffset,
            end: draftOffset + newOffset,
            original: '',
          });
        }
        const edit = edits[activeEdit];
        if (part.kind === 'remove') {
          edit.original += part.text;
          append(removed, oldOffset, oldOffset + part.text.length, activeEdit);
        } else {
          edit.end += part.text.length;
          append(added, newOffset, newOffset + part.text.length, activeEdit);
        }
      }
      if (part.kind !== 'add') oldOffset += part.text.length;
      if (part.kind !== 'remove') newOffset += part.text.length;
    }
    draftOffset += after.length;
    oldOffset = newOffset = 0;
    for (const line of hunk) {
      const start = line.kind === 'remove' ? oldOffset : newOffset;
      const ranges = line.kind === 'remove' ? removed : added;
      const parts: NonNullable<DiffLine['parts']> = [];
      let cursor = 0;
      for (const [from, to, editIndex] of ranges) {
        const a = Math.max(0, from - start),
          b = Math.min(line.text.length, to - start);
        if (a >= b) continue;
        if (a > cursor)
          parts.push({ text: line.text.slice(cursor, a), changed: false });
        parts.push({ text: line.text.slice(a, b), changed: true, editIndex });
        cursor = b;
      }
      if (cursor < line.text.length)
        parts.push({ text: line.text.slice(cursor), changed: false });
      result.push({ ...line, parts });
      if (line.kind === 'remove') oldOffset += line.text.length;
      else newOffset += line.text.length;
    }
  }
  return result;
}

export function displayDiffLine(
  line: DiffLine,
  showLineEndings = false,
): string {
  const ending = line.text.endsWith('\r\n')
    ? 'CRLF'
    : line.text.endsWith('\n')
      ? 'LF'
      : line.text.endsWith('\r')
        ? 'CR'
        : 'no newline';
  return `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '} ${line.text.replace(/[\r\n]+$/, '')}${showLineEndings ? ` ⟦${ending}⟧` : ''}`;
}

/** Keep the exact diff; only collapse long unchanged runs in its presentation. */
export function diffContext(
  diff: DiffLine[],
  context = 3,
): { collapsed: boolean; lines: DiffLine[] }[] {
  const result: { collapsed: boolean; lines: DiffLine[] }[] = [];
  for (let start = 0; start < diff.length;) {
    if (diff[start].kind !== 'context') {
      let end = start + 1;
      while (end < diff.length && diff[end].kind !== 'context') end++;
      result.push({ collapsed: false, lines: diff.slice(start, end) });
      start = end;
      continue;
    }
    let end = start;
    while (end < diff.length && diff[end].kind === 'context') end++;
    const head = start ? context : 0,
      tail = end < diff.length ? context : 0;
    if (end - start <= head + tail + 2)
      result.push({ collapsed: false, lines: diff.slice(start, end) });
    else {
      if (head)
        result.push({
          collapsed: false,
          lines: diff.slice(start, start + head),
        });
      result.push({
        collapsed: true,
        lines: diff.slice(start + head, end - tail),
      });
      if (tail)
        result.push({ collapsed: false, lines: diff.slice(end - tail, end) });
    }
    start = end;
  }
  return result;
}
