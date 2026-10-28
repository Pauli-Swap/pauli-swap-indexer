// Copies the Predict ABIs (PauliPredictXP, PredictMarket, QrlFaucet), both
// deployment records and the quest catalogue from pauli-swap-prediction-market,
// like scripts/sync-contracts.mjs does for pauli-swap. A deployment that does
// not exist yet is written with empty `contracts`, which turns the Predict
// module off (docs/INDEXER.md §8.6).
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(process.argv[2] ?? '../pauli-swap-prediction-market');
const network = process.argv[3] ?? 'devnet';
const out = path.resolve('src/contracts');
const artifactsDir = path.join(repo, 'build', 'qrvm');
const index = JSON.parse(fs.readFileSync(path.join(artifactsDir, 'index.json'), 'utf8'));

fs.mkdirSync(path.join(out, 'abi'), { recursive: true });
for (const name of ['PauliPredictXP', 'PredictMarket', 'QrlFaucet']) {
  const [unit] = index[name];
  const artifact = JSON.parse(fs.readFileSync(path.join(artifactsDir, unit, `${name}.json`), 'utf8'));
  fs.writeFileSync(path.join(out, 'abi', `${name}.json`), JSON.stringify(artifact.abi, null, 2) + '\n');
}

const read = (file) => {
  const full = path.join(repo, 'deployments', file);
  return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : null;
};
const record = (d) => ({ network, chainId: d?.chainId ?? null, startBlock: d?.startBlock ?? 0, deployedAt: d?.deployedAt ?? null, contracts: d?.contracts ?? {} });
const predict = read(`${network}.json`);
const faucet = read(`faucet-${network}.json`);
fs.writeFileSync(path.join(out, `predict-${network}.json`), JSON.stringify(record(predict), null, 2) + '\n');
fs.writeFileSync(path.join(out, `faucet-${network}.json`), JSON.stringify(record(faucet), null, 2) + '\n');
fs.copyFileSync(path.join(repo, 'quests', 'catalog.json'), path.join(out, 'quests.json'));
console.log(`synced Predict ABIs, predict ${predict ? `startBlock ${predict.startBlock}` : 'not deployed'}, faucet ${faucet ? `startBlock ${faucet.startBlock}` : 'not deployed'}, quest catalogue`);
