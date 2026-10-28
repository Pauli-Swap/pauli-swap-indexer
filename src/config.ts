import devnet from './contracts/devnet.json' with { type: 'json' };
import predictDevnet from './contracts/predict-devnet.json' with { type: 'json' };
import faucetDevnet from './contracts/faucet-devnet.json' with { type: 'json' };
import { hex } from './address.js';

const env = (name: string, fallback: string) => process.env[name] || fallback;
const num = (name: string, fallback: number) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${v}`);
  return n;
};
const oneOf = <T extends string>(name: string, values: readonly T[], fallback: T): T => {
  const v = env(name, fallback);
  if (!values.includes(v as T)) throw new Error(`${name} must be one of ${values.join(', ')}, got ${v}`);
  return v as T;
};
const addresses = (name: string) =>
  env(name, '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map(hex);

export const config = {
  rpcUrl: env('RPC_URL', 'http://127.0.0.1:8545'),
  databaseUrl: env('DATABASE_URL', 'postgres://acorn:acorn@127.0.0.1:5432/acorn'),
  port: num('PORT', 4000),
  corsOrigin: env('CORS_ORIGIN', '*'),
  confirmations: num('CONFIRMATIONS', 3),
  logRange: num('LOG_RANGE', 20_000),
  pollMs: num('POLL_MS', 4000),
  minQrlLiquidity: num('MIN_QRL_LIQUIDITY', 1),
  hourDataDays: num('HOUR_DATA_DAYS', 90),
  /// 0 keeps every event.
  eventDays: num('EVENT_DAYS', 0),
  diskPath: env('DISK_PATH', ''),
  diskMinFreeGb: num('DISK_MIN_FREE_GB', 5),
  /// Seconds between chain identity checks (regenesis, §10).
  identityCheckSec: num('IDENTITY_CHECK_SEC', 120),

  // USD (§9). `none` on the devnet: its QRL and QUSD have no market value.
  usdSource: oneOf('USD_SOURCE', ['none', 'stable', 'feed'] as const, 'none'),
  /// Off-chain QRL/USD: the source with `feed`, a cross-check with `stable`.
  usdFeed: oneOf('USD_FEED', ['', 'coingecko', 'mexc'] as const, ''),
  usdFeedMinutes: num('USD_FEED_MINUTES', 5),
  /// Feed prices older than this are not used.
  usdFeedMaxAgeHours: num('USD_FEED_MAX_AGE_HOURS', 6),
  usdMaxDeviation: num('USD_MAX_DEVIATION', 0.05),
  stableTokens: addresses('STABLE_TOKENS'),
  minUsdLiquidity: num('MIN_USD_LIQUIDITY', 10_000),
  /// Tokens besides WQRL and STABLE_TOKENS that may carry a price to others.
  bridgeTokens: addresses('BRIDGE_TOKENS'),
};

if (config.usdSource === 'stable' && !config.stableTokens.length) throw new Error('USD_SOURCE=stable needs STABLE_TOKENS');
if (config.usdSource === 'feed' && !config.usdFeed) throw new Error('USD_SOURCE=feed needs USD_FEED (coingecko or mexc)');

export const deployment = devnet as {
  network: string;
  chainId: number;
  startBlock: number;
  deployedAt: string;
  contracts: Record<string, string>;
};

export type Deployment = { network: string; chainId: number | null; startBlock: number; deployedAt: string | null; contracts: Record<string, string> };

/// pauli-swap-prediction-market deployments (scripts/sync-predict.mjs); empty
/// `contracts` until deployed.
export const predictDeployment = predictDevnet as Deployment;
export const faucetDeployment = faucetDevnet as Deployment;
