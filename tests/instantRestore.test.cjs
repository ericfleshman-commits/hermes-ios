const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Tests for the two build-137 follow-up fixes in useSessionStore:
//
// FIX 1 - instant boot from cache: when showCachedSession already rendered
// the boot cache, restoreSession must NOT raise the blocking "Loading
// history..." bar. It rehydrates silently in the background and merges when
// the network rows arrive. No cache (first run / miss) keeps the bar.
//
// FIX 2 - restore dedupe: a socket reconnect racing an in-flight restore must
// not start a duplicate restoreSession (duplicate 200-message fetch + stuck
// spinner). restoreInflightRef makes the racing call a safe no-op; once
// session.resume has set the live id, App.tsx's existing
// `opts?.attachOnly && activeSessionRef.current` branch routes to the
// lightweight attachSession (verified by reading src/App.tsx).

function loadSessionStore(storage, extra = {}) {
  const slots = [];
  const effects = [];
  const react = {
    useState: (initial) => {
      const slot = { v: initial, sets: [] };
      slots.push(slot);
      const set = (u) => { slot.v = typeof u === 'function' ? u(slot.v) : u; slot.sets.push(slot.v); };
      return [slot.v, set];
    },
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: (fn) => effects.push(fn),
  };
  const exports = {};
  const real = (file) => {
    const mod = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports: mod, require: (name) => imports[name] });
    return mod;
  };
  const imports = {
    react,
    'react-native': { Alert: { alert: () => {} } },
    'expo-secure-store': {
      getItemAsync: async (key) => storage.get(key) || null,
      setItemAsync: async (key, value) => storage.set(key, value),
      deleteItemAsync: async (key) => storage.delete(key),
    },
    '../lib/auth': { fetchJSON: async () => ({ messages: [] }) },
    '../lib/sessionListCache': { loadSessionList: async () => [], saveSessionList: () => {} },
    '../lib/transcriptCache': { loadTranscript: async () => null, saveTranscript: async () => {} },
    '../lib/sessionList': real('src/lib/sessionList.ts'),
    '../lib/sessionFence': real('src/lib/sessionFence.ts'),
    './useChatStore': { mapServerMessages: (rows) => rows, uid: () => 'test-id' },
    ...extra,
  };
  // modelPrefs imports expo-secure-store: evaluate it only after `imports`
  // exists, or the require closure hits the temporal dead zone.
  imports['../lib/modelPrefs'] = real('src/lib/modelPrefs.ts');
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/hooks/useSessionStore.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require: (name) => {
      if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
      return imports[name];
    },
  });
  const makeStore = (options) => {
    const store = exports.useSessionStore(options);
    effects.splice(0).forEach((fn) => fn());
    return store;
  };
  const loadingWasRaised = () => slots.some((s) => s.sets.includes(true));
  const loadingSets = () => {
    const hit = slots.find((s) => s.sets.includes(true));
    return hit ? hit.sets : [];
  };
  return { makeStore, loadingWasRaised, loadingSets, slots };
}

const tick = () => new Promise((r) => setImmediate(r));
const ticks = async (n) => { for (let i = 0; i < n; i++) await tick(); };

const cachedRows = [
  { id: 'srv:1', role: 'user', text: 'cached hello' },
  { id: 'srv:2', role: 'assistant', text: 'cached reply' },
];
const serverRows = [
  { id: 'srv:1', role: 'user', text: 'cached hello' },
  { id: 'srv:2', role: 'assistant', text: 'cached reply' },
  { id: 'srv:3', role: 'user', text: 'fresh from server' },
];
const tailRows = [{ id: 'srv:3', role: 'user', text: 'fresh from server' }];

const resumeOk = { session_id: 'health-live', stored_session_id: 'health', running: false, info: { model: 'm', provider: 'p' } };

// gw whose first session.resume hangs (controllable), later ones resolve.
function hangingGw(calls) {
  let resolveResume;
  return {
    gwRef: {
      current: {
        request: async (method) => {
          if (method === 'session.resume') {
            calls.resume += 1;
            if (calls.resume === 1) return new Promise((r) => { resolveResume = r; });
            return { ...resumeOk };
          }
          if (method === 'session.create') {
            calls.create += 1;
            return { session_id: 'new-live', stored_session_id: 'new-stored' };
          }
          throw new Error('unexpected RPC: ' + method);
        },
      },
    },
    resolveResume: (v) => resolveResume(v),
  };
}

function mockFetch(urls) {
  return async (url) => {
    urls.push(url);
    if (url.includes('/messages?')) {
      if (url.includes('limit=200')) return { messages: serverRows };
      if (url.includes('limit=40')) return { messages: tailRows };
      return { messages: [] };
    }
    return { model: 'm', provider: 'p' };
  };
}

function selectionStorage() {
  return new Map([['hermes.m.selection.v1', JSON.stringify({ sessionId: 'health', title: 'Health' })]]);
}

test('boot renders the cached transcript before any network runs', async () => {
  const urls = [];
  const { makeStore } = loadSessionStore(selectionStorage(), {
    '../lib/auth': { fetchJSON: mockFetch(urls) },
    '../lib/sessionListCache': { loadSessionList: async () => [], saveSessionList: () => {} },
    '../lib/transcriptCache': {
      loadTranscript: async (id) => (id === 'health' ? cachedRows : null),
      saveTranscript: async () => {},
    },
  });
  const loaded = [];
  const store = makeStore({
    gwRef: { current: null },
    activeSessionRef: { current: '' },
    onLoadMessages: (msgs) => loaded.push(msgs),
  });

  const savedId = await store.showCachedSession();
  assert.equal(savedId, 'health');
  assert.deepEqual(loaded, [cachedRows], 'cached transcript painted from SecureStore');
  assert.equal(urls.length, 0, 'no network before auth/socket');
});

test('restore with cache on screen skips the loading bar and merges silently', async () => {
  const calls = { resume: 0, create: 0 };
  const urls = [];
  const { gwRef, resolveResume } = hangingGw(calls);
  const activeSessionRef = { current: '' };
  const synced = [];
  const { makeStore, loadingWasRaised } = loadSessionStore(selectionStorage(), {
    '../lib/auth': { fetchJSON: mockFetch(urls) },
    '../lib/sessionListCache': { loadSessionList: async () => [], saveSessionList: () => {} },
    '../lib/transcriptCache': {
      loadTranscript: async (id) => (id === 'health' ? cachedRows : null),
      saveTranscript: async () => {},
    },
  });
  const store = makeStore({
    gwRef,
    activeSessionRef,
    onLoadMessages: () => {},
    onSyncMessages: (msgs, sid) => synced.push({ msgs, sid }),
  });

  await store.showCachedSession();

  const restoring = store.restoreSession();
  await ticks(5);
  assert.equal(loadingWasRaised(), false, 'no "Loading history..." bar while the cache is on screen');
  assert.equal(calls.resume, 1, 'the rehydrate still runs in the background');

  resolveResume({ ...resumeOk });
  await restoring;

  assert.equal(loadingWasRaised(), false, 'the bar is never raised at all in the silent path');
  assert.deepEqual(synced, [{ msgs: serverRows, sid: 'health-live' }], 'fresh server rows merge over the cached content');
  assert.equal(activeSessionRef.current, 'health-live', 'the live session is still attached');
  assert.equal(urls.filter((u) => u.includes('limit=200')).length, 1, 'one 200-message rehydrate ran');
});

test('restore keeps the loading bar when there is no cache', async () => {
  const calls = { resume: 0, create: 0 };
  const urls = [];
  const { gwRef, resolveResume } = hangingGw(calls);
  const { makeStore, loadingSets } = loadSessionStore(selectionStorage(), {
    '../lib/auth': { fetchJSON: mockFetch(urls) },
    '../lib/sessionListCache': { loadSessionList: async () => [], saveSessionList: () => {} },
    '../lib/transcriptCache': { loadTranscript: async () => null, saveTranscript: async () => {} },
  });
  const store = makeStore({ gwRef, activeSessionRef: { current: '' }, onLoadMessages: () => {} });

  await store.showCachedSession(); // cache miss: renders nothing

  const restoring = store.restoreSession();
  await ticks(5);
  assert.deepEqual(loadingSets(), [true], 'bar shown when nothing is on screen');

  resolveResume({ ...resumeOk });
  await restoring;
  assert.deepEqual(loadingSets(), [true, false], 'bar cleared when the rehydrate lands');
});

test('a second restoreSession during an in-flight restore starts no duplicate rehydrate', async () => {
  const calls = { resume: 0, create: 0 };
  const urls = [];
  const { gwRef, resolveResume } = hangingGw(calls);
  const { makeStore } = loadSessionStore(selectionStorage(), {
    '../lib/auth': { fetchJSON: mockFetch(urls) },
    '../lib/sessionListCache': { loadSessionList: async () => [], saveSessionList: () => {} },
    '../lib/transcriptCache': { loadTranscript: async () => null, saveTranscript: async () => {} },
  });
  const store = makeStore({ gwRef, activeSessionRef: { current: '' } });

  const first = store.restoreSession();
  await ticks(5);
  assert.equal(calls.resume, 1);

  const second = store.restoreSession();
  await ticks(5);
  assert.equal(calls.resume, 1, 'the racing restore is a safe no-op');
  assert.equal(urls.length, 0, 'no duplicate history fetch while in flight');

  resolveResume({ ...resumeOk });
  await Promise.all([first, second]);
  assert.equal(calls.resume, 1, 'still exactly one resume after both settle');
  assert.equal(urls.filter((u) => u.includes('limit=200')).length, 1, 'exactly one 200-message fetch');
});

test('a reconnect racing a restore is a no-op; once resume lands it attaches lightly', async () => {
  const calls = { resume: 0, create: 0 };
  const urls = [];
  const { gwRef, resolveResume } = hangingGw(calls);
  const activeSessionRef = { current: '' };
  const checked = [];
  const { makeStore } = loadSessionStore(selectionStorage(), {
    '../lib/auth': { fetchJSON: mockFetch(urls) },
    '../lib/sessionListCache': { loadSessionList: async () => [], saveSessionList: () => {} },
    '../lib/transcriptCache': { loadTranscript: async () => null, saveTranscript: async () => {} },
  });
  const store = makeStore({ gwRef, activeSessionRef, onCheckTail: (tail, sid) => checked.push({ tail, sid }) });

  // App.tsx handleConnected routing, verbatim:
  const handleConnected = async (opts) => {
    if (opts?.attachOnly && activeSessionRef.current) {
      await store.attachSession();
    } else {
      await store.restoreSession();
    }
  };

  const restoring = store.restoreSession();
  await ticks(5);
  // Socket drops mid-restore, before session.resume set the live session id.
  await handleConnected({ attachOnly: true });
  await ticks(3);
  assert.equal(calls.resume, 1, 'no duplicate restore from the racing reconnect');

  resolveResume({ ...resumeOk });
  await restoring;
  assert.equal(activeSessionRef.current, 'health-live');

  // Later reconnect: the existing attachOnly branch routes to lightweight attach.
  await handleConnected({ attachOnly: true });
  assert.equal(calls.resume, 2, 'attach re-verifies via session.resume');
  assert.ok(urls.some((u) => u.includes('limit=40')), 'attach fetches only the 40-message tail');
  assert.equal(urls.filter((u) => u.includes('limit=200')).length, 1, 'no second full restore');
  assert.deepEqual(checked, [{ tail: tailRows, sid: 'health-live' }]);
});

test('a failed restore releases the in-flight lock so retryLoad retries', async () => {
  const calls = { resume: 0, create: 0 };
  const { makeStore, slots } = loadSessionStore(selectionStorage(), {
    '../lib/sessionListCache': { loadSessionList: async () => [], saveSessionList: () => {} },
    '../lib/transcriptCache': { loadTranscript: async () => null, saveTranscript: async () => {} },
  });
  const gwRef = {
    current: {
      request: async (method) => {
        if (method === 'session.resume') {
          calls.resume += 1;
          throw new Error('boom');
        }
        throw new Error('unexpected RPC: ' + method);
      },
    },
  };
  const store = makeStore({ gwRef, activeSessionRef: { current: '' } });

  await store.restoreSession();
  assert.equal(calls.resume, 1);
  const errorSlot = slots.find((s) => s.sets.some((v) => typeof v === 'string' && v.includes('Retry')));
  assert.ok(errorSlot, 'the honest retry banner is set on failure');

  await store.retryLoad();
  assert.equal(calls.resume, 2, 'manual retry is not swallowed by the dedupe lock');
});
test('a reconnect on a new gateway while a restore is in-flight starts a fresh restore', async () => {
  // Regression: f954f47 dedupe blocked retries when the in-flight restore
  // was on a dead socket, stranding the app with no active session.
  // The dedupe is socket-aware: a new gateway means a fresh restore.
  const calls = { resume: 0 };
  const urls = [];
  let rejectGw1;
  const makeGw = (hang) => ({
    request: async (method) => {
      if (method === 'session.resume') {
        calls.resume += 1;
        if (hang) return new Promise((_, rej) => { rejectGw1 = rej; });
        return { ...resumeOk };
      }
      throw new Error('unexpected RPC: ' + method);
    },
  });
  const gwRef = { current: makeGw(true) };
  const { makeStore } = loadSessionStore(selectionStorage(), {
    '../lib/auth': { fetchJSON: mockFetch(urls) },
    '../lib/sessionListCache': { loadSessionList: async () => [], saveSessionList: () => {} },
    '../lib/transcriptCache': { loadTranscript: async () => null, saveTranscript: async () => {} },
  });
  const store = makeStore({ gwRef, activeSessionRef: { current: '' } });

  const first = store.restoreSession();
  await ticks(5);
  assert.equal(calls.resume, 1, 'first restore started on the old gateway');

  // Socket drops mid-restore; reconnect creates a new gateway object.
  gwRef.current = makeGw(false);
  const second = store.restoreSession();
  await ticks(5);
  assert.equal(calls.resume, 2, 'fresh restore on the new gateway is not blocked by the stale lock');

  await second;
  assert.equal(calls.resume, 2, 'exactly two resumes; no duplicates');

  // Settle the doomed first restore so the test leaves no dangling promise.
  rejectGw1(new Error('socket dead'));
  await first.catch(() => {});
});

test("a stale restore settling does not release a newer restore's lock", async () => {
  // The old restore's finally must not clear the lock taken over by the new
  // restore on the fresh socket; otherwise a third racing call would stack.
  const calls = { resume: 0 };
  const urls = [];
  let rejectGw1;
  let resolveGw2;
  const makeGw = (mode) => ({
    request: async (method) => {
      if (method === 'session.resume') {
        calls.resume += 1;
        if (mode === 'hang') return new Promise((_, rej) => { rejectGw1 = rej; });
        if (mode === 'hang2') return new Promise((res) => { resolveGw2 = res; });
        return { ...resumeOk };
      }
      throw new Error('unexpected RPC: ' + method);
    },
  });
  const gwRef = { current: makeGw('hang') };
  const { makeStore } = loadSessionStore(selectionStorage(), {
    '../lib/auth': { fetchJSON: mockFetch(urls) },
    '../lib/sessionListCache': { loadSessionList: async () => [], saveSessionList: () => {} },
    '../lib/transcriptCache': { loadTranscript: async () => null, saveTranscript: async () => {} },
  });
  const store = makeStore({ gwRef, activeSessionRef: { current: '' } });

  const first = store.restoreSession();
  await ticks(5);
  assert.equal(calls.resume, 1);

  // Reconnect: new gateway, second restore hangs too (slow network).
  gwRef.current = makeGw('hang2');
  const second = store.restoreSession();
  await ticks(5);
  assert.equal(calls.resume, 2);

  // The dead gateway's restore fails; its finally must leave the new lock alone.
  rejectGw1(new Error('socket dead'));
  await first.catch(() => {});
  await ticks(5);

  const third = store.restoreSession();
  await ticks(5);
  assert.equal(calls.resume, 2, 'the in-flight restore on the live gateway still holds the lock');

  // Clean up: let the second restore finish.
  resolveGw2({ ...resumeOk });
  await second;
  await third;
});
