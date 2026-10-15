const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;

// Run the real App and dock; replace device/network boundaries, not their
// keyboard subscriptions. Count MainChat renders at its store-hook boundary.
function harness(sessionOverrides = {}, storeOverrides = {}) {
  const noop = () => {};
  const listeners = new Map();
  const appStateListeners = new Set();
  let renders = 0;
  let connectedCallback;
  let activeRef;
  let connState = 'open';
  const outboxItems = [];
  let outboxSeq = 0;
  // Test view: pending.get(chat) is that chat's oldest outbox item.
  const pending = { get: id => outboxItems.find(x => x.sessionId === id), get size() { return outboxItems.length; }, all: () => outboxItems };
  const submitted = [];
  let submitFailure = false;
  let duplicateSend = false;
  let submitGate = null;
  let beforeMark = async () => {};
  // Server history for the heal's fresh fetch: an array of raw REST rows, or
  // null to make the fetch fail.
  let serverHistory = null;
  const historyFetches = [];
  const gateway = { state:'open', request: async (method, body, timeoutMs) => { submitted.push({method,body,timeoutMs}); if (submitFailure && method === 'prompt.submit') throw Error('request timeout'); if(method==='prompt.submit' && submitGate) await submitGate; return {status:'streaming'}; } };
  const sessionCalls = [];
  const native = {
    Platform: { OS: 'ios', select: values => values.ios ?? values.default }, StyleSheet: { create: v => v, absoluteFill: {} },
    useWindowDimensions: () => ({ width: 440, height: 956 }),
    Keyboard: { dismiss: noop, addListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return { remove: () => listeners.get(name).delete(fn) };
    } },
    AppState: { currentState: 'active', addEventListener: (_event, fn) => {
      appStateListeners.add(fn);
      return { remove: () => appStateListeners.delete(fn) };
    } },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Animated: {
      View: 'AnimatedView', Value: class { interpolate() { return 0; } },
      spring: () => ({ start: noop }),
    },
  };
  for (const name of ['View', 'Text', 'TextInput', 'FlatList', 'ImageBackground',
    'KeyboardAvoidingView', 'Modal', 'TouchableOpacity', 'ActivityIndicator', 'RefreshControl']) native[name] = name;
  const store = new Proxy({ messages: [], reversedMessages: [], messagesRef: { current: [] }, busyRef: { current: false }, ...storeOverrides },
    { get: (o, k) => k in o ? o[k] : noop });
  const session = new Proxy({ activeSession: 'test-chat', draftSessionId:'test-chat', activeTitle: 'Test chat', model: '', provider: '', sessionFilter: '', switching: false, pickerOpen: false, filteredSessions: [], modelOptions: [], drawerOpen: false,
    attachSession: () => sessionCalls.push('attach'), refreshTail: () => sessionCalls.push('tail'), restoreSession: () => sessionCalls.push('restore'), showCachedSession: () => { sessionCalls.push('cache'); return 'test-chat'; }, getStoredSessionId: () => 'test-chat',
    loadingSession: false, loadError: null, retryLoad: noop, applyDefaultModel: async () => null, ...sessionOverrides },
    { get: (o, k) => k in o ? o[k] : noop });
  const prefs = { favorites: [], recents: [] };
  const mocks = {
    react: React, 'react-native': native,
    'expo-status-bar': { StatusBar: 'StatusBar' }, 'expo-haptics': {},
    'expo-constants': { nativeBuildVersion: '121' }, 'expo-clipboard': {},
    './ErrorBoundary': { ErrorBoundary: ({ children }) => children },
    './components/Composer': { Composer: 'Composer' },
    './components/MessageRow': { MessageRow: 'MessageRow' },
    './components/AppDetails': { AppDetails: 'AppDetails' },
    './lib/gateway': {},
    './lib/transcriptCache': { saveTranscript: async () => {} },
    // Stand-in for send-once that behaves like a Mac without the plugin, so the
    // journeys below keep counting plain prompt.submit calls. A test can make
    // the Mac answer "duplicate" with h.setDuplicateSend(true).
    './lib/submitOnce': { submitOnce: async (gw, sid, text, id, timeoutMs) => {
      if (duplicateSend) { submitted.push({ method: 'prompt.submit_once', body: { session_id: sid, text, client_msg_id: id }, timeoutMs }); return 'duplicate'; }
      await gw.request('prompt.submit', { session_id: sid, text }, timeoutMs); return 'sent';
    } },
    './lib/pendingSend': {
      // In-memory outbox with the real module's API: oldest first, many items.
      loadOutbox: async () => outboxItems.slice(),
      settleAfterLaunch: async () => { let n = 0; for (const p of outboxItems) if (p.state === 'submitting') { p.state = 'uncertain'; p.uncertainAt = Date.now(); n++; } return n; },
      queueText: async (id, text) => { const p = { id:`local-${++outboxSeq}`, sessionId:id, text, state:'queued' }; outboxItems.push(p); return p; },
      markSubmitting: async (p, base) => { await beforeMark(); const it = outboxItems.find(x => x.id === p.id); if (!it || it.state !== 'queued') throw Error('changed'); it.state='submitting'; if (base !== undefined) it.baseRowId = base; return { ...it }; },
      returnToQueue: async p => { const it = outboxItems.find(x => x.id === p.id); if (!it) throw Error('changed'); it.state='queued'; return { ...it }; },
      markUncertain: async p => { const it = outboxItems.find(x => x.id === p.id); if (!it) throw Error('changed'); it.state='uncertain'; it.uncertainAt = Date.now(); return { ...it }; },
      clearPending: async p => { const i = outboxItems.findIndex(x => x.id === p.id); if (i !== -1) outboxItems.splice(i, 1); },
    },
    './lib/auth': { isAuthed: async () => true, fetchJSON: async url => { historyFetches.push(url); if (!serverHistory) throw Error('history unavailable'); return { messages: serverHistory }; } },
    './lib/modelPrefs': { EMPTY_PREFS: prefs, loadModelPrefs: async () => prefs, setDefaultModel: async (p, ref) => ({ ...p, defaultModel: ref }) },
    './lib/otaUpdates': { startOtaUpdates: () => () => {} },
    './hooks/useChatStore': { useChatStore: () => { renders++; return store; },
      // Same mapping as the real module: server ids become srv:<id>.
      mapServerMessages: rows => rows.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ id: `srv:${m.id}`, role: m.role, text: m.content })) },
    './hooks/useHermesSocket': { useHermesSocket: options => { connectedCallback = options.onConnected; activeRef = options.activeSessionRef; return { conn: connState, gwRef: { current: gateway }, reconnect: noop }; }, pillStatus: (conn, retryScheduled) => conn === 'open' ? 'live' : (conn === 'idle' || conn === 'connecting' || retryScheduled) ? 'connecting' : 'offline' },
    './hooks/useSessionStore': { useSessionStore: () => session },
  };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
    }).outputText, { exports, setTimeout, clearTimeout, console, require(name) {
      if (name in mocks) return mocks[name];
      if (name.endsWith('.jpg')) return 1;
      const base = path.resolve(path.dirname(file), name);
      const target = [base + '.ts', base + '.tsx'].find(f => fs.existsSync(f));
      if (target) return load(target);
      throw Error('Unmocked import: ' + name);
    } });
    return exports;
  }
  return {
    App: load(path.resolve('src/App.tsx')).default,
    renders: () => renders,
    emit: (name, event = {}) => { for (const fn of listeners.get(name) || []) fn({ duration: 1000, easing: 'keyboard', endCoordinates: { screenY: 610, height: 346, screenX: 0, width: 440 }, ...event }); },
    subscriptions: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    reconnectSession: () => connectedCallback({ attachOnly: true }),
    setLiveSession: id => { activeRef.current = id; },
    setConnection: state => { connState = state; gateway.state = state; },
    setSubmitFailure: value => { submitFailure = value; },
    setDuplicateSend: value => { duplicateSend = value; },
    setSubmitGate: value => {submitGate=value;},
    beforeMark: fn => { beforeMark = fn; },
    pending, submitted, historyFetches,
    setServerHistory: rows => { serverHistory = rows; },
    ageUncertain: (id, ms) => { const p = pending.get(id); if (p) p.uncertainAt = Date.now() - ms; },
    queueDirect: (id, text, state = 'queued') => { const p = { id:`local-${++outboxSeq}`, sessionId:id, text, state }; outboxItems.push(p); return p; },
    emitAppState: state => { for (const fn of appStateListeners) fn(state); },
    sessionCalls,
  };
}

test('boot shows saved transcript before waiting for authentication', async () => {
  const h = harness(); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    assert.equal(h.sessionCalls[0], 'cache');
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('reconnecting after a failed cold restore retries the saved chat', async () => {
  const h = harness();
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await act(async () => { await h.reconnectSession(); });
    assert.deepEqual(h.sessionCalls, ['cache', 'restore']);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('foregrounding without a live session retries the saved chat on a healthy socket', async () => {
  const h = harness();
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await act(async () => { h.emitAppState('background'); h.emitAppState('active'); });
    assert.deepEqual(h.sessionCalls, ['cache', 'restore']);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('offline text waits once, then sends only after the saved chat has a live session', async () => {
  const h = harness(); h.setConnection('closed'); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    const composer = () => tree.root.findByType('Composer').props;
    assert.equal(composer().allowQueue,true);
    await act(async () => { assert.equal(await composer().onSend('queued hello',[]),true); });
    assert.equal(h.pending.get('test-chat').state,'queued');
    assert.equal(h.submitted.length,0);
    h.setConnection('open');
    h.setLiveSession('test-chat');
    await act(async () => { await h.reconnectSession(); await h.reconnectSession(); });
    assert.equal(h.submitted.filter(x => x.method === 'prompt.submit').length,1);
    assert.equal(h.pending.size,0);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('a queued message stays visible in the conversation while reconnecting', async () => {
  const h = harness(); h.setConnection('connecting'); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await act(async () => { await tree.root.findByType('Composer').props.onSend('visible while waiting', []); });
    const list = tree.root.findAllByType('FlatList').find(n => n.props.inverted);
    const preview = list.props.ListHeaderComponent;
    assert.ok(preview, 'queued text must have a visible transcript preview');
    const row = preview.props.children.flat().find(child => child?.type === 'MessageRow');
    assert.equal(row.props.item.text, 'visible while waiting');
    assert.equal(h.submitted.length, 0);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('connected text is accepted locally before the network acknowledgement',async()=>{
  const h=harness({model:'test'});let release;h.setSubmitGate(new Promise(r=>{release=r;}));let tree;let sending;let accepted;
  try {
    await act(async()=>{tree=create(React.createElement(h.App));});
    h.setLiveSession('test-chat');
    await act(async()=>{
      sending=tree.root.findByType('Composer').props.onSend('retain once, not in the input and bubble',[]);
      sending.then(v=>{accepted=v;});
      await new Promise(r=>setTimeout(r,40));
    });
    assert.equal(accepted,true,'local acceptance must not wait for a remote reply');
    assert.equal(h.pending.get('test-chat')?.text,'retain once, not in the input and bubble');
    assert.equal(h.submitted.filter(r=>r.method==='prompt.submit').length,1);
  }finally{
    await act(async()=>{release();if(sending)await sending;});
    if(tree)await act(async()=>tree.unmount());
  }
});

test('a stale connected send cannot report acceptance without keeping the text', async () => {
  const h = harness(); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    h.setLiveSession('different-chat');
    await act(async () => {
      assert.equal(await tree.root.findByType('Composer').props.onSend('do not lose me', []), true);
    });
    // Accepted means kept: saved for the chat on screen, never sent to the
    // chat the stale link points at.
    assert.equal(h.pending.get('test-chat').text, 'do not lose me');
    assert.equal(h.submitted.filter(x => x.method === 'prompt.submit').length, 0);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

// Uncertain-send heal journeys. prompt.submit has no idempotency key, so a
// wrong "requeue" is a duplicate server turn and a wrong "clear" deletes the
// only durable copy. The heal may decide only from a fresh server fetch.
async function timeOutOnce(h, tree, text) {
  await act(async () => { await tree.root.findByType('Composer').props.onSend(text, []); });
  h.setConnection('open'); h.setLiveSession('test-chat');
  await act(async () => { await h.reconnectSession(); });
  assert.equal(h.pending.get('test-chat').state, 'uncertain');
  assert.equal(h.submitted.filter(x => x.method === 'prompt.submit').length, 1);
}

test('an old uncertain send retries once when fresh server history lacks it', async () => {
  const h = harness(); h.setConnection('closed'); h.setSubmitFailure(true); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await timeOutOnce(h, tree, 'only once');
    h.setServerHistory([{ id: 3, role: 'assistant', content: 'earlier' }]);
    h.ageUncertain('test-chat', 120000);
    await act(async () => { await h.reconnectSession(); });
    assert.ok(h.historyFetches.some(u => u.includes('/api/sessions/test-chat/messages')));
    assert.equal(h.submitted.filter(x => x.method === 'prompt.submit').length, 2);
    assert.equal(h.submitted.find(x => x.method === 'prompt.submit').timeoutMs, 15000);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('a recent uncertain send is not resent: the server may still accept it', async () => {
  const h = harness(); h.setConnection('closed'); h.setSubmitFailure(true); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await timeOutOnce(h, tree, 'slow accept');
    h.setServerHistory([]);
    await act(async () => { await h.reconnectSession(); });
    assert.equal(h.pending.get('test-chat').state, 'uncertain');
    assert.equal(h.submitted.filter(x => x.method === 'prompt.submit').length, 1);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('a failed history fetch leaves the send uncertain and never resends it', async () => {
  const h = harness(); h.setConnection('closed'); h.setSubmitFailure(true); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await timeOutOnce(h, tree, 'no evidence');
    h.setServerHistory(null);
    h.ageUncertain('test-chat', 120000);
    await act(async () => { await h.reconnectSession(); });
    assert.equal(h.pending.get('test-chat').state, 'uncertain');
    assert.equal(h.pending.get('test-chat').text, 'no evidence');
    assert.equal(h.submitted.filter(x => x.method === 'prompt.submit').length, 1);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('the app\'s own bubble in the local transcript never clears the only copy', async () => {
  const h = harness({}, { messagesRef: { current: [{ id: 'u-1', role: 'user', text: 'keep me' }] } });
  h.setConnection('closed'); h.setSubmitFailure(true); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await timeOutOnce(h, tree, 'keep me');
    h.setServerHistory([]);
    h.ageUncertain('test-chat', 120000);
    h.setSubmitFailure(false);
    await act(async () => { await h.reconnectSession(); });
    // Not cleared on local evidence: it retried and delivered for real.
    assert.equal(h.submitted.filter(x => x.method === 'prompt.submit').length, 2);
    assert.equal(h.pending.get('test-chat'), undefined);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('an uncertain send clears without resubmitting when the server has it after the baseline', async () => {
  const h = harness({}, { messagesRef: { current: [{ id: 'srv:4', role: 'assistant', text: 'before' }] } });
  h.setConnection('closed'); h.setSubmitFailure(true); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await timeOutOnce(h, tree, 'already sent');
    assert.equal(h.pending.get('test-chat').baseRowId, 4);
    h.setServerHistory([{ id: 4, role: 'assistant', content: 'before' }, { id: 5, role: 'user', content: 'already sent' }]);
    await act(async () => { await h.reconnectSession(); });
    assert.equal(h.pending.get('test-chat'), undefined);
    assert.equal(h.submitted.filter(x => x.method === 'prompt.submit').length, 1);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('an identical older message does not fake delivery', async () => {
  const h = harness({}, { messagesRef: { current: [{ id: 'srv:7', role: 'user', text: 'ok' }] } });
  h.setConnection('closed'); h.setSubmitFailure(true); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await timeOutOnce(h, tree, 'ok');
    h.setServerHistory([{ id: 7, role: 'user', content: 'ok' }]);
    h.ageUncertain('test-chat', 120000);
    await act(async () => { await h.reconnectSession(); });
    assert.equal(h.submitted.filter(x => x.method === 'prompt.submit').length, 2);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('queued send cannot follow a live target that changes during the storage write', async () => {
  const h=harness(); h.setConnection('closed'); let tree;
  try {
    await act(async()=>{tree=create(React.createElement(h.App));});
    await act(async()=>{await tree.root.findByType('Composer').props.onSend('belongs to original',[]);});
    h.setConnection('open'); h.setLiveSession('test-chat');
    h.beforeMark(async()=>{h.setLiveSession('different-chat');});
    await act(async()=>{await h.reconnectSession();});
    assert.equal(h.submitted.filter(x=>x.method==='prompt.submit').length,0);
  } finally {if(tree) await act(async()=>tree.unmount());}
});

test('foreground verifies a busy reply instead of ignoring a possibly missed completion', async () => {
  const h = harness({}, {busy:true,busyRef:{current:true}}); let tree;
  try {
    await act(async()=>{tree=create(React.createElement(h.App));});
    h.setLiveSession('test-chat');
    await act(async()=>{h.emitAppState('background');h.emitAppState('active');});
    assert.ok(h.sessionCalls.includes('attach'),'a cached busy flag must not block server reconciliation');
  } finally {if(tree) await act(async()=>tree.unmount());}
});

test('an offline chat shows Thinking, never connection words or a stale tool claim',async()=>{
  const h=harness({}, {busy:true,busyRef:{current:true},busyLabel:'Running mcp__exa__web_search_exa…',toolActivity:'mcp__exa__web_search_exa'});
  h.setConnection('closed');let tree;
  try {
    await act(async()=>{tree=create(React.createElement(h.App));});
    // The pill mounts on busy alone now (it must not vanish on a flap),
    // but while the socket is down its label is honest about the state:
    // "Reconnecting…", never a claim that a tool is still running.
    const labels = tree.root.findAllByType('Text').map(n=>String(n.props.children));
    assert.ok(labels.some(txt=>txt==='Thinking…'),'an offline busy pill reads Thinking…');
    assert.equal(labels.some(txt=>/Reconnecting|Connecting|Offline/.test(txt)),false,'no connection words on screen');
    assert.equal(labels.some(txt=>txt.startsWith('Running ')),false,'an offline chat must not claim a tool is still running');
  }finally{if(tree)await act(async()=>tree.unmount());}
});

test('healthy foreground refreshes server messages without a socket reattach', async () => {
  const h = harness(); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    h.setLiveSession('test-chat');
    await act(async () => { h.emitAppState('background'); h.emitAppState('active'); });
    assert.ok(h.sessionCalls.includes('tail'));
    assert.equal(h.sessionCalls.includes('attach'), false);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('chat header has clear accessible controls and a readable model label', async () => {
  const h = harness();
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    const controls = tree.root.findAllByType('TouchableOpacity');
    for (const label of ['Open chats', 'New chat', 'Choose model']) {
      const button = controls.find(n => n.props.accessibilityLabel === label);
      assert.ok(button, `${label} must be named for VoiceOver`);
      const style = Array.isArray(button.props.style) ? button.props.style.flat() : [button.props.style];
      assert.ok(style.some(s => s?.minHeight >= 44), `${label} needs a 44-point touch target`);
    }
    const title = tree.root.findAllByType('Text').find(n => n.props.children === 'Test chat');
    assert.ok(title);
    assert.ok(tree.root.findAllByType('Text').some(n => n.props.children === 'Choose a model'));
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('empty transcript invites a first message without adding a feature panel', async () => {
  const h = harness();
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    const list = tree.root.findAllByType('FlatList').find(n => n.props.inverted);
    assert.ok(list);
    const empty = list.props.ListEmptyComponent;
    const strings = [];
    const visit = node => {
      if (typeof node === 'string') strings.push(node);
      else if (Array.isArray(node)) node.forEach(visit);
      else if (node && node.props) visit(node.props.children);
    };
    visit(empty);
    const text = strings.join(' ');
    assert.match(text, /Ask Hermes anything/);
    assert.match(text, /Your conversation starts here/);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('chat lift commits the keyboard inset without starting a second timed animation', async () => {
  const h = harness();
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await act(async () => h.emit('keyboardWillShow'));
    // The app must own an immediate inset, not delegate a second animation
    // to KeyboardAvoidingView after the native keyboard is already visible.
    const layout = tree.root.findAllByType('View').find(n => n.props.testID === 'keyboard-chat-layout');
    assert.ok(layout, 'chat lift must use a directly updated layout instead of KeyboardAvoidingView');
    const padding = () => layout.props.style.flat().find(s => s?.paddingBottom !== undefined).paddingBottom;
    assert.equal(padding(), 346, '1000ms event duration must not delay the target inset');
    await act(async () => h.emit('keyboardWillChangeFrame', { endCoordinates: { screenY: 656, height: 300 } }));
    assert.equal(padding(), 300, 'predictive-row and keyboard height changes update the inset');
    await act(async () => h.emit('keyboardWillChangeFrame', { endCoordinates: { screenY: 0, height: 346 } }));
    assert.equal(padding(), 346, 'zero-origin iOS frames cannot lift the chat by the whole screen');
    await act(async () => h.emit('keyboardWillChangeFrame', { endCoordinates: { screenY: 956, height: 346 } }));
    assert.equal(padding(), 0, 'a keyboard below the window does not reserve space');
    await act(async () => h.emit('keyboardWillHide'));
    assert.equal(padding(), 0);
    assert.equal(tree.root.findAllByType('KeyboardAvoidingView').length, 0);
  } finally {
    if (tree) await act(async () => tree.unmount());
  }
  assert.equal(h.subscriptions(), 0);
});

test('keyboard open/close updates dock inset without rendering MainChat again', async () => {
  const h = harness();
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    const before = h.renders();
    const dockPadding = () => tree.root.findAllByType('View')
      .filter(n => n.props.testID !== 'keyboard-chat-layout')
      .map(n => n.props.style).filter(Array.isArray)
      .flat().find(s => s && typeof s.paddingBottom === 'number')?.paddingBottom;
    assert.equal(dockPadding(), 34);
    for (let i = 0; i < 3; i++) {
      await act(async () => h.emit('keyboardWillShow'));
      assert.equal(dockPadding(), 6);
      await act(async () => h.emit('keyboardWillHide'));
      assert.equal(dockPadding(), 34);
    }
    const extra = h.renders() - before;
    console.log('MainChat renders for three keyboard cycles:', extra);
    assert.equal(extra, 0, 'keyboard inset updates must stay local to the dock');
  } finally {
    if (tree) await act(async () => tree.unmount());
  }
  assert.equal(h.subscriptions(), 0, 'unmount removes keyboard listeners');
});

test('a history load failure shows a banner with a working retry', async () => {
  const retries = [];
  const h = harness({ loadError: 'Couldn\u2019t load this chat\u2019s history. Your messages are safe.', retryLoad: () => { retries.push(1); } });
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    const banner = tree.root.findAllByType('Text').find(n => n.props.children === 'Couldn\u2019t load this chat\u2019s history. Your messages are safe.');
    assert.ok(banner, 'the failure must be named, not an infinite spinner or a dead screen');
    const retry = tree.root.findAllByType('TouchableOpacity').find(n => n.props.accessibilityLabel === 'Retry loading chat');
    assert.ok(retry, 'the banner must offer a labeled retry');
    await act(async () => { retry.props.onPress(); });
    assert.equal(retries.length, 1, 'tapping retry must retry the load');
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('a loading session names its work instead of spinning silently', async () => {
  const h = harness({ loadingSession: true });
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    assert.ok(tree.root.findAllByType('Text').some(n => n.props.children === 'Loading history\u2026'),
      'in-flight history work must be named');
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('the composer lives inside the keyboard lift layout', async () => {
  const h = harness();
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    const layout = tree.root.findAllByType('View').find(n => n.props.testID === 'keyboard-chat-layout');
    assert.ok(layout, 'KeyboardChatLayout must wrap the chat');
    const composer = tree.root.findByType('Composer');
    let node = composer;
    let inside = false;
    while (node) {
      if (node === layout) { inside = true; break; }
      node = node.parent;
    }
    assert.ok(inside, 'the composer must sit inside the lift layout so the keyboard never covers it');
  } finally { if (tree) await act(async () => tree.unmount()); }
});

// "Open the app, send, it works": journeys for the outbox.
test('offline: two texts in a row are both accepted, shown, and sent in order on reconnect', async () => {
  const h = harness({ model: 'test' }); h.setConnection('closed'); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    const composer = () => tree.root.findByType('Composer');
    assert.equal(composer().props.allowQueue, true, 'send is enabled with no connection');
    assert.equal(composer().props.busy, false);
    let a, b;
    await act(async () => { a = await composer().props.onSend('first', []); });
    await act(async () => { b = await composer().props.onSend('second', []); });
    assert.equal(a, true); assert.equal(b, true);
    assert.deepEqual(h.pending.all().map(i => i.text), ['first', 'second']);
    const labels = tree.root.findAllByType('Text').map(n => String(n.props.children));
    assert.equal(labels.some(t => /Connecting|Reconnecting|Offline|Waiting to send/.test(t)), false, 'no connection words');
    // Connection returns: the first goes out; the second waits for its reply.
    h.setConnection('open'); h.setLiveSession('test-chat');
    await act(async () => { await h.reconnectSession(); });
    const sends = () => h.submitted.filter(x => x.method === 'prompt.submit').map(x => x.body.text);
    assert.deepEqual(sends(), ['first']);
    assert.deepEqual(h.pending.all().map(i => i.text), ['second']);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('a text typed while a reply is running is kept, not refused', async () => {
  const h = harness({ model: 'test' }, { busy: true, busyRef: { current: true } }); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    h.setLiveSession('test-chat');
    let ok;
    await act(async () => { ok = await tree.root.findByType('Composer').props.onSend('follow-up', []); });
    assert.equal(ok, true);
    assert.equal(h.pending.get('test-chat').text, 'follow-up');
    assert.equal(h.submitted.filter(x => x.method === 'prompt.submit').length, 0, 'waits for the running reply');
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('a kill mid-send is never resent blind on relaunch', async () => {
  const h = harness(); let tree;
  h.queueDirect('test-chat', 'was in flight', 'submitting');
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    assert.equal(h.pending.get('test-chat').state, 'uncertain');
    h.setServerHistory(null);
    await act(async () => { await h.reconnectSession(); });
    assert.equal(h.submitted.filter(x => x.method === 'prompt.submit').length, 0);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('a message stuck with no link shows one plain warning after a while, then clears', async () => {
  const h = harness({ model: 'test' }); h.setConnection('closed'); let tree;
  // The fake FlatList doesn't render its header: walk the header element.
  const texts = () => {
    const out = [];
    const walk = el => { if (el == null || typeof el === 'boolean') return; if (typeof el === 'string') { out.push(el); return; } if (Array.isArray(el)) { el.forEach(walk); return; } if (el.props) { if (el.type === 'Text') out.push([].concat(el.props.children).join('')); else walk(el.props.children); } };
    const list = tree.root.findAllByType('FlatList').find(n => n.props.inverted);
    walk(list.props.ListHeaderComponent);
    tree.root.findAllByType('Text').forEach(n => out.push([].concat(n.props.children).join('')));
    return out;
  };
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await act(async () => { await tree.root.findByType('Composer').props.onSend('stuck one', []); });
    assert.ok(texts().includes('Will send automatically'));
    assert.equal(texts().some(t => t.includes("Can't reach your Mac")), false, 'no warning straight away');
    await act(async () => { await new Promise(r => setTimeout(r, 10100)); });
    assert.ok(texts().some(t => t === "Not sent yet. Can't reach your Mac. Is Tailscale on?"));
    h.setConnection('open'); h.setLiveSession('test-chat');
    await act(async () => { tree.update(React.createElement(h.App)); });
    await act(async () => { await h.reconnectSession(); });
    assert.equal(texts().some(t => t.includes("Can't reach your Mac")), false, 'warning clears once connected');
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('a resend the Mac already accepted clears the outbox and the spinner without a second reply', async () => {
  const busyCalls = [];
  const h = harness({}, { setBusy: v => busyCalls.push(v) }); h.setConnection('closed'); h.setDuplicateSend(true); let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    const composer = () => tree.root.findByType('Composer').props;
    await act(async () => { assert.equal(await composer().onSend('already there', []), true); });
    const item = h.pending.get('test-chat');
    h.setConnection('open');
    h.setLiveSession('test-chat');
    await act(async () => { await h.reconnectSession(); await h.reconnectSession(); });
    const once = h.submitted.filter(x => x.method === 'prompt.submit_once');
    assert.equal(once.length, 1);
    assert.equal(once[0].body.client_msg_id, item.id, 'the outbox id is the dedupe key');
    assert.equal(h.submitted.filter(x => x.method === 'prompt.submit').length, 0, 'no plain resend');
    assert.equal(h.pending.size, 0, 'outbox cleared');
    assert.ok(busyCalls.includes(true), 'the send claimed the spinner');
    assert.equal(busyCalls.at(-1), false, 'spinner released: no completion event will come');
  } finally { if (tree) await act(async () => tree.unmount()); }
});
