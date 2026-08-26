import pg from 'pg';

// Postgres numeric types come back as strings by default so JS can't silently
// lose precision on a bigint. Every bigint in this schema is a unix timestamp
// in seconds, which is far inside Number.MAX_SAFE_INTEGER, and every consumer
// wants a number. Parse int8 (oid 20) as a Number once, here, rather than
// sprinkling Number() over every read and forgetting one.
pg.types.setTypeParser(20, (v: string) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(databaseUrl: string): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Railway's private network needs no TLS; a public proxy URL does. Trust
    // the URL rather than guessing — `?sslmode=require` is honoured by pg.
  });
  // A pool error with no listener is an uncaught exception that kills the
  // process. A dropped backend connection is ordinary and must not be fatal.
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  return pool;
}

export async function closePool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end();
}

export type Db = pg.Pool;
