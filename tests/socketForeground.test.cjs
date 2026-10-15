const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

test('foreground keeps a healthy socket when ping takes longer than 600 ms', async () => {
  let onAppState;
  let socket;
  let hook;
  const AppState = {
    currentState: 'active',
    addEventListener: (_event, fn) => {
      onAppState = fn;
      return { remove() { if (onAppState === fn) onAppState = undefined; } };
    },
  };
  class GatewayClient {
    constructor() { socket = this; this.state = 'idle'; this.disconnects = 0; }
    onState(fn) { this.onChange = fn; }
    on() {}
    async connect() { this.state = 'open'; this.onChange('open'); }
    request(method, _params, timeoutMs) {
      assert.equal(method, 'gateway.ping');
      this.pingDeadline = timeoutMs;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('request timeout')), timeoutMs);
        this.finishPing = () => { clearTimeout(timer); resolve({}); };
      });
    }
    disconnect() { this.disconnects++; this.state = 'closed'; this.onChange('closed'); }
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
      if (id === '../lib/auth') return { HOST: 'example.test', getWsTicket: async () => ({ ticket: 'ticket' }), readStoredSessionId: async () => undefined, prefetchWsTicket: async () => {}, takeWarmTicket: () => null };
      throw new Error(`unexpected import: ${id}`);
    },
    console, setTimeout, clearTimeout, Promise,
  });
  function Probe() { hook = exports.useHermesSocket({}); return null; }
  let root;
  await act(async () => { root = create(React.createElement(Probe)); });
  try {
    await act(async () => { await hook.connectGateway(); });
    assert.equal(hook.conn, 'open');
    const original = socket;
    await act(async () => { onAppState('background'); onAppState('active'); });
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(original.disconnects, 0, 'a slow ping is not proof that the socket is dead');
    assert.ok(original.pingDeadline >= 3000, 'foreground health check must allow normal network jitter');
    original.finishPing();
  } finally {
    await act(async () => { root.unmount(); });
  }
});
