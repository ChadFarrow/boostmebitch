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

/**
 * Postgres cancels any statement the read API runs after this long.
 *
 * The app's proxy (lib/nostr-index-server.ts) gives up after 6 s, but nothing
 * tells Postgres: on 2026-11-17 every /feed/live call left a 30-second query
 * running after the proxy had already answered 503, and each home page load
 * started another. With this, the route answers 503 itself
 * (`setErrorHandler` in api.ts) and the statement is cancelled.
 *
 * 5 s, one under the proxy, and not lower: a statement that answers in under
 * 5 s can still reach the user, so a lower cap would turn working pages into
 * 503s. `zapsReceived` for a much-zapped artist measured 2.2 s on production,
 * which a 3 s cap would have put one cold cache away from failing. The slow
 * statement of a route is normally its FIRST, so it is cancelled before the
 * proxy gives up; a later stage can outlive the proxy by at most the time the
 * stages before it took.
 */
export const API_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * The read API's OWN pool, carrying `statement_timeout`.
 *
 * Separate from `getPool` on purpose: the indexer and the migration runner
 * share that one and run statements that may rightly take longer — a backfill
 * page, a migration's backfill — which a cap sized for the proxy would cancel.
 * The caller owns it and ends it.
 */
export function createApiPool(databaseUrl: string, statementTimeoutMs = API_STATEMENT_TIMEOUT_MS): pg.Pool {
  const p = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: statementTimeoutMs,
  });
  p.on('error', (e) => console.error('[db] idle api client error:', e.message));
  return p;
}

export async function closePool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end();
}

export type Db = pg.Pool;
