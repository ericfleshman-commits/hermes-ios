const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
function load(path, imports = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText, {exports,require:n => imports[n]});
  return exports;
}
test('usage screen fetches current session and does not request Nous balance for OpenRouter', async () => {
  const calls = [], native = {StyleSheet:{create:x=>x}};
  for (const key of ['Modal','View','Text','TouchableOpacity','ScrollView']) native[key] = key;
  const { AppDetails } = load('src/components/AppDetails.tsx', {
    react:React,'react-native':native,'expo-clipboard':{setStringAsync:async()=>{}},
    '../lib/appStatus':load('src/lib/appStatus.ts'),
    '../lib/otaUpdates':{getOtaStatus:()=>({updateId:null,channel:'production',runtimeVersion:'1.0.0',isEnabled:true,lastCheckedAt:null,lastResult:'not-yet-checked'})},
  });
  let tree;
  await act(async () => { tree = create(React.createElement(AppDetails, {
    visible:true,onClose(){},gateway:{request:async(method,params)=>{calls.push([method,params]);return {total:12,cost_usd:0.2};}},
    sessionId:'s',provider:'openrouter',build:'p102',connection:'open',delivery:'Sent',
  })); });
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'session.usage');
  assert.equal(calls[0][1].session_id,'s');
  const text = tree.root.findAllByType('Text').map(n=>n.props.children).join(' ');
  assert.match(text,/0.2000/);
  assert.match(text,/Balance unavailable/);
  await act(async()=>tree.unmount());
});
