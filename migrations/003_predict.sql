-- Predict, quests and the PauliSwap faucet (docs/INDEXER.md §8.6). Kept apart
-- from the pool tables: the Predict module has its own cursor (meta
-- predict_cursor) and its own rebuild, which truncates only these tables.
-- Wallets are stored as bytea: the tables are small (a season has a few
-- hundred rows per kind) and are never joined into the pool path.

CREATE TABLE predict_seasons (
  id            int4 PRIMARY KEY,
  ends_at       int4 NOT NULL,
  started_ts    int4 NOT NULL,
  started_block int4 NOT NULL,
  closed_block  int4
);

CREATE TABLE predict_markets (
  id            int4 PRIMARY KEY,
  question      text NOT NULL,
  close_time    int4 NOT NULL,
  liquidity     numeric NOT NULL,
  -- 0 open, 1 resolved, 2 cancelled; outcome 0 Yes, 1 No.
  status        int2 NOT NULL DEFAULT 0,
  outcome       int2,
  created_block int4 NOT NULL,
  settled_block int4
);

-- Bought (side 0) and Sold (side 1).
CREATE TABLE predict_trades (
  block_number int4 NOT NULL,
  log_index    int4 NOT NULL,
  ts           int4 NOT NULL,
  market       int4 NOT NULL,
  wallet       bytea NOT NULL,
  side         int2 NOT NULL,
  outcome      int2 NOT NULL,
  xp           numeric NOT NULL,
  shares       numeric NOT NULL,
  PRIMARY KEY (block_number, log_index)
);
CREATE INDEX predict_trades_wallet ON predict_trades (wallet, ts);

CREATE TABLE predict_claims (
  block_number int4 NOT NULL,
  log_index    int4 NOT NULL,
  ts           int4 NOT NULL,
  market       int4 NOT NULL,
  wallet       bytea NOT NULL,
  xp           numeric NOT NULL,
  PRIMARY KEY (block_number, log_index)
);

-- QuestCompleted: quest 0 is checkIn, the rest are attester credits.
CREATE TABLE predict_quests (
  block_number int4 NOT NULL,
  log_index    int4 NOT NULL,
  ts           int4 NOT NULL,
  wallet       bytea NOT NULL,
  quest_id     int4 NOT NULL,
  day          int4 NOT NULL,
  amount       numeric NOT NULL,
  PRIMARY KEY (block_number, log_index)
);
CREATE INDEX predict_quests_wallet ON predict_quests (wallet, quest_id, day);

-- XPCredited (+) / XPDebited (-).
CREATE TABLE predict_xp_events (
  block_number int4 NOT NULL,
  log_index    int4 NOT NULL,
  ts           int4 NOT NULL,
  wallet       bytea NOT NULL,
  season       int4 NOT NULL,
  amount       numeric NOT NULL,
  reason       bytea NOT NULL,
  PRIMARY KEY (block_number, log_index)
);

-- WQRL Deposit (kind 0) / Withdrawal (kind 1); `wallet` is the event's dst /
-- src, which is the signer when a wallet wraps directly.
CREATE TABLE wrap_events (
  block_number int4 NOT NULL,
  log_index    int4 NOT NULL,
  ts           int4 NOT NULL,
  wallet       bytea NOT NULL,
  kind         int2 NOT NULL,
  amount       numeric NOT NULL,
  PRIMARY KEY (block_number, log_index)
);
CREATE INDEX wrap_events_wallet ON wrap_events (wallet, ts);

-- QrlFaucet Dripped, `wallet` = to.
CREATE TABLE faucet_drips (
  block_number int4 NOT NULL,
  log_index    int4 NOT NULL,
  ts           int4 NOT NULL,
  wallet       bytea NOT NULL,
  amount       numeric NOT NULL,
  PRIMARY KEY (block_number, log_index)
);
CREATE INDEX faucet_drips_wallet ON faucet_drips (wallet);

CREATE INDEX transactions_from ON transactions (from_id);
