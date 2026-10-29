-- What the season ranking and the Predict API need beyond 003 (docs/INDEXER.md
-- §8.8): the closeSeason record, the market pools behind priceYes, and the
-- transaction of each trade and claim. The Predict module rebuilds its tables
-- on the PREDICT_RULES bump that ships with this, which fills the columns.

ALTER TABLE predict_seasons
  ADD COLUMN snapshot_block int4,
  ADD COLUMN winners        bytea[];

ALTER TABLE predict_markets
  ADD COLUMN pool_yes numeric,
  ADD COLUMN pool_no  numeric;

ALTER TABLE predict_trades ADD COLUMN tx_hash bytea;
ALTER TABLE predict_claims ADD COLUMN tx_hash bytea;

CREATE INDEX predict_trades_market ON predict_trades (market, block_number);
