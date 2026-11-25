import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import {
  emojiSnapshot,
  emojiMatches,
  emojiQuery,
  emojiSource,
  emojiCatalogue,
} from '../src/lib/emoji-autocomplete';
import { newEmojiToken } from '../src/lib/rich-token';
import { EmojiAutocomplete } from '../src/scripts/emoji-autocomplete';

test('emoji names, aliases and search ordering match the Guide Editor catalogue', () => {
  const matches = emojiMatches(emojiSnapshot, 'necro');
  assert.ok(matches.some((emoji) => emoji.id === 'necromancy'));
  assert.ok(matches.some((emoji) => emoji.id === 'necrobasic'));
  assert.ok(matches.some((emoji) => emoji.id === 'necrosis'));
  assert.equal(emojiMatches(emojiSnapshot, 'necromancy')[0].id, 'necromancy');
  const aliased = emojiSnapshot.find((emoji) => emoji.aliases.length)!;
  assert.ok(
    emojiMatches(emojiSnapshot, aliased.aliases[0], true).some(
      (emoji) => emoji.id === aliased.id,
    ),
  );
  assert.equal(emojiQuery('word :necro')!.query, 'necro');
  assert.equal(emojiQuery(':NECROMANCY:')!.closed, true);
  for (const text of [':n', '\\:necro', '<:necro', ':necro:', ':missing:']) {
    if (text === ':necro:' || text === ':missing:') continue;
    assert.equal(emojiQuery(text), undefined, text);
  }
  assert.deepEqual(
    emojiMatches(emojiSnapshot, 'not_a_real_emoji_xyz', true),
    [],
  );
  assert.deepEqual(
    emojiCatalogue({
      categories: [{ emojis: [{ id: 'bad', emoji_id: 'javascript:bad' }] }],
    }),
    [],
  );
  for (const emoji of emojiSnapshot)
    assert.ok(newEmojiToken(emojiSource(emoji)), emoji.id);
});

function fixture(tag = 'textarea', modal = false) {
  const { document, window } = parseHTML(
    `<html><body>${modal ? '<dialog class="inline-dialog" open>' : '<div data-page-canvas>'}<${tag} id="text"></${tag}>${modal ? '</dialog>' : '</div>'}</body></html>`,
  );
  new EmojiAutocomplete(document, emojiSnapshot);
  const input = document.getElementById('text')! as HTMLTextAreaElement;
  Object.defineProperties(input, {
    selectionStart: { value: 0, writable: true },
    selectionEnd: { value: 0, writable: true },
  });
  input.setSelectionRange = (start, end) => {
    input.selectionStart = start ?? 0;
    input.selectionEnd = end ?? 0;
  };
  const type = (value: string, caret = value.length) => {
    input.value = value;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const key = (key: string) => {
    const event = new window.Event('keydown', {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(event, { key });
    input.dispatchEvent(event);
    return event;
  };
  return { document, window, input, type, key };
}

test('source/text fields autocomplete with keyboard selection, Escape and exact closing-colon replacement', () => {
  const f = fixture();
  f.type('Before :necro after', 13);
  const options = [...f.document.querySelectorAll('[role="option"]')];
  assert.ok(options.length > 1);
  const name = options[1].textContent!;
  assert.ok(f.key('ArrowDown').defaultPrevented);
  assert.ok(f.key('Enter').defaultPrevented);
  const emoji = emojiMatches(emojiSnapshot, name, true)[0];
  assert.equal(f.input.value, 'Before ' + emojiSource(emoji) + ' after');
  assert.ok(!f.document.querySelector('[role="listbox"]'));
  f.type(':necro');
  f.key('Escape');
  assert.equal(f.input.value, ':necro');
  assert.ok(!f.document.querySelector('[role="listbox"]'));
  f.type(':necr');
  f.type(':necro');
  assert.ok(f.document.querySelector('[role="listbox"]'));
  f.type(':necromancy:');
  assert.equal(
    f.input.value,
    emojiSource(emojiMatches(emojiSnapshot, 'necromancy', true)[0]),
  );
  f.type(':unknown_emoji_xyz:');
  assert.equal(f.input.value, ':unknown_emoji_xyz:');
});

test('text fields created inside dialogs retain autocomplete in the dialog top layer', () => {
  const f = fixture('input', true);
  f.type(':necro');
  assert.ok(f.document.querySelector('dialog .emoji-completions'));
  const option = f.document.querySelector('[role="option"]')!;
  const name = option.textContent!;
  option.dispatchEvent(
    new f.window.Event('click', { bubbles: true, cancelable: true }),
  );
  assert.equal(
    f.input.value,
    emojiSource(emojiMatches(emojiSnapshot, name, true)[0]),
  );
});
