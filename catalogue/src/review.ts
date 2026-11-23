import type { Catalogue, Decisions, Guide, Issue, ReviewLevel } from './schema';
import { applyEncounterConvention } from './encounter';

export const REVIEW_VERSION = '12';
export const LEVEL_LABELS: Record<ReviewLevel, string> = { action: 'Fix needed', review: 'Check this', info: 'Optional' };
export const DECISION_LABELS = { reviewed: 'Checked', dismissed: 'Ignored' };
export function issueLabel(type: string): string {
  const labels: Record<string, string> = {
    'legacy-catalogue-metadata': 'Move catalogue details out of source', 'invalid-catalogue-override': 'Repair catalogue correction', 'ambiguous-subject': 'Choose the encounter', 'likely-missing-method': 'Possible missing method', 'unknown-style': 'Style not listed', 'missing-anchor': 'No section link', 'no-methods': 'No methods found',
    'unknown-category': 'Choose a category', 'parse-failure': 'Could not read file', 'ambiguous-method': 'Check method',
    'context-review': 'Check section', 'multiple-anchors': 'Choose section link',
    'ambiguous-preset-scope': 'Match preset to method', 'ambiguous-style-combination': 'Hybrid or separate styles?',
  };
  if (labels[type]) return labels[type];
  if (/FRONTMATTER/.test(type)) return 'Check guide details';
  if (/DUPLICATE_TAG/.test(type)) return 'Repeated section link';
  if (/MISSING_TAG/.test(type)) return 'Check section link';
  if (/NONCANONICAL_TAG/.test(type)) return 'Check section link';
  if (/MALFORMED_MENTION/.test(type)) return 'Check Discord link';
  if (/UNKNOWN_SYNTAX/.test(type)) return 'Check formatting';
  if (type.startsWith('parser:')) return 'Formatting or link warning';
  return 'Check guide';
}
// Identity deliberately excludes source line: adding earlier lines does not
// rename an issue. Decisions separately require an exact source-content hash.
export function issueId(guide: Guide, issue: Issue): string {
  return [guide.id, issue.methodId ?? 'guide', issue.type, encodeURIComponent(issue.message)].join('/');
}
export function classifyIssue(guide: Guide, issue: Issue, decisions: Decisions = {}): Issue {
  let reviewLevel: ReviewLevel = 'review';
  const method = [...guide.methods, ...(guide.inspectionCandidates ?? [])].find(m => m.id === issue.methodId);
  const headingName = (text: string) => text.replace(/^#{1,6}\s*/, '').replace(/[_*~`]/g, '').trim();
  const context = issue.sources?.find(s => s.kind === 'context-heading');
  const preset = issue.message.match(/^Preset “([^”]+)”/)?.[1];
  let explanation = 'Check this part of the guide.';
  let impact = 'The file may already be correct.';
  let correction = 'Read the lines below. Choose “Looks right” if no change is needed.';
  let fixNecessary = false;
  switch (issue.type) {
    case 'ambiguous-subject':
      explanation = 'This abbreviation matches more than one encounter.';
      impact = issue.message;
      correction = 'Choose the full boss or creature name in the catalogue details.';
      break;
    case 'likely-missing-method':
      explanation = `“${method?.label ?? 'This section'}” may be a separate method, but is not listed.`;
      impact = 'A selectable approach may be missing from catalogue filters.';
      correction = 'Compare the evidence, then include this heading if it is a method. Otherwise choose Looks right.';
      break;
    case 'unknown-style':
      reviewLevel = 'info';
      explanation = 'No combat style is listed for this method.';
      impact = 'That is fine if the method works without a specific style.';
      correction = 'Leave it as it is unless the guide clearly names a style.';
      break;
    case 'missing-anchor':
      reviewLevel = 'info';
      explanation = 'This method has no section link (.tag).';
      impact = 'The method is still listed, but has no direct section link.';
      correction = 'No change is needed unless you want a section link.';
      break;
    case 'no-methods':
      reviewLevel = 'info';
      explanation = 'No separate methods were found.';
      impact = 'The guide is still listed. Some guides do not need separate methods.';
      correction = 'Leave it as it is if this is a reference or overview.';
      break;
    case 'unknown-category':
      reviewLevel = 'action'; fixNecessary = true;
      explanation = 'We could not find a category for this guide.';
      impact = 'It needs a category to appear in the right place.';
      correction = 'Choose a category in Edit guide details, or move the file to the right folder.';
      break;
    case 'parse-failure':
      reviewLevel = 'action'; fixNecessary = true;
      explanation = 'We could not read this guide.';
      impact = 'Its details may be missing from the catalogue.';
      correction = 'Open the file in VS Code and check the error under More details.';
      break;
    case 'legacy-catalogue-metadata':
      reviewLevel = 'action'; fixNecessary = true;
      explanation = 'This guide contains catalogue-only YAML that belongs in overrides.json.';
      impact = 'Keeping it in the guide mixes catalogue decisions with guide content.';
      correction = 'Preview the migration. It saves needed corrections in overrides.json and removes only the catalogue field from this guide.';
      break;
    case 'invalid-catalogue-override':
      reviewLevel = 'action'; fixNecessary = true;
      explanation = 'A saved catalogue correction could not be applied.';
      impact = issue.message;
      correction = 'Remove the saved correction, then choose a new one. The automatic result is still shown.';
      break;
    case 'ambiguous-method':
      explanation = method ? `The app cannot tell whether “${method.label}” is a separate method or part of another.` : 'The app cannot tell whether this heading is a separate method.';
      impact = 'It may just be part of another method.';
      correction = 'Choose whether to list this heading as a method. Save that choice in the catalogue so future checks use it.';
      break;
    case 'context-review':
      explanation = context && method ? `The app linked “${method.label}” to “${headingName(context.text)}”, but could not confirm that they belong together.` : 'The app could not confirm which section this method belongs to.';
      impact = 'This check is about grouping methods, not the boss name.';
      correction = 'Choose the section this method belongs to, or choose no extra grouping. Save your choice in the catalogue.';
      break;
    case 'multiple-anchors':
      explanation = 'This section has more than one link (.tag).';
      impact = 'The first link is being used.';
      correction = 'Choose the existing section link that this method should use, and save it in the catalogue.';
      break;
    case 'ambiguous-preset-scope':
      explanation = preset ? `The app found the “${preset}” preset, but could not tell which method uses it.` : 'The app found a preset, but could not match it to a method.';
      impact = 'Its style is listed for the guide, but has not been linked to a method.';
      correction = 'Choose the methods that use this preset, or mark it as shared. Save the link in the catalogue.';
      break;
    case 'ambiguous-style-combination':
      explanation = preset ? `The “${preset}” label names several styles, but does not say whether they are used together or separately.` : 'Several styles are named, but the app cannot tell whether they are used together or separately.';
      impact = 'Together means Hybrid. Separate options should stay separate.';
      correction = 'Set the styles in the catalogue: use melee-mage for a hybrid, or melee, magic for separate alternatives.';
      break;
    default:
      if (issue.type.startsWith('parser:')) {
        if (/FRONTMATTER|DUPLICATE_TAG/.test(issue.type)) {
          reviewLevel = 'action'; fixNecessary = true;
          explanation = /FRONTMATTER/.test(issue.type) ? 'The guide details at the top of the file have an error.' : 'The same section link (.tag) is used more than once.';
          impact = /FRONTMATTER/.test(issue.type) ? 'Some guide details could not be read.' : 'A link may open the wrong section.';
          correction = /FRONTMATTER/.test(issue.type) ? 'Open Edit guide details and check the YAML. The full error is under More details.' : 'Open the file in VS Code and give each section link a different name.';
        } else {
          reviewLevel = 'info';
          explanation = 'There is a small formatting or link warning.';
          impact = 'The guide can still be listed.';
          correction = 'Read the full warning under More details. Ignore it if the guide works as intended.';
        }
      }
  }
  if (guide.kind === 'boss-overview' && !(issue.methodId ? guide.methods.some(m => m.id === issue.methodId) : guide.methods.length) && ['ambiguous-method', 'context-review', 'multiple-anchors', 'ambiguous-preset-scope', 'ambiguous-style-combination'].includes(issue.type)) {
    reviewLevel = 'info'; fixNecessary = false;
    explanation = 'This is a boss overview, so it does not need separate methods.';
    impact = 'Headings about phases and mechanics are kept as part of the overview.';
    correction = 'No change is needed.';
  }
  const id = issueId(guide, issue);
  const record = decisions[id];
  const decision = record && record.sourceHash === guide.sourceHash ? record.decision : undefined;
  const rootCause = issue.type.includes('style') ? 'Combat style' : issue.type.includes('preset') ? 'Preset ownership' : issue.type === 'context-review' ? 'Encounter grouping' : ['ambiguous-method', 'likely-missing-method'].includes(issue.type) ? 'Method selection' : 'Source or catalogue data';
  const supportingEvidence = issue.supportingEvidence ?? method?.evidence.slice(0, 4);
  const contradictingEvidence = issue.contradictingEvidence ?? (issue.type === 'ambiguous-method' ? ['This generic heading has no sufficient style, tag or encounter-strategy evidence'] : issue.type === 'context-review' ? ['The named grouping is outside the parsed method ancestry and has no repeated/tagged grouping evidence'] : undefined);
  return { ...issue, id, rootCause, supportingEvidence, contradictingEvidence, reviewLevel, explanation, impact, correction, fixNecessary, decision };
}
export function applyReviewPolicy(guide: Guide, sourceHash: string, decisions: Decisions): Guide {
  let result = { ...guide, sourceHash, issues: [] as Issue[] };
  const overviewFolder = /^basic-guides\//i.test(guide.path);
  const overviewFilename = /(?:^|\/)[^/]+-basic\.txt$/i.test(guide.path);
  result.kind = overviewFolder || overviewFilename ? 'boss-overview' : 'guide';
  if (result.kind === 'boss-overview') {
    result.category = typeof (guide.metadata as Record<string, unknown> | null)?.category === 'string' ? guide.category : 'Boss';
    const selectable = new Set((guide.sections ?? []).filter(s => s.types.some(t => ['boss-rotation', 'boss-afk', 'slayer', 'combat-achievement'].includes(t))).flatMap(s => s.methodIds));
    result.inspectionCandidates = guide.methods.filter(m => !selectable.has(m.id));
    result.methods = guide.methods.filter(m => selectable.has(m.id));
    result.styles = [...new Set(result.methods.flatMap(m => m.styles))];
    result.combatSetups = result.methods.flatMap(m => m.combatSetups ?? []);
    if (result.subject?.origin !== 'explicit') result.subject = {
      value: overviewFilename ? guide.path.split('/').at(-1)!.replace(/-basic\.txt$/i, '').replaceAll('-', ' ') : guide.title,
      origin: 'inferred', evidence: overviewFilename ? '<bossname>-basic.txt boss overview filename convention' : 'Boss overview title in the basic-guides folder; may name an encounter group',
    };
  }
  result = { ...applyEncounterConvention(result), sourceHash };
  result.sections = result.sections?.map(s => ({ ...s, methodIds: s.methodIds.filter(id => result.methods.some(m => m.id === id)) }));
  const uniqueIssues = guide.issues.filter((issue, index, list) => list.findIndex(other => other.type === issue.type && other.methodId === issue.methodId && other.line === issue.line && other.message === issue.message) === index);
  result.issues = uniqueIssues.filter(i => !(['boss-overview', 'combat-achievement'].includes(result.kind ?? '') && result.category !== 'Unclassified' && i.type === 'unknown-category')).map(i => classifyIssue(result, i, decisions));
  if (result.status !== 'excluded' && result.status !== 'error') result.status = result.issues.some(isOpenIssue) ? 'review' : 'classified';
  return result;
}
export const isOpenIssue = (issue: Issue) => !issue.decision && issue.reviewLevel !== 'info';
export function reviewSummary(guides: Guide[]): NonNullable<Catalogue['reviewSummary']> {
  const summary = { action: 0, review: 0, info: 0, reviewed: 0, dismissed: 0 };
  for (const g of guides.filter(g => !g.excludedReason)) for (const i of g.issues) summary[i.decision ?? i.reviewLevel ?? 'review']++;
  return summary;
}
