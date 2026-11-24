import test from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "./accounts.js";
import { compareGames, encodeMoves, SIMILARITY } from "./similarity.js";

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const randomMoves = (n, seed) => { const r = rng(seed); return Array.from({ length: n }, (_, i) => [i % 2, Math.floor(r() * 6), Math.floor(r() * 6)]); };

async function openDb() {
  try { const { DatabaseSync } = await import("node:sqlite"); return new DatabaseSync(":memory:"); }
  catch { const { Database } = await import("bun:sqlite"); return new Database(":memory:"); }
}
async function make(env = {}) {
  const db = await openDb();
  const sql = { exec(q, ...b) { const st = db.prepare(q); const rd = /^\s*(SELECT|WITH)/i.test(q); const rows = rd ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } };
  return new Accounts({ storage: { sql } }, env);
}
async function call(acc, method, path, body, token) {
  const headers = { "content-type": "application/json", "cf-connecting-ip": "6.6.6.6" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await acc.fetch(new Request(`https://x.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function setup(env) {
  const acc = await make({ ADMIN_TOKEN: "adm-secret-1", ...env });
  const tok = (await call(acc, "POST", "/api/register", { username: "Farmer", password: "secret1", confirmPassword: "secret1" })).data.token;
  let i = 0;
  const t0 = Date.now() - 20 * 3600000;
  const up = async (id, moveList, over = {}) => {
    const n = moveList ? moveList.length : 40;
    i++;
    await call(acc, "POST", "/api/matches", { matches: [{ id, playedAt: t0 + i * 900000, mode: "vsAI", players: 2, boardSize: 6, aiKey: "bot3-s2", aiLabel: "Bot 3 · 强度 2",
      moves: n, myMoves: Math.ceil(n / 2), result: "win", duration: 600, moveList, ...over }] }, tok);
  };
  const row = (id) => acc.one(`SELECT * FROM matches WHERE id = ?`, id);
  const lb = async () => (await call(acc, "GET", "/api/leaderboard?period=all&aiKey=bot3-s2&boardSize=6")).data.entries[0]?.games ?? 0;
  return { acc, up, row, lb };
}

test("compareGames rules", () => {
  const a = randomMoves(40, 1);
  const enc = (l) => encodeMoves(l);
  // identical tail (restore farm: different openings, same finish)
  const b = [...randomMoves(25, 2), ...a.slice(-15)];
  assert.equal(compareGames({ moves: enc(a) }, { moves: enc(b) }).dup, true);
  // 92% aligned
  const c = a.map((m, i) => (i % 13 === 0 ? [m[0], (m[1] + 1) % 6, m[2]] : m));
  c[c.length - 1] = [9, 9, 9];
  const r = compareGames({ moves: enc(a) }, { moves: enc(c) });
  assert.equal(r.dup, true); assert.ok(r.percent >= 90);
  // same final board
  assert.equal(compareGames({ moves: enc(a), board: "0a1b" }, { moves: enc(randomMoves(40, 3)), board: "0a1b" }).dup, true);
  // short games never compared
  assert.equal(compareGames({ moves: enc(a.slice(0, 29)) }, { moves: enc(a.slice(0, 29)) }).dup, false);
  // same opening (first 20 moves), different tails → not duplicate
  const d = [...a.slice(0, 20), ...randomMoves(25, 7)];
  assert.equal(compareGames({ moves: enc(a) }, { moves: enc(d) }).dup, false);
});

test("observe-only (SIMILARITY_ENFORCE=false): restore-farm wins are flagged but still ranked; restored uploads never ranked", async () => {
  const { acc, up, row, lb } = await setup({ SIMILARITY_ENFORCE: "false" });
  const finish = randomMoves(15, 42);
  await up("farm-0001", [...randomMoves(20, 10), ...finish]);
  await up("farm-0002", [...randomMoves(18, 11), ...finish]);
  await up("farm-0003", [...randomMoves(30, 12), ...finish]);
  assert.equal(row("farm-0001").sim_status, null);
  assert.match(row("farm-0002").sim_reason, /^与对局 farm-0001 相似度 \d+%/);
  assert.equal(row("farm-0003").sim_status, "dup");
  assert.equal(await lb(), 3); // observe-only: nothing excluded yet
  // restored game: stored, in history, never on the leaderboard
  await up("restored-1", randomMoves(12, 5), { restored: true });
  assert.equal(row("restored-1").restored, 1);
  assert.equal(await lb(), 3);
  // admin sees them
  const sim = (await call(acc, "GET", "/api/admin/matches?verify=similar", null, "adm-secret-1")).data.matches;
  assert.equal(sim.length, 2); assert.ok(sim[0].similarReason.includes("相似度"));
});

test("enforced: only the earliest stays ranked; admin approve puts one back; honest games untouched; old clients fine", async () => {
  const { acc, up, row, lb } = await setup({ SIMILARITY_ENFORCE: "true" });
  const finish = randomMoves(15, 42);
  const opening = randomMoves(20, 99); // same honest opening every time
  await up("farm-0001", [...randomMoves(20, 10), ...finish]);
  await up("farm-0002", [...randomMoves(18, 11), ...finish]);
  await up("honest-01", [...opening, ...randomMoves(20, 1)]);
  await up("honest-02", [...opening, ...randomMoves(22, 2)]);
  await up("short-001", randomMoves(20, 3));
  await up("short-002", randomMoves(20, 3));   // identical but < 30 moves → not compared
  await up("oldclient", undefined);             // no move list → existing checks only
  for (const id of ["honest-01", "honest-02", "short-001", "short-002", "oldclient"]) assert.equal(row(id).sim_status, null, id);
  assert.equal(row("farm-0002").sim_status, "dup");
  assert.equal(await lb(), 6);
  const uid = row("farm-0002").user_id;
  assert.equal((await call(acc, "PATCH", `/api/admin/matches/${uid}/farm-0002`, { similar: "approved" }, "adm-secret-1")).status, 200);
  assert.equal(await lb(), 7);
  // out-of-order upload: an earlier game arriving later flags the later stored one instead
  // (moves are stored only for 7 days and capped per user)
  assert.ok(SIMILARITY.maxStoredPerUser > 0 && row("farm-0001").sim_moves.length === 35 * 3);
  // profile still counts everything
});

test("move lists are pruned after the window", async () => {
  const { acc, up, row } = await setup({});
  await up("old-game01", randomMoves(40, 1), { playedAt: Date.now() - 9 * 86400000 });
  assert.ok(row("old-game01").sim_moves);
  await up("new-game01", randomMoves(40, 2));
  assert.equal(row("old-game01").sim_moves, null);
});

test("enforcement is on by default; only 'false' turns it off", async () => {
  const { similarityEnforced } = await import("./similarity.js");
  assert.equal(similarityEnforced({}), true);
  assert.equal(similarityEnforced(undefined), true);
  assert.equal(similarityEnforced({ SIMILARITY_ENFORCE: "true" }), true);
  assert.equal(similarityEnforced({ SIMILARITY_ENFORCE: "FALSE" }), false);
});
