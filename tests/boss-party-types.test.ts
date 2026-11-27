import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { attributes, canonicalAttribute } from '../catalogue/src/rules';
import { getCatalogue, type Hub } from '../src/lib/catalogue';
import { websiteCollections, withCollectionHubs } from '../src/lib/collections';
import {
  bossDirectoryAttributes,
  bossPartyTypes,
  parseBossPartyTypes,
} from '../src/lib/boss-party-types';

test('boss party configuration accepts unassigned, solo, group and both only', () => {
  assert.deepEqual(
    parseBossPartyTypes({ a: null, b: 'solo', c: 'group', d: 'both' }),
    { a: null, b: 'solo', c: 'group', d: 'both' },
  );
  for (const value of ['duo', '', [], ['solo', 'group'], 2, undefined]) {
    assert.throws(() => parseBossPartyTypes({ a: value }));
  }
  assert.throws(() => parseBossPartyTypes({ 'Invalid slug': 'solo' }));
});

test('boss filters use JSON independently of guide attributes and preserve effort', () => {
  const hub = {
    slug: 'example',
    guides: [
      { attributes: ['Solo', 'Group', 'Duo', 'Trio', 'AFK / Low Effort'] },
    ],
  } as Hub;
  const effort = ['AFK / Low Effort'];
  assert.deepEqual(bossDirectoryAttributes(hub, {}), effort);
  assert.deepEqual(bossDirectoryAttributes(hub, { example: null }), effort);
  assert.deepEqual(bossDirectoryAttributes(hub, { example: 'solo' }), [
    ...effort,
    'Solo',
  ]);
  assert.deepEqual(bossDirectoryAttributes(hub, { example: 'group' }), [
    ...effort,
    'Group',
  ]);
  assert.deepEqual(bossDirectoryAttributes(hub, { example: 'both' }), [
    ...effort,
    'Solo',
    'Group',
  ]);
});

test('catalogue no longer infers or normalises party classifications', () => {
  assert.deepEqual(
    attributes('Solo duos trio quad group small teams 7s 10 players'),
    [],
  );
  assert.equal(canonicalAttribute('duo'), 'duo');
  assert.deepEqual(
    attributes('Solo AFK Hard Mode').map((finding) => finding.value),
    ['AFK / Low Effort', 'Hard Mode'],
  );
});

test('JSON lists every boss card and built cards use its classifications', () => {
  const catalogue = getCatalogue();
  const bosses = withCollectionHubs(
    catalogue.bosses,
    websiteCollections(catalogue),
    '/bosses/',
  );
  assert.deepEqual(
    Object.keys(bossPartyTypes).sort(),
    bosses.map((boss) => boss.slug).sort(),
    'Add new boss slugs to catalogue/boss-party-types.json (null is allowed).',
  );
  const { document } = parseHTML(
    readFileSync('dist/bosses/index.html', 'utf8'),
  );
  const cards = [...document.querySelectorAll('[data-entry]')];
  assert.equal(cards.length, bosses.length);
  for (const boss of bosses) {
    const card = cards.find((card) =>
      card
        .querySelector('a.entity-card')
        ?.getAttribute('href')
        ?.endsWith(boss.href),
    );
    assert.ok(card, boss.slug);
    assert.deepEqual(
      JSON.parse(card.getAttribute('data-attributes')!),
      bossDirectoryAttributes(boss),
    );
  }
});
