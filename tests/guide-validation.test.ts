import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { validateGuide, issueSummary } from '../src/lib/guide-validation';
import { GuideDiagnostics } from '../src/scripts/guide-diagnostics';
import {
  canvasBlocks,
  canvasTemplate,
  moveCanvasBlock,
  changeBlockField,
  blockFields,
} from '../src/lib/page-canvas';
import { createTestGuide } from './helpers';
import { textareaSourceOffset } from '../src/lib/textarea-source';

test('source selections translate native textarea line endings without changing parser offsets or surrogate pairs', () => {
  const source = '\uFEFF🚀\r\nFirst\r\nSecond\rThird';
  const displayed = source.replace(/\r\n|\r/g, '\n');
  for (const word of ['First', 'Second', 'Third']) {
    const start = source.indexOf(word);
    assert.equal(
      textareaSourceOffset(source, displayed, start),
      displayed.indexOf(word),
    );
    assert.equal(textareaSourceOffset(source, source, start), start);
  }
  assert.equal(textareaSourceOffset(source, 'unrelated', 3), undefined);
  assert.equal(textareaSourceOffset(source, displayed, -1), undefined);
});

test('complete literal source has separate parser and editorial severities and original UTF-16 ranges', () => {
  const source =
    '\uFEFF# Guide 🚀\r\n.\r\n## **Bad**\r\nText  here\r\n.unknown:value\r\n$linkmsg_missing$\r\n';
  const issues = validateGuide(source);
  assert.ok(
    issues.some(
      (i) =>
        i.source === 'parser' &&
        i.code === 'UNKNOWN_COMMAND' &&
        i.severity === 'error',
    ),
  );
  const heading = issues.find((i) => i.code === 'HEADING_BOLD')!;
  assert.equal(heading.source, 'style');
  assert.equal(heading.severity, 'error');
  assert.equal(
    source.slice(heading.range.start.offset, heading.range.end.offset),
    '## **Bad**',
  );
  assert.ok(
    issues.some((i) => i.code === 'DOUBLE_SPACE' && i.severity === 'warning'),
  );
  for (const issue of issues) {
    assert.equal(
      source.slice(0, issue.range.start.offset).split('\n').length,
      issue.range.start.line,
    );
    assert.ok(issue.range.end.offset <= source.length);
  }
  assert.match(issueSummary(issues), /errors, .*warnings/);
  assert.equal(issueSummary([]), 'No guide issues');
  assert.deepEqual(validateGuide(source), issues);
});

test('formatting, list operations, section moves and embeds are checked as complete guides without rewriting bytes', async () => {
  const source =
    '# Guide\r\n.\r\n## __First__\r\n.tag:first\r\n⬥ One\r\n    • Child\r\n.\r\n## __Second__\r\n.tag:second\r\nBody\r\n';
  const { session } = await createTestGuide(source);
  const line = session.lines.find((l) => l.raw === 'One')!;
  const model = session.lineModel(line.id);
  model[0] = [{ type: 'text', text: 'One', marks: ['bold'] }];
  session.setLine(line.id, model);
  const formatted = session.content();
  assert.equal(formatted, source.replace('⬥ One', '⬥ **One**'));
  assert.ok(!validateGuide(formatted).some((i) => i.severity === 'error'));
  const section = canvasBlocks(formatted).find(
    (b) => b.source === '## __First__',
  )!;
  const moved = moveCanvasBlock(formatted, section, formatted.length);
  assert.ok(!validateGuide(moved).some((i) => i.severity === 'error'));
  assert.ok(moved.includes('⬥ **One**\r\n    • Child'));
  assert.ok(moved.includes('.tag:first'));
  assert.equal(session.originalContent, source);
  const embed =
    '{"embed":{"title":"Original","description":"Keep"}}\r\n.embed:json';
  const block = canvasBlocks(embed).find((b) => b.kind === 'embed')!;
  const title = blockFields(block).find((f) => f.path?.at(-1) === 'title')!;
  const edited = changeBlockField(block, title, 'x'.repeat(257));
  assert.ok(
    validateGuide(edited).some(
      (i) => i.code === 'EMBED_SCHEMA' && i.severity === 'error',
    ),
  );
  assert.ok(edited.endsWith(',"description":"Keep"}}\r\n.embed:json'));
  assert.ok(
    !validateGuide(canvasTemplate('heading', source)).some(
      (i) => i.code === 'HEADING_UNDERLINE',
    ),
  );
});

test('diagnostic snapshots debounce changes, invalidate acknowledgement and refuse stale navigation', async () => {
  const { document, window } = parseHTML(
    '<html><body><div class="inline-editor-status"></div><form data-prepare-form></form></body></html>',
  );
  let source: string | undefined = '## Bad';
  let navigations = 0,
    clears = 0;
  const diagnostics = new GuideDiagnostics(
    document,
    () => source,
    () => {
      navigations++;
      return true;
    },
    () => clears++,
  );
  diagnostics.flush();
  assert.match(
    document.querySelector('[data-guide-diagnostics] summary')!.textContent!,
    /warning/,
  );
  assert.equal(diagnostics.canSubmit(), false);
  const checkbox = document.querySelector<HTMLInputElement>(
    '[data-acknowledge-issues]',
  )!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event('change'));
  assert.equal(diagnostics.canSubmit(), true);
  const stale = document.querySelector<HTMLButtonElement>('[data-issue-code]')!;
  source = '## __Fixed__';
  stale.click();
  assert.equal(navigations, 0);
  assert.equal(diagnostics.canSubmit(), true);
  assert.equal(checkbox.checked, false);
  source = '#### User input';
  diagnostics.schedule();
  assert.equal(
    document.querySelector('.guide-issue-list')!.childElementCount,
    0,
  );
  source = '## Different';
  diagnostics.schedule();
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.ok(document.querySelector('[data-issue-code="HEADING_UNDERLINE"]'));
  assert.equal(
    document.querySelector('[data-issue-code="HEADING_LEVEL"]'),
    null,
  );
  assert.equal(diagnostics.canSubmit(), false);
  (document.querySelector('[data-issue-code]') as HTMLElement).click();
  assert.equal(navigations, 1);
  assert.ok(clears > 0);
  source = undefined;
  diagnostics.flush();
  assert.equal(
    document.querySelector('.guide-issue-list')?.textContent || '',
    '',
  );
});
