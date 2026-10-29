import fs from 'node:fs';
import { hex } from './address.js';

/// quests/denylist.json from pauli-swap-prediction-market: wallets the faucet
/// and the attester refuse. The admin edits it after the sybil review, so it
/// is read where it lives and read again when it changes.

let cache: { path: string; mtimeMs: number; wallets: Set<string> } | null = null;

/// Lowercase hex of every denied wallet; empty when there is no file.
export function readDenylist(path: string): Set<string> {
  if (!path || !fs.existsSync(path)) return new Set();
  const { mtimeMs } = fs.statSync(path);
  if (cache?.path === path && cache.mtimeMs === mtimeMs) return cache.wallets;
  const wallets = new Set((JSON.parse(fs.readFileSync(path, 'utf8')).wallets as string[]).map(hex));
  cache = { path, mtimeMs, wallets };
  return wallets;
}
