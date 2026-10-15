const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

// Regression coverage for the broken chat loop (sends clearing with no
// thinking pill, then the full response popping in ~30s later):
//  1. flushPending (the queue-first path all text sends take) claims busy
//     with session ownership, and releases it on failure / session change.
//  2. The thinking pill mounts on busy alone (no conn === "open" gate) and
//     reads "Reconnecting…" while the socket is down.
//  3. send()'s session-change early returns clear the bubble's spinner.
//  4. Reconnect backoff caps at 5s while a turn is in flight, 30s otherwise.
//
// Fixes 1–3 are structural (App.tsx is too heavy to render in the vm);
// they fail on old code via git stash. Fix 4 is behavioral through the
// real hook module.

// --- structural helpers ---------------------------------------------------
function appSrc() {
  return fs.readFileSync('src/App.tsx', 'utf8');
}
function flushRegion(src) {
  const start = src.indexOf('const flushPending = useCallback(');
  const end = src.indexOf('flushPendingRef.current = flushPending;');
  assert.ok(start > 0 && end > start, 'flushPending region not found');
  return src.slice(start, end);
}
function sendRegion(src) {
  const start = src.indexOf('const send = useCallback(');
  const end = src.indexOf('const flushPending = useCallback(');
  assert.ok(start > 0 && end > start, 'send region not found');
  return src.slice(start, end);
}

test('flushPending claims busy with ownership before the submit RPC', () => {
  const r = flushRegion(appSrc());
  const iMark = r.indexOf('await markSubmitting(pending');
  const iBusy = r.indexOf('setBusy(true)');
  const iOwner = r.indexOf('busyOwnerRef.current = liveSid');
  const iLabel = r.indexOf('setBusyLabel("Sending…")');
  const iRpc = r.indexOf('submitOnce(gw, liveSid');
  assert.ok(iMark > 0 && iRpc > 0, 'flushPending anchors missing');
  assert.ok(iBusy > iMark && iOwner > iBusy && iLabel > iOwner && iRpc > iLabel,
    'busy claim must sit between markSubmitting and the submit RPC');
});

test('flushPending releases the pill on failure and session change with ownership', () => {
  const r = flushRegion(appSrc());
  const iCatch = r.indexOf('} catch {');
  const catchBody = r.slice(iCatch);
  assert.ok(catchBody.includes('busyOwnerRef.current === liveSid'),
    'catch must guard the busy clear on ownership');
  assert.ok(catchBody.includes('setBusy(false)'), 'catch must clear busy');
  // The session-change early return (returnToQueue) also releases.
  assert.ok(r.includes('returnToQueue(submitting)'), 'returnToQueue path missing');
  const iReturn = r.indexOf('returnToQueue(submitting)');
  const tail = r.slice(iReturn, iReturn + 600);
  assert.ok(tail.includes('busyOwnerRef.current === liveSid') && tail.includes('setBusy(false)'),
    'session-change return must ownership-guard the busy clear');
});

test('flushPending flips the label to Thinking on ack (busy stays until message.complete)', () => {
  const r = flushRegion(appSrc());
  const iRpc = r.indexOf('submitOnce(gw, liveSid');
  const afterAck = r.slice(iRpc);
  assert.ok(afterAck.includes('setBusyLabel("")'), 'ack must clear the busy label');
  // busy stays claimed through ack: no setBusy(false) between the claim and
  // the ack label clear other than the guarded catch/session paths.
  const iClaim = r.indexOf('setBusy(true)');
  const iAckLabel = r.indexOf('setBusyLabel("")');
  assert.ok(iAckLabel > iRpc && iClaim < iRpc, 'label clear must follow the RPC');
});

test('thinking pill renders on busy regardless of connection state', () => {
  const src = appSrc();
  assert.ok(!src.includes('busy && conn === "open" && ('),
    'the conn gate on the thinking pill must be gone');
  assert.ok(src.includes('{busy && ('), 'pill must mount whenever busy is true');
  // While the socket is down the whole label reads Reconnecting…: an
  // offline chat must never claim a tool is live (see the keyboardRendering
  // offline-tool test). Assert on the pill block so the offline override is
  // verified in place, not just anywhere in the file.
  const pillBlock = src.slice(src.indexOf('{busy && ('), src.indexOf('{busy && (') + 1000);
  assert.ok(!pillBlock.includes('Reconnecting'), 'the pill never shows connection words');
  assert.ok(pillBlock.includes('conn === "open"'), 'only a live chat may name a running tool');
  
});

test('send() session-change early returns clear the bubble spinner', () => {
  const r = sendRegion(appSrc());
  // Old code had exactly one `sending: undefined` patch in send() (the
  // delivery-uncertain path); the two session-change returns add two more.
  const patches = r.match(/patchMessage\(userMsgId, \(m\) => \(\{\s*\.\.\.m,\s*sending: undefined \}\)\);/g) || [];
  assert.equal(patches.length, 3,
    `both session-change returns must clear sending, found ${patches.length}`);
  assert.ok(r.includes('the chat\n          // changed, so clear it or the spinner would spin forever.'),
    'success-path return must carry the stuck-spinner guard');
  assert.ok(r.includes('Same stuck-spinner guard as the success path above.'),
    'catch-path return must carry the stuck-spinner guard');
});

// --- hook-level: backoffDelayMs -------------------------------------------------
function loadHook() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/hooks/useHermesSocket.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require(id) {
      if (id === 'react') return React;
      if (id === 'react-native') return { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } };
      if (id === '../lib/gateway') return { GatewayClient: class {} };
      if (id === '../lib/auth') return { HOST: 'example.test', getWsTicket: async () => ({ ticket: 't' }), readStoredSessionId: async () => undefined, prefetchWsTicket: async () => {}, takeWarmTicket: () => null };
      throw new Error(`unexpected import: ${id}`);
    },
    console, setTimeout, clearTimeout, Promise,
  });
  return exports;
}

test('backoffDelayMs caps at 5s when busy, 30s when not', () => {
  const { backoffDelayMs } = loadHook();
  assert.equal(typeof backoffDelayMs, 'function', 'backoffDelayMs must be exported');
  for (let i = 0; i < 50; i++) {
    const busy = backoffDelayMs(9, true);
    assert.ok(busy >= 2500 && busy <= 5000, `busy attempt 9 must land in [2500,5000], got ${busy}`);
    const idle = backoffDelayMs(9, false);
    assert.ok(idle >= 15000 && idle <= 30000, `idle attempt 9 must land in [15000,30000], got ${idle}`);
    const def = backoffDelayMs(9);
    assert.ok(def >= 15000 && def <= 30000, 'default (no busy flag) keeps the 30s cap');
  }
  // Early attempts are below both caps: unchanged behavior.
  for (let i = 0; i < 20; i++) {
    const d = backoffDelayMs(1, true);
    assert.ok(d >= 1000 && d <= 2000, `attempt 1 unchanged, got ${d}`);
  }
});

// --- hook-level: scheduler honors the busy cap -----------------------------------
function setupSocket({ busy } = {}) {
  const timers = new Map();
  let seq = 0;
  const fakeSetTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  const clients = [];
  const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  class GatewayClient {
    constructor(url) { this.url = url; this.state = 'idle'; clients.push(this); }
    onState(fn) { this.onChange = fn; }
    on() {}
    async connect() {
      this.state = 'connecting';
      this.onChange('connecting');
      await Promise.resolve();
      this.state = 'error';
      this.onChange('error');
      throw new Error('ws error');
    }
    async request() { return {}; }
    disconnect() { this.state = 'closed'; this.onChange('closed'); }
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
        getWsTicket: async () => { throw new Error('down'); },
        readStoredSessionId: async () => undefined,
        prefetchWsTicket: async () => {},
        takeWarmTicket: () => null,
      };
      throw new Error(`unexpected import: ${id}`);
    },
    console, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, Promise,
  });
  const isBusyRef = { current: !!busy };
  let hook;
  function Probe() { hook = exports.useHermesSocket({ isBusyRef }); return null; }
  return {
    timers,
    get hook() { return hook; },
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
  };
}

async function fifthDelay(busy) {
  const h = setupSocket({ busy });
  await h.mount();
  try {
    // Every ticket fetch fails: each fired timer drives one more failed
    // attempt and arms the next. After firing four timers we sit on the
    // attempt-5 scheduled delay.
    await act(async () => { await h.hook.connectGateway(); });
    for (let i = 0; i < 4; i++) {
      const [id] = [...h.timers.keys()];
      await h.fire(id);
    }
    const [delay] = h.delays();
    return delay;
  } finally {
    await h.unmount();
  }
}

test('scheduler caps reconnect backoff at 5s while a turn is in flight', async () => {
  const delay = await fifthDelay(true);
  assert.ok(delay >= 2500 && delay <= 5000,
    `busy attempt 5 must land in [2500,5000], got ${delay}`);
});

test('scheduler keeps the 30s cap when nothing is in flight', async () => {
  const delay = await fifthDelay(false);
  assert.ok(delay >= 15000 && delay <= 30000,
    `idle attempt 5 must land in [15000,30000], got ${delay}`);
});
