const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/submitOnce.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
    { exports, WeakSet, require(n) { throw Error(`unexpected import ${n}`); } });
  return exports;
}
function rpcError(code, message = 'err') { const e = new Error(message); e.code = code; return e; }

// A fake Mac: with the plugin it dedupes by client_msg_id; without it, it
// knows only prompt.submit.
function mac({ plugin = true, failNext = null } = {}) {
  const calls = []; const seen = new Set(); const turns = [];
  return {
    calls, turns,
    async request(method, params) {
      calls.push(method);
      if (failNext) { const f = failNext; failNext = null; throw f; }
      if (method === 'prompt.submit_once') {
        if (!plugin) throw rpcError(-32601, 'unknown method');
        if (seen.has(params.client_msg_id)) return { status: 'duplicate' };
        seen.add(params.client_msg_id); turns.push(params.text); return { status: 'streaming' };
      }
      if (method === 'prompt.submit') { turns.push(params.text); return { status: 'streaming' }; }
      throw rpcError(-32601);
    },
  };
}

test('resending the same outbox item never starts a second reply', async () => {
  const { submitOnce } = load(); const gw = mac();
  assert.equal(await submitOnce(gw, 's', 'hello', 'item-000001'), 'sent');
  assert.equal(await submitOnce(gw, 's', 'hello', 'item-000001'), 'duplicate');
  assert.deepEqual(gw.turns, ['hello']);
});

test('an older Mac without the plugin still gets the message, once per call', async () => {
  const { submitOnce, dedupesSends } = load(); const gw = mac({ plugin: false });
  assert.equal(await submitOnce(gw, 's', 'hi', 'item-000002'), 'sent');
  assert.deepEqual(gw.turns, ['hi']);
  assert.equal(dedupesSends(gw), false);
  await submitOnce(gw, 's', 'again', 'item-000003');
  assert.deepEqual(gw.calls, ['prompt.submit_once', 'prompt.submit', 'prompt.submit'], 'asks only once per connection');
});

test('a timeout or busy error is never turned into a plain resend', async () => {
  const { submitOnce } = load();
  for (const err of [new Error('request timeout'), rpcError(4009, 'busy')]) {
    const gw = mac({ failNext: err });
    await assert.rejects(submitOnce(gw, 's', 'x', 'item-000004'));
    assert.deepEqual(gw.calls, ['prompt.submit_once']);
    assert.deepEqual(gw.turns, []);
  }
});

test('a new connection checks for the plugin again', async () => {
  const { submitOnce, dedupesSends } = load();
  const old = mac({ plugin: false }); await submitOnce(old, 's', 'a', 'item-000005');
  const fresh = mac();
  assert.equal(dedupesSends(fresh), true);
  await submitOnce(fresh, 's', 'b', 'item-000006');
  assert.deepEqual(fresh.calls, ['prompt.submit_once']);
});
