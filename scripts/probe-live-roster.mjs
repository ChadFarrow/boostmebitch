// Answer "this show is live via RSS, so why is it not in the live tab?" — for
// one feed, gate by gate, with the shipping decisions rather than a guess.
//
// Usage:
//   npm run probe:liveroster -- <feedId | feedUrl | feed title>
//
// Needs PODCAST_INDEX_KEY / PODCAST_INDEX_SECRET, because two of the four gates
// ARE Podcast Index. The npm script loads `.env.local` for you with
// `--env-file-if-exists`, so `npm run probe:liveroster -- <target>` is the whole
// of it — no exported variables, and no failure when that file is absent (the
// script says what is missing instead, which is the more useful error).
//
// WHY THIS EXISTS. `/live` shows a `<podcast:liveItem>` only if some roster
// nominated its feed for an RSS read, and there are four independent ways for a
// genuinely-live show to be absent — each of which looks identical on screen:
//
//   1  PI's /episodes/live does not list the feed at all. Documented and
//      measured (docs/feeds.md): PI lags the live transition in both
//      directions. Nothing then reads the feed unless the VISITOR nominates it.
//   2  PI lists it, but past `MAX_LIVE_FEEDS` in `liveRosterFeedOrder`, so the
//      route's verification budget never reaches it.
//   3  The item is dropped by `liveBroadcastIsOver` — a `status="live"` more
//      than 6 h past its declared `end`, or more than 24 h past its `start`
//      with no `end` at all (the continuously-live shape that rule gets wrong).
//   4  The feed's medium makes `<LivePage>`'s client-side filter drop it from
//      the `?feeds=` roster, so favoriting it would not help either.
//
// Read-only: fetches and prints. It writes nothing and pays nothing.
//
// It imports the REAL `liveBroadcastIsOver` and `liveRosterFeedOrder` from
// lib/util.ts, so gates 2 and 3 are the app's own answers and cannot drift from
// it. The one local piece is finding a `<podcast:liveItem>` open tag, the same
// minimal scan scripts/probe-live-item.mjs keeps for the same reason — reading
// raw attributes rather than reproducing lib/pi.ts's parser.
import crypto from 'node:crypto';
import {
  LIVE_OVERRUN_GRACE_SECS,
  MAX_UNBOUNDED_LIVE_SECS,
  isMusicMedium,
  isPlaylistMedium,
  liveBroadcastIsOver,
  liveRosterFeedOrder,
} from '../lib/util.ts';

/** Kept in step with `MAX_LIVE_FEEDS` in app/api/live-shows/route.ts. */
const MAX_LIVE_FEEDS = 24;

// JOINED, not `find`. An unquoted `-- Planet Rage` arrives as two arguments,
// and taking the first silently searches for "Planet" — a wrong answer that
// reads like a real one, which is the opposite of what a probe is for.
const target = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim();
if (!target) {
  console.error('usage: npm run probe:liveroster -- <feedId | feedUrl | feed title>');
  process.exit(2);
}

const BASE = 'https://api.podcastindex.org/api/1.0';
function authHeaders() {
  const key = process.env.PODCAST_INDEX_KEY;
  const secret = process.env.PODCAST_INDEX_SECRET;
  if (!key || !secret) {
    console.error('Missing PODCAST_INDEX_KEY / PODCAST_INDEX_SECRET.');
    console.error('They live in .env.local at the repo root, which the npm script loads:');
    console.error('');
    console.error('  cp .env.example .env.local     # then put your key and secret in it');
    console.error(`  npm run probe:liveroster -- ${JSON.stringify(target)}`);
    console.error('');
    console.error('Get a free key at https://api.podcastindex.org/signup');
    process.exit(2);
  }
  const ts = Math.floor(Date.now() / 1000).toString();
  return {
    'X-Auth-Key': key,
    'X-Auth-Date': ts,
    Authorization: crypto.createHash('sha1').update(key + secret + ts).digest('hex'),
    'User-Agent': 'probe-live-roster',
  };
}

async function pi(path) {
  const res = await fetch(BASE + path, { headers: authHeaders() });
  if (!res.ok) throw new Error(`PI ${res.status} on ${path}`);
  return res.json();
}

const nowSec = Math.floor(Date.now() / 1000);
const clock = (t) =>
  typeof t === 'number' && Number.isFinite(t)
    ? `${new Date(t * 1000).toISOString()} (${rel(t)})`
    : '—';
const rel = (t) => {
  const d = nowSec - t;
  const m = Math.round(Math.abs(d) / 60);
  const s = m >= 120 ? `${(m / 60).toFixed(1)} h` : `${m} min`;
  return d >= 0 ? `${s} ago` : `in ${s}`;
};

// ── Which feed are we talking about ────────────────────────────────────────
let feed;
if (/^\d+$/.test(target)) {
  feed = (await pi(`/podcasts/byfeedid?id=${target}`)).feed;
} else if (/^https?:\/\//i.test(target)) {
  feed = (await pi(`/podcasts/byfeedurl?url=${encodeURIComponent(target)}`)).feed;
} else {
  const hits = (await pi(`/search/byterm?q=${encodeURIComponent(target)}`)).feeds ?? [];
  feed = hits[0];
  if (hits.length > 1) {
    console.log(`\n${hits.length} feeds matched "${target}"; using the first:`);
    for (const f of hits.slice(0, 5)) console.log(`   ${f.id}  ${f.title}`);
  }
}
if (!feed?.id) {
  console.error(`\nPodcast Index has no feed for "${target}".`);
  console.error('Nothing on /live can find a feed PI does not hold — the route resolves');
  console.error('every candidate through /podcasts/byfeedid to get its URL.');
  process.exit(1);
}

console.log(`\n  feed      ${feed.id}  ${feed.title}`);
console.log(`  url       ${feed.url}`);
console.log(`  medium    ${feed.medium ?? '—'}`);
console.log(`  guid      ${feed.podcastGuid ?? '—'}`);

const verdicts = [];

// ── Gate 1 + 2: Podcast Index's global roster, and the cap ────────────────
const roster = (await pi('/episodes/live?max=1000')).items ?? [];
const mine = roster.filter((e) => Number(e.feedId) === Number(feed.id));

// The route's own two filters, in order, using the shipping predicates.
const statusOk = mine.filter((e) => {
  const s = typeof e.status === 'string' ? e.status.toLowerCase() : undefined;
  return s === 'live' || s === 'pending';
});
const kept = statusOk.filter(
  (e) =>
    !liveBroadcastIsOver(
      {
        status: String(e.status).toLowerCase(),
        startTime: typeof e.startTime === 'number' ? e.startTime : undefined,
        endTime: typeof e.endTime === 'number' ? e.endTime : undefined,
      },
      nowSec,
    ),
);

console.log(`\n── Podcast Index /episodes/live ─────────────────────────────`);

// THE NARROWING, GLOBALLY, AND IT IS THE HEADLINE OF THIS PROBE. An empty live
// tab has two causes that need opposite fixes: PI sent nothing, or PI sent rows
// and our own filters dropped every one. These four numbers separate them, and
// they mirror `rosterRows` / `rosterKept` / `rosterFeeds` in the route's
// response so the two can be read against each other.
const liveOrPending = roster.filter((e) => {
  const st = typeof e.status === 'string' ? e.status.toLowerCase() : undefined;
  return st === 'live' || st === 'pending';
});
const rosterKept = liveOrPending.filter(
  (e) =>
    !liveBroadcastIsOver(
      {
        status: String(e.status).toLowerCase(),
        startTime: typeof e.startTime === 'number' ? e.startTime : undefined,
        endTime: typeof e.endTime === 'number' ? e.endTime : undefined,
      },
      nowSec,
    ),
);
console.log(`  rows PI sent (rosterRows)      ${roster.length}`);
console.log(`  after the status test          ${liveOrPending.length}`);
console.log(`  after liveBroadcastIsOver      ${rosterKept.length}  (rosterKept)`);
console.log(`  distinct feeds (rosterFeeds)   ${new Set(rosterKept.map((e) => Number(e.feedId))).size}`);
if (roster.length === 0) {
  console.log('  → PI SENT NOTHING. No filter of ours is involved. The global Live');
  console.log('    tab cannot work at all, for any visitor, until a durable roster exists.');
} else if (rosterKept.length === 0) {
  console.log('  → PI SENT ROWS AND WE DROPPED EVERY ONE. This is our bug, in');
  console.log('    getGlobalLiveItemsDetailed. A sample row, verbatim:');
  console.log('    ' + JSON.stringify(roster[0]).slice(0, 600));
}
console.log(`  rows for this feed: ${mine.length}`);
for (const e of mine) {
  console.log(`   · status=${e.status}  start=${clock(e.startTime)}  end=${clock(e.endTime)}  "${e.title}"`);
}
if (mine.length && !statusOk.length) {
  console.log('  → every row is `ended`, which getGlobalLiveItems drops.');
}
if (statusOk.length && !kept.length) {
  console.log('  → every row is dropped by liveBroadcastIsOver (see the end of this report).');
}

if (!kept.length) {
  verdicts.push(
    'GATE 1 — Podcast Index does not report this feed as live or pending.\n' +
      '    This is the documented false NEGATIVE (docs/feeds.md): RSS verification\n' +
      '    repairs false positives only. The feed is then read only if the VISITOR\n' +
      '    nominates it, which today means favoriting or having boosted the show.',
  );
} else {
  // What the route would actually rank, built from the same rows it builds from.
  const forOrder = roster
    .filter((e) => {
      const s = typeof e.status === 'string' ? e.status.toLowerCase() : undefined;
      if (s !== 'live' && s !== 'pending') return false;
      return !liveBroadcastIsOver(
        {
          status: s,
          startTime: typeof e.startTime === 'number' ? e.startTime : undefined,
          endTime: typeof e.endTime === 'number' ? e.endTime : undefined,
        },
        nowSec,
      );
    })
    .map((e) => ({
      feedId: e.feedId,
      liveStatus: String(e.status).toLowerCase(),
      liveStartTime: typeof e.startTime === 'number' ? e.startTime : undefined,
    }));
  const order = liveRosterFeedOrder(forOrder);
  const rank = order.indexOf(Number(feed.id));
  console.log(`  rank under liveRosterFeedOrder: ${rank + 1} of ${order.length}  (cap ${MAX_LIVE_FEEDS})`);
  if (rank >= MAX_LIVE_FEEDS) {
    verdicts.push(
      `GATE 2 — the feed ranks ${rank + 1} of ${order.length}, past MAX_LIVE_FEEDS (${MAX_LIVE_FEEDS}),\n` +
        '    so the route never reads it. Raise the cap only after measuring the clock\n' +
        '    budget in app/api/live-shows/route.ts.',
    );
  } else {
    console.log('  → inside the cap: the route WILL read this feed from RSS.');
  }
}

// ── Gate 3: the publisher's own feed ──────────────────────────────────────
console.log(`\n── ${feed.url} ──`);
let xml = '';
try {
  const res = await fetch(feed.url, { headers: { 'User-Agent': 'probe-live-roster' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  xml = await res.text();
  console.log(`  read ${xml.length} bytes`);
} catch (e) {
  console.log(`  could not read the feed: ${e.message}`);
  console.log('  → an unreadable feed is mergeLiveOverPi\'s `ok: false`: PI\'s rows survive');
  console.log('    and the card is stamped UNCHECKED. It never DELETES a live row.');
}

// Attributes only — the app's parser stays in lib/pi.ts.
const OPEN = /<podcast:liveItem\b([^>]*)>/gi;
const attr = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs);
  return m ? m[1] : undefined;
};
const secs = (v) => {
  const ms = v ? Date.parse(v) : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
};

let found = 0;
let survived = 0;
for (const m of xml.matchAll(OPEN)) {
  const attrs = m[1];
  if (attrs.trimEnd().endsWith('/')) continue; // self-closing: not a broadcast
  const status = attr(attrs, 'status')?.toLowerCase();
  if (status !== 'live' && status !== 'pending') continue;
  found++;
  const startTime = secs(attr(attrs, 'start'));
  const endTime = secs(attr(attrs, 'end'));
  const over = liveBroadcastIsOver({ status, startTime, endTime }, nowSec);
  if (!over) survived++;
  console.log(
    `   · status=${status}  start=${clock(startTime)}  end=${clock(endTime)}` +
      `  ${over ? '✗ DROPPED by liveBroadcastIsOver' : '✓ kept'}`,
  );
}
if (xml) {
  console.log(`  ${found} live/pending <podcast:liveItem> block(s), ${survived} kept`);
  if (found && !survived) {
    verdicts.push(
      'GATE 3 — the feed carries a live item and liveBroadcastIsOver drops it.\n' +
        `    A status="live" item leaves ${LIVE_OVERRUN_GRACE_SECS / 3600} h after its declared \`end\`, and an item\n` +
        `    with no \`end\` leaves ${MAX_UNBOUNDED_LIVE_SECS / 3600} h after its \`start\`. A continuously-live\n` +
        '    broadcast with no declared end is the one shape that rule gets wrong.',
    );
  }
  if (!found) {
    verdicts.push(
      'GATE 3 — the feed publishes no live or pending <podcast:liveItem> right now.\n' +
        '    An `ok: true` read is authoritative about which items EXIST, so this also\n' +
        '    removes any row PI still holds. Check you read the same URL the app does.',
    );
  }
}

// ── Gate 4: the client-side roster filter ─────────────────────────────────
const medium = { medium: feed.medium };
if (isMusicMedium(medium) || isPlaylistMedium(medium)) {
  verdicts.push(
    `GATE 4 — medium is "${feed.medium}", which <LivePage> filters out of the ?feeds=\n` +
      '    roster (an album never publishes a live item). So favoriting this show does\n' +
      '    NOT get its feed read, and only PI\'s roster can surface it.',
  );
} else {
  console.log(`\n  medium "${feed.medium ?? 'absent'}" passes <LivePage>'s ?feeds= filter`);
  console.log('  → favoriting or boosting this show makes /live read its feed directly,');
  console.log('    which is what repairs a PI false negative today.');
}

console.log('\n══ verdict ═══════════════════════════════════════════════════');
if (!verdicts.length) {
  console.log('  Every gate passes. The route should be listing this show — so the');
  console.log('  remaining suspects are the response itself and the client:');
  console.log('    curl -s "http://localhost:3000/api/live-shows" | jq \'.items[].feedTitle\'');
  console.log('  and check `unverifiedFeeds`/`truncated` in the same body.');
} else {
  for (const v of verdicts) console.log('  ' + v + '\n');
}
