// Pure, testable send-gate decisions for the App send path.
//
// Why this exists: the pending-send poison pill (Oct 2026). A failed flush
// marks the durable pending text "uncertain", and "uncertain" never
// auto-sends again — sends were bricked until the user found the manual
// dismiss/retry affordance, and every gate that blocked a tap was silent.
// These helpers keep the branching decisions unit-testable without pulling
// React, SecureStore, or the gateway into the test harness.
//
// No message text is ever logged or transmitted by these helpers; callers
// must only pass guard names / states to diag.

export type PendingLike = {
  id: string;
  sessionId: string;
  text: string;
  state: string;
};

export type MsgLike = {
  role: string;
  text: string;
};

/** Delivery-line shown when a new tap is blocked by an existing pending send.
 *  The tap must never die silently: the user needs to know why nothing
 *  happened and what their options are. */
export const PENDING_BLOCKED_TEXT =
  "Earlier message still sending \u2014 tap to retry or dismiss";

/** How long after a send turned uncertain the heal may conclude "never
 *  landed". A timed-out prompt.submit can still be accepted server-side;
 *  the server saves the user row at acceptance, so after this window a fresh
 *  history without the row means the send did not land. */
export const HEAL_REQUEUE_MIN_AGE_MS = 60 * 1000;

const SERVER_PREFIX = "srv:";

function serverRowNumber(id: unknown): number | null {
  if (typeof id !== "string" || !id.startsWith(SERVER_PREFIX)) return null;
  const n = parseInt(id.slice(SERVER_PREFIX.length), 10);
  return Number.isNaN(n) ? null : n;
}

/** Highest server row id in a transcript, ignoring client-minted rows.
 *  Recorded on a pending send before its RPC so a later heal only counts
 *  server rows newer than the send. */
export function latestServerRowId(messages: Array<{ id?: unknown }>): number | null {
  let max: number | null = null;
  for (const m of messages ?? []) {
    const n = serverRowNumber(m?.id);
    if (n !== null && (max === null || n > max)) max = n;
  }
  return max;
}

/**
 * Decide what to do with a stuck "uncertain" pending send.
 *
 * `serverRows` must come from a history fetch that succeeded just now for
 * the pending's chat (mapServerMessages output). Pass null when the fetch
 * failed: the local transcript is never evidence, because it holds the
 * app's own optimistic bubble and stale cache rows.
 *
 * - "clear": a server user row newer than the send's baseline matches the
 *   text, so the server accepted it. Do NOT resend.
 * - "requeue": the fresh history has no such row and the send has been
 *   uncertain long enough that the server cannot still be accepting it.
 * - "skip": no decision. The pending stays uncertain and keeps its manual
 *   check-then-dismiss/retry affordance.
 */
export function decidePendingHeal(
  pending: (PendingLike & { baseRowId?: number | null; uncertainAt?: number }) | null,
  activeSid: string,
  storedSessionId: string | null | undefined,
  serverRows: MsgLike[] | null | undefined,
  now: number = Date.now(),
): "clear" | "requeue" | "skip" {
  if (!pending || pending.state !== "uncertain") return "skip";
  // Only heal when we know which chat is live and the pending belongs to it.
  if (!activeSid || pending.sessionId !== storedSessionId) return "skip";
  if (!Array.isArray(serverRows)) return "skip";
  const base = typeof pending.baseRowId === "number" ? pending.baseRowId : null;
  let matchAfterBase = false;
  let matchAny = false;
  for (const m of serverRows) {
    const n = serverRowNumber((m as { id?: unknown }).id);
    if (n === null || m.role !== "user" || !pendingTextMatches(m.text, pending.text)) continue;
    matchAny = true;
    if (base !== null && n > base) matchAfterBase = true;
  }
  if (matchAfterBase) return "clear";
  // A match with no baseline might be an older identical message.
  if (base === null && matchAny) return "skip";
  const age = typeof pending.uncertainAt === "number" ? now - pending.uncertainAt : -1;
  if (age < HEAL_REQUEUE_MIN_AGE_MS) return "skip";
  return "requeue";
}

/** Server rows are full text; the server trims typed artifacts, so compare
 *  without outer whitespace. */
function pendingTextMatches(rowText: string, pendingText: string): boolean {
  if (typeof rowText !== "string" || typeof pendingText !== "string") return false;
  return rowText.trim() === pendingText.trim() && pendingText.trim() !== "";
}

export type QueueGate = "ok" | "no_stored_session" | "images_not_queued" | "pending_exists";

/**
 * Gate the durable-queue branch of sendOrQueue. Returns which guard blocked,
 * so the caller can log it instead of returning silently. Guards are checked
 * in the same order as the original compound condition.
 */
export function evaluateQueueGate(opts: {
  storedSessionId: string | null | undefined;
  hasImages: boolean;
  pendingState: string | null;
}): QueueGate {
  if (!opts.storedSessionId) return "no_stored_session";
  if (opts.hasImages) return "images_not_queued";
  if (opts.pendingState) return "pending_exists";
  return "ok";
}

/** Visible delivery-line for a queue gate, or null when the gate needs none. */
export function queueGateDeliveryText(gate: QueueGate): string | null {
  return gate === "pending_exists" ? PENDING_BLOCKED_TEXT : null;
}

export type FlushGateInput = {
  hasPending: boolean;
  canAutoSend: boolean;
  flushing: boolean;
  gwOpen: boolean;
  busy: boolean;
  hasActiveSid: boolean;
  sessionMatches: boolean;
};

/**
 * Name the single flushPending guard that fails, or null when the flush may
 * proceed. Mirrors the original compound early-return condition exactly.
 */
export function evaluateFlushGate(i: FlushGateInput): string | null {
  if (!i.hasPending) return "no_pending";
  if (!i.canAutoSend) return "not_auto_sendable";
  if (i.flushing) return "already_flushing";
  if (!i.gwOpen) return "gateway_not_open";
  if (i.busy) return "busy";
  if (!i.hasActiveSid) return "no_active_session";
  if (!i.sessionMatches) return "pending_wrong_chat";
  return null;
}
