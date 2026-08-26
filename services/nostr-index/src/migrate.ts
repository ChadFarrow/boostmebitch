// Minimal forward-only migration runner. No ORM, no framework — the same
// no-dependency taste the rest of this repo has.
//
// Each file in migrations/ runs once, in filename order, inside a transaction,
// and is recorded in schema_migrations. A file that has already run is skipped.
// Files are never edited after they ship; a change is a new file.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { getPool } from './db.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

export async function migrate(databaseUrl: string): Promise<string[]> {
  const db = getPool(databaseUrl);
  await db.query(`
    create table if not exists schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await db.query<{ version: string }>('select version from schema_migrations');
  const done = new Set(rows.map((r) => r.version));

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (version) values ($1)', [file]);
      await client.query('commit');
      applied.push(file);
      console.log(`[migrate] applied ${file}`);
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw new Error(`migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      client.release();
    }
  }
  if (!applied.length) console.log('[migrate] nothing to apply');
  return applied;
}

// Allow `npm run migrate` as a standalone step (Railway pre-deploy command).
// `resolve` both sides so a relative argv path and the file URL compare equal.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  await migrate(url);
  const { closePool } = await import('./db.ts');
  await closePool();
}
