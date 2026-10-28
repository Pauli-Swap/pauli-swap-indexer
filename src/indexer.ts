import fs from 'node:fs';
import pg from 'pg';
import { decode, Decoded, getLogs, RawLog, Source, tokenMetadata, topicsFor } from './abi.js';
import { hex, ZERO } from './address.js';
import { config, deployment } from './config.js';
import { dropPartitionsBefore, ensurePartition, migrate, resetSchema } from './db.js';
import { log } from './log.js';
import { isTracked, qrlPrices, rawPrice, sidesQrl, stablePrice, toFloat } from './pricing.js';
import { hexNum, Rpc } from './rpc.js';

// ---- in-memory state (small: one row per pool and per token) ----

type PoolState = {
  address: string;
  version: 2 | 3;
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
  createdBlock: number;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  sqrtPrice: bigint;
  tick: number | null;
  liquidity: bigint;
  rawPrice: number | null;
  tvlQrl: number | null;
  tracked: boolean;
  /// Tracked pools only (§9); the rest goes to untrackedVolumeQrl.
  volumeQrl: number;
  untrackedVolumeQrl: number;
  feesQrl: number;
  txCount: number;
  updatedBlock: number;
};

type TokenState = {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  totalSupply: bigint;
  derivedQrl: number | null;
  /// USD_SOURCE=stable: price through the token's own deep stable pair.
  derivedUsd: number | null;
  firstBlock: number;
  updatedBlock: number;
};

/// A row of pool_events before it has ids. kind: 0 swap, 1 add, 2 remove, 3 sync.
type EventRow = {
  ts: number;
  block: number;
  logIndex: number;
  pool: string;
  kind: 0 | 1 | 2 | 3;
  txHash: string;
  account: string | null;
  amount0: bigint;
  amount1: bigint;
  rawPrice: number | null;
  amountQrl: number | null;
};

type PoolPeriod = {
  pool: string;
  period: number;
  volume0: bigint;
  volume1: bigint;
  volumeQrl: number;
  untrackedVolumeQrl: number;
  feesQrl: number;
  swaps: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  tvlQrl: number | null;
};
type TokenPeriod = { token: string; period: number; open: number; high: number; low: number; close: number };

/// Everything one batch writes, flushed in one database transaction.
type Batch = {
  newTokens: Set<string>;
  newPools: Set<string>;
  dirtyTokens: Set<string>;
  dirtyPools: Set<string>;
  /// token -> account -> delta
  deltas: Map<string, Map<string, bigint>>;
  events: EventRow[];
  txs: Map<string, { block: number; from: string | null }>;
  blocks: Map<number, { hash: string; ts: number }>;
  poolHour: Map<string, PoolPeriod>;
  poolDay: Map<string, PoolPeriod>;
  tokenHour: Map<string, TokenPeriod>;
  tokenDay: Map<string, TokenPeriod>;
  /// Changes of the `stable` QRL/USD anchor, in block order.
  anchors: { ts: number; price: number | null }[];
};

const HOUR = 3600;
const DAY = 86400;
const V2_FEE = 3000;

/// Bump when a handler or pricing change makes indexed history wrong; like a
/// change of the pricing settings below, it rebuilds the schema (§10).
const RULES_VERSION = 2;
const rulesKey = () =>
  JSON.stringify({
    v: RULES_VERSION,
    minQrl: config.minQrlLiquidity,
    bridges: [...config.bridgeTokens].sort(),
    stables: [...config.stableTokens].sort(),
    stable: config.usdSource === 'stable' ? config.minUsdLiquidity : null,
  });

class StopIndexing extends Error {}

export type Status = {
  head: number;
  cursor: number;
  lag: number;
  paused: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  rpcCalls: number;
  chainId: number;
  startBlock: number;
};

export class Indexer {
  readonly rpc = new Rpc(config.rpcUrl);
  private pools = new Map<string, PoolState>();
  private tokens = new Map<string, TokenState>();
  /// `${token}:${pool}` -> pool's balance of token; the V3 reserves, which is
  /// what the interface reads with balanceOf (§5: derived, not read).
  private poolBalances = new Map<string, bigint>();
  private ids = new Map<string, number>();
  private cursor = deployment.startBlock - 1;
  private cursorHash: string | null = null;
  private head = 0;
  private paused: string | null = null;
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;
  private lastIdentityCheck = 0;
  private lastRetention = 0;
  private running = false;

  private readonly wqrl = hex(deployment.contracts.WQRL);
  private readonly v2Factory = hex(deployment.contracts.PauliV2Factory);
  private readonly v3Factory = hex(deployment.contracts.PauliV3Factory);
  private readonly bridges = new Set([this.wqrl, ...config.stableTokens, ...config.bridgeTokens]);
  /// Last `stable` anchor written to qrl_usd.
  private anchor: number | null = null;

  /// Called after the schema was dropped and rebuilt.
  onReset: () => void | Promise<void> = () => undefined;
  /// Runs after every step with the pool cursor (the Predict module, §8.6).
  onStep: (cursor: number) => Promise<void> = async () => undefined;

  constructor(private readonly db: pg.Pool) {}

  status(): Status {
    return {
      head: this.head,
      cursor: this.cursor,
      lag: Math.max(0, this.head - this.cursor),
      paused: this.paused,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      rpcCalls: this.rpc.calls,
      chainId: deployment.chainId,
      startBlock: deployment.startBlock,
    };
  }

  // ---- lifecycle ----

  async start() {
    await migrate(this.db);
    await this.loadState();
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
  }

  private async loop() {
    while (this.running) {
      try {
        await this.step();
        await this.onStep(this.cursor);
        this.lastError = null;
      } catch (e) {
        this.lastError = (e as Error).message;
        this.lastErrorAt = new Date().toISOString();
        log('error', 'indexing step failed', { error: this.lastError });
        // In-memory state may be ahead of the database after a failed flush.
        await this.loadState().catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, config.pollMs));
    }
  }

  private async step() {
    this.head = Number(await this.rpc.call<string>('qrl_blockNumber'));
    if (this.diskLow()) return;
    if (Date.now() - this.lastIdentityCheck > config.identityCheckSec * 1000) {
      await this.checkIdentity();
      this.lastIdentityCheck = Date.now();
    }
    await this.retention();
    const target = this.head - config.confirmations;
    if (target <= this.cursor) return;
    if (!(await this.cursorStillCanonical())) {
      log('warn', 'reorg below the confirmation depth: reindexing', { cursor: this.cursor });
      await this.reset();
      return;
    }
    while (this.running && this.cursor < target) {
      const to = Math.min(target, this.cursor + config.logRange);
      await this.runBatch(this.cursor + 1, to);
    }
  }

  private diskLow(): boolean {
    if (!config.diskPath) return false;
    try {
      const s = fs.statfsSync(config.diskPath);
      const freeGb = (s.bavail * s.bsize) / 1e9;
      if (freeGb < config.diskMinFreeGb) {
        if (!this.paused) log('error', 'disk guard: ingest paused', { freeGb, min: config.diskMinFreeGb });
        this.paused = `free disk ${freeGb.toFixed(1)} GB below DISK_MIN_FREE_GB ${config.diskMinFreeGb}`;
        return true;
      }
    } catch (e) {
      log('warn', 'disk guard cannot stat DISK_PATH', { path: config.diskPath, error: (e as Error).message });
    }
    this.paused = null;
    return false;
  }

  freeDiskBytes(): number | null {
    if (!config.diskPath) return null;
    try {
      const s = fs.statfsSync(config.diskPath);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  private async retention() {
    if (Date.now() - this.lastRetention < 3600_000) return;
    this.lastRetention = Date.now();
    const now = Math.floor(Date.now() / 1000);
    if (config.eventDays > 0) await dropPartitionsBefore(this.db, 'pool_events', now - config.eventDays * DAY);
    if (config.hourDataDays > 0) {
      await dropPartitionsBefore(this.db, 'pool_hour', now - config.hourDataDays * DAY);
      await dropPartitionsBefore(this.db, 'token_hour', now - config.hourDataDays * DAY);
    }
  }

  // ---- chain identity, regenesis, reorgs (§10) ----

  private async meta(): Promise<Map<string, string>> {
    const { rows } = await this.db.query('SELECT key, value FROM meta');
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  private async blockHash(n: number): Promise<string | null> {
    const b = await this.rpc.call<{ hash: string } | null>('qrl_getBlockByNumber', [hexNum(n), false]);
    return b ? b.hash.toLowerCase() : null;
  }

  private async checkIdentity() {
    const chainId = Number(await this.rpc.call<string>('qrl_chainId'));
    if (chainId !== deployment.chainId) {
      // A wrong endpoint or tunnel: never wipe for this.
      throw new StopIndexing(`RPC chain id ${chainId} is not devnet.json's ${deployment.chainId}`);
    }
    if (this.head < deployment.startBlock) {
      if (this.cursor >= deployment.startBlock) {
        log('warn', 'regenesis: head below startBlock', { head: this.head });
        await this.reset();
      }
      throw new StopIndexing(`chain head ${this.head} is below startBlock ${deployment.startBlock}`);
    }
    const startHash = await this.blockHash(deployment.startBlock);
    const m = await this.meta();
    if (!m.has('start_block_hash')) {
      await this.db.query(
        `INSERT INTO meta (key, value) VALUES ('chain_id', $1), ('start_block', $2), ('start_block_hash', $3), ('deployed_at', $4), ('v2_factory', $5), ('rules', $6)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(chainId), String(deployment.startBlock), startHash, deployment.deployedAt, this.v2Factory, rulesKey()],
      );
      return;
    }
    const reasons: string[] = [];
    if (m.get('start_block_hash') !== startHash) reasons.push('block hash at startBlock changed');
    if (m.get('deployed_at') !== deployment.deployedAt) reasons.push('devnet.json deployedAt changed');
    if (m.get('v2_factory') !== this.v2Factory) reasons.push('devnet.json factory changed');
    if (this.head < this.cursor) reasons.push(`head ${this.head} below cursor ${this.cursor}`);
    if (m.get('rules') !== rulesKey()) reasons.push('indexing rules or pricing settings changed');
    if (reasons.length) {
      log('warn', 'regenesis or rule change: dropping and rebuilding', { reasons });
      await this.reset();
      await this.checkIdentity();
    }
  }

  private async cursorStillCanonical(): Promise<boolean> {
    if (!this.cursorHash || this.cursor < deployment.startBlock) return true;
    return (await this.blockHash(this.cursor)) === this.cursorHash;
  }

  async reset() {
    await resetSchema(this.db);
    await this.loadState();
    await this.onReset();
  }

  // ---- state load ----

  private async loadState() {
    this.pools.clear();
    this.tokens.clear();
    this.poolBalances.clear();
    this.ids.clear();
    const m = await this.meta();
    this.cursor = m.has('cursor') ? Number(m.get('cursor')) : deployment.startBlock - 1;
    this.cursorHash = m.get('cursor_hash') ?? null;
    const tokens = await this.db.query(
      `SELECT a.address, t.* FROM tokens t JOIN addresses a ON a.id = t.id`,
    );
    for (const r of tokens.rows) {
      const address = (r.address as Buffer).toString('hex');
      this.ids.set(address, r.id);
      this.tokens.set(address, {
        address,
        symbol: r.symbol,
        name: r.name,
        decimals: r.decimals,
        totalSupply: BigInt(r.total_supply),
        derivedQrl: r.derived_qrl,
        derivedUsd: r.derived_usd,
        firstBlock: r.first_block,
        updatedBlock: r.updated_block,
      });
    }
    const pools = await this.db.query(
      `SELECT a.address, a0.address AS t0, a1.address AS t1, p.* FROM pools p
         JOIN addresses a ON a.id = p.id JOIN addresses a0 ON a0.id = p.token0_id JOIN addresses a1 ON a1.id = p.token1_id`,
    );
    for (const r of pools.rows) {
      const address = (r.address as Buffer).toString('hex');
      this.ids.set(address, r.id);
      this.pools.set(address, {
        address,
        version: r.version,
        token0: (r.t0 as Buffer).toString('hex'),
        token1: (r.t1 as Buffer).toString('hex'),
        fee: r.fee,
        tickSpacing: r.tick_spacing,
        createdBlock: r.created_block,
        reserve0: BigInt(r.reserve0),
        reserve1: BigInt(r.reserve1),
        totalSupply: BigInt(r.total_supply),
        sqrtPrice: BigInt(r.sqrt_price),
        tick: r.tick,
        liquidity: BigInt(r.liquidity),
        rawPrice: r.raw_price,
        tvlQrl: r.tvl_qrl,
        tracked: r.tracked,
        volumeQrl: r.volume_qrl,
        untrackedVolumeQrl: r.untracked_volume_qrl,
        feesQrl: r.fees_qrl,
        txCount: r.tx_count,
        updatedBlock: r.updated_block,
      });
    }
    const balances = await this.db.query(
      `SELECT ta.address AS token, pa.address AS pool, b.balance FROM token_balances b
         JOIN pools p ON p.id = b.account_id JOIN addresses pa ON pa.id = p.id JOIN addresses ta ON ta.id = b.token_id`,
    );
    for (const r of balances.rows) {
      this.poolBalances.set(`${(r.token as Buffer).toString('hex')}:${(r.pool as Buffer).toString('hex')}`, BigInt(r.balance));
    }
    const anchor = await this.db.query(`SELECT price FROM qrl_usd WHERE source = 'stable' ORDER BY ts DESC LIMIT 1`);
    this.anchor = anchor.rows[0]?.price ?? null;
  }

  // ---- one batch: [from, to] ----

  private sourceOf(address: string): Source | null {
    if (address === this.v2Factory) return 'v2Factory';
    if (address === this.v3Factory) return 'v3Factory';
    const p = this.pools.get(address);
    if (p) return p.version === 2 ? 'pair' : 'pool';
    if (this.tokens.has(address)) return 'token';
    return null;
  }

  private async runBatch(from: number, to: number) {
    const started = Date.now();
    const calls0 = this.rpc.calls;

    // 1. Factory events first, so pools and tokens created inside the range
    //    are watched for the rest of it.
    const factoryLogs = await getLogs(this.rpc, [this.v2Factory, this.v3Factory], topicsFor(['v2Factory', 'v3Factory']), from, to);
    const created = factoryLogs.map((l) => decode(hex(l.address) === this.v2Factory ? 'v2Factory' : 'v3Factory', l)).filter((d): d is Decoded => !!d);
    const pendingPools = new Map<string, 2 | 3>();
    const pendingTokens = new Map<string, number>();
    if (!this.tokens.has(this.wqrl)) pendingTokens.set(this.wqrl, from);
    for (const c of created) {
      pendingPools.set(hex(c.name === 'PairCreated' ? c.args.pair : c.args.pool), c.name === 'PairCreated' ? 2 : 3);
      for (const t of [hex(c.args.token0), hex(c.args.token1)]) if (!this.tokens.has(t) && !pendingTokens.has(t)) pendingTokens.set(t, c.block);
    }

    // 2. A token joining now may have history before `from`: its balances are
    //    only right with its full Transfer history (§3.3).
    const newTokenList = [...pendingTokens.keys()];
    const meta = newTokenList.length ? await tokenMetadata(this.rpc, newTokenList) : [];
    const backfill = newTokenList.length && from > 1 ? await getLogs(this.rpc, newTokenList, topicsFor(['token']), 1, from - 1) : [];

    // 3. Everything else the watched set emitted in the range.
    const watched = [...this.pools.keys(), ...pendingPools.keys(), ...this.tokens.keys(), ...newTokenList];
    const mainLogs = await getLogs(this.rpc, [...new Set(watched)], topicsFor(['pair', 'pool', 'token']), from, to);

    // Register now so sourceOf() dispatches the new addresses.
    const batch: Batch = {
      newTokens: new Set(),
      newPools: new Set(),
      dirtyTokens: new Set(),
      dirtyPools: new Set(),
      deltas: new Map(),
      events: [],
      txs: new Map(),
      blocks: new Map(),
      poolHour: new Map(),
      poolDay: new Map(),
      tokenHour: new Map(),
      tokenDay: new Map(),
      anchors: [],
    };
    newTokenList.forEach((address, i) => {
      this.tokens.set(address, { address, ...meta[i], totalSupply: 0n, derivedQrl: null, derivedUsd: null, firstBlock: pendingTokens.get(address)!, updatedBlock: from });
      batch.newTokens.add(address);
      batch.dirtyTokens.add(address);
    });

    const decodeAll = (logs: RawLog[]) =>
      logs.flatMap((l) => {
        const address = hex(l.address);
        const source = this.sourceOf(address) ?? (pendingPools.has(address) ? (pendingPools.get(address) === 2 ? 'pair' : 'pool') : null);
        if (!source) return [];
        try {
          const d = decode(source, l);
          // A pair is also an SQRC20 (its LP token); a Transfer from it decodes as `pair`.
          return d ? [d] : [];
        } catch (e) {
          log('warn', 'undecodable log skipped', { address, block: Number(l.blockNumber), error: (e as Error).message });
          return [];
        }
      });
    const backfillDecoded = decodeAll(backfill);
    const stream = [...created, ...decodeAll(mainLogs)].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

    // 4. Headers for blocks with pool events (timestamps) and the cursor block;
    //    senders for transactions with pool events.
    const POOL_EVENTS = new Set(['Sync', 'Swap', 'Mint', 'Burn', 'Initialize']);
    const poolish = stream.filter((d) => (d.source === 'pair' || d.source === 'pool') && POOL_EVENTS.has(d.name));
    const blockNumbers = [...new Set([...poolish.map((d) => d.block), to])];
    const headers = await this.rpc.batchStrict<{ hash: string; timestamp: string } | null>(blockNumbers.map((n) => ({ method: 'qrl_getBlockByNumber', params: [hexNum(n), false] })));
    headers.forEach((h, i) => {
      if (!h) throw new Error(`block ${blockNumbers[i]} not found`);
      batch.blocks.set(blockNumbers[i], { hash: h.hash.toLowerCase(), ts: Number(h.timestamp) });
    });
    const txHashes = [...new Set(poolish.filter((d) => d.name !== 'Initialize').map((d) => d.txHash))];
    const txs = await this.rpc.batch<{ from?: string } | null>(txHashes.map((h) => ({ method: 'qrl_getTransactionByHash', params: [h] })));
    txHashes.forEach((h, i) => {
      const t = txs[i];
      const from = t && !(t instanceof Error) && t.from ? hex(t.from) : null;
      batch.txs.set(h, { block: 0, from });
    });

    // 5. Apply: backfill first (all before `from`), then the range block by block.
    for (const d of backfillDecoded) this.applyToken(batch, d);
    let i = 0;
    while (i < stream.length) {
      const block = stream[i].block;
      const inBlock: Decoded[] = [];
      while (i < stream.length && stream[i].block === block) inBlock.push(stream[i++]);
      this.applyBlock(batch, block, inBlock, pendingPools);
    }

    // 6. Flush.
    await this.flush(batch, to);
    log('info', 'batch', {
      from,
      to,
      logs: mainLogs.length + factoryLogs.length,
      backfill: backfill.length,
      events: batch.events.length,
      newPools: batch.newPools.size,
      newTokens: batch.newTokens.size,
      rpcCalls: this.rpc.calls - calls0,
      ms: Date.now() - started,
    });
  }

  // ---- handlers (§8) ----

  private addDelta(batch: Batch, token: string, account: string, delta: bigint) {
    if (account === ZERO || delta === 0n) return;
    let m = batch.deltas.get(token);
    if (!m) batch.deltas.set(token, (m = new Map()));
    m.set(account, (m.get(account) ?? 0n) + delta);
    if (this.pools.has(account)) {
      const key = `${token}:${account}`;
      this.poolBalances.set(key, (this.poolBalances.get(key) ?? 0n) + delta);
    }
  }

  /// Transfer / Deposit / Withdrawal of a token or of a pair's LP token.
  private applyToken(batch: Batch, d: Decoded) {
    const token = d.address;
    let supply = 0n;
    if (d.name === 'Transfer') {
      const a = d.args;
      const from = hex(a.from ?? a.src ?? a[0]);
      const to = hex(a.to ?? a.dst ?? a[1]);
      const value = BigInt(a.value ?? a.wad ?? a[2]);
      this.addDelta(batch, token, from, -value);
      this.addDelta(batch, token, to, value);
      // A V2 pair locks MINIMUM_LIQUIDITY with Transfer(0, 0, 1000): a mint.
      if (from === ZERO) supply += value;
      else if (to === ZERO) supply -= value;
    } else if (d.name === 'Deposit') {
      // WQRL: deposit() emits Deposit only, no Transfer (WETH9 style).
      this.addDelta(batch, token, hex(d.args.dst), BigInt(d.args.wad));
      supply += BigInt(d.args.wad);
    } else if (d.name === 'Withdrawal') {
      this.addDelta(batch, token, hex(d.args.src), -BigInt(d.args.wad));
      supply -= BigInt(d.args.wad);
    } else return;
    const t = this.tokens.get(token);
    if (t && supply !== 0n) {
      t.totalSupply += supply;
      t.updatedBlock = d.block;
      batch.dirtyTokens.add(token);
    }
    const p = this.pools.get(token);
    if (p && p.version === 2 && supply !== 0n) {
      p.totalSupply += supply;
      p.updatedBlock = d.block;
      batch.dirtyPools.add(token);
    }
  }

  private applyBlock(batch: Batch, block: number, logs: Decoded[], pendingPools: Map<string, 2 | 3>) {
    const ts = batch.blocks.get(block)?.ts ?? 0;
    const events: EventRow[] = [];
    const syncs: { pool: string; txHash: string; logIndex: number; price: number | null }[] = [];
    const touched = new Set<string>();

    for (const d of logs) {
      const a = d.args;
      if (d.source === 'v2Factory' || d.source === 'v3Factory') {
        const v2 = d.name === 'PairCreated';
        const address = hex(v2 ? a.pair : a.pool);
        if (this.pools.has(address)) continue;
        this.pools.set(address, {
          address,
          version: v2 ? 2 : 3,
          token0: hex(a.token0),
          token1: hex(a.token1),
          fee: v2 ? V2_FEE : Number(a.fee),
          tickSpacing: v2 ? 0 : Number(a.tickSpacing),
          createdBlock: d.block,
          reserve0: 0n,
          reserve1: 0n,
          totalSupply: 0n,
          sqrtPrice: 0n,
          tick: null,
          liquidity: 0n,
          rawPrice: null,
          tvlQrl: null,
          tracked: false,
          volumeQrl: 0,
          untrackedVolumeQrl: 0,
          feesQrl: 0,
          txCount: 0,
          updatedBlock: d.block,
        });
        pendingPools.delete(address);
        batch.newPools.add(address);
        batch.dirtyPools.add(address);
        continue;
      }
      if (d.source === 'token' || d.name === 'Transfer') {
        this.applyToken(batch, d);
        continue;
      }
      const p = this.pools.get(d.address);
      if (!p) continue;
      const base = { ts, block, logIndex: d.logIndex, pool: p.address, txHash: d.txHash, rawPrice: null, amountQrl: null };
      if (d.source === 'pair') {
        if (d.name === 'Sync') {
          p.reserve0 = BigInt(a.reserve0);
          p.reserve1 = BigInt(a.reserve1);
          syncs.push({ pool: p.address, txHash: d.txHash, logIndex: d.logIndex, price: p.reserve0 > 0n ? Number(p.reserve1) / Number(p.reserve0) : null });
        } else if (d.name === 'Swap') {
          events.push({ ...base, kind: 0, account: hex(a.to), amount0: BigInt(a.amount0In) - BigInt(a.amount0Out), amount1: BigInt(a.amount1In) - BigInt(a.amount1Out) });
        } else if (d.name === 'Mint') {
          events.push({ ...base, kind: 1, account: null, amount0: BigInt(a.amount0), amount1: BigInt(a.amount1) });
        } else if (d.name === 'Burn') {
          events.push({ ...base, kind: 2, account: hex(a.to), amount0: -BigInt(a.amount0), amount1: -BigInt(a.amount1) });
        }
      } else {
        if (d.name === 'Initialize') {
          p.sqrtPrice = BigInt(a.sqrtPriceX96);
          p.tick = Number(a.tick);
        } else if (d.name === 'Swap') {
          p.sqrtPrice = BigInt(a.sqrtPriceX96);
          p.tick = Number(a.tick);
          p.liquidity = BigInt(a.liquidity);
          events.push({ ...base, kind: 0, account: hex(a.recipient), amount0: BigInt(a.amount0), amount1: BigInt(a.amount1), rawPrice: rawPrice(p) });
        } else if (d.name === 'Mint' || d.name === 'Burn') {
          const sign = d.name === 'Mint' ? 1n : -1n;
          const lower = Number(a.tickLower);
          const upper = Number(a.tickUpper);
          // Upstream v3 subgraph rule: active liquidity moves only in range.
          if (p.tick !== null && lower <= p.tick && p.tick < upper) p.liquidity += sign * BigInt(a.amount);
          const a0 = BigInt(a.amount0);
          const a1 = BigInt(a.amount1);
          // The position manager pokes with a zero Burn before collecting fees.
          if (!(d.name === 'Burn' && a0 === 0n && a1 === 0n)) events.push({ ...base, kind: d.name === 'Mint' ? 1 : 2, account: null, amount0: sign * a0, amount1: sign * a1 });
        }
      }
      p.updatedBlock = block;
      touched.add(p.address);
      batch.dirtyPools.add(p.address);
    }

    // V2: a Sync prices the Swap / Mint / Burn of the same transaction (the
    // last Sync of the tx wins); a Sync with nothing else in its tx is kept
    // as a price-only row. Same as decodeV2 in the interface's history.ts.
    const lastSync = new Map<string, number | null>();
    for (const s of syncs) lastSync.set(`${s.txHash}:${s.pool}`, s.price);
    const covered = new Set<string>();
    for (const e of events) {
      if (this.pools.get(e.pool)!.version !== 2) continue;
      const key = `${e.txHash}:${e.pool}`;
      if (lastSync.has(key)) {
        e.rawPrice = lastSync.get(key)!;
        covered.add(key);
      }
    }
    for (const s of syncs) {
      if (covered.has(`${s.txHash}:${s.pool}`)) continue;
      events.push({ ts, block, logIndex: s.logIndex, pool: s.pool, kind: 3, txHash: s.txHash, account: null, amount0: 0n, amount1: 0n, rawPrice: s.price, amountQrl: null });
    }
    events.sort((x, y) => x.logIndex - y.logIndex);

    // Pool state that depends on token balances, then prices after the block.
    for (const address of touched) {
      const p = this.pools.get(address)!;
      if (p.version === 3) {
        p.reserve0 = this.poolBalances.get(`${p.token0}:${address}`) ?? 0n;
        p.reserve1 = this.poolBalances.get(`${p.token1}:${address}`) ?? 0n;
      }
      p.rawPrice = rawPrice(p);
    }
    // V3 reserves also move on plain transfers (Collect, Flash), not only on
    // pool events.
    for (const p of this.pools.values()) {
      if (p.version !== 3 || touched.has(p.address)) continue;
      const r0 = this.poolBalances.get(`${p.token0}:${p.address}`) ?? 0n;
      const r1 = this.poolBalances.get(`${p.token1}:${p.address}`) ?? 0n;
      if (r0 === p.reserve0 && r1 === p.reserve1) continue;
      p.reserve0 = r0;
      p.reserve1 = r1;
      batch.dirtyPools.add(p.address);
    }
    if (!touched.size) return;

    const decimalsOf = (t: string) => this.tokens.get(t)?.decimals ?? null;
    const pools = [...this.pools.values()];
    const prices = qrlPrices(pools, this.wqrl, decimalsOf, config.minQrlLiquidity, this.bridges);
    const stable = config.usdSource === 'stable';
    const usdOf = (token: string) => (stable ? stablePrice(pools, token, config.stableTokens, decimalsOf, config.minUsdLiquidity) : null);
    for (const t of this.tokens.values()) {
      const next = prices.get(t.address) ?? null;
      const usd = t.address === this.wqrl ? null : usdOf(t.address);
      if (next === t.derivedQrl && usd === t.derivedUsd) continue;
      t.derivedUsd = usd;
      t.updatedBlock = block;
      batch.dirtyTokens.add(t.address);
      if (next === t.derivedQrl) continue;
      t.derivedQrl = next;
      if (next !== null && ts) {
        this.rollToken(batch.tokenHour, t.address, Math.floor(ts / HOUR) * HOUR, next);
        this.rollToken(batch.tokenDay, t.address, Math.floor(ts / DAY) * DAY, next);
      }
    }
    if (stable && ts) {
      const anchor = usdOf(this.wqrl);
      if (anchor !== this.anchor) {
        this.anchor = anchor;
        batch.anchors.push({ ts, price: anchor });
      }
    }
    // TVL and tracked status move with prices, so every pool is revalued, not
    // only the ones this block touched.
    for (const p of pools) {
      const [x, y] = sidesQrl(p, prices, decimalsOf);
      const tvl = x === null || y === null ? null : x + y;
      const tracked = isTracked(p, prices, decimalsOf, config.minQrlLiquidity);
      if (tvl === p.tvlQrl && tracked === p.tracked) continue;
      p.tvlQrl = tvl;
      p.tracked = tracked;
      batch.dirtyPools.add(p.address);
    }

    const value = (token: string, amount: bigint) => {
      const price = prices.get(token);
      const dec = decimalsOf(token);
      return price === undefined || dec === null ? null : toFloat(amount < 0n ? -amount : amount, dec) * price;
    };
    for (const e of events) {
      const p = this.pools.get(e.pool)!;
      if (e.kind === 0) e.amountQrl = e.amount0 > 0n ? value(p.token0, e.amount0) : e.amount1 > 0n ? value(p.token1, e.amount1) : null;
      else if (e.kind !== 3) {
        const x = value(p.token0, e.amount0);
        const y = value(p.token1, e.amount1);
        e.amountQrl = x === null || y === null ? null : x + y;
      }
    }
    for (const address of touched) {
      const p = this.pools.get(address)!;
      const mine = events.filter((e) => e.pool === address);
      const swaps = mine.filter((e) => e.kind === 0);
      const traded = swaps.reduce((s, e) => s + (e.amountQrl ?? 0), 0);
      // Upstream subgraph rule: only tracked volume counts, and fees follow it.
      const volumeQrl = p.tracked ? traded : 0;
      const untrackedVolumeQrl = p.tracked ? 0 : traded;
      const feesQrl = (volumeQrl * p.fee) / 1_000_000;
      p.volumeQrl += volumeQrl;
      p.untrackedVolumeQrl += untrackedVolumeQrl;
      p.feesQrl += feesQrl;
      p.txCount += mine.filter((e) => e.kind !== 3).length;
      if (!ts) continue;
      const roll = {
        volume0: swaps.reduce((s, e) => s + (e.amount0 < 0n ? -e.amount0 : e.amount0), 0n),
        volume1: swaps.reduce((s, e) => s + (e.amount1 < 0n ? -e.amount1 : e.amount1), 0n),
        volumeQrl,
        untrackedVolumeQrl,
        feesQrl,
        swaps: swaps.length,
      };
      this.rollPool(batch.poolHour, p, Math.floor(ts / HOUR) * HOUR, roll);
      this.rollPool(batch.poolDay, p, Math.floor(ts / DAY) * DAY, roll);
    }
    for (const e of events) {
      if (batch.txs.has(e.txHash)) batch.txs.get(e.txHash)!.block = block;
      else batch.txs.set(e.txHash, { block, from: null });
    }
    batch.events.push(...events);
  }

  private rollPool(
    map: Map<string, PoolPeriod>,
    p: PoolState,
    period: number,
    x: { volume0: bigint; volume1: bigint; volumeQrl: number; untrackedVolumeQrl: number; feesQrl: number; swaps: number },
  ) {
    const key = `${p.address}:${period}`;
    let r = map.get(key);
    if (!r) {
      r = { pool: p.address, period, volume0: 0n, volume1: 0n, volumeQrl: 0, untrackedVolumeQrl: 0, feesQrl: 0, swaps: 0, open: p.rawPrice, high: p.rawPrice, low: p.rawPrice, close: p.rawPrice, reserve0: 0n, reserve1: 0n, totalSupply: 0n, tvlQrl: null };
      map.set(key, r);
    }
    r.volume0 += x.volume0;
    r.volume1 += x.volume1;
    r.volumeQrl += x.volumeQrl;
    r.untrackedVolumeQrl += x.untrackedVolumeQrl;
    r.feesQrl += x.feesQrl;
    r.swaps += x.swaps;
    if (p.rawPrice !== null) {
      r.open ??= p.rawPrice;
      r.high = r.high === null ? p.rawPrice : Math.max(r.high, p.rawPrice);
      r.low = r.low === null ? p.rawPrice : Math.min(r.low, p.rawPrice);
      r.close = p.rawPrice;
    }
    r.reserve0 = p.reserve0;
    r.reserve1 = p.reserve1;
    r.totalSupply = p.totalSupply;
    r.tvlQrl = p.tvlQrl;
  }

  private rollToken(map: Map<string, TokenPeriod>, token: string, period: number, price: number) {
    const key = `${token}:${period}`;
    const r = map.get(key);
    if (!r) map.set(key, { token, period, open: price, high: price, low: price, close: price });
    else {
      r.high = Math.max(r.high, price);
      r.low = Math.min(r.low, price);
      r.close = price;
    }
  }

  // ---- flush ----

  private async resolveIds(client: pg.PoolClient, addresses: Iterable<string>) {
    const missing = [...new Set(addresses)].filter((a) => !this.ids.has(a));
    for (let i = 0; i < missing.length; i += 5000) {
      const chunk = missing.slice(i, i + 5000);
      const { rows } = await client.query(
        `WITH input AS (SELECT unnest($1::bytea[]) AS address),
              ins AS (INSERT INTO addresses (address) SELECT address FROM input ON CONFLICT (address) DO NOTHING RETURNING id, address)
         SELECT id, address FROM ins UNION ALL SELECT a.id, a.address FROM addresses a JOIN input USING (address)`,
        [chunk.map((a) => Buffer.from(a, 'hex'))],
      );
      for (const r of rows) this.ids.set((r.address as Buffer).toString('hex'), r.id);
    }
    // Keeps the cache bounded on long runs; ids are re-read on demand.
    if (this.ids.size > 200_000) {
      const keep = new Set([...this.pools.keys(), ...this.tokens.keys()]);
      for (const k of this.ids.keys()) if (!keep.has(k)) this.ids.delete(k);
      await this.resolveIds(client, addresses);
    }
  }

  private async flush(batch: Batch, to: number) {
    const id = (a: string) => {
      const v = this.ids.get(a);
      if (v === undefined) throw new Error(`no id for ${a}`);
      return v;
    };
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const accounts: string[] = [];
      for (const [token, m] of batch.deltas) accounts.push(token, ...m.keys());
      for (const e of batch.events) if (e.account) accounts.push(e.account);
      for (const t of batch.txs.values()) if (t.from) accounts.push(t.from);
      await this.resolveIds(client, [...batch.newTokens, ...batch.newPools, ...batch.dirtyPools, ...batch.dirtyTokens, ...accounts, ...[...this.pools.values()].flatMap((p) => [p.token0, p.token1])]);

      for (const address of batch.dirtyTokens) {
        const t = this.tokens.get(address)!;
        await client.query(
          `INSERT INTO tokens (id, symbol, name, decimals, total_supply, derived_qrl, derived_usd, first_block, updated_block) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET total_supply = EXCLUDED.total_supply, derived_qrl = EXCLUDED.derived_qrl, derived_usd = EXCLUDED.derived_usd,
             updated_block = EXCLUDED.updated_block`,
          [id(address), t.symbol, t.name, t.decimals, t.totalSupply.toString(), t.derivedQrl, t.derivedUsd, t.firstBlock, t.updatedBlock],
        );
      }
      for (const address of batch.dirtyPools) {
        const p = this.pools.get(address)!;
        await client.query(
          `INSERT INTO pools (id, version, token0_id, token1_id, fee, tick_spacing, created_block, reserve0, reserve1, total_supply, sqrt_price, tick, liquidity, raw_price,
             tvl_qrl, tracked, volume_qrl, untracked_volume_qrl, fees_qrl, tx_count, updated_block)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
           ON CONFLICT (id) DO UPDATE SET reserve0 = EXCLUDED.reserve0, reserve1 = EXCLUDED.reserve1, total_supply = EXCLUDED.total_supply,
             sqrt_price = EXCLUDED.sqrt_price, tick = EXCLUDED.tick, liquidity = EXCLUDED.liquidity, raw_price = EXCLUDED.raw_price,
             tvl_qrl = EXCLUDED.tvl_qrl, tracked = EXCLUDED.tracked, volume_qrl = EXCLUDED.volume_qrl, untracked_volume_qrl = EXCLUDED.untracked_volume_qrl,
             fees_qrl = EXCLUDED.fees_qrl, tx_count = EXCLUDED.tx_count, updated_block = EXCLUDED.updated_block`,
          [
            id(address), p.version, id(p.token0), id(p.token1), p.fee, p.tickSpacing, p.createdBlock, p.reserve0.toString(), p.reserve1.toString(),
            p.totalSupply.toString(), p.sqrtPrice.toString(), p.tick, p.liquidity.toString(), p.rawPrice, p.tvlQrl, p.tracked, p.volumeQrl,
            p.untrackedVolumeQrl, p.feesQrl, p.txCount, p.updatedBlock,
          ],
        );
      }

      const holderTokens: number[] = [];
      for (const [token, m] of batch.deltas) {
        const entries = [...m].filter(([, v]) => v !== 0n);
        if (!entries.length) continue;
        const tokenId = id(token);
        await client.query(
          `INSERT INTO token_balances AS b (token_id, account_id, balance)
           SELECT $1, unnest($2::int4[]), unnest($3::numeric[])
           ON CONFLICT (token_id, account_id) DO UPDATE SET balance = b.balance + EXCLUDED.balance`,
          [tokenId, entries.map(([a]) => id(a)), entries.map(([, v]) => v.toString())],
        );
        await client.query('DELETE FROM token_balances WHERE token_id = $1 AND account_id = ANY($2::int4[]) AND balance = 0', [tokenId, entries.map(([a]) => id(a))]);
        if (this.tokens.has(token)) holderTokens.push(tokenId);
      }
      if (holderTokens.length) {
        await client.query(
          `UPDATE tokens t SET holder_count = (SELECT count(*) FROM token_balances b WHERE b.token_id = t.id AND b.balance > 0) WHERE t.id = ANY($1::int4[])`,
          [holderTokens],
        );
      }

      const blocks = [...batch.blocks];
      if (blocks.length) {
        await client.query(
          `INSERT INTO blocks (number, hash, timestamp) SELECT unnest($1::int4[]), unnest($2::bytea[]), unnest($3::int4[]) ON CONFLICT (number) DO NOTHING`,
          [blocks.map(([n]) => n), blocks.map(([, b]) => Buffer.from(b.hash.slice(2), 'hex')), blocks.map(([, b]) => b.ts)],
        );
      }

      const txIds = new Map<string, string>();
      const txList = [...batch.txs].filter(([, t]) => t.block > 0);
      if (txList.length) {
        const { rows } = await client.query(
          `INSERT INTO transactions (hash, block_number, from_id)
           SELECT unnest($1::bytea[]), unnest($2::int4[]), unnest($3::int4[])
           ON CONFLICT (hash) DO UPDATE SET block_number = EXCLUDED.block_number RETURNING id, hash`,
          [txList.map(([h]) => Buffer.from(h.slice(2), 'hex')), txList.map(([, t]) => t.block), txList.map(([, t]) => (t.from ? id(t.from) : null))],
        );
        for (const r of rows) txIds.set('0x' + (r.hash as Buffer).toString('hex'), r.id);
      }

      if (batch.events.length) {
        for (const ts of new Set(batch.events.map((e) => e.ts))) await ensurePartition(client, 'pool_events', ts);
        const E = batch.events;
        await client.query(
          `INSERT INTO pool_events (ts, block_number, log_index, pool_id, kind, tx_id, account_id, amount0, amount1, raw_price, amount_qrl)
           SELECT * FROM unnest($1::int4[], $2::int4[], $3::int4[], $4::int4[], $5::int2[], $6::int8[], $7::int4[], $8::numeric[], $9::numeric[], $10::float8[], $11::float8[])
           ON CONFLICT DO NOTHING`,
          [
            E.map((e) => e.ts), E.map((e) => e.block), E.map((e) => e.logIndex), E.map((e) => id(e.pool)), E.map((e) => e.kind),
            E.map((e) => txIds.get(e.txHash)), E.map((e) => (e.account ? id(e.account) : null)), E.map((e) => e.amount0.toString()),
            E.map((e) => e.amount1.toString()), E.map((e) => e.rawPrice), E.map((e) => e.amountQrl),
          ],
        );
      }

      for (const [table, map] of [['pool_hour', batch.poolHour], ['pool_day', batch.poolDay]] as const) {
        for (const r of map.values()) {
          if (table === 'pool_hour') await ensurePartition(client, 'pool_hour', r.period);
          await client.query(
            `INSERT INTO ${table} AS t (pool_id, period, volume0, volume1, volume_qrl, untracked_volume_qrl, fees_qrl, swaps, open, high, low, close, reserve0, reserve1, total_supply, tvl_qrl)
             VALUES ($1, $2, $3, $4, $5, $16, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (pool_id, period) DO UPDATE SET
               volume0 = t.volume0 + EXCLUDED.volume0, volume1 = t.volume1 + EXCLUDED.volume1,
               volume_qrl = coalesce(t.volume_qrl, 0) + coalesce(EXCLUDED.volume_qrl, 0), fees_qrl = coalesce(t.fees_qrl, 0) + coalesce(EXCLUDED.fees_qrl, 0),
               untracked_volume_qrl = coalesce(t.untracked_volume_qrl, 0) + coalesce(EXCLUDED.untracked_volume_qrl, 0),
               swaps = t.swaps + EXCLUDED.swaps, open = coalesce(t.open, EXCLUDED.open), high = greatest(t.high, EXCLUDED.high), low = least(t.low, EXCLUDED.low),
               close = coalesce(EXCLUDED.close, t.close), reserve0 = EXCLUDED.reserve0, reserve1 = EXCLUDED.reserve1, total_supply = EXCLUDED.total_supply, tvl_qrl = EXCLUDED.tvl_qrl`,
            [id(r.pool), r.period, r.volume0.toString(), r.volume1.toString(), r.volumeQrl, r.feesQrl, r.swaps, r.open, r.high, r.low, r.close, r.reserve0.toString(), r.reserve1.toString(), r.totalSupply.toString(), r.tvlQrl, r.untrackedVolumeQrl],
          );
        }
      }
      for (const [table, map] of [['token_hour', batch.tokenHour], ['token_day', batch.tokenDay]] as const) {
        for (const r of map.values()) {
          if (table === 'token_hour') await ensurePartition(client, 'token_hour', r.period);
          await client.query(
            `INSERT INTO ${table} AS t (token_id, period, open, high, low, close) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (token_id, period) DO UPDATE SET high = greatest(t.high, EXCLUDED.high), low = least(t.low, EXCLUDED.low), close = EXCLUDED.close`,
            [id(r.token), r.period, r.open, r.high, r.low, r.close],
          );
        }
      }

      for (const a of batch.anchors) {
        await client.query(
          `INSERT INTO qrl_usd (source, ts, price) VALUES ('stable', $1, $2) ON CONFLICT (source, ts) DO UPDATE SET price = EXCLUDED.price`,
          [a.ts, a.price],
        );
      }

      // The previous cursor block was kept only for its hash; drop it unless
      // events point at it, so `blocks` grows with events, not with the chain.
      await client.query(
        'DELETE FROM blocks b WHERE b.number = $1 AND NOT EXISTS (SELECT 1 FROM pool_events e WHERE e.block_number = b.number)',
        [this.cursor],
      );
      const cursorHash = batch.blocks.get(to)!.hash;
      await client.query(
        `INSERT INTO meta (key, value) VALUES ('cursor', $1), ('cursor_hash', $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(to), cursorHash],
      );
      await client.query('COMMIT');
      this.cursor = to;
      this.cursorHash = cursorHash;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

export { StopIndexing };
