import { after } from 'next/server';
import { authHeaders } from '../pi';
import { BRANDS } from '../brand';
import { COMMUNITY_FEED_ORIGIN, communityFeedUrl } from '../curated-playlists';
import { readCappedJson } from '../capped-body';
import { safeFetch } from '../safe-fetch';
import { mapLimit } from '../util';
import {
  piNotifyBase, piNoticeAllowed, piSecondNotifyMs, piFeedIdFrom, PI_API_BASE, PI_NOTICE_DAY_MS,
} from './rules';
import { podpingTarget, sendPodpings } from './podping-notify';
import { claimPiNotice, isMissingColumn, listPiStates, readPiNoticeRow, setPiFeedId, type PiState } from './store';

// SERVER-ONLY. Tells Podcast Index about a community playlist feed, so people can
// find it there (Chad, 2026-11-19: "they get submitted to the podcast index so
// that people can search for them from there"; test playlists too). AUTOMATIC at
// PUBLISH and SAVE, with no button (Chad, 2026-11-23: "the users doesnt even need
// to know"), and with NO write key (Chad: "msp does not have write access and
// never has").
//
// A NOTICE IS PUBLIC AND MAY BE PERMANENT: Podcast Index has no delete, and the
// podping is written to Hive. So it is OFF unless `piNotifyBase` (lib/community/
// rules.ts, pinned by check:community) says yes: `COMMUNITY_PI_NOTIFY=on`, the real
// feed origin, and Vercel production or the `beta` branch. A test's `PI_NOTIFY_API`
// may name only a loopback stub.
//
// - `publish` (a create, or an owner SAVE), the way MSP-2.0 does it
//   (`api/_utils/feedUtils.ts`): first the rules (`piNoticeAllowed`: not banned, at
//   least MIN_SONGS songs, one notice per feed per 10 minutes, and a first notice
//   counts against 5 per owner and 30 over all makers a day), then the feed must
//   answer 200, then `hub/pubnotify` with NO key headers (a User-Agent only) and the
//   podping, `PI_SECOND_NOTIFY_MS` later a second `hub/pubnotify`, then a read-key
//   lookup (`podcasts/byguid`, then `podcasts/byfeedurl`) that stores the PI feed id.
// - `gone` (a delete): `hub/pubnotify` and the podping, so PI reads the 410. It
//   cannot remove the feed. No rules: a delete happens once.
//
// `add/byfeedurl` is NOT sent: it needs a key with PI's write permission, every
// key Chad has is read-only, and it answered 401 on every call (docs/feeds.md).
//
// It never throws, and a response never waits for it (`after()`). Every outcome is
// one log line with the `[community-pi]` prefix; no line carries a key or a token.

export type PiNotifyKind = 'publish' | 'gone';

/** At most this many playlists are being announced at once (a ban can delete many). */
const PI_NOTIFY_FANOUT = 4;
/** One PI call; the whole publish path must stay inside the routes' `maxDuration` (60 s). */
const PI_CALL_MS = 8_000;
/** The feed's own answer, and each lookup. */
const FEED_CHECK_MS = 5_000;
const LOOKUP_MS = 5_000;

const LOG = '[community-pi]';
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The FEED's brand, on either deploy, as the feed's own <generator> is: every playlist
// feed is on Boost Me Buddy's origin. MSP sends its own name the same way.
const userAgent = () => BRANDS.buddy.userAgent;

function piBase(): string | null {
  return piNotifyBase({
    notify: process.env.COMMUNITY_PI_NOTIFY,
    override: process.env.PI_NOTIFY_API,
    vercelEnv: process.env.VERCEL_ENV,
    gitRef: process.env.VERCEL_GIT_COMMIT_REF,
    feedOrigin: COMMUNITY_FEED_ORIGIN,
  });
}

/** PI's `{ status, description, feed }`, or null when the body is not that. */
async function piAnswer(r: Response, cap = 16 * 1024): Promise<Record<string, unknown> | null> {
  const body = await readCappedJson(r, cap).catch(() => null);
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
}

/**
 * One `hub/pubnotify`, as MSP sends it: a GET with a User-Agent and NO `X-Auth-*`
 * headers. PI answers `{"status":"true","description":"Feed marked for immediate
 * update."}`, the same words for a feed it holds and one it does not.
 */
async function pubnotify(base: string, feedUrl: string, which: string): Promise<void> {
  try {
    const r = await fetch(`${base}/hub/pubnotify?url=${encodeURIComponent(feedUrl)}`, {
      headers: { 'User-Agent': userAgent() }, cache: 'no-store', signal: AbortSignal.timeout(PI_CALL_MS),
    });
    const a = await piAnswer(r);
    const said = String(a?.description ?? '').slice(0, 120);
    // PI says `status: "true"` as a STRING.
    if (r.ok && a?.status === 'true') console.log(LOG, `hub/pubnotify ${which}:`, r.status, said, feedUrl);
    else console.warn(LOG, `hub/pubnotify ${which} answered`, r.status, said, feedUrl);
  } catch (e) {
    console.warn(LOG, `hub/pubnotify ${which} failed:`, why(e), feedUrl);
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The status our own feed answers, or null when it could not be read. On a deploy
 * the feed is `https://www.boostmebuddy.com/…` (the gate makes sure), read through
 * `safeFetch`. Only when the notices go to a test's loopback stub may a loopback
 * feed be read with a plain fetch: nothing leaves the machine then.
 */
async function feedStatus(feedUrl: string, toStub: boolean): Promise<number | null> {
  try {
    const init: RequestInit = { headers: { 'User-Agent': userAgent() }, signal: AbortSignal.timeout(FEED_CHECK_MS) };
    const loop = LOOPBACK.has(new URL(feedUrl).hostname);
    const r = toStub && loop
      ? await fetch(feedUrl, { ...init, cache: 'no-store', redirect: 'manual' })
      : await safeFetch(feedUrl, init);
    await r.body?.cancel().catch(() => {});
    return r.status;
  } catch {
    return null;
  }
}

/**
 * The feed's Podcast Index id, with the READ key: `podcasts/byguid`, then
 * `podcasts/byfeedurl`. Null when neither lists it, or neither answered: a new
 * feed takes PI some minutes (Chad: "adding new feeds can take up to 15 minutes").
 * `signal` bounds a whole /admin pass.
 */
export async function lookupPiFeedId(
  base: string, podcastGuid: string, feedUrl: string, signal?: AbortSignal,
): Promise<number | null> {
  let headers: Record<string, string>;
  try {
    headers = authHeaders();
  } catch {
    return null; // no read key on this server: nothing to ask with
  }
  for (const path of [
    `/podcasts/byguid?guid=${encodeURIComponent(podcastGuid)}`,
    `/podcasts/byfeedurl?url=${encodeURIComponent(feedUrl)}`,
  ]) {
    try {
      const t = AbortSignal.timeout(LOOKUP_MS);
      const r = await fetch(`${base}${path}`, {
        headers, cache: 'no-store', signal: signal ? AbortSignal.any([signal, t]) : t,
      });
      const id = piFeedIdFrom(await piAnswer(r, 256 * 1024));
      if (id) return id;
    } catch {
      if (signal?.aborted) return null;
    }
  }
  return null;
}

async function announcePublish(id: string, base: string | null, ping: string | null): Promise<void> {
  const feedUrl = communityFeedUrl(id);
  const now = new Date();
  let row;
  try {
    row = await readPiNoticeRow(id, now, PI_NOTICE_DAY_MS);
  } catch (e) {
    // Fail closed: without the state the rules cannot be applied.
    console.warn(LOG, isMissingColumn(e)
      ? 'no notice: the pi_* columns are missing, run `npm run community:schema`:'
      : `no notice: could not read the notice state (${why(e)}):`, feedUrl);
    return;
  }
  if (!row) {
    console.log(LOG, 'no notice (the playlist is gone):', feedUrl);
    return;
  }
  const verdict = piNoticeAllowed({
    banned: row.banned,
    songCount: row.songCount,
    inIndex: row.piFeedId !== null,
    notifiedBefore: row.piFirstNotifiedAt !== null,
    lastNotifiedAt: row.piNotifiedAt ? row.piNotifiedAt.getTime() : null,
    ownerFirstToday: row.ownerFirstToday,
    allFirstToday: row.allFirstToday,
    now: now.getTime(),
  });
  if (!verdict.send) {
    console.log(LOG, `no notice (${verdict.reason}):`, feedUrl);
    return;
  }
  const toStub = !!base && base !== PI_API_BASE;
  const status = await feedStatus(feedUrl, toStub);
  if (status !== 200) {
    console.warn(LOG, `no notice: the feed answered ${status ?? 'nothing'}:`, feedUrl);
    return;
  }
  const claimed = await claimPiNotice(id, row.piNotifiedAt, now).catch((e) => {
    console.warn(LOG, `no notice: could not record it (${why(e)}):`, feedUrl);
    return null;
  });
  if (claimed === false) {
    console.log(LOG, 'no notice: another request sent it:', feedUrl);
    return;
  }
  if (claimed === null) return;
  console.log(LOG, verdict.first ? 'first notice:' : 'notice:', feedUrl);

  await Promise.all([
    base ? pubnotify(base, feedUrl, '1/2') : null,
    ping ? sendPodpings(ping, [feedUrl]) : null,
  ]);
  if (!base) return;
  await sleep(piSecondNotifyMs(process.env.PI_NOTIFY_SETTLE_MS, toStub));
  await pubnotify(base, feedUrl, '2/2');
  if (row.piFeedId !== null) return;
  const found = await lookupPiFeedId(base, row.podcastGuid, feedUrl);
  if (!found) {
    console.log(LOG, 'not in Podcast Index yet:', feedUrl);
    return;
  }
  await setPiFeedId(id, found).then(
    () => console.log(LOG, `in Podcast Index as feed ${found}:`, feedUrl),
    (e) => console.warn(LOG, `in Podcast Index as feed ${found}, not stored (${why(e)}):`, feedUrl),
  );
}

async function announceGone(id: string, base: string | null, ping: string | null): Promise<void> {
  const feedUrl = communityFeedUrl(id);
  await Promise.all([
    base ? pubnotify(base, feedUrl, '(gone)') : null,
    ping ? sendPodpings(ping, [feedUrl]) : null,
  ]);
}

/**
 * Announce one playlist, or several, after the response is sent (`after()` keeps
 * the serverless function alive for it), `PI_NOTIFY_FANOUT` at a time. Takes the
 * playlist IDS: a publish reads the playlist's notice state from the store. Never
 * throws; outside a request scope it falls back to fire-and-forget.
 */
export function notifyPodcastIndexAfter(ids: string | string[], kind: PiNotifyKind): void {
  const base = piBase();
  // The podping goes out at the same moments, for the same feeds, on its own gate
  // (`podpingTarget`): see ./podping-notify.
  const ping = podpingTarget();
  if (!base && !ping) return;
  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length === 0) return;
  const one = kind === 'publish' ? announcePublish : announceGone;
  const run = () => mapLimit(list, PI_NOTIFY_FANOUT, (id) => one(id, base, ping).catch((e) => {
    console.warn(LOG, 'failed:', why(e), communityFeedUrl(id));
  })).then(() => {}, () => {});
  try {
    after(run);
  } catch {
    void run();
  }
}

/** /admin looks up at most this many unlisted playlists per load, inside this time. */
const ADMIN_LOOKUPS = 24;
const ADMIN_LOOKUP_BUDGET_MS = 6_000;

/** A playlist's Podcast Index state on /admin. `asked`: a lookup ran during this load. */
export interface AdminPiState { id: string; piFeedId: number | null; piNotifiedAt: string | null; asked: boolean }

/**
 * The Podcast Index state of the live playlists for /admin, or null when the store
 * has no pi_* columns yet. Playlists with no stored id are looked up first (the
 * newest `ADMIN_LOOKUPS`, all inside `ADMIN_LOOKUP_BUDGET_MS`), and an id found is
 * stored. Lookups go where the notices go (`piBase`): none when that is off.
 */
export async function adminPiStates(limit: number): Promise<AdminPiState[] | null> {
  let states: PiState[];
  try {
    states = await listPiStates(limit);
  } catch (e) {
    if (isMissingColumn(e)) return null;
    throw e;
  }
  const base = piBase();
  const out: AdminPiState[] = states.map((s) => ({ id: s.id, piFeedId: s.piFeedId, piNotifiedAt: s.piNotifiedAt, asked: false }));
  if (!base) return out;
  const todo = out.filter((s) => s.piFeedId === null).slice(0, ADMIN_LOOKUPS);
  const guid = new Map(states.map((s) => [s.id, s.podcastGuid]));
  const budget = AbortSignal.timeout(ADMIN_LOOKUP_BUDGET_MS);
  await mapLimit(todo, 6, async (s) => {
    const found = await lookupPiFeedId(base, guid.get(s.id) ?? '', communityFeedUrl(s.id), budget);
    if (budget.aborted) return;
    s.asked = true;
    if (!found) return;
    s.piFeedId = found;
    await setPiFeedId(s.id, found).catch(() => {});
  }).catch(() => {});
  return out;
}
