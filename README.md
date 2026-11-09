# Color War WebSocket room server

The Worker routes `wss://<deployed-host>/ws/<6-digit-room-code>?role=host|player&nickname=...` to a Durable Object dedicated to that room. Web and iOS use the same protocol-v2 `P2PPacket` JSON envelope. A room host owns configuration, starts and authoritative snapshots; each player may submit moves only for its assigned seat. Online seat roles are server-owned and cannot be changed by clients. The board size is fixed at match start. The Worker assigns monotonically increasing sequence IDs and forwards packets to the other sockets.

## Deploy

1. Install Node.js 20+ and run `npm install` in this folder.
2. Run `npx wrangler login` once, then `npm run deploy`.
3. The currently deployed Worker is `https://colorwar-server.wujiyan2009.workers.dev`; both clients use it by default. Either `https://` or `wss://` is accepted; the clients open `/ws/<room-code>` automatically.
4. Check `https://colorwar-server.wujiyan2009.workers.dev/health` for the service name and protocol version 2.

Deploy future server changes with `npm run deploy` from this folder after signing in to the owning Cloudflare account.

## Protocol

- Host and players connect to `/ws/<code>?role=host|player&nickname=<name>`.
- Server events: `roomJoined`, `roomRoster`, `roomError`, `playerLeft`, `roomClosed`.
- Game packets use the existing v2 actions: `hostConfig`, `playerMove`, `syncRequest`, `startGame`, `stateSnapshot`, `ping`, `ack`.
- Rooms are ephemeral: the host closing its socket closes the room; no durable match history is stored.
- Before a match, a disconnected player frees their seat. During a match, only a seat vacated by a disconnected player can be reclaimed; a new participant cannot join into an unused seat.
