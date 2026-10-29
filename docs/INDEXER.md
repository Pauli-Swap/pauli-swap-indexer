# PauliSwap Indexer — design

Status: v1 built and running against the devnet (§15). Target: the QIP-55
private devnet (`chainId` 3151908) on the VPS that `pauli-swap-interface`
runs against, with the QRVM build of PauliSwap V2 + V3 from `../pauli-swap`
(`build/qrvm`, `deployments/devnet.json`).

Decisions: a separate repo (this one), Node/TypeScript + Postgres, a GraphQL
API whose entity names follow the Uniswap v2/v3 subgraphs. The indexer shares
the VPS disk with the node, so storage is a design constraint (§14).

What v1 covers is what made the interface slow: pool discovery, pool event
history, holder counts, transaction senders and block timestamps. What it
does not cover yet is listed in §16.

---

## 1. Why a custom indexer

Without it, the interface builds every Explore / Pool number in the browser.
It calls `qrl_getLogs` per pool in 20k block steps (`src/lib/history.ts`),
discovers pools on every load (`src/lib/registry.ts`), replays every
`Transfer` of a token to count holders (`useTokenFacts` in
`src/hooks/explore.ts`), fetches each transaction to learn the sender
(`txSender`), and places blocks on a clock interpolated at ~13 s per block.
That is slow, repeated by every visitor, and grows with chain history. The
interpolated clock is also wrong when the devnet has paused: measured on
2026-10-28, it showed "15h ago" for events 8 h old.

The usual answer, The Graph (or Ponder, Envio, Subsquid, …), does not run on
QIP-55, because the chain differs from the EVM at the data layer. Each row is a
measured fact (`pauli-swap/docs/QRVM.md`) and what it forces on the indexer:

| QIP-55 fact | Breaks | Indexer consequence |
| --- | --- | --- |
| ABI words are 64 bytes; stack words are 512 bits | graph-node, ethers, viem all decode 32 byte words | decode with `@theqrl/web3` 1.0.3, the only client that encodes 64 byte words |
| Event topics are 64 bytes: keccak256 signature right padded, indexed values left padded | every EVM log filter, including web3 1.0.3's own validator | build `qrl_getLogs` filters by hand (§3.1) |
| Addresses are 64 bytes, rendered `Q` + 128 hex | `Address`/`Bytes20` types and 40 hex IDs everywhere | addresses stored as `bytea` behind an integer dictionary, rendered at the API (§7.1) |
| JSON-RPC namespace is `qrl_*` | graph-node and every EVM RPC client call `eth_*` | own RPC layer (§3) |
| CREATE2 is Keccak-512 over a `QRL-ADDR-v1` domain tag | subgraph templates that derive pair/pool addresses | discovery from factory events only (§4) |
| Public mapping getters keyed by `address`/`intN`/`bytesN` read the wrong slot (OC-V3-02) | any mapping handler that trusts `balanceOf` | balances derived from `Transfer` deltas (§5) |
| Block time ≈ 13 s, devnet regenerates from genesis | assumptions of a long-lived chain | regenesis detection and full reindex (§10) |

---

## 2. Architecture

```
  VPS ──────────────────────────────────────────────────────────
   gqrl (QIP-55) + beacon client        :8545
         │ (the node keeps every block and receipt: the log archive)
         ▼
   ┌──────────── indexer (one Node process) ────────────┐
   │ poll head → batch [cursor+1, head − CONFIRMATIONS]: │
   │   factory logs → new pools / tokens                 │
   │   new tokens: Transfer backfill from block 1        │
   │   logs of the watched set, headers, tx senders      │
   │   handlers, prices, rollups (in memory)             │
   │   one Postgres transaction + cursor                 │
   │                                                     │
   │ api: GraphQL + /health (read only)                  │◀── interface
   └───────────────────────────┬─────────────────────────┘
                               ▼
                           Postgres
```

There is no raw log table. Every batch reads logs from the node, applies them
in memory, and writes entity changes plus the cursor in one database
transaction, so a crash never leaves a half-applied batch. A handler fix is
deployed by `npm run reindex`: the node is the archive, and the whole devnet
history (1577 → 3373, 419 logs) re-indexes in about 4 s with 9 RPC calls.

Pools and tokens are kept in memory (one row each); balances, events and
rollups live in Postgres.

**Placement.** The indexer and its Postgres run on the VPS beside the node.
Development machines reach the node through the SSH tunnel or, for a small
devnet, the public proxy (`https://app.quantumark.fi/rpc/private-testnet`);
the proxy would rate limit a long backfill, so the VPS uses the node directly.
From inside Docker, see the network note in §13.

### Inputs

- `npm run sync:contracts` copies, like the interface's
  `scripts/sync-contracts.mjs`, the `build/qrvm` ABIs (`PauliV2Factory`,
  `PauliV2Pair`, `PauliV2SQRCTF1`, `WQRL`, `PauliV3Factory`, `PauliV3Pool`,
  `NonfungiblePositionManager`) and `deployments/devnet.json` (`chainId`,
  addresses, `startBlock`, `deployedAt`) into `src/contracts/`. Only
  `build/qrvm` is read; the 20 byte build in `build/hyperion` decodes 32 byte
  words and is wrong for this chain.
- `npm run sync:lib` copies the interface's `src/lib/v3.ts` into `src/lib/`
  (§8.5).

---

## 3. QRVM chain access

### 3.1 Log filters

As the interface's `src/lib/logs.ts` (`src/abi.ts`):

- topic0 = `encodeEventSignature(abiEvent)` (32 bytes) right padded to 64 bytes;
- the filter goes straight to `qrl_getLogs`, because web3 1.0.3's filter
  validator insists on 32 byte topics;
- web3 is used only for `abi.decodeLog(inputs, data, topics.slice(1))`, which
  returns addresses as `Q` + lowercase hex.

One `qrl_getLogs` call carries an address list (split at 200) and a topic0
list covering every event the handlers use. `Transfer` has one topic0 for
pair LP tokens, SQRC20 tokens, WQRL and the position manager (ERC-721 style,
4 topics), so logs dispatch on the emitting address's kind and the topic
count, not on the signature alone.

### 3.2 Transport

Measured on the devnet (gqrl `v0.3.3-stable-b92884a3`, 2026-10-28):

- Batched JSON-RPC (`src/rpc.ts`), at most 60 calls per POST; a batch of 60
  headers answers in ~0.3 s.
- `qrl_getLogs` ranges start at `LOG_RANGE` (20,000 blocks) and halve on an
  error until they pass. The whole devnet history from `startBlock` (529 logs,
  0.5 MB) comes back in one call in 0.6 s.
- Headers: `qrl_getBlockByNumber(n, false)`, only for blocks with pool events
  and the batch's last block. Senders: `qrl_getTransactionByHash`, only for
  transactions with pool events.
- Polling only: `qrl_blockNumber` every `POLL_MS` (4 s). No subscriptions,
  filters or `qrl_getBlockReceipts`.
- `finalized` and `safe` are real block tags on gqrl 0.3.3, but `finalized`
  trailed the head by 582 blocks (about 2 h) and `safe` by 475. Following them
  would make the indexer hours late, so it does not (§10).

### 3.3 The watched address set

1. Start: both factories and `WQRL`.
2. `PairCreated` / `PoolCreated` → the pair / pool and its two tokens.

Factory logs of a batch are read first, so a pool created inside the range is
watched for the rest of it. A token that joins at block `B` may have history
before it (a token minted before it was paired): its `Transfer` / `Deposit` /
`Withdrawal` logs from block 1 to the batch start are read and applied before
the batch, so balances and holder counts cover its whole life.

---

## 4. Pool discovery

The factory events are the only source of pair and pool addresses:

| Event | Gives |
| --- | --- |
| `PauliV2Factory.PairCreated(token0, token1, pair, allPairsLength)` | V2 pair (fee 3000) |
| `PauliV3Factory.PoolCreated(token0, token1, fee, tickSpacing, pool)` | V3 pool |

Addresses are never computed (CREATE2 on QIP-55 is Keccak-512 over a domain
tag). The audit (§15) checks that every factory event has a pool row.

---

## 5. OC-V3-02: do not trust getters

hypc `f570687a` generates public mapping getters that read the wrong storage
slot when the key is `address`, `intN` or `bytesN`. PauliSwap's own contracts
are fixed; any other token compiled with the same compiler may not be, and
its `balanceOf` can return 0 for an account that holds tokens. So:

- Token balances (`token_balances`) are derived from `Transfer`, plus
  `Deposit` / `Withdrawal` for WQRL, never read from `balanceOf`.
- A V3 pool's reserves are the pool's derived balances of its two tokens.
  This is what the interface shows as V3 TVL (it reads `balanceOf(pool)`), and
  it moves with Collect and Flash transfers as well as pool events.
- `balanceOf` is used only by the audit, as a cross-check (§15).

Tokens whose balances do not follow their `Transfer` events (rebasing tokens)
are out of scope; the audit would show the mismatch.

---

## 6. Block time and transaction sender

- Every pool event carries the real timestamp of its block. The interface
  prefers these over its interpolated clock (§12).
- V2 `Swap` / `Burn` name the router or recipient, not the wallet, so each
  transaction with a pool event stores its signer (`origin`), read once.

---

## 7. Data model

Schema `acorn` (`migrations/001_init.sql`, `002_usd.sql`); a regenesis drops and recreates it.

### 7.1 Conventions

- **Addresses**: stored once in `addresses(id int4, address bytea)`; every
  other table holds the `int4` id. The API renders `Q` + checksummed hex, the
  same form the node returns for transaction fields, and accepts any case and
  either `Q` / `q` on input.
- **Hashes**: `bytea(32)`, rendered `0x…`. Transactions are referenced by an
  `int8` id.
- **IDs**: pool and token IDs are addresses; an event ID is `txHash#logIndex`,
  computed by the API (event rows are keyed by `(block_number, log_index)`).
- **Raw amounts, reserves, supplies, liquidity, sqrt prices**: `numeric`,
  exact, from `bigint`. Values are typed `uint256` etc. in the contracts; the
  512 bit stack word does not widen them.
- **Prices and QRL values**: `float8`. The interface computes prices and
  values with JS numbers (`toFloat`, `priceFromSqrt`); the indexer uses the
  same math so both agree, rather than a more exact scheme the interface
  would not match.

### 7.2 Tables

| Table | Holds |
| --- | --- |
| `addresses` | address dictionary |
| `meta` | `chain_id`, `start_block`, `start_block_hash`, `deployed_at`, `v2_factory`, `rules` (§10), `cursor`, `cursor_hash` |
| `blocks` | `number`, `hash`, `timestamp`; only blocks with pool events, plus the cursor block |
| `tokens` | metadata (`decimals()` or `DECIMALS()`, the same for name and symbol), `total_supply`, `holder_count`, `derived_qrl`, `derived_usd` (`stable` only, §9), `first_block` |
| `token_balances` | `(token, account) → balance`; includes V2 LP tokens; a row is deleted at zero |
| `pools` | V2 pairs and V3 pools: tokens, fee, reserves, LP supply, `sqrt_price`, `tick`, `liquidity`, `raw_price`, `tvl_qrl`, `tracked`, running tracked / untracked volume, fees, tx count |
| `transactions` | `hash`, `block_number`, signer |
| `pool_events` | one table for all pool events, `kind` 0 swap, 1 add, 2 remove, 3 sync; amounts signed from the pool's point of view; `raw_price`, `amount_qrl`; monthly partitions |
| `pool_hour`, `pool_day` | volume (raw, tracked and untracked QRL), fees, swaps, raw price OHLC, closing reserves / supply / TVL; hour table partitioned by month |
| `token_hour`, `token_day` | QRL price OHLC; hour table partitioned by month |
| `predict_seasons`, `predict_markets`, `predict_trades`, `predict_claims`, `predict_quests`, `predict_xp_events` | PauliPredictXP / PredictMarket events (§8.6); wallets as `bytea` |
| `wrap_events`, `faucet_drips` | direct WQRL wraps and PauliSwap faucet drips, for quests (§8.6) |
| `qrl_usd` | QRL/USD over time, one series per source (`stable`, `coingecko`, `mexc`); §9 |

No table holds USD values. The API converts QRL values when it reads them
(§9), so changing the USD source needs no rebuild.

`pool_events` has the shape of the interface's `PoolEvent`, so the interface
maps rows one to one (§12). Indexes: primary keys, `(pool, block DESC,
log_index DESC)` on events, `(token, balance DESC)` on balances.

---

## 8. Handlers

Handlers port the interface's logic so both produce the same rows.

### 8.1 V2 pair

- `Sync`: reserves. Within a transaction, the last `Sync` of the pair prices
  its `Swap` / `Mint` / `Burn`; a `Sync` with nothing else in its transaction
  is stored as a price-only row (kind 3, zero amounts). This is `decodeV2` in
  the interface's `src/lib/history.ts`.
- `Swap`: amounts `in − out` per side, account = `to`.
- `Mint`: amounts positive. `Burn`: amounts negative, account = `to`.
- `Transfer` (LP token): LP balances and total supply. The pair locks
  `MINIMUM_LIQUIDITY` with `Transfer(0, 0, 1000)`, which counts as a mint.

### 8.2 V3 pool

- `Initialize`: `sqrtPriceX96`, `tick`.
- `Swap`: signed amounts, `sqrtPriceX96`, `tick`, `liquidity`; raw price
  `(sqrtPriceX96 / 2^96)^2`; account = `recipient`.
- `Mint` / `Burn`: when `tickLower ≤ tick < tickUpper`, active liquidity moves
  by `amount` (the upstream v3 subgraph rule). A `Burn` with both amounts 0 is
  the position manager poking a position before collecting fees and is not
  stored, as `decodeV3` skips it.
- Reserves: the pool's derived token balances (§5).

Pool state comes from events only; nothing reads past contract state.

### 8.3 Tokens

- `Transfer`: balances; from the zero address is a mint, to it a burn.
- `WQRL.Deposit` / `Withdrawal`: WQRL is WETH9 style; `deposit()` emits only
  `Deposit`, so these are its mints and burns.
- `holder_count`: accounts with a positive balance, the zero address excluded.

### 8.4 Pricing and values

At the end of every block that touches a pool:

- `Token.derived_qrl` from the price walk of §9.
- An event's `amount_qrl`: the input side for swaps, both sides for liquidity,
  at the prices after its block. `null` when a side has no price.
- Every pool's TVL in QRL and `tracked` flag, not only the pools the block
  touched, since both move with token prices.
- Volume of the touched pools: tracked or untracked (§9); fees
  (`volume × fee / 10^6`) on tracked volume; the hour / day rollups.
- With `USD_SOURCE=stable`: the QRL/USD anchor and each token's direct stable
  price (§9).

The interface still prices with its own live pool state; the indexer's QRL
values are for the API's rollups.

### 8.5 Code reuse

`src/lib/v3.ts` (`priceFromSqrt` and the rest of the V3 math) is copied from
the interface by `npm run sync:lib` with a header naming the source; the copy
is not edited by hand. The price walk is ported in `src/pricing.ts`, since
the interface's `registry.ts` depends on its RPC client. A shared package
(`@pauli-swap/sdk`) replaces the copies once the math is stable.

---

### 8.6 Predict and quests

Built 2026-10-28 from [PROPOSAL-PREDICT.md](PROPOSAL-PREDICT.md) step 1,
with one change: the module (`src/predict.ts`) runs on its **own cursor**
(`meta.predict_cursor`), right after each pool step and never past the pool
cursor, instead of inside the pool batch. Its identity is the two
deployment records synced by `npm run sync:predict`
(`src/contracts/predict-devnet.json`, `faucet-devnet.json`): when either
changes, only its tables are truncated and re-read from the earliest
`startBlock` (`003_predict.sql`). A regenesis drops them with the schema.

It reads PauliPredictXP, PredictMarket, the PauliSwap `QrlFaucet` (`Dripped`)
and WQRL `Deposit` / `Withdrawal` (a direct wrap names the wallet as
`dst` / `src`).

Quest rules live in `src/quests.ts`, driven by the catalogue
`pauli-swap-prediction-market/quests/catalog.json`, plus its gitignored
`quests/hidden.json` (installed from the private ops repo) when present:

- a wallet is the transaction signer for swaps and liquidity, the event user
  for Predict, `to` for drips;
- swaps count on tracked pools from `min` QRL; liquidity counts net of
  removals at the end of a completed UTC day; season tiers count days, never
  volume (the test-token faucet is unlimited);
- every window is clipped to the season (`SeasonStarted` to `endsAt`);
- hidden quests come back with null text until credited.

API: `quests`, `questProgress(user, day)`, `questQueue(day)`. The attester
(`pauli-swap-prediction-market/scripts/qrvm/attester.js`) credits
`questQueue`; season quests are queued only under today.

### 8.7 Sybil report

`npm run predict:sybil -- --season N` writes `sybil-season-N.json` for the
admin's review before prizes go out. It flags wallets; the admin decides and
edits `quests/denylist.json`. The detection rules are kept out of this public
repo so they cannot be gamed: the command loads `src/private/sybil.ts`
(gitignored), installed from the private ops repo, and fails without it.

## 9. Pricing

Base unit is QRL through WQRL, as in the interface. USD is a conversion of QRL
values, made when the API reads them, and is off on the devnet. It follows
Uniswap Labs' approach: canonical pool, stable or WETH route to USD,
filtering. (The original proposal, accepted and built on 2026-10-28, is in git
history as `docs/PROPOSAL-USD-PRICING.md`.)

### 9.1 QRL prices

- **Walk.** From WQRL outward, deepest pool first (the interface's
  `qrlPrices`). A step needs at least `MIN_QRL_LIQUIDITY` (1 QRL) on the side
  the price comes from. Devnet QRL comes from a faucet, so this keeps dust
  pools out but is no defence against an attacker; raise it once QRL has
  value.
- **Bridge whitelist.** Only WQRL, `STABLE_TOKENS` and `BRIDGE_TOKENS` carry a
  price on to other tokens. Any other token is priced from its pool with a
  bridge but prices nothing through itself, so a thin pool of an unknown token
  cannot pass a made-up price along. On the devnet with the defaults, five
  tokens that were priced through a non-bridge hop now have no QRL price: four
  tokens with the symbol `PAULI-V2` and STAR (via QUSD). Add a token to `BRIDGE_TOKENS` to
  restore such routes.

### 9.2 Tracked volume

A pool is **tracked** when both its tokens have a price and both sides hold at
least `MIN_QRL_LIQUIDITY` of value. A swap's `amount_qrl` counts towards
`volumeQRL` if the pool is tracked after the swap's block, and towards
`untrackedVolumeQRL` if it is not. Untracked volume is valued with whatever
price one side has, and is 0 when neither side has one. Fees follow tracked
volume only, as in the upstream subgraphs (`volumeUSD` / `untrackedVolumeUSD`),
so fee-to-volume ratios hold in rankings. `protocol` totals and the
`pools(orderBy: …)` rankings use tracked values; TVL totals count tracked
pools only.

### 9.3 QRL → USD

`USD_SOURCE` picks one of three sources:

- **`none`** (the default; the only correct setting on the devnet). Every USD
  field is `null`. Devnet QRL comes from a faucet and QUSD is a test token, so
  the market QRL price would produce numbers that look real and mean nothing.
- **`feed`**. `USD_FEED=coingecko` (id `quantum-resistant-ledger`) or `mexc`
  (`QRLUSDT`, a USDT price) polled every `USD_FEED_MINUTES` (5) into
  `qrl_usd`.
  - On start, and right after a rebuild (which drops the table), the feed
    backfills hourly points from an hour before `deployedAt`: CoinGecko
    `market_chart/range`, and MEXC 60 minute klines, keeping each candle's open
    and close.
  - A point older than `USD_FEED_MAX_AGE_HOURS` (6) counts as no price.
  - Failures back off up to an hour and show under `usd` in `/health`; they
    never stop indexing.
- **`stable`**. The anchor is the price of WQRL in the deepest WQRL /
  `STABLE_TOKENS` pool whose stable side holds at least `MIN_USD_LIQUIDITY`
  (10,000). The indexer writes it to series `stable` whenever it changes, and
  a point holds until the next one. A token with its own pool against a stable
  that deep takes its USD price from that pool (`tokens.derived_usd`) rather
  than through QRL. When `USD_FEED` is also set, the feed is a check: while the
  two differ by more than `USD_MAX_DEVIATION` (5%), `_meta.usdHidden` is true
  and every USD field is `null`.

Changing `MIN_QRL_LIQUIDITY`, `BRIDGE_TOKENS` or `STABLE_TOKENS`, or switching
to or from `stable`, rebuilds the index on the next start (§10).

### 9.4 Conversion when read

| Field | QRL value × QRL/USD at |
| --- | --- |
| `Token.derivedUSD`, `Pool.tvlUSD`, `protocol.tvlUSD` | now (`stable`: `derived_usd` first) |
| `PoolEvent.amountUSD` | the event's block time |
| hour / day rollups (`volumeUSD`, `feesUSD`, `tvlUSD`, `openUSD`…`closeUSD`) | the end of the period, or now for the current one |
| `Pool.volumeUSD`, `feesUSD`, `untrackedVolumeUSD`, the `protocol` sums | each day rollup at its day's end, summed |

Two approximations follow from this:

- A pool's running USD volume is priced by day, so it can differ slightly from
  the sum of its hour rows. If a day with volume has no price, the running
  total is `null`; it never silently leaves that day out.
- A USD candle is the QRL candle at one QRL/USD price. In `stable` mode it
  ignores a token's direct stable price.

### 9.5 Not built

Jump filter and TWAP pricing (skip a price step when a shallow pool's price
jumps more than `MAX_PRICE_JUMP` in one block, or price V3 tokens from
`observations`) are not built. With the whitelist and the minimum depth, a
false price needs real liquidity in a bridge pool; a TWAP also costs RPC reads
per block, which the event-only design avoids (§8.2). Revisit when QRL has
value.

`stable` is tested on the devnet with QUSD standing in for a stablecoin. That
checks the mechanics, not the numbers, until a real stablecoin is on chain.

---

## 10. Reorgs and regenesis

### Reorgs

- The indexer only indexes up to `head − CONFIRMATIONS` (default 3, about
  40 s; configurable 2–4, never 0). Proof of stake only gives absolute
  finality once a checkpoint is finalized, and on this devnet that is about
  580 blocks behind; at the tip, missed slots and competing proposals still
  cause 1–2 block reorgs.
- Before each batch it checks that the stored `cursor_hash` is still the
  node's hash at the cursor. If not, a reorg went deeper than the confirmation
  depth: the schema is dropped and rebuilt from the node. There is no
  per-block undo journal; on the devnet a full rebuild takes seconds, and such
  a reorg should not happen at 3 confirmations. Revisit if history grows
  enough that a rebuild takes minutes.

### Regenesis

On start and every `IDENTITY_CHECK_SEC` (120 s) the indexer compares `meta`
with the chain and the synced `devnet.json`:

- `qrl_chainId` differs from `devnet.json`'s `chainId`: wrong endpoint or
  tunnel. Indexing stops with an error; nothing is wiped.
- block hash at `startBlock` changed, `deployedAt` or the V2 factory in
  `devnet.json` changed, or head is below the cursor: a new chain. The schema
  is dropped (returning its disk space) and rebuilt from the new `startBlock`.
- `meta.rules` differs: the handler rules (`RULES_VERSION` in
  `src/indexer.ts`) or the pricing settings of §9 changed, so indexed history
  is computed under old rules. The schema is rebuilt the same way. Bump
  `RULES_VERSION` with any change that alters already-indexed values.

All four paths are tested (§15).

---

## 11. GraphQL API

`POST /graphql` (or `GET /graphql?query=…`), read only, plus `GET /health`.
The API is flat: fields return addresses as strings, not nested entities, so
no query fans out into per-row lookups. `first` is capped at 1000; page with
`skip`. Big integers are strings.

| Query | Returns |
| --- | --- |
| `_meta` | `block` (last indexed), `hash`, `timestamp`, `head`, `chainId`, `startBlock`, `hasIndexingErrors`, `lastError`, `usdSource`, `qrlPriceUSD`, `feedPriceUSD`, `usdDeviation`, `usdHidden` |
| `protocol` | `poolCount`, `trackedPoolCount`, `txCount`, `tvlQRL` / `tvlUSD` (tracked pools), `volumeQRL` / `volumeUSD`, `untrackedVolumeQRL` / `untrackedVolumeUSD`, `feesQRL` / `feesUSD` |
| `tokens(ids, first, skip)`, `token(id)` | metadata, `totalSupply`, `holderCount`, `derivedQRL`, `derivedUSD` |
| `pools(ids, token, version, orderBy, orderDirection, first, skip)`, `pool(id)` | tokens, fee, reserves, `totalSupply`, `sqrtPriceX96`, `tick`, `liquidity`, `rawPrice`, `tvlQRL` / `tvlUSD`, `tracked`, `volumeQRL` / `volumeUSD`, `untrackedVolumeQRL` / `untrackedVolumeUSD`, `feesQRL` / `feesUSD`, `txCount`. `orderBy`: `createdBlock` (ascending by default), `tvlQRL` (tracked pools first), `volumeQRL`, `txCount` (descending by default) |
| `poolEvents(pools, kinds, fromBlock, toBlock, fromTime, first, skip, orderDirection)` | `kind` (SWAP / ADD / REMOVE / SYNC), `block`, `logIndex`, `timestamp`, `txHash`, `origin`, `account`, `amount0`, `amount1`, `rawPrice`, `amountQRL`, `amountUSD` |
| `poolHourDatas`, `poolDayDatas(pool, from, to, first)` | rollups (§7.2), with `volumeUSD`, `untrackedVolumeQRL` / `untrackedVolumeUSD`, `feesUSD`, `tvlUSD` |
| `tokenHourDatas`, `tokenDayDatas(token, from, to, first)` | QRL price OHLC, and `openUSD` … `closeUSD` |
| `tokenHolders(token, first, skip)` | `account`, `balance`, largest first |
| `transaction(hash)` | `block`, `from` |

Every USD field is nullable: `null` with `USD_SOURCE=none`, while
`usdHidden` is true, or where no price covers the row's time (§9.4). A client
shows `$` only for non-null values.

Responses carry `Access-Control-Allow-Origin: CORS_ORIGIN`. Queries run with a
5 s statement timeout; request bodies are capped at 64 KB.

---

## 12. Interface integration

In `pauli-swap-interface`, behind `VITE_INDEXER_URL` (`src/lib/indexer.ts`).
The indexer is used only when it answers, reports no errors, and its
`_meta.block` is within `VITE_INDEXER_MAX_LAG` (20) blocks of the RPC head;
the check is cached for 4 s. Otherwise, or on any indexer error, every seam
falls back to the RPC code it replaced.

| Seam | With the indexer |
| --- | --- |
| `poolEvents` (`src/lib/history.ts`) | history up to the indexer's block from `poolEvents`; the few newer blocks still from `qrl_getLogs`, so pages stay current |
| `txSender` | primed with each event's `origin`; no per-row transaction fetch |
| `blockTime` (`src/state/app.tsx`) | exact timestamps learned from events, before the interpolated clock |
| `discover` (`src/lib/registry.ts`) | pool list from `pools`; the RPC scans cover only what came after the indexer's block |
| `useTokenFacts` (`src/hooks/explore.ts`) | `holderCount` instead of replaying every `Transfer` |

Unchanged, on RPC: live pool state (`loadState`: reserves, `slot0`,
liquidity), swap quotes and routing, wallet balances and allowances, V2 and V3
positions, `useV2Value`'s LP `Transfer` scan, all writes.

The indexer renders addresses checksummed; the interface lowercases fields
that stand in for log-decoded values (pool and token addresses, event
accounts), which is what web3 returns on the RPC path, so both paths display
identically.

---

## 13. Operations

- `docker compose up -d --build`: Postgres 16 and the indexer. Settings in
  `.env` (`.env.example`): `RPC_URL`, `POSTGRES_PASSWORD`, `CONFIRMATIONS`,
  `LOG_RANGE`, `POLL_MS`, `MIN_QRL_LIQUIDITY`, `BRIDGE_TOKENS`,
  `HOUR_DATA_DAYS`, `EVENT_DAYS`, `DISK_MIN_FREE_GB`, `CORS_ORIGIN`,
  `API_BIND`, `API_PORT`, and for USD (§9) `USD_SOURCE`, `USD_FEED`,
  `USD_FEED_MINUTES`, `USD_FEED_MAX_AGE_HOURS`, `STABLE_TOKENS`,
  `MIN_USD_LIQUIDITY`, `USD_MAX_DEVIATION`. The compose file passes each one
  through by name, so a new setting needs a line there too.
- **Docker network on the VPS.** A container on the bridge network cannot
  reach a gqrl that listens on `127.0.0.1` only. Either gqrl listens on the
  docker bridge address and `RPC_URL=http://host.docker.internal:8545` (mapped
  in the compose file), or the indexer service uses `network_mode: host`
  (Linux only) with `RPC_URL=http://127.0.0.1:8545`.
- The API is published on `API_BIND` (default `127.0.0.1`); put nginx in front
  of it, or serve it same origin next to the interface's `/rpc`. Set
  `CORS_ORIGIN` to the interface's origin when it is called cross origin.
- Commands (outside Docker): `npm run dev`, `npm run build && npm start`,
  `npm run migrate`, `npm run reindex`, `npm run audit` (§15),
  `npm run sync:contracts`, `npm run sync:lib`.
- **Reindex** drops the schema; the next start rebuilds it from the node. Stop
  the indexer first, since a running one does not expect its tables to
  vanish: `docker compose stop indexer && docker compose run --rm --no-deps
  indexer node dist/cli.js reindex && docker compose start indexer`.
- `POSTGRES_PASSWORD` is applied when the volume is first created; changing it
  later needs `docker compose down -v` (which deletes the data; a reindex
  rebuilds it).
- `GET /health`: head, cursor, lag, paused / last error, RPC calls, the USD
  feed's last poll and error (not part of `ok`), database size, the five
  largest tables, free disk on the Postgres volume.
- Logs: one JSON line per batch (range, logs, events, new pools / tokens, RPC
  calls, ms) and per error; both containers rotate at 10 MB × 3.
- **Disk guard.** The Postgres volume is mounted read only into the indexer
  (`DISK_PATH`). Below `DISK_MIN_FREE_GB` (5) of free space, indexing pauses
  and `/health` reports it; the API keeps serving. A full disk can corrupt
  the node's database; the indexer must never be what fills it.

---

## 14. Storage on the VPS

The rule: store nothing the node already keeps and nothing the API does not
serve.

| Data | Policy |
| --- | --- |
| raw logs | not stored; the node keeps every receipt and the indexer re-reads them on a rebuild |
| blocks | only blocks with pool events, plus the cursor block (the previous cursor row is dropped when nothing points at it) |
| transactions | only those with pool events; hash, block, signer |
| decoded log arguments | not stored; handlers keep what the API serves |
| addresses | once each, `bytea`; everything else holds a 4 byte id |
| `token_balances` | a row is deleted when its balance returns to zero |
| `pool_events` | monthly partitions; kept forever by default, `EVENT_DAYS` drops older months |
| hour rollups | monthly partitions; `HOUR_DATA_DAYS` (90) |
| day rollups | kept; one row per pool / token per active day |

Retention runs hourly and drops whole partitions; it never runs a large
`DELETE`, whose dead rows would stay on disk until vacuum.

Measured after indexing the devnet (17 pools, 12 tokens, 85 events): the
whole database is 9 MB, nearly all of it Postgres's fixed catalog; the
largest table (`pool_events_202610`) is 80 KB. Row sizes per event are about
150–200 bytes plus index, against roughly 0.9 KB with `Q` + 128 hex text keys.

Postgres runs with `wal_level=minimal`, `max_wal_senders=0`,
`archive_mode=off`, `max_wal_size=256MB`, `wal_compression=on`,
`default_toast_compression=lz4`, `shared_buffers=128MB`.

Not on the VPS: an archive node (`--gcmode archive`), which would grow the
node's state without bound and which nothing here needs; and database
backups, since `npm run reindex` rebuilds everything from the node.

---

## 15. Verification

`npm run audit` (`scripts/audit.ts`) compares the API with the chain at the
indexer's `_meta.block` (a pruned node still serves state that recent) and
exits 1 on any mismatch:

1. every factory `PairCreated` / `PoolCreated` has a pool row;
2. per pool and kind, event rows equal the raw `qrl_getLogs` counts under the
   interface's rules (zero V3 burns skipped, uncovered V2 syncs kept);
3. V2 reserves and LP `totalSupply` equal `getReserves()` / `totalSupply()`;
   V3 `sqrtPriceX96`, `tick`, `liquidity` equal `slot0()` / `liquidity()`,
   and reserves equal `balanceOf(pool)` of both tokens;
4. per token, `totalSupply` equals `totalSupply()`, `holderCount` equals the
   holder rows, and every derived holder balance equals `balanceOf`;
5. a sample of 40 events: `origin` equals the transaction's `from`;
6. valuation against the API's own prices, since USD is not on chain:
   - every pool's `tvlQRL` equals its reserves at the current `derivedQRL`;
   - `tracked` follows §9.2 (run the audit with the indexer's
     `MIN_QRL_LIQUIDITY`);
   - `tvlUSD` equals `tvlQRL × qrlPriceUSD`;
   - `protocol` TVL and tracked count match the pools.

Results on the devnet (2026-10-28): 236 / 236 checks pass. The first run
found the `MINIMUM_LIQUIDITY` mint (§8.1), now fixed. Check 6 was added with
USD pricing. It is how stale TVL was found and fixed: a pool's TVL used to be
recomputed only when the pool itself had an event, so it lagged price moves
elsewhere (QUSD/ACRN showed 236 QRL instead of 203).

USD modes, run on the devnet for their mechanics only (2026-10-28):

- **`none`**: every USD field is `null`.
  - Tracked plus untracked volume equals the earlier single volume for every
    pool whose tokens kept their price.
  - Changing the settings triggered the rule-change rebuild.
- **`feed` (CoinGecko, then MEXC)**:
  - `qrl_usd` was backfilled from before the first event; every one of the 85
    events has a price.
  - An event's `amountUSD` and an hour row's `volumeUSD` use the price at
    their own time (about 1.215), not the latest (1.23).
- **`stable` with QUSD standing in**:
  - QRL anchors at 25 QUSD, and QUSD prices at 1.
  - ACRN takes its direct QUSD price (0.452, against 0.512 through QRL).
  - With MEXC as the check and `USD_MAX_DEVIATION=0.0001`, `usdHidden` turns
    true and every USD field is `null`.
  - A rebuild drops `qrl_usd`; the feed refills it within seconds.

Also run:

- **Wrong chain**: pointed at a local gqrl with chain id 1337, the indexer
  stops with `RPC chain id 1337 is not devnet.json's 3151908` and keeps its
  data.
- **Regenesis**: a forged `start_block_hash` triggers "regenesis detected",
  a drop and a full rebuild.
- **Reorg**: a forged `cursor_hash` triggers "reorg below the confirmation
  depth" and a full rebuild.
- **Interface parity** (`scripts/ui-compare.mjs`): Playwright renders Explore
  (tokens, pools, transactions), a pool page and a token page from two
  builds, with and without `VITE_INDEXER_URL`, and diffs the visible text.
  Every number is identical. The differences are relative times, where the
  indexer's exact timestamps replace the interpolated clock ("8h ago" against
  a wrong "15h ago"), and, as a result, the hour buckets of the pool page's
  "Volume · past day" chart (same total, different axis ticks). With the
  indexer stopped, the indexer build renders exactly like the RPC build.
- **Load time** (`scripts/ui-timing.mjs`; median of 3, Chromium, public devnet
  proxy for RPC): Explore
  transactions 3.8 s → 2.0 s, pool page 3.5 s → 2.0 s, Explore tokens
  3.2 s → 2.1 s, Explore pools 2.8 s → 2.1 s, token page 2.7 s → 2.0 s. The
  devnet is 1,800 blocks old, so the RPC path still needs one `qrl_getLogs`
  per pool; its cost grows with history and the indexer's does not.

---

## 16. Not built yet, and open questions

Not in v1:

- V3 positions (`NonfungiblePositionManager` events, `positions(tokenId)`),
  V2 liquidity positions and position snapshots; the interface reads these
  from RPC.
- `Tick` entities, `Collect` / `Flash` event rows, protocol-wide day data.
- The sampled `balanceOf` cross-check inside the indexer (`getterSuspect`)
  and tip reconciliation with `slot0()`; the audit covers both offline.
- Subgraph-style `where` filters and time travel in the API.
- Price jump filter and V3 TWAP pricing (§9.5).
- `$` display in the interface; the USD field names in §11 are now settled.
- The Predict season-end ranking export ([PROPOSAL-PREDICT.md](PROPOSAL-PREDICT.md)
  §4.3); ingestion and quests are built (§8.6).

Open:

- VPS disk size, current use by gqrl and the beacon client, and growth per
  day; this sets `DISK_MIN_FREE_GB`, `EVENT_DAYS` and `HOUR_DATA_DAYS`.
- How gqrl is bound on the VPS (127.0.0.1 or the docker bridge), which picks
  the network option in §13.
