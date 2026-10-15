import { AppState, type AppStateStatus } from "react-native";
import * as Updates from "expo-updates";

// EAS OTA update policy for Hermes (2026-10-04).
//
// - Updates are checked on cold start and whenever the app returns to the
//   foreground, throttled to at most one check per 15 minutes.
// - When an update is found it is downloaded silently in the background via
//   fetchUpdateAsync. We NEVER call Updates.reloadAsync() here: a mid-chat
//   restart would kill an in-progress conversation, which is hostile. The
//   fetched update applies on the NEXT cold launch, which is expo-updates'
//   default behavior for a downloaded update, so there is nothing else to do.
// - expo-updates rolls back automatically when a downloaded update fails to
//   launch: it emergency-launches the embedded bundle and marks the bad
//   update as failed-launch so it is never served again. No extra config.
// - Every failure is swallowed silently. Flaky roaming Wi-Fi is the normal
//   case for this user and an update check must never surface as UI noise.
// - Build 139 (TestFlight) predates the native OTA wiring, so it can never
//   receive updates. OTA goes live with the first binary whose Expo.plist
//   points at the real updates URL -- build 140.
// - runtimeVersion bump discipline: when anything on the native side of the
//   boundary changes (new/changed native module, config plugin, SDK upgrade),
//   bump runtimeVersion in BOTH app.json and ios/Hermes/Supporting/Expo.plist
//   so old binaries never receive JS that calls native code they lack.

export type OtaCheckResult =
  | "not-yet-checked"
  | "disabled"
  | "up-to-date"
  | "fetched"
  | "rollback-directive"
  | "failed";

export interface OtaStatus {
  updateId: string | null;
  channel: string | null;
  runtimeVersion: string | null;
  isEnabled: boolean;
  lastCheckedAt: number | null;
  lastResult: OtaCheckResult;
}

export const OTA_CHECK_INTERVAL_MS = 15 * 60 * 1000;

let installed = false;
let subscription: { remove(): void } | null = null;
let lastCheckedAt: number | null = null;
let lastResult: OtaCheckResult = "not-yet-checked";

export function getOtaStatus(): OtaStatus {
  return {
    updateId: Updates.updateId,
    channel: Updates.channel,
    runtimeVersion: Updates.runtimeVersion,
    isEnabled: Updates.isEnabled,
    lastCheckedAt,
    lastResult,
  };
}

async function attemptCheck(): Promise<void> {
  try {
    if (!Updates.isEnabled) {
      // Dev builds / simulators: expo-updates is disabled and its methods
      // throw, so skip before touching the network.
      lastResult = "disabled";
      return;
    }
    const result = await Updates.checkForUpdateAsync();
    if (result.isAvailable) {
      // Silent background download only. Deliberately no reloadAsync:
      // see the policy note at the top of this file.
      await Updates.fetchUpdateAsync();
      lastResult = "fetched";
    } else if (result.isRollBackToEmbedded) {
      // Server-issued rollback directive; the native side applies it at the
      // next launch. Nothing to do in JS.
      lastResult = "rollback-directive";
    } else {
      lastResult = "up-to-date";
    }
  } catch {
    lastResult = "failed";
  }
}

export function startOtaUpdates(options?: { now?: () => number }): () => void {
  const now = options?.now ?? Date.now;
  const maybeCheck = () => {
    if (lastCheckedAt !== null && now() - lastCheckedAt < OTA_CHECK_INTERVAL_MS) return;
    // Stamp the attempt, not the completion: a check already in flight still
    // counts against the throttle so foreground churn cannot pile up checks.
    lastCheckedAt = now();
    void attemptCheck();
  };
  if (!installed) {
    installed = true;
    subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") maybeCheck();
    });
  }
  // Cold start: run one throttled check immediately.
  maybeCheck();
  return () => {
    // Process-lifetime wiring in the app; the cleanup exists so tests can
    // uninstall between cases.
    subscription?.remove();
    subscription = null;
    installed = false;
  };
}
