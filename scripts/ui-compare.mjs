// Renders the same interface pages from two builds and diffs the visible text
// line by line (docs/INDEXER.md §15).
// Usage: node scripts/ui-compare.mjs <urlA> <urlB> <poolAddress> <tokenAddress>
import { createRequire } from 'node:module';
import path from 'node:path';
// Playwright comes from the interface's devDependencies.
const require = createRequire(path.resolve(process.env.INTERFACE_DIR || '../pauli-swap-interface', 'package.json'));
const { chromium } = require('playwright');
const [a, b, pool, token] = process.argv.slice(2);

async function textOf(base, hash) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(base + '/' + hash);
  let quiet = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    if ((await page.locator('[aria-label="Loading on-chain data"], .skeleton-row, .skeleton').count()) === 0) {
      quiet ??= Date.now();
      if (Date.now() - quiet > 3000) break;
    } else quiet = null;
    await page.waitForTimeout(150);
  }
  const text = await page.locator('body').innerText();
  await browser.close();
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

for (const hash of ['#/explore', '#/explore/pools', '#/explore/transactions', `#/explore/pools/${pool}`, `#/explore/tokens/${token}`]) {
  const [x, y] = await Promise.all([textOf(a, hash), textOf(b, hash)]);
  const onlyA = x.filter((l) => !y.includes(l));
  const onlyB = y.filter((l) => !x.includes(l));
  console.log(`\n=== ${hash.slice(0, 40)}: ${x.length} lines rpc, ${y.length} lines indexer, ${onlyA.length}/${onlyB.length} differ`);
  for (let i = 0; i < Math.max(onlyA.length, onlyB.length) && i < 12; i++) console.log(`  rpc: ${onlyA[i] ?? ''}   |   indexer: ${onlyB[i] ?? ''}`);
}
