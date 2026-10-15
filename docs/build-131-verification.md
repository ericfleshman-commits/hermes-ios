# Build 131: chat loading fixes (verification)

Release: prepared 2026-09-30, build 131, source tag native 2026-09-30.p116.
Build 130 (reconnect draft safety) was uploaded to TestFlight 2026-09-29 and is
READY_FOR_BETA_TESTING, but it does NOT contain these loading fixes. The loading
fixes were written after the 130 upload (Sep 30 ~05:30 UTC) by the previous agent
session, which stalled on a tool-call limit before finishing verification.

## User report

On the physical phone the app showed a stuck Thinking pill, an empty chat
("Your conversation starts here"), and chats never loading, even though the
backend was reachable (Live indicator on). The user chats were never at risk:
68k+ messages remain in ~/.hermes/state.db on the Mac mini.

## Reproduced paths (all covered by tests, each failed before its fix)

1. Opening a chat set the app to busy/Thinking while only loading history, which
   blocked the composer even though no agent reply was running. Fixed in
   src/hooks/useSessionStore.ts: the transcript-load path no longer calls
   onSetBusy(true). Loading a transcript is not an agent turn.
2. Opening a chat downloaded the full transcript over the resume RPC (observed
   1,366 messages / 3.1 MB in a live probe) instead of the lighter resume
   (22 KB). Fixed: session.resume now passes omit_messages + defer_history +
   inline_images false with an explicit 15000 ms timeout in resumeSession,
   restoreSession and attachSession.
3. Selecting a chat sat blank behind the network resume. Fixed: the saved
   transcript cache paints first (transcriptCacheRef / loadTranscript) before
   the resume RPC resolves.
4. The history fetch timeout was cleared when response headers arrived, so a
   stalled body could load forever. Fixed in src/lib/auth.ts: fetchJSON now
   awaits res.json() inside the try, keeping the deadline active through body
   parsing.

Also included: send() now returns boolean acceptance (App.tsx), the composer
awaits acceptance for connected sends and keeps rejected drafts (Composer.tsx),
and queued text renders as a Waiting to send preview (App.tsx). No native
packages added; no backend or hosting changes. No expo-updates/OTA channel is
configured, so this must ship as a full native build.

## Verified checks (2026-09-30, on the Mac mini)

- 88 JavaScript tests passed, 0 failed (node --test tests/*.test.cjs).
- 1 Python test passed (python3 -m unittest discover -s tests).
- tsc --noEmit clean.
- expo export --platform ios succeeded.
- Release simulator build (xcodebuild, generic/platform=iOS Simulator) succeeded.

## Upload: PENDING (not performed)

Ship steps when approved: signed Release device build, then
scripts/release_check.py, code-signature verification, App Store validation,
upload, App Store Connect processing, export compliance
(usesNonExemptEncryption false), READY_FOR_BETA_TESTING, assign to the beta
group, install via TestFlight on the phone in Tokyo. Known gap from builds
129/130: the beta-group API read returned HTTP 403, so tester-group assignment
must be confirmed or the phone will not see the new build. Physical-phone
loading behavior remains unverified until the new build is installed and a chat
is opened.
