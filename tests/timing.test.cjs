const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load() {
  const events = []; let t = 1000;
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/timing.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports, Date, Number, Math, Map, Set,
    require(n) { if (n !== './diagLog') throw Error(`unexpected import ${n}`); return { diagLog: (kind, detail) => events.push({ kind, ...detail }) }; },
  });
  exports.__setClockForTests(() => t);
  return { lib: exports, events, advance: ms => { t += ms; }, at: () => t };
}

test('a reply is timed from acceptance to first words and to the end', () => {
  const h = load();
  const started = h.at(); h.advance(300);
  h.lib.sendAccepted('live-1', started);
  h.advance(1200); h.lib.replyToken('live-1');
  h.advance(50); h.lib.replyToken('live-1');           // later tokens ignored
  h.advance(2000); h.lib.replyDone('live-1', 'complete');
  assert.deepEqual(h.events.map(e => [e.name, e.ms]), [['send_ack', 300], ['first_token', 1200], ['reply_done', 3250]]);
  assert.ok(h.events.every(e => e.kind === 'timing'));
});

test('tokens or completions for a chat with no timed send log nothing', () => {
  const h = load();
  h.lib.replyToken('other'); h.lib.replyDone('other'); h.lib.replyToken(undefined);
  assert.equal(h.events.length, 0);
});

test('launch steps are logged once per app run', () => {
  const h = load();
  h.advance(400); h.lib.sinceLaunchOnce('launch_cached', { hit: true });
  h.advance(400); h.lib.sinceLaunchOnce('launch_cached', { hit: true });
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].hit, true);
});

test('timed() records the step even when it fails', async () => {
  const h = load();
  await assert.rejects(h.lib.timed('switch', async () => { h.advance(900); throw Error('no'); }));
  assert.deepEqual(h.events.map(e => [e.name, e.ms]), [['switch', 900]]);
});

test('nonsense durations (clock jumps) are dropped', () => {
  const h = load();
  h.lib.sendAccepted('s', h.at() + 5000);
  h.lib.sendAccepted('s', h.at() - 3 * 60 * 60 * 1000);
  assert.equal(h.events.length, 0);
});
