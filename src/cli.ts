import fs from 'node:fs';
import { checksum, hex, render } from './address.js';
import { config } from './config.js';
import { createPool, migrate, resetSchema } from './db.js';
import { readDenylist } from './denylist.js';
import { log } from './log.js';
import { hexNum, Rpc } from './rpc.js';
import { DEFAULT_RULES, predictCursor, seasonRow, standings, winnersOf } from './season.js';

/// `migrate`: apply migrations. `reindex`: drop everything; the next start
/// backfills from startBlock, re-reading logs from the node (§14).
/// `sybil [--season N] [--out file]`: the season sybil report (§8.7). Its
/// code is not in this repo; it loads `src/private/sybil.ts` when installed.
/// `snapshot --block B [--season N] …`: the season-end ranking (§8.8), read
/// only; exits 2 on a warning unless `--force`.
const command = process.argv[2];
// A variable, so tsc does not look for a module that is absent from the repo.
const SYBIL: string = './private/sybil.js';
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(name);
const num = (name: string, fallback?: number) => {
  const v = arg(name);
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a whole number, got ${v}`);
  return Number(v);
};
const loadSybil = () =>
  import(SYBIL).catch(() => {
    throw new Error('the sybil report is not installed: copy it into src/private/ from the private ops repo');
  });

const db = createPool(1);
try {
  if (command === 'migrate') await migrate(db);
  else if (command === 'reindex') await resetSchema(db);
  else if (command === 'sybil') {
    const season = arg('--season');
    const { sybilReport } = await loadSybil();
    const report = await sybilReport(db, new Rpc(config.rpcUrl), season ? Number(season) : undefined);
    const out = arg('--out') ?? `sybil-season-${report.season}.json`;
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    log('info', 'sybil report written', { out });
  } else if (command === 'snapshot') await snapshot();
  else throw new Error(`unknown command ${command}; use migrate, reindex, sybil or snapshot`);
  if (command === 'migrate' || command === 'reindex') log('info', `${command} done`);
} finally {
  await db.end();
}

/// Every address string in the sections of a sybil report that flag wallets.
function flaggedBy(report: Record<string, unknown>) {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string' && /^Q[0-9a-fA-F]{128}$/.test(v)) out.add(hex(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const key of ['fundingClusters', 'sharedIp', 'funnels']) walk(report[key]);
  return out;
}

async function snapshot() {
  const rpc = new Rpc(config.rpcUrl);
  const season = await seasonRow(db, num('--season'));
  if (!season) throw new Error(`season ${arg('--season') ?? ''} not indexed`);
  const cursor = await predictCursor(db);
  const block = num('--block');
  if (block === undefined) throw new Error('--block is required: the snapshotBlock passed to closeSeason');
  const rules = { minDays: num('--min-days', DEFAULT_RULES.minDays)!, minMarkets: num('--min-markets', DEFAULT_RULES.minMarkets)! };
  const warnings: string[] = [];

  const header = await rpc.call<{ timestamp: string } | null>('qrl_getBlockByNumber', [hexNum(block), false]);
  if (!header) throw new Error(`block ${block} is past the chain head`);
  const blockTime = Number(header.timestamp);

  // quests/denylist.json is edited by the admin after the sybil review, so it
  // is read where it lives, at the time of the snapshot.
  const denylistPath = arg('--denylist') ?? '../pauli-swap-prediction-market/quests/denylist.json';
  const denied = readDenylist(denylistPath);
  if (!fs.existsSync(denylistPath)) warnings.push(`no denylist at ${denylistPath}: nobody is excluded`);

  let flagged = new Set<string>();
  if (!flag('--no-sybil')) {
    const sybil = await import(SYBIL).catch(() => null);
    if (sybil) flagged = flaggedBy(await sybil.sybilReport(db, rpc, season.id));
    else warnings.push('the sybil report is not installed: no wallet is flagged');
  }

  const { rows, openMarkets } = await standings(db, season, block, rules, denied);
  const winners = winnersOf(rows);

  if (block > cursor) warnings.push(`block ${block} is past the Predict cursor ${cursor}: later rows are missing`);
  if (blockTime < season.endsAt) warnings.push(`block ${block} (${new Date(blockTime * 1000).toISOString()}) is before the season ends (endsAt ${season.endsAt}): scores can still change`);
  if (openMarkets.length) warnings.push(`markets still open at block ${block}: ${openMarkets.join(', ')}; they add nothing to claimable`);
  const eligible = rows.filter((r) => r.eligible && !r.denied).length;
  if (eligible < 3) warnings.push(`only ${eligible} eligible wallet(s): winners are padded with the zero address`);
  for (const w of winners) if (flagged.has(w)) warnings.push(`winner ${checksum(render(w))} is flagged by the sybil report`);
  if (season.closedBlock !== null) warnings.push(`season ${season.id} is already closed at block ${season.closedBlock} (snapshotBlock ${season.snapshotBlock})`);

  const report = {
    season: season.id,
    snapshotBlock: block,
    blockTime,
    endsAt: season.endsAt,
    predictCursor: cursor,
    rules: { ...rules, activeDay: 'UTC day with a QuestCompleted, Bought or Sold', marketTraded: 'market with a Bought or Sold', tieBreak: 'earlier block at which the score was reached' },
    warnings,
    closeSeason: { snapshotBlock: block, winners: winners.map((w) => checksum(render(w))) },
    wallets: rows.map((r) => ({
      rank: r.rank,
      user: checksum(render(r.user)),
      xp: r.xp.toString(),
      claimable: r.claimable.toString(),
      score: r.score.toString(),
      activeDays: r.activeDays,
      marketsTraded: r.marketsTraded,
      eligible: r.eligible,
      reachedBlock: r.reachedBlock,
      denied: r.denied,
      flagged: flagged.has(r.user),
    })),
  };
  const out = arg('--out') ?? `snapshot-season-${season.id}-block-${block}.json`;
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');

  const whole = (v: bigint) => (Number(v / 10n ** 14n) / 1e4).toFixed(4);
  console.log(`season ${season.id} at block ${block}, ${rows.length} wallets, rules: ${rules.minDays} days, ${rules.minMarkets} markets`);
  console.table(
    rows.slice(0, 20).map((r) => ({
      rank: r.rank ?? '-', user: render(r.user).slice(0, 10) + '…', score: whole(r.score), xp: whole(r.xp), claimable: whole(r.claimable),
      days: r.activeDays, markets: r.marketsTraded, eligible: r.eligible, flags: [r.denied && 'denied', flagged.has(r.user) && 'flagged'].filter(Boolean).join(' '),
    })),
  );
  console.log(`closeSeason(${block}, [${report.closeSeason.winners.join(', ')}])`);
  for (const w of warnings) console.log(`WARN ${w}`);
  log('info', 'snapshot written', { out });
  if (warnings.length && !flag('--force')) {
    console.log(`${warnings.length} warning(s): exiting 2; pass --force to accept them`);
    process.exitCode = 2;
  }
}
