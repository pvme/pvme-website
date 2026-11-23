import type { CombatSetup, Guide, Style } from '../schema';

export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const badge = (text: string, kind = '') => `<span class="badge ${esc(kind)}">${esc(text)}</span>`;
export const sourceLabel = (kind: string) => ({ 'context-heading': 'Section to check', 'method-heading': 'Method', 'guide-title': 'Guide title', 'source-location': 'File' }[kind] ?? 'Source');
export const vscode = (guide: Guide, line = 1) => `vscode://file/${encodeURI(guide.absolutePath.replaceAll('\\', '/')).replaceAll('#', '%23').replaceAll('?', '%3F')}:${line}`;
export function styleLabel(styles: Style[], setups: CombatSetup[] = []) {
  const hybrids = [...new Set(setups.filter(s => s.style === 'Hybrid').map(s => `Hybrid (${s.components.join(' + ') || 'components not listed'})`))];
  return styles.flatMap(style => style === 'Hybrid' ? hybrids.length ? hybrids : ['Hybrid'] : [style]).join(' · ');
}
