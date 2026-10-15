import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  type AppStateStatus,
  FlatList,
  ImageBackground,
  Keyboard,

  Linking,
  Modal,
  PanResponder,
  Platform,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as Haptics from "expo-haptics";
import Constants from "expo-constants";
import * as Clipboard from "expo-clipboard";
import { GatewayClient } from "./lib/gateway";
import { AppDetails } from "./components/AppDetails";
import { buildLabel, connectionLabel } from "./lib/appStatus";
import { bottomInsetFor } from "./lib/layout";
import { ComposerDock } from "./components/ComposerDock";
import { KeyboardChatLayout } from "./components/KeyboardChatLayout";
import { settleDrawerOpen, shouldOpenDrawerGesture } from "./lib/drawerMotion";
import { createReplyHapticGate, tapOnSend } from "./lib/responseHaptic";
import { clearBadge, ensurePushRegistration, installPushHandlers, setPushReporter } from "./lib/pushNotifications";
import { startOtaUpdates } from "./lib/otaUpdates";
import { getDeviceId, maybeUploadDiag } from "./lib/diagUpload";
import { diagLog } from "./lib/diagLog";
import { submitTurn, type PendingTurn } from "./lib/submitTurn";
import { saveTranscript } from "./lib/transcriptCache";
import { submitOnce } from "./lib/submitOnce";
import { replyDone, replyToken, sendAccepted, sinceLaunchOnce, timed } from "./lib/timing";
import { loadOutbox, queueText, markSubmitting, returnToQueue, markUncertain, clearPending, settleAfterLaunch, type PendingText } from "./lib/pendingSend";
import { decidePendingHeal, latestServerRowId, HEAL_REQUEUE_MIN_AGE_MS, evaluateFlushGate, evaluateQueueGate, queueGateDeliveryText } from "./lib/sendGates";
import { BASE, authFetch, isAuthed, login, silentLogin, fetchJSON, type TicketBundle } from "./lib/auth";
import { ErrorBoundary } from "./ErrorBoundary";
import { useChatStore, capMessages, mergeServerRows, mapServerMessages, uid, type Msg } from "./hooks/useChatStore";
import { useHermesSocket, pillStatus } from "./hooks/useHermesSocket";
import { useSessionStore, type SessionRow, type SessionStore } from "./hooks/useSessionStore";
import { MessageRow } from "./components/MessageRow";
import { Composer, type PendingImage } from "./components/Composer";
import {
  EMPTY_PREFS,
  loadModelPrefs,
  refKey,
  rememberRecent,
  setDefaultModel,
  toggleFavorite,
  type ModelPrefs,
} from "./lib/modelPrefs";

// Hermes mobile — native iOS client. Phase 2: live streaming via the same
// JSON-RPC WebSocket protocol the dashboard speaks.

const BUILD_TAG = "native 2026-10-11.p123";
export const STUCK_AFTER_MS = 10000;
export const STUCK_TEXT = "Not sent yet. Can't reach your Mac. Is Tailscale on?";
const BUILD_LABEL = buildLabel(BUILD_TAG, Constants.nativeBuildVersion);

export default function App() {
  return (
    <ErrorBoundary>
      <MainChat />
    </ErrorBoundary>
  );
}

function MainChat() {
  const activeSessionRef = useRef("");
  const replyHaptic = useRef(createReplyHapticGate()).current;
  const chatStore = useChatStore({ activeSessionRef });
  const {
    messages,
    reversedMessages,
    busy,
    toolActivity,
    busyLabel,
    messagesRef,
    busyRef,
    appendDelta,
    appendThinkingDelta,
    appendReasoningDelta,
    setReasoningAvailable,
    startStream,
    finishStream,
    startTool,
    completeTool,
    handleError,
    setBusy,
    setToolActivity,
    setBusyLabel,
    setMessages,
    loadMessages,
    syncFromServer,
    addUserMessage,
    addErrorMessage,
    clearRetryErrors,
    setRetryError,
    interrupt: storeInterrupt,
    reset: storeReset,
    patchAssistant,
    patchMessage,
  } = chatStore;

  const [needsLogin, setNeedsLogin] = useState(false);
  const [username, setUsername] = useState("eric");
  const [password, setPassword] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [delivery, setDelivery] = useState("");
  // Durable outbox (every unsent text, every chat, oldest first). The ref is
  // the source of truth for async code; the state drives rendering.
  const [outbox, setOutbox] = useState<PendingText[]>([]);
  const outboxRef = useRef<PendingText[]>([]);
  const refreshOutbox = useCallback(async () => {
    const items = await loadOutbox().catch(() => outboxRef.current);
    outboxRef.current = items;
    if (mounted.current) setOutbox(items);
    return items;
  }, []);
  // Oldest outbox item for a chat: the only one allowed to send next, so
  // messages always arrive in the order they were typed.
  const headFor = (sid: string | null | undefined) =>
    sid ? outboxRef.current.find(i => i.sessionId === sid) ?? null : null;
  const flushingRef = useRef(false);
  const flushPendingRef = useRef<() => Promise<void>>(async () => {});
  const healUncertainPendingRef = useRef<() => Promise<void>>(async () => {});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copiedId, setCopiedId] = useState("");
  // Model picker memory (favorites + recents) and the long-press action sheet.
  const [prefs, setPrefs] = useState<ModelPrefs>(EMPTY_PREFS);
  const prefsRef = useRef<ModelPrefs>(EMPTY_PREFS);
  const [actionMsg, setActionMsg] = useState<Msg | null>(null);
  const lastFailed = useRef<PendingTurn | null>(null);
  // Failed turns keyed by their message id so tap-to-retry replays the exact
  // turn that failed — the text is never dropped, never duplicated.
  const failedTurnsRef = useRef(new Map<string, PendingTurn>());
  const busyOwnerRef = useRef<string | null>(null);
  // Mirror of the selected model for async send paths: a send must never go
  // out with no model behind it.
  const modelRef = useRef("");
  const flatListRef = useRef<FlatList<Msg>>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const mounted = useRef(true);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


  // Home-indicator inset without a safe-area dependency: notched iPhones all
  // run an aspect ratio above 2:1, SE-class phones sit below it. The inset is
  // dropped while the keyboard is up, because KeyboardChatLayout has already
  // lifted the composer and the extra padding would become a dead band.
  const { height: winH, width: winW } = useWindowDimensions();
  const bottomInset = bottomInsetFor(Platform.OS, winW, winH);


  const sessionStoreRef = useRef<SessionStore | null>(null);

  // AppState tracking: track when app is in background
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      const previous = appStateRef.current;
      appStateRef.current = next;
      if (next === "active" && previous !== "active") void clearBadge();
      // Send the session's diagnostics (timings included) as the app leaves
      // the screen; rate-limited inside maybeUploadDiag.
      if (next === "background" && previous !== "background") maybeUploadDiag();
      // A resume RPC can time out without closing a healthy socket. Try the
      // saved chat again when the user returns, not just on socket reconnect.
      if (next === "active" && previous !== "active" && gwRef.current?.state === "open") {
        if (!activeSessionRef.current) void sessionStoreRef.current?.restoreSession();
        else if (busyRef.current) {
          // iOS may miss message.complete while suspended. Verify the server
          // instead of letting the stale busy flag block its own recovery.
          void (async () => {
            await sessionStoreRef.current?.attachSession();
            await flushPendingRef.current();
          })().catch(() => {});
        } else {
          void sessionStoreRef.current?.refreshTail();
          void flushPendingRef.current();
        }
      }
    });
    return () => sub.remove();
  }, []);

  // Picker memory loads once, off the first paint, so boot stays instant.
  useEffect(() => {
    void (async () => {
      const p = await loadModelPrefs();
      prefsRef.current = p;
      if (mounted.current) setPrefs(p);
    })();
  }, []);

  const handleLinkPress = useCallback((url: string): boolean => {
    if (url && /^https?:\/\//i.test(url)) {
      void Linking.openURL(url).catch((err) => {
        console.warn("Failed to open URL:", err);
      });
      return false;
    }
    return false;
  }, []);

  const handleSocketEvent = useCallback(
    (type: string, payload: any, sessionId?: string) => {
      switch (type) {
        case "message.start":
          replyHaptic.start(sessionId || activeSessionRef.current);
          startStream(payload?.message_id || payload?.id, sessionId);
          break;
        case "message.delta": {
          const text = payload?.text ?? "";
          if (text) {
            replyToken(sessionId);
            appendDelta(text, sessionId, payload?.message_id || payload?.id);
          }
          break;
        }
        case "tool.start": {
          const name = payload?.tool_name || payload?.name || "tool";
          startTool(String(name));
          break;
        }
        case "tool.complete":
          completeTool();
          break;
        case "thinking.delta": {
          const text = payload?.text ?? "";
          if (text) appendThinkingDelta(text, sessionId, payload?.message_id || payload?.id);
          break;
        }
        case "reasoning.available": {
          const text = payload?.text ?? "";
          if (text) setReasoningAvailable(text);
          break;
        }
        case "reasoning.delta": {
          const text = payload?.text ?? "";
          if (text) appendReasoningDelta(text);
          break;
        }
        case "session.info": {
          // Live model truth: the backend re-emits session.info after every
          // model switch (and at turn boundaries). Painting here keeps the
          // header chip in sync mid-chat instead of only on resume.
          if (payload?.model) sessionStoreRef.current?.setModel(String(payload?.model));
          if (payload?.provider) sessionStoreRef.current?.setProvider(String(payload?.provider));
          if (typeof payload?.running === "boolean" && !payload?.running) {
            setBusy(false);
            setToolActivity("");
          }
          break;
        }
        case "sessions.changed": {
          const sid = sessionStoreRef.current?.activeSession;
          if (sid && busyRef.current) {
            void (async () => {
              try {
                const d = await fetchJSON<{ messages?: any[] }>(
                  `/api/sessions/${encodeURIComponent(sid)}/messages?limit=20&order=latest`,
                );
                if (!mounted.current) return;
                const msgs = d.messages ?? [];
                if (msgs.length > 0) {
                  const last = msgs[msgs.length - 1];
                  if (last.role === "assistant") {
                    setBusy(false);
                    setToolActivity("");
                  }
                }
              } catch {}
            })();
          }
          break;
        }
        case "message.complete": {
          const finalText = payload?.text ?? payload?.rendered ?? "";
          const isError = payload?.status === "error";
          replyDone(sessionId, payload?.status);
          finishStream(finalText, isError, payload?.persisted_turn);
          if (replyHaptic.complete(activeSessionRef.current, payload?.status || "complete", appStateRef.current === "active")) {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }
          break;
        }
        case "error": {
          replyHaptic.clear();
          handleError(payload?.message || "gateway error");
          break;
        }
      }
    },
    [
      startStream,
      appendDelta,
      startTool,
      completeTool,
      appendThinkingDelta,
      setReasoningAvailable,
      appendReasoningDelta,
      finishStream,
      handleError,
      setBusy,
      setToolActivity,
      busyRef,
    ],
  );

  const handleConnected = useCallback(
    async (opts?: { attachOnly?: boolean; ticketBundle?: TicketBundle }) => {
      if (opts?.attachOnly && activeSessionRef.current) {
        await sessionStoreRef.current?.attachSession(opts?.ticketBundle);
      } else {
        // A cold restore may have timed out while the socket was open. Without
        // a live session, retry the saved durable chat rather than attaching
        // to an empty runtime id and leaving the screen stranded.
        await sessionStoreRef.current?.restoreSession(opts?.ticketBundle);
      }
      // Self-heal a stuck "uncertain" pending send now that the session is
      // attached/restored and history is re-synced: clear it if the text is
      // already in history, re-queue it for retry if not. Runs before the
      // flush so a re-queued text is picked up in the same connect.
      await healUncertainPendingRef.current();
      await flushPendingRef.current();
      // Push registration is best-effort and self-healing: re-run on every
      // connect so a backend restart that lost tokens gets a fresh one.
      // ensurePushRegistration is idempotent, never prompts twice, never throws.
      void (async () => {
        try {
          const deviceId = await getDeviceId();
          if (deviceId) await ensurePushRegistration(gwRef.current, deviceId);
        } catch {
          // Never break connect handling.
        }
      })();
    },
    [],
  );

  const socket = useHermesSocket({
    activeSessionRef,
    needsLogin,
    onEvent: handleSocketEvent,
    onConnected: handleConnected,
    // busyRef mirrors the thinking-pill state: while a turn is in flight
    // the socket reconnects with a 5s backoff cap instead of 30s.
    isBusyRef: busyRef,
  });

  const {
    conn,
    gwRef,
    reconnect,
    retryScheduled,
  } = socket;
  // Red Offline is reserved for a socket that is down AND not being
  // retried; a scheduled retry or in-flight connect shows Connecting….
  const connPill = pillStatus(conn, retryScheduled);

  const onCheckTail = useCallback(
    (tail: Msg[], sid?: string) => {
      // Id-keyed instead of the old role+text compare (which broke on the
      // cache's 900-char truncation): the merge returns the same array
      // reference when nothing changed, so unchanged tails never repaint and
      // never touch the busy pill.
      if (mergeServerRows(messagesRef.current, tail) === messagesRef.current) return;
      setBusy(false);
      setToolActivity("");
      if (mounted.current) syncFromServer(tail, sid);
    },
    [syncFromServer, messagesRef, setBusy, setToolActivity],
  );

  const sessionStore = useSessionStore({
    gwRef,
    activeSessionRef,
    onResetChat: storeReset,
    onLoadMessages: loadMessages,
    onSyncMessages: syncFromServer,
    onSetBusy: setBusy,
    onSetToolActivity: setToolActivity,
    onErrorMessage: addErrorMessage,
    onBeforeSwitch: () => {
      replyHaptic.clear();
      lastFailed.current = null;
      failedTurnsRef.current.clear();
      if (sentTimer.current) clearTimeout(sentTimer.current);
      setDelivery("");
      setShowScrollBottom(false);
      storeReset();
    },
    onCheckTail,
  });
  sessionStoreRef.current = sessionStore;

  const {
    activeSession,
    activeTitle,
    loadingSession,
    filteredSessions,
    model,
    provider,
    drawerOpen,
    sessionFilter,
    refreshingSessions,
    modelOptions,
    pickerOpen,
    expandedProv,
    switching,
    setDrawerOpen,
    setSessionFilter,
    setPickerOpen,
    setExpandedProv,
    loadSessions,
    onRefreshSessions,
    openDrawer,
    resumeSession,
    newChat,
    switchModel,
    openPicker,
    applyDefaultModel,
    loadError,
    retryLoad,
  } = sessionStore;
  // Mirror of the selected model for async send paths: a send must never go
  // out with no model behind it.
  modelRef.current = model;

  // Push notification tap: open the chat the push is about. Pushes carry
  // only a sessionId (never message text), resolved against the known
  // sessions; an unknown id still resumes by id (cached transcript first).
  const handlePushOpenSession = useCallback((sessionId: string) => {
    try {
      const store = sessionStoreRef.current;
      if (!store || !sessionId) return;
      // Already on this chat: the tap already foregrounded the app.
      if (store.getStoredSessionId() === sessionId) return;
      const row = store.sessions.find(
        (sess) => sess.id === sessionId || sess.stored_session_id === sessionId,
      );
      void store.resumeSession(row ?? { id: sessionId });
    } catch {
      // Never throw out of a native callback.
    }
  }, []);

  useEffect(() => installPushHandlers(handlePushOpenSession), [handlePushOpenSession]);
  useEffect(() => { void clearBadge(); }, []);
  // Name the stage when push registration fails (metadata only, never the
  // token) and upload at once so the Mac can see why a phone isn't registered.
  useEffect(() => {
    setPushReporter((stage, detail) => {
      diagLog("push_register", { stage, ...(detail || {}) });
      if (stage !== "registered") maybeUploadDiag();
    });
    return () => setPushReporter(null);
  }, []);

  // EAS OTA: cold-start + foreground checks, silent download, never reloads.
  useEffect(() => startOtaUpdates(), []);

  // Save only a settled chat. A switch resets messages before changing the
  // durable ID; streaming deltas stay in memory to avoid keychain writes per token.
  useEffect(() => {
    if (!activeSession || !sessionStore.draftSessionId || loadingSession || busy || !messages.length) return;
    const sid = sessionStore.draftSessionId;
    const timer = setTimeout(() => {
      if (activeSessionRef.current === activeSession) {
        void saveTranscript(sid, messages).catch(() => {});
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [activeSession, sessionStore.draftSessionId, loadingSession, busy, messages]);

  // Pinned models already appear in Favorites, so drop them from Recents.
  const recentExtras = useMemo(
    () => prefs.recents.filter((r) => !prefs.favorites.some((f) => refKey(f) === refKey(r))),
    [prefs],
  );

  const boot = useCallback(async () => {
    // Local transcript is available before auth, ticket fetch, or socket handshake.
    const savedId = await sessionStoreRef.current?.showCachedSession();
    sinceLaunchOnce("launch_cached", { hit: !!savedId });
    // A "submitting" item left by a kill has an unknown outcome: make it
    // uncertain so the evidence-based heal decides, never a blind resend.
    await settleAfterLaunch().catch(() => 0);
    await refreshOutbox();
    let authed = await isAuthed();
    if (!authed) authed = await silentLogin();
    if (!authed) {
      if (mounted.current) setNeedsLogin(true);
      return;
    }
    await reconnect();
  }, [reconnect]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offsetY = event.nativeEvent.contentOffset.y;
      setShowScrollBottom(offsetY > 100 && messages.length > 0);
    },
    [messages.length],
  );

  const scrollToBottom = useCallback(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    setShowScrollBottom(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void boot();
    return () => {
      mounted.current = false;
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (sentTimer.current) clearTimeout(sentTimer.current);
    };
  }, [boot]);

  useEffect(() => {
    if (conn !== "open") replyHaptic.clear();
    else sinceLaunchOnce("launch_live");
  }, [conn]);

  // Send queued texts whenever the chat is live and no reply is running:
  // on connect, on chat switch, after each queued item, and when a reply
  // finishes (a text typed during a reply waits for it, then goes out).
  useEffect(() => {
    // The live link must belong to the chat on screen (it can lag a switch).
    if (conn === "open" && activeSession && !busy && activeSessionRef.current === activeSession &&
        outbox.some(i => i.sessionId === sessionStore.draftSessionId && i.state === "queued")) {
      void flushPendingRef.current();
    }
  }, [conn, activeSession, sessionStore.draftSessionId, outbox, busy]);

  // Keep the drawer in the same native view tree as the chat. A modal with
  // animationType="none" snapped open at gesture recognition and could not
  // follow a finger. Only the narrow edge strip claims an opening swipe;
  // vertical chat scrolling remains the list's gesture.
  const drawerWidth = Math.min(winW * 0.84, 340);
  const drawerX = useRef(new Animated.Value(-drawerWidth)).current;
  const drawerWidthRef = useRef(drawerWidth);
  const drawerOpenRef = useRef(drawerOpen);
  const dragStartRef = useRef(-drawerWidth);
  const dragReadyRef = useRef(false);
  const dragPendingRef = useRef<number | null>(null);
  const dragReleaseRef = useRef<{ dx: number; vx: number } | null>(null);
  const dragGenerationRef = useRef(0);
  const [drawerVisible, setDrawerVisible] = useState(false);
  drawerWidthRef.current = drawerWidth;
  drawerOpenRef.current = drawerOpen;
  const openDrawerRef = useRef(openDrawer);
  openDrawerRef.current = openDrawer;

  const settleDrawer = useCallback((open: boolean) => {
    if (open) setDrawerVisible(true);
    Animated.spring(drawerX, {
      toValue: open ? 0 : -drawerWidthRef.current,
      useNativeDriver: true,
      tension: 85,
      friction: 12,
      overshootClamping: true,
    }).start(({ finished }) => {
      if (finished && !open && !drawerOpenRef.current) setDrawerVisible(false);
    });
  }, [drawerX]);

  const wasDrawerOpenRef = useRef(drawerOpen);
  useEffect(() => {
    if (wasDrawerOpenRef.current && !drawerOpen) Keyboard.dismiss();
    wasDrawerOpenRef.current = drawerOpen;
    settleDrawer(drawerOpen);
  }, [drawerOpen, drawerWidth, settleDrawer]);

  const closeDrawerUI = () => {
    Keyboard.dismiss();
    setDrawerOpen(false);
  };
  const moveDrawerDrag = (dx: number) => {
    if (!dragReadyRef.current) { dragPendingRef.current = dx; return; }
    drawerX.setValue(Math.max(-drawerWidthRef.current, Math.min(0, dragStartRef.current + dx)));
  };
  const releaseDrawerDrag = (dx: number, vx: number) => {
    if (!dragReadyRef.current) { dragReleaseRef.current = { dx, vx }; return; }
    dragReadyRef.current = false;
    const width = drawerWidthRef.current;
    const open = settleDrawerOpen(dragStartRef.current > -width / 2, width, dx, vx);
    if (open && !drawerOpenRef.current) openDrawerRef.current();
    else if (!open && drawerOpenRef.current) closeDrawerUI();
    else settleDrawer(open);
  };
  const startDrawerDrag = () => {
    const generation = ++dragGenerationRef.current;
    dragReadyRef.current = false;
    dragPendingRef.current = null;
    dragReleaseRef.current = null;
    setDrawerVisible(true);
    Keyboard.dismiss();
    // stopAnimation reports the actual on-screen position asynchronously on
    // some devices. Queue move/release until it arrives to avoid a closing jump.
    drawerX.stopAnimation((value: number) => {
      if (generation !== dragGenerationRef.current) return;
      dragStartRef.current = value;
      dragReadyRef.current = true;
      if (dragPendingRef.current !== null) moveDrawerDrag(dragPendingRef.current);
      const release = dragReleaseRef.current;
      if (release) releaseDrawerDrag(release.dx, release.vx);
    });
  };
  const cancelDrawerDrag = () => {
    ++dragGenerationRef.current;
    dragReadyRef.current = false;
    settleDrawer(drawerOpenRef.current);
  };
  const swipeStripRef = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => shouldOpenDrawerGesture(g.x0, g.dx, g.dy),
    onPanResponderGrant: startDrawerDrag,
    onPanResponderMove: (_e, g) => moveDrawerDrag(g.dx),
    onPanResponderRelease: (_e, g) => releaseDrawerDrag(g.dx, g.vx),
    onPanResponderTerminate: cancelDrawerDrag,
  })).current;
  const drawerPanRef = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dx < -12 && -g.dx > Math.abs(g.dy) * 1.2,
    onPanResponderGrant: startDrawerDrag,
    onPanResponderMove: (_e, g) => moveDrawerDrag(g.dx),
    onPanResponderRelease: (_e, g) => releaseDrawerDrag(g.dx, g.vx),
    onPanResponderTerminate: cancelDrawerDrag,
  })).current;

  const doLogin = useCallback(async () => {
    setLoginErr("");
    try {
      await login(username, password);
      if (!mounted.current) return;
      setNeedsLogin(false);
      setPassword("");
      await reconnect();
      await loadSessions();
    } catch (e) {
      if (!mounted.current) return;
      setLoginErr((e as Error).message);
    }
  }, [username, password, reconnect, loadSessions]);

  // A model is always selected: once the session is live and the backend
  // truth is in, an empty model means the backend has none — resolve the
  // persisted default and apply it instead of stranding the header on
  // "Choose a model". Never blocks: failures leave the picker one tap away.
  const ensureModelSelected = useCallback(async () => {
    const resolved = await sessionStoreRef.current?.applyDefaultModel(prefsRef.current).catch(() => null);
    if (resolved) {
      const next = await setDefaultModel(prefsRef.current, resolved).catch(() => prefsRef.current);
      prefsRef.current = next;
      if (mounted.current) setPrefs(next);
    }
  }, []);

  useEffect(() => {
    if (!activeSession || model || loadingSession || conn !== "open") return;
    void ensureModelSelected();
  }, [activeSession, model, loadingSession, conn, ensureModelSelected]);

  const send = useCallback(
    async (text: string, imgs: PendingImage[], retry?: PendingTurn) => {
      // 2. SEND RACE GUARD: atomically check busy flag at the very top of send()
      if (busyRef.current || conn !== "open" || !activeSessionRef.current ||
          activeSessionRef.current !== activeSession) return false;

      // Pin the session at send time so a mid-upload chat switch can't
      // dispatch the finished turn into the previous chat.
      const sendSid = retry?.sessionId || activeSession;
      if (!sendSid) {
        addErrorMessage("No active session — reopen from drawer");
        return false;
      }

      const gw = gwRef.current;
      if (!gw || gw.state !== "open") return false;

      if (!text && imgs.length === 0) return false;

      // Atomically set busy
      setBusy(true);
      busyOwnerRef.current = sendSid;
      setDelivery(imgs.length ? "Uploading" : "Sending");
      setBusyLabel(imgs.length ? `Uploading ${imgs.length} photo${imgs.length > 1 ? "s" : ""}…` : "Sending…");

      const turn: PendingTurn = retry || { sessionId: sendSid, text, images: imgs, imagePaths: [] };
      let submitting = false;
      // A retry replays into its original failed bubble; only a fresh turn
      // adds a new user message.
      let userMsgId: string | undefined;
      if (retry) {
        userMsgId = retry.messageId;
        // A retry replays into its original bubble: clear the failed state
        // and mark it sending again for the new attempt.
        if (userMsgId) {
          patchMessage(userMsgId, (m) => ({
            ...m,
            sendFailed: undefined,
            sendError: undefined,
            sending: true,
          }));
        }
      } else {
        userMsgId = addUserMessage(text || "📷 photo", imgs.map((p) => p.uri), { sending: true });
      }
      tapOnSend(Haptics);

      if (imgs.length > 0) {
        setToolActivity(`Uploading ${imgs.length} photo${imgs.length > 1 ? "s" : ""}…`);
      }

      try {
        // A send always has a model behind it: fill the persisted default
        // before submitting so a fresh chat can never strand the turn.
        if (!modelRef.current) await ensureModelSelected();
        // Upload photos sequentially (base64 to data URL to gateway-visible path)
        await submitTurn(sendSid, turn.text, turn.images, turn.imagePaths, {
          uploadImage: async (img) => {
            const doUpload = () => {
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 60000);
              return authFetch(`${BASE}/api/chat/image-upload`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                signal: ctrl.signal,
                body: JSON.stringify({
                  data_url: `data:image/jpeg;base64,${img.base64}`,
                  filename: img.name,
                }),
              }).finally(() => clearTimeout(t));
            };
            let res = await doUpload();
            if (res.status === 401) {
              const ok = await silentLogin();
              if (ok) res = await doUpload();
            }
            if (!res.ok) throw new Error(`photo ${img.name} upload failed (${res.status})`);
            const d = await res.json();
            return d.path ?? d.file ?? d.image_path;
          },
          submit: async (sessionId, body) => {
            if (!mounted.current || activeSessionRef.current !== sessionId) {
              throw new Error("Chat changed before submission");
            }
            setToolActivity("");
            setBusyLabel("Sending…");
            submitting = true;
            if (sentTimer.current) clearTimeout(sentTimer.current);
            setDelivery("Sending");
            await gw.request("prompt.submit", { session_id: sessionId, text: body }, 15000);
          },
        }, {
          // Uploads get bounded retries with backoff: transient network blips
          // should not strand a photo. The submit RPC stays single-attempt —
          // a post-submit timeout may hide an accepted prompt, so only the
          // user's explicit tap-to-retry may replay a submission.
          maxUploadAttempts: 3,
          uploadRetryDelayMs: 1000,
          onUploadRetry: (attempt, maxAttempts) => {
            setBusyLabel(`Uploading… retry ${attempt}/${maxAttempts}`);
          },
        });
        if (!mounted.current || activeSessionRef.current !== sendSid) {
          // This turn belongs to another chat now: its completion events are
          // session-gated, so nothing will ever clear its busy state. Clear it
          // only if no newer turn has taken ownership of the spinner meanwhile.
          if (busyOwnerRef.current === sendSid) {
            setBusy(false);
            busyOwnerRef.current = null;
          }
          // The user bubble for this turn was marked sending above: the chat
          // changed, so clear it or the spinner would spin forever.
          if (userMsgId) {
            patchMessage(userMsgId, (m) => ({ ...m, sending: undefined }));
          }
          return true;
        }
        lastFailed.current = null;
        if (turn.messageId) failedTurnsRef.current.delete(turn.messageId);
        // Ack: the bubble resolves to sent. sendFailed is cleared too in
        // case this was a retried turn; the text stays.
        if (userMsgId) {
          patchMessage(userMsgId, (m) => ({
            ...m,
            sending: undefined,
            sendFailed: undefined,
            sendError: undefined,
          }));
        }
        setDelivery("Sent");
        setBusyLabel("");
        clearRetryErrors();
        // A successful send is not information worth leaving on screen: flash
        // it briefly, then let the footer go quiet. Problem states below do
        // NOT auto-clear; they stay until the user acts.
        if (sentTimer.current) clearTimeout(sentTimer.current);
        sentTimer.current = setTimeout(() => {
          if (mounted.current) setDelivery("");
        }, 1200);
      } catch (e) {
        if (!mounted.current || activeSessionRef.current !== sendSid) {
          if (busyOwnerRef.current === sendSid) {
            setBusy(false);
            busyOwnerRef.current = null;
          }
          // Same stuck-spinner guard as the success path above.
          if (userMsgId) {
            patchMessage(userMsgId, (m) => ({ ...m, sending: undefined }));
          }
          return true;
        }
        const errMsg = (e as Error).message || "";
        // Once the submit RPC starts, even a socket error may hide an accepted
        // prompt. Offer retry only for a failure before submission (for example,
        // a photo upload). An uncertain prompt needs a chat check first.
        if (submitting) {
          setDelivery("Delivery uncertain");
          lastFailed.current = null;
          setRetryError("delivery unconfirmed — check the conversation before resending");
          // The submit attempt is over; the bubble must not keep claiming
          // "sending" when the outcome is unknown. The delivery pill carries
          // the uncertain state; the text stays in place.
          if (userMsgId) {
            patchMessage(userMsgId, (m) => ({ ...m, sending: undefined }));
          }
        } else {
          // Inline on the message: the bubble keeps the text and gains a
          // tap-to-retry state. Nothing is dropped, no separate error row.
          setDelivery("Failed to send · Tap the message to retry");
          const failed: PendingTurn = { ...turn, messageId: userMsgId };
          lastFailed.current = failed;
          if (userMsgId) {
            failedTurnsRef.current.set(userMsgId, failed);
            patchMessage(userMsgId, (m) => ({
              ...m,
              sending: undefined,
              sendFailed: true,
              sendError: errMsg ? errMsg.slice(0, 140) : undefined,
            }));
          }
        }
        setBusy(false);
        setToolActivity("");
        setBusyLabel("");
      }
      return true;
    },
    [activeSession, conn, addErrorMessage, addUserMessage, clearRetryErrors, setBusy, setRetryError, setToolActivity, patchMessage, setBusyLabel, ensureModelSelected],
  );

  // Send the chat's oldest outbox item once the chat has a live session.
  // Persist "submitting" before the RPC: after a crash or timeout the outcome
  // is unknown, and this server has no client-send idempotency key.
  const flushPending = useCallback(async () => {
    const storedSid = sessionStoreRef.current?.getStoredSessionId();
    const pending = headFor(storedSid);
    const gw = gwRef.current;
    if (!pending || pending.state !== "queued" || flushingRef.current ||
        !gw || gw.state !== "open" || busyRef.current || !activeSessionRef.current ||
        storedSid !== pending.sessionId) {
      const flushGuard = evaluateFlushGate({
        hasPending: !!pending,
        canAutoSend: pending ? pending.state === "queued" : false,
        flushing: flushingRef.current,
        gwOpen: !!gw && gw.state === "open",
        busy: busyRef.current,
        hasActiveSid: !!activeSessionRef.current,
        sessionMatches: storedSid === pending?.sessionId,
      });
      if (flushGuard !== "no_pending") {
        diagLog("send_blocked", { where: "flushPending", guard: flushGuard, pending_state: pending?.state ?? null });
      }
      // An uncertain head holds later texts (order matters). Ask the heal to
      // decide once enough time has passed; it uses fresh server evidence.
      if (pending?.state === "uncertain") scheduleHeal();
      return;
    }
    const liveSid = activeSessionRef.current;
    flushingRef.current = true;
    let marked = false;
    let sent = false;
    let flushedUserMsgId: string | undefined;
    try {
      // Baseline: the newest server row this chat had before the RPC. A
      // later heal only counts matching server rows newer than this.
      const submitting = await markSubmitting(pending, latestServerRowId(messagesRef.current));
      marked = true;
      setBusy(true);
      busyOwnerRef.current = liveSid;
      setBusyLabel("Sending…");
      if (!mounted.current || activeSessionRef.current !== liveSid ||
          sessionStoreRef.current?.getStoredSessionId() !== pending.sessionId || gwRef.current !== gw) {
        // No RPC started: keep the text queued for its original chat.
        await returnToQueue(submitting);
        await refreshOutbox();
        if (busyOwnerRef.current === liveSid) {
          setBusy(false);
          busyOwnerRef.current = null;
        }
        return;
      }
      await refreshOutbox();
      if (mounted.current) {
        flushedUserMsgId = addUserMessage(pending.text, undefined, { sending: true });
      }
      // The outbox id travels with the text, so a resend of a message the Mac
      // already accepted is answered "duplicate" instead of a second reply.
      const sendStartedAt = Date.now();
      const outcome = await submitOnce(gw, liveSid, pending.text, pending.id, 15000);
      if (outcome === "sent") sendAccepted(liveSid, sendStartedAt);
      await clearPending(submitting);
      sent = true;
      await refreshOutbox();
      if (outcome === "duplicate") {
        // No new turn starts, so no completion event will clear the spinner.
        diagLog("send_duplicate_ignored", {});
        if (busyOwnerRef.current === liveSid) {
          setBusy(false);
          busyOwnerRef.current = null;
        }
      }
      if (mounted.current) {
        setDelivery("");
        if (flushedUserMsgId) patchMessage(flushedUserMsgId, (m) => ({ ...m, sending: undefined }));
        setBusyLabel("");
      }
    } catch {
      if (busyOwnerRef.current === liveSid) {
        setBusy(false);
        busyOwnerRef.current = null;
      }
      if (marked) {
        await markUncertain(pending).catch(() => {});
        await refreshOutbox();
        if (mounted.current && flushedUserMsgId) patchMessage(flushedUserMsgId, (m) => ({ ...m, sending: undefined }));
        scheduleHeal();
      }
    } finally { flushingRef.current = false; }
    // Later texts for this chat go out after the reply (the flush effect
    // reruns when busy clears); nothing else to do here.
    void sent;
  }, [busyRef, gwRef, addUserMessage, patchMessage, setBusy, setBusyLabel, refreshOutbox]);
  flushPendingRef.current = flushPending;

  // Self-healing for an "uncertain" send (the RPC timed out or the app was
  // killed mid-send). Fetch this chat's server history directly and decide
  // from it alone. The local transcript is never evidence: it holds the
  // app's own optimistic bubble (a false "delivered" would delete the only
  // copy) and stale cache rows (a false "missing" would send a duplicate
  // turn; prompt.submit has no idempotency key). A failed fetch or
  // ambiguous evidence leaves it uncertain and tries again later.
  const healUncertainPending = useCallback(async () => {
    const storedSid = sessionStoreRef.current?.getStoredSessionId();
    const pending = headFor(storedSid);
    if (!pending || pending.state !== "uncertain") return;
    if (!activeSessionRef.current) return;
    let serverRows: Msg[] | null = null;
    try {
      const d = await fetchJSON<{ messages?: any[] }>(
        `/api/sessions/${encodeURIComponent(pending.sessionId)}/messages?limit=200&order=latest`,
      );
      serverRows = mapServerMessages(d.messages ?? []);
    } catch {
      serverRows = null;
    }
    // The chat or outbox may have changed during the fetch.
    const current = headFor(sessionStoreRef.current?.getStoredSessionId());
    if (!current || current.id !== pending.id || current.state !== "uncertain") return;
    const decision = decidePendingHeal(
      current,
      activeSessionRef.current,
      sessionStoreRef.current?.getStoredSessionId(),
      serverRows,
    );
    if (decision === "skip") {
      diagLog("pending_healed", { action: "left_uncertain", fetched: serverRows !== null });
      scheduleHeal();
      return;
    }
    try {
      if (decision === "clear") {
        await clearPending(current);
        diagLog("pending_healed", { action: "cleared_delivered" });
      } else {
        await returnToQueue(current);
        diagLog("pending_healed", { action: "requeued_for_retry" });
      }
    } catch {
      diagLog("pending_healed", { action: "aborted", decision });
    }
    await refreshOutbox();
  }, [refreshOutbox]);
  // One pending heal timer at a time. The heal needs the send to have been
  // uncertain for HEAL_REQUEUE_MIN_AGE_MS before it may resend.
  const healTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleHeal = () => {
    if (healTimerRef.current) return;
    healTimerRef.current = setTimeout(() => {
      healTimerRef.current = null;
      if (mounted.current) void healUncertainPendingRef.current();
    }, HEAL_REQUEUE_MIN_AGE_MS + 5000);
  };
  useEffect(() => () => { if (healTimerRef.current) clearTimeout(healTimerRef.current); }, []);
  healUncertainPendingRef.current = healUncertainPending;

  // This chat's own outbox items, oldest first.
  const chatOutbox = outbox.filter(i => i.sessionId === sessionStore.draftSessionId);
  // One plain warning, only when a message has been stuck a while with no
  // link to the Mac. No connection chatter otherwise.
  const hasQueued = chatOutbox.some(i => i.state === "queued");
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!hasQueued || conn === "open") { setStuck(false); return; }
    const t = setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => clearTimeout(t);
  }, [hasQueued, conn]);

  const sendOrQueue = useCallback(async (text: string, imgs: PendingImage[]) => {
    if (conn === "open" && activeSession && imgs.length) {
      // Photos need the live chat and an idle agent; text never waits.
      if (busyRef.current || activeSessionRef.current !== activeSession) {
        diagLog("send_blocked", { where: "sendOrQueue_live", guard: busyRef.current ? "busy" : "session_mismatch" });
        return false;
      }
      return await send(text, imgs);
    }
    // Accept text into the durable outbox first, connected or not. The
    // composer clears at once; the flush effect sends it when the chat is
    // live and no reply is running. Typing and sending never wait on the
    // network.
    const storedId = sessionStoreRef.current?.getStoredSessionId();
    if (!storedId || imgs.length) {
      const queueGate = evaluateQueueGate({ storedSessionId: storedId, hasImages: imgs.length > 0, pendingState: null });
      diagLog("send_blocked", { where: "sendOrQueue_queue", guard: queueGate, pending_state: null });
      const blockedText = queueGateDeliveryText(queueGate);
      if (blockedText && mounted.current) setDelivery(blockedText);
      return false;
    }
    try {
      await queueText(storedId, text);
      await refreshOutbox();
      if (conn === "open" && activeSession && activeSessionRef.current === activeSession) {
        void flushPendingRef.current();
      }
      return true;
    } catch (e) {
      if (mounted.current) setDelivery((e as Error).message || "Couldn't save message");
      return false;
    }
  }, [conn, activeSession, send]);

  // Remove an outbox item the user no longer wants (never mid-RPC).
  const dismissPending = useCallback(async (item?: PendingText) => {
    const pending = item ?? headFor(sessionStoreRef.current?.getStoredSessionId());
    if (!pending || pending.state === "submitting") return;
    await clearPending(pending).catch(() => {});
    await refreshOutbox();
    if (mounted.current) setDelivery("");
  }, [refreshOutbox]);

  const retryLast = useCallback(async () => {
    const failed = lastFailed.current;
    if (!failed || failed.sessionId !== activeSessionRef.current) return;
    await send(failed.text, failed.images, failed);
  }, [send]);

  const copyMsg = useCallback(async (m: Msg) => {
    const text = [m.thinking, m.text].filter(Boolean).join("\n\n");
    if (!text) return;
    await Clipboard.setStringAsync(text);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (!mounted.current) return;
    setCopiedId(m.id);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => {
      if (mounted.current) setCopiedId("");
    }, 1500);
  }, []);

  const shareMsg = useCallback(async (m: Msg) => {
    const text = [m.thinking, m.text].filter(Boolean).join("\n\n");
    if (!text) return;
    try {
      await Share.share({ message: text });
    } catch {
      // Dismissed sheet or iOS refusal. Nothing to recover.
    }
  }, []);

  // Retry works on the nearest earlier user turn, not on the reply itself.
  const promptBefore = useCallback(
    (m: Msg): string => {
      const all = messagesRef.current;
      const idx = all.findIndex((x) => x.id === m.id);
      if (idx < 0) return "";
      for (let i = idx - 1; i >= 0; i--) {
        if (all[i].role === "user") return all[i].text || "";
      }
      return "";
    },
    [messagesRef],
  );

  const retryFromMessage = useCallback(
    (m: Msg) => {
      const text = promptBefore(m);
      if (!text) {
        addErrorMessage("Nothing to retry — no earlier prompt in this chat");
        return;
      }
      void send(text, []);
    },
    [promptBefore, send, addErrorMessage],
  );

  // Tap-to-retry on a failed message replays that message's exact turn when
  // one was recorded. Error rows with no recorded turn (e.g. the busy-timeout
  // row) retry the nearest earlier user prompt instead of doing nothing.
  const retryMessage = useCallback((m: Msg) => {
    const turn = failedTurnsRef.current.get(m.id) ||
      (lastFailed.current?.messageId === m.id ? lastFailed.current : undefined);
    if (turn && turn.sessionId === activeSessionRef.current) {
      void send(turn.text, turn.images, turn);
      return;
    }
    retryFromMessage(m);
  }, [send, retryFromMessage]);

  const openActions = useCallback((m: Msg) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActionMsg(m);
  }, []);

  // Switching stays instant: the switch fires first, memory persists after.
  const pickModel = useCallback(
    (provSlug: string, name: string) => {
      void switchModel(provSlug, name);
      void (async () => {
        // The explicit pick becomes the persisted default, so the next
        // session starts with a model instead of "Choose a model".
        const recent = await rememberRecent(prefsRef.current, { provider: provSlug, model: name });
        const next = await setDefaultModel(recent, { provider: provSlug, model: name }).catch(() => recent);
        prefsRef.current = next;
        if (mounted.current) setPrefs(next);
      })();
    },
    [switchModel],
  );

  const toggleFavModel = useCallback((provSlug: string, name: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void (async () => {
      const next = await toggleFavorite(prefsRef.current, { provider: provSlug, model: name });
      prefsRef.current = next;
      if (mounted.current) setPrefs(next);
    })();
  }, []);

  // Stop clears the UI the instant it's tapped. The interrupt RPC is
  // fire-and-forget: awaiting it here wedged the pill on a dead socket until
  // the heartbeat timeout retired the request (~45s).
  const interrupt = useCallback(() => {
    const gw = gwRef.current;
    replyHaptic.clear();
    if (gw && activeSession) {
      void gw
        .request("session.interrupt", { session_id: activeSession }, 5000)
        .catch(() => {});
    }
    storeInterrupt();
  }, [activeSession, storeInterrupt, gwRef]);





  if (needsLogin) {
    return (
      <View style={s.loginRoot}>
        <StatusBar style="light" />
        <Text style={s.loginTitle}>Hermes</Text>
        <Text style={s.loginSub}>Sign in to the mini</Text>
        <TextInput style={s.loginInput} value={username} onChangeText={setUsername} autoCapitalize="none" placeholder="Username" placeholderTextColor="#6b6f7c" />
        <TextInput style={s.loginInput} value={password} onChangeText={setPassword} secureTextEntry placeholder="Password" placeholderTextColor="#6b6f7c" onSubmitEditing={() => void doLogin()} />
        {!!loginErr && <Text style={s.loginErr}>{loginErr}</Text>}
        <TouchableOpacity style={s.loginBtn} onPress={() => void doLogin()}>
          <Text style={s.loginBtnText}>Sign in</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      {/* Backdrop lives OUTSIDE the KeyboardChatLayout so the keyboard
          resizing the chat area can never rescale or reposition the art. */}
      <ImageBackground
        source={require("../assets/tognon-background.jpg")}
        resizeMode="cover"
        style={s.backdropLayer}
        imageStyle={s.chatBackdropImage}
      >
        <View style={s.chatBackdropScrim} />
      </ImageBackground>
      <KeyboardChatLayout
        style={s.kbWrap}
      >
      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open chats" style={s.headerIconButton} onPress={() => void openDrawer()}>
          <View style={s.menuLines}>
            <View style={s.menuLine} /><View style={s.menuLine} /><View style={s.menuLine} />
          </View>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="New chat" style={s.headerIconButton} onPress={() => void newChat()}>
          <Text style={s.newChatIcon}>＋</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Choose model" style={s.headerTitleButton} onPress={() => void openPicker()}>
          <Text style={s.title} numberOfLines={1}>
            {activeTitle || "Hermes"}
          </Text>
          <Text style={s.modelText} numberOfLines={1}>
            {model ? `${provider ? provider + " · " : ""}${model}  ▾` : "Choose a model"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`App status and usage, ${BUILD_LABEL}`}
          onPress={() => setDetailsOpen(true)}
          style={s.statusButton}
        >
          <View
            style={[
              s.dot,
              {
                backgroundColor:
                  // Quiet dot: green live, grey otherwise. The app works
                  // offline-first, so a dropped link is not an alarm.
                  connPill === "live" ? "#3ddc84" : "#5d5775",
              },
            ]}
          />
        </TouchableOpacity>
      </View>

      {/* Honest load states: named in-flight work, and failures as a banner
          with a retry — never an infinite spinner, never a dead screen. */}
      {loadingSession && (
        <View style={s.loadingBar}>
          <ActivityIndicator size="small" color="#a78bfa" />
          <Text style={s.loadingText}>Loading history…</Text>
        </View>
      )}
      {!!loadError && (
        <View style={s.loadErrorBar}>
          <Text style={s.loadErrorText} numberOfLines={3}>{loadError}</Text>
          <TouchableOpacity
            style={s.loadErrorBtn}
            onPress={() => void retryLoad()}
            accessibilityRole="button"
            accessibilityLabel="Retry loading chat"
          >
            <Text style={s.loadErrorBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={s.listContainer}>
        <FlatList
          ref={flatListRef}
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          data={reversedMessages}
          ListHeaderComponent={chatOutbox.some(i => i.state === "queued") ? (
            <View>
              {chatOutbox.filter(i => i.state === "queued").slice().reverse().map(i => (
                <MessageRow
                  key={i.id}
                  item={{ id: i.id, role: "user", text: i.text }}
                  isCopied={copiedId === i.id}
                  onCopy={copyMsg}
                  onRetry={retryMessage}
                  onLinkPress={handleLinkPress}
                  onLongPressAction={openActions}
                />
              )).reverse()}
              <Text accessibilityLiveRegion="polite" style={s.deliveryText}>
                {stuck ? STUCK_TEXT : "Will send automatically"}
              </Text>
            </View>
          ) : null}
          inverted
          keyExtractor={(m) => m.id}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          initialNumToRender={10}
          maxToRenderPerBatch={8}
          windowSize={5}
          removeClippedSubviews={Platform.OS === "android"}
          ListEmptyComponent={
            <View style={s.emptyState}>
              <View style={s.emptyMark}><Text style={s.emptyMarkText}>✦</Text></View>
              <Text style={s.emptyTitle}>Ask Hermes anything</Text>
              <Text style={s.emptySubtitle}>Your conversation starts here</Text>
            </View>
          }
          renderItem={({ item }) => (
            <MessageRow
              item={item}
              isCopied={copiedId === item.id}
              onCopy={copyMsg}
              onRetry={retryMessage}
              onLinkPress={handleLinkPress}
              onLongPressAction={openActions}
            />
          )}
        />
        {showScrollBottom && (
          <TouchableOpacity
            style={s.scrollBottomBtn}
            onPress={scrollToBottom}
            activeOpacity={0.8}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={s.scrollBottomArrow}>↓</Text>
          </TouchableOpacity>
        )}
        {/* Edge-swipe strip: opens the drawer from the left edge */}
        <View
          pointerEvents="auto"
          style={s.edgeSwipeStrip}
          {...swipeStripRef.panHandlers}
        />
        {/* Thinking pill floats in the reserved lane at the bottom of the
            list instead of sitting in the layout flow, so mounting it never
            resizes the chat area. */}
        {busy && (
          <View pointerEvents="box-none" style={s.busyOverlay}>
            <TouchableOpacity
              style={s.stopBtn}
              onPress={() => void interrupt()}
              activeOpacity={0.8}
            >
              <ActivityIndicator size="small" color="#c4b5fd" />
              <Text style={s.stopLabel}>
                {/* Never connection words. Offline, a tool name could be stale. */}
                {conn === "open" ? busyLabel || (toolActivity ? `Running ${toolActivity}…` : "Thinking…") : "Thinking…"}
              </Text>
              <View style={s.stopBadge}>
                <Text style={s.stopText}>Stop</Text>
              </View>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* One continuous dock covers the home-indicator area. No separate
          build/status row and no transparent strip below the composer. */}
      <ComposerDock style={s.composerDock} bottomInset={bottomInset}>
        {chatOutbox[0]?.state === "uncertain" ? (
          <TouchableOpacity onPress={() => void dismissPending(chatOutbox[0])} accessibilityRole="button"
            accessibilityLabel="Couldn't confirm the last message was delivered. Tap to dismiss it">
            <Text accessibilityLiveRegion="polite" style={s.deliveryText}>Checking last message · Dismiss</Text>
          </TouchableOpacity>
        ) : delivery && delivery !== "Sent" ? (
          <Text accessibilityLiveRegion="polite" style={s.deliveryText}>{delivery}</Text>
        ) : null}
        <Composer
          sessionId={sessionStore.draftSessionId || activeSession || undefined}
          onSend={sendOrQueue}
          // Text always goes to the outbox, so typing and Send never wait on
          // the connection or a running reply. Photos still need a live chat.
          busy={false}
          connected={conn === "open" && !!activeSession}
          allowQueue={!!sessionStore.draftSessionId}
          onImageError={addErrorMessage}
        />
      </ComposerDock>
      <AppDetails visible={detailsOpen} onClose={() => setDetailsOpen(false)} gateway={gwRef.current}
        sessionId={activeSession} provider={provider} build={BUILD_LABEL} connection={conn} delivery={delivery} />

      <Modal
        visible={pickerOpen}
        animationType="none"
        transparent
        onRequestClose={() => setPickerOpen(false)}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={s.drawerBackdrop}
          onPress={() => setPickerOpen(false)}
        >
          <TouchableOpacity activeOpacity={1} style={s.drawer} onPress={(e) => e.stopPropagation()}>
            <View style={s.drawerHeader}>
              <Text style={s.drawerTitle}>Model</Text>
              <TouchableOpacity onPress={() => setPickerOpen(false)}>
                <Text style={s.drawerClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={modelOptions?.providers?.filter((p: any) => (p.models?.length ?? 0) > 0) ?? []}
              keyExtractor={(p: any, i: number) => p.slug || p.name || `p-${i}`}
              initialNumToRender={12}
              ListHeaderComponent={
                <>
                  {prefs.favorites.length > 0 && (
                    <View style={s.prefBlock}>
                      <Text style={s.prefTitle}>★ Favorites</Text>
                      {prefs.favorites.map((f) => (
                        <TouchableOpacity
                          key={`fav-${refKey(f)}`}
                          style={s.prefRow}
                          onPress={() => pickModel(f.provider, f.model)}
                        >
                          <Text style={s.prefModel} numberOfLines={1}>
                            {f.model}
                          </Text>
                          <Text style={s.prefProv}>{f.provider}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  {recentExtras.length > 0 && (
                    <View style={s.prefBlock}>
                      <Text style={s.prefTitle}>Recent</Text>
                      {recentExtras.map((r) => (
                        <TouchableOpacity
                          key={`rec-${refKey(r)}`}
                          style={s.prefRow}
                          onPress={() => pickModel(r.provider, r.model)}
                        >
                          <Text style={s.prefModel} numberOfLines={1}>
                            {r.model}
                          </Text>
                          <Text style={s.prefProv}>{r.provider}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </>
              }
              renderItem={({ item: p }: any) => {
                const provSlug = p.slug || p.name;
                const isCurrentProv = provSlug === provider || p.name === provider;
                const isOpen = expandedProv[provSlug] ?? isCurrentProv;
                return (
                  <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#332a56" }}>
                    <TouchableOpacity
                      style={{
                        flexDirection: "row",
                        justifyContent: "space-between",
                        alignItems: "center",
                        paddingHorizontal: 18,
                        paddingVertical: 14,
                        backgroundColor: "#161227",
                      }}
                      onPress={() =>
                        setExpandedProv((prev) => ({
                          ...prev,
                          [provSlug]: !isOpen,
                        }))
                      }
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Text style={{ color: "#f2f3f7", fontSize: 14, fontWeight: "700" }}>
                          {p.display_name || p.name}
                        </Text>
                        <Text style={{ color: "#6b6f7c", fontSize: 12 }}>
                          ({p.models.length})
                        </Text>
                      </View>
                      <Text style={{ color: "#9a9fad", fontSize: 14 }}>{isOpen ? "▴" : "▾"}</Text>
                    </TouchableOpacity>

                    {isOpen &&
                      p.models.map((m: any, idx: number) => {
                        const name = typeof m === "string" ? m : m.id || m.name || `Model ${idx + 1}`;
                        const active = name === model && isCurrentProv;
                        const isFav = prefs.favorites.some(
                          (f) => f.provider === provSlug && f.model === name,
                        );
                        return (
                          <View
                            key={`${provSlug}-${name}-${idx}`}
                            style={[
                              s.row,
                              { paddingLeft: 30, flexDirection: "row", alignItems: "center" },
                              active && s.rowActive,
                            ]}
                          >
                            <TouchableOpacity
                              style={{ flex: 1 }}
                              onPress={() => pickModel(provSlug, name)}
                            >
                              <Text
                                style={[
                                  s.rowTitle,
                                  active && { color: "#a78bfa", fontWeight: "700" },
                                ]}
                                numberOfLines={1}
                              >
                                {active ? `✓ ${name}` : name}
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              onPress={() => toggleFavModel(provSlug, name)}
                              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                            >
                              <Text style={[s.star, isFav && s.starOn]}>
                                {isFav ? "★" : "☆"}
                              </Text>
                            </TouchableOpacity>
                          </View>
                        );
                      })}
                  </View>
                );
              }}
            />
            {switching && <ActivityIndicator color="#f2f3f7" style={{ padding: 12 }} />}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Long-press actions. Tap still copies instantly, so the fast path
          stays one gesture and the richer menu costs nothing until asked. */}
      <Modal
        visible={!!actionMsg}
        animationType="fade"
        transparent
        onRequestClose={() => setActionMsg(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={s.actionBackdrop}
          onPress={() => setActionMsg(null)}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={s.actionSheet}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={s.actionTitle} numberOfLines={1}>
              {actionMsg?.role === "user" ? "Your message" : "Hermes reply"}
            </Text>
            <TouchableOpacity
              style={s.actionRow}
              onPress={() => {
                const m = actionMsg;
                setActionMsg(null);
                if (m) void copyMsg(m);
              }}
            >
              <Text style={s.actionIcon}>⧉</Text>
              <Text style={s.actionLabel}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.actionRow}
              onPress={() => {
                const m = actionMsg;
                setActionMsg(null);
                if (m) void shareMsg(m);
              }}
            >
              <Text style={s.actionIcon}>↗</Text>
              <Text style={s.actionLabel}>Share</Text>
            </TouchableOpacity>
            {actionMsg?.role === "assistant" && !!promptBefore(actionMsg) && !busy && (
              <TouchableOpacity
                style={s.actionRow}
                onPress={() => {
                  const m = actionMsg;
                  setActionMsg(null);
                  if (m) retryFromMessage(m);
                }}
              >
                <Text style={s.actionIcon}>↻</Text>
                <Text style={s.actionLabel}>Retry</Text>
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      </KeyboardChatLayout>
      {/* The panel stays mounted and translates with the gesture; no modal snap. */}
      <View pointerEvents={drawerVisible ? "auto" : "none"} style={s.drawerOverlay}>
        <Animated.View
          style={[s.sideDrawerBackdrop, {
            opacity: drawerX.interpolate({ inputRange: [-drawerWidth, 0], outputRange: [0, 1], extrapolate: "clamp" }),
          }]}
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={closeDrawerUI} />
        </Animated.View>
        <Animated.View style={[s.sideDrawer, { width: drawerWidth, transform: [{ translateX: drawerX }] }]} {...drawerPanRef.panHandlers}>
            <View style={s.drawerHeader}>
              <Text style={s.drawerTitle}>Chats</Text>
              <TouchableOpacity onPress={closeDrawerUI}>
                <Text style={s.drawerClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={s.searchInput}
              value={sessionFilter}
              onChangeText={setSessionFilter}
              placeholder="Search chats..."
              placeholderTextColor="#6b6f7c"
            />
            <FlatList
              data={filteredSessions}
              keyExtractor={(row, i) => row.id ?? `s-${i}`}
              initialNumToRender={15}
              maxToRenderPerBatch={20}
              windowSize={5}
              refreshControl={
                <RefreshControl
                  refreshing={refreshingSessions}
                  onRefresh={() => void onRefreshSessions()}
                  tintColor="#a78bfa"
                  colors={["#a78bfa"]}
                />
              }
              renderItem={({ item }) => {
                const isCurrent = item.id === activeSession;
                const hasUnread = Boolean(item.unread);
                const isActive = Boolean(item.is_active);
                return (
                  <TouchableOpacity
                    style={[s.row, isCurrent && s.rowSelected]}
                    onPress={() => void timed("switch", () => resumeSession(item))}
                  >
                    <View style={s.rowContent}>
                      {isActive ? (
                        <View style={s.dotActive} />
                      ) : hasUnread ? (
                        <View style={s.dotUnread} />
                      ) : null}
                      <Text
                        style={[s.rowTitle, isCurrent && s.rowTitleActive, hasUnread && s.rowTitleUnread]}
                        numberOfLines={1}
                      >
                        {item.title || item.display_name || (item.id || "").slice(0, 18)}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
        </Animated.View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0a0a0d" },
  loginRoot: { flex: 1, backgroundColor: "#0a0a0d", alignItems: "center", justifyContent: "center", padding: 24 },
  loginTitle: { color: "#f2f3f7", fontSize: 28, fontWeight: "800", marginBottom: 4 },
  loginSub: { color: "#9a9fad", marginBottom: 24 },
  loginInput: {
    width: "100%", height: 46, borderRadius: 12, backgroundColor: "#161227",
    color: "#f2f3f7", paddingHorizontal: 14, marginBottom: 10,
  },
  loginErr: { color: "#f85149", marginBottom: 8 },
  loginBtn: { backgroundColor: "#a78bfa", borderRadius: 12, paddingVertical: 12, paddingHorizontal: 40, marginTop: 4 },
  loginBtnText: { color: "#0a0a0d", fontWeight: "700", fontSize: 15 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 54,
    paddingBottom: 10,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#292239",
    backgroundColor: "#0d0b13",
  },
  headerIconButton: {
    width: 44, minHeight: 44, borderRadius: 14,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "#191522", borderWidth: StyleSheet.hairlineWidth, borderColor: "#383047",
  },
  menuLines: { width: 18, gap: 4 },
  menuLine: { width: 18, height: 2, borderRadius: 1, backgroundColor: "#e9e5f3" },
  newChatIcon: { color: "#e9e5f3", fontSize: 26, lineHeight: 30, fontWeight: "300" },
  headerTitleButton: { flex: 1, minHeight: 44, justifyContent: "center", marginLeft: 4 },
  title: { color: "#f7f5fb", fontSize: 17, fontWeight: "700", letterSpacing: 0.1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusButton: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 44, paddingHorizontal: 4 },
  statusText: { color: "#8e86aa", fontSize: 11.5, fontWeight: "500", minWidth: 32 },
  modelText: { color: "#a78bfa", fontSize: 11.5, fontWeight: "500", marginTop: 1 },
  toolRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
  toolBadge: { backgroundColor: "#2c2154", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: "#4a3d80" },
  toolText: { color: "#f2f3f7", fontSize: 11, fontWeight: "600" },
  thinking: { color: "#9a9fad", fontSize: 12, fontStyle: "italic", marginBottom: 6 },
  stopBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: "#171228",
    borderWidth: 1,
    borderColor: "#362a5c",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  stopLabel: { color: "#c4b5fd", fontSize: 12.5, fontWeight: "500" },
  stopBadge: {
    backgroundColor: "#3a1420",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#5e1d2c",
  },
  stopText: { color: "#f85149", fontSize: 11.5, fontWeight: "700" },
  rowActive: { backgroundColor: "#332a56" },
  sendBusy: { opacity: 0.45 },
  offlineBar: { backgroundColor: "#200e17", paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, marginHorizontal: 16, marginBottom: 6, borderWidth: 1, borderColor: "#4d1a29" },
  offlineText: { color: "#ff9b9b", fontSize: 12, fontWeight: "500", textAlign: "center" },
  loadErrorBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#200e17",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#4d1a29",
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  loadErrorText: { flex: 1, color: "#ff9b9b", fontSize: 12.5, fontWeight: "500" },
  loadErrorBtn: {
    backgroundColor: "#3a1420",
    borderWidth: 1,
    borderColor: "#5e1d2c",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  loadErrorBtnText: { color: "#ffb3b3", fontSize: 13, fontWeight: "700" },
  loadingBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#292239",
    backgroundColor: "#0d0b13",
  },
  loadingText: { color: "#a78bfa", fontSize: 12.5, fontWeight: "500" },
  searchInput: {
    height: 42,
    borderRadius: 12,
    backgroundColor: "#13101e",
    color: "#f2f3f7",
    paddingHorizontal: 14,
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#251e3a",
    fontSize: 14,
  },
  copied: { color: "#3ddc84", fontSize: 11, marginTop: 4 },
  kbWrap: { flex: 1 },
  backdropLayer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    pointerEvents: "none",
  },
  listContainer: { flex: 1, position: "relative" },
  busyOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 6,
    alignItems: "center",
  },
  chatBackdropImage: { opacity: 0.34 },
  chatBackdropScrim: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(6, 5, 10, 0.38)",
  },
  edgeSwipeStrip: { position: "absolute", left: 0, top: 0, bottom: 0, width: 28, zIndex: 10 },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 14,
    paddingTop: 14,
    // Bottom lane stays reserved so the floating Thinking pill never covers
    // the newest message and never shifts the transcript when it appears.
    paddingBottom: 56,
    gap: 12,
  },
  scrollBottomBtn: {
    position: "absolute",
    right: 16,
    bottom: 12,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#13101e",
    borderWidth: 1,
    borderColor: "#251e3a",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 4,
    elevation: 4,
    zIndex: 10,
  },
  scrollBottomArrow: {
    color: "#a78bfa",
    fontSize: 18,
    fontWeight: "700",
    lineHeight: 20,
  },
  emptyState: { alignItems: "center", paddingVertical: 36, paddingHorizontal: 24 },
  emptyMark: { width: 48, height: 48, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "#1c1730", borderWidth: StyleSheet.hairlineWidth, borderColor: "#493766", marginBottom: 14 },
  emptyMarkText: { color: "#bba9ff", fontSize: 25 },
  emptyTitle: { color: "#f2eef9", fontSize: 17, fontWeight: "700", marginBottom: 5 },
  emptySubtitle: { color: "#a59bb6", fontSize: 13, textAlign: "center" },
  composerDock: {
    backgroundColor: "#0b0911",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#493766",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: -7 },
    shadowOpacity: 0.7,
    shadowRadius: 18,
    elevation: 12,
  },
  deliveryText: { color: "#b8aecf", textAlign: "center", fontSize: 12, paddingTop: 6 },
  drawerBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.65)", justifyContent: "flex-end" },
  drawerOverlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 20 },
  sideDrawerBackdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.7)" },
  sideDrawer: {
    height: "100%",
    backgroundColor: "#09090d",
    borderRightWidth: 1,
    borderRightColor: "#1d1930",
    paddingTop: Platform.select({ ios: 48, default: 20 }),
    paddingBottom: 24,
    shadowColor: "#000",
    shadowOffset: { width: 6, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
  },
  drawer: {
    backgroundColor: "#09090d",
    maxHeight: "72%",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 30,
    borderWidth: 1,
    borderColor: "#1d1930",
  },
  drawerHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingVertical: 16 },
  drawerTitle: { color: "#ffffff", fontSize: 17, fontWeight: "700", letterSpacing: 0.2 },
  drawerClose: { color: "#8e86aa", fontSize: 18, padding: 4 },
  row: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginHorizontal: 10,
    marginVertical: 2,
    borderRadius: 12,
  },
  rowSelected: {
    backgroundColor: "#1b1433",
    borderWidth: 1,
    borderColor: "#3c2f66",
  },
  rowContent: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowTitle: { color: "#8e86aa", fontSize: 14.5, flex: 1 },
  rowTitleActive: { color: "#ffffff", fontWeight: "600" },
  rowTitleUnread: { color: "#e6e6ee", fontWeight: "600" },
  dotActive: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#3ddc84" },
  dotUnread: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#a78bfa" },
  prefBlock: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#332a56",
  },
  prefTitle: {
    color: "#8e86aa",
    fontSize: 11.5,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  prefRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
    marginBottom: 4,
    borderRadius: 10,
    backgroundColor: "#161227",
    borderWidth: 1,
    borderColor: "#2b2344",
  },
  prefModel: { color: "#e6e6ee", fontSize: 14, fontWeight: "600", flexShrink: 1 },
  prefProv: { color: "#6b6f7c", fontSize: 11.5 },
  star: { color: "#4b4667", fontSize: 17, paddingHorizontal: 2 },
  starOn: { color: "#ffd166" },
  actionBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  actionSheet: {
    backgroundColor: "#0d0b16",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderColor: "#241d3c",
    paddingTop: 10,
    paddingBottom: 34,
  },
  actionTitle: {
    color: "#8e86aa",
    fontSize: 11.5,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    paddingHorizontal: 20,
    paddingBottom: 10,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#1d1930",
  },
  actionIcon: { color: "#a78bfa", fontSize: 16, width: 20, textAlign: "center" },
  actionLabel: { color: "#edeef5", fontSize: 15.5, fontWeight: "500" },
});
