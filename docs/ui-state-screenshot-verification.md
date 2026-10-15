# Screenshot UI-state fixes, local verification

User screenshot: a device screenshot (not committed). The native app shows Offline together with a Running tool spinner, an outgoing message repeated in the composer, and disabled Send. This is a phone report, not an authenticated simulator reproduction.

Three regressions failed before their fixes:

- Returning to foreground with a healthy socket and cached busy=true skipped all reconciliation. The App now verifies the current session with attachSession before flushing pending text. Idle foreground behavior still uses the lighter tail refresh.
- Offline rendering kept a live ActivityIndicator and Running label for an unverified old reply. The live-running overlay now requires an open connection. The internal busy guard remains until reconciliation, avoiding a false claim that server work stopped.
- Connected text acceptance waited for remote acknowledgement while the optimistic message was already in the transcript. Text-only sends now use the existing durable one-message queue on both connected and disconnected paths. Composer acceptance follows the local write, not the remote reply, and the persisted submitting/uncertain states still prevent blind retry. Photo sends keep their existing upload path. A changed live target still rejects the connected callback.

Verified execution:

- 19 App integration tests passed.
- Full suite: 114 JavaScript tests passed, zero failed; one Python test passed.
- Typecheck and iOS export passed (720 modules).
- Release iOS simulator build passed.

Not verified or delivered by this work:

- No new signed device build, App Store validation, upload, or authenticated physical-phone interaction from these edits.
- Existing signed build-133 artifact predates these edits and must not be used to release them.
- Raw tool badge names, decorative thinking text, and broader visual polish remain unchanged. Do not claim the whole screenshot or the consumer-app experience is fixed.
- No new native dependency, hosting change, or server deduplication was added. The queue remains bounded to one text message.

Logs are under <scratch>/hermes-ui-state-*.log. The project vault handoff still blocks on read; this repo note records the checked scope instead.
