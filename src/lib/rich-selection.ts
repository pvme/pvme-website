import { newLinkToken } from './rich-token';
import {
  normalizeRichLine,
  type RichLine,
  type RichPart,
  type LineMark,
} from './source-lines';

/** Offsets count text in UTF-16 units, protected objects as one, row breaks as one. */
export function selectionParts(
  model: RichLine,
  start: number,
  end: number,
): RichPart[] {
  let position = 0;
  const selected: RichPart[] = [];
  for (const row of model) {
    for (const part of row) {
      const size = part.type === 'text' ? part.text.length : 1;
      const from = Math.max(0, start - position),
        to = Math.min(size, end - position);
      // Spaces at the edges of a selection must not prevent toggling off a mark.
      if (
        from < to &&
        (part.type === 'token' || part.text.slice(from, to).trim())
      )
        selected.push(part);
      position += size;
    }
    position++;
  }
  return selected;
}

/** A caret immediately before a token targets it; immediately after targets it too. */
export function selectionTokenIds(
  model: RichLine,
  start: number,
  end: number,
): string[] {
  let position = 0;
  const selected: string[] = [];
  let preceding: string | undefined;
  for (const row of model) {
    for (const part of row) {
      const size = part.type === 'text' ? part.text.length : 1;
      if (part.type === 'token') {
        if (start === end) {
          if (position === start) return [part.id];
          if (position + size === start) preceding = part.id;
        } else if (position < end && position + size > start)
          selected.push(part.id);
      }
      position += size;
    }
    position++;
  }
  return start === end ? (preceding ? [preceding] : []) : selected;
}

export function selectionMarkState(
  model: RichLine,
  start: number,
  end: number,
  mark: LineMark,
): 'true' | 'false' | 'mixed' {
  const parts = selectionParts(model, start, end);
  if (!parts.length || parts.every((part) => !part.marks.includes(mark)))
    return 'false';
  return parts.every((part) => part.marks.includes(mark)) ? 'true' : 'mixed';
}

export function toggleSelectionMark(
  model: RichLine,
  start: number,
  end: number,
  mark: LineMark,
): RichLine {
  const remove = selectionMarkState(model, start, end, mark) === 'true';
  let position = 0;
  return normalizeRichLine(
    model.map((row) => {
      const result: RichPart[] = [];
      for (const part of row) {
        const size = part.type === 'text' ? part.text.length : 1;
        const from = Math.max(0, start - position),
          to = Math.min(size, end - position);
        if (from < to) {
          const marks = remove
            ? part.marks.filter((existing) => existing !== mark)
            : [...new Set([...part.marks, mark])];
          if (part.type === 'text') {
            if (from) result.push({ ...part, text: part.text.slice(0, from) });
            result.push({ ...part, text: part.text.slice(from, to), marks });
            if (to < size) result.push({ ...part, text: part.text.slice(to) });
          } else result.push({ ...part, marks });
        } else result.push(part);
        position += size;
      }
      position++;
      return result;
    }),
  );
}

export function linkSelection(
  model: RichLine,
  start: number,
  end: number,
  url: string,
): RichLine {
  if (start >= end) throw new Error('Select the text to link first.');
  let offset = 0;
  return normalizeRichLine(
    model.map((row) => {
      const size = row.reduce(
        (sum, part) => sum + (part.type === 'text' ? part.text.length : 1),
        0,
      );
      const rowStart = offset;
      offset += size + 1;
      if (start >= rowStart + size || end <= rowStart) return row;
      if (start < rowStart || end > rowStart + size)
        throw new Error('Select text within a single line.');
      let position = rowStart;
      const selected: RichPart[] = [];
      for (const part of row) {
        const length = part.type === 'text' ? part.text.length : 1;
        const from = Math.max(0, start - position),
          to = Math.min(length, end - position);
        if (from < to) {
          if (part.type !== 'text')
            throw new Error(
              'Select text without existing links or protected objects.',
            );
          selected.push({ ...part, text: part.text.slice(from, to) });
        }
        position += length;
      }
      const marks = selected[0].marks.filter((mark) =>
        selected.every((part) => part.marks.includes(mark)),
      );
      const delimiters = {
        bold: '**',
        italic: '*',
        underline: '__',
        strikethrough: '~~',
        spoiler: '||',
      };
      const label = selected
        .map((part) => {
          if (part.type !== 'text') return '';
          const innerMarks = part.marks.filter((mark) => !marks.includes(mark));
          const text = part.text.replace(/[\\[\]<>*_~`|]/g, '\\$&');
          return (
            innerMarks.map((mark) => delimiters[mark]).join('') +
            text +
            [...innerMarks]
              .reverse()
              .map((mark) => delimiters[mark])
              .join('')
          );
        })
        .join('');
      const token = newLinkToken(`[${label}](<${url.trim()}>)`);
      if (!token) throw new Error('Enter a valid http or https URL.');
      const result: RichPart[] = [];
      position = rowStart;
      let inserted = false;
      for (const part of row) {
        const length = part.type === 'text' ? part.text.length : 1;
        const from = Math.max(0, start - position),
          to = Math.min(length, end - position);
        if (from < to && part.type === 'text') {
          if (from) result.push({ ...part, text: part.text.slice(0, from) });
          if (!inserted) {
            result.push({ type: 'token', id: token.id, marks });
            inserted = true;
          }
          if (to < length) result.push({ ...part, text: part.text.slice(to) });
        } else result.push(part);
        position += length;
      }
      return result;
    }),
  );
}
