import type { LoadedGuideSource } from './guide-source-provider';
import type { SubmissionRequest } from './submission-contract';
import {
  parseReviewState,
  validateLoadedReview,
  validateReviewOwner,
  type ReviewVersion,
  type ContributorIdentity,
} from './review-state';
import {
  record,
  parsePublicUser,
  parseSubmissionResult,
  validateStrictUpdate,
  SubmissionUncertainError,
} from './submission-contract';

export type PublicUser = {
  username: string;
  globalName: string;
  avatar: string;
  displayName: string;
  csrfToken: string;
  canReviewPrs: boolean;
} & (
  | { provider: 'github'; githubId: string; githubLogin: string }
  | { provider: 'discord'; discordId: string; pvmeMember: boolean }
);
export interface ExistingReviewChoice {
  hasExistingReview: true;
  path: string;
  name: string;
  repo: 'pvme/pvme-guides';
  reviewBranch: string;
  prUrl: string;
  liveBranch: 'master';
  baseBranch: 'master';
  reviewState: ReviewVersion;
}
export type GuideSourceChoice = 'auto' | 'master' | 'review';
export const contributorId = (
  user: PublicUser | null,
): ContributorIdentity | null =>
  user
    ? user.provider === 'github'
      ? `github:${user.githubId}`
      : `discord:${user.discordId}`
    : null;
export const eligibleContributor = (
  user: PublicUser | null,
): user is PublicUser =>
  !!user && (user.provider === 'github' || user.pvmeMember === true);

export class GuideApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Tokens and identity live only in this instance; no authentication persistence. */
export class GuideApi {
  user: PublicUser | null = null;
  onIdentityChange?: () => void;
  private restoration?: Promise<PublicUser | null>;
  private epoch = 0;
  private submitting = false;
  constructor(
    readonly development: boolean,
    private readonly request: typeof fetch = fetch,
    readonly submissionEnabled = false,
  ) {}
  get base() {
    return this.development ? '/api/guide-pr' : 'https://guide-api.pvme.io';
  }
  private setUser(user: PublicUser | null) {
    const changed = contributorId(this.user) !== contributorId(user);
    this.user = user;
    if (changed) this.onIdentityChange?.();
  }
  restore(fresh = false): Promise<PublicUser | null> {
    if (fresh) {
      this.epoch++;
      this.restoration = undefined;
    }
    if (this.restoration) return this.restoration;
    const epoch = this.epoch;
    const pending = this.restoreAttempt(epoch);
    this.restoration = pending;
    void pending
      .finally(() => {
        if (this.restoration === pending) this.restoration = undefined;
      })
      .catch(() => {});
    return pending;
  }
  private async restoreAttempt(epoch: number): Promise<PublicUser | null> {
    try {
      const data = await this.json<{ user: PublicUser | null }>('/auth/me');
      if (epoch !== this.epoch) return this.user;
      this.setUser(parsePublicUser(data.user));
      return this.user;
    } catch (error) {
      if (epoch === this.epoch) this.setUser(null);
      throw error;
    }
  }
  async requireContributor(expected?: string | null, fresh = false) {
    const user = await this.restore(fresh);
    if (!eligibleContributor(user))
      throw new Error(
        'Sign in with an eligible contributor account to edit this guide. Your draft is retained.',
      );
    if (expected && contributorId(user) !== expected)
      throw new Error(
        'Your account changed. Reopen the editor to use this account’s draft.',
      );
    return user;
  }
  loginUrl(provider: 'github' | 'discord', href: string) {
    const returnUrl = new URL(href);
    for (const key of ['authError', 'githubSession', 'submit'])
      returnUrl.searchParams.delete(key);
    return `${this.base}/auth/${provider}/start?${new URLSearchParams({ returnTo: returnUrl.href })}`;
  }
  async logout() {
    await this.json('/auth/logout', 'POST');
    this.epoch++;
    this.restoration = undefined;
    this.setUser(null);
  }
  async verifyLocalDryRun() {
    if (!this.development)
      throw new Error(
        'Unverified review metadata is disabled outside local development.',
      );
    const health = await this.json<Record<string, unknown>>('/');
    if (
      health.ok !== true ||
      health.mode !== 'dry-run' ||
      health.repo !== 'pvme/pvme-guides' ||
      health.baseBranch !== 'master'
    )
      throw new Error(
        'Local backend dry-run mode could not be verified. Keep your draft.',
      );
    return true;
  }
  async load(path: string, source: GuideSourceChoice = 'auto') {
    const user = this.user;
    const identity = contributorId(user);
    const value = await this.json<Record<string, unknown>>(
      `/guides/load?${new URLSearchParams({ path, source })}`,
    );
    if (
      value.path !== path ||
      value.repo !== 'pvme/pvme-guides' ||
      value.baseBranch !== 'master' ||
      typeof value.name !== 'string'
    )
      throw new Error('Invalid guide-load response. Keep/export your draft.');
    let localDryRunVerified = false;
    if (record(value.reviewState) && value.reviewState.state === 'unverified')
      localDryRunVerified =
        value.dryRun === true && (await this.verifyLocalDryRun());
    const reviewState = parseReviewState(
      value.reviewState,
      localDryRunVerified,
    );
    if (identity && user) validateReviewOwner(reviewState, identity, user);
    if (value.hasExistingReview === true) {
      if (
        !identity ||
        reviewState.state !== 'present' ||
        value.reviewBranch !== reviewState.branch ||
        value.prUrl !== reviewState.prUrl ||
        value.liveBranch !== 'master' ||
        Object.hasOwn(value, 'originalText')
      )
        throw new Error('Invalid existing-review choice. Reload the source.');
      return {
        hasExistingReview: true,
        path,
        name: value.name,
        repo: 'pvme/pvme-guides',
        baseBranch: 'master',
        liveBranch: 'master',
        reviewBranch: reviewState.branch,
        prUrl: reviewState.prUrl,
        reviewState,
      } satisfies ExistingReviewChoice;
    }
    if (
      typeof value.originalText !== 'string' ||
      !['master', 'user-pr'].includes(value.source as string) ||
      typeof value.branch !== 'string' ||
      typeof value.prUrl !== 'string' ||
      (value.existingReviewBranch !== undefined &&
        typeof value.existingReviewBranch !== 'string') ||
      (value.existingReviewUrl !== undefined &&
        typeof value.existingReviewUrl !== 'string') ||
      (source === 'master' && value.source !== 'master') ||
      (source === 'review' && value.source !== 'user-pr')
    )
      throw new Error('Invalid selected-source response.');
    const loaded: LoadedGuideSource = {
      path,
      name: value.name,
      repo: 'pvme/pvme-guides',
      baseBranch: 'master',
      originalText: value.originalText,
      source: value.source as LoadedGuideSource['source'],
      branch: value.branch,
      prUrl: value.prUrl,
      reviewState,
      ...(identity ? { contributor: identity } : {}),
      ...(value.existingReviewBranch !== undefined
        ? { existingReviewBranch: value.existingReviewBranch as string }
        : {}),
      ...(value.existingReviewUrl !== undefined
        ? { existingReviewUrl: value.existingReviewUrl as string }
        : {}),
      ...(value.dryRun === true ? { dryRun: true } : {}),
      ...(localDryRunVerified ? { localDryRunVerified: true } : {}),
    };
    if (identity && user)
      validateLoadedReview(loaded, identity, user, localDryRunVerified);
    return loaded;
  }
  async submit(payload: SubmissionRequest, expectedIdentity: string) {
    if (!this.submissionEnabled)
      throw new Error(
        'Guide submission is not enabled for this build. Export your draft instead.',
      );
    if (this.submitting) throw new Error('A submission is already pending.');
    this.submitting = true;
    try {
      if (payload.expectedContributor !== expectedIdentity)
        throw new Error(
          'Captured contributor does not match the strict request.',
        );
      validateStrictUpdate(payload, this.user, this.development);
      payload = Object.freeze({
        ...payload,
        expectedReview: parseReviewState(
          payload.expectedReview,
          this.development,
        ),
      }) as SubmissionRequest;
      const localDryRun =
        payload.expectedReview?.state === 'unverified'
          ? await this.verifyLocalDryRun()
          : false;
      validateStrictUpdate(payload, this.user, localDryRun);
      await this.requireContributor(expectedIdentity, true);
      if (!this.user?.csrfToken.trim())
        throw new Error(
          'Explicit in-memory CSRF is required. Refresh your original session deliberately.',
        );
      validateStrictUpdate(payload, this.user, localDryRun);
      let data: unknown;
      let status = 0;
      try {
        data = await this.json(
          '/v2/submissions',
          'POST',
          payload,
          false,
          [200, 201],
          (value) => {
            status = value;
          },
        );
      } catch (error) {
        if (error instanceof GuideApiError) throw error;
        throw new SubmissionUncertainError(
          'The submission outcome is uncertain. A PR may have changed. Inspect or reload your contribution in Guide Editor before retrying. Your draft is retained.',
        );
      }
      const result = parseSubmissionResult(data, payload, status);
      if ('dryRun' in result && contributorId(result.user) !== expectedIdentity)
        throw new SubmissionUncertainError(
          'The response identity changed. Inspect your contribution before retrying; your draft is retained.',
        );
      return result;
    } finally {
      this.submitting = false;
    }
  }
  private async json<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    retry = true,
    acceptedStatuses?: number[],
    responseStatus?: (status: number) => void,
  ): Promise<T> {
    const identity = contributorId(this.user);
    // Browser fetch requires its Window receiver; invoking an injected property
    // as this.request(...) gives it the API instance instead.
    const response = await this.request.call(
      globalThis,
      `${this.base}${path}`,
      {
        method,
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          ...(this.user?.csrfToken
            ? { 'X-PVME-CSRF-Token': this.user.csrfToken }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const parsed: unknown = await response.json().catch(() => ({}));
    const data = record(parsed) ? parsed : {};
    if (!response.ok) {
      if (
        retry &&
        identity &&
        method !== 'GET' &&
        response.status === 403 &&
        typeof data.error === 'string' &&
        data.error.includes('login session could not be verified')
      ) {
        await this.requireContributor(identity, true);
        return this.json(path, method, body, false, acceptedStatuses);
      }
      if (response.status === 401) this.setUser(null);
      throw new GuideApiError(
        typeof data.error === 'string'
          ? data.error
          : `Request failed (${response.status}).`,
        response.status,
        typeof data.code === 'string' ? data.code : undefined,
      );
    }
    if (acceptedStatuses && !acceptedStatuses.includes(response.status))
      throw new SubmissionUncertainError(
        'Unrecognised submission status. Inspect your contribution before retrying; your draft is retained.',
      );
    responseStatus?.(response.status);
    return data as T;
  }
}

/** Scrub the bearer handoff before any asynchronous work or outgoing requests. */
export function consumeOAuthReturn(
  href: string,
  replace: (url: string) => void,
) {
  const url = new URL(href);
  const token = url.searchParams.get('githubSession');
  const error = url.searchParams.get('authError');
  for (const key of ['githubSession', 'authError', 'submit'])
    url.searchParams.delete(key);
  if (url.href !== href) replace(url.href);
  return { token, error };
}
