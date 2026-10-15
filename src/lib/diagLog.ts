// Diagnostic event ring buffer for Phase 2 auto log-upload.
//
// Metadata ONLY: connection state transitions, timeouts, reconnect
// attempts/results, RPC errors, sync anomalies. NEVER message contents,
// user text, or anything that could echo what Eric typed or received.
// Callers must never pass params/payloads here — gateway params carry
// prompt text, so only method names and failure reasons are logged.
//
// Every public function is defensive: diagLog must NEVER throw, even on
// garbage input, because it sits on hot error paths.
export type DiagKind =
  | "timeout"
  | "reconnect_attempt"
  | "reconnect_ok"
  | "reconnect_fail"
  | "rpc_error"
  | "sync_anomaly";

export interface DiagEvent {
  ts: string; // ISO timestamp
  kind: string;
  detail: Record<string, unknown>;
}

// Bounded: oldest entries are dropped first. Kept well above the per-upload
// cap so a flapping socket can't evict the first failure's context.
export const DIAG_MAX_ENTRIES = 300;
// Per-event detail cap: one pathological detail object can't blow the 64KB
// payload budget on its own.
const DIAG_MAX_DETAIL_CHARS = 4000;

const buf: DiagEvent[] = [];

function safeString(v: unknown): string {
  try {
    if (typeof v === "string") return v;
    return String(v);
  } catch {
    return "<unprintable>";
  }
}

// JSON-round-trip the detail so circular structures, functions, and other
// non-serializable values can't break the upload payload later.
function safeDetail(detail: unknown): Record<string, unknown> {
  try {
    if (detail === null || detail === undefined) return {};
    if (typeof detail !== "object") return { value: safeString(detail) };
    let json: string;
    try {
      json = JSON.stringify(detail);
    } catch {
      return { unserializable: true };
    }
    if (json.length > DIAG_MAX_DETAIL_CHARS) {
      return {
        truncated: true,
        preview: json.slice(0, DIAG_MAX_DETAIL_CHARS),
      };
    }
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { unserializable: true };
  }
}

function safeKind(kind: unknown): string {
  try {
    return typeof kind === "string" && kind.length > 0 ? kind : "unknown";
  } catch {
    return "unknown";
  }
}

/** Append a diagnostic event. Never throws. Never logs message content. */
export function diagLog(kind: string, detail?: unknown): void {
  try {
    buf.push({ ts: new Date().toISOString(), kind: safeKind(kind), detail: safeDetail(detail) });
    while (buf.length > DIAG_MAX_ENTRIES) buf.shift();
  } catch {
    // The logger itself must never break the app.
  }
}

/** Put events back at the front after a failed upload (oldest dropped
 *  first when the buffer is full). Never throws. */
export function restoreDiag(events: DiagEvent[]): void {
  try {
    buf.unshift(...events);
    while (buf.length > DIAG_MAX_ENTRIES) buf.shift();
  } catch {
    /* never break the app */
  }
}

/** Return buffered events and clear the buffer. Never throws. */
export function drainDiag(): DiagEvent[] {
  try {
    const out = buf.slice();
    buf.length = 0;
    return out;
  } catch {
    return [];
  }
}

/** Current buffered count (for tests/debugging). Never throws. */
export function diagCount(): number {
  try {
    return buf.length;
  } catch {
    return 0;
  }
}
