import test from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSourceUrl,
  linkDisplayUrl,
  pvmeChannelId,
  pvmeChannelUrl,
} from '../src/lib/link-destination';

test('website links map to channels only for this website and exact destinations', () => {
  const page = {
    title: 'Upgrade Order',
    href: '/resources/upgrade-orders/',
    url: 'https://pvme.github.io/resources/upgrade-orders/',
    sourceUrl: pvmeChannelUrl('1020045708746833930'),
  };
  const local = 'http://127.0.0.1:4321/bosses/amascut/';
  assert.equal(
    linkDisplayUrl(page.sourceUrl, [page], local),
    'http://127.0.0.1:4321/resources/upgrade-orders/',
  );
  assert.equal(
    linkSourceUrl(
      'http://127.0.0.1:4321/resources/upgrade-orders/',
      [page],
      local,
    ),
    page.sourceUrl,
  );
  assert.equal(linkSourceUrl(page.url, [page], local), page.sourceUrl);
  for (const value of [
    'https://example.com/resources/upgrade-orders/',
    `${page.url}#section`,
    `${page.url}?tab=other`,
  ])
    assert.equal(linkSourceUrl(value, [page], local), value);
  assert.throws(() => linkSourceUrl('javascript:alert(1)', [page], local));
});

test('only plain PvME Discord channel URLs become channel references', () => {
  assert.equal(
    pvmeChannelId(pvmeChannelUrl('1020045708746833930')),
    '1020045708746833930',
  );
  for (const value of [
    'https://discord.com/channels/123456789/1020045708746833930',
    `${pvmeChannelUrl('1020045708746833930')}/123456789012345678`,
    `${pvmeChannelUrl('1020045708746833930')}#section`,
    'https://example.com/channels/534508796639182860/1020045708746833930',
  ])
    assert.equal(pvmeChannelId(value), undefined);
});
