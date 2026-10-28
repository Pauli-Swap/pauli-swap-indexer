# Proposal: USD / fiat pricing

Status: accepted and built on 2026-10-28; the design of record is now
[INDEXER.md](INDEXER.md) §9 (pricing) and §11 (field names). This file keeps
the original proposal below.

Decisions taken while building it:

- **Order 1 and 2 built; order 3 built behind `USD_SOURCE=stable`.** `stable`
  was exercised on the devnet with QUSD standing in for a stablecoin. That
  tests the mechanics, not the numbers. The default stays `none`.
- **USD is converted when the API reads it**, with the QRL/USD point at each
  row's time (series in `qrl_usd`). Switching `none` / `feed` needs no
  rebuild, and a feed that starts late still prices history through its
  hourly backfill.
- **Names.** `volumeQRL` is the tracked volume and `untrackedVolumeQRL` the
  rest, the upstream subgraphs' `volumeUSD` / `untrackedVolumeUSD` pattern,
  instead of a separate `trackedVolumeQRL`. Every QRL value has a nullable
  `…USD` twin, and `_meta` adds `usdSource`, `qrlPriceUSD`, `feedPriceUSD`,
  `usdDeviation` and `usdHidden`. A new `protocol` query gives the totals.
- **Fees follow tracked volume**, as upstream.
- **Tracked** means both tokens are priced and both sides hold at least
  `MIN_QRL_LIQUIDITY`. The bridge whitelist is WQRL plus `STABLE_TOKENS` plus
  `BRIDGE_TOKENS`.
- **Pricing settings are part of the index.** Changing them rebuilds it (the
  `rules` key in `meta`), since history computed under other settings would
  be wrong.
- **Jump filter and TWAP: not built** (INDEXER.md §9.5).
- **Interface `$` display: not started.** The field names are settled, so it
  can go ahead.

## Starting point

Uniswap Labs' pricing service, as summarised for this proposal:

1. Pick the canonical pool: the deepest liquidity across V2 / V3 / V4.
2. Convert to USD: a direct pair with a stablecoin (USDC, USDT, DAI) gives the
   price; otherwise route Token → WETH → USDC.
3. Cross-check with off-chain feeds (CoinGecko, CMC) and filter junk or
   manipulated pools.

## What PauliSwap already has

Step 1 and the "Token → WETH" leg exist: `qrlPrices` in `src/pricing.ts` walks
from WQRL through the deepest pool at each step, with `MIN_QRL_LIQUIDITY`.
QRL stays the base unit. What is missing is the QRL → USD leg and the
filtering of step 3.

## 1. QRL → USD: `Bundle.qrlPriceUSD`

Chosen by `USD_SOURCE=none|stable|feed`:

- **`none`** (default, and the only correct setting on the devnet). Every USD
  field is `null`. Devnet QRL comes from a faucet and QUSD is a test token;
  multiplying by the market QRL price would produce numbers that look real
  and mean nothing.
- **`stable`**: `STABLE_TOKENS` (address list). The anchor is the deepest
  WQRL / stable pool, accepted only above `MIN_USD_LIQUIDITY`. A token with
  its own sufficiently deep stable pair is priced from that pair (Uniswap's
  step 2). This is the mainnet path once a real stablecoin exists.
- **`feed`**: the indexer polls QRL/USD every N minutes into
  `qrl_usd(ts, price, source)`. Hour / day rollups convert with the price at
  their time, not the latest one. Checked on 2026-10-28: CoinGecko id
  `quantum-resistant-ledger` returned 1.24 USD, MEXC `QRLUSDT` 1.23874;
  Coinbase has no QRL-USD pair.
- With both `stable` and `feed` available: the on-chain price is used, the
  feed is a check; a deviation above `USD_MAX_DEVIATION` sets a flag and
  hides USD until it clears.

## 2. API

All nullable; the interface shows `$` only when a value is non-null:

- `Token.derivedUSD`
- `Pool.tvlUSD`, `volumeUSD`, `feesUSD`
- `amountUSD` on events
- USD columns in pool / token hour and day data
- `_meta.usdSource` (`none` | `stable` | `feed`) and the deviation flag

## 3. Filtering (useful even without USD)

- **Tracked vs untracked volume**: `trackedVolumeQRL` only when both tokens
  are priced and the pool clears the depth threshold; the rest goes to
  `untrackedVolumeQRL` (as `untrackedVolumeUSD` in the v2 subgraph). Rankings
  and protocol totals sum tracked volume only.
- **Bridge whitelist**: only whitelisted tokens (default WQRL and
  `STABLE_TOKENS`) may carry a price to other tokens in the walk. Other tokens
  are still priced, but nothing is priced through them.
- **Jump filter**: skip a price step when a token moves more than
  `MAX_PRICE_JUMP` within one block on a shallow pool, or price V3 tokens from
  a TWAP over `observations` (an array getter, correct under OC-V3-02).

## Order

1. Nullable USD fields with `USD_SOURCE=none`, tracked / untracked volume,
   bridge whitelist. No external dependency.
2. `feed` and the `qrl_usd` table.
3. `stable` when a real stablecoin is on chain.

The interface adds conditional `$` display once the field names in §2 are
settled.
