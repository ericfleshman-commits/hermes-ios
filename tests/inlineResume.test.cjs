const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Faster reconnect handshake: POST /api/auth/ws-ticket?session_id= can carry
// the session.resume payload inline as session_resume (the exact JSON-RPC
// response object). The app consumes it to skip the resume RPC, then attaches
// a transport via session.activate (required for prompt.submit steering and
// server->client events) in parallel with the REST tail fetch.
//
// These tests pin: (a) inline resume consumed (no resume RPC, activate
// called, state from the inline result), (b) old backend without
// session_resume (resume RPC called, no activate), (c) tail fired in parallel
// with activate, (d) cold path stays sequential, (e) reaped activate falls
// back to the full resume RPC, (f) forSessionId mismatch ignores the inline
// result, (g) a 404/422 mint retries clean without session_id.

// ---------------------------------------------------------------------------
// Part 1: the ticket mint (src/lib/auth.ts)
// ---------------------------------------------------------------------------

function loadAuth({ fetchImpl, secureStore }) {
  const exports = {};
  const timers = new Map();
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync('src/lib/auth.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText,
    {
      exports,
      fetch: fetchImpl,
      Headers,
      AbortController,
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
        if (name === 'expo-secure-store')
          return {
            getItemAsync: async (k) => secureStore?.get(k) ?? null,
            setItemAsync: async (k, v) => {
              secureStore?.set(k, v);
            },
          };
        throw Error('Unexpected import ' + name);
      },
    },
  );
  return exports;
}

const INLINE_RESULT = {
  session_id: 'live-999',
  stored_session_id: 'sess-durable',
  running: false,
  info: { model: 'model-a', provider: 'prov-b' },
};

function mintServer({ onMint, resume }) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (onMint) {
      const r = onMint(String(url));
      if (r) return r;
    }
    // Like the real backend: session_resume is only present when the mint
    // carried a session_id.
    const withResume = resume !== undefined && String(url).includes('session_id=');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ticket: 't-' + urls.length,
        ttl_seconds: 30,
        ...(withResume ? { session_resume: resume } : {}),
      }),
    };
  };
  return { fetchImpl, urls };
}

test('getWsTicket passes session_id and returns the inline resume bundle', async () => {
  const srv = mintServer({ resume: { id: 'r1', result: INLINE_RESULT } });
  const auth = loadAuth({ fetchImpl: srv.fetchImpl });
  const bundle = await auth.getWsTicket('sess 1/2');
  assert.equal(bundle.ticket, 't-1');
  assert.ok(
    srv.urls[0].includes('session_id=sess%201%2F2'),
    'the session id is url-encoded on the mint URL: ' + srv.urls[0],
  );
  assert.deepEqual(bundle.sessionResume, { id: 'r1', result: INLINE_RESULT });
  assert.equal(bundle.forSessionId, 'sess 1/2');
});

test('getWsTicket without a session id mints the legacy shape (old backend)', async () => {
  const srv = mintServer({ resume: undefined });
  const auth = loadAuth({ fetchImpl: srv.fetchImpl });
  const bundle = await auth.getWsTicket();
  assert.equal(bundle.ticket, 't-1');
  assert.equal(bundle.sessionResume, undefined);
  assert.ok(!srv.urls[0].includes('session_id'), 'no param without a session id');
});

test('a 404 on the inline mint re-mints clean without session_id', async () => {
  const srv = mintServer({
    onMint: (url) =>
      url.includes('session_id=')
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ ticket: 't-clean' }) },
  });
  const auth = loadAuth({ fetchImpl: srv.fetchImpl });
  const bundle = await auth.getWsTicket('gone-session');
  assert.equal(srv.urls.length, 2, 'exactly one retry');
  assert.ok(srv.urls[0].includes('session_id=gone-session'));
  assert.ok(!srv.urls[1].includes('session_id'), 'the retry mints without the param');
  assert.equal(bundle.ticket, 't-clean');
  assert.equal(bundle.sessionResume, undefined);
});

test('a 422 on the inline mint re-mints clean without session_id', async () => {
  const srv = mintServer({
    onMint: (url) =>
      url.includes('session_id=')
        ? { ok: false, status: 422, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ ticket: 't-clean' }) },
  });
  const auth = loadAuth({ fetchImpl: srv.fetchImpl });
  const bundle = await auth.getWsTicket('gone-session');
  assert.equal(srv.urls.length, 2);
  assert.equal(bundle.ticket, 't-clean');
});

test('session_resume carrying an error payload is treated as absent', async () => {
  const srv = mintServer({ resume: { id: 'r1', error: { code: 4007, message: 'session not found' } } });
  const auth = loadAuth({ fetchImpl: srv.fetchImpl });
  const bundle = await auth.getWsTicket('sess-durable');
  assert.equal(bundle.ticket, 't-1');
  assert.equal(bundle.sessionResume, undefined, 'an error resume must not be consumed');
});

test('prefetch learns the stored session id and warms the bundle', async () => {
  const secureStore = new Map([
    ['hermes.m.selection.v1', JSON.stringify({ sessionId: 'sess-durable', title: 'T' })],
  ]);
  const srv = mintServer({ resume: { id: 'r1', result: INLINE_RESULT } });
  const auth = loadAuth({ fetchImpl: srv.fetchImpl, secureStore });
  await auth.prefetchWsTicket();
  assert.ok(srv.urls[0].includes('session_id=sess-durable'), 'prefetch mints with the stored id');
  const warm = auth.takeWarmTicket();
  assert.equal(warm.ticket, 't-1');
  assert.equal(warm.forSessionId, 'sess-durable');
  assert.deepEqual(warm.sessionResume, { id: 'r1', result: INLINE_RESULT });
});

test('prefetch with no stored session mints a plain ticket (cold boot)', async () => {
  const srv = mintServer({ resume: { id: 'r1', result: INLINE_RESULT } });
  const auth = loadAuth({ fetchImpl: srv.fetchImpl, secureStore: new Map() });
  await auth.prefetchWsTicket();
  assert.ok(!srv.urls[0].includes('session_id'), 'no session id on a cold boot');
  const warm = auth.takeWarmTicket();
  assert.equal(warm.sessionResume, undefined, 'nothing inline to consume');
});

// ---------------------------------------------------------------------------
// Part 2: the session layer (src/hooks/useSessionStore.ts)
// ---------------------------------------------------------------------------

// useState call order in the hook source; lets the tests observe which state
// each setter wrote.
const SETTER_NAMES = [
  'activeSession',
  'draftSessionId',
  'activeTitle',
  'sessions',
  'model',
  'provider',
  'loadingSession',
  'loadError',
  'drawerOpen',
  'sessionFilter',
  'refreshingSessions',
  'modelOptions',
  'pickerOpen',
  'expandedProv',
  'switching',
];

function loadSessionStore({ storage, gwRequest, fetchJSONImpl, options = {} }) {
  const effects = [];
  const setCalls = [];
  const warns = [];
  let setterIdx = 0;
  const react = {
    useState: (value) => {
      const name = SETTER_NAMES[setterIdx++] || `unknown${setterIdx}`;
      return [value, (v) => setCalls.push([name, v])];
    },
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: (fn) => effects.push(fn),
  };
  const exports = {};
  const imports = {
    react,
    'react-native': { Alert: { alert: () => {} } },
    'expo-secure-store': {
      getItemAsync: async (key) => storage.get(key) || null,
      setItemAsync: async (key, value) => storage.set(key, value),
      deleteItemAsync: async (key) => storage.delete(key),
    },
    '../lib/auth': { fetchJSON: fetchJSONImpl },
    '../lib/sessionListCache': { loadSessionList: async () => [], saveSessionList: () => {} },
    '../lib/transcriptCache': {
      loadTranscript: async () => null,
      saveTranscript: async () => {},
    },
    '../lib/sessionList': (() => {
      const mod = {};
      vm.runInNewContext(
        ts.transpileModule(fs.readFileSync('src/lib/sessionList.ts', 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText,
        { exports: mod },
      );
      return mod;
    })(),
    '../lib/sessionFence': (() => {
      const mod = {};
      vm.runInNewContext(
        ts.transpileModule(fs.readFileSync('src/lib/sessionFence.ts', 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText,
        { exports: mod },
      );
      return mod;
    })(),
    './useChatStore': { mapServerMessages: (rows) => rows, uid: () => 'test-id' },
  };
  imports['../lib/modelPrefs'] = (() => {
    const mod = {};
    vm.runInNewContext(
      ts.transpileModule(fs.readFileSync('src/lib/modelPrefs.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText,
      { exports: mod, require: (name) => imports[name] },
    );
    return mod;
  })();
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync('src/hooks/useSessionStore.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      require: (name) => {
        if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
        return imports[name];
      },
      console: { warn: (...a) => warns.push(a), log: () => {}, error: () => {} },
    },
  );
  const store = exports.useSessionStore(options);
  effects.splice(0).forEach((fn) => fn());
  return { store, setCalls, warns };
}

function testStore({ rpcImpl, restImpl, options = {} }) {
  const storage = new Map([
    ['hermes.m.selection.v1', JSON.stringify({ sessionId: 'sess-durable', title: 'T' })],
  ]);
  const rpcCalls = [];
  const restCalls = [];
  const synced = [];
  const checked = [];
  const activeSessionRef = { current: '' };
  const gwRef = {
    current: {
      request: async (method, params, timeout) => {
        rpcCalls.push({ method, params, timeout });
        return rpcImpl(method, params, timeout);
      },
    },
  };
  const { store, setCalls, warns } = loadSessionStore({
    storage,
    gwRequest: gwRef.current.request,
    fetchJSONImpl: async (path) => {
      restCalls.push(path);
      return restImpl ? restImpl(path) : { messages: [{ id: 'm1' }] };
    },
    options: {
      gwRef,
      activeSessionRef,
      onSyncMessages: (msgs, sid) => synced.push({ msgs, sid }),
      onCheckTail: (tail, sid) => checked.push({ tail, sid }),
      ...options,
    },
  });
  return { store, storage, rpcCalls, restCalls, synced, checked, activeSessionRef, setCalls, warns };
}

const BUNDLE = {
  ticket: 't-1',
  forSessionId: 'sess-durable',
  sessionResume: { id: 'r1', result: INLINE_RESULT },
};

test('restoreSession consumes the inline resume: no resume RPC, activate called, state from inline', async () => {
  const t = testStore({
    rpcImpl: (method) => {
      if (method === 'session.activate') return {};
      throw new Error('session.resume must not be called on the fast path');
    },
  });
  await t.store.restoreSession(BUNDLE);
  assert.deepEqual(
    t.rpcCalls.map((c) => c.method),
    ['session.activate'],
    'the resume RPC is skipped',
  );
  assert.equal(t.rpcCalls[0].params.session_id, 'live-999');
  assert.equal(t.rpcCalls[0].params.omit_messages, true);
  assert.equal(t.rpcCalls[0].timeout, 15000);
  assert.equal(t.activeSessionRef.current, 'live-999', 'live id comes from the inline result');
  assert.equal(t.storage.get('hermes.m.storedSession'), 'sess-durable');
  assert.ok(t.setCalls.some(([n, v]) => n === 'model' && v === 'model-a'), 'model from inline info');
  assert.ok(t.setCalls.some(([n, v]) => n === 'provider' && v === 'prov-b'), 'provider from inline info');
  assert.equal(t.restCalls.length, 1, 'the tail is fetched');
  assert.ok(t.restCalls[0].includes('/api/sessions/sess-durable/messages?limit=200'));
  assert.equal(t.synced.length, 1);
  assert.equal(t.synced[0].sid, 'live-999');
});

test('restoreSession with an old-backend bundle (no session_resume) takes the slow path', async () => {
  const t = testStore({
    rpcImpl: (method) => {
      if (method === 'session.resume')
        return { session_id: 'live-rpc', stored_session_id: 'sess-durable', info: { model: 'm', provider: 'p' } };
      throw new Error('session.activate must not be called without an inline resume');
    },
  });
  await t.store.restoreSession({ ticket: 't-1' });
  assert.deepEqual(t.rpcCalls.map((c) => c.method), ['session.resume']);
  assert.equal(t.activeSessionRef.current, 'live-rpc');
});

test('restoreSession fires the tail fetch without awaiting session.activate', async () => {
  let releaseActivate;
  const activateGate = new Promise((r) => {
    releaseActivate = r;
  });
  const t = testStore({
    rpcImpl: (method) => {
      if (method === 'session.activate') return activateGate;
      throw new Error('session.resume must not be called on the fast path');
    },
  });
  const p = t.store.restoreSession(BUNDLE);
  let waited = 0;
  while (t.restCalls.length === 0 && waited < 200) {
    await new Promise((r) => setImmediate(r));
    waited++;
  }
  assert.equal(t.restCalls.length, 1, 'the tail fetch fired while session.activate is still pending');
  releaseActivate({});
  await p;
  assert.deepEqual(t.rpcCalls.map((c) => c.method), ['session.activate']);
});

test('restoreSession with no bundle runs resume RPC then tail, in order', async () => {
  const order = [];
  const t = testStore({
    rpcImpl: (method) => {
      assert.equal(method, 'session.resume');
      order.push('resume');
      return { session_id: 'live-rpc', stored_session_id: 'sess-durable', info: { model: 'm', provider: 'p' } };
    },
    restImpl: (path) => {
      order.push('rest:' + path);
      return { messages: [] };
    },
  });
  await t.store.restoreSession();
  assert.deepEqual(order, [
    'resume',
    'rest:/api/sessions/sess-durable/messages?limit=200&order=latest',
  ]);
});

test('restoreSession falls back to the full resume RPC when session.activate is reaped', async () => {
  const t = testStore({
    rpcImpl: (method) => {
      if (method === 'session.activate') throw new Error('session not found');
      if (method === 'session.resume')
        return {
          session_id: 'live-rpc',
          stored_session_id: 'sess-durable',
          info: { model: 'mr', provider: 'pr' },
        };
      throw new Error('unexpected RPC: ' + method);
    },
  });
  await t.store.restoreSession(BUNDLE);
  assert.deepEqual(t.rpcCalls.map((c) => c.method), ['session.activate', 'session.resume']);
  assert.equal(t.activeSessionRef.current, 'live-rpc', 'state comes from the fallback RPC result');
  assert.ok(t.warns.length > 0, 'the fallback is logged');
});

test('restoreSession ignores the inline resume when forSessionId mismatches', async () => {
  const t = testStore({
    rpcImpl: (method) => {
      if (method === 'session.resume')
        return { session_id: 'live-rpc', stored_session_id: 'sess-durable', info: { model: 'm', provider: 'p' } };
      throw new Error('session.activate must not be called on a forSessionId mismatch');
    },
  });
  await t.store.restoreSession({ ...BUNDLE, forSessionId: 'other-session' });
  assert.deepEqual(t.rpcCalls.map((c) => c.method), ['session.resume']);
  assert.equal(t.activeSessionRef.current, 'live-rpc', 'the inline live id is ignored');
});

test('attachSession consumes the inline resume via the durable-pointer match', async () => {
  const t = testStore({
    rpcImpl: (method) => {
      if (method === 'session.resume')
        return { session_id: 'live-999', stored_session_id: 'sess-durable', info: { model: 'm', provider: 'p' } };
      if (method === 'session.activate') return {};
      throw new Error('unexpected RPC: ' + method);
    },
  });
  // Production sequence: an earlier restore set the live target and the
  // durable pointer; the reconnect mint used the durable id.
  await t.store.restoreSession();
  assert.equal(t.activeSessionRef.current, 'live-999');
  t.rpcCalls.length = 0;
  t.restCalls.length = 0;
  const bundle = {
    ticket: 't-1',
    forSessionId: 'sess-durable',
    sessionResume: {
      id: 'r1',
      result: { session_id: 'live-999', stored_session_id: 'sess-durable', info: { model: 'm', provider: 'p' } },
    },
  };
  await t.store.attachSession(bundle);
  assert.deepEqual(t.rpcCalls.map((c) => c.method), ['session.activate']);
  assert.equal(t.rpcCalls[0].params.session_id, 'live-999');
  assert.equal(t.rpcCalls[0].params.omit_messages, true);
  assert.equal(t.restCalls.length, 1);
  assert.ok(t.restCalls[0].includes('limit=40'), 'attach keeps its 40-message tail');
  assert.equal(t.checked.length, 1);
});

test('attachSession with no bundle takes the slow path', async () => {
  const t = testStore({
    rpcImpl: (method) => {
      if (method === 'session.resume')
        return { session_id: 'live-999', stored_session_id: 'sess-durable', info: { model: 'm', provider: 'p' } };
      throw new Error('session.activate must not be called without an inline resume');
    },
  });
  t.activeSessionRef.current = 'live-999';
  await t.store.attachSession();
  assert.deepEqual(t.rpcCalls.map((c) => c.method), ['session.resume']);
  assert.equal(t.checked.length, 1);
});
