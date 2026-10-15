const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Regression test for the loadingSession ownership fix: attachSession/newChat
// bump the session generation without owning the flag, so a restore in flight
// when either fires must still clear "Loading history…" instead of sticking it
// on forever (which also blocked the transcript-autosave and auto-model
// effects that gate on !loadingSession).
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
  // loadingSession is the only boolean state this flow ever sets true.
  const loadingSets = () => {
    const hits = slots.filter((s) => s.sets.includes(true));
    assert.equal(hits.length, 1, 'exactly one state slot is the loading flag');
    return hits[0].sets;
  };
  return { makeStore, loadingSets };
}

const tick = () => new Promise((r) => setImmediate(r));

test('a restore superseded by newChat still clears loadingSession', async () => {
  const storage = new Map([['hermes.m.selection.v1', JSON.stringify({ sessionId: 'health', title: 'Health' })]]);
  let resolveResume;
  const gwRef = {
    current: {
      request: async (method) => {
        if (method === 'session.resume') return new Promise((r) => { resolveResume = r; });
        if (method === 'session.create') return { session_id: 'new-live', stored_session_id: 'new-stored' };
        throw new Error('unexpected RPC: ' + method);
      },
    },
  };
  const { makeStore, loadingSets } = loadSessionStore(storage);
  const store = makeStore({ gwRef, activeSessionRef: { current: '' } });

  const restoring = store.restoreSession();
  await tick();
  await tick();
  assert.deepEqual(loadingSets(), [true], 'restore raises the loading flag');

  // newChat bumps the session generation mid-restore without owning the flag.
  await store.newChat();
  assert.deepEqual(loadingSets(), [true], 'newChat must not clear a flag it never raised');

  resolveResume({ session_id: 'health-live', stored_session_id: 'health', running: false, info: {} });
  await restoring;
  assert.deepEqual(loadingSets(), [true, false], 'the superseded restore must still clear the flag');
});

test('a restore superseded by attachSession still clears loadingSession', async () => {
  const storage = new Map([['hermes.m.selection.v1', JSON.stringify({ sessionId: 'health', title: 'Health' })]]);
  let resolveResume;
  let resumeCount = 0;
  const gwRef = {
    current: {
      request: async (method) => {
        if (method === 'session.resume') {
          resumeCount += 1;
          if (resumeCount === 1) return new Promise((r) => { resolveResume = r; });
          return { session_id: 'health-live', stored_session_id: 'health', running: false, info: {} };
        }
        throw new Error('unexpected RPC: ' + method);
      },
    },
  };
  const activeSessionRef = { current: '' };
  const { makeStore, loadingSets } = loadSessionStore(storage);
  const store = makeStore({ gwRef, activeSessionRef });

  const restoring = store.restoreSession();
  await tick();
  await tick();
  assert.deepEqual(loadingSets(), [true]);

  // attachSession (socket reconnect path) bumps the generation mid-restore.
  activeSessionRef.current = 'health-live';
  await store.attachSession();
  assert.deepEqual(loadingSets(), [true], 'attachSession must not clear a flag it never raised');

  resolveResume({ session_id: 'health-live', stored_session_id: 'health', running: false, info: {} });
  await restoring;
  assert.deepEqual(loadingSets(), [true, false], 'the superseded restore must still clear the flag');
});

test('a resume superseded by newChat still clears loadingSession', async () => {
  const storage = new Map();
  let resolveResume;
  const gwRef = {
    current: {
      request: async (method) => {
        if (method === 'session.resume') return new Promise((r) => { resolveResume = r; });
        if (method === 'session.create') return { session_id: 'new-live', stored_session_id: 'new-stored' };
        throw new Error('unexpected RPC: ' + method);
      },
    },
  };
  const { makeStore, loadingSets } = loadSessionStore(storage);
  const store = makeStore({ gwRef, activeSessionRef: { current: '' } });

  const opening = store.resumeSession({ id: 'health', title: 'Health' });
  await tick();
  await tick();
  assert.deepEqual(loadingSets(), [true], 'resume raises the loading flag');

  // newChat releases the resume lock and bumps the generation mid-resume
  // without ever owning the flag.
  await store.newChat();
  assert.deepEqual(loadingSets(), [true], 'newChat must not clear a flag it never raised');

  resolveResume({ session_id: 'health-live', stored_session_id: 'health', running: false, info: {} });
  await opening;
  assert.deepEqual(loadingSets(), [true, false], 'the superseded resume must still clear the flag');
});
