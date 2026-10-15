// Uncertain-send self-heal must decide only from fresh server evidence.
// A wrong "clear" silently loses the user's only durable copy; a wrong
// "requeue" sends a duplicate server turn (prompt.submit has no idempotency key).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(path, extra = {}) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, ...extra },
  );
  return exports;
}
const gates = load('src/lib/sendGates.ts');
const NOW = 1_000_000_000;
const OLD = NOW - 5 * 60 * 1000;
const P = (over = {}) => ({ id: 'p1', sessionId: 'chat-a', text: 'hello there', state: 'uncertain', baseRowId: 10, uncertainAt: OLD, ...over });
const S = (id, role, text) => ({ id: `srv:${id}`, role, text });
const L = (role, text) => ({ id: `u-${Math.random()}`, role, text });
const heal = (p, rows, now = NOW) => gates.decidePendingHeal(p, 'live-1', 'chat-a', rows, now);

test('the app\'s own unsent local bubble never proves delivery', () => {
  assert.equal(heal(P(), [S(9, 'assistant', 'hi'), L('user', 'hello there')]), 'requeue');
});

test('no fresh server history means no decision: the pending stays uncertain', () => {
  assert.equal(heal(P(), null), 'skip');
  assert.equal(heal(P(), undefined), 'skip');
});

test('an earlier identical message at or before the baseline does not count', () => {
  assert.equal(heal(P({ text: 'ok' }), [S(8, 'user', 'ok'), S(10, 'assistant', 'done')]), 'requeue');
});

test('a matching server user row after the baseline clears without resending', () => {
  assert.equal(heal(P(), [S(10, 'assistant', 'x'), S(11, 'user', 'hello there')]), 'clear');
});

test('server text cleanup (outer whitespace) still counts as delivered', () => {
  assert.equal(heal(P({ text: '  hello there\n' }), [S(11, 'user', 'hello there')]), 'clear');
});

test('without a baseline a match is ambiguous, so leave it for the user', () => {
  assert.equal(heal(P({ baseRowId: null }), [S(3, 'user', 'hello there')]), 'skip');
  assert.equal(heal(P({ baseRowId: undefined }), [S(3, 'user', 'hello there')]), 'skip');
});

test('a recent uncertain send is not requeued: the server may still be accepting it', () => {
  assert.equal(heal(P({ uncertainAt: NOW - 5000 }), [S(9, 'user', 'other')]), 'skip');
  assert.equal(heal(P({ uncertainAt: undefined }), [S(9, 'user', 'other')]), 'skip');
  // but fresh evidence of delivery still clears at once
  assert.equal(heal(P({ uncertainAt: NOW - 5000 }), [S(11, 'user', 'hello there')]), 'clear');
});

test('baseline helper reads only server row ids', () => {
  assert.equal(gates.latestServerRowId([L('user', 'a'), S(4, 'user', 'b'), S(12, 'assistant', 'c'), { id: 'srv:x', role: 'user', text: '' }]), 12);
  assert.equal(gates.latestServerRowId([L('user', 'a')]), null);
});

// Outbox persistence (baseline, uncertain time) is covered in pendingSend.test.cjs.

test('App heals from a fresh server fetch, not the local transcript', () => {
  const src = fs.readFileSync('src/App.tsx', 'utf8');
  const start = src.indexOf('const healUncertainPending = useCallback');
  const end = src.indexOf('healUncertainPendingRef.current = healUncertainPending');
  const body = src.slice(start, end);
  assert.ok(start !== -1 && end > start);
  assert.ok(!body.includes('messagesRef.current'), 'heal must not read the local transcript');
  assert.ok(body.includes('fetchJSON'), 'heal must fetch server history itself');
  assert.ok(body.includes('mapServerMessages'));
  assert.ok(src.includes('markSubmitting(pending, latestServerRowId('), 'flush must record a baseline');
});
