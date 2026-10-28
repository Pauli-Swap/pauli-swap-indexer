import pg from 'pg';
import { config, deployment } from './config.js';
import { log } from './log.js';

/// QRL/USD (docs/INDEXER.md §9). Values are stored in QRL; the API converts
/// them with the price of the series below at each row's time.
///
/// - `feed`: an off-chain series (`coingecko` or `mexc`) that this module
///   polls into qrl_usd, backfilled hourly to the first indexed event.
/// - `stable`: the on-chain anchor the indexer writes as series `stable`; the
///   feed, when set, only checks it.
///
/// The feed runs beside the indexer and never blocks it: a failed poll is
/// logged, retried with backoff and shown in /health.

const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);

type Point = { ts: number; price: number };

const json = async (url: string) => {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.json() as Promise<any>;
};

const FEEDS: Record<'coingecko' | 'mexc', { latest: () => Promise<Point>; hourly: (from: number, to: number) => Promise<Point[]> }> = {
  // Free public API; checked 2026-10-28. Ranges of 1 to 90 days come back hourly.
  coingecko: {
    latest: async () => {
      const r = await json('https://api.coingecko.com/api/v3/simple/price?ids=quantum-resistant-ledger&vs_currencies=usd&include_last_updated_at=true');
      const q = r['quantum-resistant-ledger'];
      return { ts: q.last_updated_at ?? now(), price: Number(q.usd) };
    },
    hourly: async (from, to) => {
      const out: Point[] = [];
      for (let start = from; start < to; start += 89 * 86400) {
        const end = Math.min(to, start + 89 * 86400);
        const r = await json(`https://api.coingecko.com/api/v3/coins/quantum-resistant-ledger/market_chart/range?vs_currency=usd&from=${start}&to=${end}`);
        for (const [ms, price] of r.prices ?? []) out.push({ ts: Math.floor(ms / 1000), price: Number(price) });
      }
      return out;
    },
  },
  // QRLUSDT; a USDT price, which the proposal accepts as USD.
  mexc: {
    latest: async () => {
      const r = await json('https://api.mexc.com/api/v3/ticker/price?symbol=QRLUSDT');
      return { ts: now(), price: Number(r.price) };
    },
    hourly: async (from, to) => {
      const out: Point[] = [];
      for (let start = from; start < to; start += 1000 * HOUR) {
        const r = await json(`https://api.mexc.com/api/v3/klines?symbol=QRLUSDT&interval=60m&limit=1000&startTime=${start * 1000}&endTime=${Math.min(to, start + 1000 * HOUR) * 1000}`);
        // [openTime, open, high, low, close, volume, closeTime, ...]: the open at the open, the close at the close.
        for (const k of r) {
          out.push({ ts: Math.floor(Number(k[0]) / 1000), price: Number(k[1]) });
          out.push({ ts: Math.min(now(), Math.floor(Number(k[6]) / 1000)), price: Number(k[4]) });
        }
      }
      return out;
    },
  },
};

/// What the API converts with. `series` null means every USD field is null.
export type UsdView = {
  usdSource: 'none' | 'stable' | 'feed';
  series: string | null;
  /// Seconds a series point stays valid; null for `stable`, whose points hold
  /// until the next on-chain change.
  maxAge: number | null;
  price: number | null;
  feedPrice: number | null;
  deviation: number | null;
  hidden: boolean;
};

export class Usd {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  lastError: string | null = null;
  lastPollAt: string | null = null;
  private cached: { at: number; view: UsdView } | null = null;
  /// The feed has nothing older than what is stored (a listing newer than the
  /// deployment, or a history limit): stop asking until the next rebuild.
  private historyExhausted = false;

  constructor(private readonly db: pg.Pool) {}

  start() {
    if (!config.usdFeed || this.running) return;
    this.running = true;
    void this.poll();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  /// A rebuild dropped qrl_usd with the schema: refill it now, not at the next poll.
  refill() {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.cached = null;
    this.historyExhausted = false;
    this.timer = setTimeout(() => void this.poll(), 1000);
  }

  private async poll() {
    if (!this.running) return;
    try {
      await this.backfill();
      await this.store([await FEEDS[config.usdFeed as 'coingecko' | 'mexc'].latest()]);
      this.failures = 0;
      this.lastError = null;
      this.lastPollAt = new Date().toISOString();
    } catch (e) {
      this.failures++;
      this.lastError = (e as Error).message;
      log('warn', 'usd feed poll failed', { feed: config.usdFeed, error: this.lastError, failures: this.failures });
    }
    // Back off on errors (rate limits, outages), at most an hour.
    const delay = Math.min(3600_000, config.usdFeedMinutes * 60_000 * 2 ** Math.min(this.failures, 6));
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  /// Hourly points from the deployment to now, where missing. A rebuild drops
  /// qrl_usd with the schema, so this also refills it.
  private async backfill() {
    const { rows } = await this.db.query(
      `SELECT (SELECT min(ts) FROM qrl_usd WHERE source = $1) AS first, (SELECT max(ts) FROM qrl_usd WHERE source = $1) AS last`,
      [config.usdFeed],
    );
    const { first, last } = rows[0];
    const feed = FEEDS[config.usdFeed as 'coingecko' | 'mexc'];
    const from = Math.floor(Date.parse(deployment.deployedAt) / 1000) - HOUR;
    if (!this.historyExhausted && (first === null || first > from + 2 * HOUR)) {
      const points = await feed.hourly(from, first ?? now());
      await this.store(points);
      if (first !== null && !points.some((p) => p.ts < first)) this.historyExhausted = true;
    }
    if (last !== null && last < now() - 2 * HOUR) await this.store(await feed.hourly(last, now()));
  }

  private async store(points: Point[]) {
    // One point per second; a later one wins (candle closes meet the next open).
    const ok = [...new Map(points.filter((p) => Number.isFinite(p.price) && p.price > 0).map((p) => [p.ts, p])).values()];
    if (!ok.length) return;
    await this.db.query(
      `INSERT INTO qrl_usd (source, ts, price) SELECT $1, unnest($2::int4[]), unnest($3::float8[])
       ON CONFLICT (source, ts) DO UPDATE SET price = EXCLUDED.price`,
      [config.usdFeed, ok.map((p) => p.ts), ok.map((p) => p.price)],
    );
  }

  /// The current conversion, cached for 10 s.
  async view(): Promise<UsdView> {
    if (this.cached && Date.now() - this.cached.at < 10_000) return this.cached.view;
    const feedMaxAge = config.usdFeedMaxAgeHours * HOUR;
    const latest = async (series: string, maxAge: number | null) => {
      const { rows } = await this.db.query('SELECT usd_at($1, $2, $3) AS price', [series, now(), maxAge]);
      return (rows[0]?.price ?? null) as number | null;
    };
    let feedPrice: number | null = null;
    let stablePrice: number | null = null;
    try {
      feedPrice = config.usdFeed ? await latest(config.usdFeed, feedMaxAge) : null;
      stablePrice = config.usdSource === 'stable' ? await latest('stable', null) : null;
    } catch {
      // Mid rebuild: no prices until the schema is back.
    }
    let view: UsdView;
    if (config.usdSource === 'feed') {
      view = { usdSource: 'feed', series: config.usdFeed, maxAge: feedMaxAge, price: feedPrice, feedPrice, deviation: null, hidden: false };
    } else if (config.usdSource === 'stable') {
      const price = stablePrice;
      const deviation = price !== null && feedPrice !== null ? Math.abs(price / feedPrice - 1) : null;
      const hidden = deviation !== null && deviation > config.usdMaxDeviation;
      view = { usdSource: 'stable', series: 'stable', maxAge: null, price, feedPrice, deviation, hidden };
    } else {
      view = { usdSource: 'none', series: null, maxAge: null, price: null, feedPrice, deviation: null, hidden: false };
    }
    if (view.hidden) view = { ...view, series: null, price: null };
    this.cached = { at: Date.now(), view };
    return view;
  }

  status() {
    return { feed: config.usdFeed || null, lastPollAt: this.lastPollAt, lastError: this.lastError };
  }
}
