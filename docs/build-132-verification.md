# Build 132: never-strand UX + polish + EAS Update prep (verification)

Shipped 2026-09-30. Source: main at 61d79a9 (build-number bump commit;
content = 5a9223d never-strand UX pass, 4f1bc8b boring polish,
f2aabed EAS Update prep, 298f709 pod resource delta).

## Contents
- Persisted default model (modelPrefs.ts): fresh chats auto-apply default;
  the Choose-a-model dead-end is gone; send fills default before submitting.
- Honest async states: busy pill names in-flight work; Loading history bar;
  silent history-fetch catch now surfaces; busy UI only reflects real work.
- Failed history loads: error banner + labeled Retry (retryLoad); drafts kept.
- Failed sends: bubble keeps text, inline tap-to-retry via failedTurnsRef;
  no dropped text. Delivery-uncertain keeps its explicit row.
- Polish: haptics unified via responseHaptic.tapOnSend; keyboard wire-up
  verified; copyGuard fixes link-tap firing bubble copy; submitTurn retry
  with exponential backoff on pre-submit upload phase only (submit RPC stays
  single-attempt, no double-send).
- EAS Update prep: expo-updates installed + CocoaPods linked, runtimeVersion
  appVersion policy, updates.url placeholder (project id pending eas login).
  OTA dormant in this build; native rebuild (this one) was mandatory.

## Verified checks (on the Mac mini)
- node --test tests/*.test.cjs: 109/109 pass.
- python3 -m unittest discover -s tests: OK. tsc --noEmit: clean.
- build_testflight.sh BUILD_NUMBER=132 (profile Hermes App Store
  076bba9a-d864-4678-81ab-f1a94d1d7771): BUILD SUCCEEDED, bundle version 132,
  codesign verify PASS, IPA 8.1 MB.
- scripts/release_check.py: native 2026-09-30.p116; signing expires
  2027-09-18 (8476.5 h remain).
- altool --validate-app: PASSED. altool --upload-app: SUCCEEDED.

## App Store Connect (read back via API)
- Build 132 id 40bdd353-1151-4c47-abcd-4a44d7ec4650: processingState VALID.
- Export compliance patched: usesNonExemptEncryption=false (verified re-read).
- Beta-group read returned HTTP 403 (same as builds 129/130); internal
  testers auto-receive VALID builds (confirmed behavior from the 131 ship).

## Phone test (pending, Eric in Tokyo)
Open TestFlight, pull to refresh, install Hermes 1.0.0 (132), then verify:
default model pre-selected, honest loading states, retry banners on failure,
chat history loads. Physical-phone behavior unverified until installed.

## Not done
- No git push (local commits only, per standing rule).
- EAS Update still needs: eas login with the Expo account + eas init, then
  replace the updates.url placeholder. After that, eas update ships JS fixes
  OTA without TestFlight.
