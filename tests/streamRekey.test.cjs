global.IS_REACT_ACT_ENVIRONMENT = true;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

// Regression tests for the persisted_turn re-key: WS-originated bubbles must
// acquire the server's stable row ids on message.complete, so the next REST
// merge correlates by identity instead of fragile role+text matching.
function setup() {
  const fenceExports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/sessionFence.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: fenceExports, console });
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/hooks/useChatStore.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require(id) {
      if (id === 'react') return React;
      if (id === '../lib/sessionFence') return fenceExports;
      throw new Error(`unexpected import: ${id}`);
    },
    console,
  });
  let store;
  function Probe() { store = exports.useChatStore({}); return null; }
  return {
    exports,
    get store() { return store; },
    ids() { return store.messages.map((m) => m.id); },
    async mount() {
      let root;
      await act(async () => { root = create(React.createElement(Probe)); });
      this.root = root;
    },
    async unmount() { await act(async () => { this.root.unmount(); }); },
    async turn({ userText = 'q', answer = 'a', receipt = { final_assistant_row_id: 42, user_row_id: 41 }, isError = false } = {}) {
      let userId; let streamId;
      await act(async () => { userId = store.addUserMessage(userText); });
      await act(async () => { streamId = store.startStream(); });
      await act(async () => { store.finishStream(answer, isError, receipt); });
      return { userId, streamId };
    },
  };
}

test('finishStream re-keys WS bubbles with the persisted_turn row ids', async () => {
  const h = setup();
  await h.mount();
  try {
    const { userId, streamId } = await h.turn();
    const ids = h.ids();
    assert.ok(ids.includes('srv:42'), 'assistant bubble re-keyed, got: ' + ids.join(','));
    assert.ok(ids.includes('srv:41'), 'user bubble re-keyed');
    assert.ok(!ids.includes(userId), 'throwaway user id retired');
    assert.ok(!ids.includes(streamId), 'throwaway stream id retired');
  } finally { await h.unmount(); }
});

test('finishStream without a receipt keeps throwaway ids (fallback preserved)', async () => {
  const h = setup();
  await h.mount();
  try {
    const { userId, streamId } = await h.turn({ receipt: null });
    const ids = h.ids();
    assert.ok(ids.includes(userId), 'user bubble keeps its client id');
    assert.ok(ids.includes(streamId), 'stream bubble keeps its client id');
    assert.ok(!ids.some((id) => id.startsWith('srv:')), 'no server id fabricated');
  } finally { await h.unmount(); }
});

test('finishStream ignores a malformed receipt', async () => {
  const h = setup();
  await h.mount();
  try {
    for (const receipt of [
      { final_assistant_row_id: '42', user_row_id: '41' },
      { final_assistant_row_id: 0, user_row_id: -1 },
      { final_assistant_row_id: null },
      { final_assistant_row_id: 42.5, user_row_id: NaN },
    ]) {
      const { userId, streamId } = await h.turn({ receipt });
      const ids = h.ids();
      assert.ok(!ids.some((id) => id.startsWith('srv:')), 'no fabricated server id for ' + JSON.stringify(receipt));
      assert.ok(ids.includes(userId) && ids.includes(streamId), 'throwaway ids survive');
    }
  } finally { await h.unmount(); }
});

test('finishStream on error does not re-key the assistant bubble', async () => {
  const h = setup();
  await h.mount();
  try {
    const { streamId } = await h.turn({ isError: true, answer: 'boom' });
    const ids = h.ids();
    assert.ok(ids.includes(streamId), 'errored assistant bubble keeps its id');
    assert.ok(!ids.includes('srv:42'), 'no assistant re-key on error');
  } finally { await h.unmount(); }
});

test('re-keyed bubbles merge with REST rows by identity, not text', async () => {
  const h = setup();
  await h.mount();
  try {
    await h.turn({ userText: 'what is 2+2?', answer: '4' });
    const local = h.store.messages;
    const server = h.exports.mapServerMessages([
      { id: 41, role: 'user', content: 'what is 2+2?' },
      { id: 42, role: 'assistant', content: '4' },
    ]);
    const merged = h.exports.mergeServerRows(local, server);
    assert.equal(merged.filter((m) => m.id === 'srv:42').length, 1, 'exactly one assistant row');
    assert.equal(merged.filter((m) => m.id === 'srv:41').length, 1, 'exactly one user row');
    assert.equal(merged.length, 2, 'no ghost duplicates');
  } finally { await h.unmount(); }
});

test('re-key is idempotent across a duplicate message.complete', async () => {
  const h = setup();
  await h.mount();
  try {
    await h.turn();
    const before = h.ids().join(',');
    await act(async () => { h.store.finishStream('4', false, { final_assistant_row_id: 42, user_row_id: 41 }); });
    assert.equal(h.ids().join(','), before, 'duplicate complete changes nothing');
  } finally { await h.unmount(); }
});
