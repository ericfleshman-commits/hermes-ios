const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadModule(path) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports });
  return exports;
}

const IMGS = [
  { uri: 'u1', base64: 'b1', name: 'a.jpg' },
  { uri: 'u2', base64: 'b2', name: 'b.jpg' },
  { uri: 'u3', base64: 'b3', name: 'c.jpg' },
];

test('retry after mid-batch upload failure re-uploads only the remaining photos', async () => {
  const { submitTurn } = loadModule('src/lib/submitTurn.ts');
  const donePaths = [];
  const uploaded = [];
  const io = {
    uploadImage: async (img) => {
      uploaded.push(img.name);
      if (img.name === 'b.jpg') throw new Error('photo b.jpg upload failed (500)');
      return `srv-${img.name}`;
    },
    submit: async () => { throw new Error('should not submit'); },
  };
  await assert.rejects(
    submitTurn('s1', 'hello', IMGS, donePaths, io),
    /upload failed/,
  );
  assert.deepEqual(donePaths, ['srv-a.jpg'], 'completed uploads must survive the failure');
  await submitTurn('s1', 'hello', IMGS, donePaths, {
    uploadImage: async (img) => { uploaded.push(img.name); return `srv-${img.name}`; },
    submit: async (sid, body) => { io.lastBody = body; io.sid = sid; },
  });
  assert.deepEqual(uploaded, ['a.jpg', 'b.jpg', 'b.jpg', 'c.jpg'], 'a.jpg must not re-upload');
  assert.equal(io.sid, 's1');
  assert.equal(io.body ?? io.lastBody, '@image:srv-a.jpg\n\n@image:srv-b.jpg\n\n@image:srv-c.jpg\n\nhello');
});

test('retry after a submit failure reuses uploads and submits only', async () => {
  const { submitTurn } = loadModule('src/lib/submitTurn.ts');
  const donePaths = [];
  let fail = true;
  const io = {
    uploadImage: async (img) => `srv-${img.name}`,
    submit: async () => { if (fail) { fail = false; throw new Error('request timeout'); } },
  };
  await assert.rejects(submitTurn('s1', 'hello', IMGS, donePaths, io), /request timeout/);
  assert.equal(donePaths.length, 3);
  await submitTurn('s1', 'hello', IMGS, donePaths, io);
  assert.equal(donePaths.length, 3, 'completed uploads must not run twice');
});

test('text-only and photo-only turns build correct bodies', async () => {
  const { submitTurn } = loadModule('src/lib/submitTurn.ts');
  const seen = [];
  const io = {
    uploadImage: async (img) => `srv-${img.name}`,
    submit: async (sid, body) => seen.push(body),
  };
  await submitTurn('s', 'just text', [], [], io);
  await submitTurn('s', '', IMGS.slice(0, 1), [], io);
  assert.deepEqual(seen, ['just text', '@image:srv-a.jpg']);
});

test('uploads retry with exponential backoff and report each retry', async () => {
  const { submitTurn } = loadModule('src/lib/submitTurn.ts');
  const sleeps = [];
  const retries = [];
  let attempts = 0;
  const seen = [];
  const io = {
    uploadImage: async img => { attempts++; if (attempts < 3) throw new Error('flaky network'); return `srv-${img.name}`; },
    submit: async (sid, body) => seen.push(body),
  };
  await submitTurn('s', 'hi', IMGS.slice(0, 1), [], io, {
    maxUploadAttempts: 3,
    uploadRetryDelayMs: 1000,
    sleep: async ms => { sleeps.push(ms); },
    onUploadRetry: (attempt, max, err) => retries.push([attempt, max, err.message]),
  });
  assert.equal(attempts, 3, 'two failures then a success');
  assert.deepEqual(sleeps, [1000, 2000], 'exponential backoff between retries');
  assert.deepEqual(retries, [[2, 3, 'flaky network'], [3, 3, 'flaky network']]);
  assert.deepEqual(seen, ['@image:srv-a.jpg\n\nhi']);
});

test('uploads give up after max attempts and the submit is never auto-retried', async () => {
  const { submitTurn } = loadModule('src/lib/submitTurn.ts');
  let uploads = 0, submits = 0;
  const io = {
    uploadImage: async () => { uploads++; throw new Error('still down'); },
    submit: async () => { submits++; },
  };
  await assert.rejects(
    submitTurn('s', 'hi', IMGS.slice(0, 1), [], io, { maxUploadAttempts: 2, sleep: async () => {} }),
    /still down/,
  );
  assert.equal(uploads, 2, 'exactly maxUploadAttempts tries');
  assert.equal(submits, 0, 'a failed upload never reaches submit');
  // The submit RPC itself is always single-attempt: a post-submit timeout
  // may hide an accepted prompt, so only tap-to-retry may replay it.
  let submitCalls = 0;
  const io2 = {
    uploadImage: async img => `srv-${img.name}`,
    submit: async () => { submitCalls++; throw new Error('request timeout'); },
  };
  await assert.rejects(
    submitTurn('s', 'hi', [], [], io2, { maxUploadAttempts: 3, sleep: async () => {} }),
    /request timeout/,
  );
  assert.equal(submitCalls, 1, 'submit is never retried automatically');
});

test('the default policy still fails fast on the first upload error', async () => {
  const { submitTurn } = loadModule('src/lib/submitTurn.ts');
  let uploads = 0;
  const io = {
    uploadImage: async () => { uploads++; throw new Error('boom'); },
    submit: async () => {},
  };
  await assert.rejects(submitTurn('s', 'hi', IMGS.slice(0, 1), [], io), /boom/);
  assert.equal(uploads, 1, 'no opts means one attempt: tap-to-retry owns the retry');
});
