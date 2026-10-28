// Times interface pages from two builds (e.g. without and with VITE_INDEXER_URL),
// median of 3 cold loads each, and counts RPC calls and indexer queries.
// Usage: node scripts/ui-timing.mjs <urlA> <labelA> <urlB> <labelB> <poolAddress> <tokenAddress>
import { createRequire } from 'node:module';
import path from 'node:path';
// Playwright comes from the interface's devDependencies.
const require = createRequire(path.resolve(process.env.INTERFACE_DIR || '../pauli-swap-interface', 'package.json'));
const { chromium } = require('playwright');

const [aUrl, aLabel, bUrl, bLabel, pool, token] = process.argv.slice(2);
const pages = [
  ['explore/tokens', '#/explore'],
  ['explore/pools', '#/explore/pools'],
  ['explore/transactions', '#/explore/transactions'],
  ['pool detail', `#/explore/pools/${pool}`],
  ['token detail', `#/explore/tokens/${token}`],
];

async function measure(base, hash) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const stats = { rpcPosts: 0, rpcCalls: 0, getLogs: 0, indexer: 0 };
  page.on('request', (r) => {
    if (r.method() !== 'POST') return;
    if (r.url().includes('/rpc')) {
      stats.rpcPosts++;
      try {
        const body = JSON.parse(r.postData() || '[]');
        const list = Array.isArray(body) ? body : [body];
        stats.rpcCalls += list.length;
        stats.getLogs += list.filter((x) => x.method === 'qrl_getLogs').length;
      } catch {}
    } else if (r.url().includes('/graphql')) stats.indexer++;
  });
  const t0 = Date.now();
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  // Loaded = no loading skeleton for 1.5 s and the page has content.
  let quietSince = null;
  while (Date.now() - t0 < 90_000) {
    const loading = await page.locator('[aria-label="Loading on-chain data"], .skeleton-row, .skeleton').count();
    if (loading === 0) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince > 1500) break;
    } else quietSince = null;
    await page.waitForTimeout(100);
  }
  const ms = (quietSince ?? Date.now()) - t0;
  await browser.close();
  return { ms, ...stats };
}

const rows = [];
for (const [name, hash] of pages) {
  for (const [label, base] of [[aLabel, aUrl], [bLabel, bUrl]]) {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await measure(base, hash));
    runs.sort((x, y) => x.ms - y.ms);
    const m = runs[1];
    rows.push({ page: name, mode: label, medianMs: m.ms, rpcPosts: m.rpcPosts, rpcCalls: m.rpcCalls, getLogs: m.getLogs, indexerQueries: m.indexer });
    console.log(JSON.stringify(rows.at(-1)));
  }
}
console.table(rows);
