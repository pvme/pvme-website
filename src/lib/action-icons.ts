/** Toolbar icons use the same paths and 1.6px stroke in Astro and browser code. */
export const actionIconPaths = {
  undo: 'M9 5 4 10l5 5 M4 10h10a6 6 0 0 1 0 12',
  redo: 'm15 5 5 5-5 5 M20 10H10a6 6 0 0 0 0 12',
  submit: 'M12 16V3 M7 8l5-5 5 5 M4 14v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6',
  discard: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  chevronDown: 'm6 9 6 6 6-6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
} as const;

export function createActionIcon(
  doc: Document,
  name: keyof typeof actionIconPaths,
) {
  const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24',
    width: '16',
    height: '16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    icon.setAttribute(key, value);
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', actionIconPaths[name]);
  icon.append(path);
  return icon;
}
