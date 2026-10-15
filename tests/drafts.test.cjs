const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// A fresh module instance per launch, backed by the same fake SecureStore.
function fresh(storage) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/drafts.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: name => {
    if (name === 'expo-secure-store') return {
      getItemAsync: async key => storage.get(key) ?? null,
      setItemAsync: async (key, value) => storage.set(key, value),
      deleteItemAsync: async key => storage.delete(key),
    };
    throw new Error(`Unexpected import: ${name}`);
  }});
  return exports;
}

test('draft text survives a full app restart', async () => {
  const storage = new Map();
  const first = fresh(storage);
  await first.saveDraft('s1', 'half typed thought');
  const second = fresh(storage); // cold launch: fresh memory, same store
  assert.equal(await second.loadDraft('s1'), 'half typed thought');
});

test('drafts are per chat and clearing removes only that chat', async () => {
  const storage = new Map();
  const lib = fresh(storage);
  await lib.saveDraft('s1', 'one');
  await lib.saveDraft('s2', 'two');
  await lib.clearDraft('s1');
  const lib2 = fresh(storage);
  assert.equal(await lib2.loadDraft('s1'), '');
  assert.equal(await lib2.loadDraft('s2'), 'two');
});

test('concurrent saves do not discard other chats', async () => {
  const storage = new Map();
  const lib = fresh(storage);
  await Promise.all([lib.saveDraft('a', 'alpha'), lib.saveDraft('b', 'beta')]);
  assert.equal(await lib.loadDraft('a'), 'alpha');
  assert.equal(await lib.loadDraft('b'), 'beta');
});

test('saving empty text clears the stored draft', async () => {
  const storage = new Map();
  const lib = fresh(storage);
  await lib.saveDraft('s1', 'temp');
  await lib.saveDraft('s1', '');
  assert.equal(storage.has('hermes.m.drafts.v1'), false);
});
