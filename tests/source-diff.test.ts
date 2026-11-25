import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceDiff,
  displayDiffLine,
  sourceDiffChanges,
  highlightSourceDiff,
} from '../src/lib/source-diff';

const changed = (before: string, after: string, kind: 'remove' | 'add') =>
  highlightSourceDiff(sourceDiff(before, after))
    .filter((line) => line.kind === kind)
    .flatMap((line) => line.parts || [])
    .filter((part) => part.changed)
    .map((part) => part.text)
    .join('');

test('review highlights only changed characters within a line and retains separated edits', () => {
  const before = 'Cooldown: 3t; cost: 20%.\r\n';
  const after = 'Cooldown: 6t; cost: 25%.\r\n';
  assert.equal(changed(before, after, 'remove'), '30');
  assert.equal(changed(before, after, 'add'), '65');
  for (const line of highlightSourceDiff(sourceDiff(before, after)))
    assert.equal(line.parts?.map((part) => part.text).join(''), line.text);
});

test('intraline alignment handles inserted rows without pairing them with the wrong original row', () => {
  const before = 'Alpha: 3\nBeta: 9\n';
  const after = 'New introduction\nAlpha: 6\nBeta: 8\n';
  const diff = highlightSourceDiff(sourceDiff(before, after));
  assert.equal(changed(before, after, 'remove'), '39');
  assert.equal(changed(before, after, 'add'), 'New introduction\n68');
  assert.equal(
    diff
      .filter((line) => line.kind !== 'add')
      .map((line) => line.text)
      .join(''),
    before,
  );
  assert.equal(
    diff
      .filter((line) => line.kind !== 'remove')
      .map((line) => line.text)
      .join(''),
    after,
  );
});

test('new and deleted lines are fully highlighted, Unicode stays intact, and long JSON lines stay precise', () => {
  assert.equal(changed('', 'New line\n', 'add'), 'New line\n');
  assert.equal(changed('Removed\n', '', 'remove'), 'Removed\n');
  assert.equal(changed('Keep 😀 here', 'Keep 😁 here', 'remove'), '😀');
  assert.equal(changed('Keep 😀 here', 'Keep 😁 here', 'add'), '😁');
  const prefix = '{"description":"' + 'unchanged '.repeat(5000);
  assert.equal(changed(prefix + '3t"}', prefix + '6t"}', 'add'), '6');
  const before = 'a'.repeat(25000),
    after = 'z'.repeat(25000);
  assert.equal(changed(before, after, 'add'), after);
});

test('discard ranges preserve independent insertions, deletions and exact line endings', () => {
  for (const [before, after] of [
    ['First\r\nSame\r\nLast', 'First updated\r\nSame\r\nLast updated'],
    ['Same\nLast\n', 'Added\nSame\nLast updated\n'],
    ['Removed\nSame\nLast\n', 'Same\nLast updated\n'],
    ['First 🦀\rSame\rLast', 'First 💀\rSame\rLast updated'],
  ]) {
    let draft = after;
    assert.equal(sourceDiffChanges(before, draft).length, 2);
    while (draft !== before) {
      const [change] = sourceDiffChanges(before, draft);
      assert.ok(change);
      draft =
        draft.slice(0, change.start) +
        change.original +
        draft.slice(change.end);
    }
    assert.equal(draft, before);
  }
});

test('individual edit ranges pair old and new text without reverting neighbouring changes', () => {
  const before = 'Cooldown: 3t; cost: 20%.\r\nKeep 😀 here\r\n';
  const after = 'Cooldown: 6t; cost: 25%.\r\nKeep 😁 here\r\n';
  const edits: import('../src/lib/source-diff').SourceEdit[] = [];
  const diff = highlightSourceDiff(sourceDiff(before, after), edits);
  assert.equal(edits.length, 3);
  assert.deepEqual(
    edits.map((edit) => [edit.original, after.slice(edit.start, edit.end)]),
    [
      ['3', '6'],
      ['0', '5'],
      ['😀', '😁'],
    ],
  );
  const cost = edits[1];
  assert.equal(
    after.slice(0, cost.start) + cost.original + after.slice(cost.end),
    'Cooldown: 6t; cost: 20%.\r\nKeep 😁 here\r\n',
  );
  for (const line of diff)
    for (const part of line.parts || []) {
      if (part.changed) assert.ok(edits[part.editIndex!]);
    }
});

test('granular insertion and deletion ranges reconstruct exact source in reverse order', () => {
  for (const [before, after] of [
    ['Alpha beta gamma', 'Alpha new beta gamma extra'],
    ['Alpha removed beta gone gamma', 'Alpha beta gamma'],
    ['First\r\nLast', 'First updated\r\nNew row\r\nLast!'],
    [
      '{ "title": "old", "url": "https://old.example" }',
      '{ "title": "new", "url": "https://new.example" }',
    ],
  ]) {
    const edits: import('../src/lib/source-diff').SourceEdit[] = [];
    highlightSourceDiff(sourceDiff(before, after), edits);
    let draft = after;
    for (const edit of edits.reverse())
      draft =
        draft.slice(0, edit.start) + edit.original + draft.slice(edit.end);
    assert.equal(draft, before);
  }
});

test('source diffs reconstruct exact snapshots including whitespace and line endings', () => {
  const examples = [
    ['a\r\nb\nend', 'a\r\nlong\nend\n'],
    ['', 'added'],
    ['removed\r', ''],
    ['same\n', 'same\n'],
    ['a\nb\nc\n', 'x\nb\ny\n'],
    [' \t\n', '\t \r\n'],
  ];
  let random = 12345;
  const line = () => {
    random = (random * 16807) % 2147483647;
    return ['a\n', 'b\r\n', '\t\n', 'last'][random % 4];
  };
  for (let n = 0; n < 150; n++)
    examples.push([
      Array.from({ length: n % 11 }, line).join(''),
      Array.from({ length: n % 7 }, line).join(''),
    ]);
  for (const [before, after] of examples) {
    const diff = sourceDiff(before, after);
    assert.equal(
      diff
        .filter((line) => line.kind !== 'add')
        .map((line) => line.text)
        .join(''),
      before,
    );
    assert.equal(
      diff
        .filter((line) => line.kind !== 'remove')
        .map((line) => line.text)
        .join(''),
      after,
    );
  }
  const diff = sourceDiff('a\r\nb\n', 'a\r\nc\n');
  assert.deepEqual(
    diff.map((line) => line.kind),
    ['context', 'remove', 'add'],
  );
  assert.equal(displayDiffLine(diff[0]), '  a');
  assert.match(displayDiffLine(diff[0], true), /CRLF/);
  assert.equal(displayDiffLine({ kind: 'add', text: 'last' }), '+ last');
  assert.match(
    displayDiffLine({ kind: 'add', text: 'last' }, true),
    /no newline/,
  );
});
