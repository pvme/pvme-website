import { GuideApi, GuideApiError } from './guide-api';
import { record, parsePublicUser } from './submission-contract';

/** Dynamically imported only in Astro development; omitted from production assets. */
export async function completeGithubDevLogin(
  api: GuideApi,
  token: string,
  request: typeof fetch = fetch,
) {
  if (!api.development)
    throw new Error('Local authentication is disabled in production.');
  const response = await request.call(
    globalThis,
    `${api.base}/auth/dev-session`,
    {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(api.user?.csrfToken
          ? { 'X-PVME-CSRF-Token': api.user.csrfToken }
          : {}),
      },
      body: JSON.stringify({ token }),
    },
  );
  const value: unknown = await response.json().catch(() => ({}));
  const data = record(value) ? value : {};
  if (!response.ok)
    throw new GuideApiError(
      typeof data.error === 'string'
        ? data.error
        : 'Local GitHub login could not be completed.',
      response.status,
      typeof data.code === 'string' ? data.code : undefined,
    );
  // Restore /auth/me after cookie establishment, rather than persisting the handoff response.
  if (!parsePublicUser(data.user))
    throw new Error('Invalid local login response.');
}
