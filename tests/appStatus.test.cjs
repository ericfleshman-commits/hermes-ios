const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function lib() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/appStatus.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {exports});
  return exports;
}
test('unknown usage and provider balance never display as zero', () => {
  const { usageLines } = lib();
  assert.match(usageLines({},null,'openrouter').join(' '), /Cost unavailable/);
  assert.match(usageLines({}, {balance_usd:'25'},'openrouter').join(' '), /Balance unavailable/);
  assert.match(usageLines({cost_usd:0},null,'test').join(' '), /0.0000/);
  assert.match(usageLines({}, {logged_in:true,balance_usd:'25'},'nous').join(' '), /25.00/);
});
test('diagnostic export contains only allowed fields', () => {
  const { diagnosticReport } = lib();
  const report = diagnosticReport({build:'p102',connection:'closed',provider:'test',secret:'SECRET',ticket:'SECRET',error:'SECRET'});
  assert.ok(!report.includes('SECRET'));
  assert.match(report,/p102/);
});
test('status label names the installed Apple build as well as the source tag', () => {
  const { buildLabel } = lib();
  assert.equal(buildLabel('native 2026-09-25.p105', '120'), 'native 2026-09-25.p105 · TestFlight 120');
  assert.equal(buildLabel('native 2026-09-25.p105', null), 'native 2026-09-25.p105');
});

test('connection labels make offline typing explicit', () => {
  const { connectionLabel } = lib();
  assert.match(connectionLabel('closed'), /type/i);
  assert.match(connectionLabel('open'), /Connected/);
});
test('connection label is honest about first boot vs a dropped socket', () => {
  const { connectionLabel } = lib();
  assert.match(connectionLabel('idle'), /Connecting/);
  assert.match(connectionLabel('connecting'), /Connecting/);
  assert.match(connectionLabel('error'), /Reconnecting/);
  assert.doesNotMatch(connectionLabel('idle'), /Reconnecting/);
});
