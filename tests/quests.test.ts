// Quest rules (src/quests.ts) on a small fixed database. Needs Postgres:
// TEST_DATABASE_URL, used with its own schema (acorn_test), which the test
// drops and recreates; skipped without it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Quest } from '../src/quests.js';

const url = process.env.TEST_DATABASE_URL;
if (url) {
  process.env.DATABASE_URL = url;
  process.env.DB_SCHEMA = process.env.DB_SCHEMA || 'acorn_test';
}
const skip = url ? false : 'TEST_DATABASE_URL is not set';

const { createPool, ensurePartition, resetSchema, SCHEMA } = await import('../src/db.js');
const { Quests } = await import('../src/quests.js');
if (url && SCHEMA === 'acorn') throw new Error('refusing to run the tests on the live schema acorn');

const DAY = 86400;
const D0 = 20_000; // the season's first UTC day
const at = (day: number, sec = 3600) => (D0 + day) * DAY + sec;
const XP = 10n ** 18n;
const QRL = 10n ** 18n;
const W = Buffer.alloc(64, 0xaa);
const V = Buffer.alloc(64, 0xbb);
const user = (b: Buffer) => 'Q' + b.toString('hex');
const window = { from: at(0, 0), to: at(10, 0) };
const quest = (rule: string, target: number, min?: number): Quest => ({ id: 900, kind: 'season', rule, target, min, xp: 10, title: rule, detail: rule });

const db = url ? createPool(2) : null!;

before(async () => {
  if (!url) return;
  await resetSchema(db);
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
  await q(`INSERT INTO predict_seasons (id, ends_at, started_ts, started_block) VALUES (1, $1, $2, 1)`, [at(10, 0), at(0, 0)]);

  // Addresses 1 W, 2 V, 3 tracked pool, 4 untracked pool, 5 / 6 tokens.
  for (const a of [W, V, Buffer.alloc(64, 1), Buffer.alloc(64, 2), Buffer.alloc(64, 5), Buffer.alloc(64, 6)]) await q(`INSERT INTO addresses (address) VALUES ($1)`, [a]);
  await q(`INSERT INTO pools (id, version, token0_id, token1_id, fee, tick_spacing, created_block, updated_block, tracked) VALUES (3, 2, 5, 6, 3000, 0, 1, 1, true), (4, 2, 5, 6, 3000, 0, 1, 1, false)`);
  await q(`INSERT INTO transactions (hash, block_number, from_id) SELECT decode(lpad(to_hex(n), 64, '0'), 'hex'), n, CASE WHEN n < 100 THEN 1 ELSE 2 END FROM generate_series(1, 120) n`);
  await ensurePartition(db, 'pool_events', at(-2));
  await ensurePartition(db, 'pool_events', at(9));
  // kind 0 swap, 1 add, 2 remove; tx id = block.
  const ev = (block: number, ts: number, pool: number, kind: number, qrl: number) =>
    q(`INSERT INTO pool_events (ts, block_number, log_index, pool_id, kind, tx_id, amount0, amount1, amount_qrl) VALUES ($1, $2::int4, 0, $3, $4, $2::int8, 0, 0, $5)`, [ts, block, pool, kind, qrl]);
  await ev(1, at(-1), 3, 0, 5); // before the season
  await ev(2, at(0), 3, 0, 2); // counts
  await ev(3, at(1), 3, 0, 0.5); // under min
  await ev(4, at(2), 4, 0, 5); // untracked pool
  await ev(5, at(3), 3, 0, 3); // counts
  await ev(6, at(3, 7200), 3, 0, 3); // same day again
  await ev(101, at(4), 3, 0, 9); // V's swap
  // Liquidity: net 5 at the end of day 0, 11 at the end of day 1.
  await ev(7, at(0), 3, 1, 15);
  await ev(8, at(0, 7200), 3, 2, 10);
  await ev(9, at(1), 3, 1, 6);

  await q(`INSERT INTO predict_quests VALUES (10, 0, $1, $3, 0, $5, 10), (11, 0, $2, $3, 0, $6, 10), (12, 0, $1, $4, 0, $5, 10)`, [at(0), at(2), W, V, D0, D0 + 2]);
  await q(`INSERT INTO predict_markets (id, question, close_time, liquidity, status, outcome, created_block, settled_block) VALUES
             (0, 'a', 0, 1, 1, 0, 1, 40), (1, 'b', 0, 1, 2, NULL, 1, 40), (2, 'c', 0, 1, 0, NULL, 1, NULL)`);
  const trade = (block: number, ts: number, market: number, side: number, xp: bigint) =>
    q(`INSERT INTO predict_trades (block_number, log_index, ts, market, wallet, side, outcome, xp, shares) VALUES ($1, 0, $2, $3, $4, $5, 0, $6, $6)`, [block, ts, market, W, side, xp.toString()]);
  await trade(20, at(0), 0, 0, 10n * XP);
  await trade(21, at(1), 1, 0, 5n * XP); // under min
  await trade(22, at(1, 7200), 2, 0, 12n * XP);
  await trade(23, at(2), 0, 1, 20n * XP); // a sell is not a prediction
  await q(`INSERT INTO predict_claims (block_number, log_index, ts, market, wallet, xp) VALUES (50, 0, $1, 0, $2, 1), (51, 0, $1, 1, $2, 1)`, [at(5), W]);
  await q(`INSERT INTO wrap_events VALUES (30, 0, $1, $2, 0, $3), (31, 0, $1, $2, 1, $4)`, [at(1), W, (QRL / 2n).toString(), (2n * QRL).toString()]);
  await q(`INSERT INTO faucet_drips VALUES (32, 0, $1, $2, $3)`, [at(1), W, (50n * QRL).toString()]);
});

after(async () => {
  if (!url) return;
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
});

test('season rules', { skip }, async () => {
  const quests = new Quests(db);
  const m = (rule: string, min?: number, today = D0 + 9) => quests.measure(quest(rule, 1, min), W, window, today);
  assert.equal(await m('days:check_in'), 2);
  assert.equal(await m('days:swap', 1), 2, 'tracked pools, from min QRL, once a day, inside the season');
  assert.equal(await m('days:predict_buy', 10), 2, 'buys of at least 10 XP on days 0 and 1');
  assert.equal(await m('predict_markets', 10), 2, 'markets 0 and 2');
  assert.equal(await m('predict_win'), 1, 'a claim on a cancelled market is not a win');
  assert.equal(await m('wrap', 1), 1);
  assert.equal(await m('faucet'), 1);
  assert.equal(await m('lp_net', 10), 1, 'net 11 QRL at the end of day 1');
  assert.equal(await m('lp_net', 10, D0 + 1), 0, 'day 1 is not over yet');
  assert.equal(await m('lp_net', 12), 0);
});

test('daily rules are clipped to their day', { skip }, async () => {
  const quests = new Quests(db);
  const day = (d: number) => ({ from: at(d, 0), to: at(d + 1, 0) });
  assert.equal(await quests.measure(quest('swap', 1, 1), W, day(0), D0 + 9), 1);
  assert.equal(await quests.measure(quest('swap', 1, 1), W, day(1), D0 + 9), 0);
  assert.equal(await quests.measure(quest('predict_buy', 1, 10), W, day(2), D0 + 9), 0);
});

test('a hidden quest stays hidden until the wallet is credited', { skip }, async () => {
  const hidden: Quest = { id: 201, kind: 'season', hidden: true, rule: 'faucet', target: 1, xp: 77, action: 'faucet', title: 'Secret', detail: 'Use the faucet' };
  const quests = new Quests(db, [hidden]);
  const now = at(6);
  const [before] = await quests.progress(user(W), D0 + 6, now);
  assert.equal(before.met, true);
  assert.equal(before.credited, false);
  assert.deepEqual([before.title, before.detail, before.xp, before.action, before.target, before.progress], [null, null, null, null, null, null]);
  // The attester still sees it, with its XP.
  assert.deepEqual(
    (await quests.queue(D0 + 6, now)).filter((c) => c.user === user(W)),
    [{ user: user(W), questId: 201, day: D0 + 6, xp: 77, kind: 'season' }],
  );

  await db.query(`INSERT INTO predict_quests VALUES (60, 0, $1, $2, 201, $3, 77)`, [at(6), W, D0 + 6]);
  const [after] = await quests.progress(user(W), D0 + 6, now);
  assert.equal(after.credited, true);
  assert.deepEqual([after.title, after.detail, after.xp, after.target, after.progress], ['Secret', 'Use the faucet', 77, 1, 1]);
  const [other] = await quests.progress(user(V), D0 + 6, now);
  assert.equal(other.title, null, 'another wallet still sees it hidden');
});
