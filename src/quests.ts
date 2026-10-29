import pg from 'pg';
import catalogue from './contracts/quests.json' with { type: 'json' };
import { render, toBytes } from './address.js';

/// Quest rules (docs/INDEXER.md §8.6) over the Predict module's tables and
/// pool_events. The catalogue is pauli-swap-prediction-market/quests/catalog.json,
/// synced by scripts/sync-predict.mjs; the attester bot credits what `queue`
/// returns, and the interface shows `progress`.
///
/// A wallet is the transaction signer for swaps and liquidity (the router
/// or position manager is only the `to` of the pool event), the event's
/// user for Predict, `to` for faucet drips and dst / src for wraps.
/// Anti-farming lives in the rules, not in the bot: swaps count only on
/// tracked pools and above `min` QRL, liquidity counts net of removals at the
/// end of a UTC day, and season tiers count days, never volume, since test
/// tokens have an unlimited faucet.

export type Quest = {
  id: number;
  kind: 'daily' | 'season';
  hidden?: boolean;
  rule: string;
  target: number;
  min?: number;
  xp: number;
  action?: string;
  title: string;
  detail: string;
};

export const QUESTS = (catalogue as { quests: Quest[] }).quests;
const DAY = 86400;
const XP = 10n ** 18n;

export type Progress = {
  id: number;
  kind: string;
  hidden: boolean;
  /// Null on a hidden quest the wallet has not been credited for.
  title: string | null;
  detail: string | null;
  xp: number | null;
  action: string | null;
  target: number | null;
  progress: number | null;
  met: boolean;
  credited: boolean;
};

type Season = { id: number; startedTs: number; endsAt: number };
type Window = { from: number; to: number };

/// The text of `q`, or nulls for a hidden quest the wallet has not been
/// credited for, so the API never reveals one early.
export function questText(q: Quest, credited: boolean) {
  const masked = !!q.hidden && !credited;
  return {
    title: masked ? null : q.title,
    detail: masked ? null : q.detail,
    xp: masked ? null : q.xp,
    action: masked ? null : (q.action ?? null),
    target: masked ? null : q.target,
  };
}

export class Quests {
  constructor(
    private readonly db: pg.Pool,
    private readonly quests: Quest[] = QUESTS,
  ) {}

  /// The latest season, or null before the first SeasonStarted.
  async season(): Promise<Season | null> {
    const { rows } = await this.db.query(`SELECT id, started_ts, ends_at FROM predict_seasons ORDER BY id DESC LIMIT 1`);
    return rows[0] ? { id: rows[0].id, startedTs: rows[0].started_ts, endsAt: rows[0].ends_at } : null;
  }

  private async scalar(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await this.db.query(sql, params);
    return Number(rows[0]?.n ?? 0);
  }

  /// UTC days in `w` on which a daily rule was met.
  private async days(rule: string, wallet: Buffer, w: Window, min = 0): Promise<number[]> {
    let sql: string;
    let params: unknown[] = [wallet, w.from, w.to];
    if (rule === 'check_in') {
      sql = `SELECT DISTINCT day AS d FROM predict_quests WHERE wallet = $1 AND quest_id = 0 AND ts >= $2 AND ts < $3`;
    } else if (rule === 'swap') {
      sql = `SELECT DISTINCT e.ts / ${DAY} AS d FROM pool_events e
               JOIN transactions t ON t.id = e.tx_id JOIN addresses a ON a.id = t.from_id JOIN pools p ON p.id = e.pool_id
              WHERE a.address = $1 AND e.kind = 0 AND p.tracked AND e.amount_qrl >= $4 AND e.ts >= $2 AND e.ts < $3`;
      params = [...params, min];
    } else if (rule === 'predict_buy') {
      sql = `SELECT DISTINCT ts / ${DAY} AS d FROM predict_trades WHERE wallet = $1 AND side = 0 AND xp >= $4 AND ts >= $2 AND ts < $3`;
      params = [...params, (BigInt(min) * XP).toString()];
    } else throw new Error(`no day rule ${rule}`);
    const { rows } = await this.db.query(sql, params);
    return rows.map((r) => Number(r.d));
  }

  /// The rule's count for `wallet` within `w`; `today` bounds rules that only
  /// count completed days.
  async measure(q: Quest, wallet: Buffer, w: Window, today: number): Promise<number> {
    const min = q.min ?? 0;
    if (q.rule.startsWith('days:')) return (await this.days(q.rule.slice(5), wallet, w, min)).length;
    switch (q.rule) {
      case 'check_in':
      case 'swap':
      case 'predict_buy':
        return (await this.days(q.rule, wallet, w, min)).length;
      case 'lp_net': {
        // Net liquidity (adds minus removes, in QRL at the time) after each
        // completed UTC day; met once any day ends at or above `min`.
        const { rows } = await this.db.query(
          `SELECT e.ts / ${DAY} AS d, sum(CASE e.kind WHEN 1 THEN e.amount_qrl ELSE -e.amount_qrl END) AS net FROM pool_events e
             JOIN transactions t ON t.id = e.tx_id JOIN addresses a ON a.id = t.from_id
            WHERE a.address = $1 AND e.kind IN (1, 2) AND e.amount_qrl IS NOT NULL AND e.ts < $2 GROUP BY 1 ORDER BY 1`,
          [wallet, Math.min(w.to, today * DAY)],
        );
        let running = 0;
        for (const r of rows) {
          running += Number(r.net);
          if (Number(r.d) * DAY >= w.from && running >= min) return 1;
        }
        return 0;
      }
      case 'wrap':
        return this.scalar(`SELECT count(*) AS n FROM wrap_events WHERE wallet = $1 AND amount >= $4 AND ts >= $2 AND ts < $3`, [wallet, w.from, w.to, (BigInt(Math.round(min * 1e6)) * 10n ** 12n).toString()]);
      case 'predict_markets':
        return this.scalar(`SELECT count(DISTINCT market) AS n FROM predict_trades WHERE wallet = $1 AND side = 0 AND xp >= $4 AND ts >= $2 AND ts < $3`, [wallet, w.from, w.to, (BigInt(min) * XP).toString()]);
      case 'predict_win':
        return this.scalar(
          `SELECT count(*) AS n FROM predict_claims c JOIN predict_markets m ON m.id = c.market WHERE c.wallet = $1 AND m.status = 1 AND c.ts >= $2 AND c.ts < $3`,
          [wallet, w.from, w.to],
        );
      case 'faucet':
        return this.scalar(`SELECT count(*) AS n FROM faucet_drips WHERE wallet = $1 AND ts >= $2 AND ts < $3`, [wallet, w.from, w.to]);
    }
    throw new Error(`unknown quest rule ${q.rule}`);
  }

  /// Daily quests on `day`, season quests over the latest season so far.
  async progress(address: string, day: number, now = Math.floor(Date.now() / 1000)): Promise<Progress[]> {
    const wallet = toBytes(address);
    const season = await this.season();
    const today = Math.floor(now / DAY);
    const { rows } = await this.db.query(`SELECT quest_id, day, ts FROM predict_quests WHERE wallet = $1`, [wallet]);
    const out: Progress[] = [];
    for (const q of this.quests) {
      const credited =
        q.kind === 'daily'
          ? rows.some((r) => r.quest_id === q.id && r.day === day)
          : !!season && rows.some((r) => r.quest_id === q.id && r.ts >= season.startedTs);
      // Both windows are clipped to the season: nothing before SeasonStarted counts.
      const w = !season
        ? null
        : q.kind === 'daily'
          ? { from: Math.max(day * DAY, season.startedTs), to: Math.min((day + 1) * DAY, season.endsAt) }
          : { from: season.startedTs, to: Math.min(season.endsAt, now + 1) };
      const value = w && w.from < w.to ? await this.measure(q, wallet, w, today) : 0;
      const text = questText(q, credited);
      out.push({
        id: q.id,
        kind: q.kind,
        hidden: !!q.hidden,
        ...text,
        progress: text.target === null ? null : Math.min(value, q.target),
        met: value >= q.target,
        credited,
      });
    }
    return out;
  }

  /// Wallets with any Predict, faucet, wrap or pool activity this season.
  async wallets(): Promise<Buffer[]> {
    const season = await this.season();
    if (!season) return [];
    const { rows } = await this.db.query(
      `SELECT DISTINCT w FROM (
         SELECT wallet AS w FROM predict_trades WHERE ts >= $1 UNION SELECT wallet FROM predict_claims WHERE ts >= $1
         UNION SELECT wallet FROM predict_quests WHERE ts >= $1 UNION SELECT wallet FROM wrap_events WHERE ts >= $1
         UNION SELECT wallet FROM faucet_drips WHERE ts >= $1
         UNION SELECT a.address FROM pool_events e JOIN transactions t ON t.id = e.tx_id JOIN addresses a ON a.id = t.from_id WHERE e.ts >= $1
       ) x`,
      [season.startedTs],
    );
    return rows.map((r) => r.w as Buffer);
  }

  /// What the attester should credit for `day`: met, not credited, never the
  /// on-chain check-in. Season quests are offered only for today, so a tier
  /// is never offered under two days at once.
  async queue(day: number, now = Math.floor(Date.now() / 1000)) {
    const season = await this.season();
    if (!season || now >= season.endsAt) return [];
    const today = Math.floor(now / DAY);
    const out: { user: string; questId: number; day: number; xp: number; kind: string }[] = [];
    for (const w of await this.wallets()) {
      const user = render(w);
      for (const p of await this.progress(user, day, now)) {
        if (p.id === 0 || !p.met || p.credited) continue;
        if (p.kind === 'season' && day !== today) continue;
        out.push({ user, questId: p.id, day, xp: this.quests.find((q) => q.id === p.id)!.xp, kind: p.kind });
      }
    }
    return out;
  }
}
