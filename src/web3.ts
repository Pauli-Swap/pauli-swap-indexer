import { Web3 } from '@theqrl/web3';

/// web3 1.0.3 is the only client that encodes 64 byte ABI words; it is used
/// for the codec and address checksums only, never as a provider.
export const web3 = new Web3();
