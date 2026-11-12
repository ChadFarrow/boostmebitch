// e2e for the community-playlist API, over HTTP only (imports nothing from the app).
//
// Needs a dev server started with, on the command line (never in .env.local):
//   COMMUNITY_DB_URL=postgres://postgres:test@localhost:54329/postgres
//   ADMIN_NPUBS=<ADMIN_NPUB below> NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on
//   NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN=http://localhost:3123 npm run dev -- -p 3123
// and the schema applied (`npm run community:schema`). APP_URL overrides the server.
// It signs NIP-98 headers the way the browser will, so it needs only nostr-tools.
// Prints `ok`/`FAIL` lines; exits non-zero on any FAIL. It deletes what it makes.
// It sends a new x-real-ip every 5 requests (the rate limiter reads that header first on a
// local server), so the run never waits on the 6-writes-a-minute limit.
// `--off` runs only the switch-OFF half: start the server WITHOUT
// NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on for it, then restart with it on for the full run.
// It also depends on three third-party image URLs below (Fountain and headstarts.uk); if one
// moves, the art lines fail for that reason and not because of the routes.
import { randomBytes } from 'node:crypto';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { getToken } from 'nostr-tools/nip98';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';

const APP = (process.env.APP_URL || 'http://localhost:3123').replace(/\/$/, '');
const PLAYLISTS = '/api/community-playlists';

// TEST-ONLY admin key: it is public, has no value, and is not an account anyone uses.
// The dev server's ADMIN_NPUBS must be its npub (printed at the start of the run).
const ADMIN_SK = Uint8Array.from(Buffer.from('07'.repeat(32), 'hex'));
// A song source: one of COMMUNITY_PLAYLIST_URLS in lib/curated-playlists.ts
// ("New Music Nudge Unit"). Its resolved rows give real { feedGuid, itemGuid } pairs.
const SONG_SOURCE = 'https://v4vmusic.com/playlist/334bb12d-1f72-4c0e-88e1-266bd1e2dff9.xml';
// Cover art, found in that playlist's resolved tracks (2026-11-12). Checked with sharp.
// Accepted: a Fountain-hosted JPEG, 2000x2000, no alpha.
const ART_OK = 'https://feeds.fountain.fm/a43Ic3kG9KZNwtwOqTWP/files/COVER_ART---DEFAULT---54639a46-e3df-4612-8b81-f18785109ae2.jpg';
// Refused: headstarts.uk JPEG, 1476x1472 (not square).
const ART_NOT_SQUARE = 'https://headstarts.uk/msp/the_fifty_four_plates/grey_state/grey_state_album_cover.jpg';
// Refused: headstarts.uk JPEG, 200x200 (too small).
const ART_TOO_SMALL = 'https://headstarts.uk/msp/hear-my-roar/hearmyroar%20logo.jpg';

let fails = 0;
let count = 0;
const check = (label, cond, detail = '') => {
  count++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) { fails++; if (detail) console.log(`         ${detail}`); }
  return !!cond;
};
const show = (r) => `status ${r.status} body ${JSON.stringify(r.body)}`;

const newKey = () => Uint8Array.from(randomBytes(32));

// A fresh fake client address every 5 requests, to stay under the per-IP write limit.
let sent = 0;
const nextIp = () => `10.99.${Math.floor(sent++ / 5) % 250}.${Math.floor(sent / 1250) + 1}`;

/** One request. `sk` signs a NIP-98 header; `ageSeconds` backdates it. */
async function call(method, path, { sk, body, ageSeconds = 0, headers = {} } = {}) {
  const h = { ...headers, 'x-real-ip': nextIp() };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (sk) {
    h.authorization = await getToken(`${APP}${path.split('?')[0]}`, method, (e) => {
      e.created_at -= ageSeconds;
      return finalizeEvent(e, sk);
    }, true, body);
  }
  let res;
  try {
    res = await fetch(`${APP}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    return { status: 0, body: { error: String(e) }, headers: new Headers() };
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, headers: res.headers };
}


// ── the switch OFF half ─────────────────────────────────────────────────────
if (process.argv.includes('--off')) {
  const l = await call('GET', PLAYLISTS);
  check('switch off: GET list -> 404', l.status === 404, show(l));
  const x = await fetch(`${APP}/feeds/playlists/00000000-0000-4000-8000-000000000000.xml`);
  check('switch off: GET feed .xml -> 404', x.status === 404, String(x.status));
  const j = await fetch(`${APP}/feeds/playlists/00000000-0000-4000-8000-000000000000.jpg`);
  check('switch off: GET cover .jpg -> 404', j.status === 404, String(j.status));
  // The limiter is the route's first line, before the switch: 240 a minute from one
  // address, then 429, whether the feature is on or off.
  const flood = `10.98.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  let last = 0;
  for (let i = 0; i < 241; i++) {
    last = (await fetch(`${APP}/feeds/playlists/00000000-0000-4000-8000-000000000000.xml`, { headers: { 'x-real-ip': flood } })).status;
  }
  check('switch off: the 241st feed request in a minute from one address -> 429 (rateLimit runs first)', last === 429, String(last));
  console.log(`${count - fails}/${count} passed`);
  process.exit(fails ? 1 : 0);
}

// ── set-up: 12 real songs ───────────────────────────────────────────────────
const src = await call('GET', `/api/playlist?url=${encodeURIComponent(SONG_SOURCE)}&limit=40`);
// A row Podcast Index could not resolve carries `unresolved`; take the first 12 that resolved.
const songs = (src.body?.episodes ?? [])
  .filter((e) => !e.unresolved && e.guid && e.podcastGuid)
  .slice(0, 12)
  .map((e) => ({ feedGuid: e.podcastGuid, itemGuid: e.guid }));
if (songs.length < 12) {
  console.log(`FAIL could not read 12 songs from ${APP}/api/playlist (got ${songs.length}): ${show(src)}`);
  process.exit(1);
}

const owner = newKey();
const other = newKey();
const ownerPub = getPublicKey(owner);
console.log(`admin npub (for ADMIN_NPUBS): ${npubEncode(getPublicKey(ADMIN_SK))}`);
const draft = (over = {}) => ({ title: 'e2e playlist', description: 'made by e2e-community-api', artUrl: null, songs, ...over });
const created = [];

// ── reads ───────────────────────────────────────────────────────────────────
const empty = await call('GET', PLAYLISTS);
check('GET list answers 200 with a playlists array', empty.status === 200 && Array.isArray(empty.body?.playlists), show(empty));
check('GET list is cacheable without owner', /s-maxage=30/.test(empty.headers.get('cache-control') ?? ''), empty.headers.get('cache-control'));
const byOwner = await call('GET', `${PLAYLISTS}?owner=${ownerPub}`);
check('GET list?owner answers no-store and is empty for a new key',
  byOwner.status === 200 && byOwner.headers.get('cache-control') === 'no-store' && byOwner.body?.playlists?.length === 0, show(byOwner));

// ── auth ────────────────────────────────────────────────────────────────────
const unsigned = await call('POST', PLAYLISTS, { body: { draft: draft() } });
check('unsigned POST -> 401', unsigned.status === 401, show(unsigned));
const stale = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft() }, ageSeconds: 120 });
check('POST signed 120 s ago -> 401 naming the device clock',
  stale.status === 401 && /device clock/.test(stale.body?.error ?? ''), show(stale));
const wrongUrl = await call('POST', PLAYLISTS, {
  body: { draft: draft() },
  headers: { authorization: await getToken(`${APP}/somewhere/else`, 'POST', (e) => finalizeEvent(e, owner), true, { draft: draft() }) },
});
check('POST with a token for another URL -> 401', wrongUrl.status === 401, show(wrongUrl));

// A token signed for body A must not carry body B.
const bodyA = { draft: draft({ title: 'body A' }) };
const bodyB = { draft: draft({ title: 'body B' }) };
const swapped = await call('POST', PLAYLISTS, {
  body: bodyB,
  headers: { authorization: await getToken(`${APP}${PLAYLISTS}`, 'POST', (e) => finalizeEvent(e, owner), true, bodyA) },
});
check('POST signed for body A but sent with body B -> 401', swapped.status === 401, show(swapped));

// ── validation ──────────────────────────────────────────────────────────────
const few = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ songs: songs.slice(0, 9) }) } });
check('POST with 9 songs -> 400 too-few-songs',
  few.status === 400 && few.body?.problems?.some((p) => p.kind === 'too-few-songs'), show(few));
const fake = await call('POST', PLAYLISTS, {
  sk: owner,
  body: { draft: draft({ songs: [...songs.slice(0, 11), { feedGuid: songs[0].feedGuid, itemGuid: `made-up-${Date.now()}` }] }) },
});
check('POST with a made-up itemGuid -> 400 song-not-found',
  fake.status === 400 && fake.body?.problems?.some((p) => p.kind === 'song-not-found'), show(fake));
const badArt1 = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ artUrl: ART_NOT_SQUARE }) } });
check('POST with a non-square cover -> 400 { kind: art, reason: not-square }',
  badArt1.status === 400 && badArt1.body?.problems?.some((p) => p.kind === 'art' && p.reason === 'not-square'), show(badArt1));
const badArt2 = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ artUrl: ART_TOO_SMALL }) } });
check('POST with a 200 px cover -> 400 { kind: art, reason: too-small }',
  badArt2.status === 400 && badArt2.body?.problems?.some((p) => p.kind === 'art' && p.reason === 'too-small'), show(badArt2));
const httpArt = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ artUrl: 'http://example.com/a.jpg' }) } });
check('POST with an http cover -> 400 art-not-https',
  httpArt.status === 400 && httpArt.body?.problems?.some((p) => p.kind === 'art-not-https'), show(httpArt));
const bareArt = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ artUrl: 'https://' }) } });
if (bareArt.status === 201) created.push(bareArt.body.id);
check('POST with a bare https:// cover -> 400 art-bad-link',
  bareArt.status === 400 && bareArt.body?.problems?.some((p) => p.kind === 'art-bad-link'), show(bareArt));
const longArt = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ artUrl: `https://example.com/${'a'.repeat(2048)}.jpg` }) } });
if (longArt.status === 201) created.push(longArt.body.id);
check('POST with a cover link over 2048 characters -> 400 art-bad-link',
  longArt.status === 400 && longArt.body?.problems?.some((p) => p.kind === 'art-bad-link'), show(longArt));

// ── a secret key in the title or description is refused, and not echoed ────
// A throwaway key made for this line: it belongs to nobody.
const NSEC = nsecEncode(newKey());
const nsecTitle = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ title: `my mix ${NSEC}` }) } });
if (nsecTitle.status === 201) created.push(nsecTitle.body.id);
check('POST with an nsec in the title -> 400 { kind: secret, field: title }',
  nsecTitle.status === 400 && nsecTitle.body?.problems?.some((p) => p.kind === 'secret' && p.field === 'title'), show(nsecTitle));
check('...and the answer does not carry the key', !JSON.stringify(nsecTitle.body ?? {}).includes(NSEC.slice(5, 20)), show(nsecTitle));
const nsecDesc = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ description: `songs I like. key=nostr:${NSEC.toUpperCase()}` }) } });
if (nsecDesc.status === 201) created.push(nsecDesc.body.id);
check('POST with an upper-case nostr:NSEC inside a word of the description -> 400 { kind: secret, field: description }',
  nsecDesc.status === 400 && nsecDesc.body?.problems?.some((p) => p.kind === 'secret' && p.field === 'description'), show(nsecDesc));
const nwcDesc = await call('POST', PLAYLISTS, {
  sk: owner, body: { draft: draft({ description: `nostr+walletconnect://${'ab'.repeat(32)}?relay=wss://r.example&secret=${'cd'.repeat(32)}` }) },
});
if (nwcDesc.status === 201) created.push(nwcDesc.body.id);
check('POST with a wallet connection string in the description -> 400 { kind: secret }',
  nwcDesc.status === 400 && nwcDesc.body?.problems?.some((p) => p.kind === 'secret' && p.field === 'description'), show(nwcDesc));
const npubTitle = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ title: npubEncode(ownerPub).slice(0, 60), songs: songs.slice(0, 9) }) } });
check('an npub in the title is not a secret (the draft is refused for its 9 songs only)',
  npubTitle.status === 400 && !npubTitle.body?.problems?.some((p) => p.kind === 'secret')
  && npubTitle.body?.problems?.some((p) => p.kind === 'too-few-songs'), show(npubTitle));

// ── the body cap fits 500 songs ─────────────────────────────────────────────
// 500 entries with 300-character item guids, one of them twice: the rules refuse the
// duplicate before Podcast Index is asked, which proves the body was read and parsed.
const big = Array.from({ length: 499 }, (_, i) => ({ feedGuid: songs[0].feedGuid, itemGuid: `e2e-big-${i}-${'x'.repeat(290)}` }));
big.push(big[0]);
const bigBody = { draft: draft({ songs: big }) };
const bigBytes = JSON.stringify(bigBody).length;
const bigRes = await call('POST', PLAYLISTS, { sk: owner, body: bigBody });
check(`a 500-song body of ${Math.round(bigBytes / 1024)} KB is read, not refused for its size (400 duplicate-song)`,
  bigBytes > 150 * 1024 && bigRes.status === 400 && bigRes.body?.problems?.some((p) => p.kind === 'duplicate-song'), show(bigRes).slice(0, 300));
const hugeRes = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ description: 'x'.repeat(300 * 1024) }) } });
check('a 300 KB body -> 400 payload too large', hugeRes.status === 400 && hugeRes.body?.error === 'payload too large', show(hugeRes).slice(0, 300));

// ── create, read, list ──────────────────────────────────────────────────────
// The first song carries a feedUrl the client made up: the public feed must carry the
// address Podcast Index holds for that feed, or none, never this one.
const FORGED = 'https://forged.e2e.invalid/not-the-artist.xml';
const forgedSongs = songs.map((s, i) => (i === 0 ? { ...s, feedUrl: FORGED } : s));
const post = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ title: 'fuck yeah', artUrl: ART_OK, songs: forgedSongs }) } });
const id = post.body?.id;
if (id) created.push(id);
check('POST 12 songs and a good cover -> 201 { id, feedUrl }',
  post.status === 201 && typeof id === 'string' && post.body?.feedUrl === `${APP}/feeds/playlists/${id}.xml`, show(post));
if (!id) { console.log('cannot go on without a playlist'); process.exit(1); }

const got = await call('GET', `${PLAYLISTS}/${id}`);
check('GET playlist -> title is masked', got.status === 200 && got.body?.playlist?.title === '**** yeah', show(got));
check('GET playlist -> 12 songs, art kept, owner set',
  got.body?.playlist?.songs?.length === 12 && got.body.playlist.artUrl === ART_OK && got.body.playlist.ownerPubkey === ownerPub);
check('the stored song 0 does not keep the client\'s made-up feedUrl', got.body?.playlist?.songs?.[0]?.feedUrl !== FORGED,
  JSON.stringify(got.body?.playlist?.songs?.[0]));
const list = await call('GET', PLAYLISTS);
const first = list.body?.playlists?.[0];
check('list -> the new id is first', first?.id === id, show(list));
check('list summary carries feedUrl, podcastGuid, npub, cover and count',
  first?.feedUrl === post.body.feedUrl && /^[0-9a-f-]{36}$/.test(first?.podcastGuid ?? '')
  && first?.ownerNpub === npubEncode(ownerPub) && /\.jpg\?v=\d+$/.test(first?.coverUrl ?? '') && first?.songCount === 12,
  JSON.stringify(first));
const mine = await call('GET', `${PLAYLISTS}?owner=${ownerPub}`);
check('list?owner -> exactly the new playlist', mine.body?.playlists?.length === 1 && mine.body.playlists[0].id === id, show(mine));
const missing = await call('GET', `${PLAYLISTS}/00000000-0000-4000-8000-000000000000`);
check('GET unknown id -> 404', missing.status === 404, show(missing));
const notUuid = await call('GET', `${PLAYLISTS}/not-a-uuid`);
check('GET a non-uuid id -> 404', notUuid.status === 404, show(notUuid));

// ── feed, cover, short-circuit, guid lookup, search lane ────────────────────
const feedRes = await fetch(`${APP}/feeds/playlists/${id}.xml`);
const feedXml = await feedRes.text();
check('GET feed .xml -> 200 rss+xml with the cache header',
  feedRes.status === 200 && /^application\/rss\+xml; charset=utf-8$/i.test(feedRes.headers.get('content-type') ?? '')
  && /s-maxage=60/.test(feedRes.headers.get('cache-control') ?? ''), `${feedRes.status} ${feedRes.headers.get('content-type')}`);
check('feed has 12 remoteItems, the owner npub and medium musicL',
  (feedXml.match(/<podcast:remoteItem/g) ?? []).length === 12 && feedXml.includes(npubEncode(ownerPub))
  && feedXml.includes('<podcast:medium>musicL'), feedXml.slice(0, 300));
check('the client\'s made-up feedUrl is NOT in the public feed', !feedXml.includes('forged.e2e.invalid'),
  (feedXml.match(/<podcast:remoteItem [^>]*>/) ?? [''])[0]);
{
  // What Podcast Index holds for song 0's feed, read the way the app reads it.
  const pi = await call('GET', `/api/by-guid?guid=${encodeURIComponent(songs[0].feedGuid)}`);
  const piUrl = pi.body?.podcast?.url;
  const item0 = (feedXml.match(/<podcast:remoteItem [^>]*>/) ?? [''])[0];
  check('song 0\'s remoteItem carries Podcast Index\'s feedUrl for its feed (or none when PI has none)',
    piUrl ? item0.includes(`feedUrl="${piUrl.replace(/&/g, '&amp;')}"`) : !item0.includes('feedUrl='), `${item0} / PI: ${piUrl}`);
}
check('the feed\'s podcast:guid is the stored one', feedXml.includes(`<podcast:guid>${got.body?.playlist?.podcastGuid}</podcast:guid>`),
  (feedXml.match(/<podcast:guid>[^<]*<\/podcast:guid>/) ?? [''])[0]);
const coverRes = await fetch(`${APP}/feeds/playlists/${id}.jpg`);
const coverBuf = Buffer.from(await coverRes.arrayBuffer());
// JPEG size: the first SOF marker holds height then width.
const nopeCC = (r) => r.headers.get('cache-control');
const jpegSize = (b) => {
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
};
const dims = jpegSize(coverBuf);
check('cover of the playlist with a valid art link -> x-cover-source: art', coverRes.headers.get('x-cover-source') === 'art', coverRes.headers.get('x-cover-source'));
// The current cover address, as the listing names it. Any other query is redirected to it,
// temporarily (the version moves with every edit), with no Cache-Control.
const currentCover = first?.coverUrl ?? '';
for (const [label, q] of [['a stale ?v=', '?v=1'], ['no query', ''], ['?v=<current> plus junk', `${new URL(currentCover || APP).search}&x=1`]]) {
  const r = await fetch(`${APP}/feeds/playlists/${id}.jpg${q}`, { redirect: 'manual' });
  check(`cover with ${label} -> 307 to the current ?v= address, no Cache-Control`,
    r.status === 307 && r.headers.get('location') === currentCover && !r.headers.get('cache-control'),
    `${r.status} ${r.headers.get('location')} ${r.headers.get('cache-control')}`);
}
const atCurrent = await fetch(currentCover, { redirect: 'manual' });
check('cover at the current ?v= -> 200 (no redirect)', atCurrent.status === 200, String(atCurrent.status));
await atCurrent.arrayBuffer().catch(() => {});
check('404 feed answer carries no Cache-Control', !nopeCC(await fetch(`${APP}/feeds/playlists/nope.xml`)));
check('GET cover .jpg -> 200 image/jpeg, 1400 x 1400',
  coverRes.status === 200 && coverRes.headers.get('content-type') === 'image/jpeg' && dims?.[0] === 1400 && dims?.[1] === 1400, `${coverRes.status} ${dims}`);
check('the cover is shared-cached for an hour, not a day (a deleted cover must not stay)',
  /(^|, )s-maxage=3600(,|$)/.test(coverRes.headers.get('cache-control') ?? ''), coverRes.headers.get('cache-control'));
const nope = await fetch(`${APP}/feeds/playlists/nope.xml`);
check('GET feed with a bad name -> 404', nope.status === 404, String(nope.status));
const unknownXml = await fetch(`${APP}/feeds/playlists/00000000-0000-4000-8000-000000000000.xml`);
check('GET feed for an unknown uuid -> 404', unknownXml.status === 404, String(unknownXml.status));

const viaPlaylist = await call('GET', `/api/playlist?url=${encodeURIComponent(post.body.feedUrl)}&limit=100`);
check('/api/playlist?url=<feedUrl> answers the 12 songs in order, from the store',
  viaPlaylist.status === 200 && viaPlaylist.body?.total === 12
  && viaPlaylist.body.episodes?.length === 12
  && viaPlaylist.body.episodes.every((e, i) => e.guid === songs[i].itemGuid && e.podcastGuid === songs[i].feedGuid)
  && viaPlaylist.body.podcast?.medium === 'musicL', show(viaPlaylist).slice(0, 300));
check('/api/playlist for a stored playlist is cached 30 s, not the remote-playlist 300 s (an edit shows soon)',
  /(^|, )s-maxage=30(,|$)/.test(viaPlaylist.headers.get('cache-control') ?? ''), viaPlaylist.headers.get('cache-control'));

const g = got.body.playlist;
const byGuid = await call('GET', `/api/by-guid?guid=${g.podcastGuid}`);
check('/api/by-guid answers the playlist for its podcastGuid',
  byGuid.status === 200 && byGuid.body?.podcast?.podcastGuid === g.podcastGuid
  && byGuid.body.podcast.medium === 'musicL' && byGuid.body.podcast.url === post.body.feedUrl, show(byGuid).slice(0, 300));
const searched = await call('GET', `/api/search?q=${encodeURIComponent('yeah')}&type=playlist`);
check('/api/search?type=playlist finds it by title',
  searched.status === 200 && JSON.stringify(searched.body).includes(g.podcastGuid), show(searched).slice(0, 300));

// ── edit ────────────────────────────────────────────────────────────────────
const v1 = got.body.playlist.updatedAt;
const byOther = await call('PUT', `${PLAYLISTS}/${id}`, { sk: other, body: { draft: draft({ title: 'hijack' }), expectedUpdatedAt: v1 } });
check('PUT by a second key -> 403', byOther.status === 403, show(byOther));
// Song 1 is already stored: an edit may not swap its feedUrl for a made-up one either.
const storedFeedUrl1 = got.body?.playlist?.songs?.[1]?.feedUrl;
const put1 = await call('PUT', `${PLAYLISTS}/${id}`, {
  sk: owner, body: { draft: draft({ title: 'second', songs: songs.map((s, i) => (i === 1 ? { ...s, feedUrl: FORGED } : s)) }), expectedUpdatedAt: v1 },
});
check('PUT by the owner with a fresh expectedUpdatedAt -> 200',
  put1.status === 200 && put1.body?.playlist?.title === 'second' && put1.body.playlist.updatedAt !== v1, show(put1));
check('a PUT keeps a stored song\'s feedUrl, not the client\'s made-up one',
  put1.body?.playlist?.songs?.[1]?.feedUrl === storedFeedUrl1, JSON.stringify(put1.body?.playlist?.songs?.[1]));
const nsecPut = await call('PUT', `${PLAYLISTS}/${id}`, {
  sk: owner, body: { draft: draft({ title: 'second', description: `paste: ${NSEC}` }), expectedUpdatedAt: put1.body?.playlist?.updatedAt },
});
check('PUT with an nsec in the description -> 400 { kind: secret }, nothing saved',
  nsecPut.status === 400 && nsecPut.body?.problems?.some((p) => p.kind === 'secret' && p.field === 'description'), show(nsecPut));
// A RED run (old code) saves it: put the version back so the rest of the edit half still runs.
if (nsecPut.status === 200) put1.body.playlist.updatedAt = nsecPut.body.playlist.updatedAt;
const put2 = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft({ title: 'third' }), expectedUpdatedAt: v1 } });
check('PUT with the old expectedUpdatedAt -> 409 changed elsewhere',
  put2.status === 409 && put2.body?.error === 'changed elsewhere', show(put2));
const put3 = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft({ title: 'third' }), expectedUpdatedAt: put1.body.playlist.updatedAt } });
check('PUT with a fresh one -> 200', put3.status === 200 && put3.body?.playlist?.title === 'third', show(put3));
const noExpected = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft() } });
check('PUT without expectedUpdatedAt -> 400', noExpected.status === 400, show(noExpected));

// ── admin and bans ──────────────────────────────────────────────────────────
const adminGetNon = await call('GET', `${PLAYLISTS}/admin`, { sk: other });
check('non-admin admin GET -> 403', adminGetNon.status === 403, show(adminGetNon));
const adminGetNone = await call('GET', `${PLAYLISTS}/admin`);
check('unsigned admin GET -> 401', adminGetNone.status === 401, show(adminGetNone));
const adminPostNon = await call('POST', `${PLAYLISTS}/admin`, { sk: other, body: { action: 'ban', pubkey: ownerPub } });
check('non-admin admin POST -> 403', adminPostNon.status === 403, show(adminPostNon));
const adminGet = await call('GET', `${PLAYLISTS}/admin`, { sk: ADMIN_SK });
check('admin GET -> 200 with playlists and bans',
  adminGet.status === 200 && Array.isArray(adminGet.body?.playlists) && Array.isArray(adminGet.body?.bans)
  && adminGet.body.playlists.some((p) => p.id === id), show(adminGet));
const ban = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'ban', pubkey: ownerPub } });
check('admin ban -> 200', ban.status === 200 && ban.body?.ok === true, show(ban));
const bans = await call('GET', `${PLAYLISTS}/admin`, { sk: ADMIN_SK });
check('admin GET lists the ban', bans.body?.bans?.some((b) => b.pubkey === ownerPub), show(bans));
const putBanned = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft(), expectedUpdatedAt: put3.body.playlist.updatedAt } });
check('banned owner PUT -> 403', putBanned.status === 403, show(putBanned));
const postBanned = await call('POST', `${PLAYLISTS}`, { sk: owner, body: { draft: draft() } });
check('banned owner POST -> 403 with the account message',
  postBanned.status === 403 && postBanned.body?.error === 'This account cannot publish playlists.', show(postBanned));
const unban = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'unban', pubkey: ownerPub } });
check('admin unban -> 200', unban.status === 200 && unban.body?.ok === true, show(unban));
const putAfter = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft({ title: 'fourth' }), expectedUpdatedAt: put3.body.playlist.updatedAt } });
check('owner PUT after unban -> 200', putAfter.status === 200, show(putAfter));

// A token made for one method must not work for another.
const putToken = await getToken(`${APP}${PLAYLISTS}/${id}`, 'PUT', (e) => finalizeEvent(e, owner), true);
const wrongMethod = await call('DELETE', `${PLAYLISTS}/${id}`, { headers: { authorization: putToken } });
check('a token signed for PUT sent as DELETE -> 401', wrongMethod.status === 401, show(wrongMethod));
const stillThere = await call('GET', `${PLAYLISTS}/${id}`);
check('and the playlist is still there', stillThere.status === 200, show(stillThere));

const badExpected = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft(), expectedUpdatedAt: 'not a date' } });
check('PUT with an unparseable expectedUpdatedAt -> 400 bad expectedUpdatedAt',
  badExpected.status === 400 && badExpected.body?.error === 'bad expectedUpdatedAt', show(badExpected));

// An unchanged cover link is not fetched again; the song list is checked only for new songs.
const keepArt = await call('GET', `${PLAYLISTS}/${id}`);
const withArt = await call('PUT', `${PLAYLISTS}/${id}`, {
  sk: owner, body: { draft: draft({ artUrl: ART_OK, title: 'with art' }), expectedUpdatedAt: keepArt.body.playlist.updatedAt },
});
check('PUT setting the cover -> 200', withArt.status === 200 && withArt.body?.playlist?.artUrl === ART_OK, show(withArt));
const sameArt = await call('PUT', `${PLAYLISTS}/${id}`, {
  sk: owner, body: { draft: draft({ artUrl: ART_OK, title: 'same art' }), expectedUpdatedAt: withArt.body.playlist.updatedAt },
});
check('PUT keeping the same cover -> 200', sameArt.status === 200, show(sameArt));
const newSong = await call('PUT', `${PLAYLISTS}/${id}`, {
  sk: owner,
  body: { draft: draft({ songs: [...songs, { feedGuid: songs[0].feedGuid, itemGuid: `made-up-${Date.now()}` }] }), expectedUpdatedAt: sameArt.body.playlist.updatedAt },
});
check('PUT adding a made-up song -> 400 song-not-found',
  newSong.status === 400 && newSong.body?.problems?.some((p) => p.kind === 'song-not-found'), show(newSong));

// ── a second playlist: admin delete and ban + deleteAll ─────────────────────
const p2 = await call('POST', PLAYLISTS, { sk: other, body: { draft: draft({ title: 'other one' }) } });
if (p2.body?.id) created.push(p2.body.id);
check('second key POST -> 201', p2.status === 201, show(p2));
const gridRes = await fetch(`${APP}/feeds/playlists/${p2.body?.id}.jpg`);
const gridDims = jpegSize(Buffer.from(await gridRes.arrayBuffer()));
check('cover of a playlist with no art link (song grid) -> x-cover-source: grid', gridRes.headers.get('x-cover-source') === 'grid', gridRes.headers.get('x-cover-source'));
check('cover of a playlist with no art link (song grid) -> 200 JPEG 1400 x 1400',
  gridRes.status === 200 && gridRes.headers.get('content-type') === 'image/jpeg' && gridDims?.[0] === 1400 && gridDims?.[1] === 1400,
  `${gridRes.status} ${gridDims}`);
const adminDel = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'delete', id: p2.body?.id } });
check('admin delete by id -> 200 { ok, deleted: 1 }', adminDel.status === 200 && adminDel.body?.deleted === 1, show(adminDel));
const p2gone = await call('GET', `${PLAYLISTS}/${p2.body?.id}`);
check('admin-deleted playlist -> 410', p2gone.status === 410, show(p2gone));
const p3 = await call('POST', PLAYLISTS, { sk: other, body: { draft: draft({ title: 'other two' }) } });
if (p3.body?.id) created.push(p3.body.id);
const banAll = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'ban', pubkey: getPublicKey(other), deleteAll: true } });
check('admin ban with deleteAll -> 200, deleted 1', banAll.status === 200 && banAll.body?.deleted === 1, show(banAll));
await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'unban', pubkey: getPublicKey(other) } });
const badAction = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'nope' } });
check('admin POST with an unknown action -> 400', badAction.status === 400, show(badAction));

// ── admin delete through DELETE /[id] ──
const p4 = await call('POST', PLAYLISTS, { sk: other, body: { draft: draft({ title: 'admin will delete' }) } });
if (p4.body?.id) created.push(p4.body.id);
const nonAdminDel = await call('DELETE', `${PLAYLISTS}/${p4.body?.id}`, { sk: newKey() });
check('DELETE by a stranger who is not an admin -> 403', nonAdminDel.status === 403, show(nonAdminDel));
const adminDel2 = await call('DELETE', `${PLAYLISTS}/${p4.body?.id}`, { sk: ADMIN_SK });
check('DELETE by an admin of another listener\'s playlist -> 200', adminDel2.status === 200 && adminDel2.body?.deleted === true, show(adminDel2));
const p4gone = await call('GET', `${PLAYLISTS}/${p4.body?.id}`);
check('and that playlist -> 410', p4gone.status === 410, show(p4gone));

// ── delete ──────────────────────────────────────────────────────────────────
const delOther = await call('DELETE', `${PLAYLISTS}/${id}`, { sk: other });
check('DELETE by a non-owner -> 403', delOther.status === 403, show(delOther));
const del = await call('DELETE', `${PLAYLISTS}/${id}`, { sk: owner });
check('owner DELETE -> 200 { deleted: true }', del.status === 200 && del.body?.deleted === true, show(del));
const feedGone = await fetch(`${APP}/feeds/playlists/${id}.xml`);
check('feed .xml after delete -> 410 with no Cache-Control', feedGone.status === 410 && !feedGone.headers.get('cache-control'), String(feedGone.status));
const coverGone = await fetch(`${APP}/feeds/playlists/${id}.jpg`);
check('cover .jpg after delete -> 410', coverGone.status === 410, String(coverGone.status));
const viaGone = await call('GET', `/api/playlist?url=${encodeURIComponent(post.body.feedUrl)}`);
check('/api/playlist?url=<feedUrl> after delete -> 404', viaGone.status === 404, show(viaGone));
const after = await call('GET', `${PLAYLISTS}/${id}`);
check('GET after delete -> 410', after.status === 410, show(after));
const listAfter = await call('GET', `${PLAYLISTS}?owner=${ownerPub}`);
check('list no longer has it', !listAfter.body?.playlists?.some((p) => p.id === id), show(listAfter));
const putGone = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft(), expectedUpdatedAt: v1 } });
check('PUT on a deleted playlist -> 410', putGone.status === 410, show(putGone));

// Anything still live (after a failed run) is removed with its owner's key.
for (const pid of created) {
  for (const sk of [owner, other]) await call('DELETE', `${PLAYLISTS}/${pid}`, { sk });
}
console.log(`${count - fails}/${count} passed`);
process.exit(fails ? 1 : 0);
