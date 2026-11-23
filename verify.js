// Anti-cheat: replay an uploaded match with the exact game rules (ported from the iOS/web clients'
// resolveMove / updateEliminationStatus / checkGameOver / advanceToNextTurn; client engines untouched)
// and check board size, legality, turn order, winner, step counts and the claimed result.
//
// Status stored on each match row (column `verify`):
//   NULL        historical rows from before this existed — counted as before
//   "ok"        replay matches the claim — counted
//   "unverified" new upload from an old client with no move list — kept, NOT on the leaderboard
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

/**
 * Checks an uploaded match (normalized `m` + the raw upload) and returns { verify, reason, moveList }.
 * `trusted` (optional) is the list of server-recorded move lists of the room's recent games (online).
 */
export function verifyUpload(m, raw, { trusted = null, recentUploads = 0 } = {}) {
  const flag = (reason) => ({ verify: "flagged", reason, moveList: Array.isArray(raw?.moveList) ? raw.moveList : null });
  if (recentUploads >= 40) return flag("上传太频繁（10 分钟内超过 40 局）");
  if (!Array.isArray(raw?.moveList)) return { verify: "unverified", reason: "旧版客户端，没有上传棋步", moveList: null };
  let moveList = raw.moveList;
  const seats = raw.seats;
  const start = raw.start === "duel" ? "duel" : "empty";
  let source = null;
  if (Array.isArray(trusted) && trusted.length) {
    // trusted = move lists the room server recorded (recent games). Prefer the exact same game;
    // otherwise the latest finished game in that room. The server record wins over the client's list.
    const key = (l) => l.map((x) => x.join(",")).join(";");
    const exact = trusted.find((l) => key(l) === key(moveList));
    const finished = [...trusted].reverse().find((l) => replayGame({ boardSize: m.boardSize, seats, start, moveList: l }).ok);
    const pick = exact || finished;
    if (pick) { moveList = pick; source = exact ? "联机：服务器记录" : "联机：服务器记录（客户端棋步不一致，已按服务器记录核对）"; }
  }
  if (m.mode === "online" && start === "duel") return flag("联机对局不能用对弈开局");
  const res = replayGame({ boardSize: m.boardSize, seats, start, moveList });
  if (!res.ok) return flag(res.reason);
  if (seats.length !== m.players) return flag(`人数不一致（声称 ${m.players}，棋步里 ${seats.length}）`);
  if (res.moves !== m.moves) return flag(`步数不一致（声称 ${m.moves}，实际 ${res.moves}）`);
  const mySeat = Number.isInteger(raw.mySeat) ? raw.mySeat : null;
  if (mySeat !== null && !seats.includes(mySeat)) return flag("我的座位不在这局里");
  if (m.mode === "vsAI" && (mySeat === null || seats.length !== 2)) return flag("人机对局必须是一人对一个 AI");
  const expected = mySeat === null || res.winner === null ? "none" : res.winner === mySeat ? "win" : "loss";
  if (m.result !== expected) return flag(`结果不一致（声称 ${m.result}，实际 ${expected}）`);
  const myMoves = mySeat === null ? 0 : res.perPlayer[mySeat] || 0;
  if (m.myMoves !== myMoves) return flag(`我的步数不一致（声称 ${m.myMoves}，实际 ${myMoves}）`);
  if (m.duration * 1000 < m.moves * MIN_MS_PER_MOVE) return flag(`用时太短（${m.moves} 步只用了 ${m.duration} 秒）`);
  return { verify: "ok", reason: source, moveList };
}
