const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadSessionStore(storage, extra = {}) {
  const effects = [];
  const react = {
    useState: value => [value, () => {}],
    useRef: value => ({ current: value }),
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useEffect: fn => effects.push(fn),
  };
  const exports = {};
  const imports = {
    react,
    'react-native': { Alert: { alert: () => {} } },
    'expo-secure-store': {
      getItemAsync: async key => storage.get(key) || null,
      setItemAsync: async (key, value) => storage.set(key, value),
      deleteItemAsync: async key => storage.delete(key),
    },
    '../lib/auth': { fetchJSON: async () => ({ messages: [] }) },
    '../lib/sessionListCache': { loadSessionList: async () => [], saveSessionList: () => {} },
    '../lib/transcriptCache': { loadTranscript: async id => extra.cached?.get(id) ?? null, saveTranscript: async (id, msgs) => extra.cached?.set(id, msgs) },
    '../lib/sessionList': (() => {
      const mod = {};
      vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/sessionList.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText, { exports: mod });
      return mod;
    })(),
    // Real module, not a stub: the fence translation is what the store calls.
    '../lib/sessionFence': (() => {
      const mod = {};
      vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/sessionFence.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText, { exports: mod });
      return mod;
    })(),
    './useChatStore': { uid: () => 'test-id' },
    ...extra,
  };
  // Real module, not a stub: resolveDefaultModel is what the store calls.
  // modelPrefs keeps its own expo-secure-store import, so it gets the same
  // shimmed store as the session store under test.
  imports['../lib/modelPrefs'] = (() => {
    const mod = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/modelPrefs.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText, { exports: mod, require: name => imports[name] });
    return mod;
  })();
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/hooks/useSessionStore.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: name => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  }});
  return options => {
    const store = exports.useSessionStore(options);
    effects.splice(0).forEach(fn => fn());
    return store;
  };
}

for (const action of ['resumeSession', 'restoreSession', 'attachSession']) {
  test(`${action} uses a bounded resume instead of downloading the entire chat twice`, async () => {
    const calls=[];
    const storage=new Map([['hermes.m.selection.v1',JSON.stringify({sessionId:'health',title:'Health chat'})]]);
    const activeSessionRef={current:''};
    const gwRef={current:{request:async (method,params,timeout)=>{
      calls.push({method,params,timeout});
      return {session_id:'health-live',stored_session_id:'health',running:false,info:{model:'test',provider:'test'}};
    }}};
    const store=loadSessionStore(storage)({gwRef,activeSessionRef});
    if(action==='attachSession'){await store.restoreSession();calls.length=0;}
    await store[action]({id:'health',title:'Health chat'});
    assert.equal(calls[0].params.omit_messages,true,'REST owns history; do not send a duplicate full WebSocket transcript');
    assert.equal(calls[0].params.defer_history,true);
    assert.equal(calls[0].params.inline_images,false);
    assert.ok(calls[0].timeout<=15000,'resume must not silently wait for the 120-second RPC default');
  });
}

for (const snapshotRunning of [true,false]) {
  test(`history completion cannot overwrite a newer reply state (snapshot running=${snapshotRunning})`,async()=>{
    let finishHistory;
    let busy=false;
    const store=loadSessionStore(new Map(),{'../lib/auth':{fetchJSON:()=>new Promise(r=>{finishHistory=r;})}})({
      gwRef:{current:{request:async()=>({session_id:'health-live',running:snapshotRunning,info:{model:'test',provider:'test'}})}},
      onSetBusy:value=>{busy=value;},
    });
    const opening=store.resumeSession({id:'health',title:'Health chat'});
    await new Promise(r=>setImmediate(r));
    // A newer message.complete or message.start arrives during the history fetch.
    busy=!snapshotRunning;
    finishHistory({messages:[]});
    await opening;
    assert.equal(busy,!snapshotRunning,'the older resume snapshot must not undo a newer live event');
  });
}

test('loading a chat does not pretend an agent reply is running', async () => {
  let resolveResume;
  const busy=[];
  const store=loadSessionStore(new Map())({
    gwRef:{current:{request:()=>new Promise(r=>{resolveResume=r;})}},
    onSetBusy:v=>busy.push(v),
  });
  const opening=store.resumeSession({id:'health',title:'Health chat'});
  await new Promise(r=>setImmediate(r));
  try { assert.equal(busy.includes(true),false,'loading history must not show Thinking or disable typing'); }
  finally {
    resolveResume({session_id:'health-live',running:false,info:{model:'test',provider:'test'}});
    await opening;
  }
});

test('selecting a saved chat paints its own cache before the network resume finishes', async () => {
  let resolveResume;
  const loaded=[];
  const cached=new Map([['health',[{id:'cached',role:'user',text:'saved health message'}]]]);
  const store=loadSessionStore(new Map(),{cached})({gwRef:{current:{request:()=>new Promise(r=>{resolveResume=r;})}},onLoadMessages:m=>loaded.push(m)});
  const opening=store.resumeSession({id:'health',title:'Health chat'});
  await new Promise(r=>setImmediate(r));
  try { assert.equal(loaded.at(-1)?.[0]?.text,'saved health message','selected chat must not sit blank behind its resume request'); }
  finally {
    resolveResume({session_id:'health-live',running:false,info:{model:'test',provider:'test'}});
    await opening;
  }
});

test('expired durable session is not retried on the next cold launch', async () => {
  const storage = new Map([
    ['hermes.m.storedSession', 'expired'],
    ['hermes.m.activeSession', 'old-live'],
    ['hermes.m.activeTitle', 'Old chat'],
  ]);
  const resumed = [];
  let creates = 0;
  const gwRef = { current: { request: async (method, params) => {
    if (method === 'session.resume') {
      resumed.push(params.session_id);
      if (params.session_id === 'expired') throw new Error('session expired');
      return { session_id: 'new-live', stored_session_id: 'new-stored', info: { model: 'test', provider: 'test' } };
    }
    if (method === 'session.create') {
      creates++;
      return { session_id: 'new-live', stored_session_id: 'new-stored' };
    }
    throw new Error(`Unexpected method: ${method}`);
  }}};
  await loadSessionStore(storage)({ gwRef }).restoreSession();
  await loadSessionStore(storage)({ gwRef }).restoreSession();
  assert.equal(creates, 1, 'second launch must restore the replacement, not create another blank chat');
  assert.deepEqual(resumed, ['expired', 'new-stored']);
  assert.equal(storage.get('hermes.m.activeSession'), 'new-live');
  assert.equal(storage.has('hermes.m.activeTitle'), false);
});

for (const accept of [false, true]) {
  test(`expensive model waits for explicit ${accept ? 'approval' : 'cancellation'}`, async () => {
    const calls = [];
    let dialog;
    const store = loadSessionStore(new Map(), {
      'react-native': { Alert: { alert: (...args) => { dialog = args; } } },
    })({ gwRef: { current: { request: async (method, params) => {
      calls.push(params);
      return calls.length === 1
        ? { confirm_required: true, confirm_message: 'This model costs more.' }
        : { value: 'test/model' };
    }}} });
    const switching = store.switchModel('test', 'model');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1, 'must not accept cost without asking');
    assert.ok(dialog, 'show a native confirmation dialog');
    assert.equal(dialog[1], 'This model costs more.');
    dialog[2].find(button => accept ? button.style !== 'cancel' : button.style === 'cancel').onPress();
    await switching;
    assert.equal(calls.length, accept ? 2 : 1);
    if (accept) assert.equal(calls[1].confirm_expensive_model, true);
  });
}

test('drawer requests unarchived chats without one-shot runs', async () => {
  const paths = [];
  const store = loadSessionStore(new Map(), {
    '../lib/auth': { fetchJSON: async path => { paths.push(path); return { sessions: [] }; } },
  })({ gwRef: { current: null } });
  await store.loadSessions();
  assert.equal(paths.length, 1);
  assert.match(paths[0], /(?:\?|&)archived=exclude(?:&|$)/);
  assert.match(paths[0], /(?:\?|&)exclude_sources=oneshot(?:&|$)/);
});

test('drawer drops one-shot and archived rows while keeping normal chats', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const ts = require('typescript');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/sessionList.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports });
  const rows = [
    { id: 'test', title: 'reply with exactly ok:', source: 'oneshot', archived: false },
    { id: 'archive', title: 'Old chat', source: 'desktop', archived: true },
    { id: 'chat', title: 'Working chat', source: 'desktop', archived: false },
    { id: 'other', title: 'CLI chat', source: 'cli' },
  ];
  assert.deepEqual(Array.from(exports.visibleChatSessions(rows), row => row.id), ['chat', 'other']);
});

test('temporary resume timeout keeps the saved chat and retries it on the next restore', async () => {
  const storage = new Map([
    ['hermes.m.storedSession', 'saved-chat'],
    ['hermes.m.activeSession', 'old-live'],
    ['hermes.m.activeTitle', 'My conversation'],
  ]);
  const requests = [];
  const notices = [];
  let timeout = true;
  const gwRef = { current: { request: async (method, params) => {
    requests.push([method, params?.session_id]);
    if (method === 'session.create') throw Error('must not create a replacement chat');
    if (timeout) throw Error('request timeout');
    return { session_id: 'new-live', stored_session_id: 'saved-chat', info: { model: 'test', provider: 'test' } };
  }}};
  // A failed restore is an error state with a retry (loadError), not an
  // error row: the harness's useState setters are no-ops, so record every
  // setter call and find the surfaced failure message.
  const sets = [];
  const react = {
    useState: v => { const i = sets.length; return [v, next => sets.push([i, next])]; },
    useRef: v => ({ current: v }), useCallback: f => f, useMemo: f => f(), useEffect: () => {},
  };
  const first = loadSessionStore(storage, { react })({ gwRef, onErrorMessage: msg => notices.push(msg) });
  await first.restoreSession();
  assert.equal(storage.get('hermes.m.storedSession'), 'saved-chat');
  assert.equal(storage.get('hermes.m.activeSession'), 'old-live');
  assert.equal(storage.get('hermes.m.activeTitle'), 'My conversation');
  assert.deepEqual(requests.map(([method]) => method), ['session.resume']);
  assert.ok(sets.some(([, v]) => typeof v === 'string' && /couldn't restore/i.test(v)),
    'the failure must surface as a named error state with a retry');
  assert.equal(notices.length, 0, 'no error row: the banner owns this failure');
  assert.equal(typeof first.retryLoad, 'function', 'the banner retry must be wired');
  timeout = false;
  await loadSessionStore(storage)({ gwRef }).restoreSession();
  assert.deepEqual(requests.map(([method, sid]) => [method, sid]), [
    ['session.resume', 'saved-chat'], ['session.resume', 'saved-chat'],
  ]);
  assert.equal(storage.get('hermes.m.storedSession'), 'saved-chat');
});

test('cold launch shows only the saved chat cache before a socket exists', async () => {
  const storage = new Map([['hermes.m.storedSession', 'chat-a'], ['hermes.m.activeTitle', 'My chat']]);
  const cached = new Map([['chat-a', [{ id:'1', role:'user', text:'hello' }]]]);
  const loaded = [];
  const store = loadSessionStore(storage, { cached })({ gwRef: { current: null }, onLoadMessages: msgs => loaded.push(msgs) });
  await store.showCachedSession();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0][0].text, 'hello');
  assert.equal(storage.get('hermes.m.storedSession'), 'chat-a');
});

test('a failed chat switch cannot leave the previous chat as the send target', async () => {
  const storage = new Map([['hermes.m.storedSession','japan-shoes'], ['hermes.m.activeTitle','Japan shoes']]);
  const activeSessionRef = { current:'' };
  const gwRef = { current:{ request:async (_method, params) => {
    if (params.session_id === 'japan-shoes') return {session_id:'shoes-live',stored_session_id:'japan-shoes',info:{model:'test',provider:'test'}};
    throw Error('request timeout');
  } } };
  const store = loadSessionStore(storage)({gwRef,activeSessionRef});
  await store.restoreSession();
  assert.equal(activeSessionRef.current,'shoes-live');
  await store.resumeSession({id:'ios-work',title:'Improve Hermes iOS'});
  assert.equal(activeSessionRef.current,'', 'failed switch must disable the old send target');
  assert.equal(store.getStoredSessionId(),'ios-work', 'selected durable chat must match the visible title');
  const resumed=[];
  await loadSessionStore(storage)({gwRef:{current:{request:async (_method, params) => {
    resumed.push(params.session_id); throw Error('request timeout');
  }}}}).restoreSession();
  assert.deepEqual(resumed,['ios-work'], 'cold launch must not pair the new title with the old chat');
});

test('selecting a different chat clears the previous transcript before any storage wait', async () => {
  let block = false, release;
  const gate = new Promise(r => { release = r; });
  const storage = new Map([['hermes.m.storedSession','old']]);
  const loaded = [];
  const store = loadSessionStore(storage, {'expo-secure-store': {
    getItemAsync:async k => storage.get(k) || null,
    setItemAsync:async (k,v) => { if (block) await gate; storage.set(k,v); },
    deleteItemAsync:async k => storage.delete(k),
  }})({gwRef:{current:{request:async () => ({session_id:'old-live',stored_session_id:'old',info:{model:'test',provider:'test'}})}}, onLoadMessages:m => loaded.push(m)});
  await store.restoreSession();
  loaded.length=0;
  block=true;
  const switching=store.resumeSession({id:'new',title:'New chat'});
  assert.equal(loaded.length,1);
  assert.equal(loaded[0].length,0);
  release(); await switching;
});

test('cold restore does not trust a legacy title saved separately from its chat ID', async () => {
  const storage = new Map([['hermes.m.storedSession','japan-shoes'],['hermes.m.activeTitle','Improve Hermes iOS']]);
  const titles=[]; let stateIndex=0;
  const react={useState:v => {const i=stateIndex++; return [v, next => {if(i===2) titles.push(next);}];}, useRef:v=>({current:v}),useCallback:f=>f,useMemo:f=>f(),useEffect:()=>{}};
  const cached = new Map([['japan-shoes',[{id:'1',role:'user',text:'shoes'}]]]);
  await loadSessionStore(storage,{react,cached})({gwRef:{current:null}}).showCachedSession();
  assert.equal(titles.includes('Improve Hermes iOS'),false);
});

test('cold launch reads chat identity and title from one saved selection', async () => {
  const storage = new Map([['hermes.m.selection.v1',JSON.stringify({sessionId:'ios-work',title:'Improve Hermes iOS'})],['hermes.m.storedSession','japan-shoes']]);
  const resumed=[];
  await loadSessionStore(storage)({gwRef:{current:{request:async (_m,p)=>{resumed.push(p.session_id);throw Error('request timeout');}}}}).restoreSession();
  assert.deepEqual(resumed,['ios-work']);
});

test('rendered store keeps title, draft and live target aligned after a failed switch', async () => {
  const React = require('react');
  const {create,act} = require('react-test-renderer');
  global.IS_REACT_ACT_ENVIRONMENT=true;
  const storage=new Map([['hermes.m.selection.v1',JSON.stringify({sessionId:'shoes',title:'Japan shoes'})]]);
  const activeSessionRef={current:''};
  const gwRef={current:{request:async (_m,p)=>{
    if(p.session_id==='shoes') return {session_id:'shoes-live',stored_session_id:'shoes',info:{model:'test',provider:'test'}};
    throw Error('request timeout');
  }}};
  const useStore=loadSessionStore(storage,{react:React});
  let store,tree;
  function Probe(){ store=useStore({gwRef,activeSessionRef}); return null; }
  try {
    await act(async()=>{tree=create(React.createElement(Probe));});
    await act(async()=>{await store.restoreSession();});
    assert.equal(store.activeSession,'shoes-live');
    await act(async()=>{await store.resumeSession({id:'ios',title:'Improve Hermes iOS'});});
    assert.equal(store.activeTitle,'Improve Hermes iOS');
    assert.equal(store.activeSession,'');
    assert.equal(activeSessionRef.current,'');
    assert.equal(store.draftSessionId,'ios');
    assert.equal(store.getStoredSessionId(),'ios');
    assert.equal(JSON.parse(storage.get('hermes.m.selection.v1')).sessionId,'ios');
  } finally {if(tree) await act(async()=>tree.unmount());}
});

module.exports = { loadSessionStore };
