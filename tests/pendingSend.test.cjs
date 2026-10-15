const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Fake device: documents directory (file name -> text) and Keychain.
function device() { return { files: new Map(), keychain: new Map(), failWrites: false }; }
function load(dev) {
  const exports = {};
  class File {
    constructor(_dir, name) { this.name = name; }
    get exists() { return dev.files.has(this.name); }
    create() { dev.files.set(this.name, ''); }
    async text() { return dev.files.get(this.name); }
    write(s) { if (dev.failWrites) throw Error('disk full'); dev.files.set(this.name, s); }
  }
  const mods = {
    'expo-secure-store': {
      getItemAsync: async k => dev.keychain.get(k) ?? null,
      setItemAsync: async (k, v) => dev.keychain.set(k, v),
      deleteItemAsync: async k => dev.keychain.delete(k),
    },
    'expo-file-system': { File, Paths: { document: {} } },
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync('src/lib/pendingSend.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, require: n => { if (!mods[n]) throw Error(n); return mods[n]; } },
  );
  return exports;
}

test('a queued text is tied to its durable chat and survives relaunch', async () => {
  const dev = device();
  const queued = await load(dev).queueText('chat-a', 'hello');
  assert.equal((await load(dev).loadPending('chat-a')).text, 'hello');
  assert.equal(await load(dev).loadPending('chat-b'), null);
  assert.ok(queued.id);
});

test('several messages queue in order instead of blocking the second', async () => {
  const dev = device(), api = load(dev);
  await api.queueText('a', 'first');
  await api.queueText('a', 'second');
  await api.queueText('b', 'other chat');
  assert.deepEqual(Array.from(await load(dev).loadOutbox(), i => i.text), ['first', 'second', 'other chat']);
});

test('concurrent queues never lose a message', async () => {
  const dev = device(), api = load(dev);
  await Promise.all(['1', '2', '3', '4', '5'].map(t => api.queueText('a', t)));
  assert.equal((await load(dev).loadOutbox()).length, 5);
});

test('long messages are accepted (no Keychain size limit any more)', async () => {
  const dev = device();
  await load(dev).queueText('a', 'x'.repeat(20000));
  assert.equal((await load(dev).loadPending('a')).text.length, 20000);
});

test('in-flight and uncertain sends never auto-dispatch', async () => {
  const api = load(device());
  const inflight = await api.markSubmitting(await api.queueText('chat-a', 'hello'), 7);
  assert.equal(api.canAutoSend(inflight), false);
  assert.equal(inflight.baseRowId, 7);
  const uncertain = await api.markUncertain(inflight);
  assert.equal(api.canAutoSend(uncertain), false);
  assert.equal(typeof uncertain.uncertainAt, 'number');
  await api.clearPending(uncertain);
  assert.equal(await api.loadPending('chat-a'), null);
});

test('a kill during submit becomes uncertain on relaunch, never resent blind', async () => {
  const dev = device(), api = load(dev);
  await api.markSubmitting(await api.queueText('a', 'mid-flight'), 3);
  const relaunched = load(dev);
  assert.equal(await relaunched.settleAfterLaunch(), 1);
  const item = await relaunched.loadPending('a');
  assert.equal(item.state, 'uncertain');
  assert.equal(item.baseRowId, 3);
  assert.equal(relaunched.canAutoSend(item), false);
});

test('a cancelled pre-submit attempt returns to queued with its chat and baseline', async () => {
  const api = load(device());
  const submitting = await api.markSubmitting(await api.queueText('original', 'hello'), 42);
  const waiting = await api.returnToQueue(submitting);
  assert.equal(waiting.sessionId, 'original');
  assert.equal(waiting.baseRowId, 42);
  assert.equal(api.canAutoSend(waiting), true);
});

test('updating a removed item fails instead of resurrecting it', async () => {
  const api = load(device());
  const q = await api.queueText('a', 'x');
  await api.clearPending(q);
  await assert.rejects(api.markSubmitting(q), /changed/);
  assert.equal((await api.loadOutbox()).length, 0);
});

test('a failed write keeps the previous good copy', async () => {
  const dev = device(), api = load(dev);
  await api.queueText('a', 'safe');
  dev.failWrites = true;
  await assert.rejects(api.queueText('a', 'lost'));
  dev.failWrites = false;
  assert.deepEqual(Array.from(await load(dev).loadOutbox(), i => i.text), ['safe']);
});

test('a torn newest slot falls back to the older good slot', async () => {
  const dev = device(), api = load(dev);
  await api.queueText('a', 'one');
  await api.queueText('a', 'two');
  const newest = [...dev.files.entries()].sort((x, y) => JSON.parse(y[1]).seq - JSON.parse(x[1]).seq)[0][0];
  dev.files.set(newest, '{"v":2,"seq":');
  assert.deepEqual(Array.from(await load(dev).loadOutbox(), i => i.text), ['one']);
});

test('the old single Keychain record is imported once, then removed', async () => {
  const dev = device();
  dev.keychain.set('hermes.m.pendingText.v1', JSON.stringify({ id: 'old', sessionId: 'a', text: 'legacy', state: 'uncertain' }));
  assert.deepEqual(Array.from(await load(dev).loadOutbox(), i => i.text), ['legacy']);
  assert.equal(dev.keychain.has('hermes.m.pendingText.v1'), false);
  assert.equal((await load(dev).loadOutbox()).length, 1);
});
