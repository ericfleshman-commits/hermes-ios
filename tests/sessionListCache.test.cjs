const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(files) {
  const exports = {};
  class File {
    constructor(_d, name) { this.name = name; }
    get exists() { return files.has(this.name); }
    create() { files.set(this.name, ''); }
    async text() { return files.get(this.name); }
    write(s) { files.set(this.name, s); }
  }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/sessionListCache.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, require: () => ({ File, Paths: { document: {} } }) });
  return exports;
}
test('the chat list survives relaunch without message text', async () => {
  const files = new Map();
  load(files).saveSessionList([{ id: 'a', title: 'Trip', preview: 'secret text' }, { id: 'b', display_name: 'B' }]);
  const rows = await load(files).loadSessionList();
  assert.deepEqual(Array.from(rows, r => r.id), ['a', 'b']);
  assert.equal(rows[0].title, 'Trip');
  assert.equal('preview' in rows[0], false);
});
test('a missing or corrupt cache gives an empty list, never a crash', async () => {
  assert.equal((await load(new Map()).loadSessionList()).length, 0);
  assert.equal((await load(new Map([['hermes-session-list.json', '{bad']])).loadSessionList()).length, 0);
});
