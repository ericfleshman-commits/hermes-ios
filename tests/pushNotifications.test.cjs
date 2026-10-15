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

// Loads src/lib/pushNotifications.ts in a vm with stubbed expo modules.
// opts: { isDevice, permStatus, reqStatus, token, tokenThrows, rpc, projectId,
//         notificationsMissing }
function setup(opts = {}) {
  const rpcCalls = [];
  const permCalls = [];
  let tokenCalls = [];
  let handlerCfg = null;
  const responseListeners = [];
  const subsRemoved = [];
  const gw = {
    request: opts.rpc ?? (async (method, params, timeoutMs) => {
      rpcCalls.push({ method, params, timeoutMs });
      return { ok: true };
    }),
  };
  const readToken = typeof opts.token === 'function' ? opts.token : () => (opts.token ?? 'ExponentPushToken[abcdef123456]');
  const badgeCalls = [];
  const notifications = opts.notificationsMissing ? null : {
    getPermissionsAsync: async () => {
      permCalls.push('get');
      return { status: opts.permStatus ?? 'granted' };
    },
    setBadgeCountAsync: opts.badgeThrows ? async () => { throw Error('no badge'); } : async n => { badgeCalls.push(n); return true; },
    requestPermissionsAsync: async () => {
      permCalls.push('request');
      return { status: opts.reqStatus ?? 'granted' };
    },
    getExpoPushTokenAsync: async (o) => {
      tokenCalls.push(o || {});
      if (opts.tokenThrows) throw new Error('no token');
      return { data: readToken() };
    },
    setNotificationHandler: (h) => { handlerCfg = h; },
    addNotificationResponseReceivedListener: (cb) => {
      responseListeners.push(cb);
      return { remove: () => subsRemoved.push(true) };
    },
  };
  const ctx = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    require(name) {
      if (name === 'expo-device') return { isDevice: opts.isDevice !== false };
      if (name === 'expo-notifications') {
        if (!notifications) throw new Error('module not found');
        return notifications;
      }
      if (name === 'expo-constants') {
        return { expoConfig: { extra: { eas: { projectId: opts.projectId ?? 'proj-123' } } } };
      }
      throw new Error('unexpected import: ' + name);
    },
  });
  const lib = {};
  ctx.exports = lib;
  vm.runInContext(transpile('src/lib/pushNotifications.ts'), ctx);
  lib.__resetPushForTests();
  return { lib, gw, badgeCalls, rpcCalls, permCalls, tokenCalls, responseListeners, subsRemoved,
           get handlerCfg() { return handlerCfg; } };
}

function tapResponse(sessionId) {
  return { notification: { request: { content: { data: sessionId ? { sessionId } : {} } } } };
}

test('denied permission -> no registration call, and never re-prompts', async () => {
  const { lib, gw, rpcCalls, permCalls } = setup({ permStatus: 'denied', reqStatus: 'denied' });
  await lib.ensurePushRegistration(gw, 'dev-1');
  assert.equal(rpcCalls.length, 0);
  assert.deepEqual(permCalls, ['get', 'request']);
  // Second connect: silently skips, does not even ask again.
  await lib.ensurePushRegistration(gw, 'dev-1');
  assert.equal(rpcCalls.length, 0);
  assert.deepEqual(permCalls, ['get', 'request']);
});

test('granted permission -> token fetched and push.register called with right params', async () => {
  const { lib, gw, rpcCalls, tokenCalls } = setup({ permStatus: 'granted' });
  await lib.ensurePushRegistration(gw, '7c013155-cd20-4e02-8677-235d7c01cd20');
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].method, 'push.register');
  assert.equal(rpcCalls[0].params.token, 'ExponentPushToken[abcdef123456]');
  assert.equal(rpcCalls[0].params.device_id, '7c013155-cd20-4e02-8677-235d7c01cd20');
  assert.equal(rpcCalls[0].timeoutMs, 15000);
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].projectId, 'proj-123');
});

test('undetermined permission -> requests once, registers on grant', async () => {
  const { lib, gw, rpcCalls, permCalls } = setup({ permStatus: 'undetermined', reqStatus: 'granted' });
  await lib.ensurePushRegistration(gw, 'dev-1');
  assert.deepEqual(permCalls, ['get', 'request']);
  assert.equal(rpcCalls.length, 1);
});

test('idempotent: second call with same token does not re-fire the RPC', async () => {
  const { lib, gw, rpcCalls } = setup({ permStatus: 'granted' });
  await lib.ensurePushRegistration(gw, 'dev-1');
  await lib.ensurePushRegistration(gw, 'dev-1');
  await lib.ensurePushRegistration(gw, 'dev-1');
  assert.equal(rpcCalls.length, 1);
});

test('token change -> re-registers (self-healing after backend restart)', async () => {
  let current = 'ExponentPushToken[aaa]';
  const { lib, gw, rpcCalls } = setup({ permStatus: 'granted', token: () => current });
  await lib.ensurePushRegistration(gw, 'dev-1');
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].params.token, 'ExponentPushToken[aaa]');
  await lib.ensurePushRegistration(gw, 'dev-1');
  assert.equal(rpcCalls.length, 1); // same token: idempotent
  current = 'ExponentPushToken[bbb]'; // token rotated (reinstall, new device key)
  await lib.ensurePushRegistration(gw, 'dev-1');
  assert.equal(rpcCalls.length, 2);
  assert.equal(rpcCalls[1].params.token, 'ExponentPushToken[bbb]');
});

test('simulator (not a device) -> no permission prompt, no RPC', async () => {
  const { lib, gw, rpcCalls, permCalls } = setup({ isDevice: false });
  await lib.ensurePushRegistration(gw, 'dev-1');
  assert.equal(permCalls.length, 0);
  assert.equal(rpcCalls.length, 0);
});

test('missing deviceId or gateway -> no-op, never throws', async () => {
  const { lib, gw, rpcCalls } = setup({ permStatus: 'granted' });
  await lib.ensurePushRegistration(null, 'dev-1');
  await lib.ensurePushRegistration(gw, null);
  await lib.ensurePushRegistration(gw, '');
  assert.equal(rpcCalls.length, 0);
});

test('RPC failure -> token not marked registered; next connect retries', async () => {
  let attempts = 0;
  const { lib, gw, rpcCalls } = setup({
    permStatus: 'granted',
    rpc: async (method, params, timeoutMs) => {
      attempts++;
      rpcCalls.push({ method, params, timeoutMs });
      if (attempts === 1) throw new Error('backend down');
      return { ok: true };
    },
  });
  await lib.ensurePushRegistration(gw, 'dev-1');
  assert.equal(rpcCalls.length, 1); // first attempt fired
  await lib.ensurePushRegistration(gw, 'dev-1');
  assert.equal(rpcCalls.length, 2); // retried because the first was never acknowledged
});

test('concurrent calls coalesce into a single RPC', async () => {
  const { lib, gw, rpcCalls } = setup({ permStatus: 'granted' });
  await Promise.all([
    lib.ensurePushRegistration(gw, 'dev-1'),
    lib.ensurePushRegistration(gw, 'dev-1'),
    lib.ensurePushRegistration(gw, 'dev-1'),
  ]);
  assert.equal(rpcCalls.length, 1);
});

test('token fetch failure -> silent skip, no RPC', async () => {
  const { lib, gw, rpcCalls } = setup({ permStatus: 'granted', tokenThrows: true });
  await lib.ensurePushRegistration(gw, 'dev-1');
  assert.equal(rpcCalls.length, 0);
});

test('non-Expo token shape is rejected, no RPC', async () => {
  const { lib, gw, rpcCalls } = setup({ permStatus: 'granted', token: 'fcm:whatever' });
  await lib.ensurePushRegistration(gw, 'dev-1');
  assert.equal(rpcCalls.length, 0);
});

test('foreground handler shows a banner; tap with sessionId opens that chat', async () => {
  const s2 = setup();
  const { lib, responseListeners } = s2;
  const opened = [];
  lib.installPushHandlers((sid) => opened.push(sid));
  assert.ok(s2.handlerCfg, 'setNotificationHandler was called');
  const behavior = await s2.handlerCfg.handleNotification();
  assert.equal(behavior.shouldShowBanner, true);
  assert.equal(responseListeners.length, 1);
  responseListeners[0](tapResponse('session-42'));
  assert.deepEqual(opened, ['session-42']);
});

test('tap without sessionId -> no crash, no session opened', async () => {
  const { lib, responseListeners } = setup();
  const opened = [];
  lib.installPushHandlers((sid) => opened.push(sid));
  responseListeners[0](tapResponse(null));
  responseListeners[0]({});
  responseListeners[0]({ notification: { request: { content: { data: { sessionId: 123 } } } } });
  assert.deepEqual(opened, []);
});

test('installPushHandlers is idempotent; cleanup removes the listener', async () => {
  const { lib, responseListeners, subsRemoved } = setup();
  const c1 = lib.installPushHandlers(() => {});
  const c2 = lib.installPushHandlers(() => {});
  assert.equal(responseListeners.length, 1);
  c1(); // first install's cleanup removes the listener
  assert.equal(subsRemoved.length, 1);
  c2(); // second install was a no-op; its cleanup must not double-remove
  assert.equal(subsRemoved.length, 1);
});

test('native modules absent -> all entry points are silent no-ops', async () => {
  const { lib, gw, rpcCalls } = setup({ notificationsMissing: true });
  await lib.ensurePushRegistration(gw, 'dev-1');
  const opened = [];
  const cleanup = lib.installPushHandlers((sid) => opened.push(sid));
  assert.doesNotThrow(() => cleanup());
  assert.equal(rpcCalls.length, 0);
  assert.deepEqual(opened, []);
});

test('a failed token fetch names its stage to the reporter, never the token', async () => {
  const h = setup({ tokenThrows: true });
  const stages = [];
  h.lib.setPushReporter((stage, detail) => stages.push([stage, detail]));
  await h.lib.ensurePushRegistration(h.gw, 'dev-1');
  assert.equal(stages.length, 1);
  assert.equal(stages[0][0], 'token_failed');
  assert.match(stages[0][1].error, /no token/);
});

test('a successful registration reports registered', async () => {
  const h = setup({});
  const stages = [];
  h.lib.setPushReporter((stage) => stages.push(stage));
  await h.lib.ensurePushRegistration(h.gw, 'dev-1');
  assert.deepEqual(stages, ['registered']);
});

test('opening the app clears the icon badge', async () => {
  const h = setup({});
  await h.lib.clearBadge();
  assert.deepEqual(h.badgeCalls, [0]);
});

test('clearing the badge never throws, even without the module', async () => {
  await setup({ badgeThrows: true }).lib.clearBadge();
  await setup({ notificationsMissing: true }).lib.clearBadge();
});
