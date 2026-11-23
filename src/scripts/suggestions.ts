export function initializeSuggestions(
  doc: Document = document,
  currentUrl = () => doc.defaultView?.location?.href || '',
) {
  const dialog = doc.querySelector<HTMLDialogElement>(
    '[data-suggestion-dialog]',
  );
  if (!dialog || dialog.dataset.ready) return;
  const form = dialog.querySelector<HTMLFormElement>('[data-suggestion-form]')!;
  const context = dialog.querySelector<HTMLElement>(
    '[data-suggestion-context]',
  )!;
  let trigger: HTMLButtonElement | undefined;
  let overflow = '';
  doc.addEventListener('click', (event) => {
    const button = (event.target as Element).closest?.<HTMLButtonElement>(
      '[data-suggest-improvement]',
    );
    const actions = button?.closest<HTMLElement>('[data-guide-actions]');
    if (!button || !actions || dialog.open) return;
    trigger = button;
    context.textContent = actions.dataset.guideTitle || '';
    form.querySelector<HTMLInputElement>('[name="guidePath"]')!.value =
      actions.dataset.guidePath || '';
    form.querySelector<HTMLInputElement>('[name="pageUrl"]')!.value =
      currentUrl();
    overflow = doc.documentElement.style.overflow;
    doc.documentElement.style.overflow = 'hidden';
    dialog.showModal();
  });
  form.addEventListener('submit', (event) => event.preventDefault());
  dialog
    .querySelectorAll('[data-suggestion-close]')
    .forEach((button) =>
      button.addEventListener('click', () => dialog.close()),
    );
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    doc.documentElement.style.overflow = overflow;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    trigger = undefined;
  });
  dialog.dataset.ready = 'true';
}
if (typeof document !== 'undefined') initializeSuggestions();
