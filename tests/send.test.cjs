const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Run the actual App callbacks, replacing only hooks and native/network I/O.
function setup(upload, request) {
  const source = fs.readFileSync('src/App.tsx', 'utf8');
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = [];
  function visit(node) {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ['send', 'retryLast'].includes(d.name.getText(ast)))) {
      declarations.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const busyRef = { current: false };
  const errors = [];
  const lastFailed = { current: null };
  const userMessages = [];
  const patched = [];
  const failedTurnsRef = { current: new Map() };
  const busyOwnerRef = { current: null };
  const context = {
    exports: {}, useCallback: fn => fn, busyRef, lastFailed,
    activeSession: 's1', activeSessionRef: { current: 's1' }, mounted: { current: true },
    gwRef: { current: { state: 'open', request } },
    setBusy: value => { busyRef.current = value; },
    setDelivery: value => { context.delivery = value; }, conn: "open",
    setToolActivity: () => {}, setBusyLabel: () => {},
    tapOnSend: () => { context.taps = (context.taps || 0) + 1; },
    addUserMessage: (text, images) => { userMessages.push({ text, images }); return `u-${userMessages.length}`; },
    patchMessage: (id, fn) => { patched.push(id); },
    clearRetryErrors: () => {},
    modelRef: { current: 'test-model' },
    ensureModelSelected: async () => { context.modelEnsured = (context.modelEnsured || 0) + 1; },
    failedTurnsRef, busyOwnerRef,
    addErrorMessage: msg => errors.push(msg), setRetryError: msg => errors.push(msg),
    Haptics: { impactAsync: async () => {}, ImpactFeedbackStyle: { Light: 'light' } },
    BASE: 'http://local.invalid', authFetch: upload, silentLogin: async () => false,
    AbortController, setTimeout, clearTimeout,
    // The send path now flashes "Sent" through a ref-held timer; capture the
    // real setTimeout/clearTimeout through the sandbox's own scope.
    sentTimer: { current: null },
  };
  if (fs.existsSync('src/lib/submitTurn.ts')) {
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/submitTurn.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText, { exports: module.exports });
    context.submitTurn = module.exports.submitTurn;
  }
  vm.runInNewContext(ts.transpileModule(declarations.join('\n') + '\nexports.send = send; exports.retryLast = retryLast;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return { ...context.exports, errors, lastFailed, context, userMessages, patched, failedTurnsRef };
}

const photos = [{ uri: 'a', base64: 'a', name: 'a.jpg' }, { uri: 'b', base64: 'b', name: 'b.jpg' }];
test('App retry retains photos and previously uploaded paths after second photo fails', async () => {
  let uploads = 0;
  const prompts = [];
  const app = setup(async () => {
    uploads++;
    if (uploads === 2) return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ path: `/photo-${uploads}` }) };
  }, async (_, params) => prompts.push(params));
  await app.send('hello', photos);
  assert.equal(prompts.length, 0);
  await app.retryLast();
  assert.equal(uploads, 3, 'retry must upload the missing photo');
  assert.equal(prompts[0].text, '@image:/photo-1\n\n@image:/photo-3\n\nhello');
});

test('upload timeout remains retryable but submit timeout does not', async () => {
  let uploadFails = true;
  let submits = 0;
  const app = setup(async () => {
    if (uploadFails) throw new Error('upload timeout');
    return { ok: true, json: async () => ({ path: '/photo' }) };
  }, async () => { submits++; throw new Error('request timeout'); });
  await app.send('hello', photos.slice(0, 1));
  assert.ok(app.lastFailed.current, 'no prompt was submitted, so upload can retry');
  uploadFails = false;
  await app.retryLast();
  assert.equal(submits, 1);
  assert.equal(app.lastFailed.current, null, 'unknown delivery must not offer blind retry');
  await app.retryLast();
  assert.equal(submits, 1);
});

test('any failure after prompt submission cannot offer blind retry', async () => {
  let submits = 0;
  const app = setup(async () => ({}), async () => { submits++; throw new Error('ws error'); });
  await app.send('hello', []);
  assert.equal(app.lastFailed.current, null);
  await app.retryLast();
  assert.equal(submits, 1);
});

test('late upload failure cannot overwrite another chat retry state', async () => {
  let rejectUpload;
  const app = setup(() => new Promise((_, reject) => { rejectUpload = reject; }), async () => {});
  const sending = app.send('hello', photos);
  app.context.activeSessionRef.current = 's2';
  const newerFailure = { sessionId: 's2', text: 'newer', images: [], imagePaths: [] };
  app.lastFailed.current = newerFailure;
  rejectUpload(new Error('upload failed'));
  await sending;
  assert.equal(app.lastFailed.current, newerFailure);
  assert.equal(app.errors.length, 0);
});

test('send reports submission and acknowledgement separately', async () => {
  let accept;
  const app = setup(async () => ({}), () => new Promise(r => { accept = r; }));
  const sending = app.send('hello', []);
  assert.equal(app.context.delivery, 'Sending');
  accept({});
  await sending;
  assert.equal(app.context.delivery, 'Sent');
});

test('a successful send clears its own status so the footer goes quiet', async () => {
  const app = setup(async () => ({}), async () => {});
  await app.send('hello', []);
  assert.equal(app.context.delivery, 'Sent');
  await new Promise(r => setTimeout(r, 1250));
  assert.equal(app.context.delivery, '', 'Sent must auto-clear; failure states must not');
});
test('a stale send callback cannot submit after a chat switch retires its live ID', async () => {
  let submits=0;
  const app=setup(async () => ({}),async () => {submits++;});
  app.context.activeSessionRef.current='';
  await app.send('must not reach old chat',[]);
  assert.equal(submits,0);
  assert.equal(app.context.busyRef.current,false);
});

test('failed send marks the message inline, keeps the text, and offers tap-to-retry', async () => {
  let uploads = 0;
  const app = setup(async () => { uploads++; throw new Error('photo a.jpg upload failed (500)'); }, async () => {});
  await app.send('keep me', [{ uri: 'a', base64: 'a', name: 'a.jpg' }]);
  assert.ok(app.lastFailed.current, 'failed turn must be kept for retry');
  assert.deepEqual(app.patched, ['u-1'], 'the user bubble must gain the failed state');
  assert.equal(app.context.delivery, 'Failed to send · Tap the message to retry');
  assert.equal(app.errors.length, 0, 'no separate error row for a failed send');
  assert.equal(app.userMessages[0].text, 'keep me', 'the draft text must survive on the message');
  assert.ok(app.failedTurnsRef.current.has('u-1'), 'tap-to-retry must find the exact turn');
});

test('retrying a failed message clears its inline error state on success', async () => {
  let failUpload = true;
  const app = setup(async () => {
    if (failUpload) throw new Error('upload timeout');
    return { ok: true, json: async () => ({ path: '/photo' }) };
  }, async () => {});
  await app.send('hello', [{ uri: 'a', base64: 'a', name: 'a.jpg' }]);
  assert.deepEqual(app.patched, ['u-1']);
  assert.equal(app.context.delivery, 'Failed to send · Tap the message to retry');
  failUpload = false;
  await app.retryLast();
  // Lifecycle: failure marks the bubble, retry marks it sending again,
  // ack clears both - the same bubble, no duplicate.
  assert.deepEqual(app.patched, ['u-1', 'u-1', 'u-1'], 'retry must go failed -> sending -> sent on one bubble');
  assert.equal(app.context.delivery, 'Sent');
  assert.equal(app.userMessages.length, 1, 'retry must not add a second bubble');
  assert.equal(app.lastFailed.current, null);
});

test('send fills the default model before submitting when none is selected', async () => {
  let submits = 0;
  const app = setup(async () => ({}), async () => { submits++; });
  app.context.modelRef.current = '';
  await app.send('hello', []);
  assert.equal(app.context.modelEnsured, 1, 'the persisted default must be ensured before submit');
  assert.equal(submits, 1, 'the send must still go out');
});

test('send skips the model ensure when a model is already selected', async () => {
  const app = setup(async () => ({}), async () => {});
  await app.send('hello', []);
  assert.equal(app.context.modelEnsured || 0, 0);
});

module.exports = { setup, photos };

test('a user-initiated send taps once, and a manual retry taps once more', async () => {
  const app = setup(async () => ({}), async () => {});
  await app.send('hello', []);
  assert.equal(app.context.taps, 1, 'one haptic per send, never a double-fire');
  app.context.busyRef.current = false; // the harness never completes a stream
  await app.send('again', []);
  assert.equal(app.context.taps, 2);
});
