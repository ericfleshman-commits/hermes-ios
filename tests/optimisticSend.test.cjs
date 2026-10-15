const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Optimistic send states: a tapped send must appear immediately with a
// "sending" mark, resolve to sent on ack, or to a retryable failed state -
// and a background rehydrate (syncFromServer/mergeServerRows) must never
// silently drop an optimistic row the server doesn't include yet.

// Load the real useChatStore module with stubbed react/sessionFence, the same
// way chatSync.test.cjs does.
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
    store: exports.useChatStore({}),
    messages: () => slots[0],
  };
}

const { mergeServerRows } = loadModule();

// Messages come from a vm context, so compare id lists as joined strings:
// deepStrictEqual rejects cross-realm arrays on prototype identity.
const ids = (msgs) => msgs.map((m) => m.id).join(',');
const byId = (msgs) => Object.fromEntries(msgs.map((m) => [m.id, m]));

test('addUserMessage marks the new bubble sending when asked, plain otherwise', () => {
  const h = loadHook();
  const sendingId = h.store.addUserMessage('hello', undefined, { sending: true });
  const plainId = h.store.addUserMessage('world');
  const msgs = byId(h.messages());
  assert.equal(msgs[sendingId].sending, true, 'live send marks sending');
  assert.equal(msgs[plainId].sending, undefined, 'no flag without opts');
});

test('the sending flag resolves to sent via patchMessage (the ack path)', () => {
  const h = loadHook();
  const id = h.store.addUserMessage('hello', undefined, { sending: true });
  assert.equal(byId(h.messages())[id].sending, true);
  // Mirrors App.tsx: on prompt.submit ack the bubble clears sending.
  h.store.patchMessage(id, (m) => ({ ...m, sending: undefined }));
  const m = byId(h.messages())[id];
  assert.equal(m.sending, undefined);
  assert.equal(m.text, 'hello', 'text untouched');
  assert.equal(ids(h.messages()), id, 'row not dropped');
});

test('a background sync never drops an optimistic sending row the server does not include yet', () => {
  const local = [
    { id: 'srv:1', role: 'user', text: 'earlier' },
    { id: 'u-1', role: 'user', text: 'just tapped', sending: true },
  ];
  const server = [{ id: 'srv:1', role: 'user', text: 'earlier' }];
  const merged = mergeServerRows(local, server);
  assert.equal(ids(merged), 'srv:1,u-1', 'optimistic row kept in place');
  assert.equal(byId(merged)['u-1'].sending, true, 'sending flag survives the sync');
});

test('the optimistic sending row is absorbed when the server canon row arrives - no duplicates', () => {
  const local = [
    { id: 'u-1', role: 'user', text: 'hello', sending: true },
  ];
  const server = [{ id: 'srv:9', role: 'user', text: 'hello' }];
  const merged = mergeServerRows(local, server);
  assert.equal(ids(merged), 'srv:9', 'single canon row, optimistic row absorbed');
  assert.equal(byId(merged)['srv:9'].sending, undefined, 'canon row carries no sending flag');
});

test('a sendFailed row is never dropped by a sync even when the server has the same text', () => {
  const local = [
    { id: 'srv:1', role: 'user', text: 'older' },
    { id: 'u-1', role: 'user', text: 'failed text', sendFailed: true, sendError: 'upload blew up' },
  ];
  const server = [
    { id: 'srv:1', role: 'user', text: 'older' },
    { id: 'srv:9', role: 'user', text: 'failed text' },
  ];
  const merged = mergeServerRows(local, server);
  assert.equal(ids(merged), 'srv:1,srv:9,u-1', 'failed bubble kept alongside the same-text server row');
  const failed = byId(merged)['u-1'];
  assert.equal(failed.sendFailed, true, 'retry state intact');
  assert.equal(failed.sendError, 'upload blew up');
  assert.equal(failed.text, 'failed text', 'text kept');
});

test('a sendFailed row survives a background sync that does not include it', () => {
  const local = [
    { id: 'srv:1', role: 'user', text: 'older' },
    { id: 'u-1', role: 'user', text: 'failed text', sendFailed: true },
  ];
  const server = [
    { id: 'srv:1', role: 'user', text: 'older' },
    { id: 'srv:2', role: 'assistant', text: 'reply' },
  ];
  const merged = mergeServerRows(local, server);
  assert.equal(ids(merged), 'srv:1,srv:2,u-1', 'failed row never silently vanishes');
  assert.equal(byId(merged)['u-1'].sendFailed, true);
});

test('a pre-submit failure turns sending into sendFailed via patchMessage (the retry path)', () => {
  const h = loadHook();
  const id = h.store.addUserMessage('hello', undefined, { sending: true });
  // Mirrors App.tsx catch: pre-submit failure swaps sending for sendFailed.
  h.store.patchMessage(id, (m) => ({ ...m, sending: undefined, sendFailed: true, sendError: 'boom' }));
  const m = byId(h.messages())[id];
  assert.equal(m.sending, undefined, 'sending cleared');
  assert.equal(m.sendFailed, true, 'tap-to-retry state set');
  assert.equal(m.text, 'hello', 'text kept for the retry');
});

test('retrying a failed turn marks the same bubble sending again', () => {
  const h = loadHook();
  const id = h.store.addUserMessage('hello', undefined, { sending: true });
  h.store.patchMessage(id, (m) => ({ ...m, sending: undefined, sendFailed: true }));
  // Mirrors App.tsx send() retry branch: replay into the original bubble.
  h.store.patchMessage(id, (m) => ({ ...m, sendFailed: undefined, sendError: undefined, sending: true }));
  const m = byId(h.messages())[id];
  assert.equal(m.sending, true, 'sending again during retry');
  assert.equal(m.sendFailed, undefined, 'failed state lifted for the attempt');
  assert.equal(ids(h.messages()), id, 'same bubble, no duplicate');
});
