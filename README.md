# Hermes Mobile

A native iOS client for [Hermes Agent](https://github.com/NousResearch/hermes-agent), built for my own use and run daily against my own Hermes server.

It talks to a Hermes web dashboard over HTTPS and a WebSocket: cookie login, session list, streaming chat, image upload, model picker, and push notifications through a server plugin. Most of the work went into keeping it usable on a phone that drops connections: drafts survive restarts, sends go out exactly once, dropped sessions reattach, and the app uploads its own timing logs when something stalls.

Built with Expo and React Native. Updates ship over the air for JavaScript changes and through TestFlight for native ones.

## Running it

You need your own Hermes server with the dashboard enabled, reachable from your phone (I use a private Tailscale network).

1. `npm install`
2. Copy `gateway.example.json` to `gateway.local.json` and set `gatewayHost` to your server, for example `my-mac.my-tailnet.ts.net:9220`. Or set `HERMES_GATEWAY_HOST`. The build refuses to run without one.
3. `npm test`, then `npx expo start` or open `ios/` in Xcode.

## Status

Personal project, in flux, built for me. Issues are welcome; no promises about fixes.
