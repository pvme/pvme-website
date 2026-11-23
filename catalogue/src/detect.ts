import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseGuide, type BlockNode, type GuideDocument, type HeadingBlock, type InlineNode } from '@pvme/guide-parser';
import type { CombatSetup, Finding, Guide, Heading, Issue, Method, Style } from './schema';
import { attributes, CATEGORIES, detectStyles, EXCLUDED_FOLDERS, GENERIC_METHOD, METHOD_KEYWORDS, normaliseHeading, ORDINARY, PHASE, ROLE, STYLE_ONLY, styleCombination } from './rules';
import { applyPresetStyles, sourcePresets } from './presets';
import { ordinaryMethodHeading, phaseRole, plausibleContext, referenceContent } from './method-context';
import { validateMethods } from './validate-methods';
import { classifyGuideTypes } from './classify-types';

export const stableId = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
export function exclusionReason(path: string): string | null {
  const parts = path.toLowerCase().split('/');
  if (parts.some(p => p.startsWith('.') || EXCLUDED_FOLDERS.has(p))) return 'Development, editorial, navigation, archive or command folder';
  if (/^(?:readme|index|navigation|commands?|changelog)(?:[.-]|$)/i.test(parts.at(-1)!)) return 'Support or navigation filename';
  return null;
}
function headingBlocks(blocks: BlockNode[]): HeadingBlock[] {
  return blocks.flatMap(b => b.type === 'heading' ? [b] : b.type === 'blockquote' ? headingBlocks(b.children) : b.type === 'list' ? b.items.flatMap(i => headingBlocks(i.children)) : []);
}
function emojis(nodes: InlineNode[]): string[] {
  return nodes.flatMap(n => n.type === 'emoji' ? [n.name] : 'children' in n ? emojis(n.children) : []);
}
function label(text: string) {
  return text.replace(/<a?:\w+:\d+>/g, '').replace(/[_*~`|]/g, '').trim();
}
export function extractHeadings(doc: GuideDocument): Heading[] {
  const blocks = new Map(doc.messages.flatMap(m => headingBlocks(m.blocks)).map(b => [b.id, b]));
  const sections = new Map(doc.sections.map(s => [s.id, s]));
  const actual = doc.sections.map(s => {
    const parents: string[] = [];
    let p = s.parentId;
    while (p) { const parent = sections.get(p); if (!parent) break; parents.unshift(label(parent.heading)); p = parent.parentId; }
    const block = blocks.get(s.id);
    return { text: block?.raw ?? s.heading, label: label(s.heading), level: s.level, line: s.range.start.line, endLine: s.range.end.line, parents, emojiNames: block ? emojis(block.children) : [] };
  });
  const paragraphs = (blocks: BlockNode[]): BlockNode[] => blocks.flatMap(b => b.type === 'paragraph' ? [b] : b.type === 'blockquote' ? paragraphs(b.children) : b.type === 'list' ? b.items.flatMap(i => paragraphs(i.children)) : []);
  const labelled: Heading[] = [];
  for (const paragraph of doc.messages.flatMap(m => paragraphs(m.blocks))) {
    for (const [index, line] of paragraph.raw.split(/\r?\n/).entries()) {
      const bold = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/.exec(line);
      if (!bold || !/\b(?:rotations?|methods?|strateg(?:y|ies))\b/i.test(bold[1]) || !/\b(?:level\s*\d+|t\d{2,3}|melee|magic|ranged|necromancy|afk|normal|hard)\b/i.test(bold[1])) continue;
      const sourceLine = paragraph.range.start.line + index;
      const parent = actual.filter(h => h.line < sourceLine && h.endLine >= sourceLine).sort((a, b) => b.level - a.level)[0];
      if (!parent) continue;
      labelled.push({ text: line, label: label(bold[1]), line: sourceLine, endLine: parent.endLine, level: Math.min(6, parent.level + 1), parents: [...parent.parents, parent.label], emojiNames: [] });
    }
  }
  // Require peer alternatives, not isolated bold prose, and never scan fenced-code blocks.
  const semantic = labelled.filter(h => labelled.filter(p => JSON.stringify(p.parents) === JSON.stringify(h.parents)).length >= 2);
  for (const h of semantic) h.endLine = Math.min(h.endLine, ...semantic.filter(p => p.line > h.line && JSON.stringify(p.parents) === JSON.stringify(h.parents)).map(p => p.line - 1));
  return [...actual, ...semantic].sort((a, b) => a.line - b.line);
}
function metadataText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string').join(' ');
  return '';
}
function setups(combination: ReturnType<typeof styleCombination>, origin: Finding['origin'], evidence: string): CombatSetup[] {
  return combination.styles.map(style => ({ style, components: combination.hybrid ? combination.components : [style as Exclude<Style, 'Hybrid'>], origin, evidence }));
}
export function analyse(source: string, path: string, root: string, parsed?: GuideDocument, methodScopes: Heading[] = []): Guide {
  const doc = parsed ?? parseGuide(source);
  const headings = extractHeadings(doc);
  const sectionFor = (h: Heading) => doc.sections.find(s => s.range.start.line === h.line) ?? doc.sections.filter(s => s.range.start.line < h.line && s.range.end.line >= h.line).sort((a, b) => b.level - a.level)[0];
  const sectionsById = new Map(doc.sections.map(s => [s.id, s]));
  const meta = doc.metadata ?? {};
  const folder = path.split('/')[0];
  const sourceTitle = headings.find(h => h.level === 1)?.label || path.split('/').at(-1)!.replace(/\.txt$/i, '').replace(/-/g, ' ');
  const title = metadataText(meta.title) || sourceTitle;
  const excludedReason = exclusionReason(path);
  const category = metadataText(meta.category) || CATEGORIES[folder] || 'Unclassified';
  const parserIssues: Issue[] = doc.diagnostics.map(d => ({ type: `parser:${d.code}`, severity: d.severity, path, line: d.range.start.line, message: d.message }));
  const diagnostics = parserIssues.filter(i => !/FRONTMATTER|DUPLICATE_TAG/.test(i.type) && i.severity !== 'error');
  const issues: Issue[] = parserIssues.filter(i => /FRONTMATTER|DUPLICATE_TAG/.test(i.type) || i.severity === 'error');
  const addIssue = (type: string, message: string, method?: Method, line?: number) => issues.push({ type, severity: 'warning', path, line: method?.heading.line ?? line, methodId: method?.id, message });
  const methods: Method[] = [];
  let previousStyle: { styles: Style[]; setups: CombatSetup[]; level: number; parent: string; label: string } | null = null;
  let subjectContext: Heading | null = null;
  const occurrences = new Map<string, number>();
  const metadataStyles = meta.styles ?? meta.combatStyles ?? meta.style;
  const guideCombinations = (Array.isArray(metadataStyles) ? metadataStyles : [metadataStyles]).map(v => styleCombination(metadataText(v)));
  const guideStyles = [...new Set(guideCombinations.flatMap(c => c.styles))];
  const guideSetups = guideCombinations.flatMap(c => setups(c, 'explicit', 'YAML combat style metadata'));
  const restriction = doc.messages.map(m => m.content).join('\n').match(/(?:can only be (?:killed|defeated|damaged) (?:using|with)|(?:you )?can only (?:damage|kill|defeat) (?:him|her|it|them) (?:using|with)(?: the)?)\s+(melee|magic|ranged|necromancy)\b/i);
  const restrictedStyles = restriction ? detectStyles(restriction[1]) : [];
  const fileCombination = styleCombination(path.split('/').at(-1)!);
  const fileStyles = fileCombination.styles;
  const achievementGuide = /^combat-achievements\//i.test(path) || /-ca\.txt$/i.test(path) || /(?:combat[ -]+achievements?|CAs?)\s*$/i.test(title);
  if (Object.hasOwn(meta, 'catalogue')) issues.push({ type: 'legacy-catalogue-metadata', severity: 'warning', path, line: 1, message: 'Catalogue-only corrections are present in source YAML. Move them to overrides.json and remove only the catalogue field.' });
  const guideAttrs = attributes(`${title} ${path.split('/').at(-1)!.replace(/-/g, ' ')}`, 'inferred', 'Guide title / filename');
  const reference = referenceContent(path, title);
  const encounter = /^(?:slayer|afk|rs3-full-boss-guides|combat-achievements|one-tick-guides)\//i.test(path) && (!reference || methodScopes.length > 0);
  const presetSources = sourcePresets(doc);
  const tagged = (h: Heading) => Object.values(doc.tags).some(t => t.sectionId === doc.sections.find(s => s.range.start.line === h.line)?.id);
  // AFK folder contains low effort guides too, so it cannot establish AFK effort.
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const n = normaliseHeading(`${h.label} ${h.emojiNames.join(' ')}`);
    let ownCombination = styleCombination(h.label, h.emojiNames.join(' '));
    const localText = source.split(/\r?\n/).slice(h.line, h.endLine).join('\n');
    if (ownCombination.ambiguous) {
      const boldStyles = [...localText.matchAll(/\*\*([A-Za-z ]+)\*\*/g)].flatMap(match => detectStyles(match[1]));
      const explicitAlternatives = ownCombination.components.every(s => boldStyles.includes(s)) || /\b(?:both|either)\b[\s\S]{0,200}\b(?:can be used|are viable|work with)\b/i.test(localText.slice(0, 700));
      if (explicitAlternatives) ownCombination = { ...ownCombination, styles: ownCombination.components, ambiguous: false };
    }
    const recommended = !ownCombination.styles.length && !ownCombination.ambiguous ? localText.match(/\b(Melee|Magic|Ranged|Necromancy)\b\s*(?:<a?:\w+:\d+>)?\s+(?:offers the most efficient|is (?:the )?(?:recommended|best)|works best)/i) : null;
    if (recommended) ownCombination = styleCombination(recommended[1]);
    const ownStyles = ownCombination.styles;
    const keyword = METHOD_KEYWORDS.test(n);
    const generic = GENERIC_METHOD.test(normaliseHeading(h.label));
    const ordinary = ORDINARY.test(n);
    const styleOnly = STYLE_ONLY.test(n) || (ownStyles.length > 0 && STYLE_ONLY.test(normaliseHeading(h.label)));
    const explicitMethod = /^methods?\s*[: -]/.test(normaliseHeading(h.label));
    const specific = keyword && !generic && !ordinary;
    const effort = /\b(?:afk|low effort|active)\b/.test(n) && !ordinary;
    const role = ROLE.test(n) && !ordinary;
    const isTitle = i === headings.findIndex(x => x.level === 1);
    const parentMethod = [...methods].reverse().find(m => m.heading.line < h.line && m.heading.level <= h.level && (!subjectContext || m.heading.line > subjectContext.line));
    const roleGroup = ROLE.test(n) && h.level <= 2 && tagged(h) && /\bintroduction\b/.test(n) && !reference;
    const achievement = achievementGuide && tagged(h) && /\b(?:perfect|(?:master|grandmaster) speed|speed killer)\b/.test(n) && !ordinary;
    const suppressed = ordinaryMethodHeading(h) || (!explicitMethod && !ownStyles.length && h.parents.some(p => /\bphases?\s*\d/.test(normaliseHeading(p))) && /strateg/.test(n)) || phaseRole(h, headings.slice(0, i)) || (reference && !explicitMethod && !methodScopes.some(scope => h.line >= scope.line && h.line <= scope.endLine)) || (styleOnly && h.parents.some(p => ORDINARY.test(normaliseHeading(p)) && !/rotation|strateg|method/.test(normaliseHeading(p))));
    const candidate = !suppressed && (roleGroup || achievement || specific || styleOnly || effort || role || (generic && !parentMethod && !isTitle));
    // Unqualified, unlinked CA rotation/strategy headings describe guide content,
    // rather than an independently identifiable catalogue method.
    if (achievementGuide && generic && !ownStyles.length && !tagged(h) && !/\d/.test(n)) continue;
    if (PHASE.test(n)) { previousStyle = null; continue; }
    if (!candidate || (isTitle && !styleOnly && !/^method\b/.test(n))) {
      // A nearby named sibling can identify a creature group, but is never
      // asserted as an explicit subject or used to manufacture a boundary.
      if (/^slayer\//i.test(path) && !ordinary && !keyword && !isTitle && plausibleContext(h)) subjectContext = h;
      continue;
    }
    if (generic && parentMethod) continue;
    if (ordinary && !specific && !styleOnly && !roleGroup) continue;
    const containing = sectionFor(h);
    let parentId = containing?.range.start.line === h.line ? containing.parentId : containing?.id;
    let contextIsParent = false;
    while (parentId) {
      const parent = sectionsById.get(parentId);
      if (!parent) break;
      if (parent.range.start.line === subjectContext?.line) contextIsParent = true;
      parentId = parent.parentId;
    }
    const siblingContext = subjectContext && subjectContext.line < h.line && subjectContext.level <= h.level && !contextIsParent ? subjectContext : null;
    const confidentContext = siblingContext && (tagged(siblingContext) || headings.filter(x => plausibleContext(x) && x.level === siblingContext.level && !METHOD_KEYWORDS.test(normaliseHeading(x.label)) && !STYLE_ONLY.test(normaliseHeading(x.label))).length >= 2);
    const uncertainContext = confidentContext ? null : siblingContext;
    const evidence: string[] = [];
    if (recommended) evidence.push('Explicit style recommendation in this method’s body');
    if (roleGroup) evidence.push('Tagged top-level role introduction groups phase instructions for that selectable role');
    if (achievement) evidence.push('Tagged achievement strategy heading');
    if (specific) evidence.push('Distinct method / strategy / rotation wording in parsed heading');
    if (styleOnly) evidence.push('Standalone combat-style heading');
    if (effort) evidence.push('Effort keyword in heading');
    if (role) evidence.push('Encounter role or mode in heading');
    if (generic) evidence.push('Unqualified strategy / rotation without a detected parent method; needs review');
    const context: Finding[] = h.parents.map(value => ({ value, origin: 'explicit', evidence: 'Parser section hierarchy' }));
    if (siblingContext) context.push({ value: siblingContext.label, origin: 'inferred', evidence: confidentContext ? 'Tagged or repeated creature grouping in a Slayer guide' : 'Nearby preceding named heading; relationship needs review' });
    const attrs = attributes(n);
    if (ownCombination.hybrid && !attrs.some(a => a.value === 'Hybrid')) attrs.push({ value: 'Hybrid', origin: 'explicit', evidence: 'Combined style names in method heading' });
    for (const p of h.parents.slice(1)) attrs.push(...attributes(p, 'inferred', `Parent heading: ${p}`));
    const hasSpecificMode = attrs.some(x => ['Hard Mode', 'Normal Mode'].includes(x.value));
    for (const a of guideAttrs) if (!attrs.some(x => x.value === a.value) && !(['Hard Mode', 'Normal Mode'].includes(a.value) && hasSpecificMode) && !(['AFK / Low Effort', 'Active', 'High Effort'].includes(a.value) && attrs.some(x => ['AFK / Low Effort', 'Active', 'High Effort'].includes(x.value)))) attrs.push(a);
    let styles = ownStyles;
    let combatSetups = setups(ownCombination, 'explicit', 'Method heading text / parsed emoji name');
    let styleEvidence: Finding[] = styles.map(value => ({ value, origin: 'explicit', evidence: 'Method heading text / parsed emoji name' }));
    if (!styles.length) {
      const parentStyles = [...h.parents].reverse().map(p => ({ p, combination: styleCombination(p) })).find(p => p.combination.styles.length);
      if (parentStyles) {
        styles = [...parentStyles.combination.styles];
        combatSetups = setups(parentStyles.combination, 'inferred', `Parent heading: ${parentStyles.p}`);
        styleEvidence = styles.map(value => ({ value, origin: 'inferred', evidence: `Parent heading: ${parentStyles.p}` }));
      }
      else if (role && previousStyle && previousStyle.level === h.level && previousStyle.parent === h.parents.join('/')) {
        styles = [...previousStyle.styles];
        combatSetups = previousStyle.setups.map(s => ({ ...s, origin: 'inferred', evidence: `Preceding sibling style heading: ${previousStyle!.label}` }));
        styleEvidence = styles.map(value => ({ value, origin: 'inferred', evidence: `Preceding sibling style heading: ${previousStyle!.label}; hierarchy is ambiguous` }));
        context.push({ value: previousStyle.label, origin: 'inferred', evidence: 'Preceding sibling style, same structural parent' });
        evidence.push('Role linked to preceding sibling style; verify this inferred relationship');
      } else if (guideStyles.length || fileStyles.length || restrictedStyles.length) {
        styles = guideStyles.length ? guideStyles : fileStyles.length ? fileStyles : restrictedStyles;
        styles = [...styles];
        combatSetups = guideStyles.length ? guideSetups.map(s => ({ ...s, origin: 'inferred' })) : fileStyles.length ? setups(fileCombination, 'inferred', 'Guide filename') : setups(styleCombination(restriction![1]), 'inferred', `Explicit guide restriction: ${restriction![0]}`);
        styleEvidence = styles.map(value => ({ value, origin: 'inferred', evidence: guideStyles.length ? 'YAML combat style metadata' : fileStyles.length ? 'Guide filename' : `Explicit guide restriction: “${restriction![0]}”` }));
      }
    }
    if (ownStyles.length && styleOnly) previousStyle = { styles: [...styles], setups: combatSetups, level: h.level, parent: h.parents.join('/'), label: h.label };
    const section = doc.sections.find(s => s.range.start.line === h.line);
    const anchors = section ? Object.values(doc.tags).filter(t => t.sectionId === section.id) : [];
    const tag = anchors[0] ?? null;
    const key = [...h.parents, subjectContext?.label ?? '', role ? previousStyle?.label ?? '' : '', n].join('/');
    const ordinal = (occurrences.get(key) ?? 0) + 1; occurrences.set(key, ordinal);
    const inferredSibling = styleEvidence.some(s => s.evidence.includes('sibling'));
    const confidence = generic ? 'Low' : inferredSibling ? 'Medium' : specific || achievement || roleGroup || (styleOnly && headings.filter(x => STYLE_ONLY.test(normaliseHeading(x.label))).length > 1) ? 'High' : 'Medium';
    const m: Method = {
      id: `method-${stableId(`${path}:${key}:${ordinal}`)}`, label: h.label, styles, styleEvidence, combatSetups,
      attributes: attrs.filter((a, j) => attrs.findIndex(x => x.value === a.value) === j),
      tag: tag?.tag ?? null, tagLine: tag?.range.start.line ?? null, heading: h, context,
      keywords: [...n.matchAll(/\b(?:methods?|strateg(?:y|ies)|rotations?|afk|active|low effort|hybrid|base tank|bomb tank|hm|nm|solo|duo|melee|magic|mage|ranged|necromancy|necro)\b/g)].map(x => x[0]),
      anchor: tag?.tag ?? `${normaliseHeading(h.label).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${stableId(`${path}:${key}:${ordinal}`).slice(0, 8)}`,
      confidence, evidence, review: generic || inferredSibling || !!uncertainContext,
    };
    if (tag) evidence.push(`Parser associates .tag:${tag.tag} directly with this heading`);
    methods.push(m);
    if (ownCombination.ambiguous) addIssue('ambiguous-style-combination', 'The method heading names multiple styles without establishing hybrid use or independent alternatives. These names were not treated as single-style options.', m);
    if (generic || inferredSibling) addIssue('ambiguous-method', generic ? 'Generic heading may be shared content or an independent strategy.' : 'Role and style use sibling headings; inferred style association needs review.', m);
    if (uncertainContext) {
      const guideHeading = headings.find(heading => heading.level === 1);
      issues.push({ type: 'context-review', severity: 'warning', path, line: uncertainContext.line, methodId: m.id,
        message: `Heading “${uncertainContext.label}” was associated with method “${m.label}” by proximity, not parsed parent hierarchy. Verify that association.`,
        sources: [
          { kind: 'context-heading', label: 'Context heading being associated', text: uncertainContext.text, line: uncertainContext.line },
          { kind: 'method-heading', label: 'Affected method', text: h.text, line: h.line },
          ...(guideHeading ? [{ kind: 'guide-title' as const, label: 'Guide title (encounter identity)', text: guideHeading.text, line: guideHeading.line }] : []),
        ],
      });
    }
    if (anchors.length > 1) diagnostics.push({ type: 'multiple-anchors', severity: 'info', path, line: h.line, methodId: m.id, message: 'This section has multiple valid source tags. The first is used as its method link; other tags remain unchanged.' });
  }
  // A named method with competing difficulty/style children is a group, not another selectable method.
  const wrappers = new Set(methods.filter(parent => methods.filter(child => child !== parent && child.heading.line > parent.heading.line && child.heading.line <= parent.heading.endLine && child.heading.level > parent.heading.level && (child.attributes.some(a => ['Hard Mode', 'Normal Mode'].includes(a.value)) || STYLE_ONLY.test(normaliseHeading(child.label)) || /\b(?:level\s*\d+|t\d{2,3})/.test(normaliseHeading(child.label)))).length >= 2).map(m => m.id));
  for (const method of methods) if (/^general strateg(?:y|ies)$/.test(normaliseHeading(method.label)) && !tagged(method.heading) && methods.some(other => other !== method && !GENERIC_METHOD.test(normaliseHeading(other.label)))) wrappers.add(method.id);
  for (let index = methods.length - 1; index >= 0; index--) if (wrappers.has(methods[index].id)) methods.splice(index, 1);
  // One whole-file AFK strategy is real even when its author only used setup/action-bar headings.
  const wholeFileStrategy = !methods.length && encounter && (presetSources.some(p => p.styles.length) && ((/^afk\//i.test(path) && /\b(?:afk|low effort)\b/.test(normaliseHeading(title))) || (achievementGuide && headings.some(h => GENERIC_METHOD.test(normaliseHeading(h.label)))) || (/^rs3-full-boss-guides\//i.test(path) && fileStyles.length > 0 && headings.some(h => PHASE.test(normaliseHeading(h.label))))));
  if (wholeFileStrategy) {
    const h = headings.find(h => h.level === 1);
    if (h) {
      const section = doc.sections.find(s => s.range.start.line === h.line), anchor = Object.values(doc.tags).find(t => t.sectionId === section?.id);
      methods.push({ id: `method-${stableId(`${path}:whole-file`)}`, label: h.label, heading: h, tag: anchor?.tag ?? null, tagLine: anchor?.range.start.line ?? null, anchor: anchor?.tag ?? `strategy-${stableId(path).slice(0, 8)}`, styles: [], combatSetups: [], styleEvidence: [], attributes: guideAttrs, context: [], keywords: ['strategy'], confidence: 'High', evidence: ['One encounter strategy at the guide title, supported by labelled presets and AFK/achievement purpose'], review: false });
    }
  }
  const presets = applyPresetStyles(doc, headings, methods, path);
  issues.push(...presets.issues); diagnostics.push(...presets.diagnostics);
  // Phase-specific repetitions describe one selectable style across the encounter.
  const phaseGroups = new Map<string, Method>();
  const removed = new Set(wrappers);
  for (const method of [...methods]) {
    if (!STYLE_ONLY.test(normaliseHeading(method.label)) || !method.heading.parents.some(p => PHASE.test(normaliseHeading(p)))) continue;
    const key = JSON.stringify([method.styles, (method.combatSetups ?? []).map(s => [s.style, [...s.components].sort()]), method.attributes.filter(a => !a.value.startsWith('Phase ')).map(a => a.value)]);
    const primary = phaseGroups.get(key);
    if (!primary) { phaseGroups.set(key, method); method.locations = [method.heading]; method.attributes = method.attributes.filter(a => !a.value.startsWith('Phase ')); continue; }
    primary.locations!.push(method.heading); primary.evidence.push(`Same style also appears under ${method.heading.parents.join(' / ')} at line ${method.heading.line}`);
    removed.add(method.id); methods.splice(methods.indexOf(method), 1);
  }
  for (const method of methods) {
    if (issues.some(i => i.type === 'ambiguous-style-combination' && i.methodId === method.id) && method.combatSetups?.some(s => s.url) && !method.combatSetups.some(s => s.style === 'Hybrid')) {
      const named = styleCombination(method.heading.label, method.heading.emojiNames.join(' ')).components;
      if (named.every(s => method.styles.includes(s))) { issues.splice(0, issues.length, ...issues.filter(i => !(i.type === 'ambiguous-style-combination' && i.methodId === method.id))); method.evidence.push('Separate single-style preset links establish independent alternatives for this heading'); }
    }
    const generic = GENERIC_METHOD.test(normaliseHeading(method.label));
    const credible = generic && encounter && (method.styles.length > 0 || tagged(method.heading) || /\brotations?\b/.test(normaliseHeading(title)));
    if (credible) { method.confidence = 'High'; method.review = false; method.evidence.push('A rotation/strategy in an encounter guide with style, tag or explicit rotation-title evidence'); }
    method.anchor ??= method.tag ?? `method-${method.id.replace('method-', '')}`;
  }
  for (let index = issues.length - 1; index >= 0; index--) {
    const issue = issues[index], method = methods.find(m => m.id === issue.methodId);
    if ((issue.methodId && removed.has(issue.methodId)) || (issue.type === 'ambiguous-method' && method?.confidence === 'High') || (issue.type === 'context-review' && issues.some(i => i.type === 'ambiguous-method' && i.methodId === issue.methodId))) issues.splice(index, 1);
  }
  for (const issue of [...issues]) {
    if (issue.type !== 'ambiguous-style-combination' || !issue.methodId || !issue.message.startsWith('Preset')) continue;
    const method = methods.find(m => m.id === issue.methodId), primary = issues.find(i => i !== issue && i.type === issue.type && i.methodId === issue.methodId && i.line === method?.heading.line);
    if (!primary || !method) continue;
    primary.sources = [{ kind: 'method-heading', label: 'Method style label', text: method.heading.text, line: method.heading.line }, ...(primary.sources ?? []), ...(issue.sources ?? [])];
    primary.supportingEvidence = [...(primary.supportingEvidence ?? []), ...(issue.supportingEvidence ?? [])];
    primary.contradictingEvidence = [...(primary.contradictingEvidence ?? []), ...(issue.contradictingEvidence ?? [])];
    issues.splice(issues.indexOf(issue), 1);
  }
  const validation = validateMethods(doc, headings, methods, path, reference);
  issues.push(...validation.issues);
  if (category === 'Unclassified') addIssue('unknown-category', 'Folder has no category mapping and YAML provides no category.');
  const metadataSubject = metadataText(meta.boss ?? meta.creature ?? meta.subject);
  const nested = path.split('/').slice(1, -1);
  const subject: Finding | null = metadataSubject ? { value: metadataSubject, origin: 'explicit', evidence: 'YAML metadata' } : ['Boss', 'Slayer', 'AFK'].includes(category) ? {
    value: nested.length ? nested[0].replace(/-/g, ' ') : title.replace(/^(?:AFK|Low Effort)\s+/i, '').replace(/\s*\([^)]*\)\s*$/g, ''),
    origin: 'inferred', evidence: nested.length ? 'Boss subfolder' : 'Guide title; may name a group rather than one creature',
  } : null;
  const styles = [...new Set([...guideStyles, ...fileStyles, ...methods.flatMap(m => m.styles), ...presets.styles])];
  return classifyGuideTypes({
    id: `guide-${stableId(path)}`, path, absolutePath: resolve(root, path), title, sourceTitle, category, subject, metadata: doc.metadata ?? null,
    diagnostics, inspectionCandidates: validation.candidates, styles, combatSetups: [...guideSetups, ...setups(fileCombination, 'inferred', 'Guide filename'), ...methods.flatMap(m => m.combatSetups ?? []), ...presets.setups], attributes: guideAttrs, methods, issues,
    status: excludedReason ? 'excluded' : issues.length ? 'review' : 'classified', excludedReason,
    parsed: { sections: doc.sections.length, messages: doc.messages.length, tags: Object.keys(doc.tags).length, diagnostics: doc.diagnostics },
  }, doc, headings);
}
