-- predictPositions(market: id), which the attester reads before each
-- settle(id, users[]) (docs/INDEXER.md §8.8): trades of one market already
-- have predict_trades_market; this does the same for its claims.

CREATE INDEX predict_claims_market ON predict_claims (market, block_number);
