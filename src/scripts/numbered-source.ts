let sequence = 0;
/** Plain textarea editing with a synchronised, non-editable source-line gutter. */
export function numberedSource(doc: Document, source: string, label: string) {
  const root = doc.createElement('div');
  root.className = 'numbered-source';
  const gutter = doc.createElement('pre');
  gutter.className = 'source-line-numbers';
  gutter.setAttribute('aria-hidden', 'true');
  const input = doc.createElement('textarea');
  input.value = source;
  input.wrap = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', label);
  const location = doc.createElement('p');
  location.id = `source-caret-${++sequence}`;
  location.className = 'source-caret-location';
  input.setAttribute('aria-describedby', location.id);
  const refresh = () => {
    gutter.textContent = input.value
      .split('\n')
      .map((_, i) => i + 1)
      .join('\n');
    const before = input.value.slice(0, input.selectionStart || 0);
    location.textContent = `Source line ${before.split('\n').length}, column ${before.length - before.lastIndexOf('\n')}`;
  };
  input.addEventListener('input', refresh);
  input.addEventListener('keyup', refresh);
  input.addEventListener('click', refresh);
  input.addEventListener('select', refresh);
  input.addEventListener('scroll', () => {
    gutter.scrollTop = input.scrollTop;
  });
  root.append(gutter, input);
  refresh();
  return { root, input, location, refresh };
}
