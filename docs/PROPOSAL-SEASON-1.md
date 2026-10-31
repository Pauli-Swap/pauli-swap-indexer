# Proposal: what the indexer still owes season 1

Status: proposed 2026-10-29, from the cross-repo TODO in
`pauli-swap-interface/TODO.md`; §1 to §5 built the same day. Season 1 ends
2026-11-25 17:27 UTC (`endsAt` 1795627668, after the devnet was regenerated
on 2026-10-28); the ranking has to be exportable and checked before then.

[PROPOSAL-PREDICT.md](PROPOSAL-PREDICT.md) stays the design for the Predict
module. This file is the work list on top of it, in the order it is needed.
What was built is described in [INDEXER.md](INDEXER.md) §8.8, §11, §13 to §16.

What is left: the scoring rules of TODO 2.1 (the code takes the proposed
defaults, behind `PREDICT_MIN_DAYS` / `PREDICT_MIN_MARKETS` and flags), the
`claim(id)` check and the cancel scenario once a market settles on the devnet,
the second disk measurement, and deploying this to the VPS.

## 1. Season-end ranking export (TODO 2.2, PROPOSAL-PREDICT §4.3)

Blocked on the scoring rules in TODO 2.1 (active day, traded market,
eligibility threshold, tie break, whether the public board shows `score`).
The command is built with the proposed defaults behind flags.

- [x] `npm run predict:snapshot -- --season 1 --block <B>`, read only.
- [x] Per wallet: `xp_balance`, `claimable` (a cancelled market counts
      `(yes + no) / 2` per position), `score`, active days, markets traded,
      eligible or not.
- [x] Top 3 written in the exact shape of `closeSeason(snapshotBlock, winners)`,
      padded with the zero address when fewer than 3 are eligible.
- [x] Warn, and exit non-zero without `--force`, when a market is still open
      at B, B is past the indexer cursor, or B is **before** `endsAt`. The
      list said "after": a snapshot normally comes after `endsAt`, since
      markets resolve after they close and `closeSeason` requires it.
- [x] Merge the sybil flags from `predict:sybil` (private module) when it is
      installed; the output only says `flagged`, never why.
- [x] Not in the list, but in `quests/denylist.json`'s own notes: denied
      wallets are dropped from the ranking. The denylist is read at run time
      (`--denylist`).

Checked against the prediction-market repo's `docs/PROPOSAL-SEASON-1-OPS.md`
and `docs/SEASON-END.md` (2026-10-29): its `season:close --snapshot` reads
this file's `season`, `snapshotBlock`, `warnings` and `closeSeason` as
written. Its §6 counts a traded market by a `Bought` only, so a `Sold` alone
no longer counts here either.

Run on the devnet at block 1953: three wallets, none eligible yet, four open
markets; the command printed the three warnings and exited 2.

## 2. Reconcile with the chain (TODO 2.3, PROPOSAL-PREDICT §6)

- [x] `xp_balance` against `xpOfSeason` for every wallet.
- [x] Positions against `positionOf`.
- [x] `claimable` against a `qrl_call` of `claim(id)` on every settled market.
      Built, but no market is settled yet, so it has compared nothing; to
      rerun after market #0 resolves (2026-10-30 12:00 UTC).
- [x] Simulate a Predict redeploy by changing `predict-devnet.json`: only the
      `predict_*` tables rebuilt, the swap index stayed.

This is `npm run audit -- --predict`, as section 7 of the audit (INDEXER
§15): 106 / 106 checks pass on the devnet. The cancel scenario of
`e2e.js` (buy, sell at a profit, cancel) belongs to the prediction-market
repo; here `tests/season.test.ts` checks that a cancelled market pays
`(yes + no) / 2` per position.

## 3. Predict API (TODO 3.1, PROPOSAL-PREDICT §5)

The interface replays `PredictMarket` / `PauliPredictXP` logs in the browser
today. With 3 to 20 players that works, but the leaderboard cannot show the
season score until the indexer serves it.

- [x] `predictSeason(id)`
- [x] `predictMarkets(status, first, skip)`, `predictMarket(id)`: Yes price,
      volume, traders.
- [x] `predictTrades(market, user, first, skip)`
- [x] `predictPositions(user, market)`: shares and `claimable`; also `block`
      and `includeEmpty`, which the audit uses.
- [x] `predictLeaderboard(season, block, first, skip)`, the same numbers as
      the snapshot in §1 (one code path, `src/season.ts`), without its
      denylist and sybil flags.

`_meta.predictBlock` gives the Predict cursor. Migration
`004_predict_season.sql` adds the `closeSeason` record, the market pools and
trade transaction hashes; its `PREDICT_RULES` bump rebuilds only the Predict
tables on deploy.

## 4. Docs that are out of date

- [x] INDEXER.md §16 "Open": both items are answered on the VPS.
      - gqrl binding: the indexer runs with `network_mode: host` and
        `RPC_URL` set to the node's private address on port 8545. §13 now lists this third option.
      - Disk, measured 2026-10-29 00:25 UTC (now in §14): 96 GB disk, 25 GB
        used, all Docker volumes 828 MB, the indexer database 8.5 MB.
- [ ] Measure the disk again after a week (about 2026-11-05) for the growth
      per day.
- [x] Keep `DISK_MIN_FREE_GB=5`, `EVENT_DAYS=0` and `HOUR_DATA_DAYS=90` for
      season 1. At this size none of them comes close to binding.

## 5. Tests (TODO 4.1)

- [x] SQL tests for the quest rules in `src/quests.ts`, on a small fixed
      database (`tests/quests.test.ts`, own schema, `TEST_DATABASE_URL`).
- [x] A test that a hidden quest's title, detail and rule stay hidden until
      the wallet is credited, and that the attester still gets it queued.
- [x] CI: `tsc` (src, scripts, tests), build and tests
      (`.github/workflows/ci.yml`, with a Postgres service and the public
      prediction-market repo for the synced files).

## 6. Backlog (not for season 1)

- V3 / V2 positions with snapshots, `Tick` rows, `Collect` / `Flash`,
  protocol day data.
- Price jump filter, V3 TWAP pricing, `where` filters, time travel.
- `getterSuspect` (sampled `balanceOf`) and `slot0()` reconciliation at the tip.

## 7. What the interface needs (from `pauli-swap-interface/docs/PROPOSAL-SEASON-1.md`)

Added 2026-10-30. Two changes upstream shape this: the prediction-market
repo redeploys the whole Predict pair, and a settled market now pays its
holders automatically through `settle(id, users[])` (its OPS proposal §9).
The interface moves its leaderboard, markets and positions onto the §3 API,
falling back to its log replay when the indexer is down or lagging.

- [x] After the redeploy: `sync:predict`, let `predict-devnet.json` change
      rebuild the `predict_*` tables from the new start block (the path
      tested in §2), push to the VPS. Done 2026-10-31: the redeploy of
      04:11 UTC (Predict `startBlock` 15247) synced, the VPS logged
      "predict deployment changed" and rebuilt; season 1 (`endsAt`
      1795627668) and markets 0 to 3 are indexed, no trades yet. Only
      `MarketChanged` changed among the events, and no handler reads it.
- [x] `settle` emits the existing `Claimed(id, user, xp)` once per user, so
      positions and `claimable` need no new handler. Check that a batch of
      `Claimed` in one transaction (several log indexes) is applied in full.
      Each is its own `(block, log_index)` row; `tests/season.test.ts`
      settles three holders in one block and checks that every position
      empties and no score or `reachedBlock` moves. To check on the chain
      once `settle` is deployed (`npm run audit -- --predict`).
- [x] The attester reads holders with `predictPositions(market: id)`; keep
      empty positions out by default and keep the query cheap for one
      market. Empty positions were already left out without `includeEmpty`;
      migration `005_predict_claims_market.sql` indexes claims by market, as
      `predict_trades_market` does for trades.
- [ ] `PauliPredictXP` will allow more than one market
      (`setMarket(market, allowed)`). Season 1 runs one, which
      `predict-devnet.json` names. Before a second market contract goes live,
      index `PredictMarket` events by the set of allowed markets rather than
      one address. Not for now: Season 1 has one market contract.
- [x] Deploy the build with the Predict API (§3) to the VPS before the
      interface switches over. Live 2026-10-31 with this section's API
      (`predictPriceHistory`, `eligibleRank`, migration 005), at
      `https://pauliswap.org/graphql`; port 4000 stays closed to the
      Internet.
- [x] `predictPriceHistory(market: Int!, from: Int, first: Int)`: the Yes
      price after each trade (block, timestamp, `priceYes`), plus the price
      24 h ago, for the market chart and its 24 h change. `PredictTrade` has
      no pool state after the trade, so the interface cannot build the chart
      from `predictTrades` without replaying the pool itself; the replay
      already runs here (`src/predict.ts`). Built: `priceYes`,
      `priceYes24hAgo` (0.5, the opening price, when no trade is older than
      24 h) and `points` (`block`, `logIndex`, `timestamp`, `priceYes`),
      oldest first, `from` a timestamp. The replay shares `poolDelta` with
      the indexer and matches `predict_markets` on the devnet (market #0).
- [x] PROPOSAL-PREDICT.md §4.3 still says to warn when "`B` later than
      `ends_at`"; the code and §1 above warn when B is **before** `endsAt`.
      Fix the doc.
- [x] (Optional) An `eligibleRank` on `PredictStanding`, rank among eligible
      wallets only, so the board and the prize column do not re-rank in the
      browser. Null for a wallet that is not eligible.
