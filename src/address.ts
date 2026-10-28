import { web3 } from './web3.js';

/// QIP-55 addresses are 64 bytes. Stored as bytea; the API renders them like
/// the node does, `Q` + checksummed hex (the interface's `isQAddress` needs the
/// uppercase `Q`). Inputs are accepted in any case.

const HEX128 = /^[0-9a-f]{128}$/;
export const checksum = (address: string) => web3.utils.toChecksumAddress(address) as string;

/// Lowercase 128 hex characters, no prefix. Throws on anything else.
export function hex(address: string): string {
  const body = address.trim().replace(/^[Qq]/, '').replace(/^0x/i, '').toLowerCase();
  if (!HEX128.test(body)) throw new Error(`not a 64 byte address: ${address}`);
  return body;
}

export const toBytes = (address: string) => Buffer.from(hex(address), 'hex');
export const render = (bytes: Buffer | string) => 'Q' + (typeof bytes === 'string' ? hex(bytes) : bytes.toString('hex'));
export const isAddress = (value: string) => {
  try {
    hex(value);
    return true;
  } catch {
    return false;
  }
};

export const ZERO = '0'.repeat(128);
