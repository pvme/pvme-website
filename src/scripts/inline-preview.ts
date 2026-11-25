import type { EditSession } from '../lib/edit-session';
import { syncSourceLines } from './rich-line-editor';

/** Safe updates to existing leaves only. No innerHTML, structural rendering or shifted offsets. */
export function updateDraftPreview(
  doc: Document,
  session: EditSession,
  editing: boolean,
) {
  if (editing) syncSourceLines(doc, session, true);
  for (const article of doc.querySelectorAll<HTMLElement>(
    'article[data-guide-source]',
  )) {
    if (
      article.dataset.guideSource !== session.path ||
      article.dataset.guideSourceHash !== session.sourceHash
    )
      continue;
    article.toggleAttribute('data-inline-active', editing);
    for (const element of article.querySelectorAll<HTMLElement>(
      '[data-edit-ref], [data-edit-url]',
    )) {
      if (element.closest('[data-line-editing]')) continue;
      const ref = element.dataset.editRef,
        url = element.dataset.editUrl;
      if (ref) {
        const entry = session.entry(ref);
        const value = editing ? session.value(ref) : entry.value;
        const botHeading = session.lines.some(
          (line) =>
            line.botPrefix &&
            line.range.start.offset === entry.range.start.offset,
        );
        element.textContent = botHeading ? value.replace(/^> +/, '') : value;
      }
      if (url) {
        const entry = session.entry(url);
        const value = editing ? session.value(url) : entry.value;
        if (!originalLinks.has(element))
          originalLinks.set(element, {
            href: element.getAttribute('href') || '',
            bare: session.isBareUrl(url),
            text: element.textContent || '',
          });
        const original = originalLinks.get(element)!;
        element.setAttribute('href', editing ? value : original.href);
        if (original.bare)
          element.textContent = editing ? value : original.text;
      }
      const changed =
        editing &&
        [ref, url].some(
          (id) => id && session.value(id) !== session.entry(id).value,
        );
      element.toggleAttribute('data-edit-modified', !!changed);
      if (
        editing &&
        (!element.closest('[data-source-line]') || element.tagName === 'A')
      ) {
        if (!originalAccess.has(element))
          originalAccess.set(
            element,
            Object.fromEntries(
              ['tabindex', 'role', 'aria-label'].map((key) => [
                key,
                element.getAttribute(key),
              ]),
            ),
          );
        element.tabIndex = 0;
        element.setAttribute('role', 'button');
        element.setAttribute(
          'aria-label',
          `Edit ${url ? 'link' : 'text'}: ${(element.textContent || '').slice(0, 100)}`,
        );
      } else {
        const access = originalAccess.get(element);
        if (access)
          for (const [key, value] of Object.entries(access)) {
            if (value === null) element.removeAttribute(key);
            else element.setAttribute(key, value);
          }
        originalAccess.delete(element);
      }
    }
  }
  if (!editing) syncSourceLines(doc, session, false);
}
const originalLinks = new WeakMap<
  HTMLElement,
  { href: string; bare: boolean; text: string }
>();
const originalAccess = new WeakMap<
  HTMLElement,
  Record<string, string | null>
>();
