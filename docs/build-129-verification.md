# Build 129 verification and remaining device checks

Release: 2026-09-29, build 129, source tag native 2026-09-29.p114.
Release source: GitHub main 4e9527b624e794cb9e2abe29535374054ff6347b.

## Reproduced failures and changes

A failed drawer switch updated the selected title while retaining the previous live session ID. A test reproduced the old chat as the send target after the failed switch. Selecting a row now retires the previous live ID and transcript immediately, assigns the selected durable ID to the draft, and saves the chat ID and title in one SecureStore value. Cold launch no longer trusts the legacy separately stored title. A test using real React hooks checks the title, draft ID and live target after failure.

A queued send could follow a changed live ID after awaiting storage. A failing integration test reproduced submission to the changed target. The send now pins its live ID and checks the selected durable ID, live ID and gateway again after the write. If they changed before any RPC started, the message returns to queued for its original chat. A timeout after submission remains uncertain and does not auto-retry. Normal send callbacks also reject a retired or changed live ID.

The previously unshipped parallel cache-read change is included in this release. The one-piece bottom bar is unchanged. No native packages were added, and no backend or hosting changes were made.

## Verified execution

- 79 JavaScript tests passed; one Python test passed.
- Typecheck and iOS export passed.
- Release simulator build and signed Release device build passed.
- Artifact CFBundleVersion is 129; release check found p114.
- Code signature, App Store validation and upload passed.
- App Store Connect exact build affc92aa-2b65-45cc-8193-30f819fba43a reports processing VALID, usesNonExemptEncryption false and internal READY_FOR_BETA_TESTING after readback.
- Beta-group API read returned HTTP 403. Tester-group access and installation are not verified by the agent.
- Remote main was fetched after push and matches the release source commit.
- app.json and ios/Hermes/Info.plist build-129 changes were inspected and explicitly staged. release/ remains untracked and excluded.

## Not yet proven

This is not an authenticated physical-phone validation. Confirm selecting two distinct chats, failed loads, reopening the last chat, returning during a reply and cancelling/dispatching a queued text. Existing cached legacy title metadata may be discarded; selecting a chat records its ID/title together.

This release does not add server-side duplicate-send protection, an unlimited multi-chat offline archive or new background-reply guarantees. Do not call all persistence paths fixed from these build results. iOS may suspend the connection; no background-disconnect behavior was added or removed here.

The project vault at the private project notes still blocked on read after a bounded 12-second attempt. No vault edit was attempted. This note preserves the verified work until the vault is available.
