import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { Alert } from "react-native";
import { GatewayClient } from "../lib/gateway";
import { fetchJSON, type TicketBundle } from "../lib/auth";
import { isSessionFencedElsewhere } from "../lib/sessionFence";
import { visibleChatSessions } from "../lib/sessionList";
import { loadTranscript, saveTranscript } from "../lib/transcriptCache";
import { loadSessionList, saveSessionList } from "../lib/sessionListCache";
import { mapServerMessages, type Msg } from "./useChatStore";
import { resolveDefaultModel, type ModelPrefs, type ModelRef } from "../lib/modelPrefs";

const SELECTION_KEY = "hermes.m.selection.v1";
async function readSelection(): Promise<{ sessionId: string; title: string }> {
  // Total by design: corrupt selection data must degrade to "no saved chat",
  // never to a dead boot screen with no login prompt and no retry.
  try {
    const raw = await SecureStore.getItemAsync(SELECTION_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      if (typeof value?.sessionId !== "string" || typeof value?.title !== "string") {
        throw new Error("Invalid saved chat selection");
      }
      return value;
    }
  } catch {
    return { sessionId: "", title: "" };
  }
  // Older versions saved ID and title independently. The title may be from
  // a failed switch, so do not display it as if it identified this chat.
  const legacy =
    (await SecureStore.getItemAsync("hermes.m.storedSession").catch(() => null)) ||
    (await SecureStore.getItemAsync("hermes.m.activeSession").catch(() => null)) ||
    "";
  return { sessionId: legacy, title: "" };
}

export type SessionRow = {
  id: string;
  stored_session_id?: string;
  title?: string;
  display_name?: string;
  is_active?: boolean;
  unread?: boolean;
  source?: string;
  archived?: boolean;
  status?: string;
};

export interface UseSessionStoreOptions {
  gwRef: React.MutableRefObject<GatewayClient | null>;
  activeSessionRef?: React.MutableRefObject<string>;
  onResetChat?: () => void;
  onLoadMessages?: (msgs: Msg[], sessionId?: string) => void;
  onSyncMessages?: (msgs: Msg[], sessionId?: string) => void;
  onSetBusy?: (busy: boolean) => void;
  onSetToolActivity?: (act: string) => void;
  onErrorMessage?: (msg: string) => void;
  onBeforeSwitch?: () => void;
  onCheckTail?: (tail: Msg[], sessionId?: string) => void;
}

export interface SessionStore {
  // State
  activeSession: string;
  draftSessionId: string;
  activeTitle: string;
  sessions: SessionRow[];
  filteredSessions: SessionRow[];
  model: string;
  provider: string;
  loadingSession: boolean;
  drawerOpen: boolean;
  sessionFilter: string;
  refreshingSessions: boolean;
  modelOptions: any | null;
  pickerOpen: boolean;
  expandedProv: Record<string, boolean>;
  switching: boolean;

  // Setters
  setActiveSession: React.Dispatch<React.SetStateAction<string>>;
  setActiveTitle: React.Dispatch<React.SetStateAction<string>>;
  setSessions: React.Dispatch<React.SetStateAction<SessionRow[]>>;
  setModel: React.Dispatch<React.SetStateAction<string>>;
  setProvider: React.Dispatch<React.SetStateAction<string>>;
  setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionFilter: React.Dispatch<React.SetStateAction<string>>;
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setExpandedProv: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;

  // Actions
  loadSessions: () => Promise<void>;
  onRefreshSessions: () => Promise<void>;
  openDrawer: () => void;
  closeDrawer: () => void;
  resumeSession: (row: SessionRow) => Promise<void>;
  newChat: () => Promise<void>;
  switchModel: (provSlug: string, mdl: string) => Promise<void>;
  openPicker: () => Promise<void>;
  closePicker: () => void;
  restoreSession: (ticketBundle?: TicketBundle) => Promise<void>;
  showCachedSession: () => Promise<string>;
  getStoredSessionId: () => string;
  refreshTail: () => Promise<void>;
  attachSession: (ticketBundle?: TicketBundle) => Promise<void>;
  /** Resolve and apply the persisted default model when the session has none.
   *  Returns the applied ref, or null when already set / unavailable. */
  applyDefaultModel: (prefs: ModelPrefs) => Promise<ModelRef | null>;
  /** Honest load-failure state: what happened, with retryLoad re-running the
   *  bounded load that failed. Never an infinite spinner, never a dead screen. */
  loadError: string | null;
  retryLoad: () => Promise<void>;
}

export function useSessionStore(options: UseSessionStoreOptions): SessionStore {
  const {
    gwRef,
    activeSessionRef,
    onResetChat,
    onLoadMessages,
    onSyncMessages,
    onSetBusy,
    onSetToolActivity,
    onErrorMessage,
    onBeforeSwitch,
    onCheckTail,
  } = options;

  const [activeSession, setActiveSession] = useState("");
  const [draftSessionId, setDraftSessionId] = useState("");
  const [activeTitle, setActiveTitle] = useState("");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [loadingSession, setLoadingSession] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadRetryRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const retryLoad = useCallback((): Promise<void> => loadRetryRef.current(), []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sessionFilter, setSessionFilter] = useState("");
  const [refreshingSessions, setRefreshingSessions] = useState(false);
  const [modelOptions, setModelOptions] = useState<any | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expandedProv, setExpandedProv] = useState<Record<string, boolean>>({});
  const [switching, setSwitching] = useState(false);

  const mountedRef = useRef(true);
  const resumeLockRef = useRef(false);
  // REST/history uses the durable stored id; prompt.submit and WS events use the live id.
  const storedSessionRef = useRef("");
  const showCachedSession = useCallback(async () => {
    const gen = sessionRequestGenRef.current;
    const { sessionId: id, title } = await readSelection();
    if (!id || !mountedRef.current) return "";
    const cached = await loadTranscript(id);
    if (!mountedRef.current) return "";
    // Record the cache marker BEFORE the generation check: a racing
    // restoreSession (from a fast socket connect) must not cause us to lose
    // the silent-boot marker. The actual render below stays gen-guarded.
    if (cached) {
      cacheRenderedForRef.current = id;
    }
    if (gen !== sessionRequestGenRef.current) return id;
    storedSessionRef.current = id;
    setDraftSessionId(id);
    if (title) setActiveTitle(title);
    if (cached) {
      onLoadMessagesRef.current?.(cached);
      // The boot cache is on screen for this session: a restoreSession for
      // the same session must rehydrate silently instead of spinning the
      // blocking "Loading history..." bar over visible content.
    }
    return id;
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    // Paint the last known chat list from the phone at once; the server
    // list replaces it whenever it arrives.
    void loadSessionList<SessionRow>().then(rows => {
      if (mountedRef.current && rows.length) setSessions(prev => (prev.length ? prev : visibleChatSessions(rows)));
    });
    return () => {
      mountedRef.current = false;
      resumeLockRef.current = false;
    };
  }, []);

  // Request-generation guards: slow responses from older requests must never overwrite a newer chat
  const sessionRequestGenRef = useRef(0);
  // Which generation owns the loadingSession flag. Tracked separately from
  // sessionRequestGenRef: attachSession/newChat bump the generation without
  // ever setting the flag, and must not steal its clear path.
  const loadingSessionOwnerRef = useRef<number | null>(null);
  // Which durable session id had its boot cache rendered on screen.
  // restoreSession skips the blocking "Loading history..." bar for that
  // session and rehydrates silently in the background instead.
  const cacheRenderedForRef = useRef<string>("");
  // A restore is currently in flight. A reconnect racing it must not start
  // a duplicate 200-message rehydrate; the in-flight restore is bounded by
  // the 15s resume + 20s fetch timeouts and merges when it lands.
  const restoreInflightRef = useRef(false);
  // Which gateway the in-flight restore belongs to. Every reconnect creates a
  // new gateway object, so identity tracks the socket generation. A restore
  // left in-flight on a dead gateway can never complete (its RPCs fail with
  // the socket) and must not block a fresh restore on the live one.
  const restoreGwRef = useRef<GatewayClient | null>(null);
  const sessionsListGenRef = useRef(0);
  const modelOptionsGenRef = useRef(0);

  // Mirrors for async callbacks that must read current values, not stale closures.
  const modelRef = useRef("");
  useEffect(() => { modelRef.current = model; }, [model]);
  const titleRef = useRef("");
  useEffect(() => { titleRef.current = activeTitle; }, [activeTitle]);
  const modelOptionsRef = useRef<any | null>(null);
  const modelOptionsInflightRef = useRef<Promise<any> | null>(null);
  const applyingDefaultRef = useRef(false);
  // Self refs so failure handlers can point the retry banner at these actions.
  const resumeSessionRef = useRef<(row: SessionRow) => Promise<void>>(() => Promise.resolve());
  const restoreSessionRef = useRef<(ticketBundle?: TicketBundle) => Promise<void>>(() => Promise.resolve());
  const newChatRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Sync activeSessionRef for socket session gate
  useEffect(() => {
    if (activeSessionRef) {
      activeSessionRef.current = activeSession;
    }
  }, [activeSession, activeSessionRef]);

  // Persist last active session across cold launches
  useEffect(() => {
    if (activeSession) {
      void SecureStore.setItemAsync("hermes.m.activeSession", activeSession).catch(() => {});
    }
  }, [activeSession]);

  // Keep callback refs stable to avoid churning action callbacks
  const onResetChatRef = useRef(onResetChat);
  useEffect(() => {
    onResetChatRef.current = onResetChat;
  }, [onResetChat]);

  const onLoadMessagesRef = useRef(onLoadMessages);
  useEffect(() => {
    onLoadMessagesRef.current = onLoadMessages;
  }, [onLoadMessages]);

  const onSyncMessagesRef = useRef(onSyncMessages);
  useEffect(() => {
    onSyncMessagesRef.current = onSyncMessages;
  }, [onSyncMessages]);

  const onSetBusyRef = useRef(onSetBusy);
  useEffect(() => {
    onSetBusyRef.current = onSetBusy;
  }, [onSetBusy]);

  const onSetToolActivityRef = useRef(onSetToolActivity);
  useEffect(() => {
    onSetToolActivityRef.current = onSetToolActivity;
  }, [onSetToolActivity]);

  const onErrorMessageRef = useRef(onErrorMessage);
  useEffect(() => {
    onErrorMessageRef.current = onErrorMessage;
  }, [onErrorMessage]);

  const onBeforeSwitchRef = useRef(onBeforeSwitch);
  useEffect(() => {
    onBeforeSwitchRef.current = onBeforeSwitch;
  }, [onBeforeSwitch]);

  const onCheckTailRef = useRef(onCheckTail);
  useEffect(() => {
    onCheckTailRef.current = onCheckTail;
  }, [onCheckTail]);

  // Drawer filter with strict archive exclusion: drawer never shows archived sessions
  const filteredSessions = useMemo(() => {
    return visibleChatSessions(sessions)
      .filter((row) =>
        (row.title || row.display_name || row.id)
          .toLowerCase()
          .includes(sessionFilter.toLowerCase()),
      );
  }, [sessions, sessionFilter]);

  const loadSessions = useCallback(async () => {
    const gen = ++sessionsListGenRef.current;
    try {
      const d = await fetchJSON<{ sessions: SessionRow[] }>(
        "/api/sessions?limit=30&offset=0&order=recent&archived=exclude&exclude_sources=oneshot",
      );
      if (!mountedRef.current || gen !== sessionsListGenRef.current) return;
      // Archive exclusion: drawer never shows archived sessions
      const activeRows = visibleChatSessions(d.sessions ?? []);
      setSessions(activeRows);
      saveSessionList(activeRows);
    } catch {}
  }, []);

  const onRefreshSessions = useCallback(async () => {
    setRefreshingSessions(true);
    try {
      await loadSessions();
    } finally {
      if (mountedRef.current) {
        setRefreshingSessions(false);
      }
    }
  }, [loadSessions]);

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    void loadSessions();
  }, [loadSessions]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  const openPicker = useCallback(async () => {
    setPickerOpen(true);
    setExpandedProv({});
    if (!modelOptions) {
      const gen = ++modelOptionsGenRef.current;
      try {
        const d = await fetchJSON<any>("/api/model/options?include_unconfigured=1");
        if (mountedRef.current && gen === modelOptionsGenRef.current) {
          modelOptionsRef.current = d;
          setModelOptions(d);
        }
      } catch (e) {
        // Previously swallowed: a 503 (backend running stale code) or a 401 showed an
        // empty picker with no explanation. Say what actually went wrong.
        if (mountedRef.current && gen === modelOptionsGenRef.current) {
          onErrorMessageRef.current?.(`Couldn't load models: ${(e as Error).message}`);
        }
      }
    }
  }, [modelOptions]);

  const closePicker = useCallback(() => {
    setPickerOpen(false);
  }, []);

  // Model switch contract (backend tui_gateway/methods_config_set._set_model):
  //  - a pick made while a turn is streaming is STASHED and applied at the next turn start
  //    (response carries `deferred: true`);
  //  - an expensive / contributor-tier model answers `confirm_required` + `confirm_message`
  //    and applies NOTHING until the client re-sends with `confirm_expensive_model: true`.
  // Both cases used to be swallowed here, so the chip repainted while the backend kept the
  // old model. Round-trip the confirm, paint only what the backend accepted, and surface
  // real errors instead of failing silently.
  const switchModel = useCallback(
    async (provSlug: string, mdl: string) => {
      const gw = gwRef.current;
      if (!gw) {
        onErrorMessageRef.current?.("Not connected to the mini — can't switch model.");
        return;
      }
      setSwitching(true);
      // The backend validates a bare/slash model against the SESSION's pinned provider, so a
      // cross-provider pick sent as `provider/model` is rejected with 5001
      // ("not found in this provider's model listing"). The `--provider` flag form is the one
      // shape that changes provider AND model in a single config.set, and it also works
      // same-provider (verified against the live gateway).
      const modelPart =
        mdl.includes("/") && provSlug === "openrouter" ? `openrouter/${mdl}` : mdl;
      const targetValue = `${modelPart} --provider ${provSlug}`;
      const targetSid = activeSession;
      // The live runtime id is what config.set resolves against; fall back to the stored id.
      const sid = targetSid || storedSessionRef.current || "";
      try {
        let res = await gw.request<{
          value?: string;
          confirm_required?: boolean;
          confirm_message?: string;
          deferred?: boolean;
          warning?: string;
        }>("config.set", { key: "model", session_id: sid, value: targetValue }, 60000);

        if (res?.confirm_required) {
          if (!mountedRef.current || (activeSessionRef && activeSessionRef.current !== targetSid)) return;
          const accepted = await new Promise<boolean>((resolve) => {
            Alert.alert(
              "Confirm model cost",
              res.confirm_message || "This model may cost more. Switch models?",
              [
                { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
                { text: "Switch model", onPress: () => resolve(true) },
              ],
              { cancelable: true, onDismiss: () => resolve(false) },
            );
          });
          if (!accepted || !mountedRef.current) return;
          if (activeSessionRef && activeSessionRef.current !== targetSid) return;
          res = await gw.request("config.set", {
            key: "model",
            session_id: sid,
            value: targetValue,
            confirm_expensive_model: true,
          }, 60000);
        }

        if (!mountedRef.current) return;
        if (activeSessionRef && activeSessionRef.current !== targetSid) return;

        // Paint the backend-accepted value, not the local pick.
        const applied = String(res?.value || targetValue);
        const appliedModel = applied.includes("/") ? applied.split("/").slice(1).join("/") : applied;
        const appliedProv = applied.includes("/") ? applied.split("/")[0] : provSlug;
        setModel(appliedModel);
        setProvider(appliedProv);
        setPickerOpen(false);
        if (res?.deferred) {
          onErrorMessageRef.current?.("Model switch queued — it applies at the start of the next turn.");
        }
      } catch (e) {
        if (mountedRef.current) {
          onErrorMessageRef.current?.(`Model switch failed: ${(e as Error).message}`);
        }
      } finally {
        if (mountedRef.current) setSwitching(false);
      }
    },
    [activeSession, activeSessionRef, gwRef],
  );

  // Model options fetch shared by the picker and the auto-default: one
  // in-flight request, cached afterwards.
  const ensureModelOptions = useCallback(async (): Promise<any> => {
    if (modelOptionsRef.current) return modelOptionsRef.current;
    if (!modelOptionsInflightRef.current) {
      modelOptionsInflightRef.current = (async () => {
        try {
          const d = await fetchJSON<any>("/api/model/options?include_unconfigured=1");
          if (mountedRef.current) {
            modelOptionsRef.current = d;
            setModelOptions(d);
          }
          return d;
        } finally {
          modelOptionsInflightRef.current = null;
        }
      })();
    }
    return modelOptionsInflightRef.current;
  }, []);

  // A session with no backend model is a dead end: the header begs "Choose a
  // model" and a send can strand the turn on "Thinking…" forever. Resolve the
  // persisted default (most-recent pick, then favorite, else the first listed
  // model) and apply it to the session so there is always a selected model.
  // Never blocks: failures leave the picker one tap away. An expensive model
  // may still raise the backend's one-time cost confirm via switchModel.
  const applyDefaultModel = useCallback(
    async (prefs: ModelPrefs): Promise<ModelRef | null> => {
      if (modelRef.current || applyingDefaultRef.current) return null;
      const gw = gwRef.current;
      if (!gw || gw.state !== "open") return null;
      applyingDefaultRef.current = true;
      try {
        const d = await ensureModelOptions().catch(() => null);
        const providers = d?.providers?.filter((p: any) => (p?.models?.length ?? 0) > 0) ?? [];
        const resolved = resolveDefaultModel(prefs, providers);
        if (!resolved || modelRef.current) return null;
        await switchModel(resolved.provider, resolved.model);
        return resolved;
      } catch {
        return null;
      } finally {
        applyingDefaultRef.current = false;
      }
    },
    [ensureModelOptions, switchModel],
  );

  const resumeSession = useCallback(
    async (row: SessionRow) => {
      // Immediate lock: block concurrent calls immediately before next render
      if (resumeLockRef.current) return;
      resumeLockRef.current = true;

      const gen = ++sessionRequestGenRef.current;

      let resumedRunning = false;
      try {
        setDrawerOpen(false);
        setLoadingSession(true);
        loadingSessionOwnerRef.current = gen;
        setLoadError(null);

        // KEY RISK: Model/provider are shared by the header label AND the session store.
        // When you switch chats, the store must clear them and re-query.
        setModel("");
        setProvider("");

        onBeforeSwitchRef.current?.();

        const sid = row.id;
        const title = row.title || row.display_name || "Hermes";
        // Selecting a row retires the previous live send target immediately.
        // A failed resume must never leave this new title pointing at the old chat.
        if (activeSessionRef) activeSessionRef.current = "";
        setActiveSession("");
        storedSessionRef.current = sid;
        setDraftSessionId(sid);
        onResetChatRef.current?.();
        onLoadMessagesRef.current?.([]);
        setActiveTitle(title);
        // The SecureStore snapshot is the only cache now; it carries stable
        // srv: ids, so the REST merge below correlates instead of replacing.
        const cached = await loadTranscript(sid).catch(() => null);
        if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;
        if (cached) onLoadMessagesRef.current?.(cached);
        await SecureStore.setItemAsync(SELECTION_KEY, JSON.stringify({ sessionId: sid, title }));
        await SecureStore.setItemAsync("hermes.m.storedSession", sid);
        await SecureStore.deleteItemAsync("hermes.m.activeSession");
        await SecureStore.setItemAsync("hermes.m.activeTitle", title);
        if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;

        // The previous transcript was retired before storage or network work.
        const gw = gwRef.current;
        if (!gw) {
          setLoadingSession(false);
          loadingSessionOwnerRef.current = null;
          return;
        }

        // Loading a transcript is not an agent turn. The composer stays usable.
        const res = await gw.request<{
          session_id?: string;
          stored_session_id?: string;
          running?: boolean;
          status?: string;
          info?: { model?: string; provider?: string };
        }>("session.resume", { session_id: sid, cols: 80, omit_messages: true, defer_history: true, inline_images: false }, 15000);

        if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;

        // The stored_session_id vs session_id split (live id for prompt.submit, stored id for REST history)
        resumedRunning = res?.running === true || res?.status === "streaming";
        const liveSid = res?.session_id || sid;
        if (activeSessionRef) activeSessionRef.current = liveSid;
        setActiveSession(liveSid);
        // Apply this snapshot before history I/O. Later live events own reply state.
        onSetBusyRef.current?.(resumedRunning);
        void SecureStore.setItemAsync("hermes.m.activeSession", liveSid).catch(() => {});

        const storedId = res?.stored_session_id || sid;
        storedSessionRef.current = storedId;
        setDraftSessionId(storedId);
        // Persist the durable id. A live runtime id can disappear across app reloads.
        void SecureStore.setItemAsync("hermes.m.storedSession", storedId).catch(() => {});

        // Backend model truth on resume: re-query info.model/info.provider and fall back to GET /api/sessions/{id}
        try {
          let liveModel = res?.info?.model;
          let liveProvider = res?.info?.provider;
          if (!liveModel || !liveProvider) {
            const s = await fetchJSON<{ model?: string; provider?: string; billing_provider?: string }>(
              `/api/sessions/${encodeURIComponent(storedId)}`,
            );
            if (!liveModel && s?.model) liveModel = s.model;
            if (!liveProvider && (s?.provider || s?.billing_provider)) {
              liveProvider = s.provider || s.billing_provider;
            }
          }
          if (mountedRef.current && gen === sessionRequestGenRef.current) {
            if (liveModel) setModel(String(liveModel));
            if (liveProvider) setProvider(String(liveProvider));
          }
        } catch {}

        if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;

        // Fetch messages for stored session (latest 200 messages so recent turns are visible)
        const d = await fetchJSON<{ messages?: any[] }>(
          `/api/sessions/${encodeURIComponent(storedId)}/messages?limit=200&order=latest`
        );
        if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;
        const hist: Msg[] = mapServerMessages(d.messages ?? []);
        onSyncMessagesRef.current?.(hist, liveSid);
        void saveTranscript(storedId, hist).catch(() => {});
      } catch (e) {
        if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;
        // History/load failures become an error banner with a retry that
        // re-runs this bounded resume — never an error row, never a dead
        // screen. Drafts live in SecureStore and survive the switch untouched.
        const sid = storedSessionRef.current;
        loadRetryRef.current = () =>
          resumeSessionRef.current({ id: sid, title: titleRef.current || "Hermes" });
        setLoadError(`Couldn't load this chat (${(e as Error).message}). Tap Retry to try again.`);
      } finally {
        resumeLockRef.current = false;
        if (mountedRef.current && loadingSessionOwnerRef.current === gen) {
          setLoadingSession(false);
          loadingSessionOwnerRef.current = null;
        }
      }
    },
    [gwRef, activeSessionRef],
  );
  resumeSessionRef.current = resumeSession;

  const newChat = useCallback(async () => {
    resumeLockRef.current = false;
    const gw = gwRef.current;
    if (!gw) return;

    const gen = ++sessionRequestGenRef.current;

    onBeforeSwitchRef.current?.();
    onResetChatRef.current?.();

    // KEY RISK: Clear model and provider on new chat
    setActiveSession("");
    setActiveTitle("");
    setModel("");
    setProvider("");
    if (activeSessionRef) activeSessionRef.current = "";

    await SecureStore.setItemAsync(SELECTION_KEY, JSON.stringify({ sessionId: "", title: "" })).catch(() => {});
    await SecureStore.deleteItemAsync("hermes.m.activeSession").catch(() => {});
    await SecureStore.deleteItemAsync("hermes.m.storedSession").catch(() => {});
    await SecureStore.deleteItemAsync("hermes.m.activeTitle").catch(() => {});
    storedSessionRef.current = "";
    setDraftSessionId("");

    try {
      const res = await gw.request<{ session_id: string; stored_session_id?: string }>("session.create", {
        source: "tool",
      }, 15000);
      if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;
      const newSid = res?.session_id ?? "";
      setActiveSession(newSid);
      storedSessionRef.current = res?.stored_session_id || newSid;
      setDraftSessionId(storedSessionRef.current);
      if (activeSessionRef) activeSessionRef.current = newSid;
      await SecureStore.setItemAsync(SELECTION_KEY, JSON.stringify({ sessionId: storedSessionRef.current, title: "" }));
    } catch (e) {
      // A failed create must not leave an empty, unexplained screen.
      if (mountedRef.current && gen === sessionRequestGenRef.current) {
        loadRetryRef.current = () => newChatRef.current();
        setLoadError(`Couldn't start a new chat (${(e as Error).message}). Tap Retry to try again.`);
      }
    }
  }, [gwRef, activeSessionRef]);
  newChatRef.current = newChat;

  const restoreSession = useCallback(async (ticketBundle?: TicketBundle) => {
    const gw = gwRef.current;
    if (!gw) return;

    // Never stack restores on the same socket: a reconnect racing an in-flight
    // restore must not start a duplicate 200-message rehydrate with its own
    // spinner. But if the gateway changed (a real reconnect), the in-flight
    // restore is on a dead socket and can never complete — let the fresh
    // restore proceed instead of stranding the app with no active session and
    // no retry until the next socket drop.
    if (restoreInflightRef.current && restoreGwRef.current === gwRef.current) return;
    restoreInflightRef.current = true;
    restoreGwRef.current = gwRef.current;

    const gen = ++sessionRequestGenRef.current;
    // Hard watchdog: restore must never hang forever. All inner RPCs have
    // 15-20s timeouts; if still here after 45s, something is stuck.
    // Force-clear the lock and spinner so the app stays usable.
    // Guarded for environments without timers (e.g., unit test VMs).
    const watchdog = typeof setTimeout !== "undefined" ? setTimeout(() => {
      if (restoreGwRef.current === gwRef.current) {
        restoreGwRef.current = null;
        restoreInflightRef.current = false;
      }
      if (loadingSessionOwnerRef.current === gen) {
        setLoadingSession(false);
        loadingSessionOwnerRef.current = null;
      }
    }, 45000) : null;
    // Cold boot: try to reattach to the last active chat
    const { sessionId: lastSid, title: savedTitle } = await readSelection();
    // The boot cache is already on screen for this session: run the network
    // rehydrate silently in the background and merge when it arrives. With
    // no cache (first run ever, or a cache miss) keep the loading bar.
    const silentRehydrate = !!lastSid && lastSid === cacheRenderedForRef.current;
    if (!silentRehydrate) {
      // Restoring is real in-flight work: name it instead of leaving the
      // transcript silently stale while the resume runs.
      setLoadingSession(true);
      loadingSessionOwnerRef.current = gen;
    }
    setLoadError(null);

    // Shared downstream of a session.resume result: live target, durable
    // pointer, model/provider snapshot. Used verbatim by the inline fast
    // path and the resume-RPC slow path below. Returns null when this
    // generation went stale -- callers stop, like the inline gen checks.
    const applyResumed = async (
      res:
        | {
            session_id?: string;
            stored_session_id?: string;
            messages?: any[];
            info?: { model?: string; provider?: string };
          }
        | undefined,
      fallbackSid: string,
    ): Promise<{ liveSid: string; storedId: string } | null> => {
      if (!mountedRef.current || gen !== sessionRequestGenRef.current) return null;
      const liveSid = res?.session_id || fallbackSid;
      if (activeSessionRef) activeSessionRef.current = liveSid;
      setActiveSession(liveSid);

      const storedId = res?.stored_session_id || fallbackSid;
      storedSessionRef.current = storedId;
      setDraftSessionId(storedId);
      void SecureStore.setItemAsync("hermes.m.storedSession", storedId).catch(() => {});

      // Backend model truth on resume
      try {
        let liveModel = res?.info?.model;
        let liveProvider = res?.info?.provider;
        if (!liveModel || !liveProvider) {
          const s = await fetchJSON<{ model?: string; provider?: string; billing_provider?: string }>(
            `/api/sessions/${encodeURIComponent(storedId)}`,
          );
          if (!liveModel && s?.model) liveModel = s.model;
          if (!liveProvider && (s?.provider || s?.billing_provider)) {
            liveProvider = s.provider || s.billing_provider;
          }
        }
        if (mountedRef.current && gen === sessionRequestGenRef.current) {
          if (liveModel) setModel(String(liveModel));
          if (liveProvider) setProvider(String(liveProvider));
        }
      } catch {}

      if (!mountedRef.current || gen !== sessionRequestGenRef.current) return null;
      return { liveSid, storedId };
    };

    try {
    if (lastSid) storedSessionRef.current = lastSid;
    if (savedTitle && mountedRef.current && gen === sessionRequestGenRef.current) {
      setActiveTitle(savedTitle);
    }

    if (lastSid) {
      // Fast path: the ticket mint already ran session.resume inline, so the
      // resume RPC is skipped. The inline result is consumed exactly as if
      // gw.request("session.resume") had returned it. The ticket itself is
      // not session-bound, so the inline resume is only trusted when it was
      // minted for THIS session (forSessionId gate); otherwise the slow path
      // below runs byte-identical to before.
      const inline =
        ticketBundle?.forSessionId === lastSid ? ticketBundle?.sessionResume?.result : undefined;
      if (inline && !inline.error) {
        const applied = await applyResumed(inline, lastSid);
        if (!applied) return;
        // The inline session is parked server-side with an orphan-reap
        // grace: attach a transport to it NOW -- prompt.submit's
        // steer-authority check and server->client event routing require an
        // attached transport, so the activate is not optional. Fire it in
        // parallel with the tail fetch: storedId is already known from the
        // inline result, so no sequencing is needed.
        const activateP = gw.request(
          "session.activate",
          { session_id: applied.liveSid, omit_messages: true },
          15000,
        );
        const tailP = fetchJSON<{ messages?: any[] }>(
          `/api/sessions/${encodeURIComponent(applied.storedId)}/messages?limit=200&order=latest`,
        );
        let activateFailed = false;
        try {
          const actRes = (await activateP) as { error?: unknown } | undefined;
          // gw.request rejects on a JSON-RPC error; the error check is a
          // backstop for a refusal delivered as a resolved payload.
          if (actRes?.error) activateFailed = true;
        } catch {
          // Reaped while parked (or a dead socket): fall through to the
          // full resume RPC, which re-resumes from the DB.
          activateFailed = true;
        }
        if (!activateFailed) {
          if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;
          try {
            const d = await tailP;
            if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;
            const hist: Msg[] = mapServerMessages(d.messages ?? []);
            onSyncMessagesRef.current?.(hist, applied.liveSid);
            void saveTranscript(applied.storedId, hist).catch(() => {});
            return;
          } catch {
            // The live session is attached but its history didn't load. Say so
            // with a retry instead of leaving a silently empty transcript.
            loadRetryRef.current = () => restoreSessionRef.current();
            setLoadError("Connected, but the message history didn't load. Tap Retry to reload it.");
            return;
          }
        }
        // The orphaned parallel tail is dropped: the slow path below
        // refetches it sequentially after the resume RPC.
        tailP.catch(() => {});
        console.warn("inline resume: session.activate failed; falling back to session.resume RPC");
      }
      try {
        const res = await gw.request<{
          session_id?: string;
          stored_session_id?: string;
          messages?: any[];
          info?: { model?: string; provider?: string };
        }>("session.resume", { session_id: lastSid, cols: 80, omit_messages: true, defer_history: true, inline_images: false }, 15000);

        const applied = await applyResumed(res, lastSid);
        if (!applied) return;

        try {
          const d = await fetchJSON<{ messages?: any[] }>(
            `/api/sessions/${encodeURIComponent(applied.storedId)}/messages?limit=200&order=latest`
          );
          if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;
          const hist: Msg[] = mapServerMessages(d.messages ?? []);
          onSyncMessagesRef.current?.(hist, applied.liveSid);
          void saveTranscript(applied.storedId, hist).catch(() => {});
          return;
        } catch {
          // The live session is attached but its history didn't load. Say so
          // with a retry instead of leaving a silently empty transcript.
          loadRetryRef.current = () => restoreSessionRef.current();
          setLoadError("Connected, but the message history didn't load. Tap Retry to reload it.");
          return;
        }
      } catch (err) {
        if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;
        // Tell the user why their chat was replaced instead of swapping it out
        // silently: another surface owning it is a normal, explainable state.
        const reason = err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err ?? "");
        // A timeout, busy backend, or one-writer refusal is not proof that
        // the saved chat is gone. Keep its durable pointer and title so a later
        // connection can retry; only a confirmed expired/missing session may
        // be replaced. Do not expose raw gateway errors in the transcript.
        if (!/^session (?:expired|not found)(?:\.|$)/i.test(reason.trim())) {
          setDraftSessionId(lastSid);
          // A failed restore is an error state with a retry, not an error
          // row: the durable pointer and title are kept for the retry.
          loadRetryRef.current = () => restoreSessionRef.current();
          setLoadError(
            isSessionFencedElsewhere(reason)
              ? reason
              : "Couldn't restore your last chat. It is still saved — tap Retry to try again.",
          );
          return;
        }
        // Clear both pointers so a confirmed invalid durable id cannot override
        // the replacement on the next cold launch.
        storedSessionRef.current = "";
        setDraftSessionId("");
        await SecureStore.setItemAsync(SELECTION_KEY, JSON.stringify({ sessionId: "", title: "" }));
        await SecureStore.deleteItemAsync("hermes.m.storedSession").catch(() => {});
        await SecureStore.deleteItemAsync("hermes.m.activeSession").catch(() => {});
        await SecureStore.deleteItemAsync("hermes.m.activeTitle").catch(() => {});
        if (mountedRef.current && gen === sessionRequestGenRef.current) setActiveTitle("");
      }
    }

    if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;

    // Seamless fallback to a fresh session if no previous session or resume failed
    const res = await gw.request<{ session_id: string; stored_session_id?: string }>("session.create", {
      source: "tool",
    }, 15000);
    if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;
    const newSid = res?.session_id ?? "";
    setActiveSession(newSid);
    if (activeSessionRef) activeSessionRef.current = newSid;
    storedSessionRef.current = res?.stored_session_id || newSid;
    setDraftSessionId(storedSessionRef.current);
    if (newSid) {
      await SecureStore.setItemAsync(SELECTION_KEY, JSON.stringify({ sessionId: storedSessionRef.current, title: "" }));
      await SecureStore.setItemAsync("hermes.m.activeSession", newSid);
      await SecureStore.setItemAsync("hermes.m.storedSession", storedSessionRef.current);
    }
    } finally {
      if (watchdog && typeof clearTimeout !== "undefined") clearTimeout(watchdog);
      // Only release the lock if we still own it: a newer restore on a fresh
      // socket may have taken over while this one was dying on the old one.
      if (restoreGwRef.current === gw) restoreInflightRef.current = false;
      if (mountedRef.current && loadingSessionOwnerRef.current === gen) {
        setLoadingSession(false);
        loadingSessionOwnerRef.current = null;
      }
    }
  }, [gwRef, activeSessionRef]);
  restoreSessionRef.current = restoreSession;

  const attachSession = useCallback(async (ticketBundle?: TicketBundle) => {
    onSetToolActivityRef.current?.("");
    const sid = activeSessionRef?.current || activeSession;
    if (!sid) return;

    const gw = gwRef.current;
    if (!gw) return;

    const gen = ++sessionRequestGenRef.current;
    let storedId = storedSessionRef.current || sid;

    // Shared downstream of a session.resume result: live target, durable
    // pointer, model/provider, busy reset. Null when this generation went
    // stale.
    const applyResumed = (
      r:
        | {
            session_id?: string;
            stored_session_id?: string;
            running?: boolean;
            status?: string;
            info?: { model?: string; provider?: string };
          }
        | undefined,
    ): { liveSid: string; storedId: string } | null => {
      if (!mountedRef.current || gen !== sessionRequestGenRef.current) return null;
      const liveSid = r?.session_id || sid;
      storedId = r?.stored_session_id || storedSessionRef.current || sid;
      storedSessionRef.current = storedId;
      setDraftSessionId(storedId);
      if (r?.session_id) {
        if (activeSessionRef) activeSessionRef.current = liveSid;
        setActiveSession(liveSid);
      }
      if (r?.info?.model) setModel(String(r.info.model));
      if (r?.info?.provider) setProvider(String(r.info.provider));
      if (r?.running !== true) {
        onSetBusyRef.current?.(false);
        onSetToolActivityRef.current?.("");
      }
      return { liveSid, storedId };
    };

    // Fast path: the ticket mint already ran session.resume inline, so the
    // resume RPC is skipped. The ticket itself is not session-bound, so the
    // inline resume is only trusted when it was minted for THIS session.
    // The mint used the durable id while sid is the live target -- accept a
    // match against either (both identify this chat; they are updated
    // together on every switch/restore). Anything else means the bundle is
    // for another chat and the slow path below runs byte-identical to before.
    const inline =
      ticketBundle?.forSessionId === sid || ticketBundle?.forSessionId === storedSessionRef.current
        ? ticketBundle?.sessionResume?.result
        : undefined;
    if (inline && !inline.error) {
      const applied = applyResumed(inline);
      if (!applied) return;
      // The inline session is parked server-side with an orphan-reap grace:
      // attach a transport to it NOW -- prompt.submit's steer-authority
      // check and server->client event routing require an attached
      // transport, so the activate is not optional. Fire it in parallel with
      // the tail fetch: storedId is already known from the inline result.
      const activateP = gw.request(
        "session.activate",
        { session_id: applied.liveSid, omit_messages: true },
        15000,
      );
      const tailP = fetchJSON<{ messages?: any[] }>(
        `/api/sessions/${encodeURIComponent(applied.storedId)}/messages?limit=40&order=latest`,
      );
      let activateFailed = false;
      try {
        const actRes = (await activateP) as { error?: unknown } | undefined;
        // gw.request rejects on a JSON-RPC error; the error check is a
        // backstop for a refusal delivered as a resolved payload.
        if (actRes?.error) activateFailed = true;
      } catch {
        // Reaped while parked (or a dead socket): fall through to the full
        // resume RPC, which re-resumes from the DB.
        activateFailed = true;
      }
      if (!activateFailed) {
        if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;
        try {
          const d = await tailP;
          if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;
          const tail: Msg[] = mapServerMessages(d.messages ?? []);
          onCheckTailRef.current?.(tail, sid);
        } catch {}
        return;
      }
      // The orphaned parallel tail is dropped: the slow path below refetches
      // it sequentially after the resume RPC.
      tailP.catch(() => {});
      console.warn("inline resume: session.activate failed; falling back to session.resume RPC");
    }

    // Verify-first: reattach through session.resume so a dead or rotated
    // live session is proven before anything paints from it.
    // omit_messages: tail arrives via REST below.
    try {
      const r = await gw.request<{
        session_id?: string;
        stored_session_id?: string;
        running?: boolean;
        status?: string;
        info?: { model?: string; provider?: string };
      }>("session.resume", { session_id: sid, cols: 80, omit_messages: true, defer_history: true, inline_images: false }, 15000);

      if (!applyResumed(r)) return;
    } catch {}

    if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;

    try {
      const d = await fetchJSON<{ messages?: any[] }>(
        `/api/sessions/${encodeURIComponent(storedId)}/messages?limit=40&order=latest`,
      );
      if (!mountedRef.current || gen !== sessionRequestGenRef.current) return;
      const tail: Msg[] = mapServerMessages(d.messages ?? []);
      onCheckTailRef.current?.(tail, sid);
    } catch {}
  }, [activeSession, activeSessionRef, gwRef]);

  const refreshTail = useCallback(async () => {
    const gen = sessionRequestGenRef.current;
    const sid = activeSessionRef?.current || activeSession;
    const storedId = storedSessionRef.current;
    if (!sid || !storedId) return;
    try {
      const d = await fetchJSON<{ messages?: any[] }>(
        `/api/sessions/${encodeURIComponent(storedId)}/messages?limit=200&order=latest`,
      );
      if (!mountedRef.current || gen !== sessionRequestGenRef.current ||
          storedSessionRef.current !== storedId || (activeSessionRef?.current || activeSession) !== sid) return;
      const hist: Msg[] = mapServerMessages(d.messages ?? []);
      if (hist.length) {
        onCheckTailRef.current?.(hist, sid);
        void saveTranscript(storedId, hist).catch(() => {});
      }
    } catch { /* Keep the visible chat on a transient REST failure. */ }
  }, [activeSession, activeSessionRef]);

  return {
    activeSession,
    draftSessionId,
    activeTitle,
    sessions,
    filteredSessions,
    model,
    provider,
    loadingSession,
    drawerOpen,
    sessionFilter,
    refreshingSessions,
    modelOptions,
    pickerOpen,
    expandedProv,
    switching,
    setActiveSession,
    setActiveTitle,
    setSessions,
    setModel,
    setProvider,
    setDrawerOpen,
    setSessionFilter,
    setPickerOpen,
    setExpandedProv,
    loadSessions,
    onRefreshSessions,
    openDrawer,
    closeDrawer,
    resumeSession,
    newChat,
    switchModel,
    openPicker,
    closePicker,
    restoreSession,
    applyDefaultModel,
    loadError,
    retryLoad,
    showCachedSession,
    getStoredSessionId: () => storedSessionRef.current,
    attachSession,
    refreshTail,
  };
}

export default useSessionStore;
