// Cookie-session auth: password login sets HttpOnly cookies via the server's
// session middleware (which transparently rotates them on expiry). React Native
// persists cookies per-app automatically, so no manual token storage is needed.
// The old bearer-token flow called /auth/password-login with `native: true` and
// expected {access_token} back — the server never implemented that body flag, so
// login "failed" even with correct credentials. This module now matches the
// server contract exactly.
import Constants from "expo-constants";

export const HOST: string =
  (Constants.expoConfig?.extra as any)?.gatewayHost ?? "";
export const BASE = `https://${HOST}`;

const PW_KEY = "hermes.dash.password";
const USER_KEY = "hermes.dash.username";

// Kept for the silent re-login path only. The server holds the real session in
// HttpOnly cookies we can't (and shouldn't) touch.
async function getStoredPassword(): Promise<string> {
  try {
    const { getItemAsync } = require("expo-secure-store");
    return (await getItemAsync(PW_KEY)) ?? "";
  } catch {
    return "";
  }
}

async function getStoredUsername(): Promise<string> {
  try {
    const { getItemAsync } = require("expo-secure-store");
    return (await getItemAsync(USER_KEY)) ?? "";
  } catch {
    return "";
  }
}

export async function loadSavedCreds(): Promise<{ username: string } | null> {
  const username = await getStoredUsername();
  return username ? { username } : null;
}

export async function isAuthed(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/auth/me`, { credentials: "include" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function login(username: string, password: string): Promise<void> {
  if (!password) throw new Error("Password required");
  if (!username) throw new Error("Username required");
  let res: Response;
  try {
    res = await fetch(`${BASE}/auth/password-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        provider: "basic",
        username,
        password,
        next: "/",
      }),
    });
  } catch {
    throw new Error("Can't reach the mini (network/Tailscale down?)");
  }
  if (res.status === 401) throw new Error("Wrong username or password");
  if (res.status === 429) throw new Error("Too many attempts — wait a moment and retry");
  if (!res.ok) throw new Error(`Login failed (${res.status})`);
  // Server set session cookies in the native cookie store. Persist credentials
  // so silentLogin() can rebuild the session after the server restarts or the
  // cookies expire.
  try {
    const { setItemAsync } = require("expo-secure-store");
    await setItemAsync(USER_KEY, username);
    await setItemAsync(PW_KEY, password);
    await setItemAsync("hermes.dash.hadLogin", "1");
  } catch {}
}

// Re-login from stored credentials. Used after a 401 or when /api/auth/me
// reports no live session. Returns false if nothing is stored or the re-login
// fails (caller then shows the login screen).
export async function silentLogin(): Promise<boolean> {
  const username = await getStoredUsername();
  const password = await getStoredPassword();
  if (!username || !password) return false;
  try {
    await login(username, password);
    return true;
  } catch {
    return false;
  }
}

export async function authFetch(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  let res = await fetch(url, { ...init, headers, credentials: "include" });
  // 401: server-side refresh couldn't run (cookies expired, backend restarted).
  // Re-login from stored credentials once, then retry the original request.
  if (res.status === 401 && retry) {
    if (await silentLogin()) {
      res = await fetch(url, { ...init, headers, credentials: "include" });
    }
  }
  return res;
}

export interface TicketBundle {
  ticket: string;
  // Inline session.resume payload minted with the ticket (the exact
  // JSON-RPC response object of session.resume, i.e. {id, result}).
  // Present only when the mint carried a valid ?session_id=.
  sessionResume?: any;
  // The session id the inline resume was minted for. The ticket itself is
  // NOT session-bound -- only sessionResume is gated on this match.
  forSessionId?: string;
}

export async function getWsTicket(sessionId?: string): Promise<TicketBundle> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const mint = (sid?: string) =>
      authFetch(
        sid
          ? `${BASE}/api/auth/ws-ticket?session_id=${encodeURIComponent(sid)}`
          : `${BASE}/api/auth/ws-ticket`,
        { method: "POST", signal: ctrl.signal },
      );
    let res = await mint(sessionId);
    // The backend mints NO ticket for an unknown/expired id (404/422), so a
    // rejected inline-resume mint must be re-minted clean, without the param.
    if ((res.status === 404 || res.status === 422) && sessionId) {
      res = await mint(undefined);
    }
    if (!res.ok) throw new Error(`ws-ticket failed (${res.status})`);
    const body = await res.json();
    if (!body?.ticket) throw new Error("ws-ticket response was empty");
    // session_resume is the exact JSON-RPC response of session.resume: unwrap
    // .result like gw.request() does. An error payload counts as absent.
    const raw = body.session_resume;
    const sessionResume = raw && !raw.error ? raw : undefined;
    return { ticket: body.ticket, sessionResume, forSessionId: sessionId };
  } finally {
    clearTimeout(timer);
  }
}

// The durable session id the next connect will want to resume. Mirrors the
// selection read in useSessionStore (hermes.m.selection.v1, legacy
// hermes.m.storedSession). Undefined on a cold boot with no saved chat.
export async function readStoredSessionId(): Promise<string | undefined> {
  try {
    const { getItemAsync } = require("expo-secure-store");
    const raw = await getItemAsync("hermes.m.selection.v1");
    if (raw) {
      const value = JSON.parse(raw);
      if (typeof value?.sessionId === "string" && value.sessionId) {
        return value.sessionId;
      }
    }
    return (await getItemAsync("hermes.m.storedSession")) || undefined;
  } catch {
    return undefined;
  }
}

// --- Warm WS-ticket cache --------------------------------------------------
// The ticket mint (POST /api/auth/ws-ticket) costs a full HTTPS round trip
// ahead of every WS dial. Server tickets are single-use with a 30 s TTL
// (backend: dashboard_auth.ws_tickets.TTL_SECONDS), so a cached ticket is
// only ever good for ONE connect attempt inside its TTL -- ideal for
// speculative prefetch: mint while a dead socket is being retired and the
// next connect (backoff retry, zombie-probe failover, quick background
// return) skips the mint entirely.
//
// Single-use safety: a ticket LEAVES the cache the moment it is handed out
// (takeWarmTicket), so it can never be presented twice -- even if the dial
// fails after handoff, the retry mints fresh exactly like today. The
// client-side freshness margin (25 s) sits safely under the server 30 s TTL,
// so a handed-out ticket is always still consumable; the 5 s margin covers
// phone<->mini clock skew plus the mint flight time.
//
// Failure behavior is unchanged: prefetch failures are swallowed (the next
// connect mints fresh on demand) and takeWarmTicket never throws.
//
// The cache holds the full ticket bundle, including any inline session
// resume the mint returned. The ticket itself is not session-bound, so a
// bundle minted for one session still dials fine for another -- only the
// inline resume is gated on a forSessionId match at the consume site.
const TICKET_FRESH_MS = 25_000;
let warmTicket: { bundle: TicketBundle; mintedAt: number } | null = null;
let warmTicketInflight: Promise<void> | null = null;

// Mint a ticket in the background and keep it warm for the next connect.
// Idempotent: concurrent calls share one mint, and a still-fresh ticket is
// never replaced. Never throws -- a failed mint just leaves the cache
// empty so the next connect mints on demand.
export function prefetchWsTicket(): Promise<void> {
  if (warmTicket && Date.now() - warmTicket.mintedAt < TICKET_FRESH_MS) {
    return Promise.resolve();
  }
  if (!warmTicketInflight) {
    warmTicketInflight = (async () => {
      try {
        // Learn the session id at mint time so the backend can run
        // session.resume inline. Fire-and-forget inside the prefetch: the
        // signature stays unchanged for callers. No stored session (cold
        // boot) mints a plain ticket -- the connect then takes the normal
        // slow path, which is correct.
        const bundle = await getWsTicket(await readStoredSessionId());
        warmTicket = { bundle, mintedAt: Date.now() };
      } catch {
        // Speculative by design: failure is silent, the next connect
        // mints fresh.
      } finally {
        warmTicketInflight = null;
      }
    })();
  }
  return warmTicketInflight;
}

// Hand out the warm ticket bundle for a connect attempt, or null when none
// is fresh. Consumes it: every ticket is handed out at most once, matching
// the server single-use semantics.
export function takeWarmTicket(): TicketBundle | null {
  const w = warmTicket;
  warmTicket = null;
  if (!w || Date.now() - w.mintedAt >= TICKET_FRESH_MS) return null;
  return w.bundle;
}

export async function fetchJSON<T = any>(path: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await authFetch(`${BASE}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Legacy no-ops kept so any stray import keeps compiling. The cookie store
// replaced manual bearer tokens.
export async function getSessionToken(): Promise<string> {
  return "";
}

export async function saveSessionToken(_token: string): Promise<void> {}

export async function authHeaders(): Promise<Record<string, string>> {
  return {};
}
