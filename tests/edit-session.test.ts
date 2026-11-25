import test from 'node:test';
import assert from 'node:assert/strict';
import { EditSession, readSourceMap } from '../src/lib/edit-session';
import { DraftStorage } from '../src/lib/draft-storage';
import {
  mappedSource as source,
  renderMappedGuide as render,
  loadMappedGuide as loaded,
  createMappedSession as create,
  findEntry as entry,
  MemoryStore,
} from './helpers';

test('sessions require matching source, identity, supported maps and original parser ranges', async () => {
  const session = await create();
  assert.equal(session.originalContent, source);
  await assert.rejects(
    EditSession.create(session.map, loaded(source + ' ')),
    /older source/,
  );
  await assert.rejects(
    EditSession.create(session.map, loaded(source, 'other.txt')),
    /identity/,
  );
  for (const change of [
    (map: any) => {
      map.schemaVersion = 2;
    },
    (map: any) => {
      map.entries[0].kind = 'embed';
    },
    (map: any) => {
      map.entries[0].value = 'forged';
    },
    (map: any) => {
      map.entries[0].range.start.column = 999;
    },
    (map: any) => {
      map.entries.push(map.entries[0]);
    },
  ]) {
    const map = structuredClone(session.map);
    change(map);
    await assert.rejects(EditSession.create(map, loaded()));
  }
  assert.throws(() => readSourceMap({}));
});

test('text, nested lists/formatting, labels and URLs are applied together against immutable offsets', async () => {
  const session = await create();
  const edits = [
    { entryId: entry(session, 'old').id, replacement: 'longer text' },
    { entryId: entry(session, 'inside').id, replacement: 'x' },
    { entryId: entry(session, 'child').id, replacement: 'nested child' },
    {
      entryId: entry(session, 'old label', 'link-label').id,
      replacement: 'new label',
    },
    {
      entryId: entry(session, 'https://example.com/a_(b)', 'link-url').id,
      replacement: 'https://new.example/path_(long)',
    },
    {
      entryId: entry(session, 'https://example.com/bare', 'link-url').id,
      replacement: 'https://new.example/bare',
    },
  ];
  session.setChanges(edits);
  assert.equal(session.count, 6);
  assert.equal(session.originalContent, source);
  assert.equal(
    session.content(),
    source
      .replace('**old**', '**longer text**')
      .replace('*inside*', '*x*')
      .replace('• child', '• nested child')
      .replace('[old label]', '[new label]')
      .replace('https://example.com/a_(b)', 'https://new.example/path_(long)')
      .replace('https://example.com/bare', 'https://new.example/bare'),
  );
  assert.match(session.content(), /<:magic:123>/);
  assert.match(session.content(), /"keep"/);
  assert.match(session.content(), /\$linkmsg_missing\$/);
  assert.ok(
    session.diagnostics().length > 0,
    'Unrelated missing-reference diagnostic is allowed',
  );
});

test('re-edit, restore, undo, discard and invalid batches preserve prior valid changes', async () => {
  const session = await create(),
    old = entry(session, 'old'),
    child = entry(session, 'child');
  session.setChanges([{ entryId: old.id, replacement: 'first' }]);
  session.setChanges([{ entryId: old.id, replacement: 'second' }]);
  assert.equal(session.count, 1);
  assert.match(session.content(), /second/);
  const previous = session.content();
  for (const changes of [
    [{ entryId: child.id, replacement: 'bad\n.tag:injection' }],
    [{ entryId: 'unknown', replacement: 'bad' }],
    [
      { entryId: child.id, replacement: 'one' },
      { entryId: child.id, replacement: 'two' },
    ],
    [
      {
        entryId: entry(session, 'https://example.com/bare', 'link-url').id,
        replacement: 'javascript:alert(1)',
      },
    ],
  ]) {
    assert.throws(() => session.setChanges(changes));
    assert.equal(session.content(), previous);
  }
  session.setChanges([{ entryId: old.id, replacement: old.value }]);
  assert.equal(session.count, 0);
  session.setChanges([
    { entryId: old.id, replacement: 'changed' },
    { entryId: child.id, replacement: 'changed child' },
  ]);
  session.undo(old.id);
  assert.equal(session.count, 1);
  assert.match(session.content(), /\*\*old\*\*/);
  session.discard();
  assert.equal(session.content(), source);
});

test('overlapping source-map targets are rejected before a session starts', async () => {
  const rendered = render('[label](https://example.com)');
  const map = rendered.sourceMap!;
  const label = map.entries.find((entry) => entry.kind === 'link-label')!;
  map.entries.push({
    ...label,
    kind: 'text',
    id: `text-${label.range.start.offset}-${label.range.end.offset}`,
  });
  await assert.rejects(
    EditSession.create(map, loaded('[label](https://example.com)')),
  );
});

test('draft persistence stores minimum data and validates complete restoration', async () => {
  const store = new MemoryStore(),
    drafts = new DraftStorage(store, 'contributor-a'),
    session = await create();
  session.setChanges([
    { entryId: entry(session, 'old').id, replacement: 'new' },
  ]);
  assert.equal(drafts.save(session), undefined);
  const serialized = store.getItem(drafts.key(session.path))!;
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
    'edits',
    'path',
    'schemaVersion',
    'sourceHash',
    'updatedAt',
  ]);
  assert.doesNotMatch(
    serialized,
    /originalContent|originalText|csrf|token|cookie/,
  );
  const next = await create();
  assert.equal(drafts.restore(next).status, 'restored');
  assert.equal(next.content(), session.content());
  assert.notEqual(
    drafts.key(session.path),
    new DraftStorage(store, 'contributor-b').key(session.path),
  );
  next.discard();
  drafts.save(next);
  assert.equal(store.getItem(drafts.key(session.path)), null);
});

test('stale, malformed and unsupported drafts stay available for deliberate recovery', async () => {
  const store = new MemoryStore(),
    drafts = new DraftStorage(store),
    session = await create();
  for (const raw of [
    '{broken',
    JSON.stringify({ schemaVersion: 2 }),
    JSON.stringify({
      schemaVersion: 1,
      path: session.path,
      sourceHash: 'old',
      edits: [],
      updatedAt: new Date().toISOString(),
    }),
    JSON.stringify({
      schemaVersion: 1,
      path: session.path,
      sourceHash: session.sourceHash,
      edits: [
        { entryId: entry(session, 'old').id, replacement: 'valid' },
        { entryId: 'unknown', replacement: 'invalid' },
      ],
      updatedAt: new Date().toISOString(),
    }),
  ]) {
    store.setItem(drafts.key(session.path), raw);
    const result = drafts.restore(session);
    assert.equal(result.status, 'blocked');
    assert.equal(result.status === 'blocked' && result.raw, raw);
    assert.equal(session.count, 0);
    assert.equal(store.getItem(drafts.key(session.path)), raw);
  }
  drafts.discard(session.path);
  assert.equal(drafts.restore(session).status, 'empty');
});

test('unavailable/full storage preserves the in-memory session', async () => {
  const session = await create();
  session.setChanges([
    { entryId: entry(session, 'old').id, replacement: 'new' },
  ]);
  const drafts = new DraftStorage({
    getItem() {
      throw Error('denied');
    },
    setItem() {
      throw Error('full');
    },
    removeItem() {
      throw Error('denied');
    },
  });
  assert.equal(drafts.restore(session).status, 'unavailable');
  assert.match(drafts.save(session)!, /remain in this tab/);
  assert.equal(session.count, 1);
  assert.match(session.content(), /new/);
});

test('submission preparation retains backend metadata and rejects empty, stale and undescribed drafts', async () => {
  const session = await create(),
    description = { title: 'Correct guide', notes: 'Correct a typo' };
  await assert.rejects(
    session.prepareUpdate(description, loaded()),
    /No pending/,
  );
  session.setChanges([
    { entryId: entry(session, 'old').id, replacement: 'new' },
  ]);
  await assert.rejects(
    session.prepareUpdate({ ...description, notes: ' ' }, loaded()),
    /reason/,
  );
  await assert.rejects(
    session.prepareUpdate(description, loaded(source + ' ')),
    /changed/,
  );
  const payload = await session.prepareUpdate(description, loaded());
  assert.deepEqual(payload, {
    type: 'update',
    repo: 'pvme/pvme-guides',
    baseBranch: 'master',
    path: session.path,
    originalContent: source,
    content: session.content(),
    ...description,
    source: 'master',
    branch: 'master',
    existingReviewBranch: '',
    replaceExistingReview: false,
  });
  const review = {
    ...loaded(),
    source: 'user-pr' as const,
    branch: 'review/my-guide',
    existingReviewBranch: 'review/my-guide',
    prUrl: 'https://example.com/review',
  };
  const reviewSession = await EditSession.create(render().sourceMap, review);
  reviewSession.setChanges([
    { entryId: entry(reviewSession, 'old').id, replacement: 'new' },
  ]);
  const prepared = await reviewSession.prepareUpdate(description, review);
  assert.equal(prepared.source, 'user-pr');
  assert.equal(prepared.branch, review.branch);
  assert.equal(prepared.existingReviewBranch, review.branch);
  assert.equal(prepared.replaceExistingReview, false);
  await assert.rejects(
    reviewSession.prepareUpdate(description, {
      ...review,
      existingReviewBranch: 'other',
    }),
  );
});
