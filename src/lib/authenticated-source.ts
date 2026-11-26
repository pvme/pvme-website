import {
  GuideApi,
  contributorId,
  type ExistingReviewChoice,
} from './guide-api';
import type { GuideSourceProvider } from './guide-source-provider';

/** Revalidate identity for every source read, including the selected-source recheck. */
export function authenticatedSourceProvider(
  api: GuideApi,
  identity: () => string | null,
  choose: (review: ExistingReviewChoice) => Promise<'master' | 'review'>,
): GuideSourceProvider {
  return {
    async load(path, source) {
      const expected = identity();
      if (!expected) throw new Error('Log in before editing.');
      await api.requireContributor(expected);
      let loaded = await api.load(
        path,
        source === 'user-pr' ? 'review' : source || 'auto',
      );
      if ('hasExistingReview' in loaded) {
        const selection = await choose(loaded);
        await api.requireContributor(expected);
        loaded = await api.load(path, selection);
      }
      if (contributorId(api.user) !== expected)
        throw new Error(
          'Account changed while loading source. Reopen the editor.',
        );
      if ('hasExistingReview' in loaded)
        throw new Error('Choose a guide source before editing.');
      return loaded;
    },
  };
}
