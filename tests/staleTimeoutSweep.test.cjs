const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { create, act } = require("react-test-renderer");

// Regression: a "Request timed out — tap to retry" error pill persisted at the
// bottom of the chat even though the response arrived fine afterwards. The
// timeout fires (busyTimedOut appends the error row), then message.complete
// arrives late — but clearRetryErrors only runs on the next SEND, so the stale
// row survived indefinitely. Fix: finishStream sweeps stale timeout rows on
// every completed turn, since a completion proves the stall resolved.
function setup() {
  const timers = new Map();
  let seq = 0;
  const fakeSetTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  const fenceExports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/lib/sessionFence.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: fenceExports, console });
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/hooks/useChatStore.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require(id) {
      if (id === "react") return React;
      if (id === "../lib/sessionFence") return fenceExports;
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
    fire(id) { const t = timers.get(id); assert.ok(t, "timer missing"); timers.delete(id); return act(async () => { t.fn(); }); },
  };
}

const timeoutRow = (store) =>
  store.messages.find((m) => m.role === "error" && m.text.includes("Request timed out"));

test("stale timeout error is swept when the turn completes late", async () => {
  const h = setup();
  await h.mount();
  try {
    // Start a turn, let the 60s dead-man fire.
    await act(async () => { h.store.setBusy(true); });
    const [[id]] = [...h.timers].filter(([, t]) => t.ms === 60000);
    assert.ok(id, "busy must arm the dead-man switch");
    await h.fire(id);
    assert.ok(timeoutRow(h.store), "timeout must leave the error row");

    // The response arrives late via message.complete -> finishStream.
    await act(async () => { h.store.finishStream("late response"); });
    assert.equal(timeoutRow(h.store), undefined,
      "completed turn must sweep the stale timeout error");
  } finally {
    await h.unmount();
  }
});

test("sweep does not touch non-timeout error rows", async () => {
  const h = setup();
  await h.mount();
  try {
    // A send-failure error row (different text) must survive a completion.
    await act(async () => { h.store.setRetryError("Not sent — tap to retry"); });
    await act(async () => { h.store.finishStream("done"); });
    const kept = h.store.messages.find((m) => m.role === "error" && m.text.includes("Not sent"));
    assert.ok(kept, "non-timeout error rows must be preserved");
  } finally {
    await h.unmount();
  }
});

test("sweep also runs on error completions", async () => {
  const h = setup();
  await h.mount();
  try {
    await act(async () => { h.store.setBusy(true); });
    const [[id]] = [...h.timers].filter(([, t]) => t.ms === 60000);
    await h.fire(id);
    assert.ok(timeoutRow(h.store), "timeout must leave the error row");
    // Turn completes with an error status — the stall still resolved.
    await act(async () => { h.store.finishStream("", true); });
    assert.equal(timeoutRow(h.store), undefined,
      "error completion must also sweep the stale timeout error");
  } finally {
    await h.unmount();
  }
});
