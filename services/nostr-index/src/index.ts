// Entrypoint. Runs migrations, then the API and/or the indexer depending on
// INDEX_ROLE. One process by default because that is the cheapest thing that
// works; split into two Railway services by setting the role per service.

import { config } from './config.ts';
import { closePool, getPool } from './db.ts';
import { migrate } from './migrate.ts';
import { buildApi } from './api.ts';
import { Indexer } from './indexer.ts';

const db = getPool(config.databaseUrl);
await migrate(config.databaseUrl);

let indexer: Indexer | null = null;
if (config.role === 'all' || config.role === 'indexer') {
  indexer = new Indexer(db, config);
  await indexer.start();
  console.log(`[index] indexer started over ${config.relays.length} relays`);
}

let app: ReturnType<typeof buildApi> | null = null;
if (config.role === 'all' || config.role === 'api') {
  // The indexer is handed to the API only as a health probe, so /health can
  // report relay connectivity instead of a static literal. Null in the `api`
  // role, where this process has no relays of its own to speak for.
  app = buildApi(db, config, indexer ? () => indexer!.health() : undefined);
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[index] api listening on :${config.port}`);
}

async function shutdown(signal: string) {
  console.log(`[index] ${signal} - shutting down`);
  indexer?.stop();
  if (app) await app.close().catch(() => {});
  await closePool().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
