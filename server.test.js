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
