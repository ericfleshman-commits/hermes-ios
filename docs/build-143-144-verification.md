# Builds 143 and 144 verification

## Release mapping (established 2026-10-11)

- Builds 136 to 142 came from EAS cloud builds (`appVersionSource: remote`). The repo's literal `133` in `app.json` and `Info.plist` was stale until build 143.
- Mapping by App Store Connect upload time against commit times (inferred, not recorded in artifacts):
  - 140 (Oct 4 06:37 EDT): up to `d72cace`
  - 141 (Oct 5 22:00 EDT) and 142 (Oct 5 22:38 EDT): up to `ca89051`
- `7e94d40` (stale timeout banner) and `d82d3a4` (5-minute Loading hang) were in no binary before 143.
- OTA: the Expo update endpoint for channel `production`, runtime `1.0.0`, answers "no branches linked to the channel". No OTA update has ever been served; phones run only the embedded bundle. Earlier "it'll land via OTA" claims were not true.
- Push: `ios/Hermes/Hermes.entitlements` is empty and the local App Store profile has no `aps-environment`, so locally built binaries cannot receive push. Whether EAS-built 142 had it is unverified.
- Last device diagnostic upload: build 141, Oct 5 22:18 EDT.

## Build 143 (source `ad46cce`, number commit `6c63235`)

- Heal for uncertain sends decides only from a fresh server history fetch, with a pre-send baseline row id and a 60s minimum age before resending.
- Diag uploads report `unknown` instead of a fake `133`.
- Tag `native 2026-10-11.p118`. Tests 275/275, typecheck, iOS export, `release_check.py` passed.
- Apple: VALID, internal `IN_BETA_TESTING`. Beta group read is FORBIDDEN for this API key; group attachment unverified.

## Build 144 (source `9cd1e58`)

- Durable on-phone outbox (`src/lib/pendingSend.ts`, `expo-file-system` file with two alternating slots). Any number of texts, any chat; kept across kill/relaunch; legacy Keychain record imported once.
- Text send is never blocked by connection state or a running reply. Queued texts render as normal bubbles and send in order when the chat is live and idle, never to a chat the live link no longer matches.
- A kill mid-send becomes uncertain on relaunch (`settleAfterLaunch`), then the evidence-based heal decides; it retries on a timer.
- No Connecting/Offline/Reconnecting text; quiet status dot.
- `expo-file-system` 57.0.6 to 57.0.7 (already linked); `pod install` reordered `PrivacyInfo.xcprivacy` and added privacy bundles for already-linked modules.
- Tag `native 2026-10-11.p119`. Tests 283/283, typecheck, iOS export passed. Pushed to `origin/main`.

## Not yet verified

- Authenticated use on the phone of 143 or 144.
- Journey to try on the phone: airplane mode, open the app, send two texts, turn signal back on, confirm both arrive once and in order.

## Builds 145 and 146 (2026-10-11)

- 145 (source `3e7ae71`): push entitlement (`aps-environment=production`), App ID push capability, new App Store profile "Hermes App Store Push"; stuck-message warning after 10s with no link; drawer chat list cached on the phone.
- 146 (source `d943050`): push registration failures report their stage to diagnostics (never the token); no banner while the app is in the foreground.
- Mac side: plugin `~/.hermes/plugins/mobile-push` (enabled in config). Adds `push.register` to the phone's gateway (`com.eric.hermes-remote-gateway`, port 9220) and sends a text-free "Reply ready" push via Expo on `message.complete`, data `{sessionId: <stored id>}`. Tokens in `~/.hermes/push/tokens.json` (mode 600). It installs from a waiter thread because plugin discovery can run before `tui_gateway.server` is loaded.
- Phone-verified on build 146 by Eric: registration at 12:28 EDT; a direct test push arrived; a real reply sent while locked produced "Reply ready". Expo ticket and receipt both `ok`.
- Restarting `com.eric.hermes-remote-gateway` kills any reply in flight, including replies to messages sent from the phone. Check `/api/status` `active_agents` first.
- Open: Expo OTA updates still unpublished (no branch linked to `production`).

## OTA updates switched on (2026-10-11)

- Before: the `production` channel existed with no branch, so `u.expo.dev` answered "no branches linked". No OTA update had ever been published; earlier "it'll land via OTA" claims were wrong.
- EAS CLI signed in as `efleshman13` via browser OAuth approved in Aside; no password typed.
- First publish: `eas update --channel production --environment production --platform ios`, update group `5a15b741-a99a-48a8-88d0-31e4e23ecba4`, iOS update `01a12c02-0be5-71c9-bac2-7b93fe4b90fa`, runtime 1.0.0, commit `6276ccc` (same JS as build 146). The endpoint now serves it (HTTP 200).
- JS-only changes can now ship with `eas update`; native changes (entitlements, modules, runtimeVersion) still need a TestFlight build. `--environment` is required with `--non-interactive`.
- Phone-verified by Eric: after two relaunches the details screen shows update `01a12c02` (OTA applied on build 146).

## OTA p122 (2026-10-11): per-chat cache, send-once, badge

- Source: `48bf3fc` per-chat transcript cache (40 chats x 200 messages, two-slot files, eviction by save counter), `3d84482` send-once client (`prompt.submit_once` with the outbox id; -32601 falls back to `prompt.submit`), `5c2c9fe` badge cleared on launch and foreground, BUILD_TAG p122. 301 tests pass; the duplicate-spinner journey was checked to fail when the release line is removed.
- OTA: update group `97a5c3e4-ace1-4cf5-8e08-d9f49bb0e337`, iOS update `01a12d13-be07-7b0a-ace5-c741e1a8d6db`, runtime 1.0.0, served by `u.expo.dev`.
- Mac: mobile-push plugin now adds `prompt.submit_once` (ids in `~/.hermes/mobile/sent_ids.json`, 7-day TTL, released on a refused submit), chat title in the push body, `badge: 1`. Gateway restarted 18:27 EDT with 0 active agents; plugin installed in pid 82677.
- Not yet phone-verified: update applied, a send landing in `sent_ids.json`, title in the notification, badge cleared on open.
- Known gap: a gateway crash between reserving an id and starting the turn would make a retry answer "duplicate" with no reply. The history heal still runs before any resend.

## OTA p123 (2026-10-11): timings, diagnostics receiver, update safety net

- Found: the app's diag uploads went to `/api/client-logs`, which no longer exists; the newest file in `~/.hermes/logs/client-logs` was 2026-10-06. Every upload since was dropped.
- Mac: `~/.hermes/plugins/mobile-push/dashboard/{manifest.json,api.py}` serves `POST /api/plugins/mobile-push/client-logs` (behind the normal web login; 64 KB / 200 events; JSON lines in the old format). 17 plugin tests pass; discovery and trust gates verified in a test app. Live mount (Hermes hot-mounts plugin APIs on first request) is not yet proven: the local session key is refused without the login cookie, so the phone's first upload is the proof.
- App (`463848c`): timing events `launch_cached`, `launch_live`, `switch`, `send_ack`, `first_token`, `reply_done` (durations only); uploads go to the plugin address, failed uploads keep their events, and the app uploads when it goes to the background. 306 tests pass.
- Safety net: expo-updates 57.0.24 error recovery is on. An update that throws before the first screen appears and has never launched is marked failed and the app falls back. A crash after the first screen is not rolled back automatically.
- `scripts/ota-publish.sh "msg"` refuses unless the tree is clean, HEAD equals origin/main, and typecheck, tests and the iOS export all pass. `scripts/ota-undo.sh` republishes the previous group (`--embedded` reverts to the installed build's JS; or pass a group id). Updates on the branch before 2026-10-11 never reached a phone.
- Published with the script: group `80626535-7007-4147-86e5-12c3feb53654`, iOS update `01a1316e-919e-781f-8fa0-5f57de514396`, commit `abd8f92`. Undo selection checked (would republish `97a5c3e4…`, p122) without running it.
- Crash reports: App Store Connect shows 0 TestFlight crash or screenshot submissions; per-build diagnostic signatures return 404 for builds 141-146 (no data, not proof of no crashes).
