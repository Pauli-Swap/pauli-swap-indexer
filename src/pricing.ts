import { priceFromSqrt } from './lib/v3.js';

/// Pool state the price walk needs. Addresses are lowercase 128 hex.
export type PricedPool = {
  version: 2 | 3;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  sqrtPrice: bigint;
  liquidity: bigint;
};

export const toFloat = (value: bigint, decimals: number) => {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const n = Number(abs / base) + Number(abs % base) / Number(base);
  return neg ? -n : n;
};

/// Raw (decimals-free) price of token0 in token1, as the interface's
/// `currentRawPrice`.
export function rawPrice(p: PricedPool): number | null {
  if (p.version === 3) return p.sqrtPrice > 0n ? priceFromSqrt(p.sqrtPrice, 0, 0) : null;
  return p.reserve0 > 0n ? Number(p.reserve1) / Number(p.reserve0) : null;
}

function midPrice(p: PricedPool, d0: number, d1: number): number {
  if (p.version === 3) return p.sqrtPrice ? priceFromSqrt(p.sqrtPrice, d0, d1) : 0;
  const r0 = toFloat(p.reserve0, d0);
  return r0 > 0 ? toFloat(p.reserve1, d1) / r0 : 0;
}

const usable = (pools: PricedPool[], decimalsOf: (a: string) => number | null) =>
  pools.filter((p) => p.reserve0 > 0n && p.reserve1 > 0n && (p.version === 2 || p.liquidity > 0n) && decimalsOf(p.token0) !== null && decimalsOf(p.token1) !== null);

/// Price of every reachable token in QRL, walking outward from WQRL through
/// the deepest pool at each step: the interface's `qrlPrices`
/// (src/lib/registry.ts), plus the minimum QRL depth and the bridge whitelist
/// of §9: only `bridges` (WQRL is always one) carry a price on to other
/// tokens; the rest are priced but price nothing through themselves.
export function qrlPrices(
  pools: PricedPool[],
  wqrl: string,
  decimalsOf: (a: string) => number | null,
  minQrl: number,
  bridges: Set<string>,
): Map<string, number> {
  const prices = new Map<string, number>([[wqrl, 1]]);
  const live = usable(pools, decimalsOf);
  let frontier = [wqrl];
  while (frontier.length) {
    const next: string[] = [];
    for (const from of frontier) {
      const fromPrice = prices.get(from)!;
      const candidates = live
        .filter((p) => p.token0 === from || p.token1 === from)
        .map((p) => {
          const fromIs0 = p.token0 === from;
          const other = fromIs0 ? p.token1 : p.token0;
          const depth = toFloat(fromIs0 ? p.reserve0 : p.reserve1, decimalsOf(from)!);
          return { p, other, depth, fromIs0 };
        })
        .filter((c) => !prices.has(c.other) && c.depth * fromPrice >= minQrl)
        .sort((a, b) => b.depth - a.depth);
      for (const c of candidates) {
        if (prices.has(c.other)) continue;
        const mid = midPrice(c.p, decimalsOf(c.p.token0)!, decimalsOf(c.p.token1)!);
        if (!(mid > 0)) continue;
        const otherPerFrom = c.fromIs0 ? mid : 1 / mid;
        prices.set(c.other, fromPrice / otherPerFrom);
        if (bridges.has(c.other)) next.push(c.other);
      }
    }
    frontier = next;
  }
  return prices;
}

/// Value of each side of a pool in QRL, or null where a side has no price.
export function sidesQrl(p: PricedPool, prices: Map<string, number>, decimalsOf: (a: string) => number | null): [number | null, number | null] {
  const side = (token: string, amount: bigint) => {
    const price = prices.get(token);
    const dec = decimalsOf(token);
    return price === undefined || dec === null ? null : toFloat(amount, dec) * price;
  };
  return [side(p.token0, p.reserve0), side(p.token1, p.reserve1)];
}

/// A pool whose volume counts (§9): both tokens priced and both sides at least
/// `minQrl` deep.
export function isTracked(p: PricedPool, prices: Map<string, number>, decimalsOf: (a: string) => number | null, minQrl: number) {
  const [x, y] = sidesQrl(p, prices, decimalsOf);
  return x !== null && y !== null && x >= minQrl && y >= minQrl;
}

/// Price of `token` in `stable` units through the deepest pool pairing them
/// whose stable side holds at least `minStable`, or null. With token = WQRL
/// this is the `stable` QRL/USD anchor; with any other token, its direct
/// stable price (Uniswap's step 2), which wins over the QRL route.
export function stablePrice(
  pools: PricedPool[],
  token: string,
  stables: string[],
  decimalsOf: (a: string) => number | null,
  minStable: number,
): number | null {
  let best: { depth: number; price: number } | null = null;
  for (const p of usable(pools, decimalsOf)) {
    const tokenIs0 = p.token0 === token;
    const stable = tokenIs0 ? p.token1 : p.token0;
    if (!(tokenIs0 || p.token1 === token) || !stables.includes(stable)) continue;
    const depth = toFloat(tokenIs0 ? p.reserve1 : p.reserve0, decimalsOf(stable)!);
    if (depth < minStable || (best && best.depth >= depth)) continue;
    const mid = midPrice(p, decimalsOf(p.token0)!, decimalsOf(p.token1)!);
    if (!(mid > 0)) continue;
    best = { depth, price: tokenIs0 ? mid : 1 / mid };
  }
  return best?.price ?? null;
}
