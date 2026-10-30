// The season ranking replay (src/season.ts), against PredictMarket.claim and
// the scoring of PROPOSAL-PREDICT.md §4. No database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Claim, claimableOf, Market, positions, rank, RankInput, Trade, winnersOf, XpEvent, ZERO_WALLET } from '../src/season.js';

const DAY = 86400;
const XP = 10n ** 18n;
const A = 'a'.repeat(128);
const B = 'b'.repeat(128);
const C = 'c'.repeat(128);
const season = { id: 1, startedTs: 10 * DAY, endsAt: 40 * DAY };

let logIndex = 0;
const buy = (block: number, wallet: string, market: number, outcome: number, shares: bigint, ts = 11 * DAY): Trade => ({ block, logIndex: logIndex++, ts, market, wallet, side: 0, outcome, shares });
const sell = (block: number, wallet: string, market: number, outcome: number, shares: bigint, ts = 11 * DAY): Trade => ({ ...buy(block, wallet, market, outcome, shares, ts), side: 1 });
const claim = (block: number, wallet: string, market: number): Claim => ({ block, logIndex: logIndex++, market, wallet });
const xp = (block: number, wallet: string, amount: bigint, s = 1): XpEvent => ({ block, logIndex: logIndex++, wallet, season: s, amount });
const market = (id: number, status: number, outcome: number | null, settledBlock: number | null): Market => ({ id, status, outcome, createdBlock: 1, settledBlock });
const input = (over: Partial<RankInput>): RankInput => ({ season, block: 100, markets: [], trades: [], claims: [], xp: [], quests: [], rules: { minDays: 0, minMarkets: 0 }, ...over });
const byUser = (rows: ReturnType<typeof rank>) => new Map(rows.map((r) => [r.user, r]));

test('claimableOf follows PredictMarket.claim', () => {
  const resolvedYes = market(0, 1, 0, 5);
  assert.equal(claimableOf(resolvedYes, 1, { yes: 7n, no: 3n }), 7n);
  assert.equal(claimableOf(market(0, 1, 1, 5), 1, { yes: 7n, no: 3n }), 3n);
  assert.equal(claimableOf(market(0, 2, null, 5), 2, { yes: 7n, no: 4n }), 5n, 'cancelled: (yes + no) / 2, rounded down');
  assert.equal(claimableOf(resolvedYes, 0, { yes: 7n, no: 3n }), 0n, 'open: nothing');
});

test('a cancelled market pays per position, divided before summing', () => {
  // 3 / 2 + 3 / 2 = 2, not (3 + 3) / 2 = 3.
  const rows = rank(input({ markets: [market(0, 2, null, 50), market(1, 2, null, 50)], trades: [buy(10, A, 0, 0, 3n), buy(11, A, 1, 1, 3n)] }));
  assert.equal(rows[0].claimable, 2n);
});

test('positions net buys and sells, and a claim empties them', () => {
  const trades = [buy(10, A, 0, 0, 10n * XP), sell(12, A, 0, 0, 4n * XP), buy(13, A, 0, 1, 2n * XP)];
  assert.deepEqual(positions(trades, []), [{ market: 0, wallet: A, yes: 6n * XP, no: 2n * XP }]);
  assert.deepEqual(positions(trades, [claim(60, A, 0)]), [{ market: 0, wallet: A, yes: 0n, no: 0n }]);
});

test('score is xp plus claimable on markets settled at B', () => {
  const markets = [market(0, 1, 0, 50), market(1, 1, 1, 150)];
  const trades = [buy(10, A, 0, 0, 5n), buy(11, A, 1, 1, 9n), buy(12, B, 0, 1, 4n)];
  const rows = byUser(rank(input({ markets, trades, xp: [xp(5, A, 100n), xp(10, A, -10n), xp(11, A, -10n), xp(5, B, 50n)] })));
  assert.equal(rows.get(A)!.claimable, 5n, 'market 1 is still open at B');
  assert.equal(rows.get(A)!.score, 85n);
  assert.equal(rows.get(B)!.claimable, 0n, 'B lost');
});

test('only the season’s xp counts', () => {
  const rows = rank(input({ xp: [xp(5, A, 100n, 1), xp(6, A, 70n, 2)] }));
  assert.equal(rows[0].xp, 100n);
});

test('rows after B are ignored', () => {
  const rows = rank(input({ block: 20, markets: [market(0, 1, 0, 15)], trades: [buy(10, A, 0, 0, 5n)], claims: [claim(30, A, 0)], xp: [xp(5, A, 10n), xp(30, A, 5n)] }));
  assert.equal(rows[0].xp, 10n);
  assert.equal(rows[0].claimable, 5n);
});

test('claiming does not change the score or the block it was reached', () => {
  const markets = [market(0, 1, 0, 50)];
  const trades = [buy(10, A, 0, 0, 5n)];
  const before = rank(input({ markets, trades, xp: [xp(5, A, 20n), xp(10, A, -5n)] }))[0];
  // claim: XPCredited, then Claimed, in one transaction.
  const after = rank(input({ markets, trades, xp: [xp(5, A, 20n), xp(10, A, -5n), xp(70, A, 5n)], claims: [claim(70, A, 0)] }))[0];
  assert.equal(before.score, 20n);
  assert.equal(after.score, 20n);
  assert.equal(before.reachedBlock, 50, 'the settlement set the score');
  assert.equal(after.reachedBlock, 50);
});

test('a tie goes to the wallet that reached the score first', () => {
  const rows = rank(input({ xp: [xp(9, B, 30n), xp(7, A, 30n), xp(8, C, 31n)] }));
  assert.deepEqual(rows.map((r) => [r.user, r.rank]), [[C, 1], [A, 2], [B, 3]]);
});

test('eligibility counts active days and markets inside the season', () => {
  const day = (d: number) => d * DAY + 100;
  const trades = [buy(10, A, 0, 0, 1n, day(11)), buy(11, A, 1, 0, 1n, day(12)), sell(12, A, 1, 0, 1n, day(12)), buy(13, A, 2, 0, 1n, day(45)), buy(2, A, 3, 0, 1n, day(5)), sell(14, A, 3, 0, 1n, day(13))];
  const quests = [{ block: 9, ts: day(10), wallet: A }, { block: 14, ts: day(13), wallet: A }, { block: 1, ts: day(5), wallet: A }];
  const [row] = rank(input({ trades, quests, rules: { minDays: 4, minMarkets: 2 } }));
  assert.equal(row.activeDays, 4, 'days 10, 11, 12, 13; day 5 and day 45 are outside the season');
  assert.equal(row.marketsTraded, 2, 'market 2 was traded after endsAt; market 3 was only sold in the season');
  assert.equal(row.eligible, true);
  assert.equal(rank(input({ trades, quests, rules: { minDays: 5, minMarkets: 2 } }))[0].eligible, false);
});

test('denied wallets get no rank and no prize; winners are padded', () => {
  const rows = rank(input({ xp: [xp(5, A, 100n), xp(5, B, 50n), xp(5, C, 10n)], denied: new Set([A]) }));
  assert.deepEqual(rows.map((r) => [r.user, r.rank]), [[B, 1], [C, 2], [A, null]]);
  assert.deepEqual(winnersOf(rows), [B, C, ZERO_WALLET]);
  const strict = rank(input({ xp: [xp(5, A, 100n), xp(5, B, 50n)], rules: { minDays: 1, minMarkets: 0 } }));
  assert.deepEqual(winnersOf(strict), [ZERO_WALLET, ZERO_WALLET, ZERO_WALLET], 'nobody had an active day');
});

test('eligibleRank counts eligible wallets only, skipping the denied', () => {
  const q = (w: string) => ({ block: 1, ts: 11 * DAY, wallet: w });
  const rows = rank(input({ xp: [xp(5, A, 100n), xp(5, B, 50n), xp(5, C, 10n)], quests: [q(A), q(C)], denied: new Set([A]), rules: { minDays: 1, minMarkets: 0 } }));
  assert.deepEqual(rows.map((r) => [r.user, r.rank, r.eligibleRank]), [[B, 1, null], [C, 2, 1], [A, null, null]]);
});

test('settle(id, users[]): every Claimed of one transaction empties its position', () => {
  // One settle transaction at block 70: XPCredited then Claimed per user,
  // consecutive log indexes in one block.
  const markets = [market(0, 1, 0, 50)];
  const trades = [buy(10, A, 0, 0, 5n), buy(11, B, 0, 0, 3n), buy(12, C, 0, 1, 4n)];
  const claims = [A, B, C].map((w) => claim(70, w, 0));
  assert.deepEqual(positions(trades, claims).map((p) => [p.wallet, p.yes, p.no]), [[A, 0n, 0n], [B, 0n, 0n], [C, 0n, 0n]]);
  const before = byUser(rank(input({ markets, trades })));
  const after = byUser(rank(input({ markets, trades, claims, xp: [xp(70, A, 5n), xp(70, B, 3n)] })));
  for (const w of [A, B, C]) {
    assert.equal(after.get(w)!.claimable, 0n);
    assert.equal(after.get(w)!.score, before.get(w)!.score);
    assert.equal(after.get(w)!.reachedBlock, before.get(w)!.reachedBlock);
  }
});
