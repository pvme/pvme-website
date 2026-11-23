import type { Heading } from './schema';
import { normaliseHeading, ORDINARY, PHASE, ROLE } from './rules';

export const negatedEffort = (text: string) => /\b(?:non[ -]?afk|not afk|afk (?:content )?not|non[ -]?active)\b/i.test(text);
export function referenceContent(path: string, title: string): boolean {
  const name = normaliseHeading(`${title} ${path.split('/').at(-1)!.replace(/[_.-]/g, ' ')}`);
  return /\b(?:overview|tips and tricks|introduction|introductory|faq|revenue|spreadsheets?|alt1|definitions|setup|reference)\b/.test(name)
    || /^(?:basic-guides|upgrading-info|dpm-advice|getting-started|new-to-pvm|new-to-bossing|miscellaneous-information)\//i.test(path)
    || /-basic\.txt$/i.test(path);
}
export function ordinaryMethodHeading(heading: Heading): boolean {
  const name = normaliseHeading(heading.label);
  return negatedEffort(name) || /\b(?:attack rotations?|rotation examples?|example rotations?|examples?|sample|prebuild|troubleshooting|differences (?:from|between)|bleed clears?|luring|clearing.*bleeds|dps check|content|phase strategy|strategy summary|rotation summary|specifics|considerations|breakdown|comparison)\b/.test(name)
    || /^(?:how|why|what|when|allows? you|do not|notes?|tips?|general information|the fight|prefight|pre fight|desirable drops|location|locations|rewards)\b/.test(name);
}
export function phaseRole(heading: Heading, previousHeadings: Heading[]): boolean {
  const name = normaliseHeading(heading.label);
  if (!ROLE.test(name)) return false;
  return /\bphases?\b/.test(name) || heading.parents.some(p => PHASE.test(normaliseHeading(p)))
    || previousHeadings.some(h => PHASE.test(normaliseHeading(h.label)) && h.level < heading.level && h.line < heading.line && h.endLine >= heading.line);
}
export function plausibleContext(heading: Heading): boolean {
  const name = normaliseHeading(heading.label);
  return heading.level <= 2 && !ORDINARY.test(name) && !PHASE.test(name) && !ROLE.test(name) && !ordinaryMethodHeading(heading) && name.split(' ').length <= 8;
}
