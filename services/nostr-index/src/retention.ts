// Retention for kind:30311 versions — the one table this index lets grow
// without bound if nothing removes rows.
//
// A streaming client republishes its NIP-53 live activity every few seconds,
// and every version is a new `events` row plus about four `event_tags` rows. On
// 2026-11-26 production held 624,102 of them, 514,281 older than eight days,
// in a 5 GB volume that was 80% full and growing 41-59 MB a day, about 85% of
// that from this kind. Nothing reads an old one: `/feed/live` reads only
// `live_heads` inside `LIVE_WINDOW_SECS`, the kind:5 promotion looks back the
// same window, and the live subscription asks for nothing older.
//
// So this deletes them, and keeps every row a reader could still reach:
//
//   - a version some `live_heads` row names, however old (one per broadcast);
//   - a version another stored event names in an `e` or `q` tag, because
//     `quotedEvents` serves those by id (716 on 2026-11-26);
//   - a tombstoned version (`deleted_at` set): the scan below runs on the
//     partial index `events_kind_created_idx`, which holds no tombstoned row,
//     and the 166 of them are not worth a second scan of the table;
//   - every other kind. Kinds 1, 6 and 9735 are what the feeds serve.
//
// A note that quotes a pruned version LATER gets no copy from the index, and
// the client reads it from the relays, which stay the source of truth.
//
// **Never a migration.** `migrate.ts` runs each file in one transaction at
// start, before the API listens: half a million deletes there would be one
// enormous write on a nearly full disk, with the service down for all of it.
// This runs in small batches, in the background, paced by the WAL it writes.

import type { Db } from './db.ts';
import { LIVE_STREAM_KIND, LIVE_WINDOW_SECS } from './ingest.ts';

/**
 * How old, by `created_at`, a kind:30311 version must be before it may go.
 *
 * DERIVED from `LIVE_WINDOW_SECS`, never a free number, and strictly longer:
 * the route, the live subscription and `retireLiveHeads` all look back exactly
 * the window, so a version inside it can still be served or promoted. The extra
 * day is the margin that keeps a prune from racing a promotion at the edge of
 * the window — the window moves forward while a run is in progress.
 */
export const LIVE_RETENTION_SECS = LIVE_WINDOW_SECS + 86_400;

/** Versions per DELETE. Each one cascades to about four `event_tags` rows, so a
 *  batch is about 2,500 row deletes in one short transaction. */
export const PRUNE_BATCH = 500;

/** Pause between batches, so ingest and the API share the disk with it. */
export const PRUNE_PAUSE_MS = 1_000;

/**
 * Wait when this much WAL has been written since the last checkpoint began.
 *
 * WAL is what fills a nearly full disk first, not the rows. Postgres keeps
 * every segment back to the last checkpoint's redo point, and with
 * `data_checksums` and `full_page_writes` on, the first change to a page after
 * a checkpoint writes the whole 8 kB page. On 2026-11-26 production wrote about
 * 2 MB of WAL per 5-minute checkpoint and had 904 MB free, with `max_wal_size`
 * at 1 GB. Under this ceiling the prune adds at most about this much per
 * checkpoint, and it also stands aside while something else (an autovacuum
 * after the deletes) is writing heavily.
 */
export const WAL_SINCE_REDO_CEILING = 64 * 1024 * 1024;

/** How long to wait before the WAL is measured again. */
export const WAL_WAIT_MS = 30_000;

/** How many waits in a row end a run. The next run starts on the next tick, so
 *  a run never sits for hours on a database that is busy for another reason. */
export const MAX_WAL_WAITS = 20;

/** The advisory lock a batch takes. Two processes overlap during a deploy, and
 *  only one of them should prune at a time. Any constant works, as long as
 *  nothing else in this database uses it. */
export const PRUNE_LOCK_KEY = 30_311_000;

export interface WalSample {
  /** WAL bytes written since the redo point of the last checkpoint. */
  sinceRedo: number;
}

/** The pacing decision, pure. `null` means the WAL could not be measured, and
 *  then nothing is deleted: an unmeasured disk is not a safe one. */
export function walVerdict(sample: WalSample | null): 'go' | 'wait' | 'stop' {
  if (!sample || !Number.isFinite(sample.sinceRedo)) return 'stop';
  return sample.sinceRedo > WAL_SINCE_REDO_CEILING ? 'wait' : 'go';
}

/** The `created_at` below which a version may go, for a clock reading. */
export function retentionCutoff(nowSecs: number): number {
  return Math.floor(nowSecs) - LIVE_RETENTION_SECS;
}

/**
 * Read the WAL written since the last checkpoint. `null` when the role cannot
 * call `pg_control_checkpoint()` (it needs a superuser or `pg_monitor`) or the
 * query fails for any other reason.
 */
export async function sampleWal(db: Db): Promise<WalSample | null> {
  try {
    const { rows } = await db.query<{ since_redo: string }>(
      `select pg_wal_lsn_diff(pg_current_wal_lsn(), redo_lsn)::text as since_redo
         from pg_control_checkpoint()`,
    );
    const n = Number(rows[0]?.since_redo);
    return Number.isFinite(n) ? { sinceRedo: n } : null;
  } catch {
    return null;
  }
}

/**
 * Delete one batch: the oldest prunable versions from `cursor` up to `cutoff`.
 * Returns the deleted rows' `created_at` values (empty when the lock was held
 * by another process — `locked` tells the two apart).
 *
 * The shape is measured, not chosen. `deleted_at is null` is what lets the plan
 * use the PARTIAL index `events_kind_created_idx`: without it Postgres read the
 * whole `events` heap and sorted on disk, 18.4 s and 45 MB of temp files per
 * batch on production; with it, 0.38 s cold. The two `not exists` are index
 * probes (`live_heads_event_idx`, `event_tags_lookup_idx`). `skip locked`, so a
 * kind:5 updating a version never makes the prune wait, nor the reverse.
 *
 * The cascade on `event_tags_event_id_fkey` deletes the tag rows by the primary
 * key prefix. `lock_timeout` and `statement_timeout` bound a batch that meets
 * something unexpected; it rolls back and the next run starts again.
 *
 * A `live_heads` row written between the snapshot and the delete is not seen.
 * That needs a version older than the cutoff to become a head, which only an
 * offer of a version no subscription asks for can do, and such a head is older
 * than the route's window, so it is never served either way.
 */
export async function pruneLiveBatch(
  db: Db,
  cutoff: number,
  cursor: number,
  limit = PRUNE_BATCH,
): Promise<{ locked: boolean; createdAt: number[] }> {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(`set local lock_timeout = '5s'`);
    await client.query(`set local statement_timeout = '60s'`);
    const lock = await client.query<{ got: boolean }>('select pg_try_advisory_xact_lock($1) as got', [PRUNE_LOCK_KEY]);
    if (!lock.rows[0]?.got) {
      await client.query('rollback');
      return { locked: true, createdAt: [] };
    }
    const res = await client.query<{ created_at: number }>(
      `delete from events e
         using (
           select c.id from events c
            where c.kind = $1 and c.deleted_at is null
              and c.created_at < $2 and c.created_at >= $3
              and not exists (select 1 from live_heads h where h.event_id = c.id)
              and not exists (select 1 from event_tags t where t.name in ('q', 'e') and t.value = c.id)
            order by c.created_at
            limit $4
            for update of c skip locked
         ) doomed
        where e.id = doomed.id
       returning e.created_at`,
      [LIVE_STREAM_KIND, cutoff, cursor, limit],
    );
    await client.query('commit');
    return { locked: false, createdAt: res.rows.map((r) => r.created_at) };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface PruneRun {
  deleted: number;
  batches: number;
  walWaits: number;
  /** Why the run ended. */
  end: 'caught-up' | 'stopped' | 'wal-busy' | 'wal-unmeasured' | 'locked';
  cutoff: number;
  ms: number;
}

export interface PruneOptions {
  nowSecs?: number;
  batch?: number;
  pauseMs?: number;
  walWaitMs?: number;
  maxWalWaits?: number;
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Replaces `sampleWal`; verify/check-retention.mjs drives the pacing with it. */
  sampleWal?: (db: Db) => Promise<WalSample | null>;
}

/**
 * One run: batches until nothing older than the cutoff is left to delete, the
 * process stops, or the WAL says to stand aside. Called once an hour; the first
 * runs after a deploy work through the backlog, the later ones delete about an
 * hour of versions each.
 *
 * The cursor is the newest `created_at` the last batch deleted, inclusive, so
 * a batch never walks again over the rows the earlier batches deleted (their
 * index entries stay until a vacuum) or over the rows this run keeps.
 */
export async function pruneLiveVersions(db: Db, opts: PruneOptions = {}): Promise<PruneRun> {
  const started = Date.now();
  const cutoff = retentionCutoff(opts.nowSecs ?? Date.now() / 1000);
  const batch = opts.batch ?? PRUNE_BATCH;
  const pauseMs = opts.pauseMs ?? PRUNE_PAUSE_MS;
  const walWaitMs = opts.walWaitMs ?? WAL_WAIT_MS;
  const maxWalWaits = opts.maxWalWaits ?? MAX_WAL_WAITS;
  const stop = opts.shouldStop ?? (() => false);
  const nap = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const measure = opts.sampleWal ?? sampleWal;

  const run: PruneRun = { deleted: 0, batches: 0, walWaits: 0, end: 'caught-up', cutoff, ms: 0 };
  let cursor = 0;
  let waitsInRow = 0;
  for (;;) {
    if (stop()) { run.end = 'stopped'; break; }
    const verdict = walVerdict(await measure(db));
    if (verdict === 'stop') { run.end = 'wal-unmeasured'; break; }
    if (verdict === 'wait') {
      run.walWaits++;
      if (++waitsInRow > maxWalWaits) { run.end = 'wal-busy'; break; }
      await nap(walWaitMs);
      continue;
    }
    waitsInRow = 0;
    const { locked, createdAt } = await pruneLiveBatch(db, cutoff, cursor, batch);
    if (locked) { run.end = 'locked'; break; }
    run.batches++;
    run.deleted += createdAt.length;
    if (createdAt.length < batch) break;
    cursor = Math.max(cursor, ...createdAt);
    await nap(pauseMs);
  }
  run.ms = Date.now() - started;
  return run;
}
