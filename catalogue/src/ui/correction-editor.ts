import type { CataloguePatch, MethodMatch, MethodCorrection } from '../corrections';
import type { Heading, Issue, GuideType } from '../schema';
import type { CorrectionMode } from './workflow';
import { GUIDE_TYPES, GUIDE_TYPE_LABELS } from '../guide-types';
import { esc } from './html';

export interface FixData {
  methods: { id: string; label: string; line: number; parents: string[]; match: MethodMatch; tag: string | null; styles: string[]; type?: 'Method' | 'Combat Achievement'; attributes?: string[] }[];
  headings: Heading[]; fileTypes?: GuideType[]; sectionTypes?: GuideType[][]; headingMatches?: MethodMatch[];
  anchors: { tag: string; line: number }[];
  presets: { url: string; label: string; line: number }[];
}
export function correctionForm(mode: CorrectionMode, data: FixData, issue: Issue, drafts: Record<string, string>): string {
  const method = data.methods.find(m => m.id === issue.methodId);
  const preset = data.presets.find(p => p.line === issue.line);
  const select = (id: string, label: string, options: { value: string; label: string }[], initial = '') => `<label for="${id}">${esc(label)}</label><select id="${id}" required>${options.map(o => `<option value="${esc(o.value)}" ${o.value === (drafts[id] ?? initial) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  const blank = { value: '', label: 'Choose…' };
  const methodOptions = data.methods.map((m, index) => ({ value: String(index), label: `${m.parents.length ? `${m.parents.join(' / ')} / ` : ''}${m.label} (line ${m.line})` }));
  const methodSelect = () => select('fix-method', 'Method', [blank, ...methodOptions], method ? String(data.methods.indexOf(method)) : '');
  let fields = '';
  if (mode === 'preset' || (mode === 'styles' && preset)) {
    fields += select('fix-preset', 'Preset', [blank, ...data.presets.map((p, index) => ({ value: String(index), label: `${p.label} (line ${p.line})` }))], preset ? String(data.presets.indexOf(preset)) : '');
    if (mode === 'preset') fields += `<fieldset><legend>Where is this preset used?</legend><p class="hint">Choose every method that uses it, or keep it at guide level if it is shared without a specific method.</p>${select('fix-scope', 'Preset use', [blank, { value: 'methods', label: 'Use with selected methods' }, { value: 'shared', label: 'Shared — keep at guide level' }])}${data.methods.map((m, index) => `<label class="check-label"><input type="checkbox" id="fix-owner-${index}" ${drafts[`fix-owner-${index}`] === 'yes' ? 'checked' : ''}>${esc(methodOptions[index].label)}</label>`).join('')}</fieldset>`;
  } else if (mode === 'section') {
    const selected = data.headings.findIndex(h => h.line === issue.line);
    const initial = selected >= 0 ? String(selected) : '__file';
    const chosen = drafts['fix-heading'] ?? initial;
    const current = chosen === '__file' ? data.fileTypes ?? [] : data.sectionTypes?.[Number(chosen)] ?? [];
    fields += select('fix-heading', 'File or source section', [{ value: '__file', label: 'Whole file (default purpose)' }, ...data.headings.map((h, index) => ({ value: String(index), label: `${h.parents.join(' / ')}${h.parents.length ? ' / ' : ''}${h.label} (line ${h.line})` }))], initial);
    fields += `<fieldset><legend>Guide types</legend><p class="hint">Choose all that apply. File-level purpose and individual section types combine in the catalogue. Types describe content purpose; styles and individual methods stay separate. Clear all types to leave this section unclassified.</p>${GUIDE_TYPES.map(type => `<label class="check-label"><input type="checkbox" id="fix-guide-type-${type}" ${(drafts[`fix-guide-type-${type}`] ?? (current.includes(type) ? 'yes' : 'no')) === 'yes' ? 'checked' : ''}>${esc(GUIDE_TYPE_LABELS[type])}</label>`).join('')}</fieldset>`;
  } else if (mode === 'declare') {
    fields += select('fix-heading', 'Heading to list as a method', [blank, ...data.headings.map((h, index) => ({ value: String(index), label: `${h.parents.join(' / ')}${h.parents.length ? ' / ' : ''}${h.label} (line ${h.line})` }))], issue.line ? String(data.headings.findIndex(h => h.line === issue.line)) : '');
  } else if (method || mode !== 'styles') fields += mode === 'details' ? methodSelect().replace('<select ', '<select disabled ') : methodSelect();
  if (mode === 'details') fields += `<label for="fix-label">Catalogue label</label><input id="fix-label" value="${esc(drafts['fix-label'] ?? method?.label ?? '')}" required>${select('fix-type', 'Method purpose', [{ value: 'Method', label: 'Method' }, { value: 'Combat Achievement', label: 'Combat Achievement' }], drafts['fix-type'] ?? 'Method')}<label for="fix-attributes">Attributes (comma-separated)</label><input id="fix-attributes" value="${esc(drafts['fix-attributes'] ?? '')}" placeholder="e.g. Solo, Low Effort"><p class="hint">These replace the method’s detected attributes in the catalogue.</p>`;
  if (mode === 'method') fields += select('fix-include', 'Should this appear as a separate method?', [blank, { value: 'yes', label: 'Yes — list it as a method' }, { value: 'no', label: 'No — this is supporting guide text' }]);
  if (mode === 'context') fields += select('fix-context', 'Which section groups this method?', [blank, { value: 'none', label: 'No extra grouping' }, ...data.headings.map((h, index) => ({ value: String(index), label: `${h.label} (line ${h.line})` }))]);
  if (mode === 'anchor') fields += select('fix-anchor', 'Link to use for this method', [blank, ...data.anchors.map(a => ({ value: a.tag, label: `${a.tag} (line ${a.line})` })), { value: '__none', label: 'No direct section link' }]) + '<p class="hint">To create a new .tag in the guide text, use VS Code. Here you can choose an existing tag or explicitly leave the method without a link.</p>';
  if (mode === 'styles' || mode === 'details') fields += `<label for="fix-styles">Combat styles${mode === 'details' ? ' (optional)' : ''}</label><input id="fix-styles" value="${esc(drafts['fix-styles'] ?? '')}" placeholder="e.g. necromancy, melee-mage" ${mode === 'details' ? '' : 'required'}><p class="hint">Separate alternative styles with commas. Use melee-mage for a hybrid using both styles together. Enter “any” if the method works with any style.${mode === 'details' ? ' Leave blank to keep the current styles.' : ''}</p>`;
  return `<p>Save your choice in overrides.json in the catalogue repository. The source guide stays unchanged. It will be used each time the catalogue is rebuilt.</p>${fields}`;
}
export function correctionPatch(mode: CorrectionMode, data: FixData, issue: Issue, values: Record<string, string>): CataloguePatch | { guideStyles: string[] } {
  const index = (key: string) => values[key] !== '' && values[key] !== undefined && /^\d+$/.test(values[key]) ? Number(values[key]) : -1;
  const method = data.methods[index('fix-method')];
  const preset = data.presets[index('fix-preset')];
  const styles = () => {
    const text = values['fix-styles']?.trim();
    if (!text) throw new Error('Enter a combat style, a hybrid combination, or “any”.');
    return text.toLowerCase() === 'any' ? [] : text.split(',').map(s => s.trim()).filter(Boolean);
  };
  if (mode === 'preset' || (mode === 'styles' && data.presets.some(p => p.line === issue.line))) {
    if (!preset) throw new Error('Choose the preset to correct.');
    if (mode === 'styles') return { preset: { url: preset.url, styles: styles() } };
    const owners = data.methods.filter((_, i) => values[`fix-owner-${i}`] === 'yes').map(m => m.match);
    if (!['shared', 'methods'].includes(values['fix-scope'])) throw new Error('Choose how this preset is used.');
    if (values['fix-scope'] === 'methods' && !owners.length) throw new Error('Select at least one method that uses this preset.');
    return { preset: { url: preset.url, methods: values['fix-scope'] === 'shared' ? 'shared' : owners } };
  }
  if (mode === 'section' && values['fix-heading'] === '__file') return { guideTypes: GUIDE_TYPES.filter(type => values[`fix-guide-type-${type}`] === 'yes') };
  if (mode === 'declare' || mode === 'section') {
    const heading = data.headings[index('fix-heading')];
    if (!heading) throw new Error('Choose an existing guide heading.');
    const peers = data.headings.filter(h => h.label === heading.label && JSON.stringify(h.parents) === JSON.stringify(heading.parents));
    const match = data.headingMatches?.[index('fix-heading')] ?? { heading: heading.label, parents: heading.parents, ...(peers.length > 1 ? { occurrence: peers.indexOf(heading) + 1 } : {}) };
    if (mode === 'section') return { section: { match, types: GUIDE_TYPES.filter(type => values[`fix-guide-type-${type}`] === 'yes') } };
    return { method: { match, include: true } };
  }
  if (mode === 'styles' && !issue.methodId) return { guideStyles: styles() };
  if (!method) throw new Error('Choose the method to correct.');
  if (mode === 'details') {
    if (!values['fix-label']?.trim()) throw new Error('Enter a catalogue label.');
    if (!['Method', 'Combat Achievement'].includes(values['fix-type'])) throw new Error('Choose a method classification.');
    const changes: Partial<MethodCorrection> = {};
    if (values['fix-label'].trim() !== method.label) changes.label = values['fix-label'].trim();
    if (values['fix-type'] !== (method.type ?? 'Method')) changes.type = values['fix-type'] as 'Method' | 'Combat Achievement';
    const attrs = (values['fix-attributes'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (JSON.stringify(attrs) !== JSON.stringify(method.attributes ?? [])) changes.attributes = attrs;
    if (values['fix-styles']?.trim()) changes.styles = styles();
    if (!Object.keys(changes).length) throw new Error('No catalogue details have changed yet.');
    return { method: { match: method.match, ...changes } };
  }
  if (mode === 'styles') return { method: { match: method.match, styles: styles() } };
  if (mode === 'method') {
    if (!['yes', 'no'].includes(values['fix-include'])) throw new Error('Choose whether this is a separate method.');
    return { method: { match: method.match, include: values['fix-include'] === 'yes' } };
  }
  if (mode === 'context') {
    const heading = data.headings[index('fix-context')];
    if (values['fix-context'] !== 'none' && !heading) throw new Error('Choose a grouping or “No extra grouping”.');
    return { method: { match: method.match, context: values['fix-context'] === 'none' ? null : heading.label } };
  }
  if (!values['fix-anchor']) throw new Error('Choose a section link, or “No direct section link”.');
  return { method: { match: method.match, anchor: values['fix-anchor'] === '__none' ? null : values['fix-anchor'] } };
}
