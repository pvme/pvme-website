import {
  parseGuide,
  type Diagnostic,
  type SourceRange,
} from '@pvme/guide-parser';
import { validateGuideStyle } from './guide-validation/style.js';
import { emojiSnapshot } from './emoji-autocomplete';

export interface GuideIssue extends Diagnostic {
  source: 'parser' | 'style';
}
const knownEmojiIds = new Set(emojiSnapshot.map((emoji) => emoji.emojiId));
interface EditorialIssue {
  code: string;
  text: string;
  type: string;
  range: Pick<SourceRange, 'start' | 'end'>;
}

/** Read-only checks on the complete literal source, with original UTF-16 ranges.
 * Editorial rules are adapted locally from Guide Editor until shared upstream.
 * Spreadsheet availability is deliberately not guessed from an absent dataset.
 */
export function validateGuide(source: string): GuideIssue[] {
  const document = parseGuide(source);
  const editorial = validateGuideStyle(document, source, { knownEmojiIds });
  return [
    ...document.diagnostics.map((issue) => ({
      ...issue,
      source: 'parser' as const,
    })),
    ...editorial.map((issue: EditorialIssue): GuideIssue => ({
      source: 'style',
      code: issue.code,
      message: issue.text,
      severity: issue.type === 'error' ? 'error' : 'warning',
      range: {
        ...issue.range,
        startLine: issue.range.start.line,
        endLine: issue.range.end.line,
      },
    })),
  ].sort(
    (a, b) =>
      a.range.start.offset - b.range.start.offset ||
      a.code.localeCompare(b.code),
  );
}

export function issueSummary(issues: GuideIssue[]): string {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.length - errors;
  return issues.length
    ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`
    : 'No guide issues';
}
