const MAX_PLAYERS = 8;
const PROTOCOL_VERSION = 2;
const PLAYER_TYPES = {
  human: "真人",
  mathNightmare: "算法-噩梦",
  enhancedNightmare: "算法-噩梦 (加强版)",
  network: "网络玩家",
  disabled: "未加入",
};

function packet(action, sequenceID, fields = {}) {
  return { protocolVersion: PROTOCOL_VERSION, sequenceID, action, senderID: "server", ...fields };
}

function roomCodeFromPath(pathname) {
  const match = pathname.match(/^\/ws\/([0-9]{6})\/?$/);
  return match?.[1] ?? null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ service: "Color War WebSocket", protocolVersion: PROTOCOL_VERSION });
    }
    const roomCode = roomCodeFromPath(url.pathname);
    if (!roomCode) return new Response("Use /ws/<six-digit-room-code>", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const role = url.searchParams.get("role");
    if (role !== "host" && role !== "player") return new Response("Invalid room role", { status: 400 });
    const id = env.ROOMS.idFromName(roomCode);
    return env.ROOMS.get(id).fetch(request);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.sockets = new Map();
    this.sequence = 0;
    this.room = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const roomCode = roomCodeFromPath(url.pathname);
    const role = url.searchParams.get("role");
    const nickname = (url.searchParams.get("nickname") || "玩家").trim().slice(0, 32) || "玩家";
    if (!roomCode || (role !== "host" && role !== "player")) return new Response("Invalid room", { status: 400 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });

    if (role === "host") {
      if (this.room || this.sockets.size) return new Response("Room code is already in use", { status: 409 });
      this.room = { roomCode, started: false, firstPlayerIndex: 0, currentTurnIndex: null, movePending: false, config: null, snapshot: null, startPacket: null, players: new Map() };
    } else if (!this.room) {
      return new Response("Room not found", { status: 404 });
    }

    const usedSeats = new Set([...this.sockets.values()].map((entry) => entry.playerIndex));
    const playerIndex = role === "host" ? 0 : Array.from({ length: MAX_PLAYERS - 1 }, (_, i) => i + 1).find((i) => !usedSeats.has(i));
    if (playerIndex === undefined) return new Response("Room is full", { status: 409 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.set(server, { playerIndex, isHost: role === "host", nickname });
    this.room.players.set(playerIndex, nickname);

    server.addEventListener("message", (event) => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));

    this.send(server, packet("roomJoined", this.nextSequence(), {
      roomCode,
      playerIndex,
      isHost: role === "host",
      playerNames: this.playerNames(),
      playerTypes: this.playerTypes(),
    }));
    this.broadcastRoster();

    if (role !== "host") this.sendRoomState(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  nextSequence() { this.sequence += 1; return this.sequence; }

  playerNames() {
    const names = Array(MAX_PLAYERS).fill("");
    if (!this.room) return names;
    for (const [index, name] of this.room.players) names[index] = name;
    return names;
  }

  playerTypes() {
    const types = Array(MAX_PLAYERS).fill(PLAYER_TYPES.disabled);
    if (this.room?.config?.playerTypes) {
      for (let i = 0; i < MAX_PLAYERS; i++) types[i] = this.room.config.playerTypes[i] ?? types[i];
    }
    if (this.room) {
      for (const [index] of this.room.players) types[index] = index === 0 ? PLAYER_TYPES.human : PLAYER_TYPES.network;
    }
    return types;
  }

  rosterPacket() {
    return packet("roomRoster", this.nextSequence(), {
      roomCode: this.room?.roomCode,
      playerNames: this.playerNames(),
      playerTypes: this.playerTypes(),
    });
  }

  broadcastRoster() { this.broadcast(this.rosterPacket()); }

  // Replays need fresh room-wide sequence numbers; otherwise clients discard them as stale.
  sendRoomState(socket) {
    if (!this.room) return;
    if (this.room.config) {
      this.send(socket, { ...this.room.config, sequenceID: this.nextSequence() });
    }
    if (this.room.started && this.room.startPacket) {
      this.send(socket, { ...this.room.startPacket, sequenceID: this.nextSequence() });
      if (this.room.snapshot) {
        this.send(socket, { ...this.room.snapshot, sequenceID: this.nextSequence() });
      }
    }
  }

  send(socket, value) {
    try { socket.send(JSON.stringify(value)); } catch { this.onClose(socket); }
  }

  broadcast(value, except = null) {
    for (const socket of this.sockets.keys()) if (socket !== except) this.send(socket, value);
  }

  onMessage(socket, raw) {
    const participant = this.sockets.get(socket);
    if (!participant || !this.room || typeof raw !== "string" || raw.length > 64_000) return;
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.protocolVersion !== undefined && message.protocolVersion !== PROTOCOL_VERSION) return;

    const action = message.action;
    if (action === "ping") {
      this.send(socket, packet("ack", this.nextSequence()));
      return;
    }
    if (action === "leaveRoom") { try { socket.close(1000, "left room"); } catch {} return; }

    if (action === "renamePlayer") {
      const nickname = String(message.nickname || "").trim().slice(0, 32);
      if (!nickname) return;
      participant.nickname = nickname;
      this.room.players.set(participant.playerIndex, nickname);
      this.broadcastRoster();
      return;
    }

    if (action === "hostConfig") {
      if (!participant.isHost) return;
      const normalized = { ...message, sequenceID: this.nextSequence() };
      normalized.playerNames = Array.isArray(message.playerNames) ? message.playerNames.slice(0, MAX_PLAYERS) : this.playerNames();
      normalized.playerTypes = Array.isArray(message.playerTypes) ? message.playerTypes.slice(0, MAX_PLAYERS) : this.playerTypes();
      for (const [index, name] of this.room.players) {
        normalized.playerNames[index] = name;
        normalized.playerTypes[index] = index === 0 ? PLAYER_TYPES.human : PLAYER_TYPES.network;
      }
      this.room.config = normalized;
      this.broadcast(normalized, socket);
      return;
    }

    if (action === "startGame") {
      if (!participant.isHost) return;
      const firstPlayerIndex = Number(message.firstPlayerIndex);
      if (!Number.isInteger(firstPlayerIndex) || firstPlayerIndex < 0 || firstPlayerIndex >= MAX_PLAYERS) return;
      this.room.started = true;
      this.room.movePending = false;
      this.room.snapshot = null;
      this.room.currentTurnIndex = firstPlayerIndex;
      this.room.startPacket = { ...message, firstPlayerIndex, sequenceID: this.nextSequence() };
      this.broadcast(this.room.startPacket, socket);
      return;
    }

    if (action === "stateSnapshot") {
      if (!participant.isHost) return;
      this.room.snapshot = { ...message, sequenceID: this.nextSequence() };
      if (Number.isInteger(message.currentTurnIndex)) this.room.currentTurnIndex = message.currentTurnIndex;
      this.room.movePending = false;
      this.broadcast(this.room.snapshot, socket);
      return;
    }

    if (action === "syncRequest") {
      if (participant.isHost) return;
      this.broadcast({ ...message, sequenceID: this.nextSequence() }, socket);
      return;
    }

    if (action === "playerMove") {
      const playerIndex = Number(message.playerIndex);
      if (!this.room.started || this.room.movePending || !Number.isInteger(playerIndex)) return;
      if (playerIndex !== this.room.currentTurnIndex) return;
      const isOwnSeat = playerIndex === participant.playerIndex;
      const playerType = this.room.config?.playerTypes?.[playerIndex];
      const isAI = playerType === PLAYER_TYPES.mathNightmare || playerType === PLAYER_TYPES.enhancedNightmare;
      if (!isOwnSeat && !(participant.isHost && isAI)) return;
      if (!Number.isInteger(message.row) || !Number.isInteger(message.col) || message.row < 0 || message.row >= 12 || message.col < 0 || message.col >= 12) return;
      this.room.movePending = true;
      this.broadcast({ ...message, playerIndex, sequenceID: this.nextSequence() }, socket);
      return;
    }
  }

  onClose(socket) {
    const participant = this.sockets.get(socket);
    if (!participant) return;
    this.sockets.delete(socket);
    if (!this.room) return;
    this.room.players.delete(participant.playerIndex);

    if (participant.isHost) {
      this.broadcast(packet("roomClosed", this.nextSequence(), { message: "房主已离开房间" }));
      for (const peer of this.sockets.keys()) { try { peer.close(1000, "host left"); } catch {} }
      this.sockets.clear();
      this.room = null;
      return;
    }

    this.broadcast(packet("playerLeft", this.nextSequence(), {
      playerIndex: participant.playerIndex,
      message: `${participant.nickname} 已离开房间`,
    }));
    this.broadcastRoster();
  }
}
