const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Run the real App retryMessage callback: error rows with no recorded turn
// (e.g. the busy-timeout row) must retry the nearest earlier user prompt
// instead of silently doing nothing.
function setup() {
  const source = fs.readFileSync('src/App.tsx', 'utf8');
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['promptBefore', 'retryFromMessage', 'retryMessage'];
  const declarations = [];
  function visit(node) {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.includes(d.name.getText(ast)))) {
      declarations.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(declarations.length, 3, 'retry declarations not found');
  const sends = [];
  const errors = [];
  const failedTurnsRef = { current: new Map() };
  const context = {
    exports: {}, useCallback: fn => fn,
    failedTurnsRef,
    lastFailed: { current: null },
    activeSessionRef: { current: 's1' },
    messagesRef: { current: [] },
    addErrorMessage: (m) => { errors.push(m); },
    send: async (text, images, retry) => { sends.push({ text, images, retry }); return true; },
  };
  vm.runInNewContext(ts.transpileModule(declarations.join('\n') + '\nexports.retryMessage = retryMessage;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return { retryMessage: context.exports.retryMessage, sends, errors, failedTurnsRef, context };
}

test('tap-to-retry on a timeout error replays the nearest earlier user prompt', async () => {
  const h = setup();
  h.context.messagesRef.current = [
    { id: 'u1', role: 'user', text: 'what time is it' },
    { id: 'e9', role: 'error', text: 'Request timed out \u2014 tap to retry' },
  ];
  await h.retryMessage({ id: 'e9', role: 'error', text: 'Request timed out \u2014 tap to retry' });
  assert.equal(h.sends.length, 1, 'retry must send something');
  assert.equal(h.sends[0].text, 'what time is it');
});

test('tap-to-retry still replays a recorded turn exactly', async () => {
  const h = setup();
  const turn = { sessionId: 's1', text: 'orig', images: [{ uri: 'x' }], imagePaths: [] };
  h.failedTurnsRef.current.set('u2', turn);
  await h.retryMessage({ id: 'u2', role: 'user', text: 'orig', sendFailed: true });
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].text, 'orig');
  assert.deepEqual(h.sends[0].images, [{ uri: 'x' }]);
  assert.equal(h.sends[0].retry, turn);
});

test('tap-to-retry on an error with no earlier prompt reports it', async () => {
  const h = setup();
  h.context.messagesRef.current = [
    { id: 'e9', role: 'error', text: 'Request timed out \u2014 tap to retry' },
  ];
  await h.retryMessage({ id: 'e9', role: 'error', text: 'Request timed out \u2014 tap to retry' });
  assert.equal(h.sends.length, 0);
  assert.ok(h.errors.some((e) => e.includes('Nothing to retry')));
});
