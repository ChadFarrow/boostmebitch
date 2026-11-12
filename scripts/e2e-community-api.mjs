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
// It also depends on three third-party image URLs below (Fountain and headstarts.uk); if one
// moves, the art lines fail for that reason and not because of the routes.
import { randomBytes } from 'node:crypto';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { getToken } from 'nostr-tools/nip98';
import { npubEncode } from 'nostr-tools/nip19';

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

// ── create, read, list ──────────────────────────────────────────────────────
const post = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ title: 'fuck yeah', artUrl: ART_OK }) } });
const id = post.body?.id;
if (id) created.push(id);
check('POST 12 songs and a good cover -> 201 { id, feedUrl }',
  post.status === 201 && typeof id === 'string' && post.body?.feedUrl === `${APP}/feeds/playlists/${id}.xml`, show(post));
if (!id) { console.log('cannot go on without a playlist'); process.exit(1); }

const got = await call('GET', `${PLAYLISTS}/${id}`);
check('GET playlist -> title is masked', got.status === 200 && got.body?.playlist?.title === '**** yeah', show(got));
check('GET playlist -> 12 songs, art kept, owner set',
  got.body?.playlist?.songs?.length === 12 && got.body.playlist.artUrl === ART_OK && got.body.playlist.ownerPubkey === ownerPub);
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
// Task 6 (feed route, cover, guid lookup, search): skipped until Task 6.

// ── edit ────────────────────────────────────────────────────────────────────
const v1 = got.body.playlist.updatedAt;
const byOther = await call('PUT', `${PLAYLISTS}/${id}`, { sk: other, body: { draft: draft({ title: 'hijack' }), expectedUpdatedAt: v1 } });
check('PUT by a second key -> 403', byOther.status === 403, show(byOther));
const put1 = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft({ title: 'second' }), expectedUpdatedAt: v1 } });
check('PUT by the owner with a fresh expectedUpdatedAt -> 200',
  put1.status === 200 && put1.body?.playlist?.title === 'second' && put1.body.playlist.updatedAt !== v1, show(put1));
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
