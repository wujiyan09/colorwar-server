import test from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "./accounts.js";

async function openDb() {
  try { const { DatabaseSync } = await import("node:sqlite"); return new DatabaseSync(":memory:"); }
  catch { const { Database } = await import("bun:sqlite"); return new Database(":memory:"); }
}
async function make(env) {
  const db = await openDb();
  const sql = { exec(query, ...bind) { const st = db.prepare(query); const rd = /^\s*(SELECT|WITH)/i.test(query); const rows = rd ? st.all(...bind) : (st.run(...bind), []); return { toArray: () => rows.map(r => ({ ...r })) }; } };
  return new Accounts({ storage: { sql } }, env);
}
async function call(acc, method, path, body, token, ip = "1.2.3.4") {
  const headers = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await acc.fetch(new Request(`https://x.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, data: await res.json() };
}
const ADMIN = "admin-secret-123";

test("admin auth: unset → 404, no/wrong token → 401, rate limited, user token rejected", async () => {
  const off = await make({});
  assert.equal((await call(off, "GET", "/api/admin/users", null, ADMIN)).status, 404);
  const acc = await make({ ADMIN_TOKEN: ADMIN });
  const user = (await call(acc, "POST", "/api/register", { username: "Sam", password: "secret1", confirmPassword: "secret1" })).data.token;
  assert.equal((await call(acc, "GET", "/api/admin/users")).status, 401);
  assert.equal((await call(acc, "GET", "/api/admin/users", null, "wrong")).status, 401);
  assert.equal((await call(acc, "GET", "/api/admin/users", null, user)).status, 401);
  assert.equal((await call(acc, "GET", "/api/admin/users", null, ADMIN)).status, 200);
  for (let i = 0; i < 8; i++) await call(acc, "GET", "/api/admin/users", null, "bad", "9.9.9.9");
  assert.equal((await call(acc, "GET", "/api/admin/users", null, ADMIN, "9.9.9.9")).status, 429);
});

test("admin CRUD: users, matches, friends, sessions, log; leaderboard reflects edits; no passwords", async () => {
  const acc = await make({ ADMIN_TOKEN: ADMIN });
  const reg = async (n) => (await call(acc, "POST", "/api/register", { username: n, password: "secret1", confirmPassword: "secret1" })).data;
  const a = await reg("Alice"), b = await reg("Bob");
  await call(acc, "POST", "/api/friends/request", { username: "Bob" }, a.token);
  let r = await call(acc, "GET", "/api/admin/users?q=ali", null, ADMIN);
  assert.equal(r.data.users.length, 1);
  assert.equal(JSON.stringify(r.data).includes("secret1"), false);
  const aid = r.data.users[0].id;
  r = await call(acc, "PATCH", `/api/admin/users/${aid}`, { username: "Alicia", email: "a@b.co" }, ADMIN);
  assert.equal(r.data.user.username, "Alicia"); assert.equal(r.data.user.email, "a@b.co");
  assert.equal((await call(acc, "PATCH", `/api/admin/users/${aid}`, { username: "bob" }, ADMIN)).status, 409);
  assert.equal((await call(acc, "PATCH", `/api/admin/users/${aid}`, { email: "nope" }, ADMIN)).status, 400);

  // matches: create 3 → on leaderboard; edit result → reflected; delete → drops off
  for (let i = 0; i < 3; i++) {
    r = await call(acc, "POST", "/api/admin/matches", { userId: aid, id: `manual-000${i}`, mode: "vsAI", players: 2, boardSize: 6, aiKey: "bot3-s1", aiLabel: "Bot 3 · 强度 1", moves: 40, result: "loss" }, ADMIN);
    assert.equal(r.status, 201);
  }
  assert.equal((await call(acc, "POST", "/api/admin/matches", { userId: aid, id: "manual-0000" }, ADMIN)).status, 409);
  assert.equal((await call(acc, "POST", "/api/admin/matches", { userId: aid, result: "bogus" }, ADMIN)).status, 400);
  let lb = (await call(acc, "GET", "/api/leaderboard?period=all&aiKey=bot3-s1&boardSize=6")).data;
  assert.equal(lb.entries[0].wins, 0);
  r = await call(acc, "PATCH", `/api/admin/matches/${aid}/manual-0000`, { result: "win", moves: 99 }, ADMIN);
  assert.equal(r.data.match.result, "win"); assert.equal(r.data.match.moves, 99);
  lb = (await call(acc, "GET", "/api/leaderboard?period=all&aiKey=bot3-s1&boardSize=6")).data;
  assert.equal(lb.entries[0].wins, 1); assert.equal(lb.entries[0].username, "Alicia");
  r = await call(acc, "GET", `/api/admin/matches?userId=${aid}&aiKey=bot3-s1`, null, ADMIN);
  assert.equal(r.data.matches.length, 3);
  assert.equal((await call(acc, "DELETE", `/api/admin/matches/${aid}/manual-0001`, null, ADMIN)).status, 200);
  lb = (await call(acc, "GET", "/api/leaderboard?period=all&aiKey=bot3-s1&boardSize=6")).data;
  assert.equal(lb.entries.length, 0); // below 3 games now

  // friends + sessions
  r = await call(acc, "GET", `/api/admin/friends?userId=${aid}`, null, ADMIN);
  assert.equal(r.data.friends.length, 1);
  const f = r.data.friends[0];
  assert.equal((await call(acc, "DELETE", `/api/admin/friends/${f.a}/${f.b}`, null, ADMIN)).status, 200);
  r = await call(acc, "GET", `/api/admin/sessions?userId=${aid}`, null, ADMIN);
  assert.equal(r.data.sessions.length, 1); assert.equal(r.data.sessions[0].id.length, 12);
  assert.equal((await call(acc, "DELETE", `/api/admin/sessions/${r.data.sessions[0].id}`, null, ADMIN)).status, 200);
  assert.equal((await call(acc, "GET", "/api/me", null, a.token)).status, 401);

  // delete user reuses account deletion
  const bid = (await call(acc, "GET", "/api/admin/users?q=bob", null, ADMIN)).data.users[0].id;
  assert.equal((await call(acc, "DELETE", `/api/admin/users/${bid}`, null, ADMIN)).status, 200);
  assert.equal((await call(acc, "GET", "/api/me", null, b.token)).status, 401);
  const log = (await call(acc, "GET", "/api/admin/log", null, ADMIN)).data.log.map(x => x.action);
  for (const k of ["user.edit", "match.create", "match.edit", "match.delete", "friend.delete", "session.delete", "user.delete"]) assert.ok(log.includes(k), k);
});

test("admin moves: read stored move list (admin only), 404 when none, filter verify=moves", async () => {
  const acc = await make({ ADMIN_TOKEN: ADMIN });
  await call(acc, "POST", "/api/register", { username: "Mo", password: "secret1", confirmPassword: "secret1" });
  const uid = (await call(acc, "GET", "/api/admin/users?q=mo", null, ADMIN)).data.users[0].id;
  for (const id of ["mv-game-01", "mv-game-02"])
    await call(acc, "POST", "/api/admin/matches", { userId: uid, id, mode: "vsAI", players: 2, boardSize: 5, moves: 40, result: "win" }, ADMIN);
  acc.sql.exec(`UPDATE matches SET sim_moves = ?, sim_board = ? WHERE user_id = ? AND id = ?`, "023112", "1f00", uid, "mv-game-01");
  let r = await call(acc, "GET", `/api/admin/matches/${uid}/mv-game-01/moves`, null, ADMIN);
  assert.equal(r.status, 200); assert.equal(r.data.moves, "023112"); assert.equal(r.data.board, "1f00"); assert.equal(r.data.boardSize, 5);
  assert.equal((await call(acc, "GET", `/api/admin/matches/${uid}/mv-game-02/moves`, null, ADMIN)).status, 404);
  assert.equal((await call(acc, "GET", `/api/admin/matches/${uid}/mv-game-01/moves`)).status, 401);
  r = await call(acc, "GET", "/api/admin/matches?verify=moves", null, ADMIN);
  assert.deepEqual(r.data.matches.map((m) => m.id), ["mv-game-01"]); assert.equal(r.data.matches[0].hasMoves, true);
});

test("relabel-bot0: dry run, apply with backup, undo; party 'Bot 3' and aiKey untouched", async () => {
  const acc = await make({ ADMIN_TOKEN: ADMIN });
  await call(acc, "POST", "/api/register", { username: "relab", password: "secret1", confirmPassword: "secret1" });
  const uid = (await call(acc, "GET", "/api/admin/users?q=relab", null, ADMIN)).data.users[0].id;
  const mk = (id, aiLabel, aiKey) => call(acc, "POST", "/api/admin/matches", { userId: uid, id, mode: "vsAI", players: 2, boardSize: 6, aiKey, aiLabel, moves: 40, result: "loss" }, ADMIN);
  await mk("relabel-0001", "Bot 3 · 强度 4", "bot3-s4");
  await mk("relabel-0002", "Bot 3 · 入门", "bot3-s0");
  await mk("relabel-0003", "Bot 3", "bot3-s4");
  await mk("relabel-0004", "Bot 2 · 2档", "bot2-l2");
  let r = (await call(acc, "POST", "/api/admin/relabel-bot0", { dryRun: true }, ADMIN)).data;
  assert.equal(r.count, 2);
  assert.deepEqual(r.rows.map(x => x.to).sort(), ["Bot 0 · 入门", "Bot 0 · 困难+"]);
  r = (await call(acc, "POST", "/api/admin/relabel-bot0", { dryRun: false }, ADMIN)).data;
  assert.equal(r.count, 2);
  const list = (await call(acc, "GET", `/api/admin/matches?userId=${uid}`, null, ADMIN)).data;
  const labels = Object.fromEntries((list.matches || []).map(m => [m.id, [m.aiLabel, m.aiKey]]));
  assert.deepEqual(labels["relabel-0001"], ["Bot 0 · 困难+", "bot3-s4"]);
  assert.deepEqual(labels["relabel-0003"], ["Bot 3", "bot3-s4"]);
  assert.deepEqual(labels["relabel-0004"], ["Bot 2 · 2档", "bot2-l2"]);
  assert.equal(((await call(acc, "POST", "/api/admin/relabel-bot0", { dryRun: true }, ADMIN)).data).count, 0);
  assert.equal(((await call(acc, "POST", "/api/admin/relabel-bot0/undo", { batch: r.batch }, ADMIN)).data).restored, 2);
});
