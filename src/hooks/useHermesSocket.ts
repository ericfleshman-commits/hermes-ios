import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { GatewayClient, type ConnState, type GatewayEvent } from "../lib/gateway";
import { HOST, getWsTicket, prefetchWsTicket, readStoredSessionId, takeWarmTicket, type TicketBundle } from "../lib/auth";

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

export type SocketEventHandler = (
  type: string,
  payload: any,
  sessionId?: string,
) => void;

// Carried from connectGateway into onConnected for a single connect: the
// ticket bundle (possibly with an inline session resume) that dialed this
// socket. Single-use by construction -- each connect mints/takes exactly one
// bundle and hands it to exactly one onConnected call.
export interface SocketConnectedOpts {
  attachOnly?: boolean;
  ticketBundle?: TicketBundle;
}

export interface UseHermesSocketOptions {
  activeSession?: string;
  activeSessionRef?: React.MutableRefObject<string>;
  needsLogin?: boolean;
  onEvent?: SocketEventHandler;
  onConnected?: (opts?: SocketConnectedOpts) => Promise<void> | void;
  // Set while the user is waiting on a turn (thinking pill up): the
  // reconnect scheduler caps backoff at 5s instead of 30s.
  isBusyRef?: React.MutableRefObject<boolean>;
}

export interface HermesSocketReturn {
  conn: ConnState;
  // True while a reconnect retry is scheduled: the pill shows
  // "Connecting…" instead of red Offline during the backoff wait.
  retryScheduled: boolean;
  gwRef: React.MutableRefObject<GatewayClient | null>;
  activeSessionRef: React.MutableRefObject<string>;
  connectGateway: (opts?: { attachOnly?: boolean }) => Promise<void>;
  reconnect: (opts?: boolean | { attachOnly?: boolean }) => Promise<void>;
  // Foreground entry: reset the backoff counter and reconnect immediately
  // instead of waiting out a scheduled timer; probe a socket that claims
  // open in case iOS froze it without onclose.
  reconnectNow: () => void;
  disconnect: () => void;
}

// Backoff with jitter: exponential growth, each delay drawn from
// [backoff/2, backoff] so a waking phone and a flapping mini never retry in
// lockstep. Attempt 1 lands at 1–2s: aggressive, not spinny. While a turn is
// in flight (busy) the cap drops to 5s so a user waiting on a response
// reconnects in seconds; otherwise 30s keeps the radio quiet on a dead mini.
export function backoffDelayMs(attempt: number, busy = false): number {
  const cap = busy ? 5000 : 30000;
  const backoff = Math.min(cap, 1000 * 2 ** attempt);
  return Math.floor(backoff / 2 + Math.random() * (backoff / 2));
}

// Give up the scheduler after this many consecutive failures: retrying
// every 30s forever burns radio on a dead mini and the pill could never
// honestly say Offline. A foreground return or manual reconnect resets the
// counter, so this only ever pauses retries while the app sits idle.
const MAX_RECONNECT_ATTEMPTS = 10;

export type PillStatus = "live" | "connecting" | "offline";
// The status pill's honest mapping: red Offline is reserved for a socket
// that is down AND not being retried (intentional stop, logged out, or
// attempts exhausted). A scheduled retry or an in-flight connect reads
// "Connecting…", even while conn still says closed/error between attempts.
export function pillStatus(conn: ConnState, retryScheduled: boolean): PillStatus {
  if (conn === "open") return "live";
  if (conn === "idle" || conn === "connecting" || retryScheduled) return "connecting";
  return "offline";
}

export function useHermesSocket(options: UseHermesSocketOptions = {}): HermesSocketReturn {
  const { activeSession, needsLogin, onEvent, onConnected, isBusyRef } = options;

  const [conn, setConn] = useState<ConnState>("idle");
  const [retryScheduled, setRetryScheduled] = useState(false);
  const gwRef = useRef<GatewayClient | null>(null);
  const mountedRef = useRef(true);

  // Generation guard: a socket from before the latest connect must not be
  // able to invalidate its replacement. Every connect/disconnect bumps the
  // generation; in-flight promises and handlers captured on a stale one exit early.
  const connectGenRef = useRef(0);

  // Stable active session reference for session gating (isOurs).
  // Read via ref so connectGateway identity never depends on activeSession.
  const fallbackSessionRef = useRef(activeSession || "");
  const activeSessionRef = options.activeSessionRef || fallbackSessionRef;
  useEffect(() => {
    if (activeSession !== undefined) {
      activeSessionRef.current = activeSession;
    }
  }, [activeSession, activeSessionRef]);

  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  // needsLogin as a ref: the reconnect scheduler reads it from socket
  // callbacks, where the render's prop value would be stale.
  const needsLoginRef = useRef(needsLogin);
  needsLoginRef.current = needsLogin;

  // --- The single reconnect scheduler -------------------------------------
  // Every automatic reconnect funnels through here: a dropped socket, a
  // failed handshake, a failed ticket fetch, the foreground health probe.
  // One timer, one backoff counter, one stop rule (an intentional
  // disconnect). Nothing else in this hook arms a reconnect.
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  // Set by disconnect(): going offline was asked for, so the scheduler stays
  // quiet. Cleared by any connectGateway call.
  const intentionalStopRef = useRef(false);

  const cancelScheduledReconnect = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  }, []);

  // noteFailure is referenced by connectGateway's socket callbacks, which are
  // created before noteFailure itself is defined; the ref always points at
  // the latest implementation.
  const noteFailureRef = useRef<() => void>(() => {});

  const connectGateway = useCallback(
    async (opts?: { attachOnly?: boolean }) => {
      if (!mountedRef.current) return;
      // A fresh manual connect owns the timeline: stop any scheduled retry
      // and lift the intentional-stop flag.
      intentionalStopRef.current = false;
      cancelScheduledReconnect();
      // A connect is in flight from here — including the ws-ticket fetch
      // below, which can take seconds on a waking radio. Say so immediately
      // instead of leaving a red Offline pill up while we dial.
      setConn("connecting");
      setRetryScheduled(false);
      const gen = ++connectGenRef.current;

      let bundle: TicketBundle;
      try {
        // A speculatively minted ticket (prefetched while the last socket
        // was retired, or during the foreground zombie probe) skips the
        // HTTPS mint round trip. takeWarmTicket consumes it single-use, so
        // a stale/expired cache falls back to a fresh mint exactly like
        // before -- the failure path below is untouched. The on-demand mint
        // carries the stored session id (same helper the prefetch uses) so
        // the backend can run session.resume inline with the ticket.
        bundle = takeWarmTicket() ?? (await getWsTicket(await readStoredSessionId()));
      } catch {
        // Ticket fetch failed (mini asleep, tailscale down). setConn alone
        // can't drive the retry: if we're already showing closed/error it's
        // a no-op and the scheduler would stall — re-arm explicitly.
        if (mountedRef.current && gen === connectGenRef.current) {
          setConn("error");
          diag("reconnect_fail", { stage: "ws_ticket" });
          uploadDiag();
          noteFailureRef.current();
        }
        return;
      }
      if (!mountedRef.current || gen !== connectGenRef.current) return;

      const gw = new GatewayClient(
        `wss://${HOST}/api/ws?ticket=${encodeURIComponent(bundle.ticket)}`,
      );

      // Clean up previous socket if reconnecting to prevent zombie listeners
      try {
        gwRef.current?.disconnect();
      } catch {}
      gwRef.current = gw;

      gw.onState((s) => {
        if (!mountedRef.current || gen !== connectGenRef.current) return;
        setConn(s);
        // A dead or failed socket schedules its own replacement through the
        // one scheduler — no separate effect, so this can't double-schedule
        // or stall on a no-op setConn.
        if (s === "closed" || s === "error") noteFailureRef.current();
      });

      // Session gate: events belong to us if session_id matches activeSessionRef or is omitted
      const isOurs = (ev?: GatewayEvent) => {
        const sid = ev?.session_id;
        return !sid || sid === activeSessionRef.current;
      };

      gw.on("*", (ev: GatewayEvent) => {
        if (!mountedRef.current || gen !== connectGenRef.current || !isOurs(ev)) return;
        onEventRef.current?.(ev.type, ev.payload, ev.session_id);
      });

      try {
        await gw.connect();
        if (!mountedRef.current || gen !== connectGenRef.current) return;
        if (onConnectedRef.current) {
          // The bundle is handed to the session layer for this connect
          // only: it carries the inline session.resume (if the mint had a
          // valid session id) that lets restore/attach skip the resume RPC.
          await onConnectedRef.current({ ...opts, ticketBundle: bundle });
        }
      } catch (e) {
        // Handshake failures already scheduled their retry via onState
        // above; this is just the log line.
        console.warn("gateway connect failed", e);
        diag("reconnect_fail", { stage: "handshake" });
        uploadDiag();
      }
    },
    // activeSession explicitly excluded from deps — socket is stable across chat switches
    [cancelScheduledReconnect],
  );

  // Arms one reconnect attempt. The generation captured here must still be
  // current when the timer fires: a newer manual connect in between means
  // this attempt is stale and must not disturb the live socket.
  const scheduleReconnect = useCallback((delayMs: number) => {
    cancelScheduledReconnect();
    setRetryScheduled(true);
    // The retry will need a ticket: mint it now (25 s warm window) so the
    // attempt skips the HTTPS mint round trip. Pure prefetch -- retry
    // timing, backoff, and give-up semantics are untouched; attempts 1-4
    // (backoff <= 16 s) always land inside the window.
    void prefetchWsTicket();
    const gen = connectGenRef.current;
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      if (!mountedRef.current) return;
      if (intentionalStopRef.current) return;
      if (gen !== connectGenRef.current) return; // superseded by a newer connect
      void connectGateway({ attachOnly: true }).catch(() => {});
    }, delayMs);
  }, [cancelScheduledReconnect, connectGateway]);

  const noteFailure = useCallback(() => {
    if (!mountedRef.current) return;
    if (needsLoginRef.current || intentionalStopRef.current) return;
    attempts.current += 1;
    if (attempts.current > MAX_RECONNECT_ATTEMPTS) {
      // Genuine failure, not a blip: stop the scheduler so the pill can
      // honestly show Offline. The next foreground return or manual
      // reconnect resets the counter and tries again.
      diag("reconnect_giveup", { attempts: attempts.current });
      uploadDiag();
      setRetryScheduled(false);
      return;
    }
    const busy = isBusyRef?.current === true;
    diag("reconnect_attempt", { attempt: attempts.current, busy });
    // A turn in flight gets aggressive reconnects: 5s cap, not 30s.
    scheduleReconnect(backoffDelayMs(attempts.current, busy));
  }, [scheduleReconnect, isBusyRef]);
  noteFailureRef.current = noteFailure;

  const reconnect = useCallback(
    async (opts?: boolean | { attachOnly?: boolean }) => {
      // An explicit reconnect is a fresh intent (boot, login): don't let a
      // stale backoff counter instantly trip the give-up above.
      attempts.current = 0;
      const attachOnly = typeof opts === "boolean" ? opts : opts?.attachOnly;
      await connectGateway({ attachOnly });
    },
    [connectGateway],
  );

  const disconnect = useCallback(() => {
    // Intentional: the scheduler must not resurrect this. The generation
    // bump retires the closing socket's late callbacks; its onState("closed")
    // is ignored as stale.
    intentionalStopRef.current = true;
    cancelScheduledReconnect();
    setRetryScheduled(false);
    connectGenRef.current++;
    try {
      gwRef.current?.disconnect();
    } catch {}
    gwRef.current = null;
    setConn("closed");
  }, [cancelScheduledReconnect]);

  useEffect(() => {
    if (conn === "open") {
      if (attempts.current > 0) {
        diag("reconnect_ok", { attempts: attempts.current });
        uploadDiag();
      }
      attempts.current = 0;
      setRetryScheduled(false);
    }
  }, [conn]);

  // Boot liveness: if we're still sitting on the initial "idle" state 12s
  // after mount, the handshake never started (a stalled boot before the
  // first connect) — kick the single connect entry instead of sitting dead
  // forever. Every failure after the first attempt re-arms through
  // noteFailure, so this fires at most once per mount.
  useEffect(() => {
    if (conn !== "idle" || needsLoginRef.current) return;
    const t = setTimeout(() => {
      if (!mountedRef.current) return;
      void connectGateway({ attachOnly: true }).catch(() => {});
    }, 12000);
    return () => clearTimeout(t);
  }, [conn, connectGateway]);

  // Immediate reconnect entry for foreground returns: reset the backoff
  // counter and reconnect right away instead of waiting out a scheduled
  // timer. A socket that claims open gets a health probe first — iOS may
  // have frozen it without onclose ever firing (zombie socket).
  const reconnectNow = useCallback(() => {
    if (!mountedRef.current || needsLoginRef.current) return;
    attempts.current = 0;
    cancelScheduledReconnect();
    setRetryScheduled(false);
    // gw.state is the socket's own synchronous state — fresher than the
    // conn render state, which may still say open for a dead socket.
    const gw = gwRef.current;
    if (gw && gw.state === "open") {
      // A foregrounded iPhone may need several seconds to resume its network
      // path. A 600ms deadline killed healthy sockets during normal wake-up,
      // so the probe gets 5s; only a proven-dead socket is retired.
      // Only retire the socket we probed; a newer connection may already
      // have replaced it while this ping was in flight.
      // Mint a ticket in parallel with the probe: if the probe proves the
      // socket dead, the failover connect skips the HTTPS mint round trip.
      // If the probe passes, the warm ticket simply expires unused.
      void prefetchWsTicket();
      void gw.request("gateway.ping", {}, 5000)
        .catch(() => {
          diag("reconnect_fail", { stage: "foreground_ping" });
          uploadDiag();
          if (!mountedRef.current || gwRef.current !== gw) return;
          // The ping proved it dead: retire it now so nothing tries to send
          // on it, then reconnect immediately with a fresh backoff counter.
          // The retire's own onState("closed") briefly arms a retry that the
          // fresh connect below cancels.
          gw.disconnect();
          attempts.current = 0;
          cancelScheduledReconnect();
          setRetryScheduled(false);
          void connectGateway({ attachOnly: true });
        });
      return;
    }
    void connectGateway({ attachOnly: true });
  }, [cancelScheduledReconnect, connectGateway]);

  // Leaving the app doesn't exit the chat: session id + transcript survive in
  // state; on return (foreground) reconnectNow resets the backoff and
  // reconnects immediately instead of waiting out a scheduled timer.
  // On success onConnected fires, which attaches/restores the session and
  // flushes anything queued while we were away.
  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (!mountedRef.current) return;
      if (appState.current.match(/inactive|background/) && next === "active") {
        reconnectNow();
      }
      appState.current = next;
    });
    return () => sub.remove();
  }, [reconnectNow]);

  // Cleanup on unmount (Fast Refresh, app teardown)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      connectGenRef.current++;
      cancelScheduledReconnect();
      try {
        gwRef.current?.disconnect();
      } catch {}
      gwRef.current = null;
    };
  }, [cancelScheduledReconnect]);

  return {
    conn,
    retryScheduled,
    gwRef,
    activeSessionRef,
    connectGateway,
    reconnect,
    reconnectNow,
    disconnect,
  };
}

export default useHermesSocket;
