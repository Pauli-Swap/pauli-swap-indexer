import { startApi } from './api.js';
import { config, deployment } from './config.js';
import { createPool } from './db.js';
import { Indexer } from './indexer.js';
import { log } from './log.js';
import { PredictIndexer } from './predict.js';
import { Usd } from './usd.js';

const indexerDb = createPool(2);
const apiDb = createPool(5, 5000);
const indexer = new Indexer(indexerDb);
const usd = new Usd(indexerDb);
const predict = new PredictIndexer(indexerDb, indexer.rpc);
indexer.onReset = async () => {
  usd.refill();
  await predict.load();
};
indexer.onStep = (cursor) => predict.step(cursor);

log('info', 'starting', { rpc: config.rpcUrl, chainId: deployment.chainId, startBlock: deployment.startBlock, confirmations: config.confirmations, usdSource: config.usdSource, usdFeed: config.usdFeed || null });
await indexer.start();
usd.start();
const server = startApi(apiDb, indexer, usd, predict);

const shutdown = async (signal: string) => {
  log('info', 'shutting down', { signal });
  indexer.stop();
  usd.stop();
  server.close();
  await Promise.allSettled([indexerDb.end(), apiDb.end()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
