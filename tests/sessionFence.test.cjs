const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function lib() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/sessionFence.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {exports});
  return exports;
}
// Verbatim from hermes_cli/active_sessions.py session_already_owned_message().
const REFUSAL = 'This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.\nDetails: session 20260829_110940_3c12a6 opened by desktop 5m ago.';

test('the fence refusal is detected', () => {
  const { isSessionFencedElsewhere } = lib();
  assert.equal(isSessionFencedElsewhere(REFUSAL), true);
  assert.equal(isSessionFencedElsewhere('network timeout'), false);
});

test('the notice names the owner and drops lease jargon', () => {
  const { fenceNotice } = lib();
  const notice = fenceNotice(REFUSAL);
  assert.match(notice, /desktop app on your Mac/);
  assert.match(notice, /5m ago/);
  assert.ok(!notice.includes('Details:'), 'owner detail line must not reach the transcript');
  assert.ok(!notice.includes('20260829_110940_3c12a6'), 'session id must not reach the transcript');
  assert.match(notice, /one writer per chat/);
  assert.match(notice, /new chat/, 'the way out is offered');
});

test('unknown surfaces and missing detail still produce a usable sentence', () => {
  const { fenceNotice, isSessionFencedElsewhere } = lib();
  const bare = 'This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.';
  assert.equal(isSessionFencedElsewhere(bare), true);
  assert.match(fenceNotice(bare), /another Hermes window/);
  assert.match(fenceNotice('This chat is open in another Hermes window/terminal.\nDetails: session abc opened by mobile 2s ago.'), /mobile app/);
});
