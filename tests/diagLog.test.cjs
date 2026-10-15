const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/diagLog.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, console });
  return exports;
}

test('ring buffer is bounded at 300 and drops the oldest entries', () => {
  const d = load();
  for (let i = 0; i < 350; i++) d.diagLog('timeout', { i });
  assert.equal(d.diagCount(), 300);
  const drained = d.drainDiag();
  assert.equal(drained.length, 300);
  assert.equal(drained[0].detail.i, 50);
  assert.equal(drained[299].detail.i, 349);
});

test('drain returns entries and clears the buffer', () => {
  const d = load();
  d.diagLog('reconnect_attempt', { attempt: 1 });
  d.diagLog('reconnect_ok', { attempts: 2 });
  const out = d.drainDiag();
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'reconnect_attempt');
  assert.match(out[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(d.diagCount(), 0);
  assert.equal(d.drainDiag().length, 0);
});

test('diagLog never throws on garbage input', () => {
  const d = load();
  const circular = { a: 1 };
  circular.self = circular;
  const evil = { toString() { throw new Error('nope'); } };
  assert.doesNotThrow(() => {
    d.diagLog(undefined);
    d.diagLog(null);
    d.diagLog(123);
    d.diagLog('');
    d.diagLog('x');                    // no detail
    d.diagLog('x', null);
    d.diagLog('x', 'plain string');
    d.diagLog('x', 42);
    d.diagLog('x', circular);          // circular structure
    d.diagLog('x', evil);              // hostile toString
    d.diagLog('x', Symbol('s'));       // String(symbol) throws
    d.diagLog('x', 'y'.repeat(100000)); // oversized detail gets truncated
    d.drainDiag();
    d.diagCount();
  });
  const out = d.drainDiag();
  assert.equal(out.length, 0); // drained above
  assert.ok(d.diagCount() >= 0);
});

test('oversized detail is truncated, not dropped', () => {
  const d = load();
  d.diagLog('rpc_error', { blob: 'z'.repeat(100000) });
  const [ev] = d.drainDiag();
  assert.equal(ev.detail.truncated, true);
  assert.ok(ev.detail.preview.length <= 4000);
});

test('blank kinds normalize to "unknown"', () => {
  const d = load();
  d.diagLog('');
  const [ev] = d.drainDiag();
  assert.equal(ev.kind, 'unknown');
});
