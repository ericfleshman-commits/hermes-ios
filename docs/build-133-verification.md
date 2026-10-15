# Build 133 candidate: reply-state race remaining in 132

Status: local signed candidate only. Apple validation stalled twice and upload did not run. Build 132 remains the user's installed build.

## Evidence

The user confirms TestFlight build 132 is installed and still sees the stuck-chat symptom. Treat build 132 as failing on that phone, regardless of its passing release checks.

A live read-only resume probe of the Health chat returned in 207 ms with 521 bytes, running=false and status=resuming. This proves that probe returned; it does not reproduce the phone's event sequence.

Two new regression tests reproduced a remaining state race in the build-132 source. While a REST history fetch waits, a newer message.complete can set busy=false; the history continuation then reapplies the older running=true snapshot and the spinner returns. The reverse race can clear busy after a newer message.start. Both tests failed before the fix.

The fix applies the resume reply-state snapshot as soon as the live conversation ID binds, before model/history I/O. History completion and finally no longer reapply that snapshot, so newer reply events keep ownership of the state. This is a reproduced cause of a stuck spinner, not proof that it explains every part of the phone report or a missed completion event.

## Verified checks

- Final source tag native 2026-09-30.p117.
- 111 JavaScript tests passed, zero failed; one Python test passed.
- Typecheck, final-tag iOS export and Release simulator build passed.
- Signed Release device build passed; artifact CFBundleVersion 133.
- Code-signature verification passed; scripts/release_check.py found p117 and valid signing.
- App Store validation stalled at altool startup until the first enclosing tool deadline, then stalled again during a bounded 140-second validation attempt using parsed API settings.
- Apple exact-build lookup after the first timeout returned no build 133. No upload command ran on the retry because validation did not complete.
- Artifact: <scratch>/hermes-tf-133/Build/Products/Release-iphoneos/Hermes.app.
- Logs: <scratch>/hermes-133-*.log and hermes-tf-133-validate-retry.log.

No new native dependency, server or hosting change belongs to this fix. Existing expo-updates prep from build 132 remains. Physical-phone verification of this fix is pending delivery of a new build.
