const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadGates() {
  const exports = {};
  const src = fs.readFileSync('src/lib/sendGates.ts', 'utf8');
  vm.runInNewContext(
    ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports },
  );
  return exports;
}
const gates = loadGates();

const P = (over = {}) => ({ id: 'p1', sessionId: 'chat-a', text: 'hello there', state: 'uncertain', baseRowId: 1, uncertainAt: 0, ...over });
const U = (text) => ({ role: 'user', text });
const A = (text) => ({ role: 'assistant', text });

// Evidence rules for decidePendingHeal live in tests/healEvidence.test.cjs.

test('heal skips when nothing is stuck, there is no session, or the pending belongs to another chat', () => {
  assert.equal(gates.decidePendingHeal(null, 'live-1', 'chat-a', []), 'skip');
  assert.equal(gates.decidePendingHeal(P({ state: 'queued' }), 'live-1', 'chat-a', []), 'skip');
  assert.equal(gates.decidePendingHeal(P({ state: 'submitting' }), 'live-1', 'chat-a', []), 'skip');
  assert.equal(gates.decidePendingHeal(P(), '', 'chat-a', []), 'skip');
  assert.equal(gates.decidePendingHeal(P(), 'live-1', 'chat-b', []), 'skip');
});

// (c) a new tap blocked by a pending send shows a delivery line instead of dying silently
test('a new tap blocked by an uncertain pending gets a visible delivery line, not silence', () => {
  assert.equal(
    gates.evaluateQueueGate({ storedSessionId: 'chat-a', hasImages: false, pendingState: 'uncertain' }),
    'pending_exists',
  );
  const text = gates.queueGateDeliveryText('pending_exists');
  assert.ok(typeof text === 'string' && text.length > 0);
  assert.match(text, /tap to retry or dismiss/);
});

test('queue gate passes when nothing blocks and names each other guard', () => {
  assert.equal(gates.evaluateQueueGate({ storedSessionId: 'chat-a', hasImages: false, pendingState: null }), 'ok');
  assert.equal(gates.evaluateQueueGate({ storedSessionId: null, hasImages: false, pendingState: null }), 'no_stored_session');
  assert.equal(gates.evaluateQueueGate({ storedSessionId: 'chat-a', hasImages: true, pendingState: null }), 'images_not_queued');
  assert.equal(gates.evaluateQueueGate({ storedSessionId: 'chat-a', hasImages: false, pendingState: 'queued' }), 'pending_exists');
  assert.equal(gates.queueGateDeliveryText('ok'), null);
  assert.equal(gates.queueGateDeliveryText('no_stored_session'), null);
  assert.equal(gates.queueGateDeliveryText('images_not_queued'), null);
});

// (d) diag naming: every silent gate now reports which guard failed
test('flush gate names the exact failing guard', () => {
  const base = { hasPending: true, canAutoSend: true, flushing: false, gwOpen: true, busy: false, hasActiveSid: true, sessionMatches: true };
  assert.equal(gates.evaluateFlushGate(base), null);
  assert.equal(gates.evaluateFlushGate({ ...base, hasPending: false }), 'no_pending');
  assert.equal(gates.evaluateFlushGate({ ...base, canAutoSend: false }), 'not_auto_sendable');
  assert.equal(gates.evaluateFlushGate({ ...base, flushing: true }), 'already_flushing');
  assert.equal(gates.evaluateFlushGate({ ...base, gwOpen: false }), 'gateway_not_open');
  assert.equal(gates.evaluateFlushGate({ ...base, busy: true }), 'busy');
  assert.equal(gates.evaluateFlushGate({ ...base, hasActiveSid: false }), 'no_active_session');
  assert.equal(gates.evaluateFlushGate({ ...base, sessionMatches: false }), 'pending_wrong_chat');
});

// App wiring (source-level): these fail against pre-fix code
test('App.tsx heals uncertain pending on connect, before flushing', () => {
  const src = fs.readFileSync('src/App.tsx', 'utf8');
  const h = src.indexOf('await healUncertainPendingRef.current();');
  const f = src.indexOf('await flushPendingRef.current();', h);
  assert.ok(h !== -1 && f !== -1 && f > h, 'heal must run before flush in handleConnected');
  assert.ok(src.includes('decidePendingHeal('));
  assert.ok(src.includes('returnToQueue(current)'));
});

test('App.tsx emits send_blocked diag on every silent send gate', () => {
  const src = fs.readFileSync('src/App.tsx', 'utf8');
  assert.ok(src.includes('diagLog("send_blocked", { where: "flushPending"'));
  assert.ok(src.includes('diagLog("send_blocked", { where: "sendOrQueue_live"'));
  assert.ok(src.includes('diagLog("send_blocked", { where: "sendOrQueue_queue"'));
  assert.ok(src.includes('diagLog("pending_healed"'));
});

test('App.tsx shows a visible delivery line when a pending send blocks a new tap', () => {
  const src = fs.readFileSync('src/App.tsx', 'utf8');
  assert.ok(src.includes('queueGateDeliveryText(queueGate)'));
  assert.ok(src.includes('setDelivery(blockedText)'));
});

test('Composer.tsx emits send_blocked diag on the busy swallow', () => {
  const src = fs.readFileSync('src/components/Composer.tsx', 'utf8');
  assert.ok(src.includes('diagLog("send_blocked", { guard: "composer_busy" }'));
});
