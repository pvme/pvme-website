/** Mirrors a resolved /guides/load response; the "auto" review-choice response is not source. */
export interface LoadedGuideSource {
  path: string;
  originalText: string;
  name: string;
  repo: 'pvme/pvme-guides';
  baseBranch: 'master';
  source: 'master' | 'user-pr';
  branch: string;
  prUrl?: string;
  existingReviewBranch?: string;
  existingReviewUrl?: string;
  /** Optional local preview metadata; never included in submission payloads. */
  previewLinks?: Record<string, { href: string; title?: string }>;
}

export interface GuideSourceProvider {
  load(path: string): Promise<LoadedGuideSource>;
}
