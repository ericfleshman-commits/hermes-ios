const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function lib() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/drawerMotion.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports });
  return exports;
}
test('a horizontal edge drag claims the gesture, not a vertical scroll or a center swipe', () => {
  const { shouldOpenDrawerGesture } = lib();
  assert.equal(shouldOpenDrawerGesture(18, 22, 3), true);
  assert.equal(shouldOpenDrawerGesture(18, 6, 30), false);
  assert.equal(shouldOpenDrawerGesture(80, 22, 3), false);
  assert.equal(shouldOpenDrawerGesture(18, -22, 3), false);
});
test('drag follows finger within panel bounds and release uses distance or speed', () => {
  const { drawerOffset, settleDrawerOpen } = lib();
  assert.equal(drawerOffset(false, 280, 100), -180);
  assert.equal(drawerOffset(false, 280, -50), -280);
  assert.equal(drawerOffset(true, 280, -70), -70);
  assert.equal(drawerOffset(true, 280, 100), 0);
  assert.equal(settleDrawerOpen(false, 280, 90, 0), false);
  assert.equal(settleDrawerOpen(false, 280, 160, 0), true);
  assert.equal(settleDrawerOpen(false, 280, 20, 0.7), true);
  assert.equal(settleDrawerOpen(true, 280, -80, 0), true);
  assert.equal(settleDrawerOpen(true, 280, -170, 0), false);
  assert.equal(settleDrawerOpen(true, 280, -20, -0.7), false);
});