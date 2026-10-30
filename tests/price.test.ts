// The Yes price replay behind predictPriceHistory (src/predict.ts). No database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { poolDelta, priceHistory, priceYesOf } from '../src/predict.js';

const XP = 10n ** 18n;
const L = 100n * XP;

test('poolDelta follows PredictMarket.buy / sell', () => {
  // buy Yes: the Yes pool moves by xp - shares, the No pool by xp.
  assert.deepEqual(poolDelta({ side: 0, outcome: 0, xp: 10n, shares: 18n }), [-8n, 10n]);
  assert.deepEqual(poolDelta({ side: 0, outcome: 1, xp: 10n, shares: 18n }), [10n, -8n]);
  // a sell undoes the buy it mirrors.
  assert.deepEqual(poolDelta({ side: 1, outcome: 0, xp: 10n, shares: 18n }), [8n, -10n]);
});

test('priceHistory replays the pools from the opening liquidity', () => {
  const trade = (block: number, logIndex: number, side: number, outcome: number, xp: bigint, shares: bigint) => ({ block, logIndex, ts: block * 10, side, outcome, xp, shares });
  // Given out of order: the replay sorts by block and log index.
  const points = priceHistory(L, [trade(5, 0, 1, 0, 10n * XP, 18n * XP), trade(3, 1, 0, 0, 10n * XP, 18n * XP)]);
  assert.deepEqual(points.map((p) => p.block), [3, 5]);
  assert.equal(points[0].priceYes, priceYesOf(L - 8n * XP, L + 10n * XP));
  assert.ok(points[0].priceYes > 0.5, 'buying Yes raises its price');
  assert.equal(points[1].priceYes, 0.5, 'selling the same shares returns to the opening price');
  assert.equal(points[1].timestamp, 50);
});
