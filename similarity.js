// Anti-farming: compare a vs-AI win against the same user's other recent wins (same AI key + board size).
// Moves are stored compactly: 3 base-36 chars per move (seat, row, col), only for vs-AI wins, only for 7 days.

export const SIMILARITY = {
  windowDays: 7,          // compare only against wins within this many days
  minMoves: 30,           // both games need at least this many moves
  tailMoves: 15,          // rule 1: last N moves identical → duplicate
  alignedRatio: 0.9,      // rule 2: move-by-move identical share of the shorter game ≥ this → duplicate
  maxStoredPerUser: 300,  // keep move lists for at most this many recent games per user
  maxMoves: 4000,
};

/** Enforced by default (2026-11-24); only SIMILARITY_ENFORCE = "false" switches back to observe-only. */
export const similarityEnforced = (env) => String(env?.SIMILARITY_ENFORCE ?? "").toLowerCase() !== "false";

/** Leaderboard filter. Restored games never count; similarity duplicates only when enforcing. */
export function countedSql(env) {
  return `(verify IS NULL OR verify IN ('ok', 'approved')) AND COALESCE(restored, 0) = 0`
    + (similarityEnforced(env) ? ` AND COALESCE(sim_status, '') <> 'dup'` : "");
}

const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";
/** [[seat,row,col],...] → "srcsrc..." or null if malformed. */
export function encodeMoves(list) {
  if (!Array.isArray(list) || !list.length || list.length > SIMILARITY.maxMoves) return null;
  let out = "";
  for (const mv of list) {
    if (!Array.isArray(mv) || mv.length < 3) return null;
    for (const v of mv.slice(0, 3)) { if (!Number.isInteger(v) || v < 0 || v > 35) return null; out += B36[v]; }
  }
  return out;
}
const movesOf = (s) => { const a = []; for (let i = 0; i + 3 <= s.length; i += 3) a.push(s.slice(i, i + 3)); return a; };
export const cleanBoard = (b) => (typeof b === "string" && /^[0-9a-zA-Z]{1,2000}$/.test(b) ? b.toLowerCase() : null);

/** Returns { dup, percent, rule } comparing two stored games ({ moves: string, board: string|null }). */
export function compareGames(a, b) {
  const x = movesOf(a.moves || ""), y = movesOf(b.moves || "");
  const shorter = Math.min(x.length, y.length);
  if (shorter < SIMILARITY.minMoves) return { dup: false, percent: 0 };
  let same = 0;
  for (let i = 0; i < shorter; i++) if (x[i] === y[i]) same++;
  const percent = Math.round((same / shorter) * 100);
  const t = SIMILARITY.tailMoves;
  if (x.slice(-t).join("") === y.slice(-t).join("")) return { dup: true, percent: Math.max(percent, Math.round(t / shorter * 100)), rule: `最后 ${t} 步完全相同` };
  if (a.board && b.board && a.board === b.board) return { dup: true, percent, rule: "终局棋盘完全相同" };
  if (same / shorter >= SIMILARITY.alignedRatio) return { dup: true, percent, rule: "逐步对比几乎相同" };
  return { dup: false, percent };
}
