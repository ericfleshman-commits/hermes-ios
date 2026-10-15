const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function setup() {
  let now = 0;
  const sockets = [], intervals = new Set(), timers = new Set();
  class Socket {
    static OPEN = 1;
    constructor() { sockets.push(this); this.readyState = 0; }
    close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
    send() {}
  }
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/gateway.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, WebSocket: Socket, Date: { now: () => now },
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
    setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn),
  });
  return { client: new exports.GatewayClient('ws://test.invalid'), sockets, timers, intervals,
    advance: ms => { now += ms; for (const fn of [...intervals]) fn(); } };
}

for (const opened of [false, true]) {
  test(`socket error cleans up ${opened ? 'an open connection' : 'a handshake'}`, async () => {
    const h = setup();
    const connecting = h.client.connect();
    const socket = h.sockets[0];
    const lateOpen = socket.onopen;
    let rejected;
    if (opened) {
      socket.readyState = 1;
      socket.onopen();
      await connecting;
      rejected = assert.rejects(h.client.request('test'), /ws error/);
    } else {
      rejected = assert.rejects(connecting, /ws error/);
    }
    socket.onerror();
    assert.equal(socket.closed, true);
    assert.ok(['closed', 'error'].includes(h.client.state));
    await rejected;
    lateOpen();
    assert.notEqual(h.client.state, 'open');
    assert.equal(h.intervals.size, 0);
    assert.equal(h.timers.size, 0);
  });
}

test('heartbeat failure retires socket and ignores its late events before reconnect', async () => {
  const h = setup();
  const events = [];
  h.client.on('*', ev => events.push(ev));
  const connected = h.client.connect();
  const old = h.sockets[0];
  old.readyState = 1;
  old.onopen();
  await connected;
  const lateMessage = old.onmessage, lateClose = old.onclose;
  const pending = assert.rejects(h.client.request('test'), /heartbeat timeout/);
  h.advance(46000);
  await pending;
  assert.equal(old.closed, true, 'dead socket must close, not just lose its reference');
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timers.size, 0);
  lateMessage({ data: JSON.stringify({ method: 'message.delta', params: { text: 'stale' } }) });
  assert.equal(events.length, 0, 'late data must not enter the transcript');
  const retry = h.client.connect();
  const fresh = h.sockets[1];
  fresh.readyState = 1;
  fresh.onopen();
  await retry;
  lateClose();
  assert.equal(h.client.state, 'open');
  h.client.disconnect();
});
