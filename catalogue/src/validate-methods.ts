import { createHash } from 'node:crypto';
import type { GuideDocument } from '@pvme/guide-parser';
import type { Heading, Issue, Method } from './schema';
import { sourcePresets } from './presets';
import { normaliseHeading, ORDINARY, PHASE } from './rules';
import { ordinaryMethodHeading, phaseRole } from './method-context';

/** Flag uncertain method candidates for review. */
export function validateMethods(doc: GuideDocument, headings: Heading[], methods: Method[], path: string, reference: boolean): { issues: Issue[]; candidates: Method[] } {
  const issues: Issue[] = [], candidates: Method[] = [];
  if (reference) return { issues, candidates };
  const presets = sourcePresets(doc);
  const option = (h: Heading) => /\b(?:budget|best in slot|bis|t(?:80|90|95)|\d+\s*enrage|alternative|approach)\b/.test(normaliseHeading(h.label)) || h.parents.some(p => /^(?:methods|strategies|approaches|locations)$/.test(normaliseHeading(p)));
  const possible = headings.filter(h => option(h) && !h.parents.some(p => ORDINARY.test(normaliseHeading(p)) && !/methods|strategies|approaches/.test(normaliseHeading(p))) && !ORDINARY.test(normaliseHeading(h.label)) && !PHASE.test(normaliseHeading(h.label)) && !ordinaryMethodHeading(h) && !phaseRole(h, headings));
  for (const h of possible) {
    if (methods.some(m => m.heading.line === h.line || (m.locations ?? []).some(l => l.line === h.line))) continue;
    const peers = possible.filter(p => p.level === h.level && JSON.stringify(p.parents) === JSON.stringify(h.parents));
    const scopedPreset = presets.some(p => p.line > h.line && p.line <= h.endLine && p.styles.length);
    if (peers.length < 2 || !scopedPreset) continue;
    const section = doc.sections.find(s => s.range.start.line === h.line), tag = Object.values(doc.tags).find(t => t.sectionId === section?.id);
    const id = `candidate-${createHash('sha256').update(`${path}:${h.parents.join('/')}:${h.label}`).digest('hex').slice(0, 16)}`;
    const supportingEvidence = ['A peer section offers another approach at the same heading level', 'This section has its own labelled combat preset'];
    const contradictingEvidence = ['The heading does not explicitly say method or rotation; it may only describe a gear choice'];
    candidates.push({ id, label: h.label, heading: h, tag: tag?.tag ?? null, tagLine: tag?.range.start.line ?? null, styles: [], combatSetups: [], styleEvidence: [], attributes: [], context: h.parents.map(value => ({ value, origin: 'explicit', evidence: 'Source hierarchy' })), confidence: 'Medium', keywords: [], evidence: supportingEvidence, review: true });
    issues.push({ type: 'likely-missing-method', severity: 'warning', path, line: h.line, methodId: id, message: `“${h.label}” has a separate preset and a peer approach, but was not listed as a method.`, supportingEvidence, contradictingEvidence, sources: [{ kind: 'method-heading', label: 'Possible method heading', line: h.line, text: h.text }] });
  }
  return { issues, candidates };
}
