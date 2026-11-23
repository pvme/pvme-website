const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export function initializeCombatStyleDirectory(
  root: HTMLElement,
  browser: Pick<Window, 'location' | 'history' | 'addEventListener'> = window,
) {
  const query = root.querySelector<HTMLInputElement>(
    '[data-style-directory-query]',
  )!;
  const status = root.querySelector<HTMLElement>(
    '[data-style-directory-status]',
  )!;
  const count = root.querySelector<HTMLElement>(
    '[data-style-directory-count]',
  )!;
  const empty = root.querySelector<HTMLElement>(
    '[data-style-directory-empty]',
  )!;
  const panels = [
    ...root.querySelectorAll<HTMLElement>('[data-style-directory-panel]'),
  ];
  const filters = [
    ...root.querySelectorAll<HTMLButtonElement>(
      '[data-style-directory-category]',
    ),
  ];
  const current = () => new URL(browser.location.href);
  const write = (edit: (params: URLSearchParams) => void) => {
    const address = current();
    edit(address.searchParams);
    browser.history.replaceState(
      null,
      '',
      address.pathname + address.search + address.hash,
    );
  };
  const sync = () => {
    const params = current().searchParams;
    query.value = params.get('q') || '';
    const panel = panels[0];
    const groups = [
      ...panel.querySelectorAll<HTMLElement>('[data-style-directory-group]'),
    ];
    const category = groups.some(
      (group) => group.dataset.styleDirectoryGroup === params.get('category'),
    )
      ? params.get('category') || ''
      : '';
    const words = normalize(query.value).split(' ').filter(Boolean);
    let matches = 0;
    for (const group of groups) {
      let visible = 0;
      group
        .querySelectorAll<HTMLElement>('[data-style-directory-entry]')
        .forEach((entry) => {
          const terms = normalize(entry.dataset.styleDirectoryTerms || '');
          entry.hidden =
            !!(category && group.dataset.styleDirectoryGroup !== category) ||
            !words.every((word) => terms.includes(word));
          if (!entry.hidden) visible++;
        });
      group.hidden = !visible;
      matches += visible;
    }
    filters.forEach((button) => {
      button.hidden =
        !!button.dataset.styleDirectoryCategory &&
        !groups.some(
          (group) =>
            group.dataset.styleDirectoryGroup ===
            button.dataset.styleDirectoryCategory,
        );
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.styleDirectoryCategory === category),
      );
    });
    status.hidden = !(query.value.trim() || category);
    count.textContent = `${matches} ${matches === 1 ? 'guide' : 'guides'}`;
    empty.hidden = !!matches;
  };
  query.addEventListener('input', () => {
    write((params) => {
      if (query.value.trim()) params.set('q', query.value);
      else params.delete('q');
    });
    sync();
  });
  filters.forEach((button) =>
    button.addEventListener('click', () => {
      write((params) => {
        const category = button.dataset.styleDirectoryCategory!;
        if (category) params.set('category', category);
        else params.delete('category');
      });
      sync();
    }),
  );
  root.querySelectorAll('[data-style-directory-reset]').forEach((button) =>
    button.addEventListener('click', () => {
      write((params) => {
        params.delete('q');
        params.delete('category');
      });
      sync();
      query.focus({ preventScroll: true });
    }),
  );
  browser.addEventListener('popstate', sync);
  sync();
  return { sync };
}
if (typeof document !== 'undefined')
  document
    .querySelectorAll<HTMLElement>('[data-combat-style-directory]')
    .forEach((root) => initializeCombatStyleDirectory(root));
