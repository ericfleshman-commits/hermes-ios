export function createReplyHapticGate() {
  let startedSession: string | null = null;
  return {
    start(session: string) { startedSession = session || null; },
    clear() { startedSession = null; },
    complete(activeSession: string, status: string, foreground: boolean) {
      const tap = shouldTapForReply(startedSession, activeSession, status, foreground);
      startedSession = null;
      return tap;
    },
  };
}

// Type-only: erased at compile, so this file stays importable in node tests
// without expo-haptics installed at runtime.
import type * as Haptics from "expo-haptics";

/** Structural seam for the injected Haptics module (real or test double). */
export type HapticsLike = Pick<typeof Haptics, "impactAsync" | "ImpactFeedbackStyle">;

/**
 * The single haptic path for a user-initiated send (fresh sends and manual
 * retries alike): one light tap. The Haptics module is injected so this file
 * stays importable in node tests without expo-haptics. Haptics are
 * decoration — they never throw into a send.
 */
export function tapOnSend(haptics: HapticsLike | undefined): void {
  try {
    const p = haptics?.impactAsync(haptics?.ImpactFeedbackStyle?.Light) as
      | Promise<unknown>
      | undefined;
    // A rejected tap must not surface as an unhandled rejection either.
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    // ignore: a failed tap must not break the send
  }
}

export function shouldTapForReply(
  startedSession: string | null,
  activeSession: string,
  status: string,
  foreground: boolean,
): boolean {
  return Boolean(startedSession && startedSession === activeSession && status === "complete" && foreground);
}
