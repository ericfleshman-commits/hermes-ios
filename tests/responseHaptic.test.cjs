const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const lib = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/responseHaptic.ts','utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: lib });
test('a live reply can tap only once; switching chats disarms it', () => {
  const gate = lib.createReplyHapticGate();
  gate.start('chat-a');
  assert.equal(gate.complete('chat-a', 'complete', true), true);
  assert.equal(gate.complete('chat-a', 'complete', true), false);
  gate.start('chat-a');
  gate.clear();
  assert.equal(gate.complete('chat-a', 'complete', true), false);
  gate.start('chat-a');
  assert.equal(gate.complete('chat-b', 'complete', true), false);
});

test('Stop disarms even if a late success completion arrives', () => {
  const gate = lib.createReplyHapticGate();
  gate.start('chat-a');
  gate.clear(); // interrupt() clears this before awaiting session.interrupt
  assert.equal(gate.complete('chat-a', 'complete', true), false);
});

test('one haptic for a successful foreground reply to the active chat', () => {
  assert.equal(lib.shouldTapForReply('chat-a', 'chat-a', 'complete', true), true);
  assert.equal(lib.shouldTapForReply(null, 'chat-a', 'complete', true), false);
  assert.equal(lib.shouldTapForReply('chat-a', 'chat-b', 'complete', true), false);
  assert.equal(lib.shouldTapForReply('chat-a', 'chat-a', 'error', true), false);
  assert.equal(lib.shouldTapForReply('chat-a', 'chat-a', 'complete', false), false);
});
test('tapOnSend fires one light tap through the injected haptics', () => {
  const calls = [];
  const haptics = {
    impactAsync: async style => { calls.push(style); },
    ImpactFeedbackStyle: { Light: 'light' },
  };
  lib.tapOnSend(haptics);
  assert.deepEqual(calls, ['light']);
});

test('tapOnSend never throws and never leaks a rejection', () => {
  assert.doesNotThrow(() => lib.tapOnSend(undefined));
  assert.doesNotThrow(() => lib.tapOnSend({ impactAsync: () => { throw new Error('nope'); } }));
  assert.doesNotThrow(() => lib.tapOnSend({ impactAsync: async () => { throw new Error('async nope'); } }));
});
