import { GuideApi, GuideApiError, contributorId } from './guide-api';
import type { EditSession, GuideUpdatePayload } from './edit-session';
import type { DraftStorage } from './draft-storage';
import type { GuideSourceProvider } from './guide-source-provider';
import {
  SubmissionUncertainError,
  type SubmissionResult,
  type SubmissionRequest,
} from './submission-contract';
import { reviewKey, validateLoadedReview } from './review-state';

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
    session.contributor || '',
    reviewKey(s.reviewState),
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
    const identity = session.contributor;
    if (
      !identity ||
      identity !== store.identity ||
      identity !== contributorId(this.api.user)
    )
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
    const storedRevision = store.snapshotFor(session);
    const review = reviewIdentity(session);
    this.pending = true;
    try {
      const expectedReview = validateLoadedReview(
        session.loaded,
        identity,
        this.api.user || undefined,
        this.api.development && session.loaded.localDryRunVerified === true,
      );
      const current = await this.provider.load(
        session.path,
        session.loaded.source,
      );
      const prepared = await session.prepareUpdate(description, current);
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
      if (prepared.source === 'master' && expectedReview.state === 'present') {
        if (
          !consent ||
          consent.identity !== identity ||
          consent.review !== review
        )
          throw new Error(
            'Confirm replacement of the linked submitted update before submitting this live-guide edit.',
          );
        prepared.replaceExistingReview = true;
      }
      // Never take a newer assertion from the recheck; it is only a comparison.
      const payload: SubmissionRequest =
        expectedReview.state === 'unverified'
          ? {
              ...prepared,
              contractVersion: 2,
              expectedContributor: identity,
              expectedReview,
              source: 'master',
              branch: 'master',
              replaceExistingReview: false,
            }
          : {
              ...prepared,
              contractVersion: 2,
              expectedContributor: identity,
              expectedReview,
            };
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
  if (error.code === 'CONTRIBUTOR_MISMATCH')
    action =
      'Restore the captured contributor account, reload the selected source and review the draft again. This result never transfers to another account.';
  else if (error.code === 'CSRF_INVALID')
    action =
      'Refresh the session deliberately and confirm the original contributor before a new submission. No automatic retry was made.';
  else if (
    [
      'INVALID_CONTRACT',
      'INVALID_CONTRIBUTOR',
      'INVALID_REVIEW_STATE',
      'STRICT_ROUTE_REQUIRED',
    ].includes(error.code || '')
  )
    action =
      'The strict v2 contract is unavailable or invalid. Keep/export the draft and correct the integration; never fall back to a legacy endpoint.';
  else if (error.code === 'REPLACEMENT_CONSENT_REQUIRED')
    action =
      'Reload the selected source and give fresh explicit consent for the displayed immutable review version.';
  else if (error.code === 'REVIEW_STATE_CONFLICT')
    action =
      'The review version changed. Publication may already have occurred. Inspect the contribution before retrying, then reload and give fresh consent. No version was refreshed automatically.';
  else if (error.status === 401)
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
      'The guide, review or strict v2 route is unavailable. Inspect/reload in Guide Editor. Never fall back to legacy submission.';
  else if (error.status === 413)
    action =
      'Each original and edited source must fit within 2 MiB of UTF-8 text. Export the draft.';
  else if (error.status === 429) action = 'Wait before trying again.';
  else if (error.status >= 500 || error.status === 422)
    action =
      'The outcome may be uncertain. Inspect or reload your contribution in Guide Editor before retrying.';
  return `${error.message} ${action}${retained}`;
}
