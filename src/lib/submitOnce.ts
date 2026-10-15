// Send a queued text at most once. The Mac's mobile-push plugin offers
// prompt.submit_once {session_id, text, client_msg_id}: a repeat of an id it
// already accepted answers {status: "duplicate"} instead of starting a second
// reply. Older Macs without the plugin answer -32601 (unknown method); then we
// fall back to plain prompt.submit and remember that for this connection.
//
// The id must be the outbox item's id, which stays the same through retries.

type Requester = { request<T = any>(method: string, params?: object, timeoutMs?: number): Promise<T> };

export type SubmitOutcome = "sent" | "duplicate";

const UNKNOWN_METHOD = -32601;
const unsupported = new WeakSet<object>();

export async function submitOnce(
  gw: Requester,
  sessionId: string,
  text: string,
  clientMsgId: string,
  timeoutMs = 15000,
): Promise<SubmitOutcome> {
  if (!unsupported.has(gw)) {
    try {
      const res = await gw.request<{ status?: string }>(
        "prompt.submit_once",
        { session_id: sessionId, text, client_msg_id: clientMsgId },
        timeoutMs,
      );
      return res?.status === "duplicate" ? "duplicate" : "sent";
    } catch (e) {
      if ((e as { code?: unknown })?.code !== UNKNOWN_METHOD) throw e;
      unsupported.add(gw);
    }
  }
  await gw.request("prompt.submit", { session_id: sessionId, text }, timeoutMs);
  return "sent";
}

/** True once this connection is known to dedupe sends on the Mac. */
export function dedupesSends(gw: object): boolean { return !unsupported.has(gw); }
