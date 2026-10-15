const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

// The single reconnect scheduler: one timer, exponential backoff with
// jitter, one stop rule (intentional disconnect). A failed attempt must
// always arm the next one — even when setConn("error") is a no-op because
// the banner already shows it (the old stall).
function setup({ ticketFails = false } = {}) {
  const timers = new Map();
  let seq = 0;
  const fakeSetTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  const clients = [];
  let tickets = 0;
  const AppState = {
    currentState: 'active',
    addEventListener: () => ({ remove() {} }),
  };
  class GatewayClient {
    constructor(url) { this.url = url; this.state = 'idle'; this.disconnects = 0; clients.push(this); }
    onState(fn) { this.onChange = fn; }
    on() {}
    off() {}
    async connect() {
      this.state = 'connecting';
      this.onChange('connecting');
      await Promise.resolve();
      if (this.shouldFail) {
        // Mirrors the real client: state handlers fire before the throw,
        // so the failure schedules exactly once via onState.
        this.state = 'error';
        this.onChange('error');
        throw new Error('ws error');
      }
      this.state = 'open';
      this.onChange('open');
    }
    async request() { return {}; }
    disconnect() {
      this.disconnects++;
      this.state = 'closed';
      // The real client still emits closed on disconnect; the hook's
      // generation guard must ignore it when stale.
      this.onChange('closed');
    }
  }
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/hooks/useHermesSocket.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require(id) {
      if (id === 'react') return React;
      if (id === 'react-native') return { AppState };
      if (id === '../lib/gateway') return { GatewayClient };
      if (id === '../lib/auth') return {
        HOST: 'example.test',
        getWsTicket: async () => { tickets++; if (ticketFails) throw new Error('down'); return { ticket: 't' }; },
        readStoredSessionId: async () => undefined,
        prefetchWsTicket: async () => {},
        takeWarmTicket: () => null,
      };
      throw new Error(`unexpected import: ${id}`);
    },
    console, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, Promise,
  });
  let hook;
  function Probe() { hook = exports.useHermesSocket({}); return null; }
  return {
    timers, clients,
    get hook() { return hook; },
    get tickets() { return tickets; },
    delays() { return [...timers.values()].map((t) => t.ms); },
    async mount() {
      let root;
      await act(async () => { root = create(React.createElement(Probe)); });
      this.root = root;
    },
    async unmount() { await act(async () => { this.root.unmount(); }); },
    // Fire a timer like the real runtime would (removed before invoking).
    async fire(id) {
      const t = timers.get(id);
      assert.ok(t, 'timer missing');
      timers.delete(id);
      await act(async () => { t.fn(); });
      await act(async () => {});
    },
  };
}

test('a dropped socket schedules one reconnect with jittered backoff', async () => {
  const h = setup();
  await h.mount();
  try {
    await act(async () => { await h.hook.connectGateway(); });
    assert.equal(h.hook.conn, 'open');
    assert.equal(h.timers.size, 0, 'no timer while healthy');
    // The backend drops the socket: the client reports closed.
    await act(async () => { h.clients[0].onChange('closed'); });
    assert.equal(h.hook.conn, 'closed');
    assert.equal(h.timers.size, 1, 'exactly one reconnect scheduled');
    const [delay] = h.delays();
    assert.ok(delay >= 1000 && delay <= 2000, `attempt 1 must land in [1000,2000], got ${delay}`);
    const before = h.clients.length;
    const [id] = [...h.timers.keys()];
    await h.fire(id);
    assert.equal(h.clients.length, before + 1, 'firing the timer reconnects');
    assert.equal(h.hook.conn, 'open');
    assert.equal(h.timers.size, 0, 'a healthy socket arms nothing');
  } finally {
    await h.unmount();
  }
});

test('a failed ticket fetch re-arms instead of stalling on a no-op setConn', async () => {
  const h = setup({ ticketFails: true });
  await h.mount();
  try {
    await act(async () => { await h.hook.connectGateway(); });
    assert.equal(h.hook.conn, 'error');
    assert.equal(h.tickets, 1);
    assert.equal(h.timers.size, 1, 'first failure must schedule a retry');
    // Second failure: conn is already "error", so setConn is a no-op — the
    // old code stalled here with no timer armed.
    const [id1] = [...h.timers.keys()];
    await h.fire(id1);
    assert.equal(h.tickets, 2, 'the retry must actually run');
    assert.equal(h.timers.size, 1, 'the second failure must re-arm');
    const [delay] = h.delays();
    assert.ok(delay >= 2000 && delay <= 4000, `attempt 2 must land in [2000,4000], got ${delay}`);
  } finally {
    await h.unmount();
  }
});

test('backoff grows across consecutive failures', async () => {
  const h = setup({ ticketFails: true });
  await h.mount();
  try {
    const seen = [];
    await act(async () => { await h.hook.connectGateway(); });
    for (let i = 0; i < 3; i++) {
      const [id] = [...h.timers.keys()];
      const [delay] = h.delays();
      seen.push(delay);
      await h.fire(id);
    }
    assert.ok(seen[0] >= 1000 && seen[0] <= 2000, `attempt 1 range, got ${seen[0]}`);
    assert.ok(seen[1] >= 2000 && seen[1] <= 4000, `attempt 2 range, got ${seen[1]}`);
    assert.ok(seen[2] >= 4000 && seen[2] <= 8000, `attempt 3 range, got ${seen[2]}`);
  } finally {
    await h.unmount();
  }
});

test('an intentional disconnect never resurrects', async () => {
  const h = setup();
  await h.mount();
  try {
    await act(async () => { await h.hook.connectGateway(); });
    assert.equal(h.hook.conn, 'open');
    await act(async () => { h.hook.disconnect(); });
    assert.equal(h.hook.conn, 'closed');
    assert.equal(h.timers.size, 0, 'intentional disconnect arms nothing');
    assert.equal(h.clients.length, 1, 'no replacement socket may be created');
    // A later manual connect still works: it lifts the intentional stop.
    await act(async () => { await h.hook.connectGateway(); });
    assert.equal(h.hook.conn, 'open');
    assert.equal(h.clients.length, 2);
  } finally {
    await h.unmount();
  }
});

test('a stale client close cannot schedule or disturb the replacement', async () => {
  const h = setup();
  await h.mount();
  try {
    await act(async () => { await h.hook.connectGateway(); });
    const first = h.clients[0];
    // Drop, then reconnect manually before the timer fires.
    await act(async () => { first.onChange('closed'); });
    assert.equal(h.timers.size, 1);
    await act(async () => { await h.hook.connectGateway(); });
    assert.equal(h.hook.conn, 'open');
    const live = h.clients[h.clients.length - 1];
    assert.equal(h.timers.size, 0, 'manual connect cancels the scheduled retry');
    // The dead socket's late close must be ignored (generation guard).
    await act(async () => { first.disconnect(); });
    assert.equal(h.hook.conn, 'open', 'stale close must not touch the live socket');
    assert.equal(live.disconnects, 0, 'the replacement must never be retired by the stale one');
    assert.equal(h.timers.size, 0, 'stale close must not schedule a reconnect');
  } finally {
    await h.unmount();
  }
});
