// Color War accounts: username/password login, profile, match history, leaderboards, friends and invites.
// Everything lives in one SQLite-backed Durable Object ("global"), so no D1 database or
// dashboard setup is needed; the Worker deploys it with the existing Workers Builds hook.

import { handleAdmin } from "./admin.js";
import { checkUpload } from "./verify.js";
import { SIMILARITY, countedSql, encodeMoves, cleanBoard, compareGames } from "./similarity.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "600",
};

export const ADMIN_ORIGINS = ["https://wujiyan09.ct.ws", "http://wujiyan09.ct.ws"];
const DAY = 24 * 60 * 60 * 1000;
const HK_OFFSET = 8 * 60 * 60 * 1000;
const SESSION_TTL = 180 * DAY;
const INVITE_TTL = 10 * 60 * 1000;
const MAX_AVATAR_LENGTH = 160_000;

// Leaderboard rule, kept in one place so it is easy to change later.
// Only 2-player games of one human against one AI count, grouped by AI difficulty (aiKey).
// Rank: more wins first, then a higher average number of moves per game (how long you hold out),
// then more games. A player needs at least `minGames` games in the period to appear.
export const LEADERBOARD_RULE = {
  minGames: 3,
  compare(a, b) {
    return (b.wins - a.wins) || (b.avgMoves - a.avgMoves) || (b.games - a.games) || a.username.localeCompare(b.username);
  },
};

export function validateUsername(name) {
  if (typeof name !== "string") return "用户名不能为空";
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 20) return "用户名需要 2–20 个字符";
  if (!/^[\p{L}\p{N}_\-. ]+$/u.test(trimmed)) return "用户名只能包含文字、数字、空格和 _ - .";
  return null;
}

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < 6) return "密码至少 6 位";
  if (password.length > 128) return "密码太长";
  return null;
}

export function validateAvatar(avatar) {
  if (avatar === null || avatar === "") return null;
  if (typeof avatar !== "string" || avatar.length > MAX_AVATAR_LENGTH) return "头像太大";
  if (/^emoji:[^:]{1,16}:#[0-9a-fA-F]{6}$/u.test(avatar)) return null;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) return null;
  return "头像格式不正确";
}

/** Start of the current week (Monday), month, quarter ("season") or year in Hong Kong time. */
export function periodStart(period, now = Date.now()) {
  if (period === "all") return 0; // 总榜：全部时间
  const hk = new Date(now + HK_OFFSET);
  const y = hk.getUTCFullYear();
  const m = hk.getUTCMonth();
  let startUTC;
  switch (period) {
    case "week": {
      const day = (hk.getUTCDay() + 6) % 7; // Monday = 0
      startUTC = Date.UTC(y, m, hk.getUTCDate() - day);
      break;
    }
    case "month": startUTC = Date.UTC(y, m, 1); break;
    case "season": startUTC = Date.UTC(y, m - (m % 3), 1); break;
    case "year": startUTC = Date.UTC(y, 0, 1); break;
    default: return null;
  }
  return startUTC - HK_OFFSET;
}

export function rankLeaderboard(rows, limit = 100, rule = LEADERBOARD_RULE) {
  return rows
    .map((r) => ({ ...r, avgMoves: r.games ? Math.round((r.totalMoves / r.games) * 10) / 10 : 0 }))
    .filter((r) => r.games >= rule.minGames)
    .sort((a, b) => rule.compare(a, b))
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, ...r }));
}

export function normalizeMatch(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").slice(0, 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return null;
  const result = ["win", "loss", "draw", "none"].includes(raw.result) ? raw.result : "none";
  const mode = ["vsAI", "local", "online"].includes(raw.mode) ? raw.mode : "local";
  const int = (v, lo, hi, d = 0) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : d);
  const playedAt = int(raw.playedAt, 0, Date.now() + DAY, Date.now());
  const detail = raw.detail && typeof raw.detail === "object" ? JSON.stringify(raw.detail).slice(0, 4000) : null;
  return {
    id,
    playedAt,
    mode,
    players: int(raw.players, 1, 8, 2),
    boardSize: int(raw.boardSize, 3, 20, 6),
    aiKey: mode === "vsAI" && typeof raw.aiKey === "string" ? raw.aiKey.slice(0, 40) : null,
    aiLabel: typeof raw.aiLabel === "string" ? raw.aiLabel.slice(0, 60) : null,
    moves: int(raw.moves, 0, 100000),
    myMoves: int(raw.myMoves, 0, 100000),
    result,
    duration: int(raw.duration, 0, 7 * 24 * 3600),
    detail,
  };
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// Password storage hook. Sam asked (2026-11-22) to keep passwords as plain text for now so he can write
// his own hashing later: replace ONLY these two functions. `salt` is stored next to the value.
export async function hashPassword(password, saltHex = "") {
  return { hash: String(password), salt: saltHex || "" };
}

export async function verifyPassword(password, storedHash, saltHex = "") {
  const { hash } = await hashPassword(password, saltHex);
  return safeEqual(hash, storedHash);
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...CORS_HEADERS } });
}

export class Accounts {
  constructor(state, env = {}) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.migrate();
  }

  q(query, ...bindings) {
    return this.sql.exec(query, ...bindings).toArray();
  }

  one(query, ...bindings) {
    return this.q(query, ...bindings)[0] ?? null;
  }

  migrate() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
        pw_hash TEXT, pw_salt TEXT, email TEXT, avatar TEXT, created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS matches (user_id TEXT NOT NULL, id TEXT NOT NULL, played_at INTEGER NOT NULL, mode TEXT NOT NULL,
        players INTEGER, board_size INTEGER, ai_key TEXT, ai_label TEXT, moves INTEGER, my_moves INTEGER, result TEXT,
        duration INTEGER, detail TEXT, PRIMARY KEY (user_id, id))`,
      `CREATE INDEX IF NOT EXISTS matches_board ON matches (mode, ai_key, played_at)`,
      `CREATE INDEX IF NOT EXISTS matches_user_time ON matches (user_id, played_at)`,
      `CREATE TABLE IF NOT EXISTS friends (a TEXT NOT NULL, b TEXT NOT NULL, status TEXT NOT NULL, requester TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (a, b))`,
      `CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, room_code TEXT NOT NULL,
        board_size INTEGER, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS push_tokens (user_id TEXT NOT NULL, token TEXT NOT NULL, platform TEXT, updated_at INTEGER, PRIMARY KEY (user_id, token))`,
      `CREATE TABLE IF NOT EXISTS bark_keys (user_id TEXT PRIMARY KEY, bark_key TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS login_failures (key TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL)`,
    ];
    for (const s of statements) this.sql.exec(s);
    // anti-cheat columns (added 2026-11-23); old rows keep verify = NULL and still count
    for (const col of ["verify TEXT", "verify_reason TEXT", "uploaded_at INTEGER",
      "restored INTEGER", "sim_moves TEXT", "sim_board TEXT", "sim_status TEXT", "sim_reason TEXT"]) {
      try { this.sql.exec(`ALTER TABLE matches ADD COLUMN ${col}`); } catch { /* already there */ }
    }
    // 0d3fbbb (live ~12:23–12:32 on 2026-11-23) wrongly marked every upload without a move list 'unverified';
    // that status no longer exists, so put those rows back on the leaderboard
    this.sql.exec(`UPDATE matches SET verify = 'ok', verify_reason = '恢复：早期版本误标未核对' WHERE verify = 'unverified'`);
    // finished online games as recorded and replayed by the room server (source of truth for online uploads)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS online_games (id INTEGER PRIMARY KEY AUTOINCREMENT, ended_at INTEGER NOT NULL,
      board_size INTEGER, players INTEGER, names TEXT, record TEXT)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS online_games_ended ON online_games (ended_at)`);
  }

  publicUser(row) {
    if (!row) return null;
    return { id: row.id, username: row.username, avatar: row.avatar || null };
  }

  privateUser(row) {
    const stats = this.one(`SELECT COUNT(*) AS games, SUM(result = 'win') AS wins, SUM(result = 'loss') AS losses FROM matches WHERE user_id = ?`, row.id);
    return {
      ...this.publicUser(row),
      hasPassword: !!row.pw_hash,
      barkKey: this.one(`SELECT bark_key FROM bark_keys WHERE user_id = ?`, row.id)?.bark_key || null,
      createdAt: row.created_at,
      stats: { games: stats?.games || 0, wins: stats?.wins || 0, losses: stats?.losses || 0 },
    };
  }

  createSession(userId) {
    const token = randomToken();
    const now = Date.now();
    this.sql.exec(`INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)`, token, userId, now, now);
    return token;
  }

  authenticate(request) {
    const header = request.headers.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new HttpError(401, "请先登录");
    const session = this.one(`SELECT * FROM sessions WHERE token = ?`, token);
    if (!session || session.last_seen + SESSION_TTL < Date.now()) throw new HttpError(401, "登录已过期，请重新登录");
    if (Date.now() - session.last_seen > 60 * 60 * 1000) this.sql.exec(`UPDATE sessions SET last_seen = ? WHERE token = ?`, Date.now(), token);
    const user = this.one(`SELECT * FROM users WHERE id = ?`, session.user_id);
    if (!user) throw new HttpError(401, "账号不存在");
    return { user, token };
  }

  userByName(name) {
    return this.one(`SELECT * FROM users WHERE username_key = ?`, String(name || "").trim().toLowerCase());
  }

  checkRateLimit(key) {
    const row = this.one(`SELECT * FROM login_failures WHERE key = ?`, key);
    if (row && row.first_at + 15 * 60 * 1000 > Date.now() && row.count >= 8) throw new HttpError(429, "尝试次数太多，请 15 分钟后再试");
  }

  recordFailure(key) {
    const row = this.one(`SELECT * FROM login_failures WHERE key = ?`, key);
    if (!row || row.first_at + 15 * 60 * 1000 <= Date.now()) {
      this.sql.exec(`INSERT OR REPLACE INTO login_failures (key, count, first_at) VALUES (?, 1, ?)`, key, Date.now());
    } else {
      this.sql.exec(`UPDATE login_failures SET count = count + 1 WHERE key = ?`, key);
    }
  }

  async fetch(request) {
    const res = await this.handle(request);
    if (!new URL(request.url).pathname.startsWith("/api/admin")) return res;
    // 管理接口只允许 Sam 的管理页面跨域调用
    const origin = request.headers.get("origin") || "";
    const headers = new Headers(res.headers);
    if (ADMIN_ORIGINS.includes(origin)) { headers.set("access-control-allow-origin", origin); headers.set("vary", "Origin"); }
    else headers.delete("access-control-allow-origin");
    return new Response(res.body, { status: res.status, headers });
  }

  async handle(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    try {
      return await this.route(request);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "服务器出错了" }, 500);
    }
  }

  async body(request) {
    if (Number(request.headers.get("content-length") || 0) > 400_000) throw new HttpError(413, "请求太大");
    try { return await request.json(); } catch { throw new HttpError(400, "请求格式不正确"); }
  }

  async route(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const method = request.method;

    if (path === "/internal/online-game" && method === "POST") return this.saveOnlineGame(await this.body(request));
    if (path === "/api/config" && method === "GET") return json({ leaderboardMinGames: LEADERBOARD_RULE.minGames });

    if (path === "/api/register" && method === "POST") return this.register(await this.body(request));
    if (path === "/api/login" && method === "POST") return this.login(request, await this.body(request));
    if (path === "/api/leaderboard" && method === "GET") return this.leaderboard(url);
    if (path === "/api/admin" || path.startsWith("/api/admin/")) return handleAdmin(this, request, url, path, method, { HttpError, json });

    const auth = this.authenticate(request);
    const me = auth.user;

    if (path === "/api/logout" && method === "POST") {
      this.sql.exec(`DELETE FROM sessions WHERE token = ?`, auth.token);
      return json({ ok: true });
    }
    if (path === "/api/me" && method === "GET") return json({ user: this.privateUser(me) });
    if (path === "/api/me" && method === "PATCH") return this.updateMe(me, await this.body(request));
    if (path === "/api/me/delete" && method === "POST") return this.deleteAccount(me, await this.body(request));
    if (path === "/api/me/password" && method === "POST") return this.setPassword(me, await this.body(request), auth.token);
    if (path === "/api/matches" && method === "POST") return await this.addMatches(me, await this.body(request));
    if (path === "/api/matches" && method === "GET") return this.listMatches(me, url);
    if (path === "/api/friends" && method === "GET") return this.listFriends(me);
    if (path === "/api/friends/request" && method === "POST") return this.requestFriend(me, await this.body(request));
    if (path === "/api/friends/respond" && method === "POST") return this.respondFriend(me, await this.body(request));
    const friendMatches = path.match(/^\/api\/friends\/([A-Za-z0-9-]+)\/matches$/);
    if (friendMatches && method === "GET") return this.friendMatches(me, friendMatches[1]);
    const friendDelete = path.match(/^\/api\/friends\/([A-Za-z0-9-]+)$/);
    if (friendDelete && method === "DELETE") return this.removeFriend(me, friendDelete[1]);
    if (path === "/api/invites" && method === "POST") return this.createInvite(me, await this.body(request));
    const inviteRespond = path.match(/^\/api\/invites\/([A-Za-z0-9-]+)\/respond$/);
    if (inviteRespond && method === "POST") return this.respondInvite(me, inviteRespond[1], await this.body(request));
    if (path === "/api/notifications" && method === "GET") return this.notifications(me);
    if (path === "/api/push-token" && method === "POST") return this.savePushToken(me, await this.body(request));
    throw new HttpError(404, "接口不存在");
  }

  async register(body) {
    const nameError = validateUsername(body.username);
    if (nameError) throw new HttpError(400, nameError);
    const pwError = validatePassword(body.password);
    if (pwError) throw new HttpError(400, pwError);
    if (typeof body.confirmPassword === "string" && body.confirmPassword !== body.password) throw new HttpError(400, "两次输入的密码不一致");
    const username = body.username.trim();
    if (this.userByName(username)) throw new HttpError(409, "这个用户名已经被注册了");
    const { hash, salt } = await hashPassword(body.password);
    const id = crypto.randomUUID();
    this.sql.exec(`INSERT INTO users (id, username, username_key, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id, username, username.toLowerCase(), hash, salt, Date.now());
    const user = this.one(`SELECT * FROM users WHERE id = ?`, id);
    return json({ token: this.createSession(id), user: this.privateUser(user) }, 201);
  }

  async login(request, body) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const name = String(body.username || "").trim().toLowerCase();
    this.checkRateLimit(`ip:${ip}`);
    this.checkRateLimit(`user:${name}`);
    const user = this.userByName(name);
    let ok = false;
    if (user?.pw_hash && typeof body.password === "string") {
      ok = await verifyPassword(body.password, user.pw_hash, user.pw_salt);
    }
    if (!ok) {
      this.recordFailure(`ip:${ip}`);
      this.recordFailure(`user:${name}`);
      throw new HttpError(401, "用户名或密码不正确");
    }
    this.sql.exec(`DELETE FROM login_failures WHERE key = ?`, `user:${name}`);
    return json({ token: this.createSession(user.id), user: this.privateUser(user) });
  }

  async updateMe(me, body) {
    if (body.username !== undefined) {
      const nameError = validateUsername(body.username);
      if (nameError) throw new HttpError(400, nameError);
      const username = body.username.trim();
      const existing = this.userByName(username);
      if (existing && existing.id !== me.id) throw new HttpError(409, "这个用户名已经被占用了");
      this.sql.exec(`UPDATE users SET username = ?, username_key = ? WHERE id = ?`, username, username.toLowerCase(), me.id);
    }
    if (body.avatar !== undefined) {
      const avatarError = validateAvatar(body.avatar);
      if (avatarError) throw new HttpError(400, avatarError);
      this.sql.exec(`UPDATE users SET avatar = ? WHERE id = ?`, body.avatar || null, me.id);
    }
    if (body.barkKey !== undefined) {
      const key = String(body.barkKey || "").trim();
      if (!key) this.sql.exec(`DELETE FROM bark_keys WHERE user_id = ?`, me.id);
      else if (!/^[A-Za-z0-9]{8,64}$/.test(key)) throw new HttpError(400, "Bark Key 格式不正确");
      else this.sql.exec(`INSERT OR REPLACE INTO bark_keys (user_id, bark_key) VALUES (?, ?)`, me.id, key);
    }
    return json({ user: this.privateUser(this.one(`SELECT * FROM users WHERE id = ?`, me.id)) });
  }

  // 修改密码：验证原密码（和登录共用失败次数限制），规则同注册；成功后让其他设备的登录失效，只保留当前这台
  async setPassword(me, body, currentToken = null) {
    const pwError = validatePassword(body.password);
    if (pwError) throw new HttpError(400, pwError);
    if (body.confirmPassword !== body.password) throw new HttpError(400, "两次输入的密码不一致");
    const limitKey = `user:${me.username_key || String(me.username || "").toLowerCase()}`;
    if (me.pw_hash) {
      this.checkRateLimit(limitKey);
      if (!(await verifyPassword(String(body.oldPassword || ""), me.pw_hash, me.pw_salt))) {
        this.recordFailure(limitKey);
        throw new HttpError(403, "原密码不正确");
      }
    }
    const { hash, salt } = await hashPassword(body.password);
    this.sql.exec(`UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?`, hash, salt, me.id);
    this.sql.exec(`DELETE FROM login_failures WHERE key = ?`, limitKey);
    if (currentToken) this.sql.exec(`DELETE FROM sessions WHERE user_id = ? AND token != ?`, me.id, currentToken);
    return json({ ok: true });
  }

  // 注销账号：要求密码确认；删除本人所有数据，并把别人战绩里出现的名字匿名化
  async deleteAccount(me, body) {
    if (me.pw_hash && !(await verifyPassword(String(body.password || ""), me.pw_hash, me.pw_salt))) throw new HttpError(403, "密码不正确");
    this.purgeUser(me);
    return json({ ok: true });
  }

  // 删除一个用户的全部数据（注销账号和管理后台共用）
  purgeUser(me) {
    const id = me.id, name = me.username;
    this.sql.exec(`DELETE FROM matches WHERE user_id = ?`, id);
    const others = this.q(`SELECT user_id, id, detail FROM matches WHERE detail LIKE ?`, `%${name}%`);
    for (const r of others) {
      try {
        const d = JSON.parse(r.detail);
        let changed = false;
        if (Array.isArray(d.names)) d.names = d.names.map((n) => (n === name ? (changed = true, "已注销用户") : n));
        if (d.winnerName === name) { d.winnerName = "已注销用户"; changed = true; }
        if (changed) this.sql.exec(`UPDATE matches SET detail = ? WHERE user_id = ? AND id = ?`, JSON.stringify(d), r.user_id, r.id);
      } catch {}
    }
    this.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, id);
    this.sql.exec(`DELETE FROM friends WHERE a = ? OR b = ?`, id, id);
    this.sql.exec(`DELETE FROM invites WHERE from_id = ? OR to_id = ?`, id, id);
    this.sql.exec(`DELETE FROM push_tokens WHERE user_id = ?`, id);
    this.sql.exec(`DELETE FROM bark_keys WHERE user_id = ?`, id);
    this.sql.exec(`DELETE FROM login_failures WHERE key = ?`, `user:${me.username_key || name.toLowerCase()}`);
    this.sql.exec(`DELETE FROM users WHERE id = ?`, id);
  }

  // 房间服务器在联机对局结束时报告的结果（只从 Durable Object 内部调用，Worker 不转发 /internal/*）
  saveOnlineGame(rec) {
    if (!rec || !Number.isInteger(rec.boardSize) || !Array.isArray(rec.names)) throw new HttpError(400, "bad record");
    this.sql.exec(`INSERT INTO online_games (ended_at, board_size, players, names, record) VALUES (?, ?, ?, ?, ?)`,
      Number(rec.endedAt) || Date.now(), rec.boardSize, rec.players, JSON.stringify([...rec.names].sort()), JSON.stringify(rec).slice(0, 4000));
    this.sql.exec(`DELETE FROM online_games WHERE ended_at < ?`, Date.now() - 3 * DAY);
    return json({ ok: true });
  }

  findOnlineGame(m, raw) {
    const names = Array.isArray(raw?.detail?.names) ? JSON.stringify(raw.detail.names.map(String).sort()) : null;
    if (!names) return null;
    const rows = this.q(`SELECT record FROM online_games WHERE board_size = ? AND players = ? AND names = ? AND ended_at >= ? AND ended_at <= ?
      ORDER BY ended_at DESC LIMIT 5`, m.boardSize, m.players, names, m.playedAt - 60000, m.playedAt + m.duration * 1000 + 15 * 60000);
    const recs = rows.map((r) => JSON.parse(r.record));
    return recs.find((r) => r.moves === m.moves) || recs[0] || null;
  }

  // 防刷：和自己 7 天内同 AI、同棋盘的其他胜局比较；只保留最早的一局在榜（默认排除；SIMILARITY_ENFORCE=false 时只观察）
  checkSimilarity(me, m, raw, now) {
    // prune stored move lists: older than the window (+1 day) or beyond the per-user cap
    this.sql.exec(`UPDATE matches SET sim_moves = NULL, sim_board = NULL WHERE user_id = ? AND sim_moves IS NOT NULL AND played_at < ?`,
      me.id, now - (SIMILARITY.windowDays + 1) * DAY);
    const moves = m.mode === "vsAI" && m.result === "win" && raw?.restored !== true ? encodeMoves(raw?.moveList) : null;
    if (!moves || moves.length / 3 < SIMILARITY.minMoves) return;
    const board = cleanBoard(raw?.finalBoard);
    this.sql.exec(`UPDATE matches SET sim_moves = ?, sim_board = ? WHERE user_id = ? AND id = ?`, moves, board, me.id, m.id);
    const keep = this.q(`SELECT id FROM matches WHERE user_id = ? AND sim_moves IS NOT NULL ORDER BY played_at DESC LIMIT -1 OFFSET ?`, me.id, SIMILARITY.maxStoredPerUser);
    for (const k of keep) this.sql.exec(`UPDATE matches SET sim_moves = NULL, sim_board = NULL WHERE user_id = ? AND id = ?`, me.id, k.id);
    const win = SIMILARITY.windowDays * DAY;
    const others = this.q(`SELECT id, played_at, sim_moves, sim_board, sim_status FROM matches WHERE user_id = ? AND id <> ? AND mode = 'vsAI'
      AND result = 'win' AND ai_key IS ? AND board_size = ? AND sim_moves IS NOT NULL AND played_at BETWEEN ? AND ? ORDER BY played_at`,
      me.id, m.id, m.aiKey, m.boardSize, m.playedAt - win, m.playedAt + win);
    const mine = { moves, board };
    let flaggedSelf = false;
    for (const o of others) {
      const c = compareGames(mine, { moves: o.sim_moves, board: o.sim_board });
      if (!c.dup) continue;
      const [later, earlier] = o.played_at <= m.playedAt ? [m.id, o.id] : [o.id, m.id];
      if (later === m.id && flaggedSelf) continue;
      if (later !== m.id && o.sim_status) continue; // already flagged or approved
      this.sql.exec(`UPDATE matches SET sim_status = 'dup', sim_reason = ? WHERE user_id = ? AND id = ? AND COALESCE(sim_status, '') <> 'approved'`,
        `与对局 ${earlier} 相似度 ${c.percent}%（${c.rule}）`, me.id, later);
      if (later === m.id) flaggedSelf = true;
    }
  }

  async addMatches(me, body) {
    const list = Array.isArray(body?.matches) ? body.matches : [body];
    let added = 0;
    for (const raw of list.slice(0, 200)) {
      const m = normalizeMatch(raw);
      if (!m) continue;
      const before = this.one(`SELECT 1 AS x FROM matches WHERE user_id = ? AND id = ?`, me.id, m.id);
      if (before) continue;
      const now = Date.now();
      const count = (sql, ...a) => this.one(sql, ...a)?.n || 0;
      const v = checkUpload(m, raw, {
        now,
        recentTen: count(`SELECT COUNT(*) AS n FROM matches WHERE user_id = ? AND uploaded_at >= ?`, me.id, now - 10 * 60 * 1000),
        recentDay: count(`SELECT COUNT(*) AS n FROM matches WHERE user_id = ? AND uploaded_at >= ?`, me.id, now - DAY),
        prior: this.q(`SELECT played_at, duration, mode, ai_key, result FROM matches WHERE user_id = ? AND played_at < ? AND played_at > ?
          ORDER BY played_at DESC LIMIT 60`, me.id, m.playedAt + m.duration * 1000 + 1, m.playedAt - 30 * DAY),
        strongWinsDay: count(`SELECT COUNT(*) AS n FROM matches WHERE user_id = ? AND mode = 'vsAI' AND result = 'win' AND played_at >= ?
          AND (ai_key GLOB 'bot3-s[3-9]' OR ai_key GLOB 'bot[12]-l[4-9]')`, me.id, m.playedAt - DAY),
        onlineRecord: m.mode === "online" ? this.findOnlineGame(m, raw) : null,
      });
      this.sql.exec(`INSERT INTO matches (user_id, id, played_at, mode, players, board_size, ai_key, ai_label, moves, my_moves, result, duration, detail,
          verify, verify_reason, uploaded_at, restored)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        me.id, m.id, m.playedAt, m.mode, m.players, m.boardSize, m.aiKey, m.aiLabel, m.moves, m.myMoves, m.result, m.duration, m.detail,
        v.verify, v.reason, now, raw?.restored === true ? 1 : 0);
      this.checkSimilarity(me, m, raw, now);
      added++;
    }
    return json({ added });
  }

  listMatches(me, url) {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
    const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
    const rows = this.q(`SELECT * FROM matches WHERE user_id = ? AND played_at < ? ORDER BY played_at DESC LIMIT ?`, me.id, before, limit);
    return json({
      matches: rows.map((r) => ({
        id: r.id, playedAt: r.played_at, mode: r.mode, players: r.players, boardSize: r.board_size, aiKey: r.ai_key,
        aiLabel: r.ai_label, moves: r.moves, myMoves: r.my_moves, result: r.result, duration: r.duration,
        detail: r.detail ? JSON.parse(r.detail) : null,
      })),
    });
  }

  // 好友近一个月战绩：只有已互为好友才能看（不含复盘细节）
  friendMatches(me, otherId) {
    const f = this.friendship(me.id, otherId);
    if (!f || f.status !== "accepted") throw new HttpError(403, "只能查看好友的战绩");
    const user = this.one(`SELECT * FROM users WHERE id = ?`, otherId);
    if (!user) throw new HttpError(404, "找不到这个用户");
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const rows = this.q(`SELECT * FROM matches WHERE user_id = ? AND played_at >= ? ORDER BY played_at DESC LIMIT 200`, otherId, since);
    const stats = { games: rows.length, wins: 0, losses: 0 };
    for (const r of rows) { if (r.result === "win") stats.wins++; else if (r.result === "loss") stats.losses++; }
    return json({
      user: this.publicUser(user), since, stats,
      matches: rows.map((r) => ({
        id: r.id, playedAt: r.played_at, mode: r.mode, players: r.players, boardSize: r.board_size, aiKey: r.ai_key,
        aiLabel: r.ai_label, moves: r.moves, myMoves: r.my_moves, result: r.result, duration: r.duration, detail: null,
      })),
    });
  }

  leaderboard(url) {
    const period = url.searchParams.get("period") || "week";
    const start = periodStart(period);
    if (start === null) throw new HttpError(400, "period 只能是 week/month/all（旧版 season/year 仍可用）");
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 100));
    const levels = this.q(`SELECT ai_key AS aiKey, MAX(ai_label) AS aiLabel, COUNT(*) AS games FROM matches
      WHERE mode = 'vsAI' AND players = 2 AND ai_key IS NOT NULL AND played_at >= ? AND ${countedSql(this.env)} GROUP BY ai_key ORDER BY ai_key`, start);
    const aiKey = url.searchParams.get("aiKey") || levels[0]?.aiKey || null;
    let entries = [];
    let boardSizes = [];
    let boardSize = null;
    if (aiKey) {
      boardSizes = this.q(`SELECT board_size AS boardSize, COUNT(*) AS games FROM matches
        WHERE mode = 'vsAI' AND players = 2 AND ai_key = ? AND board_size IS NOT NULL AND played_at >= ? AND ${countedSql(this.env)}
        GROUP BY board_size ORDER BY board_size`, aiKey, start);
      const asked = Number(url.searchParams.get("boardSize"));
      if (Number.isInteger(asked) && asked > 0) boardSize = asked;
      else if (boardSizes.length) boardSize = boardSizes.reduce((a, b) => (b.games > a.games ? b : a)).boardSize;
      if (boardSize !== null) {
        const rows = this.q(`SELECT m.user_id AS userId, u.username AS username, u.avatar AS avatar, COUNT(*) AS games,
            SUM(m.result = 'win') AS wins, SUM(m.result = 'loss') AS losses, SUM(m.moves) AS totalMoves, MAX(m.moves) AS bestMoves
          FROM matches m JOIN users u ON u.id = m.user_id
          WHERE m.mode = 'vsAI' AND m.players = 2 AND m.ai_key = ? AND m.board_size = ? AND m.played_at >= ? AND ${countedSql(this.env)} GROUP BY m.user_id`, aiKey, boardSize, start);
        entries = rankLeaderboard(rows, limit);
      }
    }
    return json({
      period, periodStart: start, aiKey, levels, boardSize, boardSizes, entries,
      rule: `仅统计 1 人对 1 个 AI 的双人对局，按 AI 难度和棋盘大小分榜；先比胜场，再比平均每局步数（坚持越久越靠前）；本期至少 ${LEADERBOARD_RULE.minGames} 局才上榜`,
    });
  }

  friendKey(x, y) {
    return x < y ? [x, y] : [y, x];
  }

  friendship(x, y) {
    const [a, b] = this.friendKey(x, y);
    return this.one(`SELECT * FROM friends WHERE a = ? AND b = ?`, a, b);
  }

  listFriends(me) {
    const rows = this.q(`SELECT f.*, u.id AS uid, u.username, u.avatar FROM friends f
      JOIN users u ON u.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END
      WHERE f.a = ? OR f.b = ? ORDER BY u.username_key`, me.id, me.id, me.id);
    const out = { friends: [], incoming: [], outgoing: [] };
    for (const r of rows) {
      const user = { id: r.uid, username: r.username, avatar: r.avatar || null, since: r.created_at };
      if (r.status === "accepted") out.friends.push(user);
      else if (r.requester === me.id) out.outgoing.push(user);
      else out.incoming.push(user);
    }
    return json(out);
  }

  requestFriend(me, body) {
    const target = this.userByName(body.username);
    if (!target) throw new HttpError(404, "找不到这个用户名");
    if (target.id === me.id) throw new HttpError(400, "不能加自己为好友");
    const existing = this.friendship(me.id, target.id);
    const [a, b] = this.friendKey(me.id, target.id);
    if (existing?.status === "accepted") throw new HttpError(409, "你们已经是好友了");
    if (existing && existing.requester !== me.id) {
      this.sql.exec(`UPDATE friends SET status = 'accepted' WHERE a = ? AND b = ?`, a, b);
      return json({ status: "accepted", user: this.publicUser(target) });
    }
    if (existing) return json({ status: "pending", user: this.publicUser(target) });
    this.sql.exec(`INSERT INTO friends (a, b, status, requester, created_at) VALUES (?, ?, 'pending', ?, ?)`, a, b, me.id, Date.now());
    return json({ status: "pending", user: this.publicUser(target) }, 201);
  }

  respondFriend(me, body) {
    const existing = this.friendship(me.id, String(body.userId || ""));
    if (!existing || existing.status !== "pending" || existing.requester === me.id) throw new HttpError(404, "没有这条好友申请");
    if (body.accept) this.sql.exec(`UPDATE friends SET status = 'accepted' WHERE a = ? AND b = ?`, existing.a, existing.b);
    else this.sql.exec(`DELETE FROM friends WHERE a = ? AND b = ?`, existing.a, existing.b);
    return json({ status: body.accept ? "accepted" : "declined" });
  }

  removeFriend(me, otherId) {
    const [a, b] = this.friendKey(me.id, otherId);
    this.sql.exec(`DELETE FROM friends WHERE a = ? AND b = ?`, a, b);
    return json({ ok: true });
  }

  createInvite(me, body) {
    const to = this.one(`SELECT * FROM users WHERE id = ?`, String(body.friendId || ""));
    if (!to || this.friendship(me.id, to.id)?.status !== "accepted") throw new HttpError(403, "只能邀请好友");
    const roomCode = String(body.roomCode || "");
    if (!/^[0-9]{6}$/.test(roomCode)) throw new HttpError(400, "房间号不正确");
    const now = Date.now();
    this.sql.exec(`UPDATE invites SET status = 'expired', updated_at = ? WHERE from_id = ? AND to_id = ? AND status = 'pending'`, now, me.id, to.id);
    const id = crypto.randomUUID();
    const boardSize = Number.isInteger(body.boardSize) ? body.boardSize : null;
    this.sql.exec(`INSERT INTO invites (id, from_id, to_id, room_code, board_size, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id, me.id, to.id, roomCode, boardSize, now, now);
    this.notifyBark(to.id, "Color War 对局邀请", `${me.username} 邀请你加入房间 ${roomCode}`);
    // TODO(APNs): when the app is signed with a paid Apple Developer account, send an alert push to every
    // token in push_tokens for `to.id` here (reuse createAPNsJWT from server.js). Unsigned sideloaded builds
    // cannot receive APNs pushes, so clients poll /api/notifications while open instead.
    return json({ id, status: "pending" }, 201);
  }

  respondInvite(me, inviteId, body) {
    const invite = this.one(`SELECT * FROM invites WHERE id = ?`, inviteId);
    if (!invite || invite.to_id !== me.id) throw new HttpError(404, "邀请不存在");
    if (invite.status !== "pending" || invite.created_at + INVITE_TTL < Date.now()) throw new HttpError(410, "邀请已过期");
    const status = body.accept ? "accepted" : "declined";
    this.sql.exec(`UPDATE invites SET status = ?, updated_at = ? WHERE id = ?`, status, Date.now(), inviteId);
    return json({ status, roomCode: invite.room_code });
  }

  notifications(me) {
    const since = Date.now() - INVITE_TTL;
    const invites = this.q(`SELECT i.*, u.username, u.avatar FROM invites i JOIN users u ON u.id = i.from_id
      WHERE i.to_id = ? AND i.status = 'pending' AND i.created_at >= ? ORDER BY i.created_at DESC LIMIT 10`, me.id, since)
      .map((r) => ({ id: r.id, from: { id: r.from_id, username: r.username, avatar: r.avatar || null }, roomCode: r.room_code, boardSize: r.board_size, createdAt: r.created_at }));
    const inviteUpdates = this.q(`SELECT i.*, u.username FROM invites i JOIN users u ON u.id = i.to_id
      WHERE i.from_id = ? AND i.status IN ('accepted', 'declined') AND i.updated_at >= ? ORDER BY i.updated_at DESC LIMIT 10`, me.id, since)
      .map((r) => ({ id: r.id, to: { id: r.to_id, username: r.username }, status: r.status, roomCode: r.room_code, updatedAt: r.updated_at }));
    const friendRequests = this.q(`SELECT u.id, u.username, u.avatar FROM friends f JOIN users u ON u.id = f.requester
      WHERE (f.a = ? OR f.b = ?) AND f.status = 'pending' AND f.requester != ?`, me.id, me.id, me.id)
      .map((r) => ({ id: r.id, username: r.username, avatar: r.avatar || null }));
    return json({ invites, inviteUpdates, friendRequests, serverTime: Date.now() });
  }

  notifyBark(userId, title, body) {
    const key = this.one(`SELECT bark_key FROM bark_keys WHERE user_id = ?`, userId)?.bark_key;
    if (!key) return;
    const send = fetch(`https://api.day.app/${key}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ title, body, group: "ColorWar", url: "colorwar://invites" }),
    }).catch(() => {});
    if (typeof this.state.waitUntil === "function") this.state.waitUntil(send);
  }

  savePushToken(me, body) {
    const token = String(body.token || "");
    if (!/^[0-9a-fA-F]{32,256}$/.test(token) && !/^https:\/\//.test(token)) throw new HttpError(400, "推送令牌不正确");
    this.sql.exec(`INSERT OR REPLACE INTO push_tokens (user_id, token, platform, updated_at) VALUES (?, ?, ?, ?)`,
      me.id, token.slice(0, 1000), String(body.platform || "").slice(0, 20), Date.now());
    return json({ ok: true });
  }
}
