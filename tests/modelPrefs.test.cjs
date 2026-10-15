// Persisted default model: the choice must survive restarts, and
// resolveDefaultModel must prefer: persisted default > recents > favorites.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function fresh(storage) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/modelPrefs.ts', 'utf8'), {
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

// The module runs in a vm realm (different Object.prototype), so compare model
// refs by value through JSON rather than strict deep-equal.
const sameRef = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

const openai = { slug: 'openai', models: ['gpt-4o', 'gpt-4o-mini'] };
const anthropic = { slug: 'anthropic', models: ['claude-sonnet'] };

test('default model survives a full app restart', async () => {
  const storage = new Map();
  const first = fresh(storage);
  const prefs = await first.setDefaultModel(first.EMPTY_PREFS, { provider: 'openai', model: 'gpt-4o' });
  assert.equal(prefs.defaultModel.model, 'gpt-4o');
  const second = fresh(storage); // cold launch
  const restored = await second.loadModelPrefs();
  sameRef(restored.defaultModel, { provider: 'openai', model: 'gpt-4o' });
});

test('resolveDefaultModel prefers the persisted default when still available', async () => {
  const lib = fresh(new Map());
  const prefs = await lib.setDefaultModel(
    await lib.rememberRecent(lib.EMPTY_PREFS, { provider: 'anthropic', model: 'claude-sonnet' }),
    { provider: 'openai', model: 'gpt-4o' });
  const resolved = lib.resolveDefaultModel(prefs, [openai, anthropic]);
  sameRef(resolved, { provider: 'openai', model: 'gpt-4o' });
});

test('resolveDefaultModel falls back to recents, then favorites, when the default is gone', async () => {
  const lib = fresh(new Map());
  let prefs = await lib.rememberRecent(lib.EMPTY_PREFS, { provider: 'anthropic', model: 'claude-sonnet' });
  prefs = await lib.toggleFavorite(prefs, { provider: 'openai', model: 'gpt-4o-mini' });
  const prefsNoDefault = { ...prefs, defaultModel: undefined };
  // The persisted default is gone from the backend — recents win over favorites.
  sameRef(lib.resolveDefaultModel(prefsNoDefault, [openai, anthropic]),
    { provider: 'anthropic', model: 'claude-sonnet' });
  const prefsNoRecent = { ...prefsNoDefault, recents: [] };
  sameRef(lib.resolveDefaultModel(prefsNoRecent, [openai, anthropic]),
    { provider: 'openai', model: 'gpt-4o-mini' });
});

function prefsNoRecent(prefs) { return { ...prefs, recents: [], favorites: [] }; }

test('resolveDefaultModel returns null when the backend lists nothing usable', async () => {
  const lib = fresh(new Map());
  const prefs = await lib.setDefaultModel(lib.EMPTY_PREFS, { provider: 'openai', model: 'gpt-4o' });
  assert.equal(lib.resolveDefaultModel(prefs, []), null);
  assert.equal(lib.resolveDefaultModel(prefs, [{ slug: 'openai', models: [] }]), null);
});

test('a stale default that is no longer listed is ignored, not returned', async () => {
  const lib = fresh(new Map());
  let prefs = await lib.setDefaultModel(lib.EMPTY_PREFS, { provider: 'openai', model: 'gpt-5' });
  prefs = await lib.toggleFavorite(prefs, { provider: 'openai', model: 'gpt-4o-mini' });
  const resolved = lib.resolveDefaultModel(prefs, [openai]);
  assert.notEqual(JSON.stringify(resolved), JSON.stringify({ provider: 'openai', model: 'gpt-5' }), 'stale default must never be returned');
  sameRef(resolved, { provider: 'openai', model: 'gpt-4o-mini' }, 'falls back to a listed favorite');
  // With nothing else to fall back to, the first listed model wins — never the
  // stale default, never null while the backend lists something usable.
  sameRef(lib.resolveDefaultModel(prefsNoRecent(prefs), [openai]),
    { provider: 'openai', model: 'gpt-4o' });
});
