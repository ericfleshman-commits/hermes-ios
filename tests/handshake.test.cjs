const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

// The handshake tightening: a warm WS-ticket cache in src/lib/auth.ts.
// Server tickets are single-use with a 30 s TTL, so the client may mint one
// speculatively and hand it to the next connect attempt inside a 25 s
// freshness window. These tests pin: single-use safety (a ticket is handed
// out at most once), TTL expiry (stale tickets are never presented), mint
// dedupe, and silent failure fallback (a dead mini must not break the
// normal fresh-mint path).

// ---------------------------------------------------------------------------
// Part 1: the auth.ts warm ticket cache
// ---------------------------------------------------------------------------

function loadAuth({ fetchImpl, nowMs = 0 }) {
  const exports = {};
  const timers = new Map();
  let now = nowMs;
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync('src/lib/auth.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText,
    {
      exports,
      fetch: fetchImpl,
      Headers,
      AbortController,
      Date: { now: () => now },
      setTimeout: (fn) => {
        const id = {};
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
      require: (name) => {
        if (name === 'expo-constants')
          return { expoConfig: { extra: { gatewayHost: 'local.invalid' } } };
        throw Error('Unexpected import ' + name);
      },
    },
  );
  return { auth: exports, setNow: (ms) => { now = ms; } };
}

function ticketServer() {
  const s = { calls: 0, failNext: false };
  const fetchImpl = async (url) => {
    s.calls++;
    if (s.failNext) {
      s.failNext = false;
      throw new Error('network down');
    }
    if (String(url).includes('/ws-ticket')) {
      return { ok: true, status: 200, json: async () => ({ ticket: 't-' + s.calls }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fetchImpl, state: s };
}

test('warm ticket is handed out exactly once (single-use safety)', async () => {
  const srv = ticketServer();
  const { auth } = loadAuth({ fetchImpl: srv.fetchImpl });
  await auth.prefetchWsTicket();
  assert.equal(srv.state.calls, 1, 'prefetch mints once');
  assert.equal(auth.takeWarmTicket()?.ticket, 't-1');
  assert.equal(auth.takeWarmTicket(), null, 'a consumed ticket is never handed out twice');
  assert.equal(auth.takeWarmTicket(), null);
});

test('expired warm ticket is never handed out', async () => {
  const srv = ticketServer();
  const { auth, setNow } = loadAuth({ fetchImpl: srv.fetchImpl });
  await auth.prefetchWsTicket();
  setNow(25_000);
  assert.equal(auth.takeWarmTicket(), null, 'a ticket at the 25 s freshness boundary is stale');
  setNow(60_000);
  assert.equal(auth.takeWarmTicket(), null);
});

test('ticket just inside the freshness window is still handed out', async () => {
  const srv = ticketServer();
  const { auth, setNow } = loadAuth({ fetchImpl: srv.fetchImpl });
  await auth.prefetchWsTicket();
  setNow(24_999);
  assert.equal(auth.takeWarmTicket()?.ticket, 't-1', '24.999 s is still fresh');
});

test('concurrent prefetches share a single mint', async () => {
  const srv = ticketServer();
  const { auth } = loadAuth({ fetchImpl: srv.fetchImpl });
  await Promise.all([auth.prefetchWsTicket(), auth.prefetchWsTicket(), auth.prefetchWsTicket()]);
  assert.equal(srv.state.calls, 1, 'one mint for three concurrent prefetches');
  assert.equal(auth.takeWarmTicket()?.ticket, 't-1');
});

test('a fresh cached ticket is never re-minted', async () => {
  const srv = ticketServer();
  const { auth } = loadAuth({ fetchImpl: srv.fetchImpl });
  await auth.prefetchWsTicket();
  await auth.prefetchWsTicket();
  assert.equal(srv.state.calls, 1, 'second prefetch reuses the warm ticket');
});

test('prefetch failure is silent and the fallback mint still works', async () => {
  const srv = ticketServer();
  const { auth } = loadAuth({ fetchImpl: srv.fetchImpl });
  srv.state.failNext = true;
  await auth.prefetchWsTicket(); // must resolve, not throw
  assert.equal(auth.takeWarmTicket(), null, 'a failed mint leaves nothing warm');
  // The normal on-demand path is unaffected by the failed prefetch.
  assert.equal((await auth.getWsTicket()).ticket, 't-2');
  await auth.prefetchWsTicket();
  assert.equal(auth.takeWarmTicket()?.ticket, 't-3', 'prefetch recovers after a failure');
});

test('takeWarmTicket on an empty cache returns null without throwing', async () => {
  const srv = ticketServer();
  const { auth } = loadAuth({ fetchImpl: srv.fetchImpl });
  assert.equal(auth.takeWarmTicket(), null);
});

// ---------------------------------------------------------------------------
// Part 2: useHermesSocket consumes the warm ticket
// ---------------------------------------------------------------------------

function setupHook() {
  const timers = new Map();
  let seq = 0;
  const fakeSetTimeout = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { fn, ms });
    return id;
  };
  const fakeClearTimeout = (id) => {
    timers.delete(id);
  };
  const clients = [];
  const authState = { mintCalls: 0, prefetchCalls: 0, warmAvailable: false };
  const authStub = {
    HOST: 'example.test',
    state: authState,
    getWsTicket: async () => {
      authState.mintCalls++;
      return { ticket: 'fresh-' + authState.mintCalls };
    },
    readStoredSessionId: async () => undefined,
    prefetchWsTicket: async () => {
      authState.prefetchCalls++;
      authState.warmAvailable = true;
    },
    takeWarmTicket: () => {
      if (!authState.warmAvailable) return null;
      authState.warmAvailable = false; // single-use: consumed on handoff
      return { ticket: 'warm-abc' };
    },
  };
  const AppState = {
    currentState: 'active',
    addEventListener: () => ({ remove() {} }),
  };
  class GatewayClient {
    constructor(url) {
      this.url = url;
      this.state = 'idle';
      clients.push(this);
    }
    onState(fn) {
      this.onChange = fn;
    }
    on() {}
    off() {}
    async connect() {
      this.state = 'connecting';
      this.onChange('connecting');
      await Promise.resolve();
      this.state = 'open';
      this.onChange('open');
    }
    async request() {
      return {};
    }
    disconnect() {
      this.state = 'closed';
      this.onChange('closed');
    }
  }
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync('src/hooks/useHermesSocket.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      require(id) {
        if (id === 'react') return React;
        if (id === 'react-native') return { AppState };
        if (id === '../lib/gateway') return { GatewayClient };
        if (id === '../lib/auth') return authStub;
        throw new Error(`unexpected import: ${id}`);
      },
      console,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      Promise,
    },
  );
  let hook;
  function Probe() {
    hook = exports.useHermesSocket({});
    return null;
  }
  return {
    timers,
    clients,
    authState,
    get hook() {
      return hook;
    },
    async mount() {
      let root;
      await act(async () => {
        root = create(React.createElement(Probe));
      });
      this.root = root;
    },
    async unmount() {
      await act(async () => {
        this.root.unmount();
      });
    },
    async fire(id) {
      const t = timers.get(id);
      assert.ok(t, 'timer missing');
      timers.delete(id);
      await act(async () => {
        t.fn();
      });
      await act(async () => {});
    },
  };
}

test('connectGateway consumes a warm ticket and skips the mint', async () => {
  const h = setupHook();
  h.authState.warmAvailable = true; // a prefetch landed before the connect
  await h.mount();
  try {
    await act(async () => {
      await h.hook.connectGateway();
    });
    assert.equal(h.hook.conn, 'open');
    assert.equal(h.authState.mintCalls, 0, 'no HTTPS mint when a warm ticket exists');
    assert.match(h.clients[0].url, /ticket=warm-abc/, 'the warm ticket is dialed');
    assert.equal(h.authState.warmAvailable, false, 'the ticket was consumed');
  } finally {
    await h.unmount();
  }
});

test('a scheduled retry reuses the prefetched ticket: one mint for two dials', async () => {
  const h = setupHook();
  await h.mount();
  try {
    await act(async () => {
      await h.hook.connectGateway();
    });
    assert.equal(h.hook.conn, 'open');
    assert.equal(h.authState.mintCalls, 1, 'first dial mints fresh');
    assert.match(h.clients[0].url, /ticket=fresh-1/);
    // The socket drops: the scheduler arms a retry and prefetches its ticket.
    await act(async () => {
      h.clients[0].onChange('closed');
    });
    assert.equal(h.timers.size, 1, 'exactly one retry scheduled (unchanged behavior)');
    assert.equal(h.authState.prefetchCalls, 1, 'the retry prefetches exactly one ticket');
    const [id] = [...h.timers.keys()];
    await h.fire(id);
    assert.equal(h.hook.conn, 'open');
    assert.equal(h.clients.length, 2, 'the retry dials');
    assert.match(h.clients[1].url, /ticket=warm-abc/, 'the retry skips the mint');
    assert.equal(h.authState.mintCalls, 1, 'still one mint total for two dials');
  } finally {
    await h.unmount();
  }
});

test('foreground zombie probe prefetches in parallel without disturbing a healthy socket', async () => {
  const h = setupHook();
  await h.mount();
  try {
    await act(async () => {
      await h.hook.connectGateway();
    });
    assert.equal(h.hook.conn, 'open');
    await act(async () => {
      h.hook.reconnectNow();
    });
    await act(async () => {});
    assert.equal(h.authState.prefetchCalls, 1, 'the probe mints a ticket in parallel');
    assert.equal(h.clients.length, 1, 'a healthy socket is not redialed');
    assert.equal(h.hook.conn, 'open');
  } finally {
    await h.unmount();
  }
});

test('an empty warm cache falls back to the fresh mint path', async () => {
  const h = setupHook();
  await h.mount();
  try {
    await act(async () => {
      await h.hook.connectGateway();
    });
    assert.equal(h.authState.mintCalls, 1);
    assert.match(h.clients[0].url, /ticket=fresh-1/);
  } finally {
    await h.unmount();
  }
});
