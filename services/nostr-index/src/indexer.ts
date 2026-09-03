// The indexer worker: holds relay subscriptions open, backfills history, and
// keeps the Podcast Index cache warm.
//
// This is the half that cannot run on Vercel. Its whole job is to keep
// WebSockets to several relays open continuously, and a serverless function has
// no persistent process to do that in.

import { SimplePool, type Event, type Filter } from 'nostr-tools';
import { normalizeURL } from 'nostr-tools/utils';
import type { AbstractRelay } from 'nostr-tools/abstract-relay';
import type { Db } from './db.ts';
import type { Config } from './config.ts';
import { emptyStats, indexedThrough, ingestEvent, recentNoteIds, setState, getState, trackedPubkeys, type IngestStats } from './store.ts';
import { fetchEpisodeByGuid, fetchPodcastByGuid, piConfigured } from './pi.ts';
import { LIVE_STREAM_KIND } from './ingest.ts';

/** The two filters that define this index's universe. Both mirror queries the
 *  app already makes of relays — `fetchAllPodcastNotes` and the tag half of
 *  `fetchBoostsReceivedBy` — so nothing is indexed that a client would not
 *  otherwise have asked for itself. */
export const CORE_FILTERS: { name: string; filter: Filter }[] = [
  { name: 'podcast-notes', filter: { kinds: [1], '#k': ['podcast:guid', 'podcast:item:guid'] } },
  { name: 'boostagrams', filter: { kinds: [1], '#t': ['boostagram', 'value4value'] } },
];

// Relay filters have a practical size limit, and a very long `authors` list is
// expensive for the relay to serve. Chunk, and cap how many tracked pubkeys
// take part at all.
const PUBKEY_CHUNK = 500;
const MAX_TRACKED_IN_FILTERS = 5_000;

// How many recently-stored notes are watched for REPLIES, and the per-filter
// chunk. A reply carries no `k`/`t` tag of its own, so it matches neither core
// filter and the only way to see one is to ask for it by its parent's id.
// Without this the index served bundles with `replies: []` forever — measured
// on production 2026-08-25, 50 notes and zero replies — and `replyForest`'s
// recursive CTE was correct all along, joining against rows nothing ingested.
//
// The window is generous against a corpus of roughly 26 notes a day, so it
// covers far more history than any feed page shows.
const REPLY_WATCH_IDS = 2_000;
const ID_CHUNK = 500;

// The live-activity window, matching `LIVE_STREAM_RELAYS`' own 7-day `since`
// in lib/nostr/live-streams.ts: wide enough to carry a stream scheduled ahead
// of time, narrow enough not to drag in broadcasts that ended months ago.
// Re-subscribed hourly so the `since` does not go stale on a long-lived
// process — a subscription filter is evaluated once, at REQ time.
const LIVE_WINDOW_SECS = 7 * 86_400;
const LIVE_RESUBSCRIBE_MS = 3_600_000;
const LIVE_SEED_LIMIT = 500;

// How often the tracked-pubkey subscriptions are RECONSIDERED. Resubscribing
// per new pubkey would thrash every relay, and the set grows constantly — but
// the rebuild only actually happens when the set changed, so checking often is
// cheap. On a cold index this is also the delay before the first author's
// profile, reposts, zaps and deletions are subscribed at all.
const RESUBSCRIBE_INTERVAL_MS = 60_000;

const BACKFILL_PAGE = 200;
const BACKFILL_PAUSE_MS = 750;

// Skip the database round trip for an id already ingested this run. Bounded so
// a long-lived process cannot grow it without limit.
const SEEN_CAP = 100_000;

// How often relay connectivity is checked, and how many consecutive all-dead
// checks are tolerated before the subscriptions are rebuilt from scratch.
// Two, not one, because a single check can land inside nostr-tools' own
// reconnect backoff (10s rising to 60s) and see zero connections while a
// perfectly good recovery is already in flight.
const CONNECTIVITY_CHECK_MS = 60_000;
const DEAD_CHECKS_BEFORE_REBUILD = 2;

/**
 * `AbstractSimplePool.relays` is protected, and whether a socket is actually
 * open is exactly what the watchdog and /health have to read. This subclass
 * exists for that one accessor and nothing else.
 *
 * It normalises the url on the way in because the pool keys that map by the
 * NORMALISED form — look up the configured string and every relay reads as
 * missing, which would make the watchdog rebuild every subscription once a
 * minute forever while reporting zero relays connected.
 */
class IndexPool extends SimplePool {
  relayFor(url: string): AbstractRelay | undefined {
    try { return this.relays.get(normalizeURL(url)); } catch { return undefined; }
  }
}

export class Indexer {
  // `enableReconnect` and `enablePing` are BOTH off by default in nostr-tools
  // 2.19.4, and this process depends on neither being off.
  //
  // With reconnect off, `handleHardClose` calls `closeAllSubscriptions` and
  // `SimplePool.ensureRelay`'s `onclose` deletes the relay from the pool. The
  // core subscriptions are created ONCE in `start()`, and `subscribeTracked`
  // returns early unless the tracked-pubkey set changed — which needs new
  // events, which needs the sockets. So one dropped socket stopped ingestion
  // permanently, and the only symptom was `indexedThrough` drifting: `/health`
  // answered `{ok:true}` without touching the database and `reportStats`
  // returned early on all-zero counters, so a fully stalled indexer logged
  // nothing at all. Measured 2026-08-25 on the deployed service: newest note
  // 5.5 h old against a relay note 0.6 h old, `indexedThrough` ~2 h behind.
  //
  // With reconnect ON the relay stays in the pool, `reconnect()` retries on a
  // 10s→60s backoff forever, and `ws.onopen` re-fires every open subscription
  // with `since = lastEmitted + 1`, so a reconnect resumes rather than replays.
  //
  // `enablePing` detects the half-open socket that never fires `onclose` at
  // all. nostr-tools uses real WebSocket ping frames when the implementation
  // has them and otherwise falls back to a tiny `{ids:[…], limit:0}` REQ; this
  // process is on Node's global WebSocket, so it takes the REQ path. Measured
  // against all five configured relays before enabling it — every one answered
  // EOSE, the slowest (`relay.fountain.fm`) at 3206 ms against a 20 s ping
  // timeout — because a relay that does NOT answer would be closed and
  // reconnected every 29 s, which is worse than the problem.
  //
  // NOT switched to the `ws` package, though it is a declared dependency and
  // would give real ping frames: measured the same day, `relay.damus.io`
  // refuses a `ws` handshake ("non-101 status code") while accepting Node's
  // global WebSocket. That would cost a core relay to save a REQ.
  private pool = new IndexPool({ enableReconnect: true, enablePing: true });
  private deadChecks = 0;
  private seen = new Set<string>();
  // Subscriptions by GROUP, not one flat list. The flat list was replaced
  // per-generation with `closers.splice(CORE_FILTERS.length)` — arithmetic that
  // silently means the wrong thing the moment a third group exists, which is
  // exactly what the reply watcher below adds. A keyed map cannot drift.
  private subs = new Map<string, { close(): void }[]>();
  private timers: NodeJS.Timeout[] = [];
  private stats: IngestStats = emptyStats();
  private stopped = false;
  // A fingerprint of the tracked set, NOT its size. Comparing counts misses the
  // case where one pubkey is added while another falls out of the
  // MAX_TRACKED_IN_FILTERS window in the same interval: the count is unchanged,
  // the membership is not, and the subscriptions silently never rebuild.
  private trackedFingerprint = '';
  private replyFingerprint = '';

  // Plain assignments, not parameter properties - strip-only TypeScript
  // rejects those, and this service runs without a build step.
  private db: Db;
  private cfg: Config;

  constructor(db: Db, cfg: Config) {
    this.db = db;
    this.cfg = cfg;
  }

  private get relays(): string[] {
    return Array.from(new Set([...this.cfg.relays, ...this.cfg.profileRelays]));
  }

  async start(): Promise<void> {
    this.subscribeCore();
    await this.subscribeTracked();
    await this.subscribeReplies();
    this.subscribeLive();
    void this.backfillLoop();
    void this.piLoop();

    const interval = this.cfg.resubscribeIntervalMs ?? RESUBSCRIBE_INTERVAL_MS;
    this.timers.push(setInterval(() => void this.subscribeTracked().catch(logErr('resubscribe')), interval));
    this.timers.push(setInterval(() => void this.subscribeReplies().catch(logErr('reply resubscribe')), interval));
    this.timers.push(setInterval(
      () => this.subscribeLive(),
      this.cfg.liveResubscribeMs ?? LIVE_RESUBSCRIBE_MS,
    ));
    this.timers.push(setInterval(() => this.reportStats(), 60_000));
    this.timers.push(setInterval(
      () => void this.checkConnectivity().catch(logErr('connectivity')),
      this.cfg.connectivityCheckMs ?? CONNECTIVITY_CHECK_MS,
    ));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.closeAllSubs();
    try { this.pool.close(this.relays); } catch { /* already gone */ }
  }

  /** Replace one named group of subscriptions, closing whatever it held. */
  private setSubs(group: string, closers: { close(): void }[]): void {
    for (const c of this.subs.get(group) ?? []) { try { c.close(); } catch { /* already gone */ } }
    this.subs.set(group, closers);
  }

  private closeAllSubs(): void {
    for (const group of this.subs.keys()) this.setSubs(group, []);
    this.subs.clear();
  }

  private subCount(): number {
    let n = 0;
    for (const list of this.subs.values()) n += list.length;
    return n;
  }

  /** Live subscriptions for the two core filters. */
  private subscribeCore(): void {
    this.setSubs('core', CORE_FILTERS.map(({ name, filter }) =>
      this.pool.subscribeMany(this.relays, filter, {
        onevent: (e) => void this.take(e, name),
        onclose: () => console.warn(`[indexer] ${name} subscription closed`),
      }),
    ));
  }

  /**
   * Replies to notes this index already holds.
   *
   * A reply is a kind:1 carrying an `e` tag to its parent and nothing else that
   * identifies it — no `k: podcast:guid`, no `t: boostagram` — so it matches
   * neither core filter, and the tracked filter asks its authors for kinds
   * 0/6/5 rather than 1. There is no filter shape that finds replies except
   * asking for them by parent id, which is what this does.
   *
   * `ingest.ts` already accepts kind:1, so nothing else had to change: the
   * subscription was the only thing missing, and `replyForest` has been
   * returning `[]` from a correct query over an empty set for the life of the
   * feature.
   */
  /**
   * NIP-53 live activities (kind:30311), for the homepage's "Live on Nostr" row.
   *
   * No backfill and no separate seed query: a relay answers a REQ with the
   * stored events matching the filter and THEN streams new ones, so a
   * subscription carrying `since` seeds itself. That is also why it is not in
   * CORE_FILTERS — `backfillLoop` walks those back to the 180-day floor, which
   * for this kind would page in thousands of broadcasts that ended in spring.
   *
   * Re-subscribed on a timer because the `since` is baked in at REQ time. A
   * process up for a week would otherwise be asking about a window that
   * started a week before it booted.
   */
  private subscribeLive(): void {
    const since = Math.floor(Date.now() / 1000) - LIVE_WINDOW_SECS;
    this.setSubs('live', [
      this.pool.subscribeMany(this.relays, {
        kinds: [LIVE_STREAM_KIND], since, limit: LIVE_SEED_LIMIT,
      }, {
        onevent: (e) => void this.take(e, 'live'),
        onclose: () => console.warn('[indexer] live subscription closed'),
      }),
    ]);
  }

  private async subscribeReplies(): Promise<void> {
    const ids = await recentNoteIds(this.db, REPLY_WATCH_IDS);
    const fingerprint = fingerprintOf(ids);
    if (!ids.length || fingerprint === this.replyFingerprint) return;
    this.replyFingerprint = fingerprint;

    const closers: { close(): void }[] = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      closers.push(this.pool.subscribeMany(this.relays, {
        kinds: [1], '#e': ids.slice(i, i + ID_CHUNK),
      }, { onevent: (e) => void this.take(e, 'replies') }));
    }
    this.setSubs('replies', closers);
    console.log(`[indexer] reply subscriptions rebuilt for ${ids.length} notes`);
  }

  /**
   * Subscriptions scoped to pubkeys we have actually seen.
   *
   * kind:9735 is never subscribed unfiltered — that is every zap on the
   * network. The explorer only ever shows zaps for a pubkey it is already
   * displaying, so growing the scope from observed notes covers exactly what is
   * needed and nothing more.
   *
   * kind:5 is authors-scoped for the same reason and a stronger one: a
   * deletion only ever applies to its own author's events, so a kind:5 from
   * someone we have never indexed can have nothing to delete.
   */
  private async subscribeTracked(): Promise<void> {
    const pubkeys = await trackedPubkeys(this.db, MAX_TRACKED_IN_FILTERS);
    const fingerprint = fingerprintOf(pubkeys);
    if (!pubkeys.length || fingerprint === this.trackedFingerprint) return;
    this.trackedFingerprint = fingerprint;

    // nostr-tools 2.19.4 takes ONE filter per subscription, so each half is a
    // separate subscription rather than one call with several filters.
    //
    // kind:0 is asked for ON ITS OWN, not folded in beside 6 and 5. A relay
    // caps a filter's result at its own default (strfry's is 500) and serves
    // the NEWEST matches first; a profile is written once and rarely touched,
    // so kind:0 sorts behind every recent repost and deletion from the same 500
    // authors and gets truncated away. Measured on production 2026-08-25, the
    // live bundle carried 6 profiles for 24 distinct note authors while relays
    // held 20 of the 24. Separating the filter is what stops high-churn kinds
    // spending the profile budget.
    const closers: { close(): void }[] = [];
    for (let i = 0; i < pubkeys.length; i += PUBKEY_CHUNK) {
      const chunk = pubkeys.slice(i, i + PUBKEY_CHUNK);
      const filters: Filter[] = [
        { kinds: [0], authors: chunk },
        { kinds: [6, 5], authors: chunk },
        { kinds: [9735], '#p': chunk },
      ];
      for (const filter of filters) {
        closers.push(this.pool.subscribeMany(this.relays, filter, {
          onevent: (e) => void this.take(e, 'tracked'),
        }));
      }
    }
    this.setSubs('tracked', closers);
    console.log(`[indexer] tracked subscriptions rebuilt for ${pubkeys.length} pubkeys`);
  }

  /**
   * Each configured relay sorted into the three states that matter.
   *
   * `subless` is the one worth naming: a relay with an OPEN socket and no
   * subscriptions on it. That is the shape of the failure this whole change
   * exists for — the process looks perfectly healthy from outside and indexes
   * nothing — and it is invisible to a plain connected/disconnected count.
   */
  connectedRelays(): { connected: string[]; down: string[]; subless: string[] } {
    const connected: string[] = [];
    const down: string[] = [];
    const subless: string[] = [];
    for (const url of this.relays) {
      const relay = this.pool.relayFor(url);
      if (!relay?.connected) { down.push(url); continue; }
      connected.push(url);
      if (relay.openSubs.size === 0) subless.push(url);
    }
    return { connected, down, subless };
  }

  /**
   * The watchdog behind nostr-tools' own reconnect.
   *
   * The library's reconnect is the primary recovery and handles every case
   * seen so far. This exists because the failure it covers is SILENT and
   * total: if reconnect ever leaves a relay in the pool without re-firing its
   * subscriptions, the process keeps running, keeps answering /health, and
   * indexes nothing — which is exactly the state this service was found in.
   *
   * The trigger is SUBSCRIPTION state, not event freshness and not a plain
   * connected count. Both of the obvious triggers are wrong:
   *
   *  - Freshness is wrong because this corpus is genuinely quiet — roughly 26
   *    podcast notes a day — so "no events for an hour" is an ordinary
   *    afternoon, and a watchdog that rebuilt on it would thrash the relays
   *    for nothing.
   *  - "No relay connected" is wrong because this method REPAIRS that itself,
   *    by re-dialling. Measured while building this: with the fix's pool
   *    options reverted, the watchdog re-dialled the dropped relay, the next
   *    check saw it connected and cleared the counter, and the rebuild never
   *    fired — while the fresh relay object carried no subscriptions and
   *    ingestion stayed dead. A backstop whose own repair clears its trigger
   *    is not a backstop.
   *
   * So it triggers on a relay that is CONNECTED and carries no subscriptions,
   * which is the failure itself rather than a proxy for it. Two consecutive
   * observations, because `subscribeMany` reaches a relay asynchronously and a
   * relay legitimately has no subs for a moment right after start.
   */
  private async checkConnectivity(): Promise<void> {
    if (this.stopped) return;
    const { connected, down, subless } = this.connectedRelays();

    // Re-dial anything down. With reconnect enabled `ensureRelay` returns the
    // SAME relay object, so its existing subscriptions come back with it; this
    // only shortens the wait when the library is mid-backoff.
    for (const url of down) {
      try { await this.pool.ensureRelay(url, { connectionTimeout: 5_000 }); } catch { /* still down */ }
    }
    if (down.length) console.warn(`[indexer] ${down.length}/${this.relays.length} relay(s) down: ${down.join(', ')}`);

    if (!subless.length) { this.deadChecks = 0; return; }

    this.deadChecks++;
    console.warn(
      `[indexer] ${subless.length} relay(s) connected with NO subscriptions ` +
      `(check ${this.deadChecks}/${DEAD_CHECKS_BEFORE_REBUILD}): ${subless.join(', ')}`,
    );
    if (this.deadChecks < DEAD_CHECKS_BEFORE_REBUILD) return;
    this.deadChecks = 0;
    console.warn(`[indexer] rebuilding every subscription from scratch (${connected.length} relays connected)`);
    this.closeAllSubs();
    this.subscribeCore();
    // Neither dynamic set has changed while nothing was being ingested, so
    // clear both fingerprints or their rebuilds return early and only the core
    // half comes back — which would look like a recovery and index no replies
    // and no profiles.
    this.trackedFingerprint = '';
    this.replyFingerprint = '';
    await this.subscribeTracked().catch(logErr('rebuild tracked'));
    await this.subscribeReplies().catch(logErr('rebuild replies'));
    this.subscribeLive();
  }

  /** What /health reports. Cheap enough to serve unauthenticated on every
   *  request: one indexed `max(seen_at)` and an in-memory socket count. */
  async health(): Promise<{
    indexedThrough: number;
    secondsBehind: number;
    relaysConnected: number;
    relaysConfigured: number;
    relaysDown: string[];
    relaysWithoutSubscriptions: string[];
    subscriptions: number;
  }> {
    const through = await indexedThrough(this.db);
    const { connected, down, subless } = this.connectedRelays();
    return {
      indexedThrough: through,
      secondsBehind: through ? Math.max(0, Math.floor(Date.now() / 1000) - through) : -1,
      relaysConnected: connected.length,
      relaysConfigured: this.relays.length,
      relaysDown: down,
      relaysWithoutSubscriptions: subless,
      subscriptions: this.subCount(),
    };
  }

  private async take(event: Event, source: string): Promise<void> {
    if (this.stopped) return;
    // kind:0 and kind:5 are replaceable / repeatable, so they must reach the
    // store even when the id was seen: a profile update carries a new id, but a
    // relay replaying the SAME kind:5 is worth re-applying cheaply.
    if (event.kind !== 5 && this.seen.has(event.id)) return;
    if (this.seen.size >= SEEN_CAP) this.seen.clear();
    this.seen.add(event.id);
    try {
      await ingestEvent(this.db, event, this.stats);
    } catch (e) {
      console.error(`[indexer] ingest failed (${source}):`, e instanceof Error ? e.message : e);
    }
  }

  /**
   * Walk history backwards, one page at a time, resuming from whatever the last
   * run reached. `until` paging is the only portable way to page a relay.
   *
   * Deliberately slow (a pause between pages). This is background catch-up
   * against relays we do not own; the live subscriptions already carry
   * everything new.
   */
  private async backfillLoop(): Promise<void> {
    const floor = Math.floor(Date.now() / 1000) - this.cfg.backfillDays * 86_400;
    for (const { name, filter } of CORE_FILTERS) {
      if (this.stopped) return;
      const key = `backfill:${name}`;
      const state = await getState(this.db, key);
      if (state?.backfill_done) {
        console.log(`[indexer] backfill ${name} already complete`);
        continue;
      }
      let until = state?.backfill_until ?? Math.floor(Date.now() / 1000);
      for (;;) {
        if (this.stopped) return;
        let page: Event[] = [];
        try {
          page = await this.pool.querySync(this.relays, { ...filter, until, limit: BACKFILL_PAGE }, { maxWait: 10_000 });
        } catch (e) {
          console.error(`[indexer] backfill ${name} page failed:`, e instanceof Error ? e.message : e);
          await sleep(5_000);
          continue;
        }
        const fresh = page.filter((e) => !this.seen.has(e.id));
        for (const e of page) await this.take(e, `backfill:${name}`);

        const oldest = page.reduce((min, e) => Math.min(min, e.created_at), until);
        // No page, or the page did not move the cursor: relays have no more
        // history for this filter.
        if (!page.length || oldest >= until) {
          await setState(this.db, key, { backfillDone: true, backfillUntil: oldest, status: 'done' });
          console.log(`[indexer] backfill ${name} complete at ${oldest}`);
          break;
        }
        until = oldest;
        await setState(this.db, key, { backfillUntil: until, status: 'running' });
        if (until <= floor) {
          await setState(this.db, key, { backfillDone: true, status: 'floor' });
          console.log(`[indexer] backfill ${name} reached the ${this.cfg.backfillDays}-day floor`);
          break;
        }
        console.log(`[indexer] backfill ${name}: ${fresh.length} new, cursor ${new Date(until * 1000).toISOString()}`);
        await sleep(BACKFILL_PAUSE_MS);
      }
    }
  }

  /**
   * Warm pi_podcasts / pi_episodes for identifiers seen on indexed notes.
   *
   * An entry only lands in the tables when Podcast Index actually ANSWERED —
   * either with a feed or with "not found". A failure leaves the queue row
   * alone to be retried, and writes nothing, because a row here is read by the
   * client as a cached answer.
   */
  private async piLoop(): Promise<void> {
    if (!piConfigured()) {
      console.log('[indexer] PODCAST_INDEX_KEY unset — warm-fill disabled');
      return;
    }
    for (;;) {
      if (this.stopped) return;
      const { rows } = await this.db.query<{ key: string; kind: string; feed_guid: string; item_guid: string | null }>(
        `select key, kind, feed_guid, item_guid from pi_queue
           where attempts < 5 and (last_try is null or last_try < now() - interval '1 hour')
           order by attempts, queued_at limit 20`,
      );
      if (!rows.length) { await sleep(30_000); continue; }

      for (const row of rows) {
        if (this.stopped) return;
        await this.db.query('update pi_queue set attempts = attempts + 1, last_try = now() where key = $1', [row.key]);
        try {
          if (row.kind === 'podcast') {
            const ans = await fetchPodcastByGuid(row.feed_guid);
            if (!ans) continue; // could not ask — nothing recorded, retried later
            await this.db.query(
              `insert into pi_podcasts (guid, data, miss, fetched_at) values ($1, $2::jsonb, $3, now())
               on conflict (guid) do update set data = excluded.data, miss = excluded.miss, fetched_at = now()`,
              [row.feed_guid, 'found' in ans ? JSON.stringify(ans.found) : null, !('found' in ans)],
            );
          } else if (row.item_guid) {
            const ans = await fetchEpisodeByGuid(row.feed_guid, row.item_guid);
            if (!ans) continue;
            await this.db.query(
              `insert into pi_episodes (feed_guid, item_guid, data, miss, fetched_at) values ($1, $2, $3::jsonb, $4, now())
               on conflict (feed_guid, item_guid) do update set data = excluded.data, miss = excluded.miss, fetched_at = now()`,
              [row.feed_guid, row.item_guid, 'found' in ans ? JSON.stringify(ans.found) : null, !('found' in ans)],
            );
          }
          await this.db.query('delete from pi_queue where key = $1', [row.key]);
        } catch (e) {
          console.error('[indexer] pi warm-fill failed:', e instanceof Error ? e.message : e);
        }
        // PI is a shared quota and this is background work. One request a
        // second is plenty to keep up with new notes.
        await sleep(1_000);
      }
    }
  }

  private reportStats(): void {
    const s = this.stats;
    // Deliberately prints on an all-zero minute too. It used to return early
    // there, which meant the one state worth shouting about — ingesting
    // nothing at all — was the single state that produced no log line, and
    // the service sat stalled for hours saying nothing.
    if (!s.stored && !s.profiles && !s.deleted && !s.rejected) {
      const { connected, subless } = this.connectedRelays();
      console.log(
        `[indexer] idle: nothing ingested this minute, ` +
        `${connected.length}/${this.relays.length} relays connected` +
        (subless.length ? `, ${subless.length} WITHOUT SUBSCRIPTIONS` : '') +
        ` ${this.memoryLine()}`,
      );
      return;
    }
    console.log(
      `[indexer] stored=${s.stored} profiles=${s.profiles} deleted=${s.deleted} ` +
      `rejected=${s.rejected} ${JSON.stringify(s.rejectReasons)} ${this.memoryLine()}`,
    );
    this.stats = emptyStats();
  }

  /**
   * The four numbers needed to explain an OOM, on the line that already prints
   * every minute.
   *
   * This service ran out of heap at ~2046 MB after 3h22m and stopped itself,
   * and nothing in any log said the memory was climbing — the outage was found
   * three days later by someone reading `/api/nostr/index` 503s. A growth curve
   * costs one line a minute and is the difference between a leak that is
   * measurable and one that has to be reproduced from scratch, which was tried
   * and failed: a local run under the same code sat FLAT for 18 minutes because
   * it ingests ~6 events a minute where production ingests thousands.
   *
   * Each number answers a specific question that reading the code did not:
   *
   *  - `heap` and `rss` — is it growing at all, and how fast. Both, because a
   *    gap between them is external memory (sockets, buffers), which is not
   *    what `--max-old-space-size` bounds and not what the OOM reported.
   *  - `subs` — `subCount()` across every group. The first hypothesis was that
   *    rebuilds leaked subscriptions; an isolated probe opened and closed 1,290
   *    and rejected it, but that was against ONE mock relay, and the real thing
   *    runs five, one of which refuses REQs. If this climbs while heap climbs,
   *    that hypothesis is back.
   *  - `seen` — the dedupe set, capped at SEEN_CAP and then CLEARED WHOLE. That
   *    is the one number that explains production's `profiles=5206` minutes: at
   *    the clear, every re-delivered profile stops being a duplicate and gets
   *    reprocessed. A sawtooth here that lines up with heap steps identifies it;
   *    a flat `seen` under a climbing heap rules it out.
   *
   * `rss` uses `process.memoryUsage.rss()`, which does not allocate the object
   * the full call does — this runs on a timer for the life of the process.
   */
  private memoryLine(): string {
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    const m = process.memoryUsage();
    return `heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB rss=${mb(process.memoryUsage.rss())}MB `
      + `ext=${mb(m.external)}MB subs=${this.subCount()} seen=${this.seen.size}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * FNV-1a over the tracked pubkeys, without materialising the concatenation.
 * Only used to answer "did this set change?" — never as an identifier.
 *
 * ORDER-INSENSITIVE, and that is the whole point rather than a nicety.
 *
 * It used to fold the list sequentially, so the digest depended on the ORDER as
 * well as the membership. `trackedPubkeys` reads `order by seen_at desc`, and
 * `seen_at` bumps every time an already-tracked pubkey posts — so the order
 * churns constantly while the membership barely moves. Every 60-second tick
 * therefore saw a "changed" set and tore down all 30 tracked subscriptions
 * across every relay to rebuild the identical ones.
 *
 * Measured in production on 2026-09-03: 33 rebuilds in 39 minutes — one per
 * interval, exactly as if the comparison were not there — each pushing about
 * 4.6 MB of REQ payload (5,000 pubkeys x 3 filters x 5 relays). RSS climbed
 * 780 MB/hour with `subs` flat at 37 and 428 MB unaccounted for outside the V8
 * heap: the payload sitting in socket and TLS buffers, on relays that were not
 * draining it — primal refused 238 REQs in the same window. That is the leak in
 * #301, which OOMed the service at 2 GB and stopped it for three days.
 *
 * So each pubkey is hashed on its own and the results are combined with
 * operations that do not care about order. XOR alone would let a pair of equal
 * hashes cancel, so a wrapping sum is carried too — a swap that preserves the
 * XOR has to preserve the sum as well. The count stays in the string because it
 * is free and catches the case both accumulators miss.
 *
 * Membership changes are still caught, which is what the comparison is FOR: a
 * pubkey entering as another leaves keeps the count identical, and that was the
 * reason this is a digest rather than a length check.
 */
export function fingerprintOf(pubkeys: string[]): string {
  let xor = 0;
  let sum = 0;
  for (const pk of pubkeys) {
    let h = 0x811c9dc5;
    for (let i = 0; i < pk.length; i++) {
      h ^= pk.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    xor = (xor ^ h) >>> 0;
    sum = (sum + h) >>> 0;
  }
  return `${pubkeys.length}:${xor.toString(16)}:${sum.toString(16)}`;
}

function logErr(what: string) {
  return (e: unknown) => console.error(`[indexer] ${what} failed:`, e instanceof Error ? e.message : e);
}
