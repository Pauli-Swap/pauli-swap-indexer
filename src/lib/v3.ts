// Synced from pauli-swap-interface/src/lib/v3.ts (be2e372) by scripts/sync-lib.mjs. Do not edit.
/// Concentrated liquidity math for Pauli V3, in bigint so results match the
/// pool to the wei. Prices are token1 per token0 unless a name says otherwise.

export const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT128 = (1n << 128n) - 1n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export const FEE_TIERS = [
  { fee: 500, tickSpacing: 10, label: '0.05%', hint: 'Best for correlated pairs' },
  { fee: 3000, tickSpacing: 60, label: '0.3%', hint: 'Best for most pairs' },
  { fee: 10000, tickSpacing: 200, label: '1%', hint: 'Best for exotic pairs' },
] as const;
export type FeeAmount = (typeof FEE_TIERS)[number]['fee'];
export const tickSpacingOf = (fee: number) => FEE_TIERS.find((t) => t.fee === fee)?.tickSpacing ?? 60;
export const feeLabel = (fee: number) => `${fee / 10_000}%`;

/// 2^128 / sqrt(1.0001)^(2^i) for i = 0..19: the per-bit factors the pool
/// multiplies together to get sqrt(1.0001^tick) in Q128.
const BIT_FACTORS = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick ${tick} out of range`);
  const abs = Math.abs(tick);
  let ratio = abs & 1 ? BIT_FACTORS[0] : Q128;
  for (let i = 1; i < BIT_FACTORS.length; i++) if (abs & (1 << i)) ratio = (ratio * BIT_FACTORS[i]) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Q128 to Q96, rounding up like the pool does.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/// Greatest tick whose sqrt ratio is at most `sqrtPriceX96`.
export function tickAtSqrtRatio(sqrtPriceX96: bigint): number {
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (sqrtRatioAtTick(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const nearestUsableTick = (tick: number, spacing: number) => {
  const rounded = Math.round(tick / spacing) * spacing;
  const min = Math.ceil(MIN_TICK / spacing) * spacing;
  const max = Math.floor(MAX_TICK / spacing) * spacing;
  return Math.min(max, Math.max(min, rounded));
};
export const minUsableTick = (spacing: number) => Math.ceil(MIN_TICK / spacing) * spacing;
export const maxUsableTick = (spacing: number) => Math.floor(MAX_TICK / spacing) * spacing;

/// Human price of token0 in token1 at a sqrt price.
export function priceFromSqrt(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const s = Number(sqrtPriceX96) / Number(Q96);
  return s * s * 10 ** (decimals0 - decimals1);
}
export const priceFromTick = (tick: number, decimals0: number, decimals1: number) =>
  Math.pow(1.0001, tick) * 10 ** (decimals0 - decimals1);
export function tickFromPrice(price: number, decimals0: number, decimals1: number): number {
  if (!(price > 0) || !Number.isFinite(price)) return price > 0 ? MAX_TICK : MIN_TICK;
  const raw = price * 10 ** (decimals1 - decimals0);
  return Math.max(MIN_TICK, Math.min(MAX_TICK, Math.floor(Math.log(raw) / Math.log(1.0001))));
}

const isqrt = (n: bigint) => {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
};
/// sqrt(amount1 / amount0) in Q96, for initializing a pool from a deposit ratio.
export const encodeSqrtRatioX96 = (amount1: bigint, amount0: bigint) => isqrt((amount1 << 192n) / amount0);

const sorted = (a: bigint, b: bigint) => (a > b ? [b, a] : [a, b]);

export function liquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const [a, b] = sorted(sqrtA, sqrtB);
  // LiquidityAmounts.getLiquidityForAmount0 rounds a * b / Q96 first; doing
  // amount0 * a / Q96 first overstates the liquidity on narrow low ranges.
  return (amount0 * ((a * b) / Q96)) / (b - a);
}
export function liquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  const [a, b] = sorted(sqrtA, sqrtB);
  return (amount1 * Q96) / (b - a);
}
export function liquidityForAmounts(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint): bigint {
  const [a, b] = sorted(sqrtA, sqrtB);
  if (sqrtP <= a) return liquidityForAmount0(a, b, amount0);
  if (sqrtP >= b) return liquidityForAmount1(a, b, amount1);
  const l0 = liquidityForAmount0(sqrtP, b, amount0);
  const l1 = liquidityForAmount1(a, sqrtP, amount1);
  return l0 < l1 ? l0 : l1;
}
export function amount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [a, b] = sorted(sqrtA, sqrtB);
  return ((liquidity << 96n) * (b - a)) / b / a;
}
export function amount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [a, b] = sorted(sqrtA, sqrtB);
  return (liquidity * (b - a)) / Q96;
}
export function amountsForLiquidity(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint): [bigint, bigint] {
  const [a, b] = sorted(sqrtA, sqrtB);
  if (sqrtP <= a) return [amount0ForLiquidity(a, b, liquidity), 0n];
  if (sqrtP >= b) return [0n, amount1ForLiquidity(a, b, liquidity)];
  return [amount0ForLiquidity(sqrtP, b, liquidity), amount1ForLiquidity(a, sqrtP, liquidity)];
}

/// The other side of a deposit inside [tickLower, tickUpper] at the current
/// price, so both amounts fill the same liquidity.
export function dependentAmount(
  side: 0 | 1,
  amount: bigint,
  sqrtP: bigint,
  tickLower: number,
  tickUpper: number,
): bigint {
  const a = sqrtRatioAtTick(tickLower);
  const b = sqrtRatioAtTick(tickUpper);
  if (sqrtP <= a || sqrtP >= b) return 0n;
  if (side === 0) return amount1ForLiquidity(a, sqrtP, liquidityForAmount0(sqrtP, b, amount));
  return amount0ForLiquidity(sqrtP, b, liquidityForAmount1(a, sqrtP, amount));
}

/// V3 swap path: 64 byte token, 3 byte fee, 64 byte token, ... (QRVM Path.hyp
/// uses ADDR_SIZE = 64).
export function encodePath(tokens: string[], fees: number[]): string {
  if (tokens.length !== fees.length + 1) throw new Error('path needs one more token than fees');
  let hex = '';
  tokens.forEach((t, i) => {
    hex += t.replace(/^Q/i, '').toLowerCase().padStart(128, '0');
    if (i < fees.length) hex += fees[i].toString(16).padStart(6, '0');
  });
  return '0x' + hex;
}

/// Orders two token addresses the way the factory does (numerically).
export const sortTokens = (a: string, b: string): [string, string] =>
  BigInt('0x' + a.slice(1)) < BigInt('0x' + b.slice(1)) ? [a, b] : [b, a];
