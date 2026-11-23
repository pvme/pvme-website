import type { BlockNode, GuideDocument, InlineNode } from '@pvme/guide-parser';
import type { CombatSetup, Heading, Issue, Method, Style } from './schema';
import { GENERIC_METHOD, normaliseHeading, ORDINARY, styleCombination } from './rules';

interface Preset extends ReturnType<typeof styleCombination> { label: string; url: string; line: number }
function inlineText(nodes: InlineNode[]): string {
  return nodes.map(n => n.type === 'emoji' ? ` ${n.name} ` : 'value' in n ? n.value : 'children' in n ? inlineText(n.children) : '').join('');
}
function inlineNodes(nodes: InlineNode[]): InlineNode[] {
  return nodes.flatMap(n => [n, ...('children' in n ? inlineNodes(n.children) : [])]);
}
function presetRows(blocks: BlockNode[]): Preset[] {
  return blocks.flatMap(block => {
    if (block.type === 'list') return block.items.flatMap(item => presetRows(item.children));
    if (block.type === 'blockquote') return presetRows(block.children);
    if (block.type !== 'paragraph') return [];
    const nodes = inlineNodes(block.children);
    return nodes.flatMap(n => {
      if (n.type !== 'link') return [];
      try {
        const url = new URL(n.url);
        if (url.protocol !== 'https:' || url.hostname !== 'presets.pvme.io') return [];
      } catch { return []; }
      const label = inlineText(n.children);
      // Only the link label and exact style emoji on its own source line count.
      // Prose elsewhere in the paragraph may describe enemy attacks or switches.
      const emoji = nodes.filter(x => x.type === 'emoji' && x.range.start.line === n.range.start.line);
      return [{ label, url: n.url, line: n.range.start.line, ...styleCombination(label, inlineText(emoji)) }];
    });
  });
}
export function sourcePresets(doc: GuideDocument) { return doc.messages.flatMap(m => presetRows(m.blocks)); }

/** Associate preset style evidence with source headings. */
export function applyPresetStyles(doc: GuideDocument, headings: Heading[], methods: Method[], path: string): { styles: Style[]; issues: Issue[]; diagnostics: Issue[]; setups: CombatSetup[] } {
  const titleSetup = styleCombination(headings.find(h => h.level === 1)?.label ?? ''), fileSetup = styleCombination(path.split('/').at(-1)!);
  const contextConflict = titleSetup.hybrid && fileSetup.hybrid && titleSetup.components.length > 0 && fileSetup.components.length > 0 && !titleSetup.components.every(c => fileSetup.components.includes(c)) && !fileSetup.components.every(c => titleSetup.components.includes(c));
  const guideSetup = titleSetup.hybrid && titleSetup.components.length > fileSetup.components.length ? titleSetup : fileSetup.hybrid ? fileSetup : titleSetup;
  const presets = sourcePresets(doc).filter(p => p.styles.length || p.ambiguous).map(p => p.ambiguous && !contextConflict && guideSetup.hybrid && p.components.length === guideSetup.components.length && p.components.every(s => guideSetup.components.includes(s)) ? { ...p, styles: ['Hybrid'] as Style[], hybrid: true, ambiguous: false } : p);
  const sections = new Map(doc.sections.map(s => [s.id, { section: s, heading: headings.find(h => h.line === s.range.start.line)! }]));
  const methodByLine = new Map(methods.map(m => [m.heading.line, m]));
  // Match against source headings, never styles accumulated from earlier
  // presets. That would make association circular and dependent on row order.
  const methodSignatures = new Map(methods.map(m => [m.id, styleCombination(m.heading.label, m.heading.emojiNames.join(' '))]));
  const sameSetup = (preset: Preset, method: Method) => {
    const signature = methodSignatures.get(method.id)!;
    if (signature.ambiguous || !signature.styles.length || preset.hybrid !== signature.hybrid) return false;
    if (preset.hybrid) return preset.components.length > 0 && preset.components.length === signature.components.length && preset.components.every(s => signature.components.includes(s));
    return preset.styles.every(s => signature.styles.includes(s));
  };
  const issues: Issue[] = [], diagnostics: Issue[] = [];
  for (const preset of presets) {
    const current = [...doc.sections].reverse().find(s => s.range.start.line <= preset.line);
    const scope = current ? sections.get(current.id) : undefined;
    let owner: Method | undefined;
    let inferred = false;
    let matchedForward = false, soleMethod = false;
    const contexts: string[] = [];
    let ancestor = scope;
    while (ancestor) {
      contexts.push(ancestor.heading.label);
      owner ??= methodByLine.get(ancestor.heading.line);
      ancestor = ancestor.section.parentId ? sections.get(ancestor.section.parentId) : undefined;
    }
    if (preset.ambiguous && !owner) {
      const candidates = methods.filter(m => { const signature = methodSignatures.get(m.id)!; return signature.ambiguous && signature.components.length === preset.components.length && preset.components.every(c => signature.components.includes(c)); });
      if (candidates.length === 1) owner = candidates[0];
    }
    if (preset.ambiguous && owner) {
      const hybrid = owner.combatSetups?.find(s => s.style === 'Hybrid' && s.components.length === preset.components.length && preset.components.every(c => s.components.includes(c)));
      if (hybrid) { preset.hybrid = true; preset.ambiguous = false; preset.styles = ['Hybrid']; }
      else if (preset.components.every(c => owner!.styles.includes(c)) && !owner.styles.includes('Hybrid')) { preset.ambiguous = false; preset.styles = preset.components; }
    }
    if (preset.ambiguous) {
      issues.push({ type: 'ambiguous-style-combination', severity: 'warning', path, line: preset.line, methodId: owner?.id,
        supportingEvidence: [`Preset label names ${preset.components.join(' + ')}`], sources: [{ kind: 'source-location', label: 'Preset label', text: `${preset.label}: ${preset.url}`, line: preset.line }],
        contradictingEvidence: contextConflict ? [`The guide title specifies Hybrid (${titleSetup.components.join(' + ')}), while its filename specifies Hybrid (${fileSetup.components.join(' + ')})`] : guideSetup.hybrid ? [`Guide title/filename instead specifies Hybrid (${guideSetup.components.join(' + ')})`] : ['No explicit hybrid or alternative marker in this preset scope'],
        message: `Preset “${preset.label || preset.url}” names ${preset.components.join(' + ')} without establishing hybrid use or independent alternatives. No single-style options were inferred from this link.` });
      continue;
    }
    const shared = contexts.some(text => /\b(?:shared|common|all methods|both methods|all strategies)\b/.test(normaliseHeading(text)));
    if (shared) owner = undefined;
    else if (!owner && scope) {
      const previous = [...methods].reverse().find(m => m.heading.line < preset.line);
      if (previous && scope.heading.level >= previous.heading.level) {
        const barriers = headings.filter(h => h.line > previous.heading.line && h.line <= preset.line && h.level <= previous.heading.level);
        // Presets frequently use a same-level sibling heading. Crossing an
        // unrelated named section or phase cannot establish method ownership.
        const signature = methodSignatures.get(previous.id)!;
        if ((!signature.styles.length || sameSetup(preset, previous)) && barriers.every(h => ORDINARY.test(normaliseHeading(h.label)) || GENERIC_METHOD.test(normaliseHeading(h.label)))) {
          owner = previous; inferred = true;
        }
      }
    }
    if (!shared && !owner && scope) {
      // Guides often put a preset list before their style-specific rotations.
      // Consider later methods in this encounter context, rather than assuming
      // that a preset must sit inside or after the method heading.
      const candidates = methods.filter(method => {
        if (method.heading.line <= preset.line || !sameSetup(preset, method)) return false;
        const barriers = headings.filter(h => h.line > preset.line && h.line < method.heading.line && h.level <= Math.max(scope.heading.level, method.heading.level - 1));
        return barriers.every(h => methodByLine.has(h.line) || ORDINARY.test(normaliseHeading(h.label)) || GENERIC_METHOD.test(normaliseHeading(h.label)) || /\b(?:perfect|master speed killer|speed killer)\b/.test(normaliseHeading(h.label)));
      });
      if (candidates.length === 1) { owner = candidates[0]; inferred = true; matchedForward = true; }
    }
    if (!shared && !owner && methods.length === 1 && (GENERIC_METHOD.test(normaliseHeading(methods[0].label)) || methods[0].heading.level === 1 || methods[0].evidence.includes('Tagged achievement strategy heading'))) {
      const method = methods[0], barriers = headings.filter(h => h.line > preset.line && h.line < method.heading.line && h.level <= method.heading.level);
      if (method.heading.line > preset.line && barriers.every(h => ORDINARY.test(normaliseHeading(h.label)) || GENERIC_METHOD.test(normaliseHeading(h.label)))) { owner = method; inferred = true; matchedForward = true; soleMethod = true; }
    }
    if (!owner) {
      const unknownCandidates = methods.filter(m => !m.styles.length);
      const finding: Issue = { type: 'ambiguous-preset-scope', severity: 'warning', path, line: preset.line,
        message: `Preset “${preset.label || preset.url}” identifies ${preset.styles.join(', ')}, but does not identify one owning method. Styles remain available at guide level.`,
        supportingEvidence: [`Preset label explicitly names ${preset.styles.join(', ')}`, `${unknownCandidates.length} methods have no independent style evidence`],
        contradictingEvidence: ['Presets may intentionally be shared by several methods; no ownership is assumed'] };
      if (!shared && unknownCandidates.length > 1) issues.push(finding);
      else if (methods.length) diagnostics.push({ ...finding, severity: 'info' });
      continue;
    }
    const relationship = soleMethod ? `Inferred association with the sole following method “${owner.label}” across supporting preset/rotation headings` : matchedForward ? `Inferred unique style-heading match to following method “${owner.label}”; no method content boundary was assumed` : inferred ? `Inferred association with preceding method “${owner.label}” across supporting sibling headings` : 'Parsed method section hierarchy';
    const description = preset.hybrid ? `Hybrid (${preset.components.join(' + ') || 'components unspecified'})` : preset.styles.join(', ');
    for (const style of preset.styles) {
      if (!owner.styles.includes(style)) owner.styles.push(style);
      owner.styleEvidence.push({ value: style, origin: inferred ? 'inferred' : 'explicit',
        evidence: `Preset link “${preset.label || '(unlabelled)'}” / same-line style emoji at line ${preset.line}: ${preset.url}. Setup: ${description}. ${relationship}.` });
      (owner.combatSetups ??= []).push({ style, components: preset.hybrid ? preset.components : [style as Exclude<Style, 'Hybrid'>],
        origin: inferred ? 'inferred' : 'explicit', evidence: relationship, label: preset.label, line: preset.line, url: preset.url });
    }
    owner.evidence.push(`Preset at line ${preset.line} identifies ${description}. ${relationship}.`);
  }
  return { styles: [...new Set(presets.flatMap(p => p.styles))], issues, diagnostics,
    setups: presets.flatMap(p => p.styles.map(style => ({ style, components: p.hybrid ? p.components : [style as Exclude<Style, 'Hybrid'>], origin: 'explicit' as const, evidence: 'Preset label / same-line style emoji', label: p.label, line: p.line, url: p.url }))) };
}
