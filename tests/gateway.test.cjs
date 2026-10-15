const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('stalled connection closes its socket, leaves connecting, and permits retry', async () => {
  const sockets = [];
  const timers = new Set();
  class Socket {
    static OPEN = 1;
    constructor() { sockets.push(this); this.readyState = 0; }
    close() { this.closed = true; }
  }
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/gateway.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, WebSocket: Socket, Date, Map, Set,
    setTimeout: (fn) => { timers.add(fn); return fn; },
    clearTimeout: (fn) => timers.delete(fn),
    setInterval: () => 1, clearInterval: () => {},
  });
  const client = new exports.GatewayClient('ws://test.invalid');
  const states = [];
  client.onState(s => states.push(s));
  const attempt = client.connect();
  const rejection = assert.rejects(attempt, /connect timeout/);
  const lateOpen = sockets[0].onopen;
  for (const timer of [...timers]) timer();
  await rejection;
  assert.ok(['closed', 'error'].includes(client.state), `state stayed ${client.state}`);
  assert.equal(sockets[0].closed, true);
  lateOpen();
  assert.notEqual(client.state, 'open', 'late open must not revive expired socket');
  const retry = client.connect();
  assert.equal(sockets.length, 2);
  sockets[1].onopen();
  await retry;
  assert.equal(client.state, 'open');
  assert.ok(states.includes('closed') || states.includes('error'));
  client.disconnect();
});
