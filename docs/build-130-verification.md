# Build 130: reconnect draft safety

Release: 2026-09-29, TestFlight build 130, source tag native 2026-09-29.p115.

## User report

While the app showed Connecting, typed message text disappeared. The user wants to open the app and type immediately. The exact physical-phone sequence, including whether Send was tapped, has not been reproduced by the agent.

## Reproduced paths

1. The connected composer ignored a rejected send and cleared the draft. A new test failed with an empty input instead of the entered text.
2. The App wrapper reported successful acceptance even when the send guard rejected a stale live conversation. A new test failed with true instead of false.
3. Accepted offline text left the input but had no visible message preview, only a Waiting to send status. A new test failed because the conversation had no queued-text preview.

Each regression failed before its corresponding fix. The composer now awaits acceptance for both connected and offline sends, keeps rejected drafts, guards against clearing newer edits or a different chat, and blocks repeated taps while acceptance is pending. The App reports pre-send rejection explicitly and checks the actual gateway state. Queued text now appears as a user-message preview with Waiting to send, scoped to its original chat.

This preserves the existing bounded one-message offline queue. It does not add multiple queued turns, offline photo submission, server deduplication, or a persistent background socket. A connected send can keep the input populated until acknowledgement; new edits remain protected. The exact phone report is not yet proven fixed.

## Verified checks

- 82 JavaScript tests passed, zero failed; one Python test passed.
- Typecheck, final-tag iOS export (719 modules), and Release simulator build passed.
- Signed Release device build, artifact version 130, code-signature verification, App Store validation and upload passed.
- Artifact release check found native 2026-09-29.p115.
- App Store Connect exact build 7e7ac712-1232-47bc-bc59-0ef33335b0e3: processing VALID, usesNonExemptEncryption false, internal READY_FOR_BETA_TESTING, all read back after upload/compliance update.
- Beta-group read returned HTTP 403. Tester access, installation and authenticated phone interaction remain unverified.
- Existing test-renderer and Xcode build-script warnings remain. No independent reviewer tool was available; tests and a self-review are not an independent review.

## Device acceptance check

Open the selected saved chat, type while Connecting, and tap Send. The text must remain either in the input or in a visible Waiting to send message, never vanish. After reconnecting, verify it appears once in the same conversation. Also type more while a send is pending and verify late completion does not erase the new draft.

The one-piece dock remains unchanged. No native package, hosting or backend changes were made. Obsolete release/ artifacts must remain excluded from source commits.
