import test from "node:test";
import assert from "node:assert/strict";
import { Room, buildActivityContentState, isValidActivityPushToken, shouldAlertForActivityTurn } from "./server.js";

class FakeSocket {
  messages = [];
  send(value) { this.messages.push(JSON.parse(value)); }
  close() {}
}

function setupRoom() {
  const room = new Room({});
  room.room = {
    roomCode: "123456",
    started: true,
    firstPlayerIndex: 0,
    currentTurnIndex: 1,
    movePending: false,
    config: { playerTypes: ["真人", "网络玩家", "算法-噩梦", "未加入"] },
    snapshot: null,
    startPacket: null,
    players: new Map([[0, "Host"], [1, "Guest"]]),
  };
  const host = new FakeSocket();
  const guest = new FakeSocket();
  const observer = new FakeSocket();
  room.sockets.set(host, { playerIndex: 0, isHost: true, nickname: "Host" });
  room.sockets.set(guest, { playerIndex: 1, isHost: false, nickname: "Guest" });
  room.sockets.set(observer, { playerIndex: 2, isHost: false, nickname: "Observer" });
  return { room, host, guest, observer };
}

const move = (playerIndex, row = 2, col = 3) => JSON.stringify({
  protocolVersion: 2, action: "playerMove", sequenceID: 1, playerIndex, row, col,
});

test("accepts a guest move only for its assigned current-turn seat", () => {
  const { room, host, guest, observer } = setupRoom();
  room.onMessage(guest, move(1));
  assert.equal(room.room.movePending, true);
  assert.equal(host.messages.at(-1).action, "playerMove");
  assert.equal(host.messages.at(-1).playerIndex, 1);
  assert.equal(observer.messages.at(-1).action, "playerMove");
  assert.equal(guest.messages.length, 0);
});

test("rejects wrong-seat, out-of-turn and duplicate guest moves", () => {
  const { room, host, guest } = setupRoom();
  room.onMessage(guest, move(0));
  assert.equal(host.messages.length, 0);
  room.onMessage(guest, move(1));
  room.onMessage(guest, move(1));
  assert.equal(host.messages.length, 1);
});

test("host may move its own seat and configured AI seats, but not a remote player's seat", () => {
  const { room, host, observer } = setupRoom();
  room.room.currentTurnIndex = 0;
  room.onMessage(host, move(0));
  assert.equal(observer.messages.at(-1).playerIndex, 0);
  room.room.movePending = false;
  room.room.currentTurnIndex = 1;
  room.onMessage(host, move(1));
  assert.equal(observer.messages.length, 1);
  room.room.currentTurnIndex = 2;
  room.onMessage(host, move(2));
  assert.equal(observer.messages.at(-1).playerIndex, 2);
});

test("an authoritative snapshot releases the move lock and advances the accepted turn", () => {
  const { room, host, guest } = setupRoom();
  room.onMessage(guest, move(1));
  room.onMessage(host, JSON.stringify({
    protocolVersion: 2, action: "stateSnapshot", sequenceID: 2, currentTurnIndex: 2,
    compactBoardSnapshot: [],
  }));
  assert.equal(room.room.currentTurnIndex, 2);
  assert.equal(room.room.movePending, false);
  room.onMessage(host, move(2));
  assert.equal(guest.messages.at(-1).action, "playerMove");
});


test("replayed room state uses fresh sequence IDs so a late joiner accepts it", () => {
  const { room, guest } = setupRoom();
  room.room.config = { protocolVersion: 2, sequenceID: 3, action: "hostConfig", senderID: "server" };
  room.room.startPacket = { protocolVersion: 2, sequenceID: 4, action: "startGame", senderID: "server" };
  room.room.snapshot = { protocolVersion: 2, sequenceID: 5, action: "stateSnapshot", senderID: "server" };
  room.sequence = 10;
  room.sendRoomState(guest);
  assert.deepEqual(guest.messages.map((item) => item.action), ["hostConfig", "startGame", "stateSnapshot"]);
  assert.deepEqual(guest.messages.map((item) => item.sequenceID), [11, 12, 13]);
});

test("starting a new match invalidates the previous cached snapshot", () => {
  const { room, host } = setupRoom();
  room.room.snapshot = { action: "stateSnapshot", sequenceID: 9 };
  room.room.config = { playerTypes: ["真人", "网络玩家", "算法-噩梦"] };
  room.onMessage(host, JSON.stringify({
    protocolVersion: 2, action: "startGame", sequenceID: 10, firstPlayerIndex: 0,
  }));
  assert.equal(room.room.snapshot, null);
});


test("renamePlayer updates only the connected participant's assigned roster seat", () => {
  const { room, host, guest, observer } = setupRoom();
  room.room.config.playerNames = ["Host", "Guest", "", ""];
  room.onMessage(guest, JSON.stringify({
    protocolVersion: 2, action: "renamePlayer", sequenceID: 3, playerIndex: 0, nickname: "  New Guest  ",
  }));
  assert.equal(room.room.players.get(1), "New Guest");
  assert.equal(room.room.players.get(0), "Host");
  assert.equal(room.room.config.playerNames[1], "New Guest");
  for (const socket of [host, guest, observer]) {
    assert.equal(socket.messages.at(-1).action, "roomRoster");
    assert.equal(socket.messages.at(-1).playerNames[1], "New Guest");
  }
});


test("startGame carries the host's canonical board size to guests", () => {
  const { room, host, guest } = setupRoom();
  room.room.config = { protocolVersion: 2, action: "hostConfig", boardSize: 10, playerTypes: ["真人", "网络玩家"] };
  room.onMessage(host, JSON.stringify({
    protocolVersion: 2, action: "startGame", sequenceID: 10, firstPlayerIndex: 0, boardSize: 8,
  }));
  assert.equal(room.room.startPacket.action, "startGame");
  assert.equal(room.room.startPacket.boardSize, 10);
  assert.equal(guest.messages.at(-1).boardSize, 10);
});


test("live hostConfig cannot change assigned roles and server echoes canonical assignments", () => {
  const { room, host, guest } = setupRoom();
  room.room.config = {
    playerNames: ["Host", "Guest", "AI", "Empty"],
    playerTypes: ["真人", "网络玩家", "算法-噩梦", "未加入"],
  };
  room.onMessage(host, JSON.stringify({
    protocolVersion: 2, action: "hostConfig", sequenceID: 30,
    playerNames: ["Host", "Guest", "AI", "Empty"],
    playerTypes: ["算法-噩梦", "真人", "真人", "算法-噩梦 (加强版)"],
  }));
  assert.deepEqual(room.room.config.playerTypes.slice(0, 4), ["真人", "网络玩家", "算法-噩梦", "未加入"]);
  assert.deepEqual(guest.messages.at(-1).playerTypes.slice(0, 4), ["真人", "网络玩家", "算法-噩梦", "未加入"]);
  assert.deepEqual(host.messages.at(-1).playerTypes.slice(0, 4), ["真人", "网络玩家", "算法-噩梦", "未加入"]);
});


test("lobby host may add AI only to vacant seats; connected seats and invalid roles stay server-owned", () => {
  const { room, host, guest } = setupRoom();
  room.room.started = false;
  room.room.config = {
    playerNames: ["Host", "Guest", "", ""],
    playerTypes: ["真人", "网络玩家", "未加入", "未加入"],
  };
  room.onMessage(host, JSON.stringify({
    protocolVersion: 2, action: "hostConfig", sequenceID: 31,
    playerNames: ["Host", "Changed host", "AI 3", "Bad 4"],
    playerTypes: ["算法-噩梦", "算法-噩梦", "算法-噩梦 (加强版)", "enhancedNightmare"],
  }));
  assert.deepEqual(room.room.config.playerTypes.slice(0, 4), ["真人", "网络玩家", "算法-噩梦 (加强版)", "未加入"]);
  assert.deepEqual(room.room.config.playerNames.slice(0, 4), ["Host", "Guest", "AI 3", "Bad 4"]);
  assert.deepEqual(host.messages.at(-1).playerTypes.slice(0, 4), ["真人", "网络玩家", "算法-噩梦 (加强版)", "未加入"]);
  assert.deepEqual(guest.messages.at(-1).playerTypes.slice(0, 4), ["真人", "网络玩家", "算法-噩梦 (加强版)", "未加入"]);
});


test("joining guests skip seats reserved for an AI in the lobby", () => {
  const room = new Room({});
  room.room = { started: false, config: { playerTypes: ["真人", "算法-噩梦", "未加入"] } };
  const host = new FakeSocket();
  room.sockets.set(host, { playerIndex: 0, isHost: true, nickname: "Host" });
  assert.equal(room.availablePlayerIndex("player"), 2);
});


test("guest move reaches host and observers; final authoritative chain snapshot reaches guests", () => {
  const { room, host, guest, observer } = setupRoom();
  room.onMessage(guest, move(1, 3, 3));
  assert.equal(host.messages.at(-1).action, "playerMove");
  assert.equal(observer.messages.at(-1).action, "playerMove");
  // The mover is intentionally not echoed by the server; it animates its own accepted move locally.
  assert.equal(guest.messages.length, 0);

  const finalCascadeBoard = [
    { r: 3, c: 3, owner: 1, count: 1 },
    { r: 3, c: 2, owner: 1, count: 2 },
    { r: 3, c: 4, owner: 1, count: 1 },
  ];
  room.onMessage(host, JSON.stringify({
    protocolVersion: 2, action: "stateSnapshot", sequenceID: 2, boardSize: 8,
    compactBoardSnapshot: finalCascadeBoard, currentTurnIndex: 2,
    hasEnteredSnapshot: [true, true, false], eliminatedSnapshot: Array(8).fill(false),
  }));
  for (const socket of [guest, observer]) {
    const snapshot = socket.messages.at(-1);
    assert.equal(snapshot.action, "stateSnapshot");
    assert.deepEqual(snapshot.compactBoardSnapshot, finalCascadeBoard);
    assert.equal(snapshot.currentTurnIndex, 2);
  }
  assert.deepEqual(room.room.snapshot.compactBoardSnapshot, finalCascadeBoard);
  assert.equal(room.room.currentTurnIndex, 2);
  assert.equal(room.room.movePending, false);
});


test("a host transport disconnect preserves the room and last snapshot for resume", () => {
  const { room, host, guest, observer } = setupRoom();
  room.room.hostResumeToken = "secret-resume-token";
  room.room.movePending = true;
  room.room.snapshot = { action: "stateSnapshot", currentTurnIndex: 1, compactBoardSnapshot: [{ r: 0, c: 0, owner: 1, count: 1 }] };
  room.onClose(host);
  assert.ok(room.room, "room remains live");
  assert.equal(room.room.movePending, false, "uncommitted move is discarded");
  assert.equal(room.room.hostResumeToken, "secret-resume-token");
  assert.deepEqual(room.room.snapshot.compactBoardSnapshot, [{ r: 0, c: 0, owner: 1, count: 1 }]);
  assert.equal(room.rejoinableSeats.has(0), true);
  assert.equal(guest.messages.at(-1).action, "hostDisconnected");
  assert.equal(observer.messages.at(-1).action, "hostDisconnected");
});

test("guests cannot claim the temporarily disconnected host seat", () => {
  const { room, host } = setupRoom();
  room.onClose(host);
  assert.equal(room.availablePlayerIndex("player"), undefined);
});

test("moves are rejected while the host is disconnected", () => {
  const { room, host, guest } = setupRoom();
  room.onClose(host);
  room.onMessage(guest, move(1));
  assert.equal(room.room.movePending, false);
  assert.equal(guest.messages.at(-1).action, "hostDisconnected");
});

test("Durable Object storage restores room, sequence and rejoinable seats", async () => {
  const values = new Map();
  const pending = [];
  const state = {
    storage: {
      async get(key) { return values.get(key); },
      async put(key, value) { values.set(key, structuredClone(value)); },
      async delete(key) { values.delete(key); },
      async setAlarm(value) { state.alarmAt = value; },
    },
    waitUntil(promise) { pending.push(promise); },
  };
  const original = new Room(state);
  original.room = {
    roomCode: "123456", started: true, firstPlayerIndex: 0, currentTurnIndex: 2,
    movePending: false, hostResumeToken: "resume-token", config: { boardSize: 8 },
    snapshot: { action: "stateSnapshot", currentTurnIndex: 2 }, startPacket: { action: "startGame" },
    players: new Map([[0, "Host"], [1, "Guest"]]), activityTokens: { "1": "ab".repeat(32) },
  };
  original.rejoinableSeats.add(0);
  original.rejoinableSeats.add(1);
  original.sequence = 42;
  original.persistRoom();
  await Promise.all(pending);
  const restored = new Room(state);
  await restored.ready;
  assert.equal(restored.room.roomCode, "123456");
  assert.equal(restored.room.hostResumeToken, "resume-token");
  assert.equal(restored.room.players.get(1), "Guest");
  assert.equal(restored.room.activityTokens["1"], "ab".repeat(32));
  assert.equal(restored.sequence, 42);
  assert.deepEqual([...restored.rejoinableSeats].sort(), [0, 1]);
  assert.ok(state.alarmAt > Date.now());
});

test("a departed guest is server-assigned AI in-game, without opening role edits", () => {
  const { room, host, guest, observer } = setupRoom();
  room.room.config.playerNames = ["Host", "Guest", "Observer"];
  room.room.startPacket = { action: "startGame", playerNames: ["Host", "Guest", "Observer"], playerTypes: [...room.room.config.playerTypes] };
  room.room.snapshot = { action: "stateSnapshot", playerNames: ["Host", "Guest", "Observer"], playerTypes: [...room.room.config.playerTypes] };
  room.onClose(guest);
  assert.equal(room.room.config.playerTypes[1], "算法-噩梦");
  assert.equal(room.room.config.playerNames[1], "AI 玩家2");
  assert.equal(room.room.startPacket.playerTypes[1], "算法-噩梦");
  assert.equal(room.room.snapshot.playerTypes[1], "算法-噩梦");
  const hostConfig = host.messages.findLast((item) => item.action === "hostConfig");
  assert.equal(hostConfig.playerTypes[1], "算法-噩梦");
  assert.equal(hostConfig.senderID, "server");
  assert.ok(hostConfig.sequenceID > host.messages.findLast((item) => item.action === "playerLeft").sequenceID);
  assert.equal(observer.messages.findLast((item) => item.action === "hostConfig").playerTypes[1], "算法-噩梦");
});


test("a guest leaving the lobby frees the seat without client role selection", () => {
  const { room, host, guest } = setupRoom();
  room.room.started = false;
  room.room.config.playerNames = ["Host", "Guest"];
  room.onClose(guest);
  assert.equal(room.room.config.playerTypes[1], "未加入");
  assert.equal(room.room.config.playerNames[1], "");
  assert.equal(host.messages.findLast((item) => item.action === "hostConfig").playerTypes[1], "未加入");
});

test("host configuration normalizes board size and fixed-size roster arrays", () => {
  const { room, host, guest } = setupRoom();
  room.room.config = { boardSize: 10 };
  room.onMessage(host, JSON.stringify({
    protocolVersion: 2, action: "hostConfig", sequenceID: 12, boardSize: 99,
    playerNames: ["Host"], playerTypes: ["真人"],
  }));
  assert.equal(room.room.config.boardSize, 10);
  assert.equal(room.room.config.playerNames.length, 8);
  assert.equal(room.room.config.playerTypes.length, 8);
  assert.equal(guest.messages.at(-1).boardSize, 10);
});

test("rejects moves outside the configured board", () => {
  const { room, guest, host } = setupRoom();
  room.room.config.boardSize = 6;
  room.onMessage(guest, move(1, 6, 0));
  assert.equal(room.room.movePending, false);
  assert.equal(host.messages.length, 0);
});

test("rejects starts and snapshots targeting disabled seats", () => {
  const { room, host, guest } = setupRoom();
  room.room.started = false;
  room.room.config.playerTypes[7] = "未加入";
  room.onMessage(host, JSON.stringify({ protocolVersion: 2, action: "startGame", firstPlayerIndex: 7 }));
  assert.equal(room.room.started, false);
  assert.equal(room.room.startPacket, null);
  room.room.started = true;
  room.room.movePending = true;
  room.onMessage(host, JSON.stringify({
    protocolVersion: 2, action: "stateSnapshot", currentTurnIndex: 7, compactBoardSnapshot: [],
  }));
  assert.equal(room.room.movePending, true);
  assert.equal(guest.messages.length, 0);
});

test("authoritative snapshots are bounded to the configured board and carry canonical size", () => {
  const { room, host, guest } = setupRoom();
  room.room.config.boardSize = 6;
  room.room.config.playerNames = ["Host", "Guest"];
  room.onMessage(host, JSON.stringify({
    protocolVersion: 2, action: "stateSnapshot", currentTurnIndex: 1, boardSize: 12,
    compactBoardSnapshot: [
      { r: 1, c: 2, owner: 1, count: 3 },
      { r: 7, c: 1, owner: 1, count: 1 },
      { r: 0, c: 0, owner: 9, count: 2 },
    ],
  }));
  assert.equal(room.room.snapshot.boardSize, 6);
  assert.deepEqual(room.room.snapshot.compactBoardSnapshot, [{ r: 1, c: 2, owner: 1, count: 3 }]);
  assert.equal(guest.messages.at(-1).playerNames[1], "Guest");
  assert.equal(room.room.movePending, false);
});


test("host config ignores unknown player types and caps supplied nicknames", () => {
  const { room, host, guest } = setupRoom();
  room.onMessage(host, JSON.stringify({
    protocolVersion: 2, action: "hostConfig", sequenceID: 20, boardSize: 8,
    playerNames: ["a".repeat(50), "Guest attempt", "AI seat"],
    playerTypes: ["unknown", "unknown", "unknown"],
  }));
  assert.equal(room.room.config.playerNames[0], "Host");
  assert.equal(room.room.config.playerNames[1], "Guest");
  assert.equal(room.room.config.playerNames[2], "AI seat");
  assert.equal(room.room.config.playerTypes[0], "真人");
  assert.equal(room.room.config.playerTypes[1], "网络玩家");
  // Online role assignments are frozen from the existing room state, not hostConfig input.
  assert.equal(room.room.config.playerTypes[2], "算法-噩梦");
  assert.equal(guest.messages.at(-1).playerTypes[2], "算法-噩梦");
});


test("a started room admits only a participant returning to a disconnected seat", () => {
  const { room, guest } = setupRoom();
  room.room.started = false;
  assert.equal(room.availablePlayerIndex("player"), 3);
  room.room.started = true;
  assert.equal(room.availablePlayerIndex("player"), undefined);

  room.onClose(guest);
  assert.equal(room.availablePlayerIndex("player"), 1);
  assert.equal(room.room.config.playerTypes[1], "算法-噩梦");
});


test("the server freezes board size after a match starts", () => {
  const { room, host, guest } = setupRoom();
  room.room.config = {
    boardSize: 8,
    playerNames: ["Host", "Guest", "Observer"],
    playerTypes: ["真人", "网络玩家", "网络玩家"],
  };
  room.room.started = true;
  room.onMessage(host, JSON.stringify({
    protocolVersion: 2, action: "hostConfig", sequenceID: 50,
    boardSize: 12,
    playerNames: ["Host", "Guest", "Observer"],
  }));

  assert.equal(room.room.config.boardSize, 8);
  assert.equal(host.messages.at(-1).boardSize, 8);
  assert.equal(guest.messages.at(-1).boardSize, 8);
});


test("accepts only hex ActivityKit push tokens of a plausible APNs token length", () => {
  assert.equal(isValidActivityPushToken("a".repeat(64)), true);
  assert.equal(isValidActivityPushToken("F".repeat(256)), true);
  assert.equal(isValidActivityPushToken("a".repeat(63)), false);
  assert.equal(isValidActivityPushToken("g".repeat(64)), false);
  assert.equal(isValidActivityPushToken(null), false);
});

test("builds compact Live Activity board state with turn and palette data", () => {
  const state = buildActivityContentState({
    boardSize: 5, currentTurnIndex: 1, playerNames: ["Host", "Guest"],
    colorsHex: ["FF0000FF", "00AAFFFF"],
    compactBoardSnapshot: [
      { r: 0, c: 0, owner: 0, count: 1 },
      { r: 2, c: 3, owner: 1, count: 3 },
      { r: 9, c: 9, owner: 2, count: 1 },
    ],
  }, 1);
  assert.equal(state.boardRows.length, 5);
  assert.equal(state.boardRows[0][0], "1");
  assert.equal(state.boardRows[2][3], "7");
  assert.equal(state.boardRows[4], "00000");
  assert.equal(state.currentPlayerName, "Guest");
  assert.equal(state.isMyTurn, true);
  assert.equal(state.status, "轮到你了");
  const paused = buildActivityContentState({ boardSize: 5, currentTurnIndex: 1 }, 1, true);
  assert.equal(paused.status, "房主断线，等待恢复");
  assert.equal(paused.isMyTurn, false);
  assert.equal(state.colors[0], "FF0000");
  assert.equal(state.colors[7], "808080");
  assert.equal(buildActivityContentState({ boardSize: 99 }, 0), null);
});

test("activity token registration can only bind a valid token to the connected player's own seat", () => {
  const { room, guest, host } = setupRoom();
  room.room.activityTokens = {};
  const token = "ab".repeat(32);
  room.onMessage(guest, JSON.stringify({
    protocolVersion: 2, action: "activityToken", roomCode: "123456", playerIndex: 1, activityPushToken: token,
  }));
  assert.equal(room.room.activityTokens["1"], token);
  room.onMessage(guest, JSON.stringify({
    protocolVersion: 2, action: "activityToken", roomCode: "123456", playerIndex: 0, activityPushToken: "cd".repeat(32),
  }));
  room.onMessage(host, JSON.stringify({
    protocolVersion: 2, action: "activityToken", roomCode: "123456", playerIndex: 1, activityPushToken: "ef".repeat(32),
  }));
  room.onMessage(guest, JSON.stringify({
    protocolVersion: 2, action: "activityToken", roomCode: "123456", playerIndex: 1, activityPushToken: "not-a-token",
  }));
  assert.equal(room.room.activityTokens["0"], undefined);
  assert.equal(room.room.activityTokens["1"], token);
});

test("Live Activity push is safely disabled until APNs secrets are configured", async () => {
  const { room } = setupRoom();
  room.env = {};
  room.room.snapshot = { boardSize: 5, currentTurnIndex: 0, compactBoardSnapshot: [] };
  room.room.activityTokens = { "0": "ab".repeat(32) };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected fetch"); };
  try {
    await room.pushLiveActivityUpdates();
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Live Activity turn alert is sent only when the registered player's turn begins", () => {
  assert.equal(shouldAlertForActivityTurn(1, 0, 1), true);
  assert.equal(shouldAlertForActivityTurn(0, 0, 1), false);
  assert.equal(shouldAlertForActivityTurn(1, 1, 1), false);
  assert.equal(shouldAlertForActivityTurn(1, null, 1), true);
});
