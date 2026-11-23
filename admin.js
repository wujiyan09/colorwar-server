// Admin API for Sam's own server: /api/admin/*. Auth is a separate Worker secret ADMIN_TOKEN
// (Cloudflare dashboard → Workers & Pages → colorwar-server → Settings → Variables and Secrets).
// If ADMIN_TOKEN is not set, every /api/admin route answers 404. Never returns passwords.
// Edits go straight into the same tables the app and leaderboard read, so they show up immediately.
import { normalizeMatch, validateUsername } from "./accounts.js";

const RESULTS = ["win", "loss", "draw", "none"];
const MODES = ["vsAI", "local", "online"];

function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i % x.length] || 0) ^ (y[i % y.length] || 0);
  return diff === 0;
}

export async function handleAdmin(acc, request, url, path, method, { HttpError, json }) {
  const secret = acc.env?.ADMIN_TOKEN;
  if (!secret) throw new HttpError(404, "Not found");
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const limitKey = `admin:${ip}`;
  acc.checkRateLimit(limitKey);
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !constantTimeEqual(token, secret)) {
    acc.recordFailure(limitKey);
    throw new HttpError(401, "管理员口令不正确");
  }
  acc.sql.exec(`DELETE FROM login_failures WHERE key = ?`, limitKey);
  acc.sql.exec(`CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, ip TEXT,
    action TEXT NOT NULL, target TEXT, detail TEXT)`);
  const log = (action, target, detail) => acc.sql.exec(`INSERT INTO admin_log (at, ip, action, target, detail) VALUES (?, ?, ?, ?, ?)`,
    Date.now(), ip, action, target == null ? null : String(target), detail == null ? null : JSON.stringify(detail).slice(0, 4000));
  const body = () => acc.body(request);
  const sub = path.slice("/api/admin".length) || "/";
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
  const userRow = (id) => {
    const u = acc.one(`SELECT * FROM users WHERE id = ?`, id);
    if (!u) throw new HttpError(404, "用户不存在");
    return u;
  };
  const userOut = (u) => ({
    id: u.id, username: u.username, email: u.email || null, createdAt: u.created_at, avatar: u.avatar || null,
    hasPassword: !!u.pw_hash,
    games: acc.one(`SELECT COUNT(*) AS n FROM matches WHERE user_id = ?`, u.id)?.n || 0,
  });
  const matchOut = (r) => ({
    userId: r.user_id, username: r.username ?? null, id: r.id, playedAt: r.played_at, mode: r.mode, players: r.players,
    boardSize: r.board_size, aiKey: r.ai_key, aiLabel: r.ai_label, moves: r.moves, myMoves: r.my_moves, result: r.result,
    duration: r.duration, verify: r.verify ?? null, verifyReason: r.verify_reason ?? null,
    restored: !!r.restored, similar: r.sim_status ?? null, similarReason: r.sim_reason ?? null,
    detail: r.detail ? (() => { try { return JSON.parse(r.detail); } catch { return r.detail; } })() : null,
  });

  // ---- users ----
  if (sub === "/users" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const rows = q
      ? acc.q(`SELECT * FROM users WHERE username_key LIKE ? OR id = ? OR lower(IFNULL(email,'')) LIKE ? ORDER BY created_at DESC LIMIT ?`, `%${q}%`, q, `%${q}%`, limit)
      : acc.q(`SELECT * FROM users ORDER BY created_at DESC LIMIT ?`, limit);
    return json({ users: rows.map(userOut) });
  }
  let m = sub.match(/^\/users\/([^/]+)$/);
  if (m && method === "PATCH") {
    const u = userRow(decodeURIComponent(m[1]));
    const b = await body();
    if (b.username !== undefined) {
      const err = validateUsername(b.username);
      if (err) throw new HttpError(400, err);
      const name = b.username.trim();
      const other = acc.userByName(name);
      if (other && other.id !== u.id) throw new HttpError(409, "这个用户名已经被占用了");
      acc.sql.exec(`UPDATE users SET username = ?, username_key = ? WHERE id = ?`, name, name.toLowerCase(), u.id);
    }
    if (b.email !== undefined) {
      const email = b.email === null ? "" : String(b.email).trim();
      if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new HttpError(400, "邮箱格式不正确");
      acc.sql.exec(`UPDATE users SET email = ? WHERE id = ?`, email || null, u.id);
    }
    log("user.edit", u.id, { username: b.username, email: b.email });
    return json({ user: userOut(userRow(u.id)) });
  }
  if (m && method === "DELETE") {
    const u = userRow(decodeURIComponent(m[1]));
    acc.purgeUser(u);
    log("user.delete", u.id, { username: u.username });
    return json({ ok: true });
  }

  // ---- matches ----
  if (sub === "/matches" && method === "GET") {
    const where = [], args = [];
    const userId = url.searchParams.get("userId"), username = url.searchParams.get("username");
    if (userId) { where.push("m.user_id = ?"); args.push(userId); }
    if (username) { where.push("u.username_key = ?"); args.push(username.trim().toLowerCase()); }
    const verify = url.searchParams.get("verify");
    if (verify === "historical") where.push("m.verify IS NULL");
    else if (verify === "similar") where.push("m.sim_status = 'dup'");
    else if (verify === "restored") where.push("m.restored = 1");
    else if (verify) { where.push("m.verify = ?"); args.push(verify); }
    if (url.searchParams.get("aiKey")) { where.push("m.ai_key = ?"); args.push(url.searchParams.get("aiKey")); }
    if (url.searchParams.get("from")) { where.push("m.played_at >= ?"); args.push(Number(url.searchParams.get("from")) || 0); }
    if (url.searchParams.get("to")) { where.push("m.played_at < ?"); args.push(Number(url.searchParams.get("to")) || 0); }
    const rows = acc.q(`SELECT m.*, u.username FROM matches m LEFT JOIN users u ON u.id = m.user_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.played_at DESC LIMIT ?`, ...args, limit);
    return json({ matches: rows.map(matchOut) });
  }
  if (sub === "/matches" && method === "POST") {
    const b = await body();
    const u = userRow(String(b.userId || ""));
    const raw = { id: b.id || `admin-${crypto.randomUUID()}`, playedAt: b.playedAt ?? Date.now(), ...b };
    if (!raw.id) raw.id = `admin-${crypto.randomUUID()}`;
    const fx = normalizeMatch(raw);
    if (!fx) throw new HttpError(400, "对局 ID 格式不正确（8–64 位字母数字或 -）");
    if (b.result !== undefined && !RESULTS.includes(b.result)) throw new HttpError(400, "result 只能是 win/loss/draw/none");
    if (b.mode !== undefined && !MODES.includes(b.mode)) throw new HttpError(400, "mode 只能是 vsAI/local/online");
    if (acc.one(`SELECT 1 AS x FROM matches WHERE user_id = ? AND id = ?`, u.id, fx.id)) throw new HttpError(409, "这个对局 ID 已存在");
    acc.sql.exec(`INSERT INTO matches (user_id, id, played_at, mode, players, board_size, ai_key, ai_label, moves, my_moves, result, duration, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      u.id, fx.id, fx.playedAt, fx.mode, fx.players, fx.boardSize, fx.aiKey, fx.aiLabel, fx.moves, fx.myMoves, fx.result, fx.duration, fx.detail);
    acc.sql.exec(`UPDATE matches SET verify = 'approved', verify_reason = '管理员手动添加', uploaded_at = ? WHERE user_id = ? AND id = ?`, Date.now(), u.id, fx.id);
    log("match.create", `${u.id}/${fx.id}`, fx);
    return json({ match: matchOut(acc.one(`SELECT * FROM matches WHERE user_id = ? AND id = ?`, u.id, fx.id)) }, 201);
  }
  m = sub.match(/^\/matches\/([^/]+)\/([^/]+)$/);
  if (m && (method === "PATCH" || method === "DELETE")) {
    const userId = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]);
    const row = acc.one(`SELECT * FROM matches WHERE user_id = ? AND id = ?`, userId, id);
    if (!row) throw new HttpError(404, "对局不存在");
    if (method === "DELETE") {
      acc.sql.exec(`DELETE FROM matches WHERE user_id = ? AND id = ?`, userId, id);
      log("match.delete", `${userId}/${id}`, matchOut(row));
      return json({ ok: true });
    }
    const b = await body();
    if (b.result !== undefined && !RESULTS.includes(b.result)) throw new HttpError(400, "result 只能是 win/loss/draw/none");
    if (b.mode !== undefined && !MODES.includes(b.mode)) throw new HttpError(400, "mode 只能是 vsAI/local/online");
    const cur = matchOut(row);
    const merged = { ...cur, ...b, id, detail: b.detail !== undefined ? b.detail : (cur.detail && typeof cur.detail === "object" ? cur.detail : null) };
    const fx = normalizeMatch(merged);
    if (!fx) throw new HttpError(400, "数据格式不正确");
    acc.sql.exec(`UPDATE matches SET played_at = ?, mode = ?, players = ?, board_size = ?, ai_key = ?, ai_label = ?, moves = ?, my_moves = ?,
      result = ?, duration = ?, detail = ? WHERE user_id = ? AND id = ?`,
      fx.playedAt, fx.mode, fx.players, fx.boardSize, fx.aiKey, fx.aiLabel, fx.moves, fx.myMoves, fx.result, fx.duration, fx.detail, userId, id);
    if (b.verify !== undefined) {
      if (!["ok", "approved", "flagged", "unverified"].includes(b.verify)) throw new HttpError(400, "verify 只能是 ok/approved/flagged/unverified");
      acc.sql.exec(`UPDATE matches SET verify = ?, verify_reason = ? WHERE user_id = ? AND id = ?`,
        b.verify, b.verify === "approved" ? `管理员批准（原因：${row.verify_reason || "无"}）`.slice(0, 300) : row.verify_reason, userId, id);
    }
    if (b.similar !== undefined) {
      if (b.similar !== "approved") throw new HttpError(400, "similar 只能是 approved");
      acc.sql.exec(`UPDATE matches SET sim_status = 'approved' WHERE user_id = ? AND id = ?`, userId, id);
    }
    log("match.edit", `${userId}/${id}`, { before: cur, changes: b });
    return json({ match: matchOut(acc.one(`SELECT * FROM matches WHERE user_id = ? AND id = ?`, userId, id)) });
  }

  // ---- friends ----
  if (sub === "/friends" && method === "GET") {
    const userId = url.searchParams.get("userId");
    const rows = acc.q(`SELECT f.*, ua.username AS a_name, ub.username AS b_name FROM friends f
      LEFT JOIN users ua ON ua.id = f.a LEFT JOIN users ub ON ub.id = f.b
      ${userId ? "WHERE f.a = ? OR f.b = ?" : ""} ORDER BY f.created_at DESC LIMIT ?`, ...(userId ? [userId, userId] : []), limit);
    return json({ friends: rows.map(r => ({ a: r.a, b: r.b, aName: r.a_name, bName: r.b_name, status: r.status, requester: r.requester, createdAt: r.created_at })) });
  }
  m = sub.match(/^\/friends\/([^/]+)\/([^/]+)$/);
  if (m && method === "DELETE") {
    const a = decodeURIComponent(m[1]), b = decodeURIComponent(m[2]);
    const [x, y] = a < b ? [a, b] : [b, a];
    const n = acc.q(`SELECT 1 AS x FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)`, x, y, a, b).length;
    if (!n) throw new HttpError(404, "好友关系不存在");
    acc.sql.exec(`DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)`, x, y, a, b);
    log("friend.delete", `${a}/${b}`, null);
    return json({ ok: true });
  }

  // ---- sessions ----
  if (sub === "/sessions" && method === "GET") {
    const userId = url.searchParams.get("userId");
    const rows = acc.q(`SELECT s.*, u.username FROM sessions s LEFT JOIN users u ON u.id = s.user_id
      ${userId ? "WHERE s.user_id = ?" : ""} ORDER BY s.last_seen DESC LIMIT ?`, ...(userId ? [userId] : []), limit);
    // never expose full tokens; the short id is enough to delete one
    return json({ sessions: rows.map(r => ({ id: r.token.slice(0, 12), userId: r.user_id, username: r.username, createdAt: r.created_at, lastSeen: r.last_seen })) });
  }
  m = sub.match(/^\/sessions\/([^/]+)$/);
  if (m && method === "DELETE") {
    const prefix = decodeURIComponent(m[1]);
    if (!/^[0-9a-f]{12}$/.test(prefix)) throw new HttpError(400, "会话 ID 格式不正确");
    const rows = acc.q(`SELECT token FROM sessions WHERE substr(token, 1, 12) = ?`, prefix);
    if (!rows.length) throw new HttpError(404, "会话不存在");
    acc.sql.exec(`DELETE FROM sessions WHERE substr(token, 1, 12) = ?`, prefix);
    log("session.delete", prefix, null);
    return json({ ok: true, deleted: rows.length });
  }

  if (sub === "/log" && method === "GET") {
    return json({ log: acc.q(`SELECT * FROM admin_log ORDER BY id DESC LIMIT ?`, limit) });
  }
  throw new HttpError(404, "Not found");
}
