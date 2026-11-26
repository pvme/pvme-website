import type { LoadedGuideSource } from './guide-source-provider';
import type { GuideUpdatePayload } from './edit-session';
import {
  record,
  parsePublicUser,
  parseSubmissionResult,
  validateUpdate,
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
}
export type GuideSourceChoice = 'auto' | 'master' | 'review';
export const contributorId = (user: PublicUser | null): string | null =>
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
  load(path: string, source: GuideSourceChoice = 'auto') {
    return this.json<LoadedGuideSource | ExistingReviewChoice>(
      `/guides/load?${new URLSearchParams({ path, source })}`,
    );
  }
  async submit(payload: GuideUpdatePayload, expectedIdentity: string) {
    if (!this.submissionEnabled)
      throw new Error(
        'Guide submission is not enabled for this build. Export your draft instead.',
      );
    if (this.submitting) throw new Error('A submission is already pending.');
    this.submitting = true;
    try {
      validateUpdate(payload);
      await this.requireContributor(expectedIdentity, true);
      let data: unknown;
      try {
        data = await this.json('/', 'POST', payload, true, [200, 201]);
      } catch (error) {
        if (error instanceof GuideApiError) throw error;
        throw new SubmissionUncertainError(
          'The submission outcome is uncertain. A PR may have changed. Inspect or reload your contribution in Guide Editor before retrying. Your draft is retained.',
        );
      }
      const result = parseSubmissionResult(data, payload);
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
