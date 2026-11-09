# Color War WebSocket room server

The Worker routes `wss://<deployed-host>/ws/<6-digit-room-code>?role=host|player&nickname=...` to a Durable Object dedicated to that room. Web and iOS use the same protocol-v2 `P2PPacket` JSON envelope. A room host owns configuration, starts and authoritative snapshots; each player may submit moves only for its assigned seat. The Worker assigns monotonically increasing sequence IDs and forwards packets to the other sockets.

## Deploy

1. Install Node.js 20+ and run `npm install` in this folder.
2. Run `npx wrangler login` once, then `npm run deploy`.
3. Copy the deployed `workers.dev` base URL into the Web app's “WebSocket 服务地址” field and the iOS app's “Worker 服务地址” field. Either `https://` or `wss://` is accepted; the clients open `/ws/<room-code>` automatically.
4. Verify `https://<deployed-host>/health` returns the service name and protocol version 2.

This repository does not contain Cloudflare credentials or an account-specific `workers.dev` hostname; deploying is required before public rooms can connect.

## Protocol

- Host and players connect to `/ws/<code>?role=host|player&nickname=<name>`.
- Server events: `roomJoined`, `roomRoster`, `roomError`, `playerLeft`, `roomClosed`.
- Game packets use the existing v2 actions: `hostConfig`, `playerMove`, `syncRequest`, `startGame`, `stateSnapshot`, `ping`, `ack`.
- Rooms are ephemeral: the host closing its socket closes the room; no durable match history is stored.
