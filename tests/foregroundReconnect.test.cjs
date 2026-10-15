const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

// Regression tests for the foreground "Offline" symptom: backgrounding the
// app and returning must reconnect immediately (no waiting out a backoff
// timer), a zombie socket must be probed instead of trusted, and the pill
// must read Connecting — not red Offline — while a retry is scheduled.
function setup() {
  const timers = new Map();
  let seq = 0;
  const fakeSetTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  const clients = [];
  const flags = { ticketFails: false, failConnect: false };
  let tickets = 0;
  let holdTickets = false;
  const pendingTickets = [];
  let onAppState;
  const AppState = {
    currentState: 'active',
    addEventListener: (_event, fn) => {
      onAppState = fn;
      return { remove() { if (onAppState === fn) onAppState = undefined; } };
    },
  };
  // Mirrors the real GatewayClient's synchronous state machine: setState
  // updates this.state and notifies handlers together, so gw.state never
  // disagrees with what the hook saw.
  class GatewayClient {
    constructor(url) {
      this.url = url;
      this.state = 'idle';
      this.disconnects = 0;
      this.pings = [];
      clients.push(this);
    }
    onState(fn) { this.onChange = fn; }
    on() {}
    off() {}
    setState(s) { this.state = s; this.onChange(s); }
    async connect() {
      this.setState('connecting');
      await Promise.resolve();
      if (flags.failConnect) {
        this.setState('error');
        throw new Error('ws error');
      }
      this.setState('open');
    }
    request(method, params, timeoutMs) {
      this.pings.push({ method, params, timeoutMs });
      return new Promise((resolve, reject) => { this.pingSettle = { resolve, reject }; });
    }
    disconnect() {
      this.disconnects++;
      this.setState('closed');
    }
  }
  const hookModule = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/hooks/useHermesSocket.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: hookModule,
    require(id) {
      if (id === 'react') return React;
      if (id === 'react-native') return { AppState };
      if (id === '../lib/gateway') return { GatewayClient };
      if (id === '../lib/auth') return {
        HOST: 'example.test',
        getWsTicket: () => {
          tickets++;
          if (flags.ticketFails) return Promise.reject(new Error('down'));
          if (holdTickets) return new Promise((res) => pendingTickets.push(res));
          return Promise.resolve({ ticket: 't' });
        },
        readStoredSessionId: async () => undefined,
        prefetchWsTicket: async () => {},
        takeWarmTicket: () => null,
      };
      throw new Error(`unexpected import: ${id}`);
    },
    console, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, Promise,
  });
  let hook;
  function Probe() { hook = hookModule.useHermesSocket({}); return null; }
  return {
    timers, clients, flags, hookModule,
    get hook() { return hook; },
    get tickets() { return tickets; },
    set holdTickets(v) { holdTickets = v; },
    releaseTickets() { while (pendingTickets.length) pendingTickets.shift()({ ticket: 't' }); },
    delays() { return [...timers.values()].map((t) => t.ms); },
    async mount() {
      let root;
      await act(async () => { root = create(React.createElement(Probe)); });
      this.root = root;
    },
    async unmount() { await act(async () => { this.root.unmount(); }); },
    async fire(id) {
      const t = timers.get(id);
      assert.ok(t, 'timer missing');
      timers.delete(id);
      await act(async () => { t.fn(); });
      await act(async () => {});
    },
    async foreground() {
      await act(async () => { onAppState('background'); onAppState('active'); });
      await act(async () => {});
    },
    async appState(next) {
      await act(async () => { onAppState(next); });
    },
  };
}

test('a connect already reads Connecting while the ws ticket is still being fetched', async () => {
  const h = setup();
  await h.mount();
  try {
    h.holdTickets = true;
    let p;
    act(() => { p = h.hook.connectGateway(); });
    // The ticket fetch can take seconds on a waking radio; the pill must
    // flip to Connecting immediately instead of sitting on red Offline.
    assert.equal(h.hook.conn, 'connecting');
    assert.equal(h.hook.retryScheduled, false);
    assert.equal(h.hookModule.pillStatus(h.hook.conn, h.hook.retryScheduled), 'connecting');
    // The mint awaits the stored session id before the HTTPS mint starts, so
    // the fetch is one microtask behind the synchronous act() above: let it
    // get in flight before releasing the held mint.
    await act(async () => {});
    h.releaseTickets();
    await act(async () => { await p; });
    assert.equal(h.hook.conn, 'open');
  } finally {
    await h.unmount();
  }
});

test('foreground reconnects immediately and resets the backoff counter', async () => {
  const h = setup();
  h.flags.failConnect = true;
  await h.mount();
  try {
    await act(async () => { await h.hook.connectGateway(); });
    assert.equal(h.hook.conn, 'error');
    // Grow the backoff the way flaky cellular does: three failures.
    for (let i = 0; i < 2; i++) {
      const [id] = [...h.timers.keys()];
      await h.fire(id);
    }
    const [grown] = h.delays();
    assert.ok(grown >= 4000 && grown <= 8000, `backoff must have grown to attempt 3, got ${grown}`);
    // Returning to the app must NOT wait out that scheduled timer. Hold the
    // ticket so the transient Connecting state stays observable.
    const ticketsBefore = h.tickets;
    h.holdTickets = true;
    await h.appState('background');
    await h.appState('active');
    assert.equal(h.timers.size, 0, 'the scheduled retry is cancelled on foreground');
    assert.equal(h.tickets, ticketsBefore + 1, 'a fresh ticket fetch starts immediately, not via the timer');
    assert.equal(h.hook.conn, 'connecting', 'pill flips to Connecting at once');
    assert.equal(h.hook.retryScheduled, false);
    // Let the fresh attempt run: it fails too, and the retry must be
    // attempt 1 again — the foreground reset the counter.
    const clientsBefore = h.clients.length;
    h.holdTickets = false;
    h.releaseTickets();
    await act(async () => {});
    assert.equal(h.clients.length, clientsBefore + 1, 'the foreground connect creates its socket');
    const [delay] = h.delays();
    assert.ok(delay >= 1000 && delay <= 2000, `backoff must reset to attempt 1, got ${delay}`);
    assert.equal(h.hook.retryScheduled, true);
    assert.equal(
      h.hookModule.pillStatus(h.hook.conn, h.hook.retryScheduled),
      'connecting',
      'a scheduled retry reads Connecting, not Offline',
    );
  } finally {
    await h.unmount();
  }
});

test('a zombie socket is probed on foreground, not trusted and not killed blindly', async () => {
  const h = setup();
  await h.mount();
  try {
    await act(async () => { await h.hook.connectGateway(); });
    assert.equal(h.hook.conn, 'open');
    const zombie = h.clients[0];
    await h.foreground();
    // Probe first: a healthy-but-slow socket must not be retired.
    assert.equal(zombie.pings.length, 1, 'the open socket gets exactly one health probe');
    assert.equal(zombie.pings[0].method, 'gateway.ping');
    assert.ok(zombie.pings[0].timeoutMs >= 3000, 'the probe must tolerate wake-up network jitter');
    assert.equal(zombie.disconnects, 0, 'no reconnect while the probe is still in flight');
    assert.equal(h.clients.length, 1, 'no replacement socket before the probe settles');
    // The probe proves the socket dead: retire it and reconnect at once.
    const before = h.tickets;
    await act(async () => { zombie.pingSettle.reject(new Error('request timeout')); });
    await act(async () => {});
    // Retired twice, by design: once immediately so nothing tries to send
    // on the dead socket during the ticket fetch, once by connectGateway's
    // standard cleanup — the second retire is a no-op (generation guard).
    assert.equal(zombie.disconnects, 2, 'the proven-dead socket is retired');
    assert.equal(h.clients.length, 2, 'reconnect starts immediately after the failed probe');
    assert.ok(h.tickets > before, 'the replacement connect fetches a fresh ticket');
    assert.equal(h.hook.conn, 'open', 'the replacement socket connects');
    assert.equal(h.timers.size, 0, 'a healthy socket arms no retry');
  } finally {
    await h.unmount();
  }
});

test('pillStatus reserves red Offline for a socket that is down and not being retried', () => {
  const { pillStatus } = setup().hookModule;
  assert.equal(pillStatus('open', false), 'live');
  assert.equal(pillStatus('open', true), 'live');
  assert.equal(pillStatus('idle', false), 'connecting');
  assert.equal(pillStatus('connecting', false), 'connecting');
  assert.equal(pillStatus('connecting', true), 'connecting');
  assert.equal(pillStatus('closed', true), 'connecting');
  assert.equal(pillStatus('error', true), 'connecting');
  assert.equal(pillStatus('closed', false), 'offline');
  assert.equal(pillStatus('error', false), 'offline');
});

test('the scheduler gives up after MAX attempts and foreground starts it over', async () => {
  const h = setup();
  h.flags.ticketFails = true;
  await h.mount();
  try {
    await act(async () => { await h.hook.connectGateway(); });
    assert.equal(h.hook.conn, 'error');
    assert.equal(h.hook.retryScheduled, true);
    assert.equal(h.hookModule.pillStatus(h.hook.conn, h.hook.retryScheduled), 'connecting');
    // Ten more failures: attempts 2..11. Attempt 11 trips the give-up.
    for (let i = 0; i < 10; i++) {
      const [id] = [...h.timers.keys()];
      await h.fire(id);
    }
    assert.equal(h.timers.size, 0, 'no retry scheduled after the attempts are exhausted');
    assert.equal(h.hook.retryScheduled, false);
    assert.equal(h.hook.conn, 'error');
    assert.equal(
      h.hookModule.pillStatus(h.hook.conn, h.hook.retryScheduled),
      'offline',
      'an exhausted socket honestly reads Offline',
    );
    // Returning to the app resets the counter and tries again.
    h.flags.ticketFails = false;
    const before = h.tickets;
    await h.foreground();
    assert.ok(h.tickets > before, 'foreground reconnects even after give-up');
    assert.equal(h.hook.conn, 'open');
  } finally {
    await h.unmount();
  }
});

test('an intentional disconnect reads Offline with no retry scheduled', async () => {
  const h = setup();
  await h.mount();
  try {
    await act(async () => { await h.hook.connectGateway(); });
    assert.equal(h.hook.conn, 'open');
    await act(async () => { h.hook.disconnect(); });
    assert.equal(h.hook.conn, 'closed');
    assert.equal(h.hook.retryScheduled, false);
    assert.equal(h.timers.size, 0);
    assert.equal(
      h.hookModule.pillStatus(h.hook.conn, h.hook.retryScheduled),
      'offline',
      'a user-stopped socket honestly reads Offline',
    );
  } finally {
    await h.unmount();
  }
});
