import http from 'node:http';
import { buildSchema, graphql, GraphQLError } from 'graphql';
import pg from 'pg';
import { checksum, toBytes } from './address.js';
import { config } from './config.js';
import { Indexer } from './indexer.js';
import { log } from './log.js';
import { PredictIndexer } from './predict.js';
import { QUESTS, Quests } from './quests.js';
import { Usd, UsdView } from './usd.js';

/// Read only, flat (no nested entities, so no N+1), served from entity tables
/// (docs/INDEXER.md §11). Addresses render `Q` + lowercase hex, hashes `0x…`,
/// big integers as strings.
const schema = buildSchema(`
  enum EventKind { SWAP ADD REMOVE SYNC }
  enum OrderDirection { asc desc }

  type Meta {
    "Last block fully indexed (head minus the confirmation depth)."
    block: Int!
    hash: String
    timestamp: Int
    "Chain head as last seen by the indexer."
    head: Int!
    chainId: Int!
    startBlock: Int!
    hasIndexingErrors: Boolean!
    lastError: String
    "Where USD values come from: none (every USD field is null), stable or feed."
    usdSource: String!
    "QRL/USD now, as the USD fields use it; null when USD is unavailable or hidden."
    qrlPriceUSD: Float
    "The off-chain feed's QRL/USD (the source with feed, a check with stable)."
    feedPriceUSD: Float
    "stable with a feed: relative difference between the two."
    usdDeviation: Float
    "true while usdDeviation exceeds USD_MAX_DEVIATION; USD fields are null meanwhile."
    usdHidden: Boolean!
  }

  type Token {
    id: ID!
    symbol: String
    name: String
    decimals: Int
    totalSupply: String!
    holderCount: Int!
    derivedQRL: Float
    derivedUSD: Float
    firstBlock: Int!
    updatedBlock: Int!
  }

  type Pool {
    id: ID!
    "2 for V2 pairs, 3 for V3 pools."
    version: Int!
    token0: String!
    token1: String!
    fee: Int!
    tickSpacing: Int!
    createdBlock: Int!
    "V2: pair reserves from Sync. V3: the pool's token balances, derived from Transfer."
    reserve0: String!
    reserve1: String!
    "V2 LP token supply; 0 for V3."
    totalSupply: String!
    sqrtPriceX96: String!
    tick: Int
    liquidity: String!
    "Raw (decimals-free) price of token0 in token1."
    rawPrice: Float
    tvlQRL: Float
    tvlUSD: Float
    "Both tokens priced and both sides at least MIN_QRL_LIQUIDITY deep."
    tracked: Boolean!
    "Volume while the pool was tracked; fees follow it."
    volumeQRL: Float!
    volumeUSD: Float
    "Volume while the pool was not tracked, valued with whatever price there was."
    untrackedVolumeQRL: Float!
    untrackedVolumeUSD: Float
    feesQRL: Float!
    feesUSD: Float
    txCount: Int!
    updatedBlock: Int!
  }

  "Totals over all pools; TVL counts tracked pools only, volume and fees are tracked."
  type Protocol {
    poolCount: Int!
    trackedPoolCount: Int!
    txCount: Int!
    tvlQRL: Float!
    tvlUSD: Float
    volumeQRL: Float!
    volumeUSD: Float
    untrackedVolumeQRL: Float!
    untrackedVolumeUSD: Float
    feesQRL: Float!
    feesUSD: Float
  }

  type PoolEvent {
    "txHash#logIndex, as the upstream subgraphs."
    id: ID!
    pool: String!
    kind: EventKind!
    block: Int!
    logIndex: Int!
    timestamp: Int!
    txHash: String!
    "Signer of the transaction."
    origin: String
    "Recipient named by the event (V2 Swap/Burn to, V3 Swap recipient)."
    account: String
    "Token flows from the pool's point of view: positive means into the pool."
    amount0: String!
    amount1: String!
    rawPrice: Float
    amountQRL: Float
    "amountQRL at QRL/USD of the event's time."
    amountUSD: Float
  }

  "USD fields use QRL/USD at the end of the period (or now, for the current one)."
  type PoolPeriod {
    pool: String!
    period: Int!
    volume0: String!
    volume1: String!
    volumeQRL: Float
    volumeUSD: Float
    untrackedVolumeQRL: Float
    untrackedVolumeUSD: Float
    feesQRL: Float
    feesUSD: Float
    swaps: Int!
    open: Float
    high: Float
    low: Float
    close: Float
    reserve0: String!
    reserve1: String!
    totalSupply: String!
    tvlQRL: Float
    tvlUSD: Float
  }

  "Price in QRL; the USD candle is the QRL candle at QRL/USD of the period's end."
  type TokenPeriod {
    token: String!
    period: Int!
    open: Float!
    high: Float!
    low: Float!
    close: Float!
    openUSD: Float
    highUSD: Float
    lowUSD: Float
    closeUSD: Float
  }

  type Holder {
    account: String!
    balance: String!
  }

  type Transaction {
    hash: String!
    block: Int!
    from: String
  }

  "A quest of the catalogue (quests/catalog.json in pauli-swap-prediction-market). Hidden quests have null text until credited."
  type Quest {
    id: Int!
    "daily (resets 00:00 UTC) or season (once per season)."
    kind: String!
    hidden: Boolean!
    title: String
    detail: String
    "Whole XP."
    xp: Int
    "Where the interface sends the player: checkin, swap, predict, pool or faucet."
    action: String
    target: Int
  }

  type QuestProgress {
    id: Int!
    kind: String!
    hidden: Boolean!
    title: String
    detail: String
    xp: Int
    action: String
    target: Int
    progress: Int
    "The rule is met (for daily quests, on the requested day)."
    met: Boolean!
    "A QuestCompleted exists: that day for daily quests, this season for season quests."
    credited: Boolean!
  }

  type QuestCredit {
    user: String!
    questId: Int!
    day: Int!
    xp: Int!
    kind: String!
  }

  type QuestState {
    "UTC day (unix time / 86400) the progress is for."
    day: Int!
    season: Int
    seasonEndsAt: Int
    "Last block the Predict module has indexed."
    block: Int!
    quests: [QuestProgress!]!
  }

  "createdBlock sorts ascending by default, the rest descending; tvlQRL ranks tracked pools first."
  enum PoolOrderBy { createdBlock tvlQRL volumeQRL txCount }

  type Query {
    _meta: Meta!
    protocol: Protocol!
    tokens(ids: [ID!], first: Int = 100, skip: Int = 0): [Token!]!
    token(id: ID!): Token
    pools(ids: [ID!], token: ID, version: Int, orderBy: PoolOrderBy = createdBlock, orderDirection: OrderDirection, first: Int = 100, skip: Int = 0): [Pool!]!
    pool(id: ID!): Pool
    poolEvents(
      pools: [ID!]
      kinds: [EventKind!]
      fromBlock: Int
      toBlock: Int
      fromTime: Int
      first: Int = 100
      skip: Int = 0
      orderDirection: OrderDirection = desc
    ): [PoolEvent!]!
    poolHourDatas(pool: ID!, from: Int, to: Int, first: Int = 1000): [PoolPeriod!]!
    poolDayDatas(pool: ID!, from: Int, to: Int, first: Int = 1000): [PoolPeriod!]!
    tokenHourDatas(token: ID!, from: Int, to: Int, first: Int = 1000): [TokenPeriod!]!
    tokenDayDatas(token: ID!, from: Int, to: Int, first: Int = 1000): [TokenPeriod!]!
    tokenHolders(token: ID!, first: Int = 100, skip: Int = 0): [Holder!]!
    transaction(hash: String!): Transaction
    quests: [Quest!]!
    "day defaults to today (UTC)."
    questProgress(user: ID!, day: Int): QuestState!
    "Met but not yet credited quests for day (default today); what the attester sends."
    questQueue(day: Int): [QuestCredit!]!
  }
`);

const KINDS = ['SWAP', 'ADD', 'REMOVE', 'SYNC'];
const MAX_FIRST = 1000;

const addr = (sql: string) => `'Q' || encode(${sql}, 'hex')`;
const bytesOf = (ids?: string[] | null) => {
  if (!ids) return null;
  try {
    return ids.map(toBytes);
  } catch (e) {
    throw new GraphQLError((e as Error).message);
  }
};
const page = (first: number, skip: number) => {
  if (first < 0 || skip < 0) throw new GraphQLError('first and skip must be >= 0');
  return [Math.min(first, MAX_FIRST), skip];
};

/// USD is computed when read (docs/INDEXER.md §9): `qrl` (SQL, a QRL value)
/// times QRL/USD at unix time `ts` (SQL), or now when `ts` is omitted. With no
/// USD series every USD column is NULL. `series` comes from a fixed list and
/// `maxAge` is a number, so both are inlined.
const NOW = `extract(epoch from now())::int4`;
const usdOf = (u: UsdView) => (qrl: string, ts?: string) => {
  if (!u.series) return 'NULL::float8';
  if (ts === undefined) return u.price === null ? 'NULL::float8' : `(${qrl}) * ${u.price}::float8`;
  return `(${qrl}) * usd_at('${u.series}', LEAST(${ts}, ${NOW}), ${u.maxAge ?? 'NULL'})`;
};

const TOKEN_SELECT = (u: UsdView) => `SELECT ${addr('a.address')} AS id, t.symbol, t.name, t.decimals, t.total_supply::text AS "totalSupply",
  t.holder_count AS "holderCount", t.derived_qrl AS "derivedQRL",
  ${u.series ? `coalesce(t.derived_usd, ${usdOf(u)('t.derived_qrl')})` : 'NULL::float8'} AS "derivedUSD",
  t.first_block AS "firstBlock", t.updated_block AS "updatedBlock"
  FROM tokens t JOIN addresses a ON a.id = t.id`;

/// Running USD totals of each pool from its day rollups, each day at QRL/USD
/// of its end. NULL when a day with volume has no price, rather than a total
/// that silently leaves it out.
const POOL_USD = (u: UsdView) =>
  u.series
    ? `LEFT JOIN LATERAL (
         SELECT CASE WHEN y.priced THEN y.volume END AS volume, CASE WHEN y.priced THEN y.untracked END AS untracked, CASE WHEN y.priced THEN y.fees END AS fees
           FROM (SELECT bool_and(x.usd IS NOT NULL OR coalesce(x.v, 0) + coalesce(x.uv, 0) = 0) IS NOT FALSE AS priced,
                        coalesce(sum(x.v * x.usd), 0) AS volume, coalesce(sum(x.uv * x.usd), 0) AS untracked, coalesce(sum(x.f * x.usd), 0) AS fees
                   FROM (SELECT d.volume_qrl AS v, d.untracked_volume_qrl AS uv, d.fees_qrl AS f, ${usdOf(u)('1', 'd.period + 86399')} AS usd
                           FROM pool_day d WHERE d.pool_id = p.id) x) y
       ) pu ON true`
    : `LEFT JOIN LATERAL (SELECT NULL::float8 AS volume, NULL::float8 AS untracked, NULL::float8 AS fees) pu ON true`;

const POOL_SELECT = (u: UsdView) => `SELECT ${addr('a.address')} AS id, p.version, ${addr('a0.address')} AS token0, ${addr('a1.address')} AS token1,
  p.fee, p.tick_spacing AS "tickSpacing", p.created_block AS "createdBlock", p.reserve0::text AS reserve0, p.reserve1::text AS reserve1,
  p.total_supply::text AS "totalSupply", p.sqrt_price::text AS "sqrtPriceX96", p.tick, p.liquidity::text AS liquidity, p.raw_price AS "rawPrice",
  p.tvl_qrl AS "tvlQRL", ${usdOf(u)('p.tvl_qrl')} AS "tvlUSD", p.tracked,
  p.volume_qrl AS "volumeQRL", pu.volume AS "volumeUSD", p.untracked_volume_qrl AS "untrackedVolumeQRL", pu.untracked AS "untrackedVolumeUSD",
  p.fees_qrl AS "feesQRL", pu.fees AS "feesUSD", p.tx_count AS "txCount", p.updated_block AS "updatedBlock"
  FROM pools p JOIN addresses a ON a.id = p.id JOIN addresses a0 ON a0.id = p.token0_id JOIN addresses a1 ON a1.id = p.token1_id
  ${POOL_USD(u)}`;

const POOL_ORDER: Record<string, string> = {
  createdBlock: 'p.created_block',
  tvlQRL: 'p.tracked DESC, p.tvl_qrl',
  volumeQRL: 'p.volume_qrl',
  txCount: 'p.tx_count',
};

const PERIOD_SELECT = (table: string, length: number, u: UsdView) => {
  const usd = (qrl: string) => usdOf(u)(qrl, `r.period + ${length - 1}`);
  return `SELECT ${addr('a.address')} AS pool, r.period, r.volume0::text AS volume0, r.volume1::text AS volume1,
  r.volume_qrl AS "volumeQRL", ${usd('r.volume_qrl')} AS "volumeUSD", r.untracked_volume_qrl AS "untrackedVolumeQRL",
  ${usd('r.untracked_volume_qrl')} AS "untrackedVolumeUSD", r.fees_qrl AS "feesQRL", ${usd('r.fees_qrl')} AS "feesUSD",
  r.swaps, r.open, r.high, r.low, r.close, r.reserve0::text AS reserve0,
  r.reserve1::text AS reserve1, r.total_supply::text AS "totalSupply", r.tvl_qrl AS "tvlQRL", ${usd('r.tvl_qrl')} AS "tvlUSD"
  FROM ${table} r JOIN addresses a ON a.id = r.pool_id
  WHERE a.address = $1 AND r.period >= $2 AND r.period <= $3 ORDER BY r.period ASC LIMIT $4`;
};

const TOKEN_PERIOD_SELECT = (table: string, length: number, u: UsdView) => {
  const usd = (qrl: string) => usdOf(u)(qrl, `r.period + ${length - 1}`);
  return `SELECT ${addr('a.address')} AS token, r.period, r.open, r.high, r.low, r.close,
  ${usd('r.open')} AS "openUSD", ${usd('r.high')} AS "highUSD", ${usd('r.low')} AS "lowUSD", ${usd('r.close')} AS "closeUSD"
  FROM ${table} r JOIN addresses a ON a.id = r.token_id
  WHERE a.address = $1 AND r.period >= $2 AND r.period <= $3 ORDER BY r.period ASC LIMIT $4`;
};

/// Addresses leave the API in the node's checksummed case, so the interface
/// shows the same `Qa1A6…34Ca` whether a row came from here or from RPC.
const ADDRESS = /^Q[0-9a-f]{128}$/;
const checksumRow = (row: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(row)) if (typeof v === 'string' && ADDRESS.test(v)) row[k] = checksum(v);
  return row;
};

function resolvers(db: pg.Pool, indexer: Indexer, usd: Usd, predict: PredictIndexer) {
  const quests = new Quests(db);
  const today = () => Math.floor(Date.now() / 1000 / 86400);
  const userOf = (id: string) => {
    bytesOf([id]);
    return id;
  };
  const one = async (sql: string, params: unknown[]) => {
    const row = (await db.query(sql, params)).rows[0];
    return row ? checksumRow(row) : null;
  };
  const many = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows.map(checksumRow);
  const periods = (table: string, length: number) => async (a: { pool: string; from?: number; to?: number; first: number }) =>
    many(PERIOD_SELECT(table, length, await usd.view()), [bytesOf([a.pool])![0], a.from ?? 0, a.to ?? 2 ** 31 - 1, page(a.first, 0)[0]]);
  const tokenPeriods = (table: string, length: number) => async (a: { token: string; from?: number; to?: number; first: number }) =>
    many(TOKEN_PERIOD_SELECT(table, length, await usd.view()), [bytesOf([a.token])![0], a.from ?? 0, a.to ?? 2 ** 31 - 1, page(a.first, 0)[0]]);

  return {
    _meta: async () => {
      const s = indexer.status();
      const row = await one(`SELECT b.number, '0x' || encode(b.hash, 'hex') AS hash, b.timestamp FROM blocks b WHERE b.number = $1`, [s.cursor]);
      const u = await usd.view();
      return {
        usdSource: u.usdSource,
        qrlPriceUSD: u.price,
        feedPriceUSD: u.feedPrice,
        usdDeviation: u.deviation,
        usdHidden: u.hidden,
        block: s.cursor,
        hash: row?.hash ?? null,
        timestamp: row?.timestamp ?? null,
        head: s.head,
        chainId: s.chainId,
        startBlock: s.startBlock,
        hasIndexingErrors: !!s.lastError,
        lastError: s.lastError,
      };
    },
    protocol: async () => {
      const u = await usd.view();
      const row = await one(
        `SELECT count(*)::int AS "poolCount", count(*) FILTER (WHERE p.tracked)::int AS "trackedPoolCount", coalesce(sum(p.tx_count), 0)::int AS "txCount",
                coalesce(sum(p.tvl_qrl) FILTER (WHERE p.tracked), 0) AS "tvlQRL", ${usdOf(u)('coalesce(sum(p.tvl_qrl) FILTER (WHERE p.tracked), 0)')} AS "tvlUSD",
                coalesce(sum(p.volume_qrl), 0) AS "volumeQRL", ${u.series ? 'sum(pu.volume)' : 'NULL::float8'} AS "volumeUSD",
                coalesce(sum(p.untracked_volume_qrl), 0) AS "untrackedVolumeQRL", ${u.series ? 'sum(pu.untracked)' : 'NULL::float8'} AS "untrackedVolumeUSD",
                coalesce(sum(p.fees_qrl), 0) AS "feesQRL", ${u.series ? 'sum(pu.fees)' : 'NULL::float8'} AS "feesUSD"
           FROM pools p ${POOL_USD(u)}`,
        [],
      );
      // A pool whose total is unknown makes the protocol total unknown.
      if (row && u.series) {
        const { rows } = await db.query(`SELECT bool_or(pu.volume IS NULL) AS missing FROM pools p ${POOL_USD(u)}`);
        if (rows[0]?.missing) Object.assign(row, { volumeUSD: null, untrackedVolumeUSD: null, feesUSD: null });
      }
      return row;
    },
    tokens: async (a: { ids?: string[]; first: number; skip: number }) =>
      many(`${TOKEN_SELECT(await usd.view())} WHERE ($1::bytea[] IS NULL OR a.address = ANY($1)) ORDER BY t.first_block, t.id LIMIT $2 OFFSET $3`, [
        bytesOf(a.ids),
        ...page(a.first, a.skip),
      ]),
    token: async (a: { id: string }) => one(`${TOKEN_SELECT(await usd.view())} WHERE a.address = $1`, [bytesOf([a.id])![0]]),
    pools: async (a: { ids?: string[]; token?: string; version?: number; orderBy: string; orderDirection?: 'asc' | 'desc'; first: number; skip: number }) => {
      const dir = (a.orderDirection ?? (a.orderBy === 'createdBlock' ? 'asc' : 'desc')) === 'asc' ? 'ASC' : 'DESC';
      return many(
        `${POOL_SELECT(await usd.view())} WHERE ($1::bytea[] IS NULL OR a.address = ANY($1)) AND ($2::bytea IS NULL OR a0.address = $2 OR a1.address = $2)
         AND ($3::int2 IS NULL OR p.version = $3) ORDER BY ${POOL_ORDER[a.orderBy]} ${dir} NULLS LAST, p.id LIMIT $4 OFFSET $5`,
        [bytesOf(a.ids), a.token ? bytesOf([a.token])![0] : null, a.version ?? null, ...page(a.first, a.skip)],
      );
    },
    pool: async (a: { id: string }) => one(`${POOL_SELECT(await usd.view())} WHERE a.address = $1`, [bytesOf([a.id])![0]]),
    poolEvents: async (a: { pools?: string[]; kinds?: string[]; fromBlock?: number; toBlock?: number; fromTime?: number; first: number; skip: number; orderDirection: 'asc' | 'desc' }) => {
      const dir = a.orderDirection === 'asc' ? 'ASC' : 'DESC';
      const u = await usd.view();
      const rows = await many(
        `SELECT e.block_number AS block, e.log_index AS "logIndex", e.ts AS timestamp, e.kind, ${addr('pa.address')} AS pool,
                '0x' || encode(tx.hash, 'hex') AS "txHash", ${addr('fa.address')} AS origin, ${addr('aa.address')} AS account,
                e.amount0::text AS amount0, e.amount1::text AS amount1, e.raw_price AS "rawPrice", e.amount_qrl AS "amountQRL",
                ${usdOf(u)('e.amount_qrl', 'e.ts')} AS "amountUSD"
           FROM pool_events e
           JOIN addresses pa ON pa.id = e.pool_id
           JOIN transactions tx ON tx.id = e.tx_id
           LEFT JOIN addresses fa ON fa.id = tx.from_id
           LEFT JOIN addresses aa ON aa.id = e.account_id
          WHERE ($1::bytea[] IS NULL OR pa.address = ANY($1))
            AND ($2::int2[] IS NULL OR e.kind = ANY($2))
            AND e.block_number >= $3 AND e.block_number <= $4 AND e.ts >= $5
          ORDER BY e.block_number ${dir}, e.log_index ${dir} LIMIT $6 OFFSET $7`,
        [
          bytesOf(a.pools),
          a.kinds ? a.kinds.map((k) => KINDS.indexOf(k)) : null,
          a.fromBlock ?? 0,
          a.toBlock ?? 2 ** 31 - 1,
          a.fromTime ?? 0,
          ...page(a.first, a.skip),
        ],
      );
      return rows.map((r) => ({ ...r, id: `${r.txHash}#${r.logIndex}`, kind: KINDS[r.kind as number] }));
    },
    poolHourDatas: periods('pool_hour', 3600),
    poolDayDatas: periods('pool_day', 86400),
    tokenHourDatas: tokenPeriods('token_hour', 3600),
    tokenDayDatas: tokenPeriods('token_day', 86400),
    tokenHolders: (a: { token: string; first: number; skip: number }) =>
      many(
        `SELECT ${addr('aa.address')} AS account, b.balance::text AS balance FROM token_balances b
           JOIN addresses ta ON ta.id = b.token_id JOIN addresses aa ON aa.id = b.account_id
          WHERE ta.address = $1 AND b.balance > 0 ORDER BY b.balance DESC, b.account_id LIMIT $2 OFFSET $3`,
        [bytesOf([a.token])![0], ...page(a.first, a.skip)],
      ),
    quests: () =>
      QUESTS.map((q) => {
        const masked = !!q.hidden;
        return { id: q.id, kind: q.kind, hidden: masked, title: masked ? null : q.title, detail: masked ? null : q.detail, xp: masked ? null : q.xp, action: masked ? null : (q.action ?? null), target: masked ? null : q.target };
      }),
    questProgress: async (a: { user: string; day?: number }) => {
      const day = a.day ?? today();
      const season = await quests.season();
      return { day, season: season?.id ?? null, seasonEndsAt: season?.endsAt ?? null, block: predict.status().cursor, quests: await quests.progress(userOf(a.user), day) };
    },
    questQueue: async (a: { day?: number }) => (await quests.queue(a.day ?? today())).map(checksumRow),
    transaction: (a: { hash: string }) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(a.hash)) throw new GraphQLError('hash must be 0x + 64 hex');
      return one(
        `SELECT '0x' || encode(t.hash, 'hex') AS hash, t.block_number AS block, ${addr('a.address')} AS "from"
           FROM transactions t LEFT JOIN addresses a ON a.id = t.from_id WHERE t.hash = $1`,
        [Buffer.from(a.hash.slice(2), 'hex')],
      );
    },
  };
}

const MAX_BODY = 64 * 1024;

export function startApi(db: pg.Pool, indexer: Indexer, usd: Usd, predict: PredictIndexer) {
  const root = resolvers(db, indexer, usd, predict);

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': config.corsOrigin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    });
    res.end(JSON.stringify(body));
  };

  const health = async () => {
    const s = indexer.status();
    const { rows } = await db.query(
      `SELECT pg_database_size(current_database()) AS db_bytes,
              (SELECT json_agg(x) FROM (
                 SELECT c.relname AS table, pg_total_relation_size(c.oid) AS bytes FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'acorn' AND c.relkind IN ('r', 'p') ORDER BY 2 DESC LIMIT 5) x) AS largest`,
    );
    // The USD feed reports on its own and does not affect `ok`.
    return { ok: !s.lastError && !s.paused, ...s, usd: usd.status(), predict: predict.status(), dbBytes: Number(rows[0].db_bytes), largestTables: rows[0].largest ?? [], freeDiskBytes: indexer.freeDiskBytes() };
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'OPTIONS') return send(res, 204, null);
      if (url.pathname === '/health') return send(res, 200, await health());
      if (url.pathname !== '/graphql') return send(res, 404, { error: 'not found' });

      let query: string | null = null;
      let variables: Record<string, unknown> | undefined;
      if (req.method === 'GET') {
        query = url.searchParams.get('query');
        const v = url.searchParams.get('variables');
        variables = v ? JSON.parse(v) : undefined;
      } else if (req.method === 'POST') {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_BODY) return send(res, 413, { errors: [{ message: 'request too large' }] });
          chunks.push(c as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        query = body.query;
        variables = body.variables;
      } else return send(res, 405, { error: 'method not allowed' });
      if (!query) return send(res, 400, { errors: [{ message: 'missing query' }] });

      const result = await graphql({ schema, source: query, rootValue: root, variableValues: variables });
      send(res, 200, result);
    } catch (e) {
      log('warn', 'api request failed', { error: (e as Error).message });
      send(res, 400, { errors: [{ message: (e as Error).message }] });
    }
  });
  server.listen(config.port, () => log('info', 'api listening', { port: config.port }));
  return server;
}
