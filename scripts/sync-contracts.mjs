// Copies the QRVM (QIP-55) ABIs and the devnet deployment from the pauli-swap
// repo, like pauli-swap-interface/scripts/sync-contracts.mjs. The 20 byte build
// in build/hyperion encodes 32 byte ABI words and would not decode against the
// devnet, so only build/qrvm is read.
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(process.argv[2] ?? '../pauli-swap');
const network = process.argv[3] ?? 'devnet';
const out = path.resolve('src/contracts');
const artifactsDir = path.join(repo, 'build', 'qrvm');
const index = JSON.parse(fs.readFileSync(path.join(artifactsDir, 'index.json'), 'utf8'));

const CONTRACTS = {
  WQRL: 'WQRL',
  PauliV2Factory: 'PauliV2Factory',
  PauliV2Pair: 'PauliV2Pair',
  SQRCTF1: 'PauliV2SQRCTF1',
  PauliV3Factory: 'PauliV3Factory',
  PauliV3Pool: 'PauliV3Pool',
  NonfungiblePositionManager: 'NonfungiblePositionManager',
};

fs.mkdirSync(path.join(out, 'abi'), { recursive: true });
for (const [name, artifactName] of Object.entries(CONTRACTS)) {
  const [unit] = index[artifactName];
  const artifact = JSON.parse(fs.readFileSync(path.join(artifactsDir, unit, `${artifactName}.json`), 'utf8'));
  fs.writeFileSync(path.join(out, 'abi', `${name}.json`), JSON.stringify(artifact.abi, null, 2) + '\n');
}

const deployment = JSON.parse(fs.readFileSync(path.join(repo, 'deployments', `${network}.json`), 'utf8'));
const { network: name, chainId, startBlock, deployedAt } = deployment;
// Deployments made before the AcornV2* / AcornV3* -> PauliV2* / PauliV3* rename
// keep the old keys; the addresses and ABIs are the same contracts.
const contracts = Object.fromEntries(
  Object.entries(deployment.contracts).map(([key, address]) => [key.replace(/^Acorn/, "Pauli"), address]),
);
fs.writeFileSync(
  path.join(out, `${network}.json`),
  JSON.stringify({ network: name, chainId, startBlock, deployedAt, contracts }, null, 2) + '\n',
);
console.log(`synced ${Object.keys(CONTRACTS).length} ABIs and ${network} (chainId ${chainId}, startBlock ${startBlock})`);
