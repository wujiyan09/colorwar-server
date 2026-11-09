import test from "node:test";
import assert from "node:assert/strict";
import { Room } from "./server.js";

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


test("disconnecting the host explicitly notifies remaining room members", () => {
  const { room, host, guest } = setupRoom();
  room.onClose(host);
  assert.equal(guest.messages.at(-1).action, "roomClosed");
  assert.equal(guest.messages.at(-1).message, "房主已断开连接，对局已结束。");
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
  assert.equal(room.room.config.playerTypes[2], "算法-噩梦");
  assert.equal(guest.messages.at(-1).playerTypes[2], "算法-噩梦");
});
