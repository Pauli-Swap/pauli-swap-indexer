# Proposal: Predict module

Status: step 1 built 2026-10-28 as the Predict module on its own cursor,
with quests and the sybil report ([INDEXER.md](INDEXER.md) §8.6, §8.7); the
season-end export (§4.3) and the API of §5 beyond quests are not built. It fills the "Prediction Market
handlers" line of [INDEXER.md](INDEXER.md) §16 and step 4.1 / 4.4 of
`pauli-swap-prediction-market/docs/PLAN.md`.

## Starting point

- `PauliPredictXP` and `PredictMarket` are deployed on the devnet
  (`pauli-swap-prediction-market/deployments/devnet.json`, `startBlock` 4440,
  `deployedAt` 2026-10-28T04:45:29Z, season 1).
- The interface reads all of Predict from `qrl_getLogs` in the browser
  (`pauli-swap-interface/src/lib/predict.ts`, `contractLog`), leaderboard
  included. With 3 to 20 players that is fast enough; what it cannot do is
  the season-end ranking, which needs history at a fixed block and an
  eligibility check.
- The indexer has no Predict code, no Predict ABIs and no table for it.

The goal is the season-end export first (§4), and the API for the interface
second (§5).

## 1. Inputs

- `npm run sync:predict` copies `build/qrvm` ABIs of `PauliPredictXP` and
  `PredictMarket` and `deployments/devnet.json` from
  `../pauli-swap-prediction-market` into `src/contracts/` as
  `predict-devnet.json`, as the interface's `scripts/sync-predict.mjs` does.
- An empty `contracts` map means Predict is not deployed: the module stays
  off and the rest of the indexer runs as today.

## 2. Ingestion

The two addresses join the watched set (§3.3) and their logs are read in the
same batch and the same Postgres transaction as the pool logs. The handlers
sit outside the pricing and rollup path.

| Contract | Events |
| --- | --- |
| `PauliPredictXP` | `SeasonStarted`, `SeasonClosed`, `XPCredited`, `XPDebited`, `QuestCompleted` |
| `PredictMarket` | `MarketCreated`, `Bought`, `Sold`, `MarketResolved`, `MarketCancelled`, `Claimed` |

### 2.1 Its own deployment identity

Predict is redeployed without a regenesis: the 2026-10-28 deployment at block
4440 came on a chain the indexer had already indexed to 4409. Today's
identity check (§10) only watches pauli-swap's `devnet.json`, so it would
miss this.

Proposed: `meta` gets `predict_deployed_at`, `predict_xp`, `predict_market`
and `predict_start_block`. When any of them differs from
`predict-devnet.json`, the indexer drops only the `predict_*` tables,
backfills them from the new `startBlock` to the cursor in 20k block steps,
and goes on. The pool tables are not touched. A real regenesis still drops
everything, Predict included.

`RULES_VERSION` covers the Predict handlers too.

## 3. Tables

All event tables are kept for the whole season, with no retention: a season
has a few markets and a few hundred trades. The ranking is recomputed from
rows at a given block (§4), so no running total has to be correct at an
arbitrary point in history.

| Table | Holds |
| --- | --- |
| `predict_seasons` | `id`, `ends_at`, `started_block`, `closed_block`, `snapshot_block`, the three `winners` |
| `predict_markets` | `id`, `question`, `close_time`, `liquidity`, `status` (0 open, 1 resolved, 2 cancelled), `outcome`, `pool_yes`, `pool_no`, created / settled block |
| `predict_trades` | `Bought` / `Sold`: `market`, `user`, `side` (buy / sell), `outcome`, `xp`, `shares`, block, log index, tx |
| `predict_claims` | `market`, `user`, `xp`, block |
| `predict_xp_events` | `XPCredited` / `XPDebited`: `user`, `season`, signed `amount`, `reason`, block, timestamp |
| `predict_quests` | `user`, `quest_id`, `day`, `amount`, block |
| `predict_positions` | current `(market, user) → yes_shares, no_shares`, from trades and claims; kept for the API, never used for a snapshot |

Amounts are `numeric` wei (XP has 18 decimals), as for pool amounts (§7.1).

## 4. Season-end ranking

This replaces nothing on chain. It is what the admin reviews before calling
`closeSeason(snapshotBlock, winners)` (PLAN.md §4 step 4).

### 4.1 Score

For a wallet in season `S` at block `B`:

```
score = xp_balance(S, user, B) + claimable(user, B)
```

- `xp_balance` is the sum of `XPCredited` minus `XPDebited` for season `S`
  up to `B`. It equals `xpOfSeason(S, user)` at `B`.
- `claimable` adds up, over every market that is settled at `B`, the
  wallet's position at `B` that it has not claimed yet:
  - **resolved**: the winning shares, `yesShares` if Yes won, else
    `noShares` (1 XP a share);
  - **cancelled**: `(yesShares + noShares) / 2`, integer division per
    position, exactly as `PredictMarket.claim`. It is **not**
    `spent - received`. That old rule was dropped on chain because it let a
    wallet that sold at a profit keep the profit while its buyers got a full
    refund. Divide per position, then sum, never the other way round: the sum
    must equal what the wallet's claims would pay.
- A position at `B` comes from that wallet's `Bought` (adds `shares` to the
  outcome) and `Sold` (removes `shares`) up to `B`. A `Claimed` up to `B`
  sets it to zero, since `claim` deletes the position.
- Open markets add nothing. Step 4.1 of PLAN.md settles every market before
  the snapshot. Any market still open at `B` is listed in the export as a
  warning.

Claims credit the season that is current when they are made, not the season
the market belongs to. `claimable` therefore counts every settled market,
whatever its season. That is what claiming at `B` would actually pay, and it
is the behaviour PLAN.md §4 step 5 warns about.

### 4.2 Eligibility

PLAN.md §3.1: at least 7 active days and at least 3 markets traded in the
season. Proposed definitions, to be confirmed:

- **Active day**: a UTC day (`timestamp / 86400`, the contract's `today()`)
  on which the wallet has a `QuestCompleted`, `Bought` or `Sold`.
- **Market traded**: a distinct market id with at least one `Bought` or
  `Sold` by the wallet in the season.
- The season runs from `SeasonStarted` to `ends_at`, or to `SeasonClosed`
  if that comes first.

### 4.3 Export

`npm run predict:snapshot -- --season 1 --block <B>` prints, and writes as
JSON:

- each wallet's `xp_balance`, `claimable` and `score`, its active days, its
  markets traded and whether it is eligible;
- the top 3 eligible wallets, which are the `winners` argument for
  `closeSeason`;
- warnings: markets still open at `B`, `B` past the indexed cursor, and
  `B` later than `ends_at`.

Ties are broken by the earlier block at which the wallet reached its score;
this needs confirming.

## 5. API

Added to §11, read only, flat like the rest:

| Query | Returns |
| --- | --- |
| `predictSeason(id)` | `endsAt`, `active`, `closed`, `snapshotBlock`, `winners` |
| `predictMarkets(status, first, skip)`, `predictMarket(id)` | the `predict_markets` row, `priceYes`, `volumeXP`, `traders` |
| `predictTrades(market, user, first, skip)` | rows of `predict_trades` with `timestamp` and `txHash` |
| `predictPositions(user, market)` | current shares and `claimable` |
| `predictLeaderboard(season, block, first, skip)` | `user`, `xp`, `claimable`, `score`, `rank`, `eligible`, `activeDays`, `marketsTraded`; `block` defaults to the cursor |

The interface can then take its Leaderboard and Rewards tabs, and the chart
of each market, from the indexer. Today it builds them from logs, and its
Leaderboard shows the XP balance only, without `claimable`. Whether the
public leaderboard should show `score` or only the balance is a product
decision; the export always uses `score`.

## 6. Verification

Run against the devnet after every backfill, as for pools (§15):

- `predict_positions` against `positionOf(id, user)` for every pair seen.
  The view is explicit, so it is not affected by OC-V3-02.
- `xp_balance(S, user, cursor)` against `xpOfSeason(S, user)`.
- `claimable` against a `qrl_call` of `claim(id)` from the wallet on each
  settled market. The call returns the XP the claim would pay without
  sending anything, and reverts `PM: nothing` where `claimable` is 0.
- The cancel scenario of `pauli-swap-prediction-market/scripts/qrvm/e2e.js`
  (buy, sell at a profit, cancel). The claim must come out at
  `(yesShares + noShares) / 2` and not at `spent - received`.
- A Predict redeploy: change `predict-devnet.json`, and only the `predict_*`
  tables rebuild (§2.1).

## 7. Not in this proposal

- Quest detection and the attester bot (PLAN.md §4 step 2): the swap, LP and
  wrap quests need the indexer's pool events plus a key that holds the
  attester role. That is a separate proposal.
- Sybil review: the export lists funding sources only if asked to. The
  decision stays with the admin.

## Order

1. `sync:predict`, the watched set, the tables and the handlers, with the
   Predict-only rebuild of §2.1.
2. `predict:snapshot` and the checks of §6. This is what season 1 needs
   before it ends on 2026-11-25 (`endsAt` 1795581833).
3. The API of §5, then moving the interface over.
