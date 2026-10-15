// Durations for the moments that make the app feel fast or slow. Each one is
// logged as a diagnostic event {kind: "timing", detail: {name, ms, ...}} and
// rides along with the normal diagnostic upload. Metadata only, never text.
//
//   launch_cached  JS start -> cached chat painted (detail.hit: cache found)
//   launch_live    JS start -> first live connection to the Mac
//   switch         tap a chat in the drawer -> that chat is loaded
//   send_ack       send leaves the outbox -> the Mac accepts it
//   first_token    send accepted -> first words of the reply arrive
//   reply_done     send accepted -> reply finished
import { diagLog } from "./diagLog";

type Clock = () => number;
let now: Clock = () => Date.now();
let jsStart = now();
const onceDone = new Set<string>();
// One reply in flight per chat: when its send was accepted, and whether the
// first token has been timed yet.
const replies = new Map<string, { acceptedAt: number; firstSeen: boolean }>();

function log(name: string, ms: number, extra?: Record<string, unknown>): void {
  if (!Number.isFinite(ms) || ms < 0 || ms > 30 * 60 * 1000) return;
  diagLog("timing", { name, ms: Math.round(ms), ...(extra || {}) });
}

/** Time since JS start, logged once per app process. */
export function sinceLaunchOnce(name: string, extra?: Record<string, unknown>): void {
  if (onceDone.has(name)) return;
  onceDone.add(name);
  log(name, now() - jsStart, extra);
}

/** Time an async step: `await timed("switch", () => resume(row))`. */
export async function timed<T>(name: string, fn: () => Promise<T>, extra?: Record<string, unknown>): Promise<T> {
  const t = now();
  try {
    return await fn();
  } finally {
    log(name, now() - t, extra);
  }
}

export function sendAccepted(sessionId: string, startedAt: number): void {
  const t = now();
  log("send_ack", t - startedAt);
  if (sessionId) replies.set(sessionId, { acceptedAt: t, firstSeen: false });
}

export function replyToken(sessionId: string | undefined): void {
  const r = sessionId ? replies.get(sessionId) : undefined;
  if (!r || r.firstSeen) return;
  r.firstSeen = true;
  log("first_token", now() - r.acceptedAt);
}

export function replyDone(sessionId: string | undefined, status?: string): void {
  const r = sessionId ? replies.get(sessionId) : undefined;
  if (!r) return;
  replies.delete(sessionId as string);
  log("reply_done", now() - r.acceptedAt, { status: status || "complete" });
}

export function __setClockForTests(clock: Clock): void {
  now = clock;
  jsStart = clock();
  onceDone.clear();
  replies.clear();
}
