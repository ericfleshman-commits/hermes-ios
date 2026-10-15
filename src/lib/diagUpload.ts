// Phase 2: fire-and-forget upload of buffered diagnostic events to the mini.
//
// Contract: POST {BASE}/api/client-logs with
//   { app, version, buildNumber, deviceId, uploadedAt, events[] }.
// Client caps: ≤200 events/upload, ≤64KB JSON, ≤1 upload per 5 minutes.
// Best-effort: failures are caught and dropped; this module never throws
// and is never awaited on the UI/chat path.
import { BASE, authFetch } from "./auth";
import { diagLog, drainDiag, restoreDiag, type DiagEvent } from "./diagLog";

// Served by the mobile-push plugin on the Mac (~/.hermes/plugins/mobile-push/dashboard/api.py).
const ENDPOINT = "/api/plugins/mobile-push/client-logs";
const APP_NAME = "hermes-ios";
const MAX_EVENTS_PER_UPLOAD = 200;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MIN_UPLOAD_INTERVAL_MS = 5 * 60 * 1000;
const UPLOAD_TIMEOUT_MS = 15000;
const DEVICE_ID_KEY = "hermes.dash.deviceId";
const SERVER_ERROR_MESSAGE_CHARS = 120;

let lastUploadAt = 0;
let inFlight = false;
let cachedDeviceId: string | null = null;

function utf8ByteLen(s: string): number {
  try {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          n += 4;
          i++;
        } else n += 3;
      } else n += 3;
    }
    return n;
  } catch {
    return s.length * 2;
  }
}

function appMeta(): { version: string; buildNumber: string } {
  try {
    // Lazy require like auth.ts: keeps this module importable in plain
    // node (tests) where expo-constants doesn't exist.
    const mod = require("expo-constants") as {
      default?: { expoConfig?: { version?: unknown }; platform?: { ios?: { buildNumber?: unknown } } };
      expoConfig?: { version?: unknown };
      platform?: { ios?: { buildNumber?: unknown } };
    };
    const c = mod?.default ?? mod;
    const version =
      typeof c?.expoConfig?.version === "string" && c.expoConfig.version ? c.expoConfig.version : "1.0.0";
    // The real native build number: CFBundleVersion baked into the binary,
    // served by expo-constants' already-linked native module
    // (Constants.platform.ios.buildNumber). expoConfig.ios.buildNumber is
    // deliberately not used — it reflects the JS manifest/config and can be
    // stale or absent in a shipped binary. With no native module (unit
    // tests, web) report "unknown": a made-up number misled release mapping.
    const nbv = c?.platform?.ios?.buildNumber;
    const buildNumber = typeof nbv === "string" && nbv ? nbv : "unknown";
    return { version, buildNumber };
  } catch {
    return { version: "1.0.0", buildNumber: "unknown" };
  }
}

function newDeviceId(): string {
  try {
    const h = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    const a = h();
    const b = h();
    const c = h();
    return `${a.slice(0, 8)}-${b.slice(0, 4)}-4${b.slice(4, 7)}-${((parseInt(c.slice(0, 2), 16) & 0x3f) | 0x80)
      .toString(16)}${c.slice(2, 4)}-${c.slice(4, 8)}${a.slice(0, 4)}${b.slice(0, 4)}`;
  } catch {
    return `diag-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

// Stable per-install uuid, persisted in SecureStore. Falls back to a
// session-scoped id when SecureStore is unavailable (never throws).
// Exported so push registration reuses the same device identity.
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const { getItemAsync, setItemAsync } = require("expo-secure-store") as {
      getItemAsync: (k: string) => Promise<string | null>;
      setItemAsync: (k: string, v: string) => Promise<void>;
    };
    let id = await getItemAsync(DEVICE_ID_KEY);
    if (!id) {
      id = newDeviceId();
      try {
        await setItemAsync(DEVICE_ID_KEY, id);
      } catch {
        // Persist failed; keep the in-memory id for this session.
      }
    }
    cachedDeviceId = id;
    return id;
  } catch {
    if (!cachedDeviceId) cachedDeviceId = newDeviceId();
    return cachedDeviceId;
  }
}

function payloadBody(events: DiagEvent[], deviceId: string): { body: string; count: number } {
  const meta = appMeta();
  const envelope = (evts: DiagEvent[]) =>
    JSON.stringify({
      app: APP_NAME,
      version: meta.version,
      buildNumber: meta.buildNumber,
      deviceId,
      uploadedAt: new Date().toISOString(),
      events: evts,
    });
  // Most recent events win: an old stall matters less than the failure that
  // just happened.
  let evts = events.slice(-MAX_EVENTS_PER_UPLOAD);
  let body = envelope(evts);
  while (evts.length > 1 && utf8ByteLen(body) > MAX_PAYLOAD_BYTES) {
    evts = evts.slice(-Math.max(1, Math.floor(evts.length / 2)));
    body = envelope(evts);
  }
  return { body, count: evts.length };
}

function safeMessage(e: unknown): string {
  try {
    const m =
      typeof e === "object" && e !== null && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e);
    return m.slice(0, SERVER_ERROR_MESSAGE_CHARS);
  } catch {
    return "unknown";
  }
}

async function doUpload(events: DiagEvent[]): Promise<void> {
  const deviceId = await getDeviceId();
  const { body, count } = payloadBody(events, deviceId);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await authFetch(`${BASE}${ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    if (res.status !== 202) {
      throw new Error(`client-logs upload rejected (${res.status}, ${count} events)`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drain the diagnostic buffer and upload it, fire-and-forget.
 * Rate-limited to one upload per 5 minutes; no-ops when the buffer is empty
 * or an upload is already in flight. Never throws, never rejects.
 */
export function maybeUploadDiag(): void {
  try {
    const now = Date.now();
    if (inFlight) return;
    if (now - lastUploadAt < MIN_UPLOAD_INTERVAL_MS) return;
    const events = drainDiag();
    if (events.length === 0) return;
    // Reserve the rate-limit slot before the async work starts so a burst of
    // error paths can't queue parallel uploads.
    lastUploadAt = now;
    inFlight = true;
    void (async () => {
      try {
        await doUpload(events);
      } catch (e) {
        // Keep the events for the next try (e.g. Tailscale was off), then
        // record the failure itself as metadata. Never user content.
        restoreDiag(events);
        diagLog("rpc_error", {
          method: `POST ${ENDPOINT}`,
          reason: "upload_failed",
          message: safeMessage(e),
        });
      } finally {
        inFlight = false;
      }
    })();
  } catch {
    // Never break the caller.
  }
}

/** Test-only: reset the rate limiter, in-flight guard, and device id cache. */
export function __resetDiagUploadForTests(): void {
  lastUploadAt = 0;
  inFlight = false;
  cachedDeviceId = null;
}
