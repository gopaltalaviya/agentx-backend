#!/usr/bin/env node
/**
 * Apply migrations in filename order, tracked in a ledger table.
 *
 * Deliberately plain: drizzle-kit generates the schema DDL, and 0001+ are
 * hand-written constraint files it cannot express. Both are just SQL, applied
 * once each, inside a transaction.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import postgres from 'postgres';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL ?? 'postgres://agentx:agentx@localhost:5442/agentx';
const sql = postgres(url, {max: 1});

await sql`CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

const applied = new Set((await sql`SELECT name FROM _migrations`).map((r) => r.name));
const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();

let count = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  const ddl = readFileSync(join(ROOT, 'migrations', file), 'utf8');
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });
    console.log(`✓ ${file}`);
    count++;
  } catch (err) {
    console.error(`✗ ${file}\n  ${err.message}`);
    await sql.end();
    process.exit(1);
  }
}

console.log(count === 0 ? 'already up to date' : `applied ${count} migration(s)`);
await sql.end();
