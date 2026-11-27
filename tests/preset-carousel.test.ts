import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { parseGuide } from '@pvme/guide-parser';
import { analysePresets } from '../src/lib/preset-entries';
import { renderGuide } from '../src/lib/renderer';
import { getCatalogue } from '../src/lib/catalogue';
import { sourceFingerprint } from '../src/lib/source-map-builder';
import { initializePresetCarousel } from '../src/scripts/preset-carousel';

const urls = ['first', 'second', 'third', 'fourth'].map(
  (id) => `https://presets.pvme.io/?id=${id}`,
);
function render(source: string) {
  const destinations = [...analysePresets(parseGuide(source)).urls];
  const previews = Object.fromEntries(
    destinations.map((url, i) => [
      url,
      {
        checkedAt: 1,
        path: `/preset-previews/test-${i}.png`,
      },
    ]),
  );
  const result = renderGuide(
    source,
    { methods: [], sections: [] },
    '',
    previews,
    { sourcePath: 'test/presets.txt' },
  );
  const { document, window } = parseHTML(`<article>${result.html}</article>`);
  assert.equal(result.sourceMap!.sourceHash, sourceFingerprint(source));
  const refs = [
    ...document.querySelectorAll('[data-edit-ref],[data-edit-url]'),
  ].flatMap((element) =>
    [
      element.getAttribute('data-edit-ref'),
      element.getAttribute('data-edit-url'),
    ].filter(Boolean),
  );
  assert.equal(new Set(refs).size, refs.length);
  assert.deepEqual(
    refs.sort(),
    result.sourceMap!.entries.map((entry) => entry.id).sort(),
  );
  assert.ok(
    !document.querySelector(
      '.preset-preview-card [data-edit-ref],.preset-preview-card[data-edit-url]',
    ),
  );
  return { document, window, result };
}

for (const [path, expected] of [
  ['basic-guides/chaos-elemental-basic.txt', 2],
  ['afk/afk-chaos-elemental.txt', 4],
] as const)
  test(`${path}: all preset choices share a slider across Discord message breaks`, () => {
    const source = readFileSync(join(getCatalogue().root, path), 'utf8');
    const { document } = render(source);
    const carousels = [
      ...document.querySelectorAll(
        '[data-preset-carousel][aria-label="Equipment presets"]',
      ),
    ];
    assert.equal(carousels.length, 1);
    const cards = [
      ...carousels[0].querySelectorAll<HTMLAnchorElement>(
        '.preset-preview-card',
      ),
    ];
    assert.equal(cards.length, expected);
    assert.deepEqual(
      cards.map((card) => card.getAttribute('href')),
      [...analysePresets(parseGuide(source)).urls],
    );
    assert.match(cards.at(-1)!.textContent!, /Necromancy/i);
    assert.ok(
      ![
        ...document.querySelectorAll<HTMLAnchorElement>('.preset-preview-card'),
      ].some(
        (card) =>
          card.href.startsWith('https://presets.pvme.io') &&
          !card.closest('[data-preset-carousel]'),
      ),
    );
    for (const anchor of Object.values(parseGuide(source).tags))
      assert.ok(document.getElementById(anchor.tag));
  });

test('paragraph presets retain labels and controls navigate every cross-message choice', () => {
  const source = `## __Equipment__\n[First preset](<${urls[0]}>)\n.tag:first\n.\n\n.\n[Second preset](${urls[1]})\n.tag:second`;
  const { document, window } = render(source);
  const carousel = document.querySelector<HTMLElement>(
    '[data-preset-carousel]',
  )!;
  assert.ok(carousel);
  assert.equal(carousel.querySelectorAll('[data-preset-slide]').length, 2);
  assert.deepEqual(
    [...carousel.querySelectorAll('.preset-preview-label')].map(
      (label) => label.textContent,
    ),
    ['First preset', 'Second preset'],
  );
  assert.ok(document.getElementById('first'));
  assert.ok(document.getElementById('second'));
  const track = carousel.querySelector<HTMLElement>('[data-preset-track]')!;
  Object.defineProperty(track, 'clientWidth', { value: 400 });
  track.scrollTo = (options) => {
    if (typeof options === 'object') track.scrollLeft = options.left || 0;
  };
  initializePresetCarousel(carousel);
  carousel.querySelector<HTMLButtonElement>('[data-preset-next]')!.click();
  assert.equal(
    carousel.querySelector('[data-preset-count]')!.textContent,
    '2 / 2',
  );
  assert.equal(track.scrollLeft, 400);
  assert.equal(
    carousel.querySelector<HTMLButtonElement>('[data-preset-next]')!.disabled,
    true,
  );
  const first = carousel
    .closest('[data-media-switcher-group]')!
    .querySelector<HTMLAnchorElement>('p a')!;
  first.dispatchEvent(
    new window.Event('click', { bubbles: true, cancelable: true }),
  );
  assert.equal(
    carousel.querySelector('[data-preset-count]')!.textContent,
    '1 / 2',
  );
});

for (const boundary of [
  '.\n## __Other equipment__',
  '.\nNotes about these presets.',
  '.\n⬥ An explanation without a preset.',
])
  test(`preset sliders stop at ${JSON.stringify(boundary)}`, () => {
    const source = `## __Equipment__\n⬥ [First preset](${urls[0]})\n.\n⬥ [Second preset](${urls[1]})\n${boundary}\n.\n⬥ [Third preset](${urls[2]})\n.\n⬥ [Fourth preset](${urls[3]})`;
    const { document } = render(source);
    const groups = [...document.querySelectorAll('[data-preset-carousel]')];
    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups.map((group) =>
        [
          ...group.querySelectorAll<HTMLAnchorElement>('.preset-preview-card'),
        ].map((card) => card.getAttribute('href')),
      ),
      [urls.slice(0, 2), urls.slice(2)],
    );
  });

test('a new heading inside the starting message prevents grouping across sections', () => {
  const source = `## __Equipment__\n⬥ [First preset](${urls[0]})\n### Other equipment\n⬥ [Second preset](${urls[1]})\n.\n⬥ [Third preset](${urls[2]})`;
  const { document } = render(source);
  assert.equal(document.querySelectorAll('[data-preset-carousel]').length, 0);
  assert.equal(document.querySelectorAll('.preset-preview-card').length, 3);
});
