const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Load the real useChatStore module with stubbed react/sessionFence, the same
// way session.test.cjs loads the session store.
function loadModule() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/hooks/useChatStore.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require(name) {
      if (name === 'react') return {};
      if (name === '../lib/sessionFence') return { isSessionFencedElsewhere: () => false, fenceNotice: (t) => t };
      throw new Error('Unexpected import: ' + name);
    },
  });
  return exports;
}

// Minimal hook harness: slot-based useState so setMessages updaters work.
function loadHook() {
  const slots = [];
  const react = {
    useState: (v) => {
      const i = slots.length;
      slots.push(v);
      return [slots[i], (u) => { slots[i] = typeof u === 'function' ? u(slots[i]) : u; }];
    },
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: () => {},
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/hooks/useChatStore.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require(name) {
      if (name === 'react') return react;
      if (name === '../lib/sessionFence') return { isSessionFencedElsewhere: () => false, fenceNotice: (t) => t };
      throw new Error('Unexpected import: ' + name);
    },
  });
  return {
    makeStore: (options) => exports.useChatStore(options || {}),
    messages: () => slots[0],
  };
}

const { mergeServerRows, mapServerMessages } = loadModule();

// Messages come from a vm context, so compare id lists as joined strings:
// deepStrictEqual rejects cross-realm arrays on prototype identity.
const ids = (msgs) => msgs.map((m) => m.id).join(',');

test('REST mapping keeps the server row id as the message id', () => {
  const rows = mapServerMessages([
    { id: 41, role: 'user', content: 'hi' },
    { id: 42, role: 'assistant', content: [{ text: 'hello ' }, { text: 'there' }] },
    { id: 43, role: 'system', content: 'dropped' },
    { id: 44, role: 'assistant', content: 42 },
  ]);
  assert.equal(ids(rows), 'srv:41,srv:42,srv:44');
  assert.equal(rows[1].text, 'hello there');
  // Defensive fallback: a row without a server id still maps, client-minted.
  const [fallback] = mapServerMessages([{ role: 'user', content: 'x' }]);
  assert.ok(fallback.id.startsWith('h-'), 'falls back to uid("h")');
  assert.ok(!fallback.id.startsWith('srv:'), 'never fabricates a server id');
});

test('rehydrate merges on stable ids instead of duplicating rows', () => {
  const local = [
    { id: 'srv:1', role: 'user', text: 'a' },
    { id: 'srv:2', role: 'assistant', text: 'b' },
  ];
  const server = [
    { id: 'srv:1', role: 'user', text: 'a' },
    { id: 'srv:2', role: 'assistant', text: 'b' },
    { id: 'srv:3', role: 'user', text: 'c' },
  ];
  const merged = mergeServerRows(local, server);
  assert.equal(ids(merged), 'srv:1,srv:2,srv:3');
  assert.equal(merged.filter((m) => m.id === 'srv:2').length, 1, 'no duplicate rows');
});

test('an unchanged tail is a no-op returning the same reference', () => {
  const local = [
    { id: 'srv:1', role: 'user', text: 'a' },
    { id: 'srv:2', role: 'assistant', text: 'b' },
  ];
  const server = local.map((m) => ({ ...m })); // fresh objects, same content
  assert.equal(mergeServerRows(local, server), local, 'callers skip the repaint');
});

test('a local streaming bubble dedupes against its completed server row', () => {
  const local = [
    { id: 'srv:1', role: 'user', text: 'q' },
    { id: 'a-99', role: 'assistant', text: 'partial…', streaming: true },
  ];
  const server = [
    { id: 'srv:1', role: 'user', text: 'q' },
    { id: 'srv:2', role: 'assistant', text: 'full answer' },
  ];
  const merged = mergeServerRows(local, server);
  assert.equal(ids(merged), 'srv:1,srv:2');
});

test('a completed local stream matching the server row collapses to the server row', () => {
  const local = [
    { id: 'srv:1', role: 'user', text: 'q' },
    { id: 'a-99', role: 'assistant', text: 'full answer', streaming: false },
  ];
  const server = [
    { id: 'srv:1', role: 'user', text: 'q' },
    { id: 'srv:2', role: 'assistant', text: 'full answer' },
  ];
  const merged = mergeServerRows(local, server);
  assert.equal(ids(merged), 'srv:1,srv:2', 'server canon wins');
});

test('a pending unsent user message survives a rehydrate', () => {
  const local = [
    { id: 'srv:1', role: 'user', text: 'a' },
    { id: 'srv:2', role: 'assistant', text: 'b' },
    { id: 'u-9', role: 'user', text: 'not yet sent' },
  ];
  const server = [
    { id: 'srv:1', role: 'user', text: 'a' },
    { id: 'srv:2', role: 'assistant', text: 'b' },
  ];
  const merged = mergeServerRows(local, server);
  assert.equal(ids(merged), 'srv:1,srv:2,u-9');
  assert.equal(merged[2].text, 'not yet sent');
});

test('local server rows older than the fetch window are preserved', () => {
  const local = [
    { id: 'srv:1', role: 'user', text: 'old' },
    { id: 'srv:2', role: 'assistant', text: 'older' },
    { id: 'srv:161', role: 'user', text: 'w1' },
    { id: 'srv:162', role: 'assistant', text: 'w2' },
  ];
  const server = [
    { id: 'srv:161', role: 'user', text: 'w1 fresh' },
    { id: 'srv:162', role: 'assistant', text: 'w2 fresh' },
  ];
  const merged = mergeServerRows(local, server);
  assert.equal(ids(merged), 'srv:1,srv:2,srv:161,srv:162');
  assert.equal(merged[2].text, 'w1 fresh', 'in-window rows are replaced by server truth');
});

test('in-window server rows missing server-side are dropped as rewound', () => {
  // The server wound back from row 9 to row 8: local srv:9 is at/above the
  // window minimum (7) but absent from the fetch, so it is dropped. srv:1 is
  // older than the window and is preserved.
  const local = [
    { id: 'srv:1', role: 'user', text: 'old' },
    { id: 'srv:9', role: 'assistant', text: 'ghost' },
  ];
  const server = [
    { id: 'srv:7', role: 'user', text: 'new' },
    { id: 'srv:8', role: 'assistant', text: 'newer' },
  ];
  const merged = mergeServerRows(local, server);
  assert.equal(ids(merged), 'srv:1,srv:7,srv:8');
});

test('local error rows survive a rehydrate', () => {
  const local = [
    { id: 'srv:1', role: 'user', text: 'a' },
    { id: 'e-1', role: 'error', text: 'Request timed out \u2014 tap to retry' },
  ];
  const server = [{ id: 'srv:1', role: 'user', text: 'a' }];
  const merged = mergeServerRows(local, server);
  assert.equal(ids(merged), 'srv:1,e-1');
});

test('legacy client-minted ids dedupe by content and never duplicate', () => {
  const local = [{ id: 'h-1720000000000-1', role: 'user', text: 'a' }];
  const server = [{ id: 'srv:1', role: 'user', text: 'a' }];
  assert.equal(ids(mergeServerRows(local, server)), 'srv:1');
});

test('an empty server fetch never wipes the transcript', () => {
  const local = [{ id: 'srv:1', role: 'user', text: 'a' }];
  assert.equal(mergeServerRows(local, []), local);
});

test('syncFromServer applies server truth through the store without duplicating stable rows', () => {
  const { makeStore, messages } = loadHook();
  const store = makeStore({});
  store.loadMessages([{ id: 'srv:1', role: 'user', text: 'a' }]);
  store.syncFromServer([
    { id: 'srv:1', role: 'user', text: 'a' },
    { id: 'srv:2', role: 'assistant', text: 'b' },
  ]);
  assert.equal(ids(messages()), 'srv:1,srv:2');
});

test('syncFromServer ignores history for a stale session id', () => {
  const { makeStore, messages } = loadHook();
  const store = makeStore({ activeSessionRef: { current: 'live-1' } });
  store.loadMessages([{ id: 'srv:1', role: 'user', text: 'a' }]);
  store.syncFromServer([{ id: 'srv:9', role: 'user', text: 'other chat' }], 'live-2');
  assert.equal(ids(messages()), 'srv:1');
});
