import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';
import { log } from './log.js';

/// DB_SCHEMA lets the tests run beside a live database without touching it.
export const SCHEMA = process.env.DB_SCHEMA || 'acorn';
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) throw new Error(`DB_SCHEMA must be a lowercase identifier, got ${SCHEMA}`);
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function createPool(max: number, statementTimeoutMs?: number) {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max,
    options: `-c search_path=${SCHEMA}` + (statementTimeoutMs ? ` -c statement_timeout=${statementTimeoutMs}` : ''),
  });
}

/// Applies migrations/*.sql in name order, once each.
export async function migrate(db: pg.Pool) {
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await db.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.schema_migrations (name text PRIMARY KEY)`);
  const done = new Set((await db.query(`SELECT name FROM ${SCHEMA}.schema_migrations`)).rows.map((r) => r.name));
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path = ${SCHEMA}`);
      // Migrations qualify names with `acorn.` where search_path does not
      // apply (a function body); DB_SCHEMA renames them.
      await client.query(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8').replaceAll('acorn.', `${SCHEMA}.`));
      await client.query(`INSERT INTO ${SCHEMA}.schema_migrations (name) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      log('info', 'migration applied', { file });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

/// Regenesis or a reorg below the confirmation depth: start over (§10).
/// DROP SCHEMA returns the disk space at once.
export async function resetSchema(db: pg.Pool) {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  partitions.clear();
  await migrate(db);
}

// ---- monthly partitions (§14) ----

const partitions = new Set<string>();
const monthStart = (ts: number) => {
  const d = new Date(ts * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
};
const nextMonth = (start: number) => {
  const d = new Date(start * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
};
const suffix = (start: number) => new Date(start * 1000).toISOString().slice(0, 7).replace('-', '');

export const PARTITIONED = ['pool_events', 'pool_hour', 'token_hour'] as const;

/// Creates the month partition of `table` holding unix time `ts`, if missing.
export async function ensurePartition(q: pg.ClientBase | pg.Pool, table: (typeof PARTITIONED)[number], ts: number) {
  const start = monthStart(ts);
  const name = `${table}_${suffix(start)}`;
  if (partitions.has(name)) return;
  await q.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.${name} PARTITION OF ${SCHEMA}.${table} FOR VALUES FROM (${start}) TO (${nextMonth(start)})`);
  partitions.add(name);
}

/// Drops month partitions of `table` that end before `cutoff` (unix time).
export async function dropPartitionsBefore(db: pg.Pool, table: (typeof PARTITIONED)[number], cutoff: number) {
  const { rows } = await db.query(
    `SELECT c.relname AS name FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = $1 AND p.relname = $2`,
    [SCHEMA, table],
  );
  for (const { name } of rows) {
    const m = /_(\d{4})(\d{2})$/.exec(name);
    if (!m) continue;
    const end = Date.UTC(Number(m[1]), Number(m[2]), 1) / 1000;
    if (end <= cutoff) {
      await db.query(`DROP TABLE ${SCHEMA}.${name}`);
      partitions.delete(name);
      log('info', 'partition dropped', { table: name });
    }
  }
}
