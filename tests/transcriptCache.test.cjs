const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(files, opts = {}) {
  const exports = {};
  class File {
    constructor(_dir, name) { this.name = name; }
    get exists() { return files.has(this.name); }
    create() { files.set(this.name, ''); }
    async text() { return files.get(this.name); }
    write(s) {
      if (opts.tornWrite?.(this.name)) { files.set(this.name, s.slice(0, 10)); throw Error('crash mid-write'); }
      files.set(this.name, s);
    }
    delete() { files.delete(this.name); }
  }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/transcriptCache.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports,
    require(name) {
      if (name !== 'expo-file-system') throw Error(`unexpected import ${name}`);
      return { File, Paths: { document: {} } };
    },
  });
  return exports;
}
const M = (id, role, text, extra = {}) => ({ id, role, text, ...extra });
const texts = list => Array.from(list, m => m.text);

test('each chat keeps its own transcript across relaunch', async () => {
  const files = new Map();
  await load(files).saveTranscript('chat-a', [M('srv:1', 'user', 'hello a'), M('srv:2', 'assistant', 'reply a')]);
  await load(files).saveTranscript('chat-b', [M('srv:9', 'user', 'hello b')]);
  const again = load(files);
  assert.deepEqual(texts(await again.loadTranscript('chat-a')), ['hello a', 'reply a']);
  assert.deepEqual(texts(await again.loadTranscript('chat-b')), ['hello b']);
  assert.equal(await again.loadTranscript('chat-c'), null);
});

test('long replies are kept in full (no 900-character cut)', async () => {
  const files = new Map();
  await load(files).saveTranscript('a', [M('srv:1', 'assistant', 'x'.repeat(5000))]);
  assert.equal((await load(files).loadTranscript('a'))[0].text.length, 5000);
});

test('streaming bubbles, errors and empty rows are not cached', async () => {
  const files = new Map();
  await load(files).saveTranscript('a', [M('srv:1', 'user', 'q'), M('a-1', 'assistant', 'partial', { streaming: true }), M('e-1', 'error', 'boom'), M('srv:2', 'assistant', '')]);
  const got = await load(files).loadTranscript('a');
  assert.deepEqual(texts(got), ['q']);
  assert.equal(got[0].streaming, undefined);
});

test('keeps the latest 200 messages of a chat', async () => {
  const files = new Map();
  const many = Array.from({ length: 250 }, (_, i) => M(`srv:${i}`, 'user', `m${i}`));
  await load(files).saveTranscript('a', many);
  const got = await load(files).loadTranscript('a');
  assert.equal(got.length, 200);
  assert.equal(got[0].text, 'm50');
});

test('the newest save wins after several saves', async () => {
  const files = new Map(); const api = load(files);
  for (const t of ['one', 'two', 'three']) await api.saveTranscript('a', [M('srv:1', 'user', t)]);
  assert.deepEqual(texts(await load(files).loadTranscript('a')), ['three']);
});

test('a crash mid-write keeps the previous complete copy', async () => {
  const files = new Map();
  await load(files).saveTranscript('a', [M('srv:1', 'user', 'good')]);
  await assert.rejects(load(files, { tornWrite: n => n.startsWith('hermes-chat-a.') }).saveTranscript('a', [M('srv:2', 'user', 'new')]));
  assert.deepEqual(texts(await load(files).loadTranscript('a')), ['good']);
});

test('only the 40 most recent chats are kept', async () => {
  const files = new Map(); const api = load(files);
  for (let i = 0; i < 45; i++) await api.saveTranscript(`chat-${i}`, [M('srv:1', 'user', `m${i}`)]);
  const again = load(files);
  assert.equal(await again.loadTranscript('chat-0'), null);
  assert.ok(await again.loadTranscript('chat-44'));
  const chats = new Set([...files.keys()].filter(k => k.startsWith('hermes-chat-chat-')).map(k => k.split('.')[0]));
  assert.equal(chats.size, 40);
});

test('a hostile chat id cannot escape its file name', async () => {
  const files = new Map();
  await load(files).saveTranscript('../../etc/passwd', [M('srv:1', 'user', 'x')]);
  assert.ok([...files.keys()].every(k => !k.includes('/')));
  assert.ok(await load(files).loadTranscript('../../etc/passwd'));
});

test('two chats whose ids clean to the same file name never show each other', async () => {
  const files = new Map();
  await load(files).saveTranscript('a/b', [M('srv:1', 'user', 'from a/b')]);
  assert.equal(await load(files).loadTranscript('a_b'), null);
});
