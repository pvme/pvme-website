import {
  tabChoices,
  hubBreadcrumbTitle,
  hubChoiceHref,
  type MenuGuide,
  type MenuChoice,
} from '../lib/hub-menu';
import { navigationSettings } from '../../catalogue/src/navigation-definitions';
export type HubBrowser = Pick<
  Window,
  'location' | 'history' | 'addEventListener' | 'requestAnimationFrame'
>;
export function initializeHub(root: HTMLElement, browser: HubBrowser = window) {
  const doc = root.ownerDocument;
  const guides: MenuGuide[] = JSON.parse(
    root.querySelector('[data-hub-model]')!.textContent!,
  );
  const subject = root.dataset.subject || '';
  const tabs = [...root.querySelectorAll<HTMLAnchorElement>('[data-tab]')];
  if (!tabs.length) return;
  const choices = new Map(
    tabs.map((t) => {
      const type = t.dataset.tab!;
      return [type, tabChoices(guides, type, subject)];
    }),
  );
  const remembered = new Map<string, MenuChoice>();
  let params = new URLSearchParams(browser.location.search),
    current: MenuChoice,
    active = tabs[0].dataset.tab!,
    open: string | undefined;
  const supportsHover = () =>
    doc.defaultView?.matchMedia?.(
      '(min-width: 761px) and (hover: hover) and (pointer: fine)',
    ).matches ?? true;
  let hoverOpened: string | undefined;
  let hoverCloseTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelHoverClose = () => {
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = undefined;
  };
  const visibleItems = (type: string) =>
    [
      ...root.querySelectorAll<HTMLElement>(
        `[data-menu="${type}"] [data-choice]`,
      ),
    ].filter((b) => !b.hidden);
  const close = (restore = false) => {
    cancelHoverClose();
    hoverOpened = undefined;
    if (!open) return;
    const trigger = tabs.find((t) => t.dataset.tab === open);
    root.querySelector<HTMLElement>(`[data-menu="${open}"]`)!.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    open = undefined;
    if (restore) trigger?.focus({ preventScroll: true });
  };
  const fragment = () => {
    try {
      return decodeURIComponent(browser.location.hash.slice(1));
    } catch {
      return '';
    }
  };
  const render = () => {
    active = choices.has(params.get('tab') || '')
      ? params.get('tab')!
      : tabs[0].dataset.tab!;
    const anchor = fragment();
    const requestedGuide =
      params.get('guide') ||
      guides.find((guide) => anchor.startsWith(`${guide.id}--`))?.id;
    if (
      requestedGuide &&
      !choices.get(active)!.some((choice) => choice.guideId === requestedGuide)
    ) {
      const correctedTab = [...choices].find(([, items]) =>
        items.some((choice) => choice.guideId === requestedGuide),
      );
      if (correctedTab) active = correctedTab[0];
    }
    const items = choices.get(active)!;
    const selected =
      items.find((choice) => !!anchor && choice.anchor === anchor) ||
      items.find(
        (choice) =>
          choice.guideId === requestedGuide &&
          !!params.get('method') &&
          choice.methodId === params.get('method'),
      ) ||
      items.find(
        (choice) =>
          !!params.get('guide') &&
          choice.guideId === requestedGuide &&
          !choice.methodId,
      );
    current =
      selected || items.find((c) => c.guideId === requestedGuide) || items[0];
    if (selected) remembered.set(active, current);
    tabs.forEach((t) => {
      const selected = t.dataset.tab === active;
      t.classList.toggle('selected', selected);
      if (selected) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    root
      .querySelectorAll<HTMLElement>('[data-guide-panel]')
      .forEach((p) => (p.hidden = p.dataset.guidePanel !== current.guideId));
    root
      .querySelectorAll<HTMLElement>('[data-choice]')
      .forEach((b) =>
        b.setAttribute(
          'aria-checked',
          String(
            !!selected &&
              b.dataset.choiceTab === active &&
              b.dataset.choice === current.id,
          ),
        ),
      );
    const sourceLink = doc.querySelector<HTMLAnchorElement>(
      '[data-guide-source]',
    );
    const panel = [
      ...root.querySelectorAll<HTMLElement>('[data-guide-panel]'),
    ].find((p) => p.dataset.guidePanel === current.guideId);
    if (sourceLink && panel?.dataset.sourceUrl)
      sourceLink.href = panel.dataset.sourceUrl;
    const selectedGuide = guides.find((guide) => guide.id === current.guideId);
    if (selectedGuide) {
      const title = hubBreadcrumbTitle(subject, selectedGuide.title, active);
      doc
        .querySelectorAll<HTMLElement>('.breadcrumbs [aria-current="page"]')
        .forEach((crumb) => {
          crumb.textContent = title;
        });
    }
    if (panel?.dataset.editorUrl) {
      for (const link of doc.querySelectorAll<HTMLAnchorElement>(
        '[data-guide-editor-external]',
      ))
        link.href = panel.dataset.editorUrl;
      for (const actions of doc.querySelectorAll<HTMLElement>(
        '.site-header [data-guide-actions]',
      )) {
        actions.dataset.guidePath = panel.dataset.guidePath || '';
        actions.dataset.guideTitle = panel.dataset.guideTitle || '';
      }
      if (import.meta.env?.DEV) {
        for (const trigger of doc.querySelectorAll<HTMLElement>(
          '[data-inline-edit-path]',
        )) {
          if (trigger.closest('[data-guide-panel]')) continue;
          trigger.dataset.inlineEditPath = panel.dataset.guidePath || '';
          trigger.dataset.inlineEditTitle = panel.dataset.guideTitle || '';
        }
      }
      for (const pencil of doc.querySelectorAll<HTMLElement>(
        '[data-guide-edit]',
      ))
        pencil.setAttribute(
          'aria-label',
          `Edit ${panel.dataset.guideTitle} in place`,
        );
    }
    const status = root.querySelector<HTMLElement>('[data-reader-status]')!;
    status.hidden = !selected;
    status.textContent = selected ? `Reading: ${current.label}` : '';
    doc.dispatchEvent(new doc.defaultView!.Event('pvme:guide-change'));
  };
  const scrollToSelection = () => {
    const panel = [
      ...root.querySelectorAll<HTMLElement>('[data-guide-panel]'),
    ].find((panel) => panel.dataset.guidePanel === current.guideId);
    const id = fragment();
    let target = id ? doc.getElementById(id) : null;
    if (!target || !panel?.contains(target)) {
      target =
        params.get('method') === current.methodId && current.anchor
          ? doc.getElementById(current.anchor)
          : null;
    }
    if (!target || !panel?.contains(target)) return;
    for (
      let parent = target.closest('details');
      parent && panel.contains(parent);
      parent = parent.parentElement?.closest('details') || null
    )
      parent.open = true;
    const destination = target;
    browser.requestAnimationFrame(() =>
      destination.scrollIntoView({ block: 'start' }),
    );
  };
  const select = (type: string, choice: MenuChoice) => {
    const defaultTab = tabs[0].dataset.tab!;
    const href = hubChoiceHref(
      browser.location.pathname,
      type,
      choice,
      defaultTab,
      choices.get(defaultTab)![0].guideId,
    );
    browser.history.pushState(null, '', href);
    params = new URLSearchParams(browser.location.search);
    render();
    close();
    tabs.find((t) => t.dataset.tab === type)?.focus({ preventScroll: true });
    scrollToSelection();
  };
  const toggle = (type: string, focus = false) => {
    if (open === type) {
      close(true);
      return;
    }
    close();
    open = type;
    const menu = root.querySelector<HTMLElement>(`[data-menu="${type}"]`)!;
    menu.hidden = false;
    menu.style.setProperty('--menu-offset', '0px');
    const viewport = doc.documentElement.clientWidth;
    if (viewport) {
      const overflow = menu.getBoundingClientRect().right - viewport + 16;
      if (overflow > 0)
        menu.style.setProperty('--menu-offset', `${-overflow}px`);
    }
    tabs
      .find((t) => t.dataset.tab === type)
      ?.setAttribute('aria-expanded', 'true');
    if (focus)
      (
        visibleItems(type).find(
          (b) => b.getAttribute('aria-checked') === 'true',
        ) || visibleItems(type)[0]
      )?.focus({ preventScroll: true });
  };
  tabs
    .filter((tab) => tab.hasAttribute('aria-haspopup'))
    .forEach((tab) => {
      const type = tab.dataset.tab!;
      const item = tab.closest<HTMLElement>('.hub-tab-item')!;
      const menu = root.querySelector<HTMLElement>(`[data-menu="${type}"]`)!;
      item.addEventListener('pointerenter', (event) => {
        if (event.pointerType !== 'mouse' || !supportsHover()) return;
        cancelHoverClose();
        if (open !== type) {
          toggle(type);
          hoverOpened = type;
        }
      });
      item.addEventListener('pointerleave', (event) => {
        if (
          event.pointerType !== 'mouse' ||
          !supportsHover() ||
          open !== type ||
          hoverOpened !== type
        )
          return;
        cancelHoverClose();
        hoverCloseTimer = setTimeout(() => {
          if (
            open === type &&
            hoverOpened === type &&
            !menu.contains(doc.activeElement)
          )
            close();
        }, 180);
      });
    });
  root.addEventListener('click', (e) => {
    const target = (e.target as Element).closest<HTMLElement>(
      '[data-tab],[data-choice]',
    );
    if (!target) return;
    const mouse = e as MouseEvent;
    if (
      mouse.button > 0 ||
      mouse.metaKey ||
      mouse.ctrlKey ||
      mouse.shiftKey ||
      mouse.altKey
    )
      return;
    e.preventDefault();
    if (target.dataset.choice) {
      const type = target.dataset.choiceTab!;
      select(
        type,
        choices.get(type)!.find((c) => c.id === target.dataset.choice)!,
      );
      return;
    }
    const type = target.dataset.tab!;
    if (target.hasAttribute('aria-haspopup')) {
      // The first click after hovering should keep the newly opened menu open.
      if (open === type && hoverOpened === type) {
        cancelHoverClose();
        hoverOpened = undefined;
      } else toggle(type);
    } else
      select(
        type,
        type === navigationSettings.overview?.tab
          ? choices.get(type)![0]
          : remembered.get(type) || choices.get(type)![0],
      );
  });
  root.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
      return;
    }
    if (
      target.dataset.tab &&
      target.hasAttribute('aria-haspopup') &&
      ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)
    ) {
      e.preventDefault();
      if (open !== target.dataset.tab) toggle(target.dataset.tab!, true);
      else visibleItems(open)[0]?.focus();
      return;
    }
    if (!open) return;
    if (e.key === 'Tab') {
      close();
      return;
    }
    if (target.dataset.choice && ['Enter', ' '].includes(e.key)) {
      e.preventDefault();
      target.click();
      return;
    }
    if (
      target.classList.contains('menu-search') &&
      !['ArrowDown', 'ArrowUp'].includes(e.key)
    )
      return;
    const items = visibleItems(open);
    const index = items.indexOf(target);
    let next: number | undefined;
    if (e.key === 'ArrowDown') next = (index + 1) % items.length;
    if (e.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = items.length - 1;
    if (next !== undefined) {
      e.preventDefault();
      items[next]?.focus({ preventScroll: true });
    }
  });
  root.querySelectorAll<HTMLInputElement>('.menu-search').forEach((input) =>
    input.addEventListener('input', () => {
      const menu = input.closest<HTMLElement>('[data-menu]')!;
      const query = input.value.toLowerCase().trim();
      menu
        .querySelectorAll<HTMLElement>('[data-choice]')
        .forEach(
          (b) => (b.hidden = !b.textContent!.toLowerCase().includes(query)),
        );
      menu.querySelector<HTMLElement>('.menu-empty')!.hidden =
        visibleItems(menu.dataset.menu!).length > 0;
    }),
  );
  doc.addEventListener('click', (e) => {
    if (
      open &&
      !root
        .querySelector(`[data-menu="${open}"]`)
        ?.contains(e.target as Node) &&
      !tabs.find((t) => t.dataset.tab === open)?.contains(e.target as Node)
    )
      close();
  });
  doc.addEventListener('focusin', (e) => {
    if (
      open &&
      !root
        .querySelector(`[data-menu="${open}"]`)
        ?.contains(e.target as Node) &&
      !tabs.find((t) => t.dataset.tab === open)?.contains(e.target as Node)
    )
      close();
  });
  browser.addEventListener('popstate', () => {
    close();
    params = new URLSearchParams(browser.location.search);
    render();
    scrollToSelection();
  });
  browser.addEventListener('hashchange', () => {
    render();
    scrollToSelection();
  });
  render();
  scrollToSelection();
}
if (typeof document !== 'undefined')
  document
    .querySelectorAll<HTMLElement>('[data-hub]')
    .forEach((root) => initializeHub(root));
