import { GuideApi, GuideApiError, contributorId } from './guide-api';
import type { EditSession, GuideUpdatePayload } from './edit-session';
import type { DraftStorage } from './draft-storage';
import type { GuideSourceProvider } from './guide-source-provider';
import {
  SubmissionUncertainError,
  type SubmissionResult,
} from './submission-contract';

export function reviewIdentity(session: EditSession) {
  const s = session.loaded;
  return JSON.stringify([
    session.path,
    session.sourceHash,
    s.source,
    s.branch,
    s.existingReviewBranch || '',
    s.existingReviewUrl || '',
    s.prUrl || '',
  ]);
}
export interface ReplacementConsent {
  identity: string;
  review: string;
}
export interface SubmissionReceipt {
  identity: string;
  path: string;
  source: GuideUpdatePayload['source'];
  sourceHash: string;
  content: string;
  changes: string;
  result: SubmissionResult;
  store: DraftStorage;
  storedRevision: string | null | undefined;
}
export class GuideSubmission {
  pending = false;
  private completed = new Set<string>();
  constructor(
    readonly api: GuideApi,
    readonly provider: GuideSourceProvider,
  ) {}
  private key(session: EditSession, identity: string) {
    return JSON.stringify([
      identity,
      reviewIdentity(session),
      session.content(),
    ]);
  }
  async submit(
    session: EditSession,
    description: { title: string; notes: string },
    store: DraftStorage,
    consent?: ReplacementConsent,
  ): Promise<SubmissionReceipt> {
    if (this.pending) throw new Error('A submission is already pending.');
    const identity = store.identity;
    if (identity !== contributorId(this.api.user))
      throw new Error(
        'Your account changed. Reopen the editor; your draft is retained.',
      );
    const key = this.key(session, identity);
    if (this.completed.has(key))
      throw new Error(
        'This exact edit has already been submitted. Return to reading or reload your contribution before editing again.',
      );
    const content = session.content(),
      changes = JSON.stringify(session.changes);
    const storedRevision = store.snapshot(session.path);
    const review = reviewIdentity(session);
    this.pending = true;
    try {
      const current = await this.provider.load(
        session.path,
        session.loaded.source,
      );
      const payload = await session.prepareUpdate(description, current);
      if (
        session.content() !== content ||
        JSON.stringify(session.changes) !== changes
      )
        throw new Error(
          'Your draft changed while checking the source. Review it again before submitting.',
        );
      // prepareUpdate validates branch/source; URLs also bind the displayed consent.
      if (
        (current.prUrl || '') !== (session.loaded.prUrl || '') ||
        (current.existingReviewUrl || '') !==
          (session.loaded.existingReviewUrl || '')
      )
        throw new Error(
          'Review metadata changed. Reload the source and confirm replacement again.',
        );
      if (payload.source === 'master' && payload.existingReviewBranch) {
        if (
          !consent ||
          consent.identity !== identity ||
          consent.review !== review
        )
          throw new Error(
            'Confirm replacement of the linked submitted update before submitting this live-guide edit.',
          );
        payload.replaceExistingReview = true;
      }
      const result = await this.api.submit(payload, identity);
      if (!('dryRun' in result)) this.completed.add(key);
      return {
        identity,
        path: session.path,
        source: payload.source,
        sourceHash: session.sourceHash,
        content,
        changes,
        result,
        store,
        storedRevision,
      };
    } finally {
      this.pending = false;
    }
  }
  complete(receipt: SubmissionReceipt) {
    if ('dryRun' in receipt.result) return false;
    return receipt.store.discardSubmitted(receipt.path, receipt.storedRevision);
  }
}
export function submissionFailure(error: unknown): string {
  const retained = ' Your draft is retained.';
  if (error instanceof SubmissionUncertainError) return error.message;
  if (!(error instanceof GuideApiError))
    return (
      (error instanceof Error ? error.message : 'Submission failed.') + retained
    );
  let action = '';
  if (error.status === 401)
    action = 'Sign in again with the same contributor account.';
  else if (error.status === 403)
    action =
      'Refresh your session or log in again to check permission and OAuth repository scope.';
  else if (error.code === 'FORK_SYNC_REQUIRED')
    action =
      'On GitHub use Sync fork → Update branch and resolve workflow conflicts, then reload your contribution before retrying.';
  else if (error.status === 409)
    action =
      'Reload the selected source or inspect your submitted update in Guide Editor before retrying. Do not overwrite or rebase automatically.';
  else if (error.status === 404)
    action =
      'The guide or review is unavailable. Reload the live source or use Guide Editor.';
  else if (error.status === 413)
    action =
      'Each original and edited source must fit within 2 MiB of UTF-8 text. Export the draft.';
  else if (error.status === 429) action = 'Wait before trying again.';
  else if (error.status >= 500 || error.status === 422)
    action =
      'The outcome may be uncertain. Inspect or reload your contribution in Guide Editor before retrying.';
  return `${error.message} ${action}${retained}`;
}
