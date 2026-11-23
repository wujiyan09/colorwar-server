// Anti-cheat (server only; clients unchanged).
// replayGame: the game rules ported from the iOS/web clients (resolveMove / elimination / game over / next turn).
//   The Room server uses it to replay the moves it relayed in an online game and records the true result.
// checkUpload: sanity checks for every uploaded match + cross-check of online uploads against the room record.
//
// Status stored on each match row (column `verify`):
//   NULL        historical rows from before this existed — counted as before
//   "ok"        replay matches the claim — counted
//   "flagged"   replay / sanity check failed — kept, NOT on the leaderboard, reason in `verify_reason`
//   "approved"  an admin approved it — counted

export const COUNTED_SQL = "(verify IS NULL OR verify IN ('ok', 'approved'))";
const MAX_PLAYERS = 8;
const MIN_MS_PER_MOVE = 150; // the fastest a move can resolve in either client (AI waits 150 ms + animation)

/** Replays a move list. Returns { ok, reason, winner, moves, perPlayer }. */
export function replayGame({ boardSize, seats, start, moveList }) {
  const n = boardSize;
  if (!Number.isInteger(n) || n < 3 || n > 20) return { ok: false, reason: "棋盘大小不正确" };
  if (!Array.isArray(seats) || seats.length < 2 || seats.length > MAX_PLAYERS
    || seats.some((s) => !Number.isInteger(s) || s < 0 || s >= MAX_PLAYERS) || new Set(seats).size !== seats.length)
    return { ok: false, reason: "玩家座位不正确" };
  if (!Array.isArray(moveList) || moveList.length === 0) return { ok: false, reason: "没有棋步" };
  if (moveList.length > n * n * 60) return { ok: false, reason: "棋步数量不合理" };

  const board = Array.from({ length: n * n }, () => ({ o: -1, k: 0 }));
  const entered = new Array(MAX_PLAYERS).fill(false);
  const eliminated = new Array(MAX_PLAYERS).fill(false);
  let current = null;
  if (start === "duel") {
    if (seats.length !== 2) return { ok: false, reason: "对弈开局必须是两人" };
    board[0] = { o: seats[0], k: 1 };
    board[n * n - 1] = { o: seats[1], k: 1 };
    entered[seats[0]] = entered[seats[1]] = true;
    current = seats[0];
  }
  const perPlayer = {};
  let winner = null, over = false;
  for (let i = 0; i < moveList.length; i++) {
    const mv = moveList[i];
    if (!Array.isArray(mv) || mv.length < 3 || !mv.slice(0, 3).every(Number.isInteger)) return { ok: false, reason: `第 ${i + 1} 步格式不正确` };
    const [r, c, p] = mv;
    if (over) return { ok: false, reason: `第 ${i + 1} 步：对局已经结束了还在落子` };
    if (!seats.includes(p)) return { ok: false, reason: `第 ${i + 1} 步：玩家 ${p} 不在这局里` };
    if (current === null) current = p; // free / random first player
    if (p !== current) return { ok: false, reason: `第 ${i + 1} 步：不是玩家 ${p} 的回合（应是 ${current}）` };
    if (r < 0 || r >= n || c < 0 || c >= n) return { ok: false, reason: `第 ${i + 1} 步：落子超出棋盘` };
    const idx = r * n + c;
    const ownsAny = board.some((x) => x.o === p && x.k > 0);
    if (ownsAny ? board[idx].o !== p : board[idx].o !== -1) return { ok: false, reason: `第 ${i + 1} 步：(${r + 1},${c + 1}) 不能落子` };
    // place
    const add = entered[p] ? 1 : 3;
    entered[p] = true;
    board[idx] = { o: p, k: board[idx].k + add };
    // explode in waves
    let wave = board[idx].k >= 4 ? [idx] : [];
    for (let guard = 0; wave.length && guard < 4000; guard++) {
      const exploding = wave.filter((j) => board[j].k >= 4);
      const targets = [];
      for (const j of exploding) {
        const rr = Math.floor(j / n), cc = j % n;
        if (rr > 0) targets.push(j - n); if (rr < n - 1) targets.push(j + n);
        if (cc > 0) targets.push(j - 1); if (cc < n - 1) targets.push(j + 1);
      }
      for (const j of exploding) {
        const k = board[j].k - 4;
        board[j] = k === 0 ? { o: -1, k: 0 } : { o: p, k };
      }
      const changed = new Set();
      for (const t of targets) { board[t] = { o: p, k: board[t].k + 1 }; changed.add(t); }
      wave = [...changed].filter((j) => board[j].k >= 4);
    }
    perPlayer[p] = (perPlayer[p] || 0) + 1;
    // elimination + game over
    const appears = new Array(MAX_PLAYERS).fill(false);
    for (const x of board) if (x.o >= 0 && x.k > 0) appears[x.o] = true;
    for (const s of seats) if (entered[s] && !appears[s]) eliminated[s] = true;
    const alive = seats.filter((s) => !eliminated[s]);
    if (seats.every((s) => entered[s] || eliminated[s]) && alive.length <= 1) {
      over = true; winner = alive.length ? alive[0] : null;
      continue;
    }
    // next turn
    let at = seats.indexOf(p);
    for (let k = 0; k < seats.length; k++) {
      at = (at + 1) % seats.length;
      if (!eliminated[seats[at]]) break;
    }
    current = seats[at];
  }
  if (!over) return { ok: false, reason: "按棋步走完，对局并没有结束" };
  return { ok: true, winner, moves: moveList.length, perPlayer };
}

// ---- upload checks (server-only: clients are unchanged, they send the same match record as before) ----
export const LIMITS = {
  perTenMinutes: 30,        // uploads per user per 10 minutes
  perDay: 300,              // uploads per user per 24 hours
  minMsPerMove: 150,        // fastest a move can resolve in either client
  maxFutureMs: 5 * 60 * 1000,
  maxAgeMs: 400 * 24 * 3600 * 1000,
  streakWins: 40,           // consecutive vs-AI wins (strong AIs, 强度 ≥ 3)
  dailyWinsStrong: 80,      // vs-AI wins against 强度 ≥ 3 within 24h
};
const strongAI = (aiKey) => /^bot3-s([3-9])$/.test(aiKey || "") || /^bot[12]-l([4-9])$/.test(aiKey || "");

/**
 * m: normalized upload. ctx: { now, recentTen, recentDay, prior (rows of this user's last ~60 vs-AI uploads, newest first),
 *   strongWinsDay, onlineRecord (server room record or null) }.
 * Returns { verify: "ok"|"flagged", reason }.
 */
export function checkUpload(m, raw, ctx) {
  const now = ctx.now ?? Date.now();
  const flag = (reason) => ({ verify: "flagged", reason });
  const n = m.boardSize, cells = n * n;
  if ((ctx.recentTen ?? 0) >= LIMITS.perTenMinutes) return flag(`上传太频繁（10 分钟内超过 ${LIMITS.perTenMinutes} 局）`);
  if ((ctx.recentDay ?? 0) >= LIMITS.perDay) return flag(`超过每日上限（24 小时内超过 ${LIMITS.perDay} 局）`);
  if (m.playedAt > now + LIMITS.maxFutureMs) return flag("对局时间在未来");
  if (m.playedAt < now - LIMITS.maxAgeMs) return flag("对局时间太早");
  if (!Number.isInteger(n) || n < 3 || n > 20) return flag("棋盘大小不正确");
  if (m.players < 2 || m.players > 8) return flag("人数不正确");
  if (m.mode === "vsAI" && m.players !== 2) return flag("人机对局必须是两人");
  // 最少步数：赢家要把对手全部吃掉，至少需要让格子爆开；放宽到人数 × 2
  const minMoves = Math.max(m.players * 2, 4);
  if (m.result !== "none" && m.moves < minMoves) return flag(`步数太少（${m.moves} 步不可能结束 ${n}×${n} 的对局）`);
  if (m.moves > cells * 40) return flag(`步数太多（${n}×${n} 棋盘 ${m.moves} 步）`);
  if (m.myMoves > m.moves) return flag("我的步数大于总步数");
  // 两人对局严格轮流，所以我的步数 ≈ 总步数的一半
  if (m.mode !== "local" && m.players === 2 && Math.abs(m.myMoves * 2 - m.moves) > 2) return flag(`我的步数和总步数对不上（两人轮流，${m.moves} 步里我走了 ${m.myMoves} 步）`);
  if (m.duration * 1000 < m.moves * LIMITS.minMsPerMove) return flag(`用时太短（${m.moves} 步只用了 ${m.duration} 秒）`);
  if (m.duration > 6 * 3600) return flag("用时超过 6 小时");
  const prior = ctx.prior || [];
  const overlap = (p) => Math.min(p.played_at + (p.duration || 0) * 1000, m.playedAt + m.duration * 1000) - Math.max(p.played_at, m.playedAt);
  if (prior.some((p) => p.mode !== "local" && m.mode !== "local" && overlap(p) > 10000))
    return flag("和另一局时间重叠（同一时间不可能下两局）");
  if (m.mode === "vsAI" && m.result === "win" && strongAI(m.aiKey)) {
    let streak = 1;
    for (const p of prior) { if (p.mode !== "vsAI" || !strongAI(p.ai_key)) continue; if (p.result === "win") streak++; else break; }
    if (streak > LIMITS.streakWins) return flag(`连胜异常（对强 AI 连赢 ${streak} 局）`);
    if ((ctx.strongWinsDay ?? 0) + 1 > LIMITS.dailyWinsStrong) return flag(`胜场异常（24 小时内赢强 AI 超过 ${LIMITS.dailyWinsStrong} 局）`);
  }
  if (m.mode === "online") {
    const rec = ctx.onlineRecord;
    if (!rec) return { verify: "ok", reason: "联机：没有找到服务器记录（只做了基本检查）" };
    if (rec.moves !== m.moves) return flag(`和服务器联机记录不一致：步数 ${m.moves}，服务器记录 ${rec.moves}`);
    if (!rec.perPlayer.includes(m.myMoves)) return flag(`和服务器联机记录不一致：我的步数 ${m.myMoves}`);
    const claimedWinner = raw?.detail?.winnerName ?? null;
    if (claimedWinner !== null && rec.winnerName !== null && claimedWinner !== rec.winnerName) return flag(`和服务器联机记录不一致：胜者应是 ${rec.winnerName}`);
    const winnerMoves = rec.winnerSeatMoves;
    if (m.result === "win" && rec.winnerName !== null && m.myMoves !== winnerMoves) return flag("和服务器联机记录不一致：你不是这局的胜者");
    return { verify: "ok", reason: "联机：和服务器记录一致" };
  }
  return { verify: "ok", reason: null };
}
