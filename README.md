# Color War WebSocket room server

The Worker routes `wss://<deployed-host>/ws/<6-digit-room-code>?role=host|player&nickname=...` to a Durable Object dedicated to that room. Web and iOS use the same protocol-v2 `P2PPacket` JSON envelope. A room host owns configuration, starts and authoritative snapshots; each player may submit moves only for its assigned seat. Online seat roles are server-owned and cannot be changed by clients. The board size is fixed at match start. The Worker assigns monotonically increasing sequence IDs and forwards packets to the other sockets.

## Deploy

1. Install Node.js 20+ and run `npm install` in this folder.
2. Run `npx wrangler login` once, then `npm run deploy`.
3. The currently deployed Worker is `https://colorwar-server.wujiyan2009.workers.dev`; both clients use it by default. Either `https://` or `wss://` is accepted; the clients open `/ws/<room-code>` automatically.
4. Check `https://colorwar-server.wujiyan2009.workers.dev/health` for the service name and protocol version 2.

Deploy future server changes with `npm run deploy` from this folder after signing in to the owning Cloudflare account.

## Protocol

- Host and players connect to `/ws/<code>?role=host|player&nickname=<name>`. The host resume credential is sent only in the `X-ColorWar-Host-Token` request header, never in the URL.
- Server events: `roomJoined`, `roomRoster`, `roomError`, `playerLeft`, `roomClosed`.
- Game packets use the existing v2 actions: `hostConfig`, `playerMove`, `syncRequest`, `startGame`, `stateSnapshot`, `ping`, `ack`.
- Room state and the latest authoritative snapshot are persisted in the room Durable Object for up to 2 hours of inactivity. This is a recovery cache, not permanent match history.
- If the host transport disconnects during a match, the room is suspended instead of ended; guests are told the host disconnected, and moves are rejected until the host resumes. The host can reclaim the room only with its saved resume token. An intentional host `leaveRoom` still ends the room.
- On app foreground, clients should reconnect with their saved room identity and request/receive the latest snapshot. This restores game state after suspension; it does not keep an iOS WebSocket alive in the background.
- Before a match, a disconnected guest frees their seat. During a match, only a seat vacated by a disconnected player can be reclaimed; a new participant cannot join into an unused seat.
- Expired rooms are closed and deleted by the Durable Object alarm.

## ActivityKit / Dynamic Island push

The iOS client starts a Live Activity for an online room, displays the board preview and turn in the expanded Dynamic Island and lock screen, and registers the ActivityKit push token over that participant's active room WebSocket. The server sends best-effort ActivityKit update pushes after accepting authoritative board snapshots. The widget itself has no network connection; an APNs update changes its displayed state but does not keep the game process or WebSocket running.

To enable remote Live Activity updates, enable Live Activities and Push Notifications for the app's Apple Developer App ID, configure a matching signed bundle ID and provisioning profile, and create an APNs authentication key. Set these Worker secrets with Wrangler (paste the private key only into the secret prompt):

```sh
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_PRIVATE_KEY
npx wrangler secret put APNS_BUNDLE_ID
```

`APNS_PRIVATE_KEY` is the `.p8` key contents and must never be committed. The app registers ActivityKit push tokens; it does not expose APNs credentials. Set optional `APNS_HOST` to exactly `https://api.push.apple.com` (production, default) or `https://api.sandbox.push.apple.com` (development), matching the token environment. The sample XcodeGen project uses `com.example.ColorWarAI`; replace it with the actual app identifier before signing and distribution. `ColorWarAI.entitlements` is a development template; use a production entitlement/provisioning profile for distribution. An unsigned IPA cannot register APNs tokens or receive operational pushes.

The server may retain a room for up to two hours and can restore its last committed snapshot when the host reconnects. An interrupted, not-yet-snapshotted move is discarded. This is the practical mitigation for app suspension; iOS may suspend the app, delay or throttle pushes, so a permanently live WebSocket is not achievable through APNs. The XcodeGen project/workflow has not been executed here; build and physical-device validation still require macOS with Xcode, valid signing, configured secrets and a deployed server.
