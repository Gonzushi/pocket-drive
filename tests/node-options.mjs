import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicatePreloads } from '../scripts/node-options.mjs';

test('duplicate company registry preloads are retained once', () => {
  const hook = '/Library/sec_registry/npm-registry-hook.js';
  assert.deepEqual(deduplicatePreloads(`--require ${hook} --require ${hook}`), {
    options: `--require ${hook}`, removed: 1
  });
});
test('all distinct hooks and other security options are preserved', () => {
  assert.deepEqual(deduplicatePreloads('--require=hook.js --enable-source-maps --require hook.js --require=another.js --disallow-code-generation-from-strings'), {
    options: '--require=hook.js --enable-source-maps --require=another.js --disallow-code-generation-from-strings', removed: 1
  });
});
test('quoted paths and short flags are handled without altering other values', () => {
  assert.deepEqual(deduplicatePreloads('--require "./a folder/hook.js" -r "./a folder/hook.js" --conditions="custom value"'), {
    options: '--require "./a folder/hook.js" --conditions="custom value"', removed: 1
  });
});
test('settings without duplicates are left byte-for-byte unchanged', () => {
  for (const options of ['', '--require=hook.js', ' --require hook.js   --enable-source-maps ']) assert.deepEqual(deduplicatePreloads(options), { options, removed: 0 });
});
