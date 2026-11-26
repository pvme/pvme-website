import {
  initializeInlineEditor,
  type InlineEditorOptions,
} from './inline-editor';
import { DraftStorage, type DraftStore } from '../lib/draft-storage';
import type {
  GuideSourceProvider,
  LinkPage,
} from '../lib/guide-source-provider';
import { GuideApi, consumeOAuthReturn, contributorId } from '../lib/guide-api';
import { authenticatedSourceProvider } from '../lib/authenticated-source';
import { guideEditorHref } from '../lib/guide-editor';
import { releaseFlags } from '../lib/release-flags';
import { GuideSubmission } from '../lib/guide-submission';

const flags = releaseFlags(
  import.meta.env.DEV,
  import.meta.env.PUBLIC_AUTHENTICATION,
  import.meta.env.PUBLIC_AUTHENTICATED_EDITING,
  import.meta.env.PUBLIC_GUIDE_SUBMISSION,
);
const api = new GuideApi(import.meta.env.DEV, fetch, flags.submission);
const { authenticatedEditing, localEditing } = flags;
const account = document.querySelector<HTMLDetailsElement>('[data-account]')!;
const accountError = account.querySelector<HTMLElement>(
  '[data-account-error]',
)!;
const oauth = consumeOAuthReturn(window.location.href, (url) =>
  history.replaceState(history.state, '', url),
);
let storage: DraftStore;
try {
  storage = window.localStorage;
} catch {
  storage = {
    getItem() {
      throw new Error('Storage unavailable');
    },
    setItem() {
      throw new Error('Storage unavailable');
    },
    removeItem() {
      throw new Error('Storage unavailable');
    },
  };
}
let editor: ReturnType<typeof initializeInlineEditor>;
let identity: string | null = null;
let options: InlineEditorOptions;
let linkPages: Promise<LinkPage[]> | undefined;
const base = import.meta.env.BASE_URL.replace(/\/$/, '');
const status = (message: string, reveal = true) => {
  accountError.textContent = message;
  if (reveal) account.open = true;
};
function renderAccount() {
  const user = api.user;
  account.querySelector('[data-account-name]')!.textContent =
    user?.displayName || user?.globalName || user?.username || 'Log in';
  account.querySelector('[data-account-status]')!.textContent = user
    ? `Signed in with ${user.provider === 'github' ? 'GitHub' : 'Discord'}`
    : 'Sign in to contribute';
  account.querySelector<HTMLElement>('[data-logout]')!.hidden = !user;
  const image = account.querySelector<HTMLImageElement>(
    '[data-account-avatar]',
  )!;
  let avatar = '';
  if (user?.avatar) {
    if (user.provider === 'discord' && /^[a-zA-Z0-9_]+$/.test(user.avatar))
      avatar = `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.discordId)}/${user.avatar}.png?size=64`;
    else {
      try {
        const url = new URL(user.avatar);
        if (url.protocol === 'https:') avatar = url.href;
      } catch {
        /* No image. */
      }
    }
  }
  image.hidden = !avatar;
  if (avatar) image.src = avatar;
  else image.removeAttribute('src');
}
api.onIdentityChange = () => {
  editor?.suspend();
  for (const element of document.querySelectorAll<HTMLDialogElement>(
    '.auth-source-dialog[open]',
  ))
    element.close();
  identity = contributorId(api.user);
  if (options && authenticatedEditing)
    options.drafts = new DraftStorage(storage, identity || 'signed-out');
  renderAccount();
};
function dialog(title: string, text: string) {
  const element = document.createElement('dialog');
  element.className = 'auth-source-dialog';
  element.setAttribute('aria-label', title);
  const heading = document.createElement('h2');
  heading.textContent = title;
  const description = document.createElement('p');
  description.textContent = text;
  const actions = document.createElement('div');
  actions.className = 'inline-actions';
  element.append(heading, description, actions);
  document.body.append(element);
  const button = (label: string, action: () => void) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.onclick = action;
    actions.append(node);
    return node;
  };
  element.addEventListener('close', () => element.remove());
  return { element, actions, button };
}
const authenticated = authenticatedSourceProvider(
  api,
  () => identity,
  (review) =>
    new Promise((resolve, reject) => {
      const ui = dialog(
        'Continue your contribution',
        'You already have a submitted update for this guide. Choose the source to edit. Loading the live guide does not authorise replacing your update.',
      );
      const link = document.createElement('a');
      link.textContent = 'View submitted update';
      if (/^https:\/\/github\.com\//.test(review.prUrl)) {
        link.href = review.prUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        ui.actions.append(link);
      }
      let selected = false;
      for (const [label, value] of [
        ['Load submitted update', 'review'],
        ['Load live guide', 'master'],
      ] as const)
        ui.button(label, () => {
          selected = true;
          ui.element.close();
          resolve(value);
        });
      ui.button('Cancel', () => ui.element.close());
      ui.element.addEventListener('close', () => {
        if (!selected)
          reject(
            new Error('Source selection cancelled. Your draft is retained.'),
          );
      });
      ui.element.showModal();
    }),
);
const provider: GuideSourceProvider = {
  async load(path, source) {
    let loaded;
    if (authenticatedEditing) loaded = await authenticated.load(path, source);
    else {
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      const response = await fetch(`${base}/guide-source/${encodedPath}.json`, {
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok)
        throw new Error('Guide source unavailable. Use Guide Editor.');
      loaded = await response.json();
    }
    linkPages ??= fetch(`${base}/link-pages.json`, { credentials: 'omit' })
      .then((result) =>
        result.ok ? (result.json() as Promise<LinkPage[]>) : [],
      )
      .catch(() => {
        linkPages = undefined;
        return [];
      });
    loaded.linkPages = await linkPages;
    loaded.previewLinks ||= {};
    for (const page of loaded.linkPages)
      loaded.previewLinks[page.sourceUrl] ||= {
        href: page.href,
        title: page.title,
      };
    return loaded;
  },
};
if (localEditing || authenticatedEditing) {
  options = {
    pageCanvas: true,
    refreshEmojis: true,
    provider,
    submission: flags.submission
      ? new GuideSubmission(api, provider)
      : undefined,
    drafts: new DraftStorage(
      storage,
      localEditing ? 'local-development' : 'signed-out',
    ),
    restoreReadingDrafts: localEditing,
    beforeEnter: authenticatedEditing
      ? async () => {
          try {
            await api.requireContributor(identity);
          } catch (error) {
            status(error instanceof Error ? error.message : 'Sign in to edit.');
            throw error;
          }
        }
      : undefined,
    onSourceFailure(path, error) {
      if (!authenticatedEditing || !api.user) return;
      const ui = dialog(
        'Inline editing unavailable',
        `${error instanceof Error ? error.message : 'Source could not be verified.'} Stored drafts are retained. A refreshed site build or Guide Editor may be needed.`,
      );
      const link = document.createElement('a');
      link.href = guideEditorHref({ path });
      link.textContent = 'Open Guide Editor';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      ui.actions.append(link);
      if (options.drafts.hasDraft(path))
        ui.button('Export stored draft', () => {
          const raw = options.drafts.snapshot(path);
          if (!raw) return;
          const url = URL.createObjectURL(
            new Blob([raw], { type: 'application/json' }),
          );
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = 'pvme-draft-recovery.json';
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
      ui.button('Close', () => ui.element.close());
      ui.element.showModal();
    },
  };
  editor = initializeInlineEditor(document, options);
}
async function restore() {
  try {
    await api.restore();
    accountError.textContent = '';
    renderAccount();
  } catch {
    renderAccount();
    status(
      'Session could not be checked. Your drafts are retained. Try Refresh session.',
      false,
    );
  }
}
if (flags.authentication) {
  for (const button of account.querySelectorAll<HTMLButtonElement>(
    '[data-login]',
  ))
    button.onclick = () => {
      if (editor && !editor.checkpoint()) return;
      window.location.assign(
        api.loginUrl(
          button.dataset.login as 'discord' | 'github',
          window.location.href,
        ),
      );
    };
  account.querySelector<HTMLButtonElement>('[data-logout]')!.onclick = async (
    event,
  ) => {
    if (editor && !editor.checkpoint()) return;
    editor?.suspend();
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      await api.logout();
      accountError.textContent = '';
      renderAccount();
    } catch (error) {
      status(error instanceof Error ? error.message : 'Logout failed.');
    } finally {
      button.disabled = false;
    }
  };
  account.querySelector<HTMLButtonElement>('[data-auth-refresh]')!.onclick =
    () => void restore();
  window.addEventListener('focus', () => void restore());
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) void restore();
  });
  void (async () => {
    if (oauth.token && import.meta.env.DEV) {
      try {
        const { completeGithubDevLogin } = await import('../lib/guide-api-dev');
        await completeGithubDevLogin(api, oauth.token);
      } catch {
        status(
          'Local GitHub login could not be completed. Please log in again.',
        );
      }
    }
    await restore();
    if (oauth.error) status(oauth.error);
  })();
}
