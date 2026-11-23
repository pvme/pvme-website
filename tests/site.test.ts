import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { getCatalogue, url } from '../src/lib/catalogue';
import { renderGuide } from '../src/lib/renderer';
import { websiteCollections } from '../src/lib/collections';
import { groupCollectionCards } from '../src/lib/collection-cards';
import { initializeDirectory } from '../src/scripts/directory';
import { initializeResourceGuideBrowser } from '../src/scripts/resource-guide-browser';
import { initializeCombatStyleDirectory } from '../src/scripts/combat-style-directory';
import { collectionDefinitions } from '../catalogue/src/collection-definitions';
import { navigationSettings } from '../catalogue/src/navigation-definitions';
import { initializeSearch } from '../src/scripts/search';
import { initializeHub } from '../src/scripts/hub';

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
