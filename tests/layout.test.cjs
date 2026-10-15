const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function lib() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/layout.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {exports});
  return exports;
}
test('home-indicator inset only applies to notched iPhones', () => {
  const { bottomInsetFor } = lib();
  assert.equal(bottomInsetFor('ios', 440, 956), 34);   // 17 Pro Max
  assert.equal(bottomInsetFor('ios', 375, 812), 34);   // iPhone X class
  assert.equal(bottomInsetFor('ios', 375, 667), 0);    // SE, no home indicator
  assert.equal(bottomInsetFor('android', 440, 956), 0);
  assert.equal(bottomInsetFor('ios', 0, 0), 0);        // before layout
});
test('composer dock carries the home-indicator area but has no keyboard gap', () => {
  const { composerDockBottomPadding } = lib();
  assert.equal(composerDockBottomPadding(34, false), 34);
  assert.equal(composerDockBottomPadding(34, true), 6);
  assert.equal(composerDockBottomPadding(0, false), 8);
});

test('keyboard events match the platform API', () => {
  const { keyboardEvents } = lib();
  // Field-by-field: the sandbox creates these objects in another realm, so
  // deepStrictEqual would fail on prototype identity alone.
  const ios = keyboardEvents('ios');
  assert.equal(ios.show, 'keyboardWillShow');
  assert.equal(ios.hide, 'keyboardWillHide');
  const android = keyboardEvents('android');
  assert.equal(android.show, 'keyboardDidShow');
  assert.equal(android.hide, 'keyboardDidHide');
});
