import type { Guide, Issue, IssueSource } from './schema';

export function issueSources(guide: Guide, issue: Issue): IssueSource[] {
  if (issue.sources?.length) return issue.sources;
  const method = [...guide.methods, ...(guide.inspectionCandidates ?? [])].find(m => m.id === issue.methodId);
  if (method) return [{ kind: 'method-heading', label: 'Affected method heading', text: method.heading.text, line: method.heading.line }];
  return [{ kind: 'source-location', label: issue.line ? 'Relevant source location' : 'Source file', text: guide.path, line: issue.line ?? 1 }];
}
