const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function transpile(path) {
  return ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

// Loads src/lib/otaUpdates.ts in a vm with stubbed react-native and expo-updates.
// opts: { isEnabled, checkImpl, fetchImpl, updateId, channel, runtimeVersion }
function setup(opts = {}) {
  const calls = { check: 0, fetch: 0, reload: 0 };
  const listeners = [];
  const appState = {
    addEventListener: (event, cb) => {
      listeners.push(cb);
      return { remove: () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); } };
    },
  };
  const updates = {
    isEnabled: opts.isEnabled !== false,
    updateId: opts.updateId !== undefined ? opts.updateId : 'abc123def456789',
    channel: opts.channel !== undefined ? opts.channel : 'production',
    runtimeVersion: opts.runtimeVersion !== undefined ? opts.runtimeVersion : '1.0.0',
    checkForUpdateAsync: async () => {
      calls.check++;
      if (opts.checkImpl) return opts.checkImpl();
      return { isAvailable: false, isRollBackToEmbedded: false, manifest: undefined, reason: 'noUpdateAvailableOnServer' };
    },
    fetchUpdateAsync: async () => {
      calls.fetch++;
      if (opts.fetchImpl) return opts.fetchImpl();
      return { isNew: true, manifest: {}, isRollBackToEmbedded: false };
    },
    reloadAsync: async () => { calls.reload++; },
  };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Promise,
    require(name) {
      if (name === 'react-native') return { AppState: appState };
      if (name === 'expo-updates') return updates;
      throw new Error('unexpected import: ' + name);
    },
  });
  const lib = {};
  ctx.exports = lib;
  vm.runInContext(transpile('src/lib/otaUpdates.ts'), ctx);
  return { lib, calls, updates, listeners };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

test('cold start triggers one check immediately; up-to-date means no fetch and no reload', async () => {
  const now = 1_000_000;
  const { lib, calls } = setup();
  const cleanup = lib.startOtaUpdates({ now: () => now });
  await flush();
  assert.equal(calls.check, 1);
  assert.equal(calls.fetch, 0);
  assert.equal(calls.reload, 0);
  assert.equal(lib.getOtaStatus().lastResult, 'up-to-date');
  assert.equal(lib.getOtaStatus().lastCheckedAt, now);
  cleanup();
});

test('update available -> silent background fetch, never reloads while the app is active', async () => {
  const { lib, calls } = setup({
    checkImpl: () => ({ isAvailable: true, isRollBackToEmbedded: false, manifest: {} }),
  });
  const cleanup = lib.startOtaUpdates({ now: () => 2_000_000 });
  await flush();
  assert.equal(calls.check, 1);
  assert.equal(calls.fetch, 1);
  // The policy: a mid-chat restart would be hostile, so reloadAsync is never
  // called. The fetched update applies on the next cold launch.
  assert.equal(calls.reload, 0);
  assert.equal(lib.getOtaStatus().lastResult, 'fetched');
  cleanup();
});

test('rollback directive -> recorded, no fetch, no reload', async () => {
  const { lib, calls } = setup({
    checkImpl: () => ({ isAvailable: false, isRollBackToEmbedded: true, manifest: undefined, reason: undefined }),
  });
  const cleanup = lib.startOtaUpdates({ now: () => 3_000_000 });
  await flush();
  assert.equal(calls.check, 1);
  assert.equal(calls.fetch, 0);
  assert.equal(calls.reload, 0);
  assert.equal(lib.getOtaStatus().lastResult, 'rollback-directive');
  cleanup();
});

test('check error is swallowed silently; failure recorded, no throw out of listener', async () => {
  const { lib, calls, listeners } = setup({
    checkImpl: () => { throw new Error('network down'); },
  });
  let now = 4_000_000;
  const cleanup = lib.startOtaUpdates({ now: () => now });
  await flush();
  assert.equal(calls.check, 1);
  assert.equal(lib.getOtaStatus().lastResult, 'failed');
  // A later foreground event must not throw either, and stays throttled.
  now += 20 * 60 * 1000;
  assert.doesNotThrow(() => listeners[0]('active'));
  await flush();
  assert.equal(calls.check, 2);
  assert.equal(lib.getOtaStatus().lastResult, 'failed');
  cleanup();
});

test('fetch error is swallowed silently; reload still never called', async () => {
  const { lib, calls } = setup({
    checkImpl: () => ({ isAvailable: true, isRollBackToEmbedded: false, manifest: {} }),
    fetchImpl: () => { throw new Error('download dropped'); },
  });
  const cleanup = lib.startOtaUpdates({ now: () => 5_000_000 });
  await flush();
  assert.equal(calls.fetch, 1);
  assert.equal(calls.reload, 0);
  assert.equal(lib.getOtaStatus().lastResult, 'failed');
  cleanup();
});

test('updates disabled (dev build) -> no network calls at all', async () => {
  const { lib, calls } = setup({ isEnabled: false });
  const cleanup = lib.startOtaUpdates({ now: () => 6_000_000 });
  await flush();
  await flush();
  assert.equal(calls.check, 0);
  assert.equal(calls.fetch, 0);
  assert.equal(lib.getOtaStatus().lastResult, 'disabled');
  assert.equal(lib.getOtaStatus().isEnabled, false);
  cleanup();
});

test('fromeground active triggers a check, throttled to one per 15 minutes', async () => {
  const { lib, calls, listeners } = setup();
  let now = 7_000_000;
  const cleanup = lib.startOtaUpdates({ now: () => now });
  await flush();
  assert.equal(calls.check, 1); // cold start

  // Foreground churn right after the cold start: no new check.
  listeners[0]('active');
  listeners[0]('active');
  await flush();
  assert.equal(calls.check, 1);

  // Non-active transitions never trigger checks.
  listeners[0]('background');
  listeners[0]('inactive');
  await flush();
  assert.equal(calls.check, 1);

  // 14 minutes later: still throttled.
  now += 14 * 60 * 1000;
  listeners[0]('active');
  await flush();
  assert.equal(calls.check, 1);

  // Past the 15-minute window: one fresh check.
  now += 61 * 1000;
  listeners[0]('active');
  await flush();
  assert.equal(calls.check, 2);
  assert.equal(lib.getOtaStatus().lastCheckedAt, now);
  cleanup();
});

test('status getter exposes update id, channel, runtime version, and last check', async () => {
  const { lib } = setup({ updateId: 'deadbeef00112233', channel: 'production', runtimeVersion: '1.0.0' });
  const before = lib.getOtaStatus();
  assert.equal(before.updateId, 'deadbeef00112233');
  assert.equal(before.channel, 'production');
  assert.equal(before.runtimeVersion, '1.0.0');
  assert.equal(before.lastCheckedAt, null);
  assert.equal(before.lastResult, 'not-yet-checked');
  const cleanup = lib.startOtaUpdates({ now: () => 8_000_000 });
  await flush();
  const after = lib.getOtaStatus();
  assert.equal(after.updateId, 'deadbeef00112233');
  assert.equal(after.lastCheckedAt, 8_000_000);
  assert.equal(after.lastResult, 'up-to-date');
  cleanup();
});

test('start is idempotent; cleanup removes the listener', async () => {
  const { lib, calls, listeners } = setup();
  let now = 9_000_000;
  const c1 = lib.startOtaUpdates({ now: () => now });
  const c2 = lib.startOtaUpdates({ now: () => now });
  assert.equal(listeners.length, 1); // one listener, not two
  await flush();
  assert.equal(calls.check, 1); // second start was throttled by the first
  c1();
  assert.equal(listeners.length, 0);
  now += 20 * 60 * 1000;
  c2(); // second cleanup is a safe no-op
  assert.equal(listeners.length, 0);
});
