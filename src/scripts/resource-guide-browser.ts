export function initializeResourceGuideBrowser(
  root: HTMLElement,
  browser: Pick<Window, 'location' | 'addEventListener'> = window,
) {
  const grid = root.querySelector<HTMLElement>('[data-resource-category-grid]');
  if (!grid) return;
  const input = root.querySelector<HTMLInputElement>('[data-directory-query]')!;
  const results = root.querySelector<HTMLElement>(
    '[data-resource-guide-results]',
  )!;
  const status = root.querySelector<HTMLElement>(
    '[data-resource-guide-status]',
  )!;
  const sync = () => {
    const searching = !!input.value.trim();
    grid.hidden = searching;
    results.hidden = !searching;
    status.hidden = !searching;
  };
  input.value = new URLSearchParams(browser.location.search).get('q') || '';
  input.addEventListener('input', sync);
  root
    .querySelectorAll('[data-directory-reset]')
    .forEach((button) =>
      button.addEventListener('click', () => queueMicrotask(sync)),
    );
  browser.addEventListener('popstate', () => {
    input.value = new URLSearchParams(browser.location.search).get('q') || '';
    sync();
  });
  sync();
  return { sync };
}
if (typeof document !== 'undefined')
  document
    .querySelectorAll<HTMLElement>('[data-resource-guide-browser]')
    .forEach((root) => initializeResourceGuideBrowser(root));
