import test from "node:test";
import assert from "node:assert/strict";
import { replayGame, checkUpload, LIMITS } from "./verify.js";
import { Accounts } from "./accounts.js";
import { onlineGameRecord } from "./server.js";

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
// random legal game, judged only by the server replay
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

const NOW = Date.UTC(2026, 10, 23, 4, 0, 0);
const good = (over = {}) => ({ mode: "vsAI", players: 2, boardSize: 6, aiKey: "bot3-s4", moves: 40, myMoves: 20, result: "win", duration: 300, playedAt: NOW - 600000, ...over });

test("replay: illegal moves and wrong turns are rejected, a real game ends with a winner", () => {
  const g = randomGame({ boardSize: 5, seats: [0, 1], start: "duel", seed: 3 });
  assert.ok(g.result.ok && g.result.winner !== null);
  assert.equal(replayGame({ boardSize: 5, seats: [0, 1], start: "duel", moveList: [[4, 4, 0]] }).ok, false);
  assert.equal(replayGame({ boardSize: 5, seats: [0, 1], start: "duel", moveList: [[0, 0, 1]] }).ok, false);
});

test("a normal vs-AI upload is ok", () => {
  assert.equal(checkUpload(good(), {}, { now: NOW }).verify, "ok");
});

test("forged / impossible uploads are flagged with a reason", () => {
  const cases = [
    [good({ moves: 2, myMoves: 1 }), {}],                         // too few steps to finish
    [good({ moves: 5000, myMoves: 2500, duration: 99999 }), {}],  // too many steps for 6×6
    [good({ myMoves: 35 }), {}],                                  // not alternating in a 2-player game
    [good({ myMoves: 50 }), {}],                                  // my moves > total
    [good({ duration: 2 }), {}],                                  // 40 moves in 2 s
    [good({ playedAt: NOW + 3600000 }), {}],                      // in the future
    [good({ playedAt: NOW - 3 * 365 * 86400000 }), {}],           // years ago
    [good({ players: 3 }), {}],                                   // vs-AI must be 2 players
    [good({ boardSize: 40 }), {}],                                // board too big
  ];
  for (const [m, raw] of cases) {
    const v = checkUpload(m, raw, { now: NOW });
    assert.equal(v.verify, "flagged", JSON.stringify(m));
    assert.ok(v.reason);
  }
  // rate limits / daily cap
  assert.match(checkUpload(good(), {}, { now: NOW, recentTen: LIMITS.perTenMinutes }).reason, /频繁/);
  assert.match(checkUpload(good(), {}, { now: NOW, recentDay: LIMITS.perDay }).reason, /每日上限/);
  // overlapping in time with another vs-AI game
  const prior = [{ played_at: NOW - 600000 + 60000, duration: 300, mode: "vsAI", ai_key: "bot3-s4", result: "win" }];
  assert.match(checkUpload(good(), {}, { now: NOW, prior }).reason, /重叠/);
  // back-to-back games are fine
  assert.equal(checkUpload(good(), {}, { now: NOW, prior: [{ played_at: NOW - 600000 - 300000, duration: 290, mode: "vsAI", ai_key: "bot3-s4", result: "win" }] }).verify, "ok");
  // impossible win streak against a strong AI
  const streak = Array.from({ length: LIMITS.streakWins }, (_, i) => ({ played_at: NOW - 3600000 * (i + 1), duration: 60, mode: "vsAI", ai_key: "bot3-s5", result: "win" }));
  assert.match(checkUpload(good(), {}, { now: NOW, prior: streak }).reason, /连胜/);
  // same streak vs a weak AI is fine
  assert.equal(checkUpload(good({ aiKey: "bot3-s1" }), {}, { now: NOW, prior: streak.map(p => ({ ...p, ai_key: "bot3-s1" })) }).verify, "ok");
  assert.match(checkUpload(good(), {}, { now: NOW, strongWinsDay: LIMITS.dailyWinsStrong }).reason, /胜场异常/);
});

test("online: room server record is the source of truth", () => {
  const g = randomGame({ boardSize: 5, seats: [0, 1, 2], start: "empty", seed: 9 });
  const rec = onlineGameRecord({ boardSize: 5, playerTypes: ["真人", "真人", "真人", "未加入"], playerNames: ["Sam", "Tom", "Amy", ""] }, { startedAt: NOW, moves: g.moveList });
  assert.ok(rec);
  assert.equal(rec.moves, g.moveList.length);
  const w = g.result.winner;
  const winnerName = ["Sam", "Tom", "Amy"][w];
  const base = { mode: "online", players: 3, boardSize: 5, moves: rec.moves, playedAt: NOW - 600000, duration: 400 };
  const raw = { detail: { names: ["Sam", "Tom", "Amy"], winnerName } };
  // the real winner uploads the truth → ok
  assert.equal(checkUpload({ ...base, myMoves: rec.winnerSeatMoves, result: "win" }, raw, { now: NOW, onlineRecord: rec }).verify, "ok");
  // a loser claims the win → flagged
  const loserSeat = [0, 1, 2].find((s) => s !== w);
  const loserMoves = g.result.perPlayer[loserSeat] || 0;
  if (loserMoves !== rec.winnerSeatMoves)
    assert.equal(checkUpload({ ...base, myMoves: loserMoves, result: "win" }, { detail: { ...raw.detail, winnerName: ["Sam", "Tom", "Amy"][loserSeat] } }, { now: NOW, onlineRecord: rec }).verify, "flagged");
  assert.equal(checkUpload({ ...base, myMoves: rec.winnerSeatMoves, result: "win" }, { detail: { ...raw.detail, winnerName: "Nobody" } }, { now: NOW, onlineRecord: rec }).verify, "flagged");
  // wrong step count → flagged
  assert.match(checkUpload({ ...base, moves: rec.moves + 7, myMoves: rec.winnerSeatMoves, result: "win" }, raw, { now: NOW, onlineRecord: rec }).reason, /服务器联机记录/);
  // unfinished game in the room → no record
  assert.equal(onlineGameRecord({ boardSize: 5, playerTypes: ["真人", "真人", "真人"], playerNames: ["a", "b", "c"] }, { moves: g.moveList.slice(0, 3) }), null);
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

test("end to end: forged uploads are kept but off the leaderboard until an admin approves; history untouched", async () => {
  const acc = await make({ ADMIN_TOKEN: "adm-secret-1" });
  const tok = (await call(acc, "POST", "/api/register", { username: "Sam", password: "secret1", confirmPassword: "secret1" })).data.token;
  const t = Date.now() - 3 * 3600000;
  const up = (id, i, over = {}) => ({ id, playedAt: t + i * 600000, mode: "vsAI", players: 2, boardSize: 6, aiKey: "bot3-s1", aiLabel: "Bot 3 · 强度 1", moves: 30, myMoves: 15, result: "win", duration: 200, ...over });
  // a historical row (from before anti-cheat): verify stays NULL and keeps counting
  await call(acc, "POST", "/api/matches", { matches: [up("hist-0001", 0)] }, tok);
  acc.sql.exec(`UPDATE matches SET verify = NULL, verify_reason = NULL`);
  await call(acc, "POST", "/api/matches", { matches: [up("good-0001", 1), up("good-0002", 2), up("forged-001", 3, { moves: 3, myMoves: 2, duration: 1 })] }, tok);
  const rows = acc.q(`SELECT id, verify FROM matches ORDER BY id`);
  assert.deepEqual(rows.map(r => [r.id, r.verify]), [["forged-001", "flagged"], ["good-0001", "ok"], ["good-0002", "ok"], ["hist-0001", null]]);
  const lb = async () => (await call(acc, "GET", "/api/leaderboard?period=all&aiKey=bot3-s1&boardSize=6")).data.entries;
  assert.equal((await lb())[0].games, 3);
  const flagged = (await call(acc, "GET", "/api/admin/matches?verify=flagged", null, "adm-secret-1")).data.matches;
  assert.equal(flagged.length, 1); assert.ok(flagged[0].verifyReason);
  const uid = flagged[0].userId;
  assert.equal((await call(acc, "PATCH", `/api/admin/matches/${uid}/forged-001`, { verify: "approved" }, "adm-secret-1")).status, 200);
  assert.equal((await lb())[0].games, 4);
  assert.equal((await call(acc, "GET", "/api/me", null, tok)).data.user.stats.games, 4);
});

test("end to end: online upload checked against the record the room posted", async () => {
  const acc = await make();
  const tok = (await call(acc, "POST", "/api/register", { username: "Sam", password: "secret1", confirmPassword: "secret1" })).data.token;
  const g = randomGame({ boardSize: 5, seats: [0, 1], start: "empty", seed: 5 });
  const rec = onlineGameRecord({ boardSize: 5, playerTypes: ["真人", "真人"], playerNames: ["Sam", "Tom"] }, { startedAt: Date.now() - 100000, moves: g.moveList });
  // the internal route is reachable only from inside (the Worker forwards /api/* only)
  assert.equal((await call(acc, "POST", "/internal/online-game", rec)).status, 200);
  const w = rec.winnerName, mine = rec.winnerSeatMoves;
  const base = { mode: "online", players: 2, boardSize: 5, moves: rec.moves, playedAt: Date.now() - 200000, duration: 150, detail: { names: ["Sam", "Tom"], winnerName: w } };
  await call(acc, "POST", "/api/matches", { matches: [{ id: "on-real-01", ...base, myMoves: mine, result: "win" }] }, tok);
  await call(acc, "POST", "/api/matches", { matches: [{ id: "on-fake-01", ...base, moves: rec.moves + 10, myMoves: mine + 5, result: "win", playedAt: Date.now() - 190000, duration: 1 }] }, tok);
  const r = Object.fromEntries(acc.q(`SELECT id, verify, verify_reason FROM matches`).map(x => [x.id, x]));
  assert.equal(r["on-real-01"].verify, "ok"); assert.match(r["on-real-01"].verify_reason, /一致/);
  assert.equal(r["on-fake-01"].verify, "flagged");
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
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("leaderboard only counts 6/9/12 boards; other sizes stay in history", async () => {
  const acc = await make({});
  const tok = (await call(acc, "POST", "/api/register", { username: "Size", password: "secret1", confirmPassword: "secret1" })).data.token;
  const t = Date.now() - 3600000;
  const up = (id, i, boardSize) => ({ id, playedAt: t + i * 600000, mode: "vsAI", players: 2, boardSize, aiKey: "bot3-s1", aiLabel: "Bot 3 · 强度 1", moves: 30, myMoves: 15, result: "win", duration: 200 });
  await call(acc, "POST", "/api/matches", { matches: [up("size-0005", 0, 5), up("size-0006", 1, 6), up("size-0008", 2, 8)] }, tok);
  const d = (await call(acc, "GET", "/api/leaderboard?period=all&aiKey=bot3-s1")).data;
  assert.deepEqual(d.boardSizes.map(b => b.boardSize), [6]);
  assert.equal((await call(acc, "GET", "/api/leaderboard?period=all&aiKey=bot3-s1&boardSize=5")).data.entries.length, 0);
  assert.equal(acc.q(`SELECT COUNT(*) AS n FROM matches`)[0].n, 3);
});
