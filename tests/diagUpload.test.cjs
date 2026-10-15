const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const RealDate = Date;
let nowMs = 1_750_000_000_000;
function FakeDate(...args) { return new RealDate(...(args.length ? args : [nowMs])); }
FakeDate.now = () => nowMs;
FakeDate.prototype = RealDate.prototype;

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

function transpile(path) {
  return ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

// Loads diagLog + diagUpload into one shared vm context so they share the
// ring buffer. Stubs ./auth, expo-constants, and expo-secure-store.
function setup(opts = {}) {
  const calls = [];
  const store = new Map(opts.initialStore ?? []);
  let setItemCalls = 0;
  const authFetch = opts.authFetch ?? (async () => ({ status: 202 }));
  const ctx = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    Date: FakeDate,
    require(name) {
      if (name === './auth') {
        return {
          BASE: 'https://gateway.example.ts.net:9220',
          authFetch: async (url, init) => { calls.push({ url, init }); return authFetch(url, init); },
        };
      }
      if (name === 'expo-constants') {
        if (opts.constants === null) throw new Error('expo-constants unavailable');
        // Realistic native-module shape: platform.ios.buildNumber is the
        // CFBundleVersion baked into the binary; expoConfig.ios.buildNumber
        // is the (stale, in this fixture) manifest value the old code read.
        return opts.constants ?? {
          default: {
            expoConfig: { version: '1.0.0', ios: { buildNumber: '133' } },
            platform: { ios: { buildNumber: '140' } },
          },
        };
      }
      if (name === 'expo-secure-store') {
        return {
          getItemAsync: async (k) => (store.has(k) ? store.get(k) : null),
          setItemAsync: async (k, v) => { setItemCalls++; store.set(k, v); },
        };
      }
      if (name === './diagLog') return diagExports;
      throw new Error('unexpected import: ' + name);
    },
  });
  const diagExports = {};
  ctx.exports = diagExports;
  vm.runInContext(transpile('src/lib/diagLog.ts'), ctx);
  const upExports = {};
  ctx.exports = upExports;
  vm.runInContext(transpile('src/lib/diagUpload.ts'), ctx);
  return {
    diag: diagExports,
    up: upExports,
    calls,
    store,
    get setItemCalls() { return setItemCalls; },
    bodies() { return calls.map((c) => JSON.parse(c.init.body)); },
  };
}

test('upload posts the contract payload, then rate-limits for 5 minutes', async () => {
  nowMs = 1_750_000_000_000;
  const h = setup();
  h.diag.diagLog('timeout', { context: 'busy_stall' });
  h.diag.diagLog('reconnect_ok', { attempts: 2 });
  h.up.maybeUploadDiag();
  await tick();
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(url, 'https://gateway.example.ts.net:9220/api/plugins/mobile-push/client-logs');
  assert.equal(init.method, 'POST');
  const body = JSON.parse(init.body);
  assert.equal(body.app, 'hermes-ios');
  assert.equal(body.version, '1.0.0');
  assert.equal(body.buildNumber, '140'); // native CFBundleVersion wins over the stale expoConfig value ('133')
  assert.match(body.deviceId, /^[0-9a-f-]{36}$/);
  assert.match(body.uploadedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(body.events.length, 2);
  assert.equal(body.events[0].kind, 'timeout');

  // Second call inside the window: buffered, not sent.
  h.diag.diagLog('rpc_error', { method: 'prompt.submit', reason: 'request_timeout' });
  h.up.maybeUploadDiag();
  await tick();
  assert.equal(h.calls.length, 1);

  // After 5 minutes the next call flushes what accumulated.
  nowMs += 5 * 60 * 1000 + 1;
  h.up.maybeUploadDiag();
  await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.bodies()[1].events.length, 1);
});

test('at most 200 events per upload; most recent win', async () => {
  nowMs = 1_750_000_000_000;
  const h = setup();
  for (let i = 0; i < 250; i++) h.diag.diagLog('reconnect_attempt', { i });
  h.up.maybeUploadDiag();
  await tick();
  assert.equal(h.calls.length, 1);
  const events = h.bodies()[0].events;
  assert.equal(events.length, 200);
  assert.equal(events[0].detail.i, 50);
  assert.equal(events[199].detail.i, 249);
});

test('payload is truncated under 64KB, never sent whole', async () => {
  nowMs = 1_750_000_000_000;
  const h = setup();
  for (let i = 0; i < 300; i++) h.diag.diagLog('rpc_error', { blob: 'z'.repeat(3900), i });
  h.up.maybeUploadDiag();
  await tick();
  assert.equal(h.calls.length, 1);
  const raw = h.calls[0].init.body;
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 64 * 1024, `payload was ${Buffer.byteLength(raw, 'utf8')} bytes`);
  const events = JSON.parse(raw).events;
  assert.ok(events.length < 300, 'oversized buffer must be truncated, not sent whole');
  assert.ok(events.length >= 1);
});

test('uploader never throws or rejects when fetch fails', async () => {
  nowMs = 1_750_000_000_000;
  const h = setup({ authFetch: async () => { throw new Error('network down'); } });
  h.diag.diagLog('timeout', { context: 'busy_stall' });
  assert.doesNotThrow(() => h.up.maybeUploadDiag());
  await tick(50);
  // The failure is swallowed; the unsent events are kept for the next try
  // (e.g. Tailscale was off) and the failure itself is recorded as metadata.
  const evs = h.diag.drainDiag();
  assert.deepEqual(Array.from(evs, e => e.kind), ['timeout', 'rpc_error']);
  assert.equal(evs[1].detail.reason, 'upload_failed');
});

test('device id is generated once and persisted in SecureStore', async () => {
  nowMs = 1_750_000_000_000;
  const h = setup();
  h.diag.diagLog('timeout', {});
  h.up.maybeUploadDiag();
  await tick();
  const id1 = h.bodies()[0].deviceId;
  assert.ok(h.store.get('hermes.dash.deviceId'), 'device id persisted');
  assert.equal(h.setItemCalls, 1);

  // A fresh module state re-reads the stored id instead of minting a new one.
  h.up.__resetDiagUploadForTests();
  nowMs += 5 * 60 * 1000 + 1;
  h.diag.diagLog('timeout', {});
  h.up.maybeUploadDiag();
  await tick();
  assert.equal(h.bodies()[1].deviceId, id1);
  assert.equal(h.setItemCalls, 1, 'stored id reused, not rewritten');
});

test('empty buffer never triggers an upload', async () => {
  nowMs = 1_750_000_000_000;
  const h = setup();
  h.up.maybeUploadDiag();
  await tick();
  assert.equal(h.calls.length, 0);
});

test('build number resolves from the named-export shape too', async () => {
  nowMs = 1_750_000_000_000;
  const h = setup({ constants: { expoConfig: { version: '1.0.0' }, platform: { ios: { buildNumber: '141' } } } });
  h.diag.diagLog('timeout', {});
  h.up.maybeUploadDiag();
  await tick();
  assert.equal(h.bodies()[0].buildNumber, '141');
});

test('build number reports unknown when the native module has no build number', async () => {
  nowMs = 1_750_000_000_000;
  const h = setup({ constants: { default: { expoConfig: { version: '2.0.0' } } } });
  h.diag.diagLog('timeout', {});
  h.up.maybeUploadDiag();
  await tick();
  const body = h.bodies()[0];
  assert.equal(body.buildNumber, 'unknown');
  assert.equal(body.version, '2.0.0');
});

test('build number reports unknown when expo-constants is unavailable', async () => {
  nowMs = 1_750_000_000_000;
  const h = setup({ constants: null });
  h.diag.diagLog('timeout', {});
  h.up.maybeUploadDiag();
  await tick();
  const body = h.bodies()[0];
  assert.equal(body.buildNumber, 'unknown');
  assert.equal(body.version, '1.0.0');
});
