const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Run the real App interrupt callback: Stop must clear the UI the instant it
// is tapped, never waiting on the interrupt RPC (a dead socket used to wedge
// the busy pill until the heartbeat timeout retired the request).
function setup(gw) {
  const source = fs.readFileSync('src/App.tsx', 'utf8');
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = [];
  function visit(node) {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === 'interrupt')) {
      declarations.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(declarations.length, 1, 'interrupt declaration not found');
  const calls = [];
  const requests = [];
  const context = {
    exports: {}, useCallback: fn => fn,
    gwRef: { current: gw },
    activeSession: 's1',
    replyHaptic: { clear: () => { calls.push('haptic-clear'); } },
    storeInterrupt: () => { calls.push('storeInterrupt'); },
  };
  vm.runInNewContext(ts.transpileModule(declarations.join('\n') + '\nexports.interrupt = interrupt;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return { interrupt: context.exports.interrupt, calls, requests, gw };
}

test('Stop clears the UI immediately without waiting for the interrupt RPC', () => {
  const requests = [];
  const gw = {
    request: (...args) => { requests.push(args); return new Promise(() => {}); },
  };
  const { interrupt, calls } = setup(gw);
  interrupt();
  assert.deepEqual(calls, ['haptic-clear', 'storeInterrupt'],
    'Stop must clear local state synchronously, even with a hung RPC');
  assert.equal(requests.length, 1, 'interrupt RPC must still be attempted');
  assert.equal(requests[0][0], 'session.interrupt');
  assert.equal(requests[0][1].session_id, 's1');
  assert.equal(requests[0][2], 5000, 'interrupt RPC must be bounded');
});

test('Stop clears local state even with no socket', () => {
  const { interrupt, calls } = setup(null);
  interrupt();
  assert.deepEqual(calls, ['haptic-clear', 'storeInterrupt']);
});
