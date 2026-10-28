# PauliSwap Indexer

Indexer and GraphQL API for PauliSwap V2 and V3 on the QIP-55 QRL devnet
(64 byte addresses, 64 byte ABI words and event topics). Generic EVM indexers
such as The Graph cannot read this chain, so this one is written for it.
Design and measurements: [docs/INDEXER.md](docs/INDEXER.md).

Stack: Node 22 / TypeScript, `@theqrl/web3` 1.0.3 for ABI decoding, Postgres 16,
GraphQL. Contract ABIs and the deployment come from `../pauli-swap`
(`npm run sync:contracts`); the front end is `../pauli-swap-interface`, which
uses this API when `VITE_INDEXER_URL` is set.

## Run with Docker

```
cp .env.example .env        # set RPC_URL and POSTGRES_PASSWORD
docker compose up -d --build
curl localhost:4000/health
```

GraphQL is at `http://127.0.0.1:4000/graphql`:

```graphql
{ _meta { block head } pools(first: 5) { id version tvlQRL volumeQRL } }
```

Without the SSH tunnel, a small devnet can be indexed through the public proxy
(`RPC_URL=https://app.quantumark.fi/rpc/private-testnet`). On the VPS, point it
at the node; docs/INDEXER.md §13 has the Docker network note.

## Check it

```
RPC_URL=<same node> npm run audit
```

compares every pool, token, holder balance and a sample of transaction senders
with the chain at the indexer's block (docs/INDEXER.md §15).

## Develop

```
npm install
npm run dev          # needs DATABASE_URL and RPC_URL
npm run typecheck
npm run reindex      # drop the schema; stop the indexer first (docs/INDEXER.md §13)
```

`scripts/ui-compare.mjs` and `scripts/ui-timing.mjs` diff and time interface
builds with and without the indexer; they use Playwright from
`../pauli-swap-interface` (`INTERFACE_DIR`).

## License

GNU General Public License v2.0 or later; see [LICENSE](LICENSE).
