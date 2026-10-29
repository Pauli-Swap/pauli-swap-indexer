# Proposal: what the indexer still owes season 1

Status: proposed 2026-10-29, from the cross-repo TODO in
`pauli-swap-interface/TODO.md`. Season 1 ends 2026-11-25 17:27 UTC
(`endsAt` 1795627668, after the devnet was regenerated on 2026-10-28); the
ranking has to be exportable and checked before then.

[PROPOSAL-PREDICT.md](PROPOSAL-PREDICT.md) stays the design for the Predict
module. This file is the work list on top of it, in the order it is needed.

## 1. Season-end ranking export (TODO 2.2, PROPOSAL-PREDICT §4.3)

Blocked on the scoring rules in TODO 2.1 (active day, traded market,
eligibility threshold, tie break, whether the public board shows `score`).
The command can be built with the proposed defaults behind flags.

- [ ] `npm run predict:snapshot -- --season 1 --block <B>`, read only.
- [ ] Per wallet: `xp_balance`, `claimable` (a cancelled market counts
      `(yes + no) / 2` per position), `score`, active days, markets traded,
      eligible or not.
- [ ] Top 3 written in the exact shape of `closeSeason(snapshotBlock, winners)`.
- [ ] Warn, and exit non-zero without `--force`, when a market is still open
      at B, B is past the indexer cursor, or B is after `endsAt`.
- [ ] Merge the sybil flags from `predict:sybil` (private module) when it is
      installed; the public output only says "flagged", never why.

## 2. Reconcile with the chain (TODO 2.3, PROPOSAL-PREDICT §6)

- [ ] `xp_balance` against `xpOfSeason` for every wallet.
- [ ] Positions against `positionOf`.
- [ ] `claimable` against a `qrl_call` of `claim(id)` on every settled market.
- [ ] Simulate a Predict redeploy by changing `predict-devnet.json`: only the
      `predict_*` tables may rebuild, the swap index must stay.

This belongs in `npm run audit` as a `--predict` section, so it runs the same
way as the pool / token audit.

## 3. Predict API (TODO 3.1, PROPOSAL-PREDICT §5)

The interface replays `PredictMarket` / `PauliPredictXP` logs in the browser
today. With 3 to 20 players that works, but the leaderboard cannot show the
season score until the indexer serves it.

- [ ] `predictSeason(id)`
- [ ] `predictMarkets(status, first, skip)`, `predictMarket(id)`: Yes price,
      volume, traders.
- [ ] `predictTrades(market, user, first, skip)`
- [ ] `predictPositions(user, market)`: shares and `claimable`.
- [ ] `predictLeaderboard(season, block, first, skip)`, the same numbers as
      the snapshot in §1.

## 4. Docs that are out of date

- [ ] INDEXER.md §16 "Open": both items are answered on the VPS.
      - gqrl binding: the indexer runs with `network_mode: host` and
        `RPC_URL` set to the gqrl container's address on the chain's own
        bridge network. Neither option in §13 was used,
        because a second bridge network cannot reach the chain's bridge and
        joining `kt-qrl-devnet` can take the chain containers' pinned IPs.
        §13 should list this third option.
      - Disk, measured 2026-10-29 00:25 UTC, about 7 h after the devnet was
        regenerated: 96 GB disk, 25 GB used, all Docker volumes 828 MB, the
        indexer database 8.5 MB. Measure again after a week to get the growth
        per day before changing the defaults below.
- [ ] Keep `DISK_MIN_FREE_GB=5`, `EVENT_DAYS=0` and `HOUR_DATA_DAYS=90` for
      season 1. At this size none of them comes close to binding.

## 5. Tests (TODO 4.1)

- [ ] SQL tests for the quest rules in `src/quests.ts`, on a small fixed
      database.
- [ ] A test that a hidden quest's title, detail and rule stay hidden until
      the wallet is credited.
- [ ] CI: `tsc`, build and tests.

## 6. Backlog (not for season 1)

- V3 / V2 positions with snapshots, `Tick` rows, `Collect` / `Flash`,
  protocol day data.
- Price jump filter, V3 TWAP pricing, `where` filters, time travel.
- `getterSuspect` (sampled `balanceOf`) and `slot0()` reconciliation at the tip.
