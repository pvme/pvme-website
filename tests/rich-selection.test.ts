import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lineMarks,
  normalizeRichLine,
  type RichLine,
} from '../src/lib/source-lines';
import {
  selectionMarkState,
  selectionTokenIds,
  toggleSelectionMark,
} from '../src/lib/rich-selection';

test('link selection targets chips at the caret and respects text, Unicode and row boundaries', () => {
  const model: RichLine = [
    [
      { type: 'text', text: '🚀 ', marks: [] },
      { type: 'token', id: 'first', marks: ['bold'] },
      { type: 'token', id: 'second', marks: [] },
      { type: 'text', text: ' end', marks: [] },
    ],
    [{ type: 'token', id: 'third', marks: [] }],
  ];
  assert.deepEqual(selectionTokenIds(model, 3, 3), ['first']);
  assert.deepEqual(selectionTokenIds(model, 4, 4), ['second']);
  assert.deepEqual(selectionTokenIds(model, 5, 5), ['second']);
  assert.deepEqual(selectionTokenIds(model, 1, 1), []);
  assert.deepEqual(selectionTokenIds(model, 6, 8), []);
  assert.deepEqual(selectionTokenIds(model, 3, 5), ['first', 'second']);
  assert.deepEqual(selectionTokenIds(model, 10, 10), ['third']);
});

for (const mark of lineMarks)
  test(`${mark} toggles on and off without changing the selection or other marks`, () => {
    const original: RichLine = [
      [{ type: 'text', text: 'before selected after', marks: [] }],
    ];
    const on = toggleSelectionMark(original, 7, 15, mark);
    assert.equal(selectionMarkState(on, 7, 15, mark), 'true');
    assert.deepEqual(toggleSelectionMark(on, 7, 15, mark), original);
    assert.deepEqual(
      original,
      [[{ type: 'text', text: 'before selected after', marks: [] }]],
      'The source model is immutable',
    );
  });

test('unformatted selection-edge spaces do not prevent turning bold off', () => {
  const original: RichLine = [
    [
      { type: 'text', text: ' ', marks: [] },
      { type: 'text', text: 'selected', marks: ['bold', 'underline'] },
      { type: 'text', text: ' ', marks: [] },
    ],
  ];
  assert.equal(selectionMarkState(original, 0, 10, 'bold'), 'true');
  const off = toggleSelectionMark(original, 0, 10, 'bold');
  assert.equal(selectionMarkState(off, 0, 10, 'bold'), 'false');
  assert.equal(selectionMarkState(off, 0, 10, 'underline'), 'true');
});

test('mixed formatting toggles the entire selection on before toggling off', () => {
  const original: RichLine = [
    [
      { type: 'text', text: 'one', marks: ['bold'] },
      { type: 'text', text: ' two', marks: [] },
    ],
  ];
  assert.equal(selectionMarkState(original, 0, 7, 'bold'), 'mixed');
  const on = toggleSelectionMark(original, 0, 7, 'bold');
  assert.equal(selectionMarkState(on, 0, 7, 'bold'), 'true');
  assert.deepEqual(toggleSelectionMark(on, 0, 7, 'bold'), [
    [{ type: 'text', text: 'one two', marks: [] }],
  ]);
});

test('toggle offsets respect Unicode, protected objects and new-bullet boundaries', () => {
  const original: RichLine = [
    [
      { type: 'text', text: '🚀', marks: [] },
      { type: 'token', id: 'protected', marks: [] },
    ],
    [{ type: 'text', text: 'second', marks: ['italic'] }],
  ];
  const on = toggleSelectionMark(original, 4, 10, 'bold');
  assert.deepEqual(on[0], original[0]);
  assert.equal(selectionMarkState(on, 4, 10, 'bold'), 'true');
  assert.deepEqual(
    toggleSelectionMark(on, 4, 10, 'bold'),
    normalizeRichLine(original),
  );
});
