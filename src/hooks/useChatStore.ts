import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isSessionFencedElsewhere, fenceNotice } from "../lib/sessionFence";

// Lazy diag access (see gateway.ts): keeps this module loadable in the node
// vm tests while never breaking the hot path if the logger is unavailable.
let diagMod: { diagLog: (k: string, d?: unknown) => void; maybeUploadDiag: () => void } | undefined;
function diagHooks(): { diagLog: (k: string, d?: unknown) => void; maybeUploadDiag: () => void } {
  try {
    if (!diagMod) {
      const l = require("../lib/diagLog");
      const u = require("../lib/diagUpload");
      diagMod = { diagLog: l.diagLog, maybeUploadDiag: u.maybeUploadDiag };
    }
    return diagMod;
  } catch {
    return { diagLog: () => {}, maybeUploadDiag: () => {} };
  }
}
function diag(kind: string, detail?: unknown): void {
  diagHooks().diagLog(kind, detail);
}
function uploadDiag(): void {
  diagHooks().maybeUploadDiag();
}

export type Msg = {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  streaming?: boolean;
  images?: string[]; // file:// URIs for user bubbles
  thinking?: string;
  tools?: string[];
  /** Set while this user turn's submit is in flight. Renders inline as a
   *  subtle sending state with a non-color cue; cleared on ack, replaced
   *  by sendFailed on a pre-submit failure. Never participates in
   *  mergeServerRows reconciliation keys, so it cannot break absorption
   *  by the server canon row. */
  sending?: boolean;
  /** Set when this user turn failed before submission. Renders inline on the
   *  bubble with tap-to-retry; the text is kept, never dropped. */
  sendFailed?: boolean;
  sendError?: string;
};

let uidCounter = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++uidCounter}`;

// Keep the in-memory transcript bounded — very long chats must not grow
// the FlatList without limit on a phone.
export const MAX_MESSAGES = 300;
export function capMessages(msgs: Msg[]): Msg[] {
  return msgs.length > MAX_MESSAGES ? msgs.slice(msgs.length - MAX_MESSAGES) : msgs;
}

// Stable server identity: the backend's integer row id is monotonic insertion
// order and stable across resume lineage, so it becomes the client message id.
// Every rehydrate then correlates rows instead of minting fresh ids and
// blindly replacing the whole list (which remounted every bubble and broke
// in-flight streaming state).
export const SERVER_ID_PREFIX = "srv:";

/** Numeric server row id for `srv:<id>` rows; null for client-minted ids. */
function serverRowId(id: string): number | null {
  if (!id.startsWith(SERVER_ID_PREFIX)) return null;
  const n = parseInt(id.slice(SERVER_ID_PREFIX.length), 10);
  return Number.isNaN(n) ? null : n;
}

/** Stable row ids the server reports for a committed turn
 *  (message.complete's persisted_turn). Absent on failed/unpersisted turns. */
export type PersistedTurnReceipt = {
  final_assistant_row_id?: unknown;
  user_row_id?: unknown;
};

/** Map REST history rows to messages with stable server ids. A row that
 *  somehow lacks the server id falls back to a client-minted id — defensive
 *  only; such a row can never correlate across rehydrates. */
export function mapServerMessages(raw: any[]): Msg[] {
  return (raw ?? [])
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant"))
    .map((m: any) => ({
      id: m.id === undefined || m.id === null ? uid("h") : `${SERVER_ID_PREFIX}${m.id}`,
      role: m.role,
      text:
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c: any) => c.text ?? "").join("")
            : "",
    }));
}

/** One sync protocol: merge server truth into the local transcript instead of
 *  wholesale-replacing it.
 *  - Local `srv:` rows present in the incoming set are replaced by the fresh
 *    server rows below.
 *  - Local `srv:` rows older than the fetch window (numeric id below the
 *    minimum incoming id) are kept; the fetch only covers the latest rows.
 *  - Any other local `srv:` row is in-window but absent server-side, i.e.
 *    deleted or rewound — dropped.
 *  - Local-only rows (client-minted u-/a-/e- ids, legacy h- ids): streaming
 *    bubbles are dropped (dead socket; the busy dead-man's switch already
 *    covers the UX), rows the server already has (exact role+text match) are
 *    dropped in favor of the server canon — this absorbs the pendingSend
 *    duplicate case — and everything else (unsent pending text, error rows)
 *    is kept in its original relative order.
 *  Result order: kept older server rows, then server rows in server order,
 *  then kept local rows. Returns the original array reference when nothing
 *  changed so callers can skip the repaint. */
export function mergeServerRows(local: Msg[], server: Msg[]): Msg[] {
  const incomingIds = new Set(server.map((m) => m.id));
  let minIncoming: number | null = null;
  for (const m of server) {
    const n = serverRowId(m.id);
    if (n !== null && (minIncoming === null || n < minIncoming)) minIncoming = n;
  }
  const serverKeys = new Set(server.map((m) => `${m.role}\n${m.text}`));
  const keptOlder: Msg[] = [];
  const keptLocal: Msg[] = [];
  for (const m of local) {
    const n = serverRowId(m.id);
    if (n !== null) {
      if (incomingIds.has(m.id)) continue;
      // Older than the fetch window, or the window had no parseable ids at
      // all (empty fetch): keep conservatively rather than wiping.
      if (minIncoming === null || n < minIncoming) keptOlder.push(m);
      continue;
    }
    if (m.streaming) continue;
    // A failed send is never absorbed by a same-text server row: the server
    // cannot have this failed turn, and the bubble owns its retry state. The
    // text stays, the row stays, until the user retries or the send succeeds.
    if (m.sendFailed) {
      keptLocal.push(m);
      continue;
    }
    if (serverKeys.has(`${m.role}\n${m.text}`)) continue;
    keptLocal.push(m);
  }
  const merged = [...keptOlder, ...server, ...keptLocal];
  if (
    merged.length === local.length &&
    merged.every((m, i) => m.id === local[i].id && m.role === local[i].role && m.text === local[i].text)
  ) {
    return local;
  }
  return merged;
}

// Dead-man's switch default: while the store reports busy (the thinking pill,
// a running tool-call row, a streaming "…" bubble), any stretch this long
// with no sign of progress surfaces a visible, tap-to-retry error instead of
// hanging forever.
export const BUSY_TIMEOUT_MS = 60000;

export interface UseChatStoreOptions {
  activeSessionId?: string;
  activeSessionRef?: React.MutableRefObject<string>;
}

export interface ChatStore {
  // State
  messages: Msg[];
  reversedMessages: Msg[];
  busy: boolean;
  toolActivity: string;
  /** Names the in-flight work for the busy pill ("Sending…", "Uploading…").
   *  Empty while the pill shows the generic streaming state. */
  busyLabel: string;

  // Stable Refs
  messagesRef: React.MutableRefObject<Msg[]>;
  busyRef: React.MutableRefObject<boolean>;
  lastAssistantRef: React.MutableRefObject<string | null>;
  pendingDeltaRef: React.MutableRefObject<string>;
  thinkingBufferRef: React.MutableRefObject<string>;
  streamFlushTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;

  // Streaming Actions (stable callbacks via useCallback on stable refs)
  startStream: (id?: string, sessionId?: string) => string;
  appendDelta: (text: string, sessionId?: string, messageId?: string) => void;
  appendThinkingDelta: (text: string, sessionId?: string, messageId?: string) => void;
  appendThinking: (text: string, sessionId?: string, messageId?: string) => void;
  appendReasoningDelta: (text: string) => void;
  setReasoningAvailable: (text: string) => void;
  startTool: (name: string) => void;
  completeTool: () => void;
  finishStream: (finalText?: string, isError?: boolean, persistedTurn?: PersistedTurnReceipt) => void;
  handleError: (errorMessage?: string) => void;
  flushStream: () => void;
  scheduleStreamFlush: () => void;

  // Transcript & Control Actions (stable callbacks)
  setMessages: React.Dispatch<React.SetStateAction<Msg[]>>;
  loadMessages: (msgs: Msg[], sessionId?: string) => void;
  syncFromServer: (msgs: Msg[], sessionId?: string) => void;
  addUserMessage: (text: string, images?: string[], opts?: { sending?: boolean }) => string;
  addErrorMessage: (text: string) => string;
  clearRetryErrors: () => void;
  setRetryError: (text: string) => string;
  setBusy: (busy: boolean) => void;
  setToolActivity: (activity: string) => void;
  setBusyLabel: (label: string) => void;
  patchMessage: (id: string, fn: (m: Msg) => Msg) => void;
  interrupt: () => void;
  reset: () => void;
  patchAssistant: (fn: (m: Msg) => Msg) => void;
  findAssistantIndex: (prev: Msg[]) => number;
}

export function useChatStore(options: UseChatStoreOptions = {}): ChatStore {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusyState] = useState(false);
  const [toolActivity, setToolActivityState] = useState("");
  const [busyLabel, setBusyLabelState] = useState("");

  const reversedMessages = useMemo(
    () => capMessages([...messages]).reverse(),
    [messages],
  );

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fallbackSessionRef = useRef(options.activeSessionId || "");
  useEffect(() => {
    if (options.activeSessionId !== undefined) {
      fallbackSessionRef.current = options.activeSessionId;
    }
  }, [options.activeSessionId]);
  const activeSessionRef = options.activeSessionRef || fallbackSessionRef;

  // Mirror of messages for use inside async/socket callbacks, so they never
  // need setState-inside-updater side effects to read the latest transcript.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const lastAssistant = useRef<string | null>(null);
  const lastUserMessage = useRef<string | null>(null);

  // Throttle streaming renders: accumulate delta tokens in a buffer and
  // flush at most ~every 50ms instead of on every single token. Without
  // this, fast models fire 100+ setMessages/sec and the phone drops
  // frames on every render.
  const pendingDeltaRef = useRef("");
  const thinkingBufferRef = useRef("");
  const bufferedMessageIdRef = useRef<string | null>(null);
  const bufferedSessionIdRef = useRef<string | null>(null);
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Dead-man's switch for every loading state the store owns. Armed when
  // busy turns on, re-armed by any sign of progress, disarmed when busy
  // clears. It can never strand the UI: on expiry it clears busy and leaves
  // a tap-to-retry error row behind.
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fast assistant lookup: during streaming, the target assistant message is
  // almost always the last message in the array. Fall back to reverse scan.
  const findAssistantIndex = useCallback((prev: Msg[]) => {
    const id = lastAssistant.current;
    if (!id) return -1;
    const lastIdx = prev.length - 1;
    if (lastIdx >= 0 && prev[lastIdx].id === id && prev[lastIdx].role === "assistant") {
      return lastIdx;
    }
    for (let i = lastIdx - 1; i >= 0; i--) {
      if (prev[i].id === id && prev[i].role === "assistant") {
        return i;
      }
    }
    return -1;
  }, []);

  const patchMessage = useCallback((id: string, fn: (m: Msg) => Msg) => {
    if (!mountedRef.current || !id) return;
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = fn(prev[idx]);
      return updated;
    });
  }, []);

  const patchAssistant = useCallback((fn: (m: Msg) => Msg) => {
    if (!mountedRef.current) return;
    setMessages((prev) => {
      const targetId = lastAssistant.current;
      const targetIndex = targetId
        ? prev.findIndex((m) => m.id === targetId && m.role === "assistant")
        : -1;

      if (targetIndex !== -1) {
        const updated = [...prev];
        updated[targetIndex] = fn(prev[targetIndex]);
        return updated;
      }
      return prev;
    });
  }, []);

  const flushStream = useCallback(() => {
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    if (!mountedRef.current) return;
    const delta = pendingDeltaRef.current;
    const thinking = thinkingBufferRef.current;
    const targetMsgId = bufferedMessageIdRef.current || lastAssistant.current;
    const targetSessionId = bufferedSessionIdRef.current;

    // Reset buffer state immediately
    pendingDeltaRef.current = "";
    thinkingBufferRef.current = "";
    bufferedMessageIdRef.current = null;
    bufferedSessionIdRef.current = null;

    if (!delta && !thinking) return;

    // Session identity check: queued text must match the active session if session is tracked
    if (targetSessionId && activeSessionRef.current && targetSessionId !== activeSessionRef.current) {
      return;
    }

    // Message-id identity check: queued text must belong to a specific assistant message
    if (!targetMsgId) return;

    setMessages((prev) => {
      const targetIndex = prev.findIndex((m) => m.id === targetMsgId && m.role === "assistant");
      // If the message is not found (e.g. switched chats) or not streaming, discard the queued text
      if (targetIndex === -1) return prev;
      const target = prev[targetIndex];
      if (target.streaming === false) return prev;

      const updated = [...prev];
      updated[targetIndex] = {
        ...target,
        text: target.text + delta,
        thinking: thinking ? (target.thinking ?? "") + thinking : target.thinking,
      };
      return updated;
    });
  }, [activeSessionRef]);

  // Flush throttle: dynamic interval (25ms) so short bursts paint promptly
  // while heavy token streams never stutter the frame rate.
  const scheduleStreamFlush = useCallback(() => {
    if (streamFlushTimerRef.current) return;
    streamFlushTimerRef.current = setTimeout(flushStream, 25);
  }, [flushStream]);

  // Clean up flush timer on unmount
  useEffect(() => {
    return () => {
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      if (busyTimerRef.current) {
        clearTimeout(busyTimerRef.current);
        busyTimerRef.current = null;
      }
    };
  }, []);

  const clearBusyTimer = useCallback(() => {
    if (busyTimerRef.current) {
      clearTimeout(busyTimerRef.current);
      busyTimerRef.current = null;
    }
  }, []);

  const busyTimedOut = useCallback(() => {
    if (!mountedRef.current || !busyRef.current) return;
    busyTimerRef.current = null;
    flushStream();
    busyRef.current = false;
    setBusyState(false);
    setToolActivityState("");
    setBusyLabelState("");
    // Stop the streaming "…" on the in-flight assistant bubble, then surface
    // the stall as an error row. The word "retry" in the text is what wires
    // MessageRow's tap-to-retry and the clearRetryErrors sweep on next send.
    setMessages((prev) => {
      const targetId = lastAssistant.current;
      const next = targetId
        ? prev.map((m) => (m.id === targetId ? { ...m, streaming: false } : m))
        : prev;
      return capMessages([
        ...next,
        { id: uid("e"), role: "error", text: "Request timed out — tap to retry" },
      ]);
    });
    diag("timeout", { context: "busy_stall", busyMs: BUSY_TIMEOUT_MS });
    uploadDiag();
  }, [flushStream]);

  // Any sign of progress re-arms the countdown while busy is on.
  const pokeBusy = useCallback(() => {
    if (!mountedRef.current || !busyRef.current) return;
    clearBusyTimer();
    busyTimerRef.current = setTimeout(busyTimedOut, BUSY_TIMEOUT_MS);
  }, [busyTimedOut, clearBusyTimer]);

  const setBusy = useCallback((val: boolean) => {
    busyRef.current = val;
    setBusyState(val);
    if (val) pokeBusy();
    else clearBusyTimer();
  }, [pokeBusy, clearBusyTimer]);

  const setToolActivity = useCallback((activity: string) => {
    setToolActivityState(activity);
  }, []);

  const setBusyLabel = useCallback((label: string) => {
    if (!mountedRef.current) return;
    setBusyLabelState(label);
    pokeBusy();
  }, [pokeBusy]);

  const startStream = useCallback(
    (id?: string, sessionId?: string) => {
      if (pendingDeltaRef.current || thinkingBufferRef.current) {
        flushStream();
      }
      setBusyLabelState("");
      pokeBusy();
      const msgId = id || uid("a");
      lastAssistant.current = msgId;
      bufferedMessageIdRef.current = msgId;
      bufferedSessionIdRef.current = sessionId || activeSessionRef.current;
      setMessages((prev) =>
        capMessages([
          ...prev,
          { id: msgId, role: "assistant", text: "", streaming: true },
        ]),
      );
      return msgId;
    },
    [flushStream, activeSessionRef, pokeBusy],
  );

  const appendDelta = useCallback(
    (text: string, sessionId?: string, messageId?: string) => {
      if (!text) return;
      setToolActivityState("");

      const targetMsgId = messageId || lastAssistant.current;
      const targetSessionId = sessionId || activeSessionRef.current;

      if (
        (bufferedMessageIdRef.current && targetMsgId && bufferedMessageIdRef.current !== targetMsgId) ||
        (bufferedSessionIdRef.current && targetSessionId && bufferedSessionIdRef.current !== targetSessionId)
      ) {
        flushStream();
      }

      bufferedMessageIdRef.current = targetMsgId;
      bufferedSessionIdRef.current = targetSessionId;
      pendingDeltaRef.current += text;
      scheduleStreamFlush();
      pokeBusy();
    },
    [flushStream, scheduleStreamFlush, activeSessionRef, pokeBusy],
  );

  const appendThinkingDelta = useCallback(
    (text: string, sessionId?: string, messageId?: string) => {
      if (!text) return;

      const targetMsgId = messageId || lastAssistant.current;
      const targetSessionId = sessionId || activeSessionRef.current;

      if (
        (bufferedMessageIdRef.current && targetMsgId && bufferedMessageIdRef.current !== targetMsgId) ||
        (bufferedSessionIdRef.current && targetSessionId && bufferedSessionIdRef.current !== targetSessionId)
      ) {
        flushStream();
      }

      bufferedMessageIdRef.current = targetMsgId;
      bufferedSessionIdRef.current = targetSessionId;
      thinkingBufferRef.current += text;
      scheduleStreamFlush();
      pokeBusy();
    },
    [flushStream, scheduleStreamFlush, activeSessionRef, pokeBusy],
  );

  const appendThinking = appendThinkingDelta;

  const appendReasoningDelta = useCallback(
    (text: string) => {
      if (!text) return;
      setToolActivityState("");
      setMessages((prev) => {
        let targetIndex = findAssistantIndex(prev);
        if (targetIndex !== -1) {
          const target = prev[targetIndex];
          if (target.streaming === false) return prev;
          const updated = [...prev];
          updated[targetIndex] = { ...target, thinking: (target.thinking ?? "") + text };
          return updated;
        }

        const id = uid("a");
        lastAssistant.current = id;
        return capMessages([
          ...prev,
          { id, role: "assistant", text: "", thinking: text, streaming: true },
        ]);
      });
      pokeBusy();
    },
    [findAssistantIndex, pokeBusy],
  );

  const setReasoningAvailable = useCallback(
    (text: string) => {
      if (!text || !lastAssistant.current) return;
      patchAssistant((m) => ({ ...m, thinking: m.thinking || text }));
    },
    [patchAssistant],
  );

  const startTool = useCallback(
    (toolName: string) => {
      setToolActivityState(toolName);
      setBusyState(true);
      busyRef.current = true;
      pokeBusy();
      patchAssistant((m) => ({
        ...m,
        tools: [...new Set([...(m.tools ?? []), toolName])],
      }));
    },
    [patchAssistant, pokeBusy],
  );

  const completeTool = useCallback(() => {
    setToolActivityState("");
  }, []);

  const finishStream = useCallback(
    (finalText?: string, isError?: boolean, persistedTurn?: PersistedTurnReceipt) => {
      // Flush any buffered streaming text before marking complete — otherwise
      // the last chunk of a fast turn can be stuck in the throttle buffer.
      flushStream();
      setToolActivityState("");
      setBusyLabelState("");
      setBusyState(false);
      busyRef.current = false;
      // Re-key WS-originated bubbles with the server's stable row ids when the
      // turn committed them: the next REST merge then correlates by identity
      // instead of fragile role+text matching. The receipt is absent on
      // failed/unpersisted turns — the text-match fallback stays for those.
      const assistantRowId = persistedTurn?.final_assistant_row_id;
      const newAssistantId =
        !isError && Number.isInteger(assistantRowId) && (assistantRowId as number) > 0
          ? `${SERVER_ID_PREFIX}${assistantRowId}`
          : null;
      // NOTE: patchAssistant resolves its target through lastAssistant.current
      // inside the queued updater, so it must not be used here: flipping the
      // ref below (synchronously, before React flushes the queue) would make
      // its lookup miss and the bubble would be dropped as a ghost.
      // patchMessage captures the id as a parameter, so it is safe to pair
      // with the ref flip.
      const prevAssistantId = lastAssistant.current;
      if (prevAssistantId) {
        patchMessage(prevAssistantId, (m) =>
          m.role === "assistant"
            ? {
                ...m,
                ...(newAssistantId ? { id: newAssistantId } : {}),
                ...(finalText ? { text: finalText } : {}),
                streaming: false,
                ...(isError ? { role: "error" as const } : {}),
              }
            : m,
        );
        if (newAssistantId) lastAssistant.current = newAssistantId;
      }
      const userRowId = persistedTurn?.user_row_id;
      const newUserId =
        Number.isInteger(userRowId) && (userRowId as number) > 0
          ? `${SERVER_ID_PREFIX}${userRowId}`
          : null;
      const prevUserId = lastUserMessage.current;
      if (newUserId && prevUserId && !prevUserId.startsWith(SERVER_ID_PREFIX)) {
        patchMessage(prevUserId, (m) =>
          m.role === "user" ? { ...m, id: newUserId } : m,
        );
        lastUserMessage.current = newUserId;
      }
      // Clean up empty ghost assistant bubbles if no text/tools were produced
      setMessages((prev) =>
        prev.filter(
          (m) =>
            !(
              m.role === "assistant" &&
              !m.text &&
              (!m.tools || m.tools.length === 0)
            ),
        ),
      );
      // A completed turn proves any "timed out" stall resolved — sweep the
      // stale error rows. busyTimedOut appends them, but clearRetryErrors only
      // runs on the next send, so without this they persist despite the
      // response arriving.
      setMessages((prev) =>
        prev.filter(
          (m) => !(m.role === "error" && m.text.includes("Request timed out")),
        ),
      );
      clearBusyTimer();
    },
    [flushStream, patchMessage, clearBusyTimer],
  );

  const handleError = useCallback(
    (errorMessage?: string) => {
      flushStream();
      setMessages((prev) =>
        capMessages([
          ...prev,
          { id: uid("e"), role: "error", text: errorMessage || "gateway error" },
        ]),
      );
      setBusyState(false);
      busyRef.current = false;
      setToolActivityState("");
      setBusyLabelState("");
      clearBusyTimer();
    },
    [flushStream, clearBusyTimer],
  );

  const reset = useCallback(() => {
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    pendingDeltaRef.current = "";
    thinkingBufferRef.current = "";
    bufferedMessageIdRef.current = null;
    bufferedSessionIdRef.current = null;
    lastAssistant.current = null;
    lastUserMessage.current = null;
    setBusyState(false);
    busyRef.current = false;
    setToolActivityState("");
    setBusyLabelState("");
    clearBusyTimer();
    setMessages([]);
  }, [clearBusyTimer]);

  const interrupt = useCallback(() => {
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    pendingDeltaRef.current = "";
    thinkingBufferRef.current = "";
    bufferedMessageIdRef.current = null;
    bufferedSessionIdRef.current = null;
    setBusyState(false);
    busyRef.current = false;
    setToolActivityState("");
    setBusyLabelState("");
    clearBusyTimer();
    if (lastAssistant.current) {
      const targetId = lastAssistant.current;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === targetId ? { ...m, streaming: false } : m,
        ),
      );
    }
  }, [clearBusyTimer]);

  const loadMessages = useCallback(
    (msgs: Msg[], sessionId?: string) => {
      if (sessionId && activeSessionRef.current && sessionId !== activeSessionRef.current) {
        return;
      }
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      pendingDeltaRef.current = "";
      thinkingBufferRef.current = "";
      bufferedMessageIdRef.current = null;
      bufferedSessionIdRef.current = null;
      lastAssistant.current = null;
      lastUserMessage.current = null;
      setMessages(capMessages(msgs));
    },
    [activeSessionRef],
  );

  // One sync protocol: merge server truth into the transcript instead of
  // replacing it. loadMessages stays the raw setter for reset/empty snapshot
  // paths; this is the only entry point for REST history.
  const syncFromServer = useCallback(
    (serverMsgs: Msg[], sessionId?: string) => {
      if (sessionId && activeSessionRef.current && sessionId !== activeSessionRef.current) {
        return;
      }
      // Retire in-flight streaming state first: the merge drops streaming
      // bubbles (dead socket), so buffered deltas must not land on them later.
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      pendingDeltaRef.current = "";
      thinkingBufferRef.current = "";
      bufferedMessageIdRef.current = null;
      bufferedSessionIdRef.current = null;
      lastAssistant.current = null;
      lastUserMessage.current = null;
      setMessages((prev) => {
        const merged = mergeServerRows(prev, serverMsgs);
        return merged === prev ? prev : capMessages(merged);
      });
    },
    [activeSessionRef],
  );

  const addUserMessage = useCallback(
    (text: string, images?: string[], opts?: { sending?: boolean }) => {
      const id = uid("u");
      lastUserMessage.current = id;
      setMessages((prev) =>
        capMessages([
          ...prev,
          {
            id,
            role: "user",
            text,
            images,
            ...(opts?.sending ? { sending: true } : {}),
          },
        ]),
      );
      return id;
    },
    [],
  );

  const addErrorMessage = useCallback((text: string) => {
    const id = uid("e");
    // A one-writer-per-chat refusal names the owning surface on a second line
    // reserved for logs. Show the plain sentence instead of the raw payload.
    const shown = isSessionFencedElsewhere(text) ? fenceNotice(text) : text;
    setMessages((prev) =>
      capMessages([
        ...prev,
        { id, role: "error", text: shown },
      ]),
    );
    return id;
  }, []);

  const clearRetryErrors = useCallback(() => {
    setMessages((prev) =>
      prev.filter((m) => !(m.role === "error" && m.text.includes("retry"))),
    );
  }, []);

  const setRetryError = useCallback((text: string) => {
    const id = uid("e");
    setMessages((prev) =>
      capMessages([
        ...prev.filter((m) => !(m.role === "error" && m.text.includes("retry"))),
        { id, role: "error", text },
      ]),
    );
    return id;
  }, []);

  return {
    messages,
    reversedMessages,
    busy,
    toolActivity,
    busyLabel,
    messagesRef,
    busyRef,
    lastAssistantRef: lastAssistant,
    pendingDeltaRef,
    thinkingBufferRef,
    streamFlushTimerRef,
    startStream,
    appendDelta,
    appendThinkingDelta,
    appendThinking,
    appendReasoningDelta,
    setReasoningAvailable,
    startTool,
    completeTool,
    finishStream,
    handleError,
    flushStream,
    scheduleStreamFlush,
    setMessages,
    loadMessages,
    syncFromServer,
    addUserMessage,
    addErrorMessage,
    clearRetryErrors,
    setRetryError,
    setBusy,
    setToolActivity,
    setBusyLabel,
    patchMessage,
    interrupt,
    reset,
    patchAssistant,
    findAssistantIndex,
  };
}

export default useChatStore;
