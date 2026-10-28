import factoryAbi from './contracts/abi/PauliV2Factory.json' with { type: 'json' };
import pairAbi from './contracts/abi/PauliV2Pair.json' with { type: 'json' };
import v3FactoryAbi from './contracts/abi/PauliV3Factory.json' with { type: 'json' };
import v3PoolAbi from './contracts/abi/PauliV3Pool.json' with { type: 'json' };
import tokenAbi from './contracts/abi/SQRCTF1.json' with { type: 'json' };
import wqrlAbi from './contracts/abi/WQRL.json' with { type: 'json' };
import predictXpAbi from './contracts/abi/PauliPredictXP.json' with { type: 'json' };
import predictMarketAbi from './contracts/abi/PredictMarket.json' with { type: 'json' };
import faucetAbi from './contracts/abi/QrlFaucet.json' with { type: 'json' };
import { hex } from './address.js';
import { Rpc, RpcError, hexNum } from './rpc.js';
import { web3 } from './web3.js';

const codec = web3.qrl.abi;

type AbiInput = { name: string; type: string; indexed?: boolean };
type AbiEvent = { type: string; name: string; inputs: AbiInput[] };

/// Which kind of contract emits an event, so `Transfer` (one topic0 shared by
/// LP tokens, tokens and WQRL) dispatches on the emitter, not the signature.
export type Source = 'v2Factory' | 'v3Factory' | 'pair' | 'pool' | 'token' | 'predictXP' | 'predictMarket' | 'faucet';

/// QRVM topics are 64 byte words: the keccak256 signature right padded.
const topicWord = (sig: string) => '0x' + sig.replace(/^0x/, '').padEnd(128, '0').toLowerCase();

type Spec = { source: Source; event: AbiEvent; topic0: string };
const specs: Spec[] = [];
function register(source: Source, abi: unknown, names: string[]) {
  for (const e of abi as AbiEvent[]) {
    if (e.type !== 'event' || !names.includes(e.name)) continue;
    specs.push({ source, event: e, topic0: topicWord(codec.encodeEventSignature(e as any)) });
  }
}
register('v2Factory', factoryAbi, ['PairCreated']);
register('v3Factory', v3FactoryAbi, ['PoolCreated']);
register('pair', pairAbi, ['Sync', 'Swap', 'Mint', 'Burn', 'Transfer']);
register('pool', v3PoolAbi, ['Initialize', 'Swap', 'Mint', 'Burn']);
register('token', tokenAbi, ['Transfer']);
register('token', wqrlAbi, ['Deposit', 'Withdrawal']);
// Predict module (§8.6), read on its own cursor.
register('predictXP', predictXpAbi, ['SeasonStarted', 'SeasonClosed', 'XPCredited', 'XPDebited', 'QuestCompleted']);
register('predictMarket', predictMarketAbi, ['MarketCreated', 'Bought', 'Sold', 'MarketResolved', 'MarketCancelled', 'Claimed']);
register('faucet', faucetAbi, ['Dripped']);

const bySourceTopic = new Map(specs.map((s) => [`${s.source}:${s.topic0}`, s]));
export const topicsFor = (sources: Source[]) => [...new Set(specs.filter((s) => sources.includes(s.source)).map((s) => s.topic0))];
export const topicsOf = (source: Source, names: string[]) => specs.filter((s) => s.source === source && names.includes(s.event.name)).map((s) => s.topic0);

export type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
};

export type Decoded = {
  source: Source;
  name: string;
  /// Lowercase 128 hex, no prefix.
  address: string;
  block: number;
  logIndex: number;
  txHash: string;
  args: Record<string, any>;
};

/// Decodes a log emitted by a contract of kind `source`; null when the log is
/// not one the handlers use (e.g. an ERC-721 style Transfer with 4 topics).
export function decode(source: Source, log: RawLog): Decoded | null {
  const spec = bySourceTopic.get(`${source}:${String(log.topics[0]).toLowerCase()}`);
  if (!spec) return null;
  const indexed = spec.event.inputs.filter((i) => i.indexed).length;
  if (log.topics.length !== indexed + 1) return null;
  const args = codec.decodeLog(spec.event.inputs as any, log.data, log.topics.slice(1)) as Record<string, any>;
  return {
    source,
    name: spec.event.name,
    address: hex(log.address),
    block: Number(log.blockNumber),
    logIndex: Number(log.logIndex),
    txHash: String(log.transactionHash).toLowerCase(),
    args,
  };
}

/// `qrl_getLogs` over [from, to] for `addresses` and `topic0s`. web3's own
/// filter validator insists on 32 byte topics, so the filter goes to the RPC
/// as is. On an error the range is halved until it passes.
export async function getLogs(rpc: Rpc, addresses: string[], topic0s: string[], from: number, to: number): Promise<RawLog[]> {
  if (!addresses.length || from > to) return [];
  const out: RawLog[] = [];
  // Long address lists are split; a few hundred addresses per call is well
  // under any request size limit.
  for (let i = 0; i < addresses.length; i += 200) {
    const address = addresses.slice(i, i + 200).map((a) => 'Q' + a);
    let start = from;
    let span = to - from + 1;
    while (start <= to) {
      const end = Math.min(to, start + span - 1);
      try {
        out.push(...(await rpc.call<RawLog[]>('qrl_getLogs', [{ address, fromBlock: hexNum(start), toBlock: hexNum(end), topics: [topic0s] }])));
        start = end + 1;
      } catch (e) {
        if (span === 1 || !(e instanceof RpcError || e instanceof Error)) throw e;
        span = Math.max(1, Math.floor(span / 2));
      }
    }
  }
  out.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  return out;
}

// ---- contract reads (latest block only) ----

const selector = (signature: string) => codec.encodeFunctionSignature(signature);
const SEL = {
  decimals: selector('decimals()'),
  DECIMALS: selector('DECIMALS()'),
  symbol: selector('symbol()'),
  SYMBOL: selector('SYMBOL()'),
  name: selector('name()'),
  NAME: selector('NAME()'),
};

const ethCall = (to: string, data: string, block: string = 'latest') => ({ method: 'qrl_call', params: [{ to: 'Q' + hex(to), data }, block] });

function decodeOr<T>(type: string, value: unknown): T | null {
  if (value instanceof RpcError || typeof value !== 'string' || value === '0x') return null;
  try {
    return codec.decodeParameter(type, value) as T;
  } catch {
    return null;
  }
}

export type TokenMeta = { decimals: number | null; symbol: string | null; name: string | null };

/// SQRC20 ABIs carry both spellings (`decimals()` and `DECIMALS()`); the first
/// that answers wins.
export async function tokenMetadata(rpc: Rpc, addresses: string[]): Promise<TokenMeta[]> {
  const calls = addresses.flatMap((a) => [SEL.decimals, SEL.DECIMALS, SEL.symbol, SEL.SYMBOL, SEL.name, SEL.NAME].map((s) => ethCall(a, s)));
  const r = await rpc.batch<string>(calls);
  return addresses.map((_, i) => {
    const [d, D, s, S, n, N] = r.slice(i * 6, i * 6 + 6);
    const dec = decodeOr<bigint>('uint8', d) ?? decodeOr<bigint>('uint8', D);
    return {
      decimals: dec === null ? null : Number(dec),
      symbol: decodeOr<string>('string', s) ?? decodeOr<string>('string', S),
      name: decodeOr<string>('string', n) ?? decodeOr<string>('string', N),
    };
  });
}

/// View calls by signature at `block` (recent blocks only on a pruned node),
/// decoded with `returns`; used by the audit.
export async function viewCalls(rpc: Rpc, block: number, calls: { to: string; signature: string; args?: { type: string; value: unknown }[]; returns: string[] }[]) {
  const payload = calls.map((c) => {
    const args = c.args ?? [];
    const data = selector(c.signature) + (args.length ? codec.encodeParameters(args.map((a) => a.type), args.map((a) => a.value) as any).slice(2) : '');
    return ethCall(c.to, data, hexNum(block));
  });
  const r = await rpc.batch<string>(payload);
  return r.map((v, i) => {
    if (v instanceof RpcError) return v;
    return codec.decodeParameters(calls[i].returns, v) as Record<string, any>;
  });
}
