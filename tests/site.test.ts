import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { getCatalogue, sourcePath, url } from '../src/lib/catalogue';
import { renderGuide } from '../src/lib/renderer';
import { pageLinkTitle } from '../src/lib/page-link-title';
import { websiteCollections } from '../src/lib/collections';
import { groupCollectionCards } from '../src/lib/collection-cards';
import { initializeDirectory } from '../src/scripts/directory';
import { initializeResourceGuideBrowser } from '../src/scripts/resource-guide-browser';
import { initializeCombatStyleDirectory } from '../src/scripts/combat-style-directory';
import { collectionDefinitions } from '../catalogue/src/collection-definitions';
import { navigationSettings } from '../catalogue/src/navigation-definitions';
import { sourceFingerprint } from '../src/lib/source-map-builder';
import { initializeSearch } from '../src/scripts/search';
import { initializeHub } from '../src/scripts/hub';

test('guide contributions live in the header and search lives in the navigation', () => {
  const { document } = page('slayer/blood-reavers/');
  assert.equal(document.querySelectorAll('[data-search]').length, 1);
  assert.ok(document.querySelector('.sidebar [data-search]'));
  assert.equal(document.querySelector('.site-header [data-search]'), null);
  assert.equal(document.querySelectorAll('[data-guide-actions]').length, 1);
  assert.ok(document.querySelector('.site-header [data-suggest-improvement]'));
  const menu = document.querySelector('.site-header .guide-edit-menu')!;
  assert.ok(menu.textContent?.includes('Edit (in place)'));
  const inlineEdit = menu.querySelector('button[data-inline-edit-path]')!;
  assert.ok(inlineEdit);
  assert.equal(inlineEdit.hasAttribute('disabled'), false);
  assert.ok(document.querySelector('[data-inline-editor]'));
  assert.ok(document.querySelector('[data-review-dialog]'));
  const external = menu.querySelector('a[data-guide-editor-external]')!;
  assert.match(external.getAttribute('href')!, /guide-editor/);
  assert.equal(external.getAttribute('target'), '_blank');
  for (const pencil of document.querySelectorAll('[data-guide-edit]')) {
    assert.equal(pencil.tagName, 'BUTTON');
    assert.equal(pencil.hasAttribute('href'), false);
    assert.match(pencil.getAttribute('aria-label')!, /in place$/);
  }
});

test('published guide sources match the exact revision rendered for editing', () => {
  const { guides, root } = getCatalogue();
  for (const guide of guides) {
    const source = JSON.parse(
      readFileSync(join('dist/guide-source', `${guide.path}.json`), 'utf8'),
    );
    assert.equal(source.path, guide.path);
    assert.equal(source.repo, 'pvme/pvme-guides');
    assert.equal(
      source.originalText,
      readFileSync(sourcePath(root, guide.path), 'utf8'),
    );
    const { document } = page(
      new URL(guide.href, 'https://pvme.test').pathname.replace(/^\//, ''),
    );
    const article = [
      ...document.querySelectorAll('[data-guide-source-hash]'),
    ].find(
      (article) => article.getAttribute('data-guide-source') === guide.path,
    );
    assert.ok(article, guide.path);
    assert.equal(
      article.getAttribute('data-guide-source-hash'),
      sourceFingerprint(source.originalText),
      guide.path,
    );
  }
});

test('standalone guide titles use readable casing without duplicating combat icons', () => {
  const guide = getCatalogue().guides.find((guide) =>
    guide.path.endsWith('/ability-information/necromancy-abilities.txt'),
  )!;
  const { document } = page(guide.href.replace(/^\//, ''));
  const title = document.querySelector('.guide-title-row h1')!;
  assert.equal(title.textContent?.trim(), 'Necromancy Abilities');
  assert.equal(title.querySelectorAll('img').length, 0);
  assert.ok(!document.querySelector('.guide-page-heading .eyebrow'));
  assert.ok(!document.querySelector('.guide-heading-copy > p'));
});

test('all pages use one of the three shared page layouts', () => {
  const layouts = new Set<string>();
  for (const file of walk('dist')) {
    const { document } = parseHTML(read(file));
    const roots = [...document.querySelectorAll('[data-page-layout]')];
    assert.equal(roots.length, 1, file);
    const layout = roots[0].getAttribute('data-page-layout')!;
    assert.ok(['home', 'directory', 'guide'].includes(layout), file);
    layouts.add(layout);
    if (layout === 'guide') {
      const heading = roots[0].querySelector(':scope > .guide-page-heading')!;
      assert.ok(heading, file);
      assert.equal(heading.querySelectorAll('h1').length, 1, file);
      assert.ok(!heading.querySelector('.eyebrow, p'), file);
    }
    if (layout === 'directory')
      assert.equal(
        roots[0].querySelectorAll(':scope > .page-heading h1').length,
        1,
        file,
      );
  }
  assert.deepEqual([...layouts].sort(), ['directory', 'guide', 'home']);
});

test('directory and guide layouts keep their dynamic navigation and editing controls', () => {
  for (const path of [
    'bosses/',
    'slayer/',
    'resources/',
    'tools/',
    'necromancy/',
    'resources/upgrade-orders/',
  ]) {
    const { document } = page(path);
    assert.equal(
      document
        .querySelector('[data-page-layout]')!
        .getAttribute('data-page-layout'),
      'directory',
      path,
    );
    assert.ok(document.querySelector('.sidebar [data-search]'), path);
  }
  for (const path of ['bosses/araxxor/', 'slayer/blood-reavers/']) {
    const { document } = page(path);
    assert.equal(
      document
        .querySelector('[data-page-layout]')!
        .getAttribute('data-page-layout'),
      'guide',
      path,
    );
    assert.ok(document.querySelector('[data-hub] .hub-tabs'), path);
    assert.ok(
      document.querySelector('.guide-title-row [data-guide-edit]'),
      path,
    );
    assert.ok(
      document.querySelector('.site-header [data-guide-actions]'),
      path,
    );
  }
  const { document } = page('');
  assert.equal(
    document
      .querySelector('[data-page-layout]')!
      .getAttribute('data-page-layout'),
    'home',
  );
  assert.ok(!document.querySelector('.sidebar'));
});

const read = (path: string) => readFileSync(path, 'utf8');
const page = (path: string) => parseHTML(read(`dist/${path}index.html`));
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith('.html')
        ? [resolve(dir, entry.name)]
        : [],
  );
const output = (pathname: string) => {
  const base = process.env.BASE_PATH?.replace(/\/$/, '');
  const path =
    base && pathname.startsWith(base + '/')
      ? pathname.slice(base.length)
      : pathname;
  return resolve(
    'dist',
    '.' + decodeURIComponent(path) + (path.endsWith('/') ? 'index.html' : ''),
  );
};

test('the production site and search index have working internal links and unique anchors', () => {
  assert.ok(
    existsSync('dist/index.html'),
    'Run npm run verify to build before testing',
  );
  const files = walk('dist');
  const pages = new Map(files.map((file) => [file, read(file)]));
  const anchors = new Map(
    [...pages].map(([file, html]) => {
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(
        (match) => match[1],
      );
      assert.equal(ids.length, new Set(ids).size, `Duplicate IDs in ${file}`);
      return [file, new Set(ids)];
    }),
  );
  const check = (href: string, source: string) => {
    const target = new URL(href.replace(/&amp;/g, '&'), source);
    if (target.origin !== 'https://local') return;
    const file = output(target.pathname);
    assert.ok(existsSync(file), `Missing target: ${href} from ${source}`);
    if (target.hash && anchors.has(file))
      assert.ok(
        anchors.get(file)!.has(decodeURIComponent(target.hash.slice(1))),
        `Missing anchor: ${href}`,
      );
  };
  for (const [file, html] of pages) {
    const source =
      'https://local/' +
      file
        .slice(resolve('dist').length + 1)
        .replace(/\\/g, '/')
        .replace(/index\.html$/, '');
    for (const [, href] of html.matchAll(/href="([^"<>]+)"/g))
      if (/^[/#?]/.test(href)) check(href, source);
  }
  const search = JSON.parse(read('dist/search-index.json')) as {
    href: string;
  }[];
  assert.ok(search.length);
  assert.equal(new Set(search.map((entry) => entry.href)).size, search.length);
  for (const entry of search) check(entry.href, 'https://local/');
  for (const reference of JSON.parse(read('dist/reference-index.json')) as {
    id: string;
    payload: string;
  }[]) {
    const payload = JSON.parse(
      read(output(new URL(reference.payload, 'https://local').pathname)),
    );
    assert.equal(payload.id, reference.id);
  }
  for (const path of [
    '',
    'bosses/',
    'slayer/',
    'resources/',
    'tools/',
    'necromancy/',
    'magic/',
    'ranged/',
    'melee/',
  ])
    assert.ok(existsSync(`dist/${path}index.html`), path);
});

test('collections retain their entries, configured card groups and guide ordering', () => {
  const catalogue = getCatalogue();
  for (const hub of [...catalogue.bosses, ...catalogue.slayer].filter(
    (hub) => !hub.isCollection,
  )) {
    for (const guide of hub.guides.filter(
      (guide) =>
        !guide.types.some((type) =>
          navigationSettings.routes.standaloneTypes.includes(type),
        ),
    )) {
      assert.ok(
        guide.href.startsWith(hub.href),
        `${guide.path}: expected encounter URL`,
      );
    }
  }
  for (const collection of websiteCollections(catalogue)) {
    const { document } = page(collection.href.slice(1));
    const links = [...document.querySelectorAll('a')].map((link) =>
      link.getAttribute('href'),
    );
    for (const entry of [...collection.members, ...collection.guides])
      assert.ok(
        links.some((link) => link?.endsWith(entry.href)),
        `${collection.href}: ${entry.href}`,
      );
  }
  const cards = [{ id: 'a' }, { id: 'b' }, { id: 'new' }];
  const groups = groupCollectionCards(cards, '/example/', [
    { parent: '/example/', label: 'Other', remaining: true },
    { parent: '/example/', label: 'Featured', cards: ['b'] },
  ]);
  assert.deepEqual(
    groups.map((group) => group.cards.map((card) => card.id)),
    [['b'], ['a', 'new']],
  );
  assert.equal(groups[1].heading, 'Other');
  for (const definition of collectionDefinitions.collections.filter(
    (definition) => definition.guideOrder?.length,
  )) {
    const collection = websiteCollections(catalogue).find(
      (collection) =>
        collection.id === definition.subjectId &&
        collection.parent.href === definition.parent,
    )!;
    const ordered = definition.guideOrder!.filter((path) =>
      collection.guides.some((guide) => guide.path === path),
    );
    assert.deepEqual(
      collection.guides.slice(0, ordered.length).map((guide) => guide.path),
      ordered,
    );
  }
});

test('guide formatting is retained and unsafe HTML and link protocols are blocked', () => {
  const { html } = renderGuide(
    '# Guide\n## Method\n.tag:method\n**Important**\n⬥ First\n    • Child\n⬥ Second\n[Unsafe](javascript:alert(1))\n<script>alert(1)</script>',
    { methods: [], sections: [] },
  );
  const { document } = parseHTML(html);
  assert.equal(document.querySelector('strong')?.textContent, 'Important');
  assert.ok(document.querySelector('ul li ul li'));
  assert.ok(document.getElementById('method'));
  assert.equal(document.querySelector('script'), null);
  assert.doesNotMatch(html, /(?:href|src)="javascript:/);
});

function browserFixture(path: string) {
  const { document, window } = page(path);
  let address = new URL(url(`/${path}`), 'https://local');
  const browser = {
    get location() {
      return address;
    },
    history: {
      replaceState(_state: unknown, _title: string, href: string) {
        address = new URL(href, address);
      },
    },
    addEventListener() {},
  } as unknown as Window;
  return { document, window, browser };
}

test('directory and global searches keep filters and display simple result labels', async () => {
  for (const path of ['bosses/', 'slayer/', 'resources/', 'tools/']) {
    const { document, window, browser } = browserFixture(path);
    const root = document.querySelector<HTMLElement>('[data-directory]')!;
    initializeDirectory(root, browser);
    initializeResourceGuideBrowser(root, browser);
    const entries = [...root.querySelectorAll<HTMLElement>('[data-entry]')];
    assert.ok(entries.length);
    const style = root.querySelector<HTMLElement>(
      '[data-dir-key="style"][data-value]:not([data-value=""])',
    );
    style?.dispatchEvent(new window.Event('click'));
    if (style)
      assert.ok(
        entries
          .filter((entry) => !entry.hidden)
          .every((entry) =>
            JSON.parse(entry.dataset.styles!).includes(style.dataset.value),
          ),
      );
    const first = entries.find((entry) => !entry.hidden)!;
    const query = root.querySelector<HTMLInputElement>(
      '[data-directory-query]',
    )!;
    query.value = first.dataset.terms!.split(/\s+/).find(Boolean)!;
    query.dispatchEvent(new window.Event('input'));
    assert.ok(entries.some((entry) => !entry.hidden));
    assert.ok(
      entries
        .filter((entry) => !entry.hidden)
        .every((entry) => entry.dataset.terms!.includes(query.value)),
    );
    query.value = '';
    query.dispatchEvent(new window.Event('input'));
    root
      .querySelector('[data-directory-reset]')!
      .dispatchEvent(new window.Event('click'));
    assert.ok(entries.every((entry) => !entry.hidden));
    if (path === 'slayer/') {
      const groups = [
        ...root.querySelectorAll<HTMLElement>('[data-directory-card-group]'),
      ];
      const pinned = collectionDefinitions.cardGroups.find(
        (group) => group.parent === '/slayer/' && group.cards,
      )!;
      assert.deepEqual(
        [...groups[0].querySelectorAll('a.entity-card')].map((card) =>
          card.getAttribute('href')!.split('/').filter(Boolean).at(-1),
        ),
        pinned.cards,
      );
      query.value = 'abyssal';
      query.dispatchEvent(new window.Event('input'));
      assert.ok(
        groups[0].querySelector<HTMLElement>('[data-directory-group-heading]')!
          .hidden,
      );
      assert.equal(
        groups[1].querySelector<HTMLElement>('[data-directory-group-heading]')!
          .hidden,
        true,
      );
      root
        .querySelector('[data-directory-reset]')!
        .dispatchEvent(new window.Event('click'));
      assert.ok(
        groups.every(
          (group) =>
            !group.querySelector<HTMLElement>('[data-directory-group-heading]')!
              .hidden,
        ),
      );
    }
  }
  const { document } = page('');
  const root = document.querySelector<HTMLElement>('[data-search]')!;
  const rows = JSON.parse(read('dist/search-index.json'));
  assert.ok(
    rows.every(
      (row: { category: string }) => !['Boss', 'Method'].includes(row.category),
    ),
  );
  const controller = initializeSearch(root, async () => rows);
  for (const row of rows) {
    const tab = new URL(row.href, 'https://local').searchParams.get('tab');
    const expected = [
      ...navigationSettings.bossTabs,
      ...navigationSettings.slayerTabs,
    ].find((item) => item.id === tab);
    if (expected)
      assert.equal(
        row.category,
        expected.id === 'slayer' ? 'Slayer' : expected.label,
      );
    if (
      new URL(row.href, 'https://local').pathname.startsWith(url('/bosses/')) &&
      row.section
    )
      assert.ok(
        !row.section.toLowerCase().includes(row.category.toLowerCase()),
      );
  }
  assert.equal(
    rows.find((row: { href: string }) =>
      row.href.endsWith('/bosses/god-wars-dungeon-3/'),
    ).category,
    'Collection',
  );
  root.querySelector('input')!.value = 'glacor';
  await controller.run();
  const results = [...root.querySelectorAll('.search-results a')];
  assert.ok(results.length);
  assert.ok(
    results.every(
      (row) =>
        row.querySelector('.search-result-title') &&
        row.querySelectorAll('.search-result-tags small').length === 1,
    ),
  );
  assert.ok(
    results.every((row) => !row.querySelector('.search-result-title img')),
  );
  const hybrid = rows.filter(
    (row: { title: string; styles?: string[] }) =>
      row.title === 'Arch Glacor' && row.styles?.includes('Melee'),
  );
  assert.ok(hybrid.length >= 2);
  assert.ok(
    hybrid.every(
      (row: { title: string; section?: string }) =>
        !/Melee|Mage|3000/.test(row.title + row.section),
    ),
  );
  assert.ok(
    results.some((row) =>
      /Arch Glacor - .*Melee/.test(
        row.querySelector('.search-result-title')!.textContent!,
      ),
    ),
  );
  assert.ok(
    results.every(
      (row) =>
        ![...row.querySelectorAll('.search-result-tags small')].some((pill) =>
          /^(?:Melee|Magic|Ranged|Necromancy)(?: \/ (?:Melee|Magic|Ranged|Necromancy))*$/.test(
            pill.textContent!,
          ),
        ),
    ),
  );
});

test('guide navigation preserves filters and opens the requested method section', () => {
  const { document, window, browser } = browserFixture('necromancy/');
  const root = document.querySelector<HTMLElement>(
    '[data-combat-style-directory]',
  )!;
  initializeCombatStyleDirectory(root, browser);
  const query = root.querySelector<HTMLInputElement>(
    '[data-style-directory-query]',
  )!;
  query.value = 'arch glacor';
  query.dispatchEvent(new window.Event('input'));
  root
    .querySelector('[data-style-directory-category="afk"]')!
    .dispatchEvent(new window.Event('click'));
  const rows = [
    ...root.querySelectorAll<HTMLElement>('[data-style-directory-entry]'),
  ].filter((row) => !row.hidden);
  assert.ok(rows.length);
  assert.ok(
    rows.every(
      (row) =>
        row.closest<HTMLElement>('[data-style-directory-group]')!.dataset
          .styleDirectoryGroup === 'afk',
    ),
  );
  assert.equal(new URL(browser.location.href).pathname, url('/necromancy/'));
  assert.equal(
    new URL(browser.location.href).searchParams.get('q'),
    'arch glacor',
  );
  const hub = getCatalogue().slayer.find(
    (hub) => hub.id === 'acheron-mammoths',
  )!;
  const guide = hub.guides[0];
  for (const method of [undefined, ...guide.methods]) {
    const { document } = page('slayer/acheron-mammoths/');
    let scrolled = '';
    for (const element of document.querySelectorAll<HTMLElement>('[id]'))
      element.scrollIntoView = () => {
        scrolled = element.id;
      };
    let address = new URL(url('/slayer/acheron-mammoths/'), 'https://local');
    for (const tab of document.querySelectorAll<HTMLElement>('[data-tab]'))
      tab.focus = () => {};
    const model = JSON.parse(
      document.querySelector('[data-hub-model]')!.textContent!,
    );
    const anchor = method
      ? model
          .find((entry: { id: string }) => entry.id === guide.id)
          .navigation.find((entry: { id: string }) => entry.id === method.id)
          .anchor
      : '';
    if (method) address.hash = anchor;
    initializeHub(document.querySelector<HTMLElement>('[data-hub]')!, {
      get location() {
        return address;
      },
      history: {
        pushState(_state: unknown, _title: string, href: string) {
          address = new URL(href, address);
        },
      },
      addEventListener() {},
      requestAnimationFrame(callback: FrameRequestCallback) {
        callback(0);
        return 0;
      },
    } as unknown as Window);
    if (method) {
      assert.equal(scrolled, anchor, method.label);
      const link = document.querySelector<HTMLAnchorElement>(
        `[data-choice="${guide.id}:${method.id}"]`,
      )!;
      assert.equal(link.tagName, 'A');
      assert.equal(link.getAttribute('href'), url(`${hub.href}#${anchor}`));
      assert.equal(link.getAttribute('aria-checked'), 'true');
    } else {
      assert.equal(
        scrolled,
        '',
        'Opening the page without a method must stay at the top',
      );
      assert.equal(
        document.querySelectorAll('[data-choice][aria-checked="true"]').length,
        0,
      );
      const link = document.querySelector<HTMLAnchorElement>(
        '[data-choice][href*="#"]',
      )!;
      link.dispatchEvent(
        new document.defaultView!.Event('click', { bubbles: true }),
      );
      assert.equal(decodeURIComponent(address.hash.slice(1)), scrolled);
      assert.equal(address.search, '');
      assert.equal(link.getAttribute('aria-checked'), 'true');
    }
  }
  const afk = page('bosses/arch-glacor/').document;
  let afkAddress = new URL(
    url('/bosses/arch-glacor/?tab=boss-afk'),
    'https://local',
  );
  let target = '';
  for (const element of afk.querySelectorAll<HTMLElement>('[id]'))
    element.scrollIntoView = () => {
      target = element.id;
    };
  for (const tab of afk.querySelectorAll<HTMLElement>('[data-tab]'))
    tab.focus = () => {};
  initializeHub(afk.querySelector<HTMLElement>('[data-hub]')!, {
    get location() {
      return afkAddress;
    },
    history: {
      pushState(_state: unknown, _title: string, href: string) {
        afkAddress = new URL(href, afkAddress);
      },
    },
    addEventListener() {},
    requestAnimationFrame(callback: FrameRequestCallback) {
      callback(0);
      return 0;
    },
  } as unknown as Window);
  const afkLinks = [
    ...afk.querySelectorAll<HTMLAnchorElement>(
      '[data-menu="boss-afk"] [data-choice]',
    ),
  ];
  assert.equal(afkLinks.length, 2);
  assert.equal(
    afk.querySelector('[data-tab="boss-afk"] .tab-style-icons'),
    null,
  );
  assert.equal(
    afk.querySelector('[data-menu="boss-afk"] .menu-style-icons'),
    null,
  );
  for (const link of afkLinks) {
    link.dispatchEvent(new afk.defaultView!.Event('click', { bubbles: true }));
    assert.equal(decodeURIComponent(afkAddress.hash.slice(1)), target);
    assert.equal(link.getAttribute('aria-checked'), 'true');
  }
  const single = page('bosses/rasial/').document;
  assert.equal(
    single
      .querySelector('[data-tab="boss-afk"]')
      ?.getAttribute('aria-haspopup'),
    'menu',
  );
  assert.ok(
    [
      ...page('bosses/kerapac/').document.querySelectorAll(
        '[data-menu="boss-afk"] [data-choice]',
      ),
    ].some((link) => !link.getAttribute('href')?.includes('#')),
  );
});

test('Discord title prefixes disappear from headings and navigation without changing ordinary quotes', () => {
  const source =
    '# > __Magic DPM Advice__\n## > Core Rotation\n### Settings > Interfaces\n> Ordinary quote';
  const rendered = renderGuide(
    source,
    { methods: [], sections: [] },
    '',
    {},
    { sourcePath: 'test.txt' },
  );
  const { document } = parseHTML(rendered.html);
  assert.deepEqual(
    [...document.querySelectorAll('h2,h3')].map((node) => node.textContent),
    ['Magic DPM Advice', 'Core Rotation', 'Settings > Interfaces'],
  );
  assert.deepEqual(
    rendered.toc.map((item) => item.text),
    ['Magic DPM Advice', 'Core Rotation', 'Settings > Interfaces'],
  );
  assert.equal(
    document.querySelector('blockquote')!.textContent,
    'Ordinary quote',
  );
  assert.equal(pageLinkTitle('> magic dpm advice'), 'Magic DPM Advice');
  assert.equal(pageLinkTitle('Settings > Interfaces'), 'Settings > Interfaces');
});

test('mobile search button expands search, closes navigation, and dismisses with Escape or outside click', () => {
  const { document, window } = parseHTML(
    '<html><body><div class="sidebar-navigation"><div class="sidebar-search"><button data-mobile-search-toggle aria-expanded="false">Search</button><div class="search compact" data-search><label><input><button data-search-clear hidden>Clear</button></label><div class="search-results" hidden></div></div></div><details class="mobile-nav" open><summary>Menu</summary></details></div><main>Content</main></body></html>',
  );
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true }),
  });
  const root = document.querySelector<HTMLElement>('[data-search]')!;
  initializeSearch(root, async () => []);
  const button = document.querySelector('[data-mobile-search-toggle]')!;
  const container = document.querySelector('.sidebar-search')!;
  button.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.ok(container.hasAttribute('data-mobile-search-open'));
  assert.equal(
    document.querySelector<HTMLDetailsElement>('.mobile-nav')!.open,
    false,
  );
  const escape = new window.Event('keydown', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(escape, { key: 'Escape' });
  root.querySelector('input')!.dispatchEvent(escape);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(container.hasAttribute('data-mobile-search-open'), false);
  button.dispatchEvent(new window.Event('click', { bubbles: true }));
  document
    .querySelector('main')!
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(container.hasAttribute('data-mobile-search-open'), false);
  const shortcut = new window.Event('keydown', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(shortcut, { key: 'k', ctrlKey: true });
  document.querySelector('main')!.dispatchEvent(shortcut);
  assert.ok(container.hasAttribute('data-mobile-search-open'));
});

test('mobile hub dropdowns open on tap and stay open when crossing wrapped rows', async (t) => {
  const { document, window } = page('bosses/amascut/');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false }),
  });
  t.after(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });
  let address = new URL(url('/bosses/amascut/'), 'https://local');
  initializeHub(document.querySelector<HTMLElement>('[data-hub]')!, {
    get location() {
      return address;
    },
    history: {
      pushState(_state: unknown, _title: string, href: string) {
        address = new URL(href, address);
      },
    },
    addEventListener() {},
    requestAnimationFrame() {
      return 0;
    },
  } as unknown as Window);
  const tab = document.querySelector<HTMLElement>('[data-tab][aria-haspopup]')!;
  const item = tab.closest('.hub-tab-item')!;
  const menu = document.querySelector<HTMLElement>(
    `[data-menu="${tab.dataset.tab}"]`,
  )!;
  const pointer = (type: string) => {
    const event = new window.Event(type);
    Object.assign(event, { pointerType: 'mouse' });
    item.dispatchEvent(event);
  };
  pointer('pointerenter');
  assert.equal(menu.hidden, true);
  tab.dispatchEvent(
    new window.Event('click', { bubbles: true, cancelable: true }),
  );
  assert.equal(menu.hidden, false);
  assert.equal(tab.getAttribute('aria-expanded'), 'true');
  pointer('pointerleave');
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(menu.hidden, false);
  const choice = menu.querySelector<HTMLElement>('[data-choice]')!;
  choice.dispatchEvent(
    new window.Event('click', { bubbles: true, cancelable: true }),
  );
  assert.equal(menu.hidden, true);
  assert.equal(tab.getAttribute('aria-expanded'), 'false');
  assert.equal(choice.getAttribute('aria-checked'), 'true');
});

test('clicking a hover-opened desktop hub dropdown pins it open until dismissed', async (t) => {
  const { document, window } = page('bosses/amascut/');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true }),
  });
  t.after(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });
  const address = new URL(url('/bosses/amascut/'), 'https://local');
  initializeHub(document.querySelector<HTMLElement>('[data-hub]')!, {
    location: address,
    history: { pushState() {} },
    addEventListener() {},
    requestAnimationFrame() {
      return 0;
    },
  } as unknown as Window);
  const tab = document.querySelector<HTMLElement>('[data-tab][aria-haspopup]')!;
  const item = tab.closest('.hub-tab-item')!;
  const menu = document.querySelector<HTMLElement>(
    `[data-menu="${tab.dataset.tab}"]`,
  )!;
  const pointer = (type: string) => {
    const event = new window.Event(type);
    Object.assign(event, { pointerType: 'mouse' });
    item.dispatchEvent(event);
  };
  pointer('pointerenter');
  assert.equal(menu.hidden, false);
  pointer('pointerleave');
  tab.dispatchEvent(
    new window.Event('click', { bubbles: true, cancelable: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(menu.hidden, false);
  tab.dispatchEvent(
    new window.Event('click', { bubbles: true, cancelable: true }),
  );
  assert.equal(menu.hidden, true);
});
