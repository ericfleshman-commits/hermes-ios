// Minimal JSON-RPC gateway client for React Native.
// Speaks the same wire protocol as the dashboard SPA: JSON-RPC 2.0 frames
// over a single WebSocket, events dispatched by method name, heartbeat ping.
export type GatewayEvent = { type: string; payload?: any; session_id?: string };
export type ConnState = "idle" | "connecting" | "open" | "closed" | "error";

// Server error messages are metadata (never user text); still cap the
// length and never let a hostile value break the log path.
function safeServerMessage(error: any): string {
  try {
    const m = typeof error?.message === "string" ? error.message : String(error?.message ?? error);
    return m.slice(0, 120);
  } catch {
    return "unreadable";
  }
}

// Lazy diagLog access: this module also runs in the node vm tests, whose
// sandboxes stub require() strictly or omit it. The logger must never break
// the wire path, so an unavailable logger is a silent no-op. In the app,
// Metro always resolves these static requires.
let diagFn: ((kind: string, detail?: unknown) => void) | undefined;
function diag(kind: string, detail?: unknown): void {
  try {
    if (!diagFn) diagFn = require("./diagLog").diagLog;
    if (diagFn) diagFn(kind, detail);
  } catch {
    // Logger unavailable: never break the caller.
  }
}


type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<string, Pending>();
  private handlers = new Map<string, Set<(ev: GatewayEvent) => void>>();
  private stateHandlers = new Set<(s: ConnState) => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastInbound = 0;
  private seq = 0;
  state: ConnState = "idle";
  private wsUrl: string;
  // Generation guard: a stale socket's late onclose/onmessage must never
  // kill or paint into its replacement. Every connect/disconnect bumps the
  // generation; handlers captured a stale one exit early.
  private gen = 0;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  onState(fn: (s: ConnState) => void) {
    this.stateHandlers.add(fn);
  }
  on(method: string, fn: (ev: GatewayEvent) => void) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(fn);
  }
  off(method: string, fn: (ev: GatewayEvent) => void) {
    this.handlers.get(method)?.delete(fn);
  }

  private setState(s: ConnState) {
    this.state = s;
    this.stateHandlers.forEach((f) => f(s));
  }

  connect(): Promise<void> {
    if (this.state === "open" || this.state === "connecting") return Promise.resolve();
    this.setState("connecting");
    const g = ++this.gen;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const failTimer = setTimeout(() => {
        // Retire only this attempt. A timed-out socket must not open late
        // or leave reconnect waiting forever for a terminal state.
        if (g === this.gen) this.disconnect();
        reject(new Error("connect timeout"));
      }, 15000);
      ws.onopen = () => {
        if (g !== this.gen) {
          clearTimeout(failTimer);
          try { ws.close(); } catch {}
          return;
        }
        clearTimeout(failTimer);
        this.lastInbound = Date.now();
        this.setState("open");
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastInbound > 45000) {
            this.invalidate("heartbeat timeout");
            return;
          }
          this.raw({
            jsonrpc: "2.0",
            id: `hb-${++this.seq}`,
            method: "gateway.ping",
            params: {},
          });
        }, 15000);
        resolve();
      };
      ws.onerror = () => {
        if (g !== this.gen) return;
        clearTimeout(failTimer);
        this.invalidate("ws error");
        reject(new Error("ws error"));
      };
      ws.onclose = () => {
        if (g !== this.gen) return;
        if (this.state !== "open") {
          clearTimeout(failTimer);
          this.setState("error");           // was stuck in 'connecting'
          try { reject(new Error("ws closed during handshake")); } catch {}
        } else {
          this.invalidate("closed");
        }
      };
      ws.onmessage = (e) => {
        if (g !== this.gen) return;
        this.lastInbound = Date.now();
        let frame: any;
        try {
          frame = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (
          frame.id !== undefined &&
          frame.id !== null &&
          (frame.result !== undefined || frame.error !== undefined)
        ) {
          const p = this.pending.get(String(frame.id));
          if (p) {
            this.pending.delete(String(frame.id));
            clearTimeout(p.timer);
            if (frame.error) {
              diag("rpc_error", { method: p.method, reason: "server_error", message: safeServerMessage(frame.error) });
              const err = new Error(frame.error.message || "rpc error") as Error & { code?: unknown };
              err.code = frame.error.code;
              p.reject(err);
            } else p.resolve(frame.result);
          }
          return;
        }
        if (frame.method && frame.method !== "gateway.ping") {
          // The gateway wraps events: {method:"event", params:{type, payload, session_id}}.
          // Dispatch on the inner type; handlers register by event name.
          const type =
            frame.method === "event" ? frame.params?.type : frame.method;
          if (!type) return;
          const ev: GatewayEvent = {
            type,
            payload: frame.params?.payload ?? frame.params ?? {},
            session_id: frame.params?.session_id,
          };
          this.handlers.get(type)?.forEach((f) => f(ev));
          this.handlers.get("*")?.forEach((f) => f(ev));
        }
      };
    });
  }

  private raw(obj: object) {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch {}
  }

  private invalidate(reason: string) {
    // Retire the socket before closing it: close can synchronously fire callbacks.
    this.gen++;
    const ws = this.ws;
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try { ws.close(); } catch {}
    }
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.ws = null;
    this.pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    });
    this.pending.clear();
    if (this.state !== "error") this.setState("closed");
  }

  request<T = any>(method: string, params: object = {}, timeoutMs = 120000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      diag("rpc_error", { method, reason: "not_connected" });
      return Promise.reject(new Error("not connected"));
    }
    const id = `m${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        diag("rpc_error", { method, reason: "request_timeout", timeoutMs });
        reject(new Error("request timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.raw({ jsonrpc: "2.0", id, method, params });
    });
  }

  disconnect() {
    // Bump the generation first so the closing socket's late onclose is
    // ignored, detach its handlers, then close. The old socket can no
    // longer invalidate its replacement.
    this.gen++;
    const ws = this.ws;
    this.ws = null;
    try {
      if (ws) {
        (ws as any).onopen = null;
        (ws as any).onclose = null;
        (ws as any).onerror = null;
        (ws as any).onmessage = null;
        ws.close();
      }
    } catch {}
    this.invalidate("disconnect");
  }
}
