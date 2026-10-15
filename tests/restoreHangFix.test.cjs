const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

// Regression tests for the 5-minute "Loading history..." hang (2026-10-08).
// Root cause: race between showCachedSession (SecureStore read) and
// restoreSession (fast socket connect). If restoreSession increments the
// generation while showCachedSession is awaiting, the old code returned early
// without setting cacheRenderedForRef, causing the blocking spinner to show
// despite cache existing.

test("showCachedSession sets cache marker before generation check (race fix)", () => {
  const src = fs.readFileSync("src/hooks/useSessionStore.ts", "utf8");
  // The marker assignment must come BEFORE the gen-stale early return.
  // Old code: gen check first, then marker (marker lost on race).
  // New code: marker set when cache loads, gen check only guards the render.
  const markerIdx = src.indexOf("cacheRenderedForRef.current = id;");
  const showCachedStart = src.indexOf("const showCachedSession = useCallback");
  const showCachedEnd = src.indexOf("}, []);", showCachedStart);
  const fnBody = src.slice(showCachedStart, showCachedEnd);
  const genCheckIdx = fnBody.indexOf("if (gen !== sessionRequestGenRef.current) return id;");
  const markerInFn = fnBody.indexOf("cacheRenderedForRef.current = id;");
  assert.ok(markerInFn !== -1, "marker assignment must exist in showCachedSession");
  assert.ok(genCheckIdx !== -1, "gen check must exist");
  assert.ok(markerInFn < genCheckIdx, "marker must be set BEFORE the gen-stale return");
});

test("session.create fallback has explicit 15s timeout", () => {
  const src = fs.readFileSync("src/hooks/useSessionStore.ts", "utf8");
  // Find the session.create fallback (not session.resume which already had timeout)
  const createIdx = src.indexOf('"session.create"');
  assert.ok(createIdx !== -1, "session.create call must exist");
  const snippet = src.slice(createIdx, createIdx + 200);
  assert.ok(snippet.includes("15000"), "session.create must have 15000ms timeout");
});

test("restore watchdog force-clears lock and spinner after 45s", () => {
  const src = fs.readFileSync("src/hooks/useSessionStore.ts", "utf8");
  assert.ok(src.includes("watchdog = typeof setTimeout"), "watchdog timer must exist");
  // Verify 45s duration
  const wdIdx = src.indexOf("watchdog = typeof setTimeout");
  const wdSnippet = src.slice(wdIdx, wdIdx + 800);
  assert.ok(wdSnippet.includes("45000"), "watchdog must be 45 seconds");
  assert.ok(wdSnippet.includes("restoreInflightRef.current = false"), "watchdog must clear inflight lock");
  assert.ok(wdSnippet.includes("setLoadingSession(false)"), "watchdog must clear spinner");
  assert.ok(src.includes("clearTimeout(watchdog)"), "watchdog must be cleared in finally");
});
