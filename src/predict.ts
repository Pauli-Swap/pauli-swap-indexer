import pg from 'pg';
import { decode, Decoded, getLogs, Source, topicsFor, topicsOf } from './abi.js';
import { hex } from './address.js';
import { config, deployment, faucetDeployment, predictDeployment } from './config.js';
import { log } from './log.js';
import { hexNum, Rpc } from './rpc.js';

/// The Predict module (docs/INDEXER.md §8.6): PauliPredictXP, PredictMarket,
/// the PauliSwap QrlFaucet and direct WQRL wraps, into the predict_* /
/// wrap_events / faucet_drips tables. It runs on its own cursor, never past
/// the pool cursor, so quest rules can join its rows with pool_events.
///
/// Predict is redeployed without a regenesis (the 2026-10-28 deployment came
/// at block 4440 on a chain already indexed to 4409), so it has its own
/// identity: when a deployment record changes, only these tables are emptied
/// and rebuilt from the new startBlock. A regenesis drops the whole schema,
/// these tables included.

const TABLES = ['predict_seasons', 'predict_markets', 'predict_trades', 'predict_claims', 'predict_quests', 'predict_xp_events', 'wrap_events', 'faucet_drips'];

/// Bump when a Predict handler change makes indexed rows wrong.
const PREDICT_RULES = 1;

const optional = (address: string | undefined) => (address ? hex(address) : null);

export class PredictIndexer {
  readonly xp = optional(predictDeployment.contracts.PauliPredictXP);
  readonly market = optional(predictDeployment.contracts.PredictMarket);
  readonly faucet = optional(faucetDeployment.contracts.QrlFaucet);
  private readonly wqrl = hex(deployment.contracts.WQRL);
  private cursor = 0;
  private loaded = false;

  constructor(private readonly db: pg.Pool, private readonly rpc: Rpc) {}

  get enabled() {
    return !!(this.xp && this.market);
  }

  /// Where the module starts reading: the earliest deployment it watches.
  get startBlock() {
    const starts = [this.enabled ? predictDeployment.startBlock : null, this.faucet ? faucetDeployment.startBlock : null].filter((n): n is number => n !== null);
    return starts.length ? Math.min(...starts) : 0;
  }

  private identity() {
    return JSON.stringify({
      v: PREDICT_RULES,
      predict: this.enabled ? [predictDeployment.deployedAt, this.xp, this.market] : null,
      faucet: this.faucet ? [faucetDeployment.deployedAt, this.faucet] : null,
    });
  }

  status() {
    return { enabled: this.enabled, faucet: !!this.faucet, cursor: this.cursor, startBlock: this.startBlock };
  }

  /// Reads the module cursor; empties the Predict tables when the deployment
  /// records changed. Called on start and after a schema reset.
  async load() {
    const { rows } = await this.db.query(`SELECT key, value FROM meta WHERE key IN ('predict_identity', 'predict_cursor')`);
    const m = new Map(rows.map((r) => [r.key, r.value]));
    if (m.get('predict_identity') !== this.identity()) {
      if (m.has('predict_identity')) log('warn', 'predict deployment changed: rebuilding the predict tables', {});
      await this.db.query(`TRUNCATE ${TABLES.join(', ')}`);
      this.cursor = this.startBlock - 1;
      await this.db.query(
        `INSERT INTO meta (key, value) VALUES ('predict_identity', $1), ('predict_cursor', $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [this.identity(), String(this.cursor)],
      );
    } else this.cursor = Number(m.get('predict_cursor'));
    this.loaded = true;
  }

  /// Indexes up to `target`, the pool cursor.
  async step(target: number) {
    if (!this.enabled && !this.faucet) return;
    if (!this.loaded) await this.load();
    while (this.cursor < target) {
      const to = Math.min(target, this.cursor + config.logRange);
      await this.batch(this.cursor + 1, to);
    }
  }

  private sourceOf(address: string): Source | null {
    if (address === this.xp) return 'predictXP';
    if (address === this.market) return 'predictMarket';
    if (address === this.faucet) return 'faucet';
    if (address === this.wqrl) return 'token';
    return null;
  }

  private async batch(from: number, to: number) {
    const addresses = [this.xp, this.market, this.faucet, this.wqrl].filter((a): a is string => !!a);
    const topics = [...topicsFor(['predictXP', 'predictMarket', 'faucet']), ...topicsOf('token', ['Deposit', 'Withdrawal'])];
    const logs = await getLogs(this.rpc, addresses, topics, from, to);
    const events = logs.flatMap((l) => {
      const source = this.sourceOf(hex(l.address));
      const d = source ? decode(source, l) : null;
      return d && (source !== 'token' || d.name === 'Deposit' || d.name === 'Withdrawal') ? [d] : [];
    });
    const blocks = [...new Set(events.map((e) => e.block))];
    const headers = await this.rpc.batchStrict<{ timestamp: string } | null>(blocks.map((n) => ({ method: 'qrl_getBlockByNumber', params: [hexNum(n), false] })));
    const tsOf = new Map(blocks.map((n, i) => [n, Number(headers[i]?.timestamp ?? 0)]));

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      for (const e of events) await this.apply(client, e, tsOf.get(e.block)!);
      await client.query(`UPDATE meta SET value = $1 WHERE key = 'predict_cursor'`, [String(to)]);
      await client.query('COMMIT');
      this.cursor = to;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    if (events.length) log('info', 'predict batch', { from, to, events: events.length });
  }

  private async apply(q: pg.PoolClient, d: Decoded, ts: number) {
    const a = d.args;
    const wallet = (v: string) => Buffer.from(hex(v), 'hex');
    const key = [d.block, d.logIndex, ts];
    switch (d.name) {
      case 'SeasonStarted':
        return q.query(`INSERT INTO predict_seasons (id, ends_at, started_ts, started_block) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, [Number(a.season), Number(a.endsAt), ts, d.block]);
      case 'SeasonClosed':
        return q.query(`UPDATE predict_seasons SET closed_block = $2 WHERE id = $1`, [Number(a.season), d.block]);
      case 'XPCredited':
      case 'XPDebited': {
        const amount = BigInt(a.amount) * (d.name === 'XPDebited' ? -1n : 1n);
        return q.query(`INSERT INTO predict_xp_events VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`, [
          ...key, wallet(a.user), Number(a.season), amount.toString(), Buffer.from(String(a.reason).replace(/^0x/, ''), 'hex'),
        ]);
      }
      case 'QuestCompleted':
        return q.query(`INSERT INTO predict_quests VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`, [...key, wallet(a.user), Number(a.questId), Number(a.day), BigInt(a.amount).toString()]);
      case 'MarketCreated':
        return q.query(
          `INSERT INTO predict_markets (id, question, close_time, liquidity, created_block) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
          [Number(a.id), String(a.question), Number(a.closeTime), BigInt(a.liquidity).toString(), d.block],
        );
      case 'MarketResolved':
        return q.query(`UPDATE predict_markets SET status = 1, outcome = $2, settled_block = $3 WHERE id = $1`, [Number(a.id), Number(a.outcome), d.block]);
      case 'MarketCancelled':
        return q.query(`UPDATE predict_markets SET status = 2, settled_block = $2 WHERE id = $1`, [Number(a.id), d.block]);
      case 'Bought':
      case 'Sold':
        return q.query(`INSERT INTO predict_trades VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`, [
          ...key, Number(a.id), wallet(a.user), d.name === 'Bought' ? 0 : 1, Number(a.outcome), BigInt(d.name === 'Bought' ? a.xpIn : a.xpOut).toString(), BigInt(a.shares).toString(),
        ]);
      case 'Claimed':
        return q.query(`INSERT INTO predict_claims VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, [...key, Number(a.id), wallet(a.user), BigInt(a.xp).toString()]);
      case 'Dripped':
        return q.query(`INSERT INTO faucet_drips VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [...key, wallet(a.to), BigInt(a.amount).toString()]);
      case 'Deposit':
      case 'Withdrawal':
        return q.query(`INSERT INTO wrap_events VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, [
          ...key, wallet(d.name === 'Deposit' ? a.dst : a.src), d.name === 'Deposit' ? 0 : 1, BigInt(a.wad).toString(),
        ]);
    }
  }
}
