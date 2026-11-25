import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import assert from 'node:assert/strict';
import {
  canvasBlocks,
  canvasMessages,
  blockFields,
  changeBlockField,
  replaceCanvasBlock,
  validatePageSource,
} from '../src/lib/page-canvas';
import { jsonSource } from '../src/lib/json-source';

const root = resolve(process.env.GUIDES_DIR || '../pvme-guides');
const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    ['.git', 'node_modules'].includes(entry.name)
      ? []
      : entry.isDirectory()
        ? walk(join(directory, entry.name))
        : entry.name.endsWith('.txt')
          ? [join(directory, entry.name)]
          : [],
  );
const result = {
  guides: 0,
  blocks: 0,
  messages: 0,
  embeds: 0,
  propertyNoops: 0,
  editedEmbeds: 0,
  advancedOnly: [] as { path: string; reason: string }[],
  invalid: [] as { path: string; error: string }[],
};
for (const file of walk(root)) {
  const path = relative(root, file).replace(/\\/g, '/');
  result.guides++;
  try {
    const source = readFileSync(file, 'utf8');
    assert.equal(validatePageSource(source, source), source);
    const messages = canvasMessages(source);
    for (const message of messages) {
      assert.equal(message.source, source.slice(message.start, message.end));
      assert.equal(replaceCanvasBlock(source, message, message.source), source);
      result.messages++;
    }
    let end = 0;
    for (const block of canvasBlocks(source)) {
      assert.ok(block.start >= end);
      assert.equal(block.source, source.slice(block.start, block.end));
      end = block.end;
      result.blocks++;
      if (!['settings', 'source', 'divider'].includes(block.kind))
        assert.equal(
          messages.filter(
            (message) =>
              block.start >= message.start && block.end <= message.end,
          ).length,
          1,
          `Block ${block.id} must belong to exactly one original message`,
        );
      if (block.node?.type !== 'embed' || !block.node.valid) continue;
      result.embeds++;
      try {
        assert.deepEqual(
          JSON.parse(JSON.stringify(jsonSource(block.source).value)),
          block.node.value,
        );
      } catch (error) {
        result.advancedOnly.push({ path, reason: String(error) });
        continue;
      }
      const fields = blockFields(block);
      for (const field of fields) {
        assert.equal(changeBlockField(block, field, field.value), block.source);
        result.propertyNoops++;
      }
      const field = fields.find((field) => field.type === 'text');
      if (field) {
        const changed = replaceCanvasBlock(
          source,
          block,
          changeBlockField(block, field, field.value + ' audit'),
        );
        assert.equal(validatePageSource(source, changed), changed);
        result.editedEmbeds++;
      }
    }
  } catch (error) {
    result.invalid.push({ path, error: String(error) });
  }
}
console.log(JSON.stringify(result, null, 2));
if (result.invalid.length) process.exitCode = 1;
