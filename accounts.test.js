import test from "node:test";
import assert from "node:assert/strict";
import { Accounts, periodStart, rankLeaderboard, normalizeMatch, validateUsername } from "./accounts.js";

async function openDb() {
  try { const { DatabaseSync } = await import("node:sqlite"); return new DatabaseSync(":memory:"); }
  catch { const { Database } = await import("bun:sqlite"); return new Database(":memory:"); }
}

async function makeAccounts() {
  const db = await openDb();
  const sql = {
    exec(query, ...bind) {
      const stmt = db.prepare(query);
      const isRead = /^\s*(SELECT|WITH)/i.test(query);
      const rows = isRead ? stmt.all(...bind) : (stmt.run(...bind), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
  return new Accounts({ storage: { sql } }, {});
}

function req(method, path, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`https://x.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

async function call(acc, method, path, body, token) {
  const res = await acc.fetch(req(method, path, body, token));
  return { status: res.status, data: await res.json() };
}

test("validators and periods", () => {
  assert.equal(validateUsername("a"), "用户名需要 2–20 个字符");
  assert.equal(validateUsername("Sam 王"), null);
  const now = Date.UTC(2026, 10, 22, 12); // Sun 22 Nov 2026 20:00 HK
  assert.equal(new Date(periodStart("week", now) + 8 * 3600e3).toISOString().slice(0, 10), "2026-11-16");
  assert.equal(periodStart("all", now), 0);
  assert.equal(new Date(periodStart("season", now) + 8 * 3600e3).toISOString().slice(0, 10), "2026-10-01");
  assert.equal(normalizeMatch({ id: "x" }), null);
});

test("ranking: wins then average moves, min 3 games", () => {
  const rows = [
    { userId: "a", username: "a", games: 3, wins: 0, totalMoves: 90 },
    { userId: "b", username: "b", games: 3, wins: 0, totalMoves: 120 },
    { userId: "c", username: "c", games: 4, wins: 1, totalMoves: 40 },
    { userId: "d", username: "d", games: 2, wins: 2, totalMoves: 400 },
  ];
  assert.deepEqual(rankLeaderboard(rows).map((r) => r.userId), ["c", "b", "a"]);
});

test("register, login, profile, matches, leaderboard, friends, invites", async () => {
  const acc = await makeAccounts();
  let r = await call(acc, "POST", "/api/register", { username: "Sam", password: "secret1", confirmPassword: "secret2" });
  assert.equal(r.status, 400);
  r = await call(acc, "POST", "/api/register", { username: "Sam", password: "secret1", confirmPassword: "secret1" });
  assert.equal(r.status, 201);
  const sam = r.data.token;
  r = await call(acc, "POST", "/api/register", { username: "sam", password: "secret1", confirmPassword: "secret1" });
  assert.equal(r.status, 409);
  r = await call(acc, "POST", "/api/login", { username: "SAM", password: "nope" });
  assert.equal(r.status, 401);
  r = await call(acc, "POST", "/api/login", { username: "SAM", password: "secret1" });
  assert.equal(r.status, 200);
  r = await call(acc, "PATCH", "/api/me", { username: "SamW", avatar: "emoji:🐯:#ff8800" }, sam);
  assert.equal(r.data.user.username, "SamW");

  const now = Date.now();
  const matches = [1, 2, 3].map((i) => ({ id: `match-000${i}`, playedAt: now - i, mode: "vsAI", players: 2, boardSize: 6, aiKey: "bot3-s4", aiLabel: "Bot 3 · 强度 4", moves: 30 + i, result: "loss" }));
  r = await call(acc, "POST", "/api/matches", { matches: [...matches, matches[0]] }, sam);
  assert.equal(r.data.added, 3);
  // these uploads have no move list (old client) → unverified, off the leaderboard; treat them as historical rows here
  assert.equal(acc.one(`SELECT COUNT(*) AS n FROM matches WHERE verify = 'unverified'`).n, 3);
  acc.sql.exec(`UPDATE matches SET verify = NULL`);
  r = await call(acc, "GET", "/api/matches?limit=2", null, sam);
  assert.equal(r.data.matches.length, 2);
  r = await call(acc, "GET", "/api/leaderboard?period=week&limit=5");
  assert.equal(r.data.entries[0].username, "SamW");
  assert.equal(r.data.entries[0].avgMoves, 32);
  assert.equal(r.data.boardSize, 6);
  r = await call(acc, "GET", "/api/leaderboard?period=week&limit=5&aiKey=bot3-s4&boardSize=8");
  assert.equal(r.data.entries.length, 0);

  r = await call(acc, "POST", "/api/register", { username: "Tom", password: "secret1", confirmPassword: "secret1" });
  const tom = r.data.token;
  const tomId = r.data.user.id;
  r = await call(acc, "POST", "/api/invites", { friendId: tomId, roomCode: "123456" }, sam);
  assert.equal(r.status, 403);
  r = await call(acc, "GET", `/api/friends/${tomId}/matches`, null, sam);
  assert.equal(r.status, 403);
  await call(acc, "POST", "/api/friends/request", { username: "tom" }, sam);
  r = await call(acc, "GET", "/api/notifications", null, tom);
  assert.equal(r.data.friendRequests.length, 1);
  const samId = r.data.friendRequests[0].id;
  await call(acc, "POST", "/api/friends/respond", { userId: samId, accept: true }, tom);
  r = await call(acc, "GET", "/api/friends", null, sam);
  assert.equal(r.data.friends[0].username, "Tom");
  r = await call(acc, "GET", `/api/friends/${samId}/matches`, null, tom);
  assert.equal(r.data.stats.games, 3);
  assert.equal(r.data.matches[0].detail, null);
  r = await call(acc, "POST", "/api/invites", { friendId: tomId, roomCode: "123456", boardSize: 6 }, sam);
  assert.equal(r.status, 201);
  r = await call(acc, "GET", "/api/notifications", null, tom);
  assert.equal(r.data.invites[0].roomCode, "123456");
  r = await call(acc, "POST", `/api/invites/${r.data.invites[0].id}/respond`, { accept: true }, tom);
  assert.equal(r.data.roomCode, "123456");
  r = await call(acc, "GET", "/api/notifications", null, sam);
  assert.equal(r.data.inviteUpdates[0].status, "accepted");
  r = await call(acc, "GET", "/api/me", null, "bad");
  assert.equal(r.status, 401);
});

test("delete account removes user data and requires password", async () => {
  const acc = await makeAccounts();
  let r = await call(acc, "POST", "/api/register", { username: "Del", password: "secret1", confirmPassword: "secret1" });
  const tok = r.data.token;
  await call(acc, "POST", "/api/matches", { matches: [{ id: "match-x1", playedAt: Date.now(), mode: "vsAI", players: 2, boardSize: 6, aiKey: "bot1-l1", moves: 10, result: "win" }] }, tok);
  r = await call(acc, "POST", "/api/me/delete", { password: "wrong" }, tok);
  assert.equal(r.status, 403);
  r = await call(acc, "POST", "/api/me/delete", { password: "secret1" }, tok);
  assert.equal(r.status, 200);
  r = await call(acc, "GET", "/api/me", null, tok);
  assert.equal(r.status, 401);
  r = await call(acc, "POST", "/api/login", { username: "Del", password: "secret1" });
  assert.equal(r.status, 401);
});

test("change password: verifies old, same rules, keeps current session, ends others, rate limited", async () => {
  const acc = await makeAccounts();
  let r = await call(acc, "POST", "/api/register", { username: "Pw", password: "secret1", confirmPassword: "secret1" });
  const current = r.data.token;
  const other = (await call(acc, "POST", "/api/login", { username: "pw", password: "secret1" })).data.token;
  r = await call(acc, "POST", "/api/me/password", { oldPassword: "wrong1", password: "newpass1", confirmPassword: "newpass1" }, current);
  assert.equal(r.status, 403);
  r = await call(acc, "POST", "/api/me/password", { oldPassword: "secret1", password: "123", confirmPassword: "123" }, current);
  assert.equal(r.status, 400);
  r = await call(acc, "POST", "/api/me/password", { oldPassword: "secret1", password: "newpass1", confirmPassword: "newpass2" }, current);
  assert.equal(r.status, 400);
  r = await call(acc, "POST", "/api/me/password", { oldPassword: "secret1", password: "newpass1", confirmPassword: "newpass1" }, current);
  assert.equal(r.status, 200);
  assert.equal((await call(acc, "GET", "/api/me", null, current)).status, 200);
  assert.equal((await call(acc, "GET", "/api/me", null, other)).status, 401);
  assert.equal((await call(acc, "POST", "/api/login", { username: "pw", password: "secret1" })).status, 401);
  assert.equal((await call(acc, "POST", "/api/login", { username: "pw", password: "newpass1" })).status, 200);
  for (let i = 0; i < 8; i++) await call(acc, "POST", "/api/me/password", { oldPassword: "bad", password: "zzzzzz1", confirmPassword: "zzzzzz1" }, current);
  r = await call(acc, "POST", "/api/me/password", { oldPassword: "newpass1", password: "zzzzzz1", confirmPassword: "zzzzzz1" }, current);
  assert.equal(r.status, 429);
});
