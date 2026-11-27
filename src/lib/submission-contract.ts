import type { GuideUpdatePayload } from './edit-session';
import type { PublicUser } from './guide-api';
import {
  contributorBranch,
  parseReviewState,
  validContributor,
  validateReviewOwner,
  type ContributorIdentity,
  type ExpectedReview,
} from './review-state';

export const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
export function parsePublicUser(value: unknown): PublicUser | null {
  if (value === null) return null;
  if (
    !record(value) ||
    !['username', 'globalName', 'avatar', 'displayName', 'csrfToken'].every(
      (key) => string(value[key]),
    ) ||
    !(value.csrfToken as string).trim() ||
    typeof value.canReviewPrs !== 'boolean'
  )
    throw new Error('Invalid public session response.');
  const common = {
    username: value.username as string,
    globalName: value.globalName as string,
    avatar: value.avatar as string,
    displayName: value.displayName as string,
    csrfToken: value.csrfToken as string,
    canReviewPrs: value.canReviewPrs,
  };
  if (
    value.provider === 'github' &&
    string(value.githubId) &&
    /^[1-9]\d*$/.test(value.githubId) &&
    string(value.githubLogin) &&
    value.githubLogin
  )
    return {
      ...common,
      provider: 'github',
      githubId: value.githubId,
      githubLogin: value.githubLogin,
    };
  if (
    value.provider === 'discord' &&
    string(value.discordId) &&
    /^[1-9]\d*$/.test(value.discordId) &&
    typeof value.pvmeMember === 'boolean'
  )
    return {
      ...common,
      provider: 'discord',
      discordId: value.discordId,
      pvmeMember: value.pvmeMember,
    };
  throw new Error('Invalid public session response.');
}
export const validPrUrl = (value: unknown): value is string =>
  string(value) &&
  /^https:\/\/github\.com\/pvme\/pvme-guides\/pull\/[1-9]\d*$/.test(value);
export interface SubmittedUpdate {
  contractVersion: 2;
  contributor: ContributorIdentity;
  prUrl: string;
  branch: string;
  path: string;
  reusedReview: boolean;
}
export interface DryRunUpdate {
  contractVersion: 2;
  contributor: ContributorIdentity;
  reviewStateVerified: false;
  dryRun: true;
  message: string;
  path: string;
  title: string;
  user: PublicUser;
  contentBytes: number;
  originalContentBytes: number;
  source: 'master' | 'user-pr';
  branch: string;
  reviewBranch: string;
}
export type SubmissionResult = SubmittedUpdate | DryRunUpdate;
export class SubmissionUncertainError extends Error {}
export type StrictGuideUpdate = Omit<
  GuideUpdatePayload,
  'title' | 'existingReviewBranch'
> & {
  title?: string;
  existingReviewBranch?: string;
  contractVersion: 2;
  expectedContributor: ContributorIdentity;
  expectedReview: ExpectedReview;
};
/** Explicit local-only exception; it is not a live ExpectedReview assertion. */
export type LocalDryRunGuideUpdate = Omit<
  StrictGuideUpdate,
  'expectedReview' | 'source' | 'branch' | 'replaceExistingReview'
> & {
  expectedReview: { state: 'unverified' };
  source: 'master';
  branch: 'master';
  replaceExistingReview: false;
};
export type SubmissionRequest = StrictGuideUpdate | LocalDryRunGuideUpdate;
export function validateUpdate(payload: GuideUpdatePayload) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    ![
      'type',
      'repo',
      'baseBranch',
      'path',
      'originalContent',
      'content',
      'title',
      'notes',
      'source',
      'branch',
      'existingReviewBranch',
    ].every(
      (key) =>
        typeof (payload as unknown as Record<string, unknown>)[key] ===
        'string',
    ) ||
    payload.type !== 'update' ||
    payload.repo !== 'pvme/pvme-guides' ||
    payload.baseBranch !== 'master' ||
    !/\.txt$/i.test(payload.path) ||
    /[\\:\u0000-\u001f]/.test(payload.path) ||
    payload.path.startsWith('/') ||
    payload.path
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    !['master', 'user-pr'].includes(payload.source) ||
    !payload.branch ||
    (payload.source === 'master' && payload.branch !== 'master') ||
    payload.sourcePreservation !== 'exact' ||
    typeof payload.replaceExistingReview !== 'boolean' ||
    typeof payload.originalContent !== 'string' ||
    typeof payload.content !== 'string' ||
    !payload.content.trim() ||
    payload.content === payload.originalContent ||
    !payload.title.trim() ||
    payload.title.trim().length > 120 ||
    !payload.notes.trim() ||
    payload.notes.trim().length > 2000
  )
    throw new Error(
      'Invalid guide update. Check the source, summary and reason; your draft is retained.',
    );
  if (
    [payload.originalContent, payload.content].some(
      (text) => new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024,
    )
  )
    throw new Error(
      'Guide source exceeds the 2 MiB UTF-8 limit. Export your draft for recovery.',
    );
}
export function validateStrictUpdate(
  payload: SubmissionRequest,
  user?: PublicUser | null,
  allowUnverified = false,
) {
  const keys = [
    'contractVersion',
    'expectedContributor',
    'expectedReview',
    'type',
    'repo',
    'baseBranch',
    'path',
    'originalContent',
    'content',
    'title',
    'notes',
    'source',
    'branch',
    'existingReviewBranch',
    'replaceExistingReview',
    'sourcePreservation',
  ];
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).some((key) => !keys.includes(key)) ||
    (payload.title !== undefined && typeof payload.title !== 'string') ||
    (payload.existingReviewBranch !== undefined &&
      typeof payload.existingReviewBranch !== 'string')
  )
    throw new Error('Invalid strict request fields.');
  validateUpdate({
    ...payload,
    title: payload.title?.trim() || 'Update',
    existingReviewBranch: payload.existingReviewBranch || '',
  });
  if (
    payload.contractVersion !== 2 ||
    !validContributor(payload.expectedContributor)
  )
    throw new Error(
      'Strict v2 submission requires contractVersion 2 and the captured contributor.',
    );
  const review = parseReviewState(payload.expectedReview, allowUnverified);
  validateReviewOwner(review, payload.expectedContributor, user || undefined);
  if (
    payload.source === 'user-pr' &&
    (review.state !== 'present' ||
      payload.branch !== review.branch ||
      payload.replaceExistingReview)
  )
    throw new Error(
      'Review-source submission requires its captured version and replacement false.',
    );
  if (
    payload.existingReviewBranch &&
    (review.state !== 'present' ||
      payload.existingReviewBranch !== review.branch)
  )
    throw new Error(
      'Legacy branch metadata conflicts with the strict review assertion.',
    );
  if (
    payload.source === 'master' &&
    (review.state === 'present') !== payload.replaceExistingReview
  )
    throw new Error(
      'Master replacement requires explicit consent for the captured review version.',
    );
  if (
    review.state === 'unverified' &&
    (!allowUnverified ||
      payload.source !== 'master' ||
      payload.replaceExistingReview)
  )
    throw new Error('Unverified review state is local dry-run only.');
}
export function parseSubmissionResult(
  value: unknown,
  payload: SubmissionRequest,
  status: number,
): SubmissionResult {
  const invalid = () =>
    new SubmissionUncertainError(
      'The server returned an unrecognised submission result. A PR may have changed. Inspect or reload your contribution in Guide Editor before retrying. Your draft is retained.',
    );
  if (
    !record(value) ||
    value.contractVersion !== 2 ||
    value.contributor !== payload.expectedContributor ||
    value.path !== payload.path ||
    !string(value.branch) ||
    !value.branch
  )
    throw invalid();
  if (value.dryRun === true) {
    let user;
    try {
      user = parsePublicUser(value.user);
    } catch {
      throw invalid();
    }
    if (
      !user ||
      status !== 200 ||
      value.reviewStateVerified !== false ||
      (user.provider === 'github'
        ? `github:${user.githubId}`
        : `discord:${user.discordId}`) !== payload.expectedContributor ||
      !string(value.message) ||
      !string(value.title) ||
      value.title !== (payload.title?.trim() || `Update ${payload.path}`) ||
      value.source !== payload.source ||
      value.branch !== payload.branch ||
      !contributorBranch(value.reviewBranch, payload.expectedContributor) ||
      (payload.expectedReview.state === 'present' &&
        value.reviewBranch !== payload.expectedReview.branch) ||
      value.contentBytes !==
        new TextEncoder().encode(payload.content).byteLength ||
      value.originalContentBytes !==
        new TextEncoder().encode(payload.originalContent).byteLength
    )
      throw invalid();
    return {
      contractVersion: 2,
      contributor: payload.expectedContributor,
      reviewStateVerified: false,
      dryRun: true,
      message: value.message,
      title: value.title,
      path: payload.path,
      branch: value.branch,
      reviewBranch: value.reviewBranch,
      source: payload.source,
      contentBytes: value.contentBytes as number,
      originalContentBytes: value.originalContentBytes as number,
      user,
    };
  }
  if (
    payload.expectedReview.state === 'unverified' ||
    !contributorBranch(value.branch, payload.expectedContributor) ||
    value.dryRun !== undefined ||
    !validPrUrl(value.prUrl) ||
    typeof value.reusedReview !== 'boolean' ||
    status !== (value.reusedReview ? 200 : 201) ||
    value.reusedReview !== (payload.expectedReview.state === 'present') ||
    (payload.expectedReview.state === 'present' &&
      (value.branch !== payload.expectedReview.branch ||
        value.prUrl !== payload.expectedReview.prUrl)) ||
    (payload.source === 'user-pr' &&
      (value.branch !== payload.branch || !value.reusedReview)) ||
    (payload.existingReviewBranch &&
      value.branch !== payload.existingReviewBranch)
  )
    throw invalid();
  return {
    contractVersion: 2,
    contributor: payload.expectedContributor,
    path: payload.path,
    branch: value.branch,
    prUrl: value.prUrl,
    reusedReview: value.reusedReview,
  };
}
