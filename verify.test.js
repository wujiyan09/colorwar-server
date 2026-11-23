import test from "node:test";
import assert from "node:assert/strict";
import { replayGame, verifyUpload } from "./verify.js";
import { Accounts } from "./accounts.js";

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
// Plays random legal moves until the game ends, using only the server replay to judge legality.
function randomGame({ boardSize, seats, start, seed }) {
  const rand = rng(seed), list = [];
  for (let step = 0; step < 3000; step++) {
    const tries = [];
    for (let r = 0; r < boardSize; r++) for (let c = 0; c < boardSize; c++) for (const p of seats) tries.push([r, c, p]);
    tries.sort(() => rand() - 0.5);
    let found = null;
    for (const mv of tries) {
      const res = replayGame({ boardSize, seats, start, moveList: [...list, mv] });
      if (res.ok) return { moveList: [...list, mv], result: res };
      if (res.reason === "按棋步走完，对局并没有结束") { found = mv; break; }
    }
    if (!found) throw new Error("stuck");
    list.push(found);
  }
  throw new Error("too long");
}
const game = randomGame({ boardSize: 5, seats: [0, 1], start: "duel", seed: 3 });
const winner = game.result.winner;
const claim = (over = {}) => {
  const me = 0, moves = game.moveList.length;
  const m = { mode: "vsAI", players: 2, boardSize: 5, moves, myMoves: game.result.perPlayer[me] || 0, result: winner === me ? "win" : "loss", duration: 600 };
  const raw = { moveList: game.moveList, seats: [0, 1], mySeat: me, start: "duel" };
  return { m: { ...m, ...(over.m || {}) }, raw: { ...raw, ...(over.raw || {}) } };
};

test("genuine game verifies ok", () => {
  const { m, raw } = claim();
  assert.equal(verifyUpload(m, raw).verify, "ok");
});

test("forged uploads are flagged with a reason", () => {
  const cases = [
    claim({ m: { result: winner === 0 ? "loss" : "win" } }),                  // flipped result
    claim({ m: { moves: game.moveList.length + 5 } }),                          // wrong step count
    claim({ m: { myMoves: 1 } }),                                               // wrong own moves
    claim({ m: { boardSize: 6 } }),                                             // wrong board size
    claim({ raw: { moveList: game.moveList.slice(0, -1) } }),                   // game not finished
    claim({ raw: { moveList: [...game.moveList, game.moveList.at(-1)] } }),     // moves after the end
    claim({ raw: { moveList: [[0, 0, 1], ...game.moveList.slice(1)] } }),       // wrong turn
    claim({ raw: { moveList: [[4, 4, 0], ...game.moveList.slice(1)] } }),       // illegal cell (opponent corner)
    claim({ raw: { moveList: [[9, 9, 0], ...game.moveList.slice(1)] } }),       // off board
    claim({ m: { duration: 1 } }),                                              // too fast
    claim({ raw: { seats: [0, 1, 2] }, m: { players: 3 } }),                    // duel start with 3 seats
    claim({ raw: { mySeat: null } }),                                           // vsAI without a human
  ];
  for (const { m, raw } of cases) {
    const v = verifyUpload(m, raw);
    assert.equal(v.verify, "flagged", JSON.stringify(m) + " " + v.reason);
    assert.ok(v.reason);
  }
});

test("old client (no move list) → unverified; upload flood → flagged; online: server room record is the source of truth", () => {
  const { m, raw } = claim();
  assert.equal(verifyUpload(m, { ...raw, moveList: undefined }).verify, "unverified");
  assert.equal(verifyUpload(m, raw, { recentUploads: 40 }).verify, "flagged");
  const online = randomGame({ boardSize: 5, seats: [0, 1, 2], start: "empty", seed: 9 });
  const om = { mode: "online", players: 3, boardSize: 5, moves: online.moveList.length, myMoves: online.result.perPlayer[1] || 0, result: online.result.winner === 1 ? "win" : "loss", duration: 999 };
  const oraw = { moveList: online.moveList, seats: [0, 1, 2], mySeat: 1, start: "empty" };
  assert.equal(verifyUpload(om, oraw, { trusted: [online.moveList] }).verify, "ok");
  // client sends a forged move list but the room's own record is used → the true result decides
  const forged = { ...oraw, moveList: online.moveList.slice(0, 3) };
  assert.equal(verifyUpload(om, forged, { trusted: [online.moveList] }).verify, "ok");
  const lie = { ...om, result: om.result === "win" ? "loss" : "win" };
  assert.equal(verifyUpload(lie, forged, { trusted: [online.moveList] }).verify, "flagged");
});

async function openDb() {
  try { const { DatabaseSync } = await import("node:sqlite"); return new DatabaseSync(":memory:"); }
  catch { const { Database } = await import("bun:sqlite"); return new Database(":memory:"); }
}
async function make(env = {}) {
  const db = await openDb();
  const sql = { exec(q, ...b) { const st = db.prepare(q); const rd = /^\s*(SELECT|WITH)/i.test(q); const rows = rd ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } };
  return new Accounts({ storage: { sql } }, env);
}
async function call(acc, method, path, body, token, origin) {
  const headers = { "content-type": "application/json", "cf-connecting-ip": "5.5.5.5" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  const res = await acc.fetch(new Request(`https://x.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
}

test("leaderboard: verified + historical count, flagged/unverified don't until an admin approves", async () => {
  const acc = await make({ ADMIN_TOKEN: "adm-secret-1" });
  const tok = (await call(acc, "POST", "/api/register", { username: "Sam", password: "secret1", confirmPassword: "secret1" })).data.token;
  const base = claim();
  const up = (id, over = {}) => ({ id, playedAt: Date.now() - 1000, aiKey: "bot3-s1", aiLabel: "Bot 3 · 强度 1", ...base.m, ...base.raw, ...over });
  await call(acc, "POST", "/api/matches", { matches: [up("good-0001"), up("good-0002"), up("forged-001", { result: winner === 0 ? "loss" : "win" }), up("oldclient1", { moveList: undefined })] }, tok);
  const rows = acc.q(`SELECT id, verify FROM matches ORDER BY id`);
  assert.deepEqual(rows.map(r => r.verify), ["flagged", "ok", "ok", "unverified"]);
  const lb = async () => (await call(acc, "GET", "/api/leaderboard?period=all&aiKey=bot3-s1&boardSize=5")).data.entries;
  assert.equal((await lb()).length, 0); // only 2 counted, min 3
  acc.sql.exec(`UPDATE matches SET verify = NULL WHERE id = 'oldclient1'`); // a historical row counts
  assert.equal((await lb())[0].games, 3);
  const uid = acc.q(`SELECT id FROM users`)[0].id;
  const flagged = (await call(acc, "GET", "/api/admin/matches?verify=flagged", null, "adm-secret-1")).data.matches;
  assert.equal(flagged.length, 1); assert.ok(flagged[0].verifyReason.includes("结果不一致")); assert.ok(Array.isArray(flagged[0].moveList));
  await call(acc, "PATCH", `/api/admin/matches/${uid}/forged-001`, { verify: "approved" }, "adm-secret-1");
  assert.equal((await lb())[0].games, 4);
  // profile stats still count everything
  assert.equal((await call(acc, "GET", "/api/me", null, tok)).data.user.stats.games, 4);
});

test("admin CORS only for Sam's admin site", async () => {
  const acc = await make({ ADMIN_TOKEN: "adm-secret-1" });
  let r = await call(acc, "GET", "/api/admin/users", null, "adm-secret-1", "https://wujiyan09.ct.ws");
  assert.equal(r.headers.get("access-control-allow-origin"), "https://wujiyan09.ct.ws");
  r = await call(acc, "GET", "/api/admin/users", null, "adm-secret-1", "http://wujiyan09.ct.ws");
  assert.equal(r.headers.get("access-control-allow-origin"), "http://wujiyan09.ct.ws");
  r = await call(acc, "GET", "/api/admin/users", null, "adm-secret-1", "https://evil.example");
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  r = await call(acc, "GET", "/api/leaderboard?period=all", null, null, "https://evil.example");
  assert.equal(r.headers.get("access-control-allow-origin"), "*"); // public API unchanged
});
