const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
function component(storage, load = async id => storage.get(id) || '', save = (id, text) => storage.set(id, text), appState = {}, photo = false) {
  const exports = {};
  const native = { StyleSheet: { create: v => v }, Keyboard: { dismiss() {} }, Platform: { OS: 'ios' }, AppState: { addEventListener: (event, listener) => { appState[event] = listener; return { remove() {} }; } }, ActionSheetIOS: { showActionSheetWithOptions: (_options, callback) => callback(2) } };
  for (const name of ['View','Text','TextInput','TouchableOpacity','Image']) native[name] = name;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/components/Composer.tsx','utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, { exports, setTimeout, clearTimeout, require: name => {
    if (name === 'react') return React;
    if (name === 'react-native') return native;
    if (name === 'expo-image-picker') return photo ? {
      requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
      launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: 'file:///photo.jpg', base64: 'aGVsbG8=', fileName: 'photo.jpg' }] }),
    } : {};
    if (name === '../lib/drafts') return { loadDraft: load, saveDraft: async (id,text) => save(id,text) };
    if (name === '../lib/diagLog') return { diagLog() {} };
    throw Error(name);
  }});
  return exports.Composer;
}
const props = { busy: false, onSend() {} };
test('photo thumbnails inherit the single dock instead of adding a second dark bar', async () => {
  const C = component(new Map(), undefined, undefined, {}, true);
  let tree;
  await act(async () => { tree = create(React.createElement(C, { ...props, sessionId: 'a' })); });
  await act(async () => tree.root.findAllByType('TouchableOpacity')[0].props.onPress());
  const thumbRow = tree.root.findAllByType('View').find(n => n.props.style?.flexWrap === 'wrap');
  assert.ok(thumbRow);
  assert.equal(thumbRow.props.style.backgroundColor, 'transparent');
  await act(async () => tree.unmount());
});

test('backgrounding flushes the latest unsaved draft before iOS suspension', async () => {
  const storage = new Map();
  const listeners = {};
  const C = component(storage, undefined, (id, text) => storage.set(id, text), listeners);
  let tree;
  await act(async () => { tree = create(React.createElement(C, { ...props, sessionId: 'a' })); });
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('just typed'));
  assert.equal(storage.get('a'), undefined);
  await act(async () => listeners.change('background'));
  assert.equal(storage.get('a'), 'just typed');
  await act(async () => tree.unmount());
});

test('composer is one rounded surface with integrated actions', async () => {
  const C = component(new Map());
  let tree;
  await act(async () => { tree = create(React.createElement(C, { ...props, sessionId: 'a' })); });
  const input = tree.root.findByType('TextInput');
  const capsule = tree.root.findAllByType('View').find(n => n.props.style?.borderRadius === 28);
  assert.ok(capsule, 'one shared input capsule');
  assert.equal(input.props.style.backgroundColor, 'transparent');
  const camera = tree.root.findAllByType('TouchableOpacity')[0];
  assert.equal(camera.props.style.backgroundColor, 'transparent');
  await act(async () => tree.unmount());
});

test('rapid typing persists only the final draft after a short pause', async () => {
  const storage = new Map();
  const writes = [];
  const C = component(storage, undefined, (id, text) => { writes.push([id, text]); storage.set(id, text); });
  let tree;
  await act(async () => { tree = create(React.createElement(C, { ...props, sessionId: 'a' })); });
  await act(async () => {
    for (const value of ['h', 'he', 'hel', 'hell', 'hello']) tree.root.findByType('TextInput').props.onChangeText(value);
  });
  assert.equal(tree.root.findByType('TextInput').props.value, 'hello');
  assert.equal(writes.length, 0, 'typing must not start a SecureStore transaction per key');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
  assert.deepEqual(writes, [['a', 'hello']]);
  await act(async () => tree.unmount());
});

test('sending clears a pending draft before leaving the chat', async () => {
  const storage = new Map();
  const C = component(storage);
  let tree, sent = '';
  await act(async () => { tree = create(React.createElement(C, { ...props, sessionId: 'a', connected: true, onSend: text => { sent = text; } })); });
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('hello'));
  const send = tree.root.findAllByType('TouchableOpacity').find(n => n.props.disabled !== undefined);
  await act(async () => send.props.onPress());
  assert.equal(sent, 'hello');
  assert.equal(storage.get('a'), '');
  await act(async () => tree.unmount());
});

test('typing before a session arrives survives session assignment', async () => {
  const storage = new Map();
  const C = component(storage);
  let tree;
  await act(async () => { tree = create(React.createElement(C, props)); });
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('early typing'));
  await act(async () => tree.update(React.createElement(C, {...props,sessionId:'a'})));
  assert.equal(tree.root.findByType('TextInput').props.value,'early typing');
  assert.equal(storage.get('a'),'early typing');
  await act(async () => tree.unmount());
});
test('offline text can queue once while a photo stays in the draft', async () => {
  const storage = new Map(); const C = component(storage);
  let sent = ''; let tree;
  await act(async () => { tree = create(React.createElement(C, { ...props, sessionId:'a', connected:false, allowQueue:true, onSend: async t => { sent = t; return true; } })); });
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('offline text'));
  const button = () => tree.root.findAllByType('TouchableOpacity').find(n => n.props.disabled !== undefined);
  assert.equal(button().props.disabled,false);
  await act(async () => button().props.onPress());
  assert.equal(sent,'offline text');
  assert.equal(tree.root.findByType('TextInput').props.value,'');
  await act(async () => tree.unmount());
});

test('a connected send rejected during reconnect keeps the draft visible', async () => {
  const C = component(new Map()); let tree;
  await act(async () => { tree = create(React.createElement(C, { ...props, sessionId:'a', connected:true, onSend: async () => false })); });
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('keep me during reconnect'));
  await act(async () => tree.root.findAllByType('TouchableOpacity').find(n => n.props.disabled !== undefined).props.onPress());
  assert.equal(tree.root.findByType('TextInput').props.value,'keep me during reconnect');
  await act(async () => tree.unmount());
});

test('a rejected offline queue keeps the draft visible', async () => {
  const C = component(new Map()); let tree;
  await act(async () => { tree = create(React.createElement(C, { ...props, sessionId:'a', connected:false, allowQueue:true, onSend: async () => false })); });
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('keep me'));
  await act(async () => tree.root.findAllByType('TouchableOpacity').find(n => n.props.disabled !== undefined).props.onPress());
  assert.equal(tree.root.findByType('TextInput').props.value,'keep me');
  await act(async () => tree.unmount());
});

test('offline composer keeps typing and refuses send', async () => {
  const storage = new Map();
  const C = component(storage);
  let sends = 0, tree;
  await act(async () => { tree = create(React.createElement(C, {...props,sessionId:'a',connected:false,onSend:() => sends++})); });
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('offline text'));
  const send = tree.root.findAllByType('TouchableOpacity').find(n => n.props.disabled !== undefined);
  assert.equal(send.props.disabled,true);
  await act(async () => send.props.onPress());
  assert.equal(sends,0);
  assert.equal(tree.root.findByType('TextInput').props.value,'offline text');
  await act(async () => tree.unmount());
});
test('composer restores when session arrives after mount', async () => {
  const storage = new Map([['a','saved draft']]);
  const C = component(storage);
  let tree;
  await act(async () => { tree = create(React.createElement(C, props)); });
  await act(async () => { tree.update(React.createElement(C, { ...props, sessionId: 'a' })); });
  assert.equal(tree.root.findByType('TextInput').props.value, 'saved draft');
  await act(async () => tree.unmount());
});
test('slow draft load does not overwrite fresh typing', async () => {
  let resolve;
  const C = component(new Map(), () => new Promise(r => { resolve = r; }));
  let tree;
  await act(async () => { tree = create(React.createElement(C, { ...props, sessionId: 'a' })); });
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('new typing'));
  await act(async () => resolve('old draft'));
  assert.equal(tree.root.findByType('TextInput').props.value, 'new typing');
  await act(async () => tree.unmount());
});
test('switching chats saves latest typing before debounce', async () => {
  const storage = new Map([['b','draft b']]);
  const C = component(storage);
  let tree;
  await act(async () => { tree = create(React.createElement(C, { ...props, sessionId: 'a' })); });
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('draft a'));
  await act(async () => tree.update(React.createElement(C,{...props,sessionId:'b'})));
  assert.equal(tree.root.findByType('TextInput').props.value,'draft b');
  assert.equal(storage.get('a'),'draft a');
  await act(async () => tree.unmount());
});
