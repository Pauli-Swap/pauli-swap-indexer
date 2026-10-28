import fs from 'node:fs';
import { config } from './config.js';
import { createPool, migrate, resetSchema } from './db.js';
import { log } from './log.js';
import { Rpc } from './rpc.js';

/// `migrate`: apply migrations. `reindex`: drop everything; the next start
/// backfills from startBlock, re-reading logs from the node (§14).
/// `sybil [--season N] [--out file]`: the season sybil report (§8.7). Its
/// code is not in this repo; it loads `src/private/sybil.ts` when installed.
const command = process.argv[2];
// A variable, so tsc does not look for a module that is absent from the repo.
const SYBIL: string = './private/sybil.js';
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const db = createPool(1);
try {
  if (command === 'migrate') await migrate(db);
  else if (command === 'reindex') await resetSchema(db);
  else if (command === 'sybil') {
    const season = arg('--season');
    const { sybilReport } = await import(SYBIL).catch(() => {
      throw new Error('the sybil report is not installed: copy it into src/private/ from the private ops repo');
    });
    const report = await sybilReport(db, new Rpc(config.rpcUrl), season ? Number(season) : undefined);
    const out = arg('--out') ?? `sybil-season-${report.season}.json`;
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    log('info', 'sybil report written', { out });
  } else throw new Error(`unknown command ${command}; use migrate, reindex or sybil`);
  if (command !== 'sybil') log('info', `${command} done`);
} finally {
  await db.end();
}
