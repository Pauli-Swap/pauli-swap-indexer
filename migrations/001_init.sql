-- Everything lives in schema `acorn`, which a regenesis drops and recreates
-- (docs/INDEXER.md §10). Storage layout: docs/INDEXER.md §7 and §14.

-- Every 64 byte address once; other tables hold the int4 id.
CREATE TABLE addresses (
  id      int4 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address bytea NOT NULL UNIQUE
);

-- Chain identity and cursors: chain_id, start_block, start_block_hash,
-- deployed_at, v2_factory, cursor, cursor_hash.
CREATE TABLE meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- Only blocks that carry pool events, plus the cursor block.
CREATE TABLE blocks (
  number    int4 PRIMARY KEY,
  hash      bytea NOT NULL,
  timestamp int4 NOT NULL
);

CREATE TABLE tokens (
  id             int4 PRIMARY KEY REFERENCES addresses,
  symbol         text,
  name           text,
  decimals       int2,
  total_supply   numeric NOT NULL DEFAULT 0,
  holder_count   int4 NOT NULL DEFAULT 0,
  derived_qrl    float8,
  first_block    int4 NOT NULL,
  updated_block  int4 NOT NULL
);

-- Balances derived from Transfer / Deposit / Withdrawal, never balanceOf
-- (OC-V3-02, §5). Also holds V2 LP token balances (token_id = pair).
-- A row is deleted when its balance returns to zero.
CREATE TABLE token_balances (
  token_id   int4 NOT NULL,
  account_id int4 NOT NULL,
  balance    numeric NOT NULL,
  PRIMARY KEY (token_id, account_id)
);
CREATE INDEX token_balances_rank ON token_balances (token_id, balance DESC);

-- V2 pairs (version 2) and V3 pools (version 3).
CREATE TABLE pools (
  id            int4 PRIMARY KEY REFERENCES addresses,
  version       int2 NOT NULL,
  token0_id     int4 NOT NULL,
  token1_id     int4 NOT NULL,
  fee           int4 NOT NULL,
  tick_spacing  int4 NOT NULL,
  created_block int4 NOT NULL,
  reserve0      numeric NOT NULL DEFAULT 0,
  reserve1      numeric NOT NULL DEFAULT 0,
  total_supply  numeric NOT NULL DEFAULT 0,
  sqrt_price    numeric NOT NULL DEFAULT 0,
  tick          int4,
  liquidity     numeric NOT NULL DEFAULT 0,
  raw_price     float8,
  tvl_qrl       float8,
  volume_qrl    float8 NOT NULL DEFAULT 0,
  fees_qrl      float8 NOT NULL DEFAULT 0,
  tx_count      int4 NOT NULL DEFAULT 0,
  updated_block int4 NOT NULL
);

-- Transactions that carry a pool event; only the signer is kept (§6).
CREATE TABLE transactions (
  id           int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hash         bytea NOT NULL UNIQUE,
  block_number int4 NOT NULL,
  from_id      int4
);

-- Swap / Mint / Burn / uncovered Sync rows, in the interface's PoolEvent
-- shape. kind: 0 swap, 1 add, 2 remove, 3 sync (price only).
-- Partitioned by month of `ts` so retention drops partitions.
CREATE TABLE pool_events (
  ts           int4 NOT NULL,
  block_number int4 NOT NULL,
  log_index    int4 NOT NULL,
  pool_id      int4 NOT NULL,
  kind         int2 NOT NULL,
  tx_id        int8 NOT NULL,
  account_id   int4,
  amount0      numeric NOT NULL,
  amount1      numeric NOT NULL,
  raw_price    float8,
  amount_qrl   float8,
  PRIMARY KEY (block_number, log_index, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX pool_events_pool ON pool_events (pool_id, block_number DESC, log_index DESC);

-- Rollups. Prices are raw (decimals-free) token1 per token0, like the
-- interface's rawPrice; hour tables are partitioned by month for retention.
CREATE TABLE pool_hour (
  pool_id      int4 NOT NULL,
  period       int4 NOT NULL,
  volume0      numeric NOT NULL DEFAULT 0,
  volume1      numeric NOT NULL DEFAULT 0,
  volume_qrl   float8,
  fees_qrl     float8,
  swaps        int4 NOT NULL DEFAULT 0,
  open         float8,
  high         float8,
  low          float8,
  close        float8,
  reserve0     numeric NOT NULL,
  reserve1     numeric NOT NULL,
  total_supply numeric NOT NULL,
  tvl_qrl      float8,
  PRIMARY KEY (pool_id, period)
) PARTITION BY RANGE (period);

CREATE TABLE pool_day (LIKE pool_hour INCLUDING DEFAULTS, PRIMARY KEY (pool_id, period));

CREATE TABLE token_hour (
  token_id int4 NOT NULL,
  period   int4 NOT NULL,
  open     float8 NOT NULL,
  high     float8 NOT NULL,
  low      float8 NOT NULL,
  close    float8 NOT NULL,
  PRIMARY KEY (token_id, period)
) PARTITION BY RANGE (period);

CREATE TABLE token_day (LIKE token_hour INCLUDING DEFAULTS, PRIMARY KEY (token_id, period));
