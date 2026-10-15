// iOS push registration for the Hermes client.
//
// Shared contract with the backend:
//   - Registration: gw.request("push.register", { token, device_id }, 15000) -> { ok: true }
//   - Token format: ExponentPushToken[...]
//   - Incoming pushes carry { sessionId } in `data`; the body is generic
//     ("New response ready") and never contains message text (privacy).
//
// Rules: this module never throws, never logs the token, never nags.
// Permission is requested at most once per app session; a denial is a
// silent skip. Registration is idempotent and safe to call on every
// socket connect — a re-register after a backend restart is cheap and
// self-healing, and concurrent calls coalesce into one in-flight attempt.
import type { GatewayClient } from "./gateway";

const REGISTER_TIMEOUT_MS = 15000;
const EXPO_TOKEN_PREFIX = "ExponentPushToken[";

// Minimal shapes of the expo modules, lazily required so this file stays
// importable in plain node (tests) and on platforms where the native
// modules are absent.
interface PushDeviceApi {
  isDevice: boolean;
}
interface ExpoPushTokenResult {
  data?: string;
}
interface PushNotificationsApi {
  getPermissionsAsync(): Promise<{ status?: string }>;
  requestPermissionsAsync(): Promise<{ status?: string }>;
  getExpoPushTokenAsync(options?: {
    projectId?: string;
  }): Promise<ExpoPushTokenResult | string>;
  setNotificationHandler(handler: {
    handleNotification: () => Promise<{
      shouldShowBanner: boolean;
      shouldShowList: boolean;
      shouldPlaySound: boolean;
      shouldSetBadge: boolean;
    }>;
  }): void;
  addNotificationResponseReceivedListener(
    listener: (response: unknown) => void,
  ): { remove(): void };
  setBadgeCountAsync?(count: number): Promise<boolean>;
}

type PushNative = {
  device: PushDeviceApi;
  notifications: PushNotificationsApi;
};

let pushNativeCache: PushNative | null | undefined;
function loadPushNative(): PushNative | null {
  if (pushNativeCache !== undefined) return pushNativeCache;
  try {
    const device = require("expo-device") as PushDeviceApi;
    const notifications = require("expo-notifications") as PushNotificationsApi;
    if (!device || !notifications) throw new Error("push modules unavailable");
    pushNativeCache = { device, notifications };
  } catch {
    pushNativeCache = null;
  }
  return pushNativeCache;
}

// The EAS project id the push token is minted for. Mirrors the lazy
// expo-constants pattern in diagUpload.ts.
function pushProjectId(): string | undefined {
  try {
    const mod = require("expo-constants") as {
      default?: any;
      expoConfig?: any;
      easConfig?: any;
    };
    const cfg = mod?.default?.expoConfig ?? mod?.expoConfig ?? mod?.default ?? mod;
    return cfg?.extra?.eas?.projectId ?? mod?.easConfig?.projectId ?? cfg?.easConfig?.projectId;
  } catch {
    return undefined;
  }
}

// App-session state (never persisted — privacy, and a fresh token check
// each launch is cheap):
//   registeredToken: last Expo token the backend acknowledged this session
//   permissionDenied: iOS was asked and said no; never re-prompt
//   inFlight: coalesces concurrent ensurePushRegistration calls
let registeredToken: string | null = null;
let permissionDenied = false;
let inFlight: Promise<void> | null = null;
let handlerInstalled = false;
let openSessionCb: ((sessionId: string) => void) | null = null;

async function requestPermissionOnce(
  notifications: PushNotificationsApi,
): Promise<boolean> {
  let status: string | undefined;
  try {
    status = (await notifications.getPermissionsAsync())?.status;
  } catch {
    return false;
  }
  if (status !== "granted") {
    try {
      status = (await notifications.requestPermissionsAsync())?.status;
    } catch {
      status = "denied";
    }
  }
  return status === "granted";
}

// Optional reporter: the App routes these to diagnostics so a silent
// registration failure names its stage. Never receives the token.
type PushStageReporter = (stage: string, detail?: Record<string, unknown>) => void;
let reporter: PushStageReporter | null = null;
export function setPushReporter(fn: PushStageReporter | null): void { reporter = fn; }
function report(stage: string, detail?: Record<string, unknown>): void {
  try { reporter?.(stage, detail); } catch { /* never break registration */ }
}
function safeErr(e: unknown): string {
  const m = (e as { code?: unknown; message?: unknown }) || {};
  return String(m.code ?? m.message ?? e ?? "").replace(/ExponentPushToken\[[^\]]*\]/g, "<token>").slice(0, 160);
}

async function currentExpoToken(
  notifications: PushNotificationsApi,
): Promise<string | null> {
  try {
    const projectId = pushProjectId();
    if (!projectId) report("no_project_id");
    const res = await notifications.getExpoPushTokenAsync({ projectId });
    const token = typeof res === "string" ? res : (res as ExpoPushTokenResult)?.data;
    if (typeof token === "string" && token.startsWith(EXPO_TOKEN_PREFIX)) return token;
    report("token_bad_shape", { type: typeof token });
    return null;
  } catch (e) {
    report("token_failed", { error: safeErr(e) });
    return null;
  }
}

/** Register this device's Expo push token with the backend. Never throws. */
export function ensurePushRegistration(
  gw: GatewayClient | null,
  deviceId: string | null | undefined,
): Promise<void> {
  if (!gw || !deviceId) return Promise.resolve();
  if (inFlight) return inFlight;
  const work = (async () => {
    const native = loadPushNative();
    if (!native) return;
    const { device, notifications } = native;
    // Simulators and non-device targets can never get a push token.
    if (!device.isDevice) { report("not_device"); return; }
    // A denial this session is final — silent skip, no nag loop.
    if (permissionDenied) return;
    let granted = false;
    try {
      granted = await requestPermissionOnce(notifications);
    } catch {
      granted = false;
    }
    if (!granted) {
      permissionDenied = true;
      report("permission_denied");
      return;
    }
    const token = await currentExpoToken(notifications);
    if (!token) return;
    // Idempotent: the backend already has this token from this session.
    if (token === registeredToken) return;
    try {
      await gw.request("push.register", { token, device_id: deviceId }, REGISTER_TIMEOUT_MS);
    } catch (e) {
      // Backend unreachable or restarted mid-call: stay unregistered and
      // retry on the next connect. Never mark the token as registered.
      report("register_rpc_failed", { error: safeErr(e) });
      return;
    }
    registeredToken = token;
    report("registered");
  })();
  inFlight = work;
  void work.finally(() => {
    if (inFlight === work) inFlight = null;
  });
  return work;
}

function handleNotificationResponse(response: unknown): void {
  try {
    const data = (response as any)?.notification?.request?.content?.data;
    const sid = data && typeof data.sessionId === "string" ? data.sessionId : "";
    if (sid && openSessionCb) openSessionCb(sid);
    // No sessionId in data: the tap already foregrounded the app; nothing to do.
  } catch {
    // Never throw out of a native callback.
  }
}

/**
 * Install the foreground banner handler and the tap listener. Safe to call
 * more than once — the first call wins and later calls only refresh the
 * session-open callback. Returns a cleanup that removes the listener.
 */
export function installPushHandlers(
  onOpenSession: (sessionId: string) => void,
): () => void {
  function appIsActive(): boolean {
  try {
    const { AppState } = require("react-native") as { AppState: { currentState?: string } };
    return AppState?.currentState === "active";
  } catch {
    return false;
  }
}

const noop = () => {};
  const native = loadPushNative();
  if (!native) return noop;
  const { notifications } = native;
  openSessionCb = onOpenSession ?? null;
  if (handlerInstalled) return noop;
  handlerInstalled = true;
  try {
    // Foreground pushes show a banner ("New response ready") so Eric sees
    // the reply without the app open in front of him.
    notifications.setNotificationHandler({
      // No banner while Hermes is on screen: the reply is already in
      // front of you. Background/locked pushes are shown by iOS itself.
      handleNotification: async () => ({
        shouldShowBanner: !appIsActive(),
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
  } catch {
    // Non-fatal: taps still work without the banner handler.
  }
  let sub: { remove(): void } | null = null;
  try {
    sub = notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
  } catch {
    sub = null;
  }
  return () => {
    try {
      sub?.remove();
    } catch {
      // ignore
    }
    handlerInstalled = false;
  };
}

/** Test-only reset of module session state. Never called by the app. */
// The Mac sends "Reply ready" with badge 1. Opening Hermes means you've
// seen it, so clear the app-icon badge on launch and on every return to the
// foreground. Never throws.
export async function clearBadge(): Promise<void> {
  try {
    await loadPushNative()?.notifications.setBadgeCountAsync?.(0);
  } catch {
    /* best effort */
  }
}

export function __resetPushForTests(): void {
  registeredToken = null;
  permissionDenied = false;
  inFlight = null;
  handlerInstalled = false;
  openSessionCb = null;
  pushNativeCache = undefined;
}
