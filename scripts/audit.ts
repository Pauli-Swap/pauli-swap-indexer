// Audits the indexer's API against the chain at the same block (the indexer's
// _meta.block; a pruned node still serves state that recent). Exit code 1 on
// any mismatch. Usage: npm run audit [-- --predict]  (INDEXER_URL, RPC_URL
// from env). --predict adds the Predict checks (docs/INDEXER.md §15, 7).
import { decode, getLogs, topicsFor, viewCalls } from '../src/abi.js';
import { hex } from '../src/address.js';
import { config, deployment, predictDeployment } from '../src/config.js';
import { Rpc, RpcError } from '../src/rpc.js';

const INDEXER_URL = process.env.INDEXER_URL || 'http://127.0.0.1:4000/graphql';
const rpc = new Rpc(process.env.RPC_URL || 'http://127.0.0.1:8545');

async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(INDEXER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function all<T>(field: string, query: string, variables: Record<string, unknown> = {}): Promise<T[]> {
  const out: T[] = [];
  for (let skip = 0; ; skip += 1000) {
    const page = (await gql(query, { ...variables, skip }))[field] as T[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

let failures = 0;
let checks = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) {
    failures++;
    results.push(`FAIL ${name}${detail ? ': ' + detail : ''}`);
  }
}
const short = (a: string) => a.slice(0, 9) + '…';

const meta = (await gql(`{ _meta { block head hasIndexingErrors lastError chainId qrlPriceUSD predictBlock } }`))._meta;
const B: number = meta.block;
console.log(`indexer block ${B}, head ${meta.head}, chain ${meta.chainId}, errors: ${meta.lastError ?? 'none'}`);
check('chain id', Number(await rpc.call('qrl_chainId')) === meta.chainId);
check('no indexing errors', !meta.hasIndexingErrors, meta.lastError ?? '');

const pools = await all<any>('pools', `query($skip: Int) { pools(first: 1000, skip: $skip) { id version token0 token1 reserve0 reserve1 totalSupply sqrtPriceX96 tick liquidity tvlQRL tvlUSD tracked } }`);
const tokens = await all<any>('tokens', `query($skip: Int) { tokens(first: 1000, skip: $skip) { id symbol decimals totalSupply holderCount derivedQRL } }`);
const events = await all<any>('poolEvents', `query($skip: Int, $to: Int) { poolEvents(first: 1000, skip: $skip, toBlock: $to, orderDirection: asc) { pool kind block logIndex txHash origin amount0 amount1 } }`, { to: B });
console.log(`${pools.length} pools, ${tokens.length} tokens, ${events.length} events`);

// 1. Pool discovery: every factory pair / pool is indexed.
const factoryLogs = await getLogs(rpc, [hex(deployment.contracts.PauliV2Factory), hex(deployment.contracts.PauliV3Factory)], topicsFor(['v2Factory', 'v3Factory']), deployment.startBlock, B);
const created = new Set(factoryLogs.map((l) => decode(l.topics.length === 3 ? 'v2Factory' : 'v3Factory', l)).filter(Boolean).map((d) => hex(d!.args.pair ?? d!.args.pool)));
check('pool count', created.size === pools.length, `chain ${created.size}, indexer ${pools.length}`);
for (const p of pools) check(`pool ${short(p.id)} discovered`, created.has(hex(p.id)));

// 2. Event rows vs raw logs, with the interface's rules (zero V3 Burns
//    skipped, Sync rows only where nothing else in the tx carries the price).
const raw = await getLogs(rpc, pools.map((p) => hex(p.id)), topicsFor(['pair', 'pool']), deployment.startBlock, B);
const versionOf = new Map(pools.map((p) => [hex(p.id), p.version as number]));
const expected = new Map<string, number>();
const bump = (k: string) => expected.set(k, (expected.get(k) ?? 0) + 1);
const decodedRaw = raw.map((l) => decode(versionOf.get(hex(l.address)) === 2 ? 'pair' : 'pool', l)).filter(Boolean) as NonNullable<ReturnType<typeof decode>>[];
const flowTx = new Set(decodedRaw.filter((d) => ['Swap', 'Mint', 'Burn'].includes(d.name)).map((d) => `${d.txHash}:${d.address}`));
for (const d of decodedRaw) {
  if (d.name === 'Swap') bump(`${d.address}:SWAP`);
  else if (d.name === 'Mint') bump(`${d.address}:ADD`);
  else if (d.name === 'Burn' && !(BigInt(d.args.amount0) === 0n && BigInt(d.args.amount1) === 0n)) bump(`${d.address}:REMOVE`);
  else if (d.name === 'Sync' && !flowTx.has(`${d.txHash}:${d.address}`)) bump(`${d.address}:SYNC`);
}
const got = new Map<string, number>();
for (const e of events) got.set(`${hex(e.pool)}:${e.kind}`, (got.get(`${hex(e.pool)}:${e.kind}`) ?? 0) + 1);
for (const key of new Set([...expected.keys(), ...got.keys()])) {
  check(`events ${short('Q' + key.split(':')[0])} ${key.split(':')[1]}`, expected.get(key) === got.get(key), `chain ${expected.get(key) ?? 0}, indexer ${got.get(key) ?? 0}`);
}

// 3. Pool state at B.
for (const p of pools) {
  if (p.version === 2) {
    const [r, s] = await viewCalls(rpc, B, [
      { to: p.id, signature: 'getReserves()', returns: ['uint112', 'uint112', 'uint32'] },
      { to: p.id, signature: 'totalSupply()', returns: ['uint256'] },
    ]);
    if (r instanceof RpcError || s instanceof RpcError) {
      check(`pair ${short(p.id)} readable at ${B}`, false, String(r instanceof RpcError ? r.message : (s as RpcError).message));
      continue;
    }
    check(`pair ${short(p.id)} reserves`, String(r[0]) === p.reserve0 && String(r[1]) === p.reserve1, `chain ${r[0]}/${r[1]}, indexer ${p.reserve0}/${p.reserve1}`);
    check(`pair ${short(p.id)} totalSupply`, String(s[0]) === p.totalSupply, `chain ${s[0]}, indexer ${p.totalSupply}`);
  } else {
    const [slot0, liq, b0, b1] = await viewCalls(rpc, B, [
      { to: p.id, signature: 'slot0()', returns: ['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'] },
      { to: p.id, signature: 'liquidity()', returns: ['uint128'] },
      { to: p.token0, signature: 'balanceOf(address)', args: [{ type: 'address', value: p.id }], returns: ['uint256'] },
      { to: p.token1, signature: 'balanceOf(address)', args: [{ type: 'address', value: p.id }], returns: ['uint256'] },
    ]);
    if ([slot0, liq, b0, b1].some((x) => x instanceof RpcError)) {
      check(`pool ${short(p.id)} readable at ${B}`, false);
      continue;
    }
    const s0 = slot0 as Record<string, any>;
    check(`pool ${short(p.id)} sqrtPrice`, String(s0[0]) === p.sqrtPriceX96, `chain ${s0[0]}, indexer ${p.sqrtPriceX96}`);
    check(`pool ${short(p.id)} tick`, Number(s0[1]) === p.tick, `chain ${s0[1]}, indexer ${p.tick}`);
    check(`pool ${short(p.id)} liquidity`, String((liq as any)[0]) === p.liquidity, `chain ${(liq as any)[0]}, indexer ${p.liquidity}`);
    check(`pool ${short(p.id)} balances`, String((b0 as any)[0]) === p.reserve0 && String((b1 as any)[0]) === p.reserve1, `chain ${(b0 as any)[0]}/${(b1 as any)[0]}, indexer ${p.reserve0}/${p.reserve1}`);
  }
}

// 4. Tokens: totalSupply, and every derived holder balance against balanceOf
//    (PauliSwap's own tokens keep mappings private, so their getters are right).
for (const t of tokens) {
  const [s] = await viewCalls(rpc, B, [{ to: t.id, signature: 'totalSupply()', returns: ['uint256'] }]);
  if (!(s instanceof RpcError)) check(`token ${t.symbol} ${short(t.id)} totalSupply`, String((s as any)[0]) === t.totalSupply, `chain ${(s as any)[0]}, indexer ${t.totalSupply}`);
  const holders = await all<any>('tokenHolders', `query($skip: Int, $t: ID!) { tokenHolders(token: $t, first: 1000, skip: $skip) { account balance } }`, { t: t.id });
  check(`token ${t.symbol} ${short(t.id)} holderCount`, holders.length === t.holderCount, `rows ${holders.length}, holderCount ${t.holderCount}`);
  const onChain = await viewCalls(rpc, B, holders.map((h) => ({ to: t.id, signature: 'balanceOf(address)', args: [{ type: 'address', value: h.account }], returns: ['uint256'] })));
  const wrong = holders.filter((h, i) => onChain[i] instanceof RpcError || String((onChain[i] as any)[0]) !== h.balance);
  check(`token ${t.symbol} ${short(t.id)} holder balances (${holders.length})`, wrong.length === 0, wrong.slice(0, 3).map((h) => short(h.account)).join(', '));
}

// 5. Transaction senders, a sample of up to 40.
const sample = events.filter((_, i) => i % Math.max(1, Math.floor(events.length / 40)) === 0).slice(0, 40);
const txs = await rpc.batch<{ from: string }>(sample.map((e) => ({ method: 'qrl_getTransactionByHash', params: [e.txHash] })));
sample.forEach((e, i) => {
  const t = txs[i];
  check(`origin of ${e.txHash.slice(0, 12)}…`, !(t instanceof RpcError) && !!t && hex(t.from) === hex(e.origin ?? 'Q' + '0'.repeat(128)));
});

// 6. Valuation, against the API's own prices (USD is not on chain, §9): TVL is
//    reserves at current prices, `tracked` is both sides >= MIN_QRL_LIQUIDITY
//    (the audit's env must match the indexer's), protocol TVL sums tracked
//    pools, and USD TVL is QRL TVL at qrlPriceUSD.
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const tokenById = new Map(tokens.map((t) => [hex(t.id), t]));
for (const p of pools) {
  const [t0, t1] = [tokenById.get(hex(p.token0)), tokenById.get(hex(p.token1))];
  const side = (t: any, raw: string) => (t?.derivedQRL == null || t.decimals == null ? null : (Number(raw) / 10 ** t.decimals) * t.derivedQRL);
  const [x, y] = [side(t0, p.reserve0), side(t1, p.reserve1)];
  const tvl = x === null || y === null ? null : x + y;
  check(`pool ${short(p.id)} tvlQRL`, tvl === null ? p.tvlQRL === null : p.tvlQRL !== null && near(tvl, p.tvlQRL), `expected ${tvl}, indexer ${p.tvlQRL}`);
  const tracked = x !== null && y !== null && x >= config.minQrlLiquidity && y >= config.minQrlLiquidity;
  check(`pool ${short(p.id)} tracked`, tracked === p.tracked, `expected ${tracked}, indexer ${p.tracked}`);
  const usd = meta.qrlPriceUSD === null || p.tvlQRL === null ? null : p.tvlQRL * meta.qrlPriceUSD;
  check(`pool ${short(p.id)} tvlUSD`, usd === null ? p.tvlUSD === null : p.tvlUSD !== null && near(usd, p.tvlUSD), `expected ${usd}, indexer ${p.tvlUSD}`);
}
const protocol = (await gql(`{ protocol { tvlQRL trackedPoolCount } }`)).protocol;
const trackedPools = pools.filter((p) => p.tracked);
check('protocol tvlQRL', near(protocol.tvlQRL, trackedPools.reduce((s, p) => s + (p.tvlQRL ?? 0), 0)));
check('protocol trackedPoolCount', protocol.trackedPoolCount === trackedPools.length);

// 7. Predict (--predict), at the Predict cursor: the views are explicit
//    getters, so OC-V3-02 does not apply.
if (process.argv.includes('--predict')) await auditPredict(meta.predictBlock);

async function auditPredict(P: number) {
  const XP = predictDeployment.contracts.PauliPredictXP;
  const PM = predictDeployment.contracts.PredictMarket;
  if (!XP || !PM) return check('predict deployed', false, 'predict-devnet.json has no contracts');
  const season = (await gql(`{ predictSeason { id } }`)).predictSeason;
  if (!season) return check('predict season indexed', false);
  const pages = async <T>(field: string, query: string, variables: Record<string, unknown> = {}) => {
    const out: T[] = [];
    for (let skip = 0; ; skip += 1000) {
      const page = (await gql(query, { ...variables, skip }))[field] as T[];
      out.push(...page);
      if (page.length < 1000) return out;
    }
  };
  const markets = await pages<any>('predictMarkets', `query($skip: Int) { predictMarkets(first: 1000, skip: $skip) { id status outcome poolYes poolNo createdBlock settledBlock } }`);
  const positions = await pages<any>('predictPositions', `query($skip: Int, $b: Int) { predictPositions(block: $b, includeEmpty: true, first: 1000, skip: $skip) { market user yesShares noShares claimable } }`, { b: P });
  const board: any[] = [];
  for (let skip = 0; ; skip += 1000) {
    const b = (await gql(`query($s: Int, $b: Int, $skip: Int) { predictLeaderboard(season: $s, block: $b, first: 1000, skip: $skip) { standings { user xp claimable score } } }`, { s: season.id, b: P, skip })).predictLeaderboard;
    board.push(...b.standings);
    if (b.standings.length < 1000) break;
  }
  console.log(`predict block ${P}, season ${season.id}, ${markets.length} markets, ${positions.length} positions, ${board.length} wallets`);

  // Markets: count, pools and status. The pools are the API's current ones, so
  // a trade indexed while this runs shows as a mismatch: run it again.
  const [count] = await viewCalls(rpc, P, [{ to: PM, signature: 'marketCount()', returns: ['uint256'] }]);
  const live = markets.filter((m) => m.createdBlock <= P);
  check('predict market count', !(count instanceof RpcError) && Number((count as any)[0]) === live.length, `chain ${(count as any)[0]}, indexer ${live.length}`);
  const onChain = await viewCalls(rpc, P, live.map((m) => ({ to: PM, signature: 'markets(uint256)', args: [{ type: 'uint256', value: m.id }], returns: ['uint256', 'uint256', 'uint256', 'uint8', 'uint8'] })));
  live.forEach((m, i) => {
    const r = onChain[i] as any;
    const status = m.settledBlock !== null && m.settledBlock <= P ? m.status : 0;
    check(`market #${m.id} pools`, !(r instanceof RpcError) && String(r[1]) === m.poolYes && String(r[2]) === m.poolNo, r instanceof RpcError ? r.message : `chain ${r[1]}/${r[2]}, indexer ${m.poolYes}/${m.poolNo}`);
    check(`market #${m.id} status`, !(r instanceof RpcError) && Number(r[3]) === status && (status !== 1 || Number(r[4]) === m.outcome));
  });

  // xp_balance against xpOfSeason, score = xp + claimable, and the board's
  // claimable against the positions'.
  const xp = await viewCalls(rpc, P, board.map((w) => ({ to: XP, signature: 'xpOfSeason(uint256,address)', args: [{ type: 'uint256', value: season.id }, { type: 'address', value: w.user }], returns: ['uint256'] })));
  const wrongXp = board.filter((w, i) => xp[i] instanceof RpcError || String((xp[i] as any)[0]) !== w.xp);
  check(`xp_balance vs xpOfSeason (${board.length})`, wrongXp.length === 0, wrongXp.slice(0, 3).map((w) => short(w.user)).join(', '));
  const claimableByUser = new Map<string, bigint>();
  for (const p of positions) claimableByUser.set(hex(p.user), (claimableByUser.get(hex(p.user)) ?? 0n) + BigInt(p.claimable));
  const wrongSum = board.filter((w) => BigInt(w.score) !== BigInt(w.xp) + BigInt(w.claimable) || BigInt(w.claimable) !== (claimableByUser.get(hex(w.user)) ?? 0n));
  check('leaderboard score = xp + claimable of positions', wrongSum.length === 0, wrongSum.slice(0, 3).map((w) => short(w.user)).join(', '));

  // Positions against positionOf, every (market, wallet) ever traded.
  const pos = await viewCalls(rpc, P, positions.map((p) => ({ to: PM, signature: 'positionOf(uint256,address)', args: [{ type: 'uint256', value: p.market }, { type: 'address', value: p.user }], returns: ['uint256', 'uint256', 'uint256', 'uint256'] })));
  const wrongPos = positions.filter((p, i) => pos[i] instanceof RpcError || String((pos[i] as any)[0]) !== p.yesShares || String((pos[i] as any)[1]) !== p.noShares);
  check(`positions vs positionOf (${positions.length})`, wrongPos.length === 0, wrongPos.slice(0, 3).map((p) => `#${p.market} ${short(p.user)}`).join(', '));

  // claimable against claim(id) called as the wallet; a revert ("PM: nothing")
  // means 0.
  const settled = new Set(live.filter((m) => m.settledBlock !== null && m.settledBlock <= P).map((m) => m.id));
  const claimRows = positions.filter((p) => settled.has(p.market));
  const sim = await viewCalls(rpc, P, claimRows.map((p) => ({ to: PM, from: p.user, signature: 'claim(uint256)', args: [{ type: 'uint256', value: p.market }], returns: ['uint256'] })));
  const wrongClaim = claimRows.filter((p, i) => (sim[i] instanceof RpcError ? '0' : String((sim[i] as any)[0])) !== p.claimable);
  check(`claimable vs claim() (${claimRows.length})`, wrongClaim.length === 0, wrongClaim.slice(0, 3).map((p) => `#${p.market} ${short(p.user)} indexer ${p.claimable}`).join(', '));
}

for (const r of results) console.log(r);
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
