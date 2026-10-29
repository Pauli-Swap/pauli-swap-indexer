import pg from 'pg';
import { render } from './address.js';
import { config } from './config.js';

/// Season ranking (docs/INDEXER.md §8.8, PROPOSAL-PREDICT.md §4): each
/// wallet's score at block B, replayed from the Predict tables. The snapshot
/// command and the API's predictLeaderboard both call `standings`, so the
/// board and the closeSeason export never disagree.
///
///   score = xp_balance(S, user, B) + claimable(user, B)
///
/// `claimable` is what claiming every market settled at B would pay, per
/// position as PredictMarket.claim does: the winning shares of a resolved
/// market, `(yes + no) / 2` (integer division) of a cancelled one. It counts
/// settled markets of any season, since a claim credits the current season.

const DAY = 86400;

export type Rules = {
  /// Active UTC days (a QuestCompleted, Bought or Sold) in the season.
  minDays: number;
  /// Distinct markets with a Bought in the season (a Sold alone does not count).
  minMarkets: number;
};
/// PREDICT_MIN_DAYS / PREDICT_MIN_MARKETS; 7 and 3 are the proposed season 1
/// rules (TODO 2.1), still to be confirmed.
export const DEFAULT_RULES: Rules = { minDays: config.predictMinDays, minMarkets: config.predictMinMarkets };

export type Market = { id: number; status: number; outcome: number | null; createdBlock: number; settledBlock: number | null };
type At = { block: number; logIndex: number };
export type Trade = At & { ts: number; market: number; wallet: string; side: number; outcome: number; shares: bigint };
export type Claim = At & { market: number; wallet: string };
export type XpEvent = At & { wallet: string; season: number; amount: bigint };
export type QuestEvent = { block: number; ts: number; wallet: string };
export type Season = { id: number; startedTs: number; endsAt: number };

export type Position = { market: number; wallet: string; yes: bigint; no: bigint };

export type Standing = {
  user: string;
  xp: bigint;
  claimable: bigint;
  score: bigint;
  activeDays: number;
  marketsTraded: number;
  eligible: boolean;
  /// Last block at which the score changed; the earlier one ranks higher on a tie.
  reachedBlock: number | null;
  /// 1-based over wallets not denied; null for a denied wallet.
  rank: number | null;
  denied: boolean;
};

const statusAt = (m: Market, block: number) => (m.settledBlock !== null && m.settledBlock <= block ? m.status : 0);

/// What claim(id) pays for `p` on a market in status `status`.
export function claimableOf(m: Market, status: number, p: { yes: bigint; no: bigint }): bigint {
  if (status === 1) return m.outcome === 0 ? p.yes : p.no;
  if (status === 2) return (p.yes + p.no) / 2n;
  return 0n;
}

/// Positions after every trade and claim given (a claim deletes the position).
export function positions(trades: Trade[], claims: Claim[]): Position[] {
  const events = [...trades.map((t) => ({ ...t, kind: 'trade' as const })), ...claims.map((c) => ({ ...c, kind: 'claim' as const }))].sort(
    (a, b) => a.block - b.block || a.logIndex - b.logIndex,
  );
  const out = new Map<string, Position>();
  for (const e of events) {
    const key = `${e.market}:${e.wallet}`;
    const p = out.get(key) ?? { market: e.market, wallet: e.wallet, yes: 0n, no: 0n };
    out.set(key, p);
    if (e.kind === 'claim') {
      p.yes = 0n;
      p.no = 0n;
    } else {
      const d = e.side === 0 ? e.shares : -e.shares;
      if (e.outcome === 0) p.yes += d;
      else p.no += d;
    }
  }
  return [...out.values()];
}

export type RankInput = {
  season: Season;
  block: number;
  markets: Market[];
  /// Rows at or before `block`; xp of every season (only `season.id` counts).
  trades: Trade[];
  claims: Claim[];
  xp: XpEvent[];
  quests: QuestEvent[];
  rules: Rules;
  denied?: Set<string>;
};

/// Replays the season block by block. The score is taken at the end of each
/// block, so a claim (XPCredited, then Claimed, in one transaction) never
/// shows as a change.
export function rank(input: RankInput): Standing[] {
  const { season, block: B, rules } = input;
  const marketById = new Map(input.markets.map((m) => [m.id, m]));
  const upTo = <T extends { block: number }>(rows: T[]) => rows.filter((r) => r.block <= B);
  const trades = upTo(input.trades);
  const claims = upTo(input.claims);
  const xp = upTo(input.xp).filter((e) => e.season === season.id);
  const inSeason = (ts: number) => ts >= season.startedTs && ts < season.endsAt;

  // Block by block: xp balance and positions of each wallet.
  type Ev = { block: number; logIndex: number; apply: () => string[] };
  const balance = new Map<string, bigint>();
  const pos = new Map<string, Map<number, { yes: bigint; no: bigint }>>();
  const posOf = (w: string, m: number) => {
    let byMarket = pos.get(w);
    if (!byMarket) pos.set(w, (byMarket = new Map()));
    let p = byMarket.get(m);
    if (!p) byMarket.set(m, (p = { yes: 0n, no: 0n }));
    return p;
  };
  const events: Ev[] = [
    ...xp.map((e) => ({ ...e, apply: () => (balance.set(e.wallet, (balance.get(e.wallet) ?? 0n) + e.amount), [e.wallet]) })),
    ...trades.map((t) => ({
      ...t,
      apply: () => {
        const p = posOf(t.wallet, t.market);
        const d = t.side === 0 ? t.shares : -t.shares;
        if (t.outcome === 0) p.yes += d;
        else p.no += d;
        return [t.wallet];
      },
    })),
    ...claims.map((c) => ({ ...c, apply: () => (pos.get(c.wallet)?.delete(c.market), [c.wallet]) })),
    // A settlement comes before anything else in its block: no trade can
    // follow it, and a claim needs it.
    ...input.markets
      .filter((m) => m.settledBlock !== null && m.settledBlock <= B)
      .map((m) => ({ block: m.settledBlock!, logIndex: -1, apply: () => [...pos.entries()].filter(([, ps]) => ps.has(m.id)).map(([w]) => w) })),
  ].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

  const claimableNow = (w: string, at: number) => {
    let sum = 0n;
    for (const [id, p] of pos.get(w) ?? []) {
      const m = marketById.get(id);
      if (m) sum += claimableOf(m, statusAt(m, at), p);
    }
    return sum;
  };
  const scoreOf = (w: string, at: number) => (balance.get(w) ?? 0n) + claimableNow(w, at);
  const last = new Map<string, bigint>();
  const reached = new Map<string, number>();
  for (let i = 0; i < events.length; ) {
    const at = events[i].block;
    const touched = new Set<string>();
    for (; i < events.length && events[i].block === at; i++) for (const w of events[i].apply()) touched.add(w);
    for (const w of touched) {
      const s = scoreOf(w, at);
      if (s !== (last.get(w) ?? 0n)) reached.set(w, at);
      last.set(w, s);
    }
  }

  const days = new Map<string, Set<number>>();
  const markets = new Map<string, Set<number>>();
  const add = <K>(m: Map<string, Set<K>>, w: string, v: K) => (m.get(w) ?? m.set(w, new Set()).get(w)!).add(v);
  for (const q of upTo(input.quests)) if (inSeason(q.ts)) add(days, q.wallet, Math.floor(q.ts / DAY));
  for (const t of trades) {
    if (!inSeason(t.ts)) continue;
    add(days, t.wallet, Math.floor(t.ts / DAY));
    if (t.side === 0) add(markets, t.wallet, t.market);
  }

  const wallets = new Set([...balance.keys(), ...pos.keys(), ...days.keys()]);
  const rows: Standing[] = [...wallets].map((w) => {
    const x = balance.get(w) ?? 0n;
    const claimable = claimableNow(w, B);
    const activeDays = days.get(w)?.size ?? 0;
    const marketsTraded = markets.get(w)?.size ?? 0;
    return {
      user: w,
      xp: x,
      claimable,
      score: x + claimable,
      activeDays,
      marketsTraded,
      eligible: activeDays >= rules.minDays && marketsTraded >= rules.minMarkets,
      reachedBlock: reached.get(w) ?? null,
      rank: null,
      denied: !!input.denied?.has(w),
    };
  });
  rows.sort(
    (a, b) =>
      Number(a.denied) - Number(b.denied) ||
      (a.score === b.score ? 0 : a.score > b.score ? -1 : 1) ||
      (a.reachedBlock ?? Infinity) - (b.reachedBlock ?? Infinity) ||
      (a.user < b.user ? -1 : 1),
  );
  let n = 0;
  for (const r of rows) if (!r.denied) r.rank = ++n;
  return rows;
}

/// The `winners` argument of closeSeason: the first three eligible wallets
/// that are not denied, padded with the zero address.
export const ZERO_WALLET = '0'.repeat(128);
export const winnersOf = (rows: Standing[]) => {
  const w = rows.filter((r) => r.eligible && !r.denied).slice(0, 3).map((r) => r.user);
  return [...w, ...Array(3 - w.length).fill(ZERO_WALLET)] as string[];
};

// ---- loading from the database ----

const hexOf = (b: Buffer) => b.toString('hex');

export type SeasonRow = Season & { startedBlock: number; closedBlock: number | null; snapshotBlock: number | null; winners: string[] | null };

export async function seasonRow(db: pg.Pool, id?: number): Promise<SeasonRow | null> {
  const { rows } = await db.query(
    `SELECT id, ends_at, started_ts, started_block, closed_block, snapshot_block, winners FROM predict_seasons
      WHERE $1::int4 IS NULL OR id = $1 ORDER BY id DESC LIMIT 1`,
    [id ?? null],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    endsAt: r.ends_at,
    startedTs: r.started_ts,
    startedBlock: r.started_block,
    closedBlock: r.closed_block,
    snapshotBlock: r.snapshot_block,
    winners: r.winners ? (r.winners as Buffer[]).map(render) : null,
  };
}

export async function loadMarkets(db: pg.Pool): Promise<Market[]> {
  const { rows } = await db.query(`SELECT id, status, outcome, created_block, settled_block FROM predict_markets ORDER BY id`);
  return rows.map((r) => ({ id: r.id, status: r.status, outcome: r.outcome, createdBlock: r.created_block, settledBlock: r.settled_block }));
}

/// Trades up to `block`, of one wallet and / or one market when given.
export async function loadTrades(db: pg.Pool, block: number, wallet?: Buffer, market?: number): Promise<Trade[]> {
  const { rows } = await db.query(
    `SELECT block_number, log_index, ts, market, wallet, side, outcome, shares::text FROM predict_trades
      WHERE block_number <= $1 AND ($2::bytea IS NULL OR wallet = $2) AND ($3::int4 IS NULL OR market = $3)`,
    [block, wallet ?? null, market ?? null],
  );
  return rows.map((r) => ({
    block: r.block_number, logIndex: r.log_index, ts: r.ts, market: r.market, wallet: hexOf(r.wallet), side: r.side, outcome: r.outcome, shares: BigInt(r.shares),
  }));
}

export async function loadClaims(db: pg.Pool, block: number, wallet?: Buffer, market?: number): Promise<Claim[]> {
  const { rows } = await db.query(
    `SELECT block_number, log_index, market, wallet FROM predict_claims
      WHERE block_number <= $1 AND ($2::bytea IS NULL OR wallet = $2) AND ($3::int4 IS NULL OR market = $3)`,
    [block, wallet ?? null, market ?? null],
  );
  return rows.map((r) => ({ block: r.block_number, logIndex: r.log_index, market: r.market, wallet: hexOf(r.wallet) }));
}

/// Standings of `season` at `block`.
export async function standings(db: pg.Pool, season: Season, block: number, rules: Rules, denied?: Set<string>) {
  const [markets, trades, claims, xp, quests] = await Promise.all([
    loadMarkets(db),
    loadTrades(db, block),
    loadClaims(db, block),
    db.query(`SELECT block_number, log_index, wallet, season, amount::text FROM predict_xp_events WHERE season = $1 AND block_number <= $2`, [season.id, block]),
    db.query(`SELECT block_number, ts, wallet FROM predict_quests WHERE block_number <= $1`, [block]),
  ]);
  const rows = rank({
    season,
    block,
    rules,
    denied,
    markets,
    trades,
    claims,
    xp: xp.rows.map((r) => ({ block: r.block_number, logIndex: r.log_index, wallet: hexOf(r.wallet), season: r.season, amount: BigInt(r.amount) })),
    quests: quests.rows.map((r) => ({ block: r.block_number, ts: r.ts, wallet: hexOf(r.wallet) })),
  });
  const openMarkets = markets.filter((m) => m.createdBlock <= block && statusAt(m, block) === 0).map((m) => m.id);
  return { rows, openMarkets };
}

/// The Predict module's cursor.
export async function predictCursor(db: pg.Pool): Promise<number> {
  const { rows } = await db.query(`SELECT value FROM meta WHERE key = 'predict_cursor'`);
  return Number(rows[0]?.value ?? 0);
}
