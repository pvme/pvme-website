import type { GuideUpdatePayload } from './edit-session';
import type { PublicUser } from './guide-api';

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
    !value.csrfToken ||
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
    /^\d+$/.test(value.githubId) &&
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
    /^\d+$/.test(value.discordId) &&
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
  prUrl: string;
  branch: string;
  path: string;
  reusedReview: boolean;
}
export interface DryRunUpdate {
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
export function validateUpdate(payload: GuideUpdatePayload) {
  if (
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
export function parseSubmissionResult(
  value: unknown,
  payload: GuideUpdatePayload,
): SubmissionResult {
  const invalid = () =>
    new SubmissionUncertainError(
      'The server returned an unrecognised submission result. A PR may have changed. Inspect or reload your contribution in Guide Editor before retrying. Your draft is retained.',
    );
  if (
    !record(value) ||
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
      !string(value.message) ||
      !string(value.title) ||
      value.source !== payload.source ||
      value.branch !== payload.branch ||
      !string(value.reviewBranch) ||
      !value.reviewBranch ||
      value.contentBytes !==
        new TextEncoder().encode(payload.content).byteLength ||
      value.originalContentBytes !==
        new TextEncoder().encode(payload.originalContent).byteLength
    )
      throw invalid();
    return {
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
    value.dryRun !== undefined ||
    !validPrUrl(value.prUrl) ||
    typeof value.reusedReview !== 'boolean' ||
    (payload.source === 'user-pr' &&
      (value.branch !== payload.branch || !value.reusedReview)) ||
    (payload.existingReviewBranch &&
      value.branch !== payload.existingReviewBranch)
  )
    throw invalid();
  return {
    path: payload.path,
    branch: value.branch,
    prUrl: value.prUrl,
    reusedReview: value.reusedReview,
  };
}
