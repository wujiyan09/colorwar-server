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

export function isValidActivityPushToken(value) {
  return typeof value === "string" && /^[0-9a-fA-F]{64,256}$/.test(value);
}

export function shouldAlertForActivityTurn(seatIndex, previousTurnIndex, currentTurnIndex) {
  return Number.isInteger(currentTurnIndex) && currentTurnIndex === seatIndex
    && previousTurnIndex !== currentTurnIndex;
}

export function buildActivityContentState(snapshot, seatIndex, hostDisconnected = false) {
  const size = Number(snapshot?.boardSize);
  if (!Number.isInteger(size) || size < 5 || size > 12) return null;
  const rows = Array.from({ length: size }, () => Array(size).fill("0"));
  for (const cell of Array.isArray(snapshot.compactBoardSnapshot) ? snapshot.compactBoardSnapshot : []) {
    if (!Number.isInteger(cell?.r) || !Number.isInteger(cell?.c) || !Number.isInteger(cell?.owner)
      || !Number.isInteger(cell?.count) || cell.r < 0 || cell.r >= size || cell.c < 0 || cell.c >= size
      || cell.owner < 0 || cell.owner >= MAX_PLAYERS || cell.count < 1) continue;
    const encoded = cell.owner * 4 + Math.min(cell.count, 3);
    rows[cell.r][cell.c] = encoded.toString(36).toUpperCase();
  }
  const currentPlayer = Number(snapshot.currentTurnIndex);
  const playerNames = Array.isArray(snapshot.playerNames) ? snapshot.playerNames : [];
  const colors = Array.isArray(snapshot.colorsHex) ? snapshot.colorsHex : [];
  const isMyTurn = !hostDisconnected && Number.isInteger(currentPlayer) && seatIndex === currentPlayer;
  return {
    boardRows: rows.map((row) => row.join("")),
    boardSize: size,
    currentPlayer: Number.isInteger(currentPlayer) ? currentPlayer : 0,
    currentPlayerName: typeof playerNames[currentPlayer] === "string" ? playerNames[currentPlayer] : "玩家",
    colors: Array.from({ length: MAX_PLAYERS }, (_, i) => {
      if (typeof colors[i] !== "string") return "808080";
      const hex = colors[i].replace(/[^0-9a-f]/gi, "");
      return /^[0-9a-f]{6,8}$/i.test(hex) ? hex.slice(0, 6).toUpperCase() : "808080";
    }),
    isMyTurn,
    status: hostDisconnected ? "房主断线，等待恢复" : (isMyTurn ? "轮到你了" : "等待对手落子"),
  };
}

function base64url(bytesOrString) {
  const bytes = typeof bytesOrString === "string" ? new TextEncoder().encode(bytesOrString) : bytesOrString;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemBytes(pem) {
  const base64 = String(pem || "").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function createAPNsJWT(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }));
  const claims = base64url(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now }));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemBytes(env.APNS_PRIVATE_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ service: "Color War WebSocket", protocolVersion: PROTOCOL_VERSION });
    }
    const resumeMatch = url.pathname.match(/^\/resume-ticket\/([0-9]{6})\/?$/);
    if (resumeMatch) {
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });
      const id = env.ROOMS.idFromName(resumeMatch[1]);
      const response = await env.ROOMS.get(id).fetch(request);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
  constructor(state, env = {}) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.sequence = 0;
    this.room = null;
    // During a live match, only seats vacated by a disconnected participant may be reclaimed.
    this.rejoinableSeats = new Set();
    this.ready = this.restoreRoom();
  }

  async restoreRoom() {
    if (!this.state.storage) return;
    const saved = await this.state.storage.get("roomState");
    if (!saved || saved.expiresAt <= Date.now()) {
      if (saved) await this.state.storage.delete("roomState");
      return;
    }
    const resumeTickets = Object.fromEntries(Object.entries(saved.resumeTickets || {}).filter(([, expiresAt]) => expiresAt > Date.now()));
    this.room = { ...saved, resumeTickets, players: new Map(saved.players || []), activityTokens: saved.activityTokens || {} };
    this.rejoinableSeats = new Set(saved.rejoinableSeats || []);
    this.sequence = saved.sequence || 0;
  }

  persistRoom() {
    if (!this.state.storage) return;
    if (!this.room) {
      const deletion = this.state.storage.delete("roomState");
      if (typeof this.state.waitUntil === "function") this.state.waitUntil(deletion);
      else void deletion;
      return;
    }
    this.room.lastTouchedAt = Date.now();
    this.room.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
    const saved = {
      ...this.room,
      players: [...this.room.players.entries()],
      rejoinableSeats: [...this.rejoinableSeats],
      activityTokens: this.room.activityTokens || {},
      resumeTickets: this.room.resumeTickets || {},
      sequence: this.sequence,
    };
    const writes = Promise.all([
      this.state.storage.put("roomState", saved),
      this.state.storage.setAlarm?.(this.room.expiresAt),
    ]);
    // Keep Durable Object storage writes alive when the socket event handler returns.
    if (typeof this.state.waitUntil === "function") this.state.waitUntil(writes);
    else void writes;
  }

  async alarm() {
    await this.ready;
    if (!this.room) return;
    if (this.room.expiresAt > Date.now()) {
      await this.state.storage?.setAlarm?.(this.room.expiresAt);
      return;
    }
    this.broadcast(packet("roomClosed", this.nextSequence(), { message: "房间已超时关闭。" }));
    for (const socket of this.sockets.keys()) { try { socket.close(1000, "room expired"); } catch {} }
    this.sockets.clear();
    this.room = null;
    this.rejoinableSeats.clear();
    await this.state.storage?.delete("roomState");
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const resumeMatch = url.pathname.match(/^\/resume-ticket\/([0-9]{6})\/?$/);
    if (resumeMatch && request.method === "POST") {
      if (Number(request.headers.get("content-length") || 0) > 256) return new Response("Invalid resume token", { status: 400 });
      const token = (await request.text()).trim();
      if (token.length > 256) return new Response("Invalid resume token", { status: 400 });
      if (!this.room || this.room.roomCode !== resumeMatch[1]) return new Response("Room not found", { status: 404 });
      if (!token || token !== this.room.hostResumeToken) return new Response("Invalid resume token", { status: 403 });
      if ([...this.sockets.values()].some((entry) => entry.isHost)) return new Response("Host is already connected", { status: 409 });
      const now = Date.now();
      const tickets = { ...(this.room.resumeTickets || {}) };
      for (const [ticket, expiresAt] of Object.entries(tickets)) if (expiresAt <= now) delete tickets[ticket];
      const ticket = crypto.randomUUID();
      tickets[ticket] = now + 30_000;
      this.room.resumeTickets = tickets;
      this.persistRoom();
      return Response.json({ ticket }, { headers: { "cache-control": "no-store" } });
    }
    const roomCode = roomCodeFromPath(url.pathname);
    const role = url.searchParams.get("role");
    const nickname = (url.searchParams.get("nickname") || "玩家").trim().slice(0, 32) || "玩家";
    if (!roomCode || (role !== "host" && role !== "player")) return new Response("Invalid room", { status: 400 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });

    const hostResumeToken = request.headers.get("x-colorwar-host-token") || "";
    const resumeTicket = url.searchParams.get("resumeTicket") || "";
    let resumedHost = false;
    if (role === "host") {
      if (this.room) {
        const existingHost = [...this.sockets.values()].some((entry) => entry.isHost);
        const tickets = { ...(this.room.resumeTickets || {}) };
        const ticketExpiry = tickets[resumeTicket];
        const ticketIsValid = Boolean(resumeTicket && ticketExpiry > Date.now());
        const tokenIsValid = Boolean(hostResumeToken && hostResumeToken === this.room.hostResumeToken);
        if ((!tokenIsValid && !ticketIsValid) || existingHost) {
          return new Response("Room code is already in use", { status: 409 });
        }
        if (ticketIsValid) {
          delete tickets[resumeTicket];
          this.room.resumeTickets = tickets;
        }
        resumedHost = true;
        if (this.room.started) this.room.movePending = false; // discard an interrupted, uncommitted move; snapshot is authoritative
      } else {
        this.room = { roomCode, hostResumeToken: hostResumeToken || crypto.randomUUID(), resumeTickets: {}, started: false, firstPlayerIndex: 0, currentTurnIndex: null, movePending: false, config: null, snapshot: null, startPacket: null, players: new Map(), activityTokens: {}, expiresAt: Date.now() + 2 * 60 * 60 * 1000 };
        this.rejoinableSeats.clear();
      }
    } else if (!this.room) {
      return new Response("Room not found", { status: 404 });
    }

    const playerIndex = this.availablePlayerIndex(role);
    if (playerIndex === undefined) return new Response(this.room.started ? "No disconnected seat is available" : "Room is full", { status: 409 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.set(server, { playerIndex, isHost: role === "host", nickname });
    this.room.players.set(playerIndex, nickname);
    if (role === "player" || resumedHost) this.rejoinableSeats.delete(playerIndex);
    if (role !== "host" && this.room.config) {
      this.refreshRoomConfigFromParticipants();
      this.broadcastRoomConfig();
    }

    server.addEventListener("message", (event) => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));

    this.send(server, packet("roomJoined", this.nextSequence(), {
      roomCode,
      playerIndex,
      isHost: role === "host",
      roomStarted: Boolean(this.room.started),
      ...(role === "host" ? { hostResumeToken: this.room.hostResumeToken } : {}),
      playerNames: this.playerNames(),
      playerTypes: this.playerTypes(),
    }));
    this.broadcastRoster();
    if (resumedHost && this.room.started) {
      this.broadcast(packet("hostReconnected", this.nextSequence(), { playerIndex: 0, message: "房主已恢复连接，正在同步棋局。" }), server);
    }

    if (this.room.started) this.sendRoomState(server);
    this.persistRoom();

    return new Response(null, { status: 101, webSocket: client });
  }

  nextSequence() { this.sequence += 1; return this.sequence; }

  availablePlayerIndex(role) {
    if (!this.room) return undefined;
    const usedSeats = new Set([...this.sockets.values()].map((entry) => entry.playerIndex));
    if (role === "host") return usedSeats.has(0) ? undefined : 0;
    if (role !== "player") return undefined;
    if (this.room.started) {
      return [...this.rejoinableSeats].sort((a, b) => a - b).find((index) => index > 0 && !usedSeats.has(index));
    }
    return Array.from({ length: MAX_PLAYERS - 1 }, (_, i) => i + 1).find((index) => {
      if (usedSeats.has(index)) return false;
      const configuredType = this.room.config?.playerTypes?.[index];
      return configuredType !== PLAYER_TYPES.mathNightmare && configuredType !== PLAYER_TYPES.enhancedNightmare;
    });
  }

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
      for (const [index] of this.room.players) {
        if (index === 0) {
          const hostType = this.room.config?.playerTypes?.[0];
          types[index] = hostType === PLAYER_TYPES.mathNightmare || hostType === PLAYER_TYPES.enhancedNightmare
            ? hostType
            : PLAYER_TYPES.human;
        } else {
          types[index] = PLAYER_TYPES.network;
        }
      }
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

  refreshRoomConfigFromParticipants() {
    if (!this.room?.config) return;
    const playerNames = this.playerNames();
    const playerTypes = this.playerTypes();
    this.room.config = { ...this.room.config, playerNames, playerTypes };
    for (const cached of [this.room.startPacket, this.room.snapshot]) {
      if (cached) Object.assign(cached, { playerNames, playerTypes });
    }
  }

  broadcastRoomConfig() {
    if (!this.room?.config) return;
    this.broadcast({
      ...this.room.config,
      protocolVersion: PROTOCOL_VERSION,
      action: "hostConfig",
      senderID: "server",
      sequenceID: this.nextSequence(),
    });
  }

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
    if (action === "leaveRoom") {
      if (participant.isHost) {
        this.broadcast(packet("roomClosed", this.nextSequence(), { message: "房主已结束房间。" }));
        for (const peer of this.sockets.keys()) { try { peer.close(1000, "host left"); } catch {} }
        this.sockets.clear();
        this.rejoinableSeats.clear();
        this.room = null;
        this.persistRoom();
      } else {
        if (this.room.activityTokens) delete this.room.activityTokens[String(participant.playerIndex)];
        this.persistRoom();
        try { socket.close(1000, "left room"); } catch {}
      }
      return;
    }

    if (action === "renamePlayer") {
      const nickname = String(message.nickname || "").trim().slice(0, 32);
      if (!nickname) return;
      participant.nickname = nickname;
      this.room.players.set(participant.playerIndex, nickname);
      if (this.room.config && Array.isArray(this.room.config.playerNames)) {
        const names = this.room.config.playerNames.slice(0, MAX_PLAYERS);
        names[participant.playerIndex] = nickname;
        this.room.config.playerNames = names;
      }
      this.broadcastRoster();
      this.persistRoom();
      return;
    }

    if (action === "activityToken") {
      if (!this.room.started || message.roomCode !== this.room.roomCode
        || Number(message.playerIndex) !== participant.playerIndex
        || !isValidActivityPushToken(message.activityPushToken)) return;
      this.room.activityTokens ||= {};
      this.room.activityTokens[String(participant.playerIndex)] = message.activityPushToken.toLowerCase();
      this.persistRoom();
      return;
    }

    if (action === "hostConfig") {
      if (!participant.isHost) return;
      const normalized = { ...message, sequenceID: this.nextSequence() };
      const requestedNames = Array.isArray(message.playerNames) ? message.playerNames : [];
      normalized.playerNames = Array.from({ length: MAX_PLAYERS }, (_, i) =>
        typeof requestedNames[i] === "string" ? requestedNames[i].trim().slice(0, 32) : this.playerNames()[i]);
      // Only the host may add/remove AI in vacant lobby seats. Human/network seats are
      // assigned by the server and all roles freeze once the match starts.
      normalized.playerTypes = this.playerTypes();
      const requestedTypes = Array.isArray(message.playerTypes) ? message.playerTypes : [];
      if (!this.room.started) {
        for (let i = 0; i < MAX_PLAYERS; i++) {
          if (this.room.players.has(i)) continue;
          const requestedType = requestedTypes[i];
          if (requestedType === PLAYER_TYPES.mathNightmare
            || requestedType === PLAYER_TYPES.enhancedNightmare
            || requestedType === PLAYER_TYPES.disabled) {
            normalized.playerTypes[i] = requestedType;
          }
        }
      }
      const requestedBoardSize = Number(message.boardSize);
      // Board geometry is part of the active match state; changing it mid-game would
      // make clients interpret the same snapshot with different dimensions.
      normalized.boardSize = this.room.started
        ? (Number.isInteger(this.room.config?.boardSize) ? this.room.config.boardSize : 8)
        : (Number.isInteger(requestedBoardSize) && requestedBoardSize >= 5 && requestedBoardSize <= 12
          ? requestedBoardSize
          : (Number.isInteger(this.room.config?.boardSize) ? this.room.config.boardSize : 8));
      for (const [index, name] of this.room.players) {
        normalized.playerNames[index] = name;
        normalized.playerTypes[index] = index === 0 ? PLAYER_TYPES.human : PLAYER_TYPES.network;
      }
      this.room.config = normalized;
      // Echo the canonical role assignment to the host too, correcting stale or tampered local state.
      this.broadcast(normalized);
      this.persistRoom();
      return;
    }

    if (action === "startGame") {
      if (!participant.isHost || !this.room.config) return;
      const firstPlayerIndex = Number(message.firstPlayerIndex);
      if (!Number.isInteger(firstPlayerIndex) || firstPlayerIndex < 0 || firstPlayerIndex >= MAX_PLAYERS) return;
      const firstPlayerType = this.room.config.playerTypes?.[firstPlayerIndex];
      if (firstPlayerType === undefined || firstPlayerType === PLAYER_TYPES.disabled) return;
      this.room.started = true;
      this.room.movePending = false;
      this.room.snapshot = null;
      this.room.currentTurnIndex = firstPlayerIndex;
      const configuredBoardSize = this.room.config?.boardSize;
      this.room.startPacket = {
        ...message,
        ...this.room.config,
        action: "startGame",
        playerNames: this.room.config.playerNames,
        playerTypes: this.room.config.playerTypes,
        ...(Number.isInteger(configuredBoardSize) ? { boardSize: configuredBoardSize } : {}),
        firstPlayerIndex,
        sequenceID: this.nextSequence(),
      };
      this.broadcast(this.room.startPacket, socket);
      this.persistRoom();
      return;
    }

    if (action === "stateSnapshot") {
      if (!participant.isHost || !this.room.started || !Array.isArray(message.compactBoardSnapshot)) return;
      const currentTurnIndex = Number(message.currentTurnIndex);
      if (!Number.isInteger(currentTurnIndex) || currentTurnIndex < 0 || currentTurnIndex >= MAX_PLAYERS) return;
      const turnType = this.room.config?.playerTypes?.[currentTurnIndex];
      if (turnType === undefined || turnType === PLAYER_TYPES.disabled) return;
      const boardSize = this.room.config?.boardSize ?? 8;
      const seenCells = new Set();
      const compactBoardSnapshot = message.compactBoardSnapshot
        .filter((cell) => {
          if (!cell || !Number.isInteger(cell.r) || !Number.isInteger(cell.c)
            || cell.r < 0 || cell.r >= boardSize || cell.c < 0 || cell.c >= boardSize
            || !Number.isInteger(cell.owner) || cell.owner < 0 || cell.owner >= MAX_PLAYERS
            || !Number.isInteger(cell.count) || cell.count <= 0) return false;
          const key = `${cell.r}:${cell.c}`;
          if (seenCells.has(key)) return false;
          seenCells.add(key);
          return true;
        })
        .slice(0, boardSize * boardSize);
      const previousTurnIndex = this.room.currentTurnIndex;
      this.room.snapshot = {
        ...(this.room.config || {}),
        ...message,
        action: "stateSnapshot",
        boardSize,
        playerNames: this.room.config?.playerNames ?? message.playerNames,
        playerTypes: this.room.config?.playerTypes ?? message.playerTypes,
        colorsHex: Array.isArray(message.colorsHex) ? message.colorsHex.slice(0, MAX_PLAYERS) : [],
        compactBoardSnapshot,
        currentTurnIndex,
        sequenceID: this.nextSequence(),
      };
      this.room.currentTurnIndex = currentTurnIndex;
      this.room.movePending = false;
      this.broadcast(this.room.snapshot, socket);
      this.persistRoom();
      const pushWork = this.pushLiveActivityUpdates(previousTurnIndex);
      if (typeof this.state.waitUntil === "function") this.state.waitUntil(pushWork);
      else void pushWork;
      return;
    }

    if (action === "syncRequest") {
      if (participant.isHost) return;
      this.broadcast({ ...message, sequenceID: this.nextSequence() }, socket);
      return;
    }

    if (action === "playerMove") {
      const hostConnected = [...this.sockets.values()].some((entry) => entry.isHost);
      if (!hostConnected) {
        this.send(socket, packet("hostDisconnected", this.nextSequence(), { playerIndex: 0, message: "等待房主恢复后才能继续落子。" }));
        return;
      }
      const playerIndex = Number(message.playerIndex);
      if (!this.room.started || this.room.movePending || !Number.isInteger(playerIndex)) return;
      if (playerIndex !== this.room.currentTurnIndex) return;
      const isOwnSeat = playerIndex === participant.playerIndex;
      const playerType = this.room.config?.playerTypes?.[playerIndex];
      const isAI = playerType === PLAYER_TYPES.mathNightmare || playerType === PLAYER_TYPES.enhancedNightmare;
      if (!isOwnSeat && !(participant.isHost && isAI)) return;
      const boardSize = this.room.config?.boardSize ?? 8;
      if (!Number.isInteger(message.row) || !Number.isInteger(message.col)
        || message.row < 0 || message.row >= boardSize || message.col < 0 || message.col >= boardSize) return;
      this.room.movePending = true;
      this.broadcast({ ...message, playerIndex, sequenceID: this.nextSequence() }, socket);
      this.persistRoom();
      return;
    }
  }

  async pushLiveActivityUpdates(previousTurnIndex = null) {
    const env = this.env;
    if (!this.room?.snapshot || !env.APNS_TEAM_ID || !env.APNS_KEY_ID || !env.APNS_PRIVATE_KEY || !env.APNS_BUNDLE_ID) return;
    const host = env.APNS_HOST || "https://api.push.apple.com";
    if (host !== "https://api.push.apple.com" && host !== "https://api.sandbox.push.apple.com") return;
    const tokens = Object.entries(this.room.activityTokens || {}).filter(([seat, token]) =>
      Number.isInteger(Number(seat)) && isValidActivityPushToken(token));
    if (!tokens.length) return;
    let jwt;
    try { jwt = await createAPNsJWT(env); } catch { return; }
    const snapshot = this.room.snapshot;
    const hostDisconnected = ![...this.sockets.values()].some((entry) => entry.isHost);
    await Promise.all(tokens.map(async ([seatText, token]) => {
      const contentState = buildActivityContentState(snapshot, Number(seatText), hostDisconnected);
      if (!contentState) return;
      try {
        const response = await fetch(`${host}/3/device/${token}`, {
          method: "POST",
          headers: {
            authorization: `bearer ${jwt}`,
            "apns-push-type": "liveactivity",
            "apns-topic": `${env.APNS_BUNDLE_ID}.push-type.liveactivity`,
            "apns-priority": "10",
            "apns-expiration": String(Math.floor(Date.now() / 1000) + 2 * 60 * 60),
            "content-type": "application/json",
          },
          body: JSON.stringify({ aps: {
            timestamp: Math.floor(Date.now() / 1000),
            event: "update",
            "stale-date": Math.floor(Date.now() / 1000) + 2 * 60 * 60,
            "content-state": contentState,
            ...(shouldAlertForActivityTurn(Number(seatText), previousTurnIndex, snapshot.currentTurnIndex)
              ? { alert: { title: "轮到你了", body: "Color War 对局现在轮到你落子。" } }
              : {}),
          } }),
        });
        if (response.status === 410 && this.room?.activityTokens?.[seatText] === token) {
          delete this.room.activityTokens[seatText];
          this.persistRoom();
        }
      } catch {
        // APNs is best-effort; the authoritative room snapshot remains available on reconnect.
      }
    }));
  }

  onClose(socket) {
    const participant = this.sockets.get(socket);
    if (!participant) return;
    this.sockets.delete(socket);
    if (!this.room) return;
    this.room.players.delete(participant.playerIndex);

    if (participant.isHost) {
      // Keep the room, configuration and last authoritative snapshot so the same host
      // can resume with its secret token. Guests remain in the match instead of being
      // told that it has ended simply because iOS suspended the host app.
      if (this.room.started) {
        this.rejoinableSeats.add(0);
        // Any move not followed by an authoritative snapshot was interrupted. Replaying
        // the last committed snapshot is safer than leaving the room permanently locked.
        this.room.movePending = false;
      }
      this.room.players.set(0, participant.nickname);
      this.broadcast(packet("hostDisconnected", this.nextSequence(), { playerIndex: 0, message: "房主暂时断线，等待重新连接。" }));
      if (this.room.snapshot) this.broadcast({ ...this.room.snapshot, sequenceID: this.nextSequence() });
      this.persistRoom();
      if (this.room.snapshot) {
        const pushWork = this.pushLiveActivityUpdates(this.room.currentTurnIndex);
        if (typeof this.state.waitUntil === "function") this.state.waitUntil(pushWork);
        else void pushWork;
      }
      return;
    }

    if (this.room.started) this.rejoinableSeats.add(participant.playerIndex);
    else this.rejoinableSeats.delete(participant.playerIndex);

    if (this.room.config) {
      const playerTypes = this.playerTypes();
      const playerNames = this.playerNames();
      playerTypes[participant.playerIndex] = this.room.started ? PLAYER_TYPES.mathNightmare : PLAYER_TYPES.disabled;
      playerNames[participant.playerIndex] = this.room.started ? `AI 玩家${participant.playerIndex + 1}` : "";
      this.room.config = { ...this.room.config, playerTypes, playerNames };
      for (const cached of [this.room.startPacket, this.room.snapshot]) {
        if (cached) Object.assign(cached, { playerNames, playerTypes });
      }
    }

    this.broadcast(packet("playerLeft", this.nextSequence(), {
      playerIndex: participant.playerIndex,
      message: `${participant.nickname} 已离开房间`,
    }));
    this.broadcastRoomConfig();
    this.broadcastRoster();
    this.persistRoom();
  }
}
