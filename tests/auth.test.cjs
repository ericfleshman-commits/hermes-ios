const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');

function loadAuth(fetch,timers){
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/auth.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,{
    exports,fetch,Headers,AbortController,
    setTimeout:fn=>{const id={};timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    require:name=>{if(name==='expo-constants')return {expoConfig:{extra:{gatewayHost:'local.invalid'}}};throw Error('Unexpected import '+name);},
  });
  return exports;
}

test('history deadline remains active while the response body is still arriving',async()=>{
  const timers=new Map();let rejectBody;
  const auth=loadAuth(async(_url,init)=>({ok:true,status:200,json:()=>new Promise((_resolve,reject)=>{
    rejectBody=reject;
    init.signal.addEventListener('abort',()=>reject(Error('aborted response body')));
  })}),timers);
  const request=auth.fetchJSON('/api/sessions/health/messages').catch(e=>e);
  await new Promise(r=>setImmediate(r));
  try {
    assert.equal(timers.size,1,'a received header must not cancel the history body deadline');
    for(const timeout of timers.values())timeout();
    assert.match((await request).message,/aborted response body/);
    assert.equal(timers.size,0);
  }finally{rejectBody(Error('test cleanup'));await request;}
});
