const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

// Exercise the chat store's dead-man's switch: every busy/loading state the
// store owns (thinking pill, running tool-call row, streaming "…" bubble)
// must surface a visible, tap-to-retry error after 60s with no progress.
function setup() {
  const timers = new Map();
  let seq = 0;
  const fakeSetTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
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
    console, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  });
  let store;
  function Probe() { store = exports.useChatStore({}); return null; }
  return {
    exports, timers,
    get store() { return store; },
    async mount() {
      let root;
      await act(async () => { root = create(React.createElement(Probe)); });
      this.root = root;
    },
    async unmount() { await act(async () => { this.root.unmount(); }); },
    // Firing a timer removes it first, like the real runtime does.
    fire(id) { const t = timers.get(id); assert.ok(t, 'timer missing'); timers.delete(id); return act(async () => { t.fn(); }); },
  };
}

test('BUSY_TIMEOUT_MS is the 60s default', () => {
  const h = setup();
  assert.equal(h.exports.BUSY_TIMEOUT_MS, 60000);
});

test('busy with no progress surfaces a tap-to-retry error after the timeout', async () => {
  const h = setup();
  await h.mount();
  try {
    await act(async () => { h.store.setBusy(true); });
    assert.equal(h.store.busy, true);
    assert.equal(h.timers.size, 1);
    const [[id, t]] = [...h.timers];
    assert.equal(t.ms, 60000, 'dead-man switch must use the 60s default');
    await h.fire(id);
    assert.equal(h.store.busy, false, 'timeout must clear busy');
    assert.equal(h.store.toolActivity, '', 'timeout must clear the tool row');
    assert.equal(h.timers.size, 0, 'timeout must disarm itself');
    const err = h.store.messages.find((m) => m.role === 'error');
    assert.ok(err, 'timeout must leave a visible error row');
    assert.ok(err.text.includes('retry'), 'error row must wire MessageRow tap-to-retry');
  } finally {
    await h.unmount();
  }
});

test('a stuck tool-call row times out the same way', async () => {
  const h = setup();
  await h.mount();
  try {
    await act(async () => { h.store.startTool('mcp__exa__web_search_exa'); });
    assert.equal(h.store.toolActivity, 'mcp__exa__web_search_exa');
    assert.equal(h.timers.size, 1, 'startTool must arm the dead-man switch');
    const [[id]] = [...h.timers];
    await h.fire(id);
    assert.equal(h.store.busy, false);
    assert.equal(h.store.toolActivity, '');
    assert.ok(h.store.messages.some((m) => m.role === 'error' && m.text.includes('retry')));
  } finally {
    await h.unmount();
  }
});

test('streaming progress re-arms the countdown instead of firing', async () => {
  const h = setup();
  await h.mount();
  try {
    await act(async () => { h.store.setBusy(true); });
    // The fake timers also capture the 25ms stream-flush throttle; only the
    // 60s timers are the dead-man's switch.
    const busyTimers = () => [...h.timers].filter(([, t]) => t.ms === 60000).map(([id]) => id);
    const [first] = busyTimers();
    assert.ok(first, 'setBusy(true) must arm the dead-man switch');
    await act(async () => {
      h.store.startStream('a1', 's1');
      h.store.appendDelta('hello', 's1', 'a1');
      h.store.appendThinkingDelta('hmm', 's1', 'a1');
    });
    const ids = busyTimers();
    assert.equal(ids.length, 1, 'exactly one countdown must be armed');
    assert.notEqual(ids[0], first, 'progress must re-arm the timer');
    assert.equal(h.store.busy, true, 'progress must not clear busy');
  } finally {
    await h.unmount();
  }
});

test('finishStream and handleError disarm the switch', async () => {
  const h = setup();
  await h.mount();
  try {
    await act(async () => { h.store.setBusy(true); });
    assert.equal(h.timers.size, 1);
    await act(async () => { h.store.finishStream('done'); });
    assert.equal(h.timers.size, 0, 'finish must disarm the dead-man switch');
    await act(async () => { h.store.setBusy(true); });
    assert.equal(h.timers.size, 1);
    await act(async () => { h.store.handleError('boom'); });
    assert.equal(h.timers.size, 0, 'error must disarm the dead-man switch');
  } finally {
    await h.unmount();
  }
});

test('timeout stops the streaming "…" on the in-flight assistant bubble', async () => {
  const h = setup();
  await h.mount();
  try {
    await act(async () => {
      h.store.setBusy(true);
      h.store.startStream('a9', 's1');
    });
    const [[id]] = [...h.timers];
    await h.fire(id);
    const bubble = h.store.messages.find((m) => m.id === 'a9');
    assert.ok(bubble, 'assistant bubble must survive');
    assert.equal(bubble.streaming, false, 'timeout must stop the streaming ellipsis');
  } finally {
    await h.unmount();
  }
});
