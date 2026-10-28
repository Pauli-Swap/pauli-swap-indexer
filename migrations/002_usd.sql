-- USD pricing and tracked volume (docs/INDEXER.md §9). Values stay in QRL;
-- the API converts to USD when it reads, with the QRL/USD price at each row's
-- time, so changing USD_SOURCE needs no rebuild.

-- volume_qrl / fees_qrl now count tracked pools only; the rest is untracked.
ALTER TABLE pools ADD COLUMN untracked_volume_qrl float8 NOT NULL DEFAULT 0;
-- Both tokens priced and both sides at least MIN_QRL_LIQUIDITY deep.
ALTER TABLE pools ADD COLUMN tracked boolean NOT NULL DEFAULT false;
ALTER TABLE pool_hour ADD COLUMN untracked_volume_qrl float8;
ALTER TABLE pool_day ADD COLUMN untracked_volume_qrl float8;

-- USD_SOURCE=stable: a token's price through its own deep stable pair.
ALTER TABLE tokens ADD COLUMN derived_usd float8;

-- QRL/USD over time, one series per source: 'stable' (written by the indexer
-- when the on-chain anchor changes), 'coingecko' / 'mexc' (the feed).
CREATE TABLE qrl_usd (
  source text NOT NULL,
  ts     int4 NOT NULL,
  -- NULL: the source had no usable price from this time on.
  price  float8,
  PRIMARY KEY (source, ts)
);

-- QRL/USD of `src` at unix time `t`: the latest point at or before `t`, no
-- older than `max_age` seconds (NULL: any age).
CREATE FUNCTION usd_at(src text, t int4, max_age int4) RETURNS float8
LANGUAGE sql STABLE AS $$
  SELECT price FROM acorn.qrl_usd
   WHERE source = src AND ts <= t AND (max_age IS NULL OR ts > t - max_age)
   ORDER BY ts DESC LIMIT 1
$$;
