// A link tap inside a message bubble also fires the bubble's onPress.
// The suppression window keeps the bubble from copying the whole message
// on top of opening the link.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const lib = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/copyGuard.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: lib });

test('a bubble tap right after a link tap is suppressed', () => {
  assert.equal(lib.shouldSuppressCopy(1000, 1000), true, 'same instant');
  assert.equal(lib.shouldSuppressCopy(1000, 1499), true, 'inside the window');
});

test('a bubble tap after the window still copies', () => {
  assert.equal(lib.shouldSuppressCopy(1000, 1500), false, 'at the boundary');
  assert.equal(lib.shouldSuppressCopy(1000, 5000), false, 'well after');
  assert.equal(lib.shouldSuppressCopy(0, 10_000), false, 'no recent link tap');
});

test('the suppression window is half a second', () => {
  assert.equal(lib.LINK_TAP_SUPPRESS_MS, 500);
});
