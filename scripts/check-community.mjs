// Pins the community-playlist rules: validatePlaylistDraft (with the secret-key test it is
// handed, textHoldsSecret), withIndexFeedUrls, artVerdict, cleanText, the feed document
// and the feed URL helpers in lib/curated-playlists.ts, and localTarget, the guard that keeps
// the playlist e2e scripts on this machine (scripts/local-target.mjs). Imports the real modules.
import {
  COMMUNITY_FEED_ORIGIN, COMMUNITY_FEED_PATH, COMMUNITY_PLAYLISTS_ON,
  communityFeedUrl, communityCoverUrl, communityIdFromFeedUrl, coverVersion,
  COMMUNITY_PUBLISHER_PATH, communityPublisherFeedUrl,
} from '../lib/curated-playlists.ts';
import {
  validatePlaylistDraft, artVerdict, withIndexFeedUrls, MAX_PLAYLIST_BODY_BYTES, MAX_SONGS, MAX_URL_LEN,
  artUploadSize, uploadedArtUrl, ART_UPLOAD_SERVER,
  blossomServersFromTags, artUploadServers, MAX_USER_BLOSSOM_SERVERS, coverStyleFor,
  foldName, MAX_OWNER_NAME_LEN, cleanMakerLn, makerLnOf, MAX_MAKER_LN_LEN, archiveDispatchBase, PRODUCTION_FEED_ORIGIN, piNotifyBase, PI_API_BASE,
  podpingEndpoint, podpingRequestUrl, PODPING_MEDIUM, PODPING_REASON,
  piNoticeAllowed, piSecondNotifyMs, piFeedIdFrom, PI_NOTICE_THROTTLE_MS, PI_NOTICE_OWNER_DAILY,
  PI_NOTICE_GLOBAL_DAILY, PI_SECOND_NOTIFY_MS, PI_ADD_FORM, MIN_SONGS, addSong, songsAddedElsewhere,
} from '../lib/community/rules.ts';
import { readFileSync } from 'node:fs';
import { textHoldsSecret, looksLikeSecretKey } from '../lib/nostr/npub-input.ts';
import { cleanText } from '../lib/community/clean-text.ts';
import {
  escapeXml, communityFeedGuid, buildPlaylistFeedXml, FEED_TEMPLATE_UPDATED_AT, buildPublisherFeedXml, PLAYLIST_MAKER_REL,
} from '../lib/community/feed-doc.ts';
import { channelSlice, parsePlaylistRemoteItems, parseFeedNpubs, decodeXmlText } from '../lib/feed-xml.ts';
import { npubEncode, noteEncode, nprofileEncode, nsecEncode } from 'nostr-tools/nip19';
import { bech32 } from '@scure/base';
import { generateSecretKey, finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { getToken, validateEventMethodTag } from 'nostr-tools/nip98';
import { verifyNip98, adminPubkeys, authMessage } from '../lib/community/auth.ts';
import { communityPlaylistToPodcast, fnvHash, playlistBoostContext, heardOnLines } from '../lib/util.ts';
import { composeCover, noteSvg } from '../lib/community/cover-compose.ts';
import sharp from 'sharp';
import { BRANDS } from '../lib/brand.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';
import { localTarget } from './local-target.mjs';

let failed = 0;
const fail = (m) => { console.error('  ✗ ' + m); failed++; };
const ok = (m) => console.log('  ok   ' + m);
const check = (name, cond) => (cond ? ok(name) : fail(name));

for (const [f, opts] of [
  ['lib/curated-playlists.ts', undefined],
  ['lib/community/rules.ts', undefined],
  ['lib/community/clean-text.ts', { allowBare: true }],
  ['lib/community/cover-compose.ts', { allowBare: true }],
]) {
  const p = importFreeProblems(f, opts);
  if (p.length) { explainImportFree(f, p); failed++; } else ok(f + ' import-free');
}

const songs = (n) => Array.from({ length: n }, (_, i) => ({ feedGuid: 'f' + i, itemGuid: 'i' + i }));
const draft = (o = {}) => ({ title: 'T', description: '', artUrl: '', songs: songs(10), ...o });
const kinds = (r) => (r.ok ? [] : r.problems.map((p) => p.kind));
// Every route and the maker hand the rules the REAL secret test; so does every vector here.
const V = (raw) => validatePlaylistDraft(raw, textHoldsSecret);

let r = V({ title: '  ', description: '', artUrl: '', songs: [] });
check('blank title + no songs', !r.ok && kinds(r).includes('title-missing')
  && r.problems.some((p) => p.kind === 'too-few-songs' && p.have === 0));
r = V(draft({ songs: songs(9) }));
check('9 songs too few', !r.ok && r.problems.some((p) => p.kind === 'too-few-songs' && p.have === 9));
check('10 songs ok', V(draft()).ok);
check('500 songs ok', V(draft({ songs: songs(500) })).ok);
r = V(draft({ songs: songs(501) }));
check('501 songs too many', !r.ok && r.problems.some((p) => p.kind === 'too-many-songs' && p.have === 501));
r = V(draft({ songs: [...songs(10), { feedGuid: 'f0', itemGuid: 'i0' }] }));
check('duplicate song', !r.ok && r.problems.some((p) => p.kind === 'duplicate-song' && p.itemGuid === 'i0'));
check('same itemGuid, other feed is not a duplicate',
  V(draft({ songs: [...songs(10), { feedGuid: 'other', itemGuid: 'i0' }] })).ok);
check('http art refused', kinds(V(draft({ artUrl: 'http://x/a.png' }))).includes('art-not-https'));
r = V(draft({ artUrl: '' }));
check('empty art -> null', r.ok && r.draft.artUrl === null);
r = V(draft({ artUrl: 'https://x/a.png' }));
check('https art kept', r.ok && r.draft.artUrl === 'https://x/a.png');
check('121-char title', kinds(V(draft({ title: 'a'.repeat(121) }))).includes('title-too-long'));
check('120-char title ok', V(draft({ title: 'a'.repeat(120) })).ok);
check('120-emoji title ok', V(draft({ title: '😀'.repeat(120) })).ok);
check('121-emoji title refused', kinds(V(draft({ title: '😀'.repeat(121) }))).includes('title-too-long'));
check('1001-char description', kinds(V(draft({ description: 'a'.repeat(1001) }))).includes('description-too-long'));
check('1000-emoji description ok', V(draft({ description: '😀'.repeat(1000) })).ok);
r = V(draft({ title: '  Hi  ', description: ' d ' }));
check('trims', r.ok && r.draft.title === 'Hi' && r.draft.description === 'd');
r = V(draft({ songs: [{ feedGuid: '', itemGuid: 'x' }, ...songs(10)] }));
check('empty feedGuid is bad-song index 0', !r.ok && r.problems.some((p) => p.kind === 'bad-song' && p.index === 0));
r = V(draft({ songs: [...songs(10), { feedGuid: 'f', itemGuid: 'x'.repeat(2049) }] }));
check('long itemGuid bad-song', !r.ok && r.problems.some((p) => p.kind === 'bad-song' && p.index === 10));
r = V(draft({ songs: [...songs(10), { feedGuid: 'f'.repeat(121), itemGuid: 'x' }] }));
check('long feedGuid bad-song', !r.ok && r.problems.some((p) => p.kind === 'bad-song' && p.index === 10));
r = V(draft({ songs: [{ feedGuid: 'a', itemGuid: 'b', feedUrl: 'javascript:1' }, ...songs(9)] }));
check('non-http feedUrl dropped', r.ok && r.draft.songs[0].feedUrl === undefined);
r = V(draft({ songs: [{ feedGuid: 'a', itemGuid: 'b', feedUrl: 'https://x/f.xml' }, ...songs(9)] }));
check('https feedUrl kept', r.ok && r.draft.songs[0].feedUrl === 'https://x/f.xml');
check('garbage rejected', !V(null).ok && !V('x').ok);
r = V({ title: 5, description: 5, artUrl: 5, songs: 'x' });
check('wrong types report problems', !r.ok && r.problems.length > 0);

// ---- a secret key in the title or description (the playlist is PUBLIC) -------
// The maker and both write routes refuse it before anything is stored or sent on.
// `textHoldsSecret` runs `looksLikeSecretKey` on every run of letters and digits (a
// bech32 key is one such run), so a key glued to other text is still found.
{
  const NSEC = nsecEncode(generateSecretKey());
  const hits = [
    NSEC, `my mix ${NSEC}`, `nostr:${NSEC}`, `(${NSEC})`, `"${NSEC}"`, `key=${NSEC}`, `x:${NSEC}`,
    NSEC.toUpperCase(), 'nsec1qqqq', `ncryptsec1${'q'.repeat(40)}`,
    `nostr+walletconnect://${'ab'.repeat(32)}?relay=wss://r.example&secret=${'cd'.repeat(32)}`,
    `songs\nNOSTR+WALLETCONNECT://x`,
  ];
  const misses = [
    '', 'Insect1 mix', 'nsec', 'nsec 1', npubEncode('ab'.repeat(32)), nprofileEncode({ pubkey: 'ab'.repeat(32) }),
    'Summer songs 2026', 'wallet connect mix', 'nostr:npub1abc',
  ];
  for (const h of hits) check(`secret found: ${JSON.stringify(h.slice(0, 24))}…`, textHoldsSecret(h));
  for (const m of misses) check(`not a secret: ${JSON.stringify(m.slice(0, 24))}`, !textHoldsSecret(m));
  // Can fail: the old rules had no test at all, and the bug report's whitespace split
  // (lib/bug-report.ts) misses a key glued to other text.
  const none = () => false;
  const wsSplit = (t) => t.split(/[\s,;]+/).some((x) => looksLikeSecretKey(x.replace(/^[^a-z0-9]+/i, '')));
  check('secret vectors fail against no test (can fail)', hits.every((h) => !none(h)));
  check('glued-key vectors fail against a whitespace split (can fail)', !wsSplit(`key=${NSEC}`) && !wsSplit(`x:${NSEC}`));

  let s = V(draft({ title: `mix ${NSEC}` }));
  check('secret in the title -> { kind: secret, field: title }',
    !s.ok && s.problems.some((p) => p.kind === 'secret' && p.field === 'title'));
  s = V(draft({ description: `paste ${NSEC} here` }));
  check('secret in the description -> { kind: secret, field: description }',
    !s.ok && s.problems.some((p) => p.kind === 'secret' && p.field === 'description'));
  s = V(draft({ title: NSEC, description: NSEC }));
  check('secret in both -> two problems', !s.ok && s.problems.filter((p) => p.kind === 'secret').length === 2);
  check('a refusal does not carry the key', !JSON.stringify(V(draft({ title: NSEC })).problems ?? []).includes(NSEC.slice(5)));
  check('an npub title is publishable', V(draft({ title: npubEncode('ab'.repeat(32)) })).ok);
  // Can fail: the old validator, which took no secret test.
  check('secret-title vector fails against the old validator (can fail)',
    validatePlaylistDraft(draft({ title: `mix ${NSEC}` }), none).ok);
}

// ---- links: length caps and a real host -------------------------------------
{
  const atCap = 'https://x.example/' + 'a'.repeat(MAX_URL_LEN - 'https://x.example/'.length);
  check('MAX_URL_LEN is 2048', MAX_URL_LEN === 2048 && atCap.length === 2048);
  check('art link of exactly 2048 characters ok', V(draft({ artUrl: atCap })).ok);
  check('art link of 2049 characters -> art-bad-link', kinds(V(draft({ artUrl: atCap + 'a' }))).includes('art-bad-link'));
  check('bare https:// -> art-bad-link', kinds(V(draft({ artUrl: 'https://' }))).includes('art-bad-link'));
  check('https:// plus a path and no host -> art-bad-link', kinds(V(draft({ artUrl: 'https://?x=1' }))).includes('art-bad-link'));
  check('http art is still art-not-https, not art-bad-link',
    JSON.stringify(kinds(V(draft({ artUrl: 'http://x/a.png' })))) === JSON.stringify(['art-not-https']));
  // Can fail: the old test was a prefix regex.
  const oldArtOk = (u) => /^https:\/\//i.test(u);
  check('bare-https vector fails against the old prefix test (can fail)', oldArtOk('https://'));

  let s = V(draft({ songs: [{ feedGuid: 'a', itemGuid: 'b', feedUrl: atCap + 'a' }, ...songs(9)] }));
  check('a client feedUrl over 2048 characters is dropped', s.ok && s.draft.songs[0].feedUrl === undefined);
  s = V(draft({ songs: [{ feedGuid: 'a', itemGuid: 'b', feedUrl: 'https://' }, ...songs(9)] }));
  check('a client feedUrl with no host is dropped', s.ok && s.draft.songs[0].feedUrl === undefined);
}

// ---- the public feed carries Podcast Index's feedUrl, never the client's ------
// withIndexFeedUrls is what both write routes store; `urlFor` answers what the index
// holds for a song (or, for a song an edit kept, what was stored when it was checked).
{
  const client = [
    { feedGuid: 'g1', itemGuid: 'i1', feedUrl: 'https://forged.example/evil.xml', title: 'extra field' },
    { feedGuid: 'g2', itemGuid: 'i2', feedUrl: 'https://forged.example/two.xml' },
    { feedGuid: 'g3', itemGuid: 'i3' },
    { feedGuid: 'g4', itemGuid: 'i4' },
    { feedGuid: 'g5', itemGuid: 'i5' },
  ];
  const index = {
    g1: 'https://feeds.artist.example/album.xml',
    g3: 'javascript:alert(1)',
    g4: 'https://feeds.artist.example/' + 'a'.repeat(2048),
    g5: 'https://feeds.artist.example/five.xml?a=1&b=2',
  };
  const out = withIndexFeedUrls(client, (s) => index[s.feedGuid]);
  const want = [
    { feedGuid: 'g1', itemGuid: 'i1', feedUrl: 'https://feeds.artist.example/album.xml' },
    { feedGuid: 'g2', itemGuid: 'i2' },
    { feedGuid: 'g3', itemGuid: 'i3' },
    { feedGuid: 'g4', itemGuid: 'i4' },
    { feedGuid: 'g5', itemGuid: 'i5', feedUrl: 'https://feeds.artist.example/five.xml?a=1&b=2' },
  ];
  check('withIndexFeedUrls: the index URL replaces the client one; none, a script link or an over-long one -> no feedUrl; nothing else copied',
    JSON.stringify(out) === JSON.stringify(want));
  check('withIndexFeedUrls: order kept', out.map((s) => s.itemGuid).join() === 'i1,i2,i3,i4,i5');
  // Can fail: the old route stored the client's songs as validated.
  const naiveStore = (songs) => songs.map(({ feedGuid, itemGuid, feedUrl }) => (feedUrl ? { feedGuid, itemGuid, feedUrl } : { feedGuid, itemGuid }));
  check('forged-feedUrl vector fails against storing the client value (can fail)', JSON.stringify(naiveStore(client)) !== JSON.stringify(want));
}

// ---- the body cap fits MAX_SONGS ---------------------------------------------
{
  // 500 songs shaped like real ones: a UUID feed guid, a permalink item guid, a feed URL.
  const real = Array.from({ length: MAX_SONGS }, (_, i) => ({
    feedGuid: '917393e3-1b1e-5cef-ace4-edaa54e1f810',
    itemGuid: `https://music.example.com/artist-name/album-name-here/track-${i}-a-longish-song-title-goes-here`,
    feedUrl: 'https://feeds.example.com/artist-name/album-name-here/feed.xml',
  }));
  const body = { draft: { title: 'a'.repeat(120), description: 'd'.repeat(1000), artUrl: 'https://x.example/a.jpg', songs: real }, expectedUpdatedAt: new Date().toISOString() };
  const bytes = Buffer.byteLength(JSON.stringify(body));
  check(`a full 500-song write body (${Math.round(bytes / 1024)} KB) fits MAX_PLAYLIST_BODY_BYTES with room`, bytes * 1.5 < MAX_PLAYLIST_BODY_BYTES);
  // Can fail: the old cap.
  check('the 500-song body is over the old 64 KB cap (can fail)', bytes > 64 * 1024);
}

const A = (o) => artVerdict(o);
check('png 1400 ok', A({ format: 'png', width: 1400, height: 1400 }).ok);
check('jpeg 3000 ok', A({ format: 'jpeg', width: 3000, height: 3000 }).ok);
check('300 ok (the smallest)', A({ format: 'jpeg', width: 300, height: 300 }).ok);
check('299 too-small', A({ format: 'jpeg', width: 299, height: 299 }).reason === 'too-small');
check('5000 ok (no upper limit; the fetch cap is 12 MB)', A({ format: 'jpeg', width: 5000, height: 5000 }).ok);
check('764x766 ok (not square is allowed)', A({ format: 'jpeg', width: 764, height: 766 }).ok);
check('1400x299 too-small (the shortest side counts)', A({ format: 'jpeg', width: 1400, height: 299 }).reason === 'too-small');
check('webp format', A({ format: 'webp', width: 1400, height: 1400 }).reason === 'format');
check('png with alpha ok', A({ format: 'png', width: 3000, height: 3000, hasAlpha: true }).ok);
check('{} not-image', A({}).reason === 'not-image');

// The UPLOAD button's two pure rules. Can fail: the obvious version keeps a
// 24 MP phone photo whole (over the art check's pixel limit), or shrinks a
// panorama under ART_MIN_PX and uploads a cover PUBLISH will then refuse.
{
  const S = (w, h) => JSON.stringify(artUploadSize(w, h));
  check('24 MP phone photo shrinks to 3000 on the long side', S(5712, 4284) === JSON.stringify({ width: 3000, height: 2250 }));
  check('portrait shrinks on the long side too', S(3024, 4032) === JSON.stringify({ width: 2250, height: 3000 }));
  check('1400 square is kept, never enlarged', S(1400, 1400) === JSON.stringify({ width: 1400, height: 1400 }));
  check('300 square is kept (the smallest)', S(300, 300) === JSON.stringify({ width: 300, height: 300 }));
  check('299 square is refused', artUploadSize(299, 299) === null);
  check('a panorama under ART_MIN_PX AFTER the shrink is refused', artUploadSize(12000, 1000) === null);
  check('a panorama that stays over ART_MIN_PX passes', S(6000, 800) === JSON.stringify({ width: 3000, height: 400 }));
  check('zero / NaN sizes are refused', artUploadSize(0, 500) === null && artUploadSize(NaN, 500) === null);
  check('the shrunk size passes artVerdict', A({ format: 'jpeg', ...artUploadSize(5712, 4284) }).ok);

  const h = 'ab'.repeat(32);
  const U = (a) => uploadedArtUrl(ART_UPLOAD_SERVER, h, a);
  check('upload url is rebuilt from OUR hash', U({ sha256: h, url: 'https://evil.example/x.jpg' }) === `${ART_UPLOAD_SERVER}/${h}.jpg`);
  check('an answer naming another hash is refused', U({ sha256: 'cd'.repeat(32), url: `${ART_UPLOAD_SERVER}/${h}.jpg` }) === null);
  check('an answer with no hash is refused', U({ url: `${ART_UPLOAD_SERVER}/${h}.jpg` }) === null);
  check('a non-object answer is refused', U('ok') === null && U(null) === null);
  check('an upper-case hash in the answer still matches', U({ sha256: h.toUpperCase() }) === `${ART_UPLOAD_SERVER}/${h}.jpg`);
  check('a bad local hash is refused', uploadedArtUrl(ART_UPLOAD_SERVER, 'xyz', { sha256: 'xyz' }) === null);
  check('the upload server is https with no trailing slash', /^https:\/\/[^/]+$/.test(ART_UPLOAD_SERVER));

  // The user's own kind:10063 list. Can fail: the obvious version reads every
  // tag's [1] (a `relay` tag becomes a server), keeps http, or loses the order.
  const B = (tags) => JSON.stringify(blossomServersFromTags(tags));
  check('servers keep the user order, normalised', B([['server', 'https://cdn.a.example/'], ['server', 'https://b.example']])
    === JSON.stringify(['https://cdn.a.example', 'https://b.example']));
  check('a server with a path keeps the path', B([['server', 'https://a.example/blossom/']]) === JSON.stringify(['https://a.example/blossom']));
  check('http is skipped (a signed authorization over plain http)', B([['server', 'http://a.example']]) === '[]');
  check('credentials in the URL are skipped', B([['server', 'https://u:p@a.example']]) === '[]');
  check('query and fragment are dropped', B([['server', 'https://a.example/?x=1#y']]) === JSON.stringify(['https://a.example']));
  check('a non-server tag is skipped', B([['relay', 'https://a.example'], ['r', 'https://b.example']]) === '[]');
  check('junk is skipped', B([['server'], ['server', 42], ['server', 'not a url'], 'x', null]) === '[]');
  check('duplicates are dropped', B([['server', 'https://a.example'], ['server', 'https://a.example/']]) === JSON.stringify(['https://a.example']));
  check('at most MAX_USER_BLOSSOM_SERVERS', blossomServersFromTags(
    [1, 2, 3, 4, 5].map((i) => ['server', `https://s${i}.example`])).length === MAX_USER_BLOSSOM_SERVERS);
  check('non-array tags give []', B(undefined) === '[]' && B({}) === '[]');
  check('order: user servers, then the default', JSON.stringify(artUploadServers(['https://a.example']))
    === JSON.stringify(['https://a.example', ART_UPLOAD_SERVER]));
  check('the default is not tried twice', JSON.stringify(artUploadServers([ART_UPLOAD_SERVER, 'https://a.example']))
    === JSON.stringify([ART_UPLOAD_SERVER, 'https://a.example']));
  check('no user servers: the default alone', JSON.stringify(artUploadServers([])) === JSON.stringify([ART_UPLOAD_SERVER]));
  check('a server with a path builds <server>/<hash>.jpg', uploadedArtUrl('https://a.example/blossom', h, { sha256: h })
    === `https://a.example/blossom/${h}.jpg`);
}

// The fallback cover of a playlist BMB does not host. Can fail: the obvious
// version tests `includes('v4vmusic.com')`, which gives a lookalike host
// v4vmusic's style and a path that merely names it too.
{
  const C = coverStyleFor;
  check('a v4vmusic playlist uses its first song', C('https://v4vmusic.com/playlist/508a029b-020f-4334-9704-e0a9a5f800fb.xml') === 'first-song');
  check('a v4vmusic subdomain uses its first song', C('https://www.v4vmusic.com/playlist/x.xml') === 'first-song');
  check('the host is matched in any case', C('https://V4VMusic.com/playlist/x.xml') === 'first-song');
  check('a lookalike host gets the grid', C('https://v4vmusic.com.example/playlist/x.xml') === 'grid');
  check('a host that only ENDS in the name gets the grid', C('https://notv4vmusic.com/p.xml') === 'grid');
  check('a path naming v4vmusic gets the grid', C('https://cdn.kolomona.com/v4vmusic.com/p.xml') === 'grid');
  check('another host gets the grid', C('https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/refs/heads/main/docs/HGH-music-playlist.xml') === 'grid');
  check('junk gets the grid', C('not a url') === 'grid');
}

check('cleanText censors', cleanText('fuck this') === '**** this');
for (const s of ['Scunthorpe classics', 'assassin', 'Cocktail hour', 'a  b\n c'])
  check('cleanText leaves ' + JSON.stringify(s), cleanText(s) === s);

check('feature off by default', COMMUNITY_PLAYLISTS_ON === false);
if (!process.env.NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN)
  check('origin equals buddy origin', COMMUNITY_FEED_ORIGIN === BRANDS.buddy.origin);
check('feed path', COMMUNITY_FEED_PATH === '/feeds/playlists/');
const id = '0b5e2f3a-1c4d-4e6f-8a9b-0c1d2e3f4a5b';
check('feed url shape', communityFeedUrl(id) === `${COMMUNITY_FEED_ORIGIN}/feeds/playlists/${id}.xml`);
check('cover url shape', communityCoverUrl(id, 7) === `${COMMUNITY_FEED_ORIGIN}/feeds/playlists/${id}.jpg?v=7`);
check('round trip', communityIdFromFeedUrl(communityFeedUrl(id)) === id);
check('non-uuid -> null', communityIdFromFeedUrl(`${COMMUNITY_FEED_ORIGIN}/feeds/playlists/x.xml`) === null);
check('other origin -> null', communityIdFromFeedUrl(`https://evil.example/feeds/playlists/${id}.xml`) === null);
check('undefined -> null', communityIdFromFeedUrl(undefined) === null);
check('suffix junk -> null', communityIdFromFeedUrl(communityFeedUrl(id) + '?x=1') === null);
check('coverVersion', coverVersion('2026-11-12T00:00:00.000Z') === 1794441600);

// ---- The feed document ------------------------------------------------------
// Vectors are parsed back with the REAL readers in lib/feed-xml.ts, so a
// document that only our own builder can read fails here.
const PC20 = '917393e3-1b1e-5cef-ace4-edaa54e1f810';
check('guid: PC20 vector', communityFeedGuid('https://mp3s.nashownotes.com/pc20rss.xml') === PC20);
check('guid: trailing slash', communityFeedGuid('https://mp3s.nashownotes.com/pc20rss.xml/') === PC20);
check('guid: http scheme', communityFeedGuid('http://mp3s.nashownotes.com/pc20rss.xml') === PC20);

const TITLE = `Tom & Jerry's <"mix"> ]]> 🎵 שלום`;
const ownerNpub = npubEncode('ab'.repeat(32));
const docSongs = Array.from({ length: 12 }, (_, i) => ({
  feedGuid: 'feed-' + i, itemGuid: i === 3 ? 'https://x.example/?a=1&b=2' : i === 5 ? 'say "hi" it\'s' : 'item-' + i,
  ...(i === 0 ? { feedUrl: 'https://x.example/f.xml?a=1&b=2' } : {}),
}));
const stored = {
  id, ownerPubkey: 'ab'.repeat(32), createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z', title: TITLE, description: 'A & B <c>', ownerName: '', artUrl: null, songs: docSongs,
};
// The maker's publisher feed: it lists every playlist of the maker, and each playlist
// names it back in <podcast:publisher>. The spec trusts the link only both ways.
const PUB_URL = communityPublisherFeedUrl(ownerNpub);
const PUB_GUID = communityFeedGuid(PUB_URL);
const opts = {
  feedUrl: communityFeedUrl(id), coverUrl: communityCoverUrl(id, 1),
  ownerNpub, fallbackDescription: 'Fallback & co', podcastGuid: communityFeedGuid(communityFeedUrl(id)),
  generator: `${BRANDS.buddy.displayName} (${BRANDS.buddy.origin})`,
  publisher: { feedUrl: PUB_URL, podcastGuid: PUB_GUID },
};
// The guid saved with the row when it was created. It is the feed's identity for good:
// a deploy whose feed origin differs from the one the row was made under must not mint a
// second one (the recomputed guid below is what the builder used to print).
const STORED_GUID = '3f2a1b0c-9d8e-5f7a-8b6c-5d4e3f2a1b0c';
const titleOf = (xml) => decodeXmlText(/<title>([\s\S]*?)<\/title>/.exec(channelSlice(xml))[1]);
const docVectors = [
  { kind: 'items', build: (b) => b(stored, opts), test: (xml) => {
    const refs = parsePlaylistRemoteItems(channelSlice(xml));
    return refs.length === 12 && refs.every((x, i) => x.feedGuid === docSongs[i].feedGuid && x.itemGuid === docSongs[i].itemGuid);
  } },
  { kind: 'title', build: (b) => b(stored, opts), test: (xml) => titleOf(xml) === TITLE },
  { kind: 'title well-formed', build: (b) => b(stored, opts), test: (xml) => {
    const raw = /<title>([\s\S]*?)<\/title>/.exec(channelSlice(xml))[1];
    return !/[<>"']/.test(raw) && !/&(?!(amp|lt|gt|quot|apos);)/.test(raw);
  } },
  { kind: 'medium on every item', build: (b) => b(stored, opts), test: (xml) =>
    (xml.match(/<podcast:remoteItem [^>]*medium="music"\/>/g) ?? []).length === 12
    && (xml.match(/medium="music"/g) ?? []).length === 12 },
  { kind: 'xml-illegal chars stripped', build: (b) => b({ ...stored, title: 'a\x01b\x1Fc\uD800d' }, opts), test: (xml) =>
    !/[\x00-\x08\x0B\x0C\x0E-\x1F\uD800-\uDFFF]/.test(xml) && titleOf(xml) === 'abcd' },
  { kind: 'npub', build: (b) => b(stored, opts), test: (xml) => {
    const n = parseFeedNpubs(xml); return !!n && n.length === 1 && n[0].npub === ownerNpub;
  } },
  { kind: 'description', build: (b) => b(stored, opts), test: (xml) =>
    decodeXmlText(/<description>([\s\S]*?)<\/description>/.exec(channelSlice(xml))[1]) === 'A & B <c>' },
  { kind: 'fallback description', build: (b) => b({ ...stored, description: '' }, opts), test: (xml) =>
    decodeXmlText(/<description>([\s\S]*?)<\/description>/.exec(channelSlice(xml))[1]) === 'Fallback & co' },
  // No value block, ever (Chad, 2026-11-15: the maker of a playlist takes no cut).
  { kind: 'no value/item; no author without a name', build: (b) => b(stored, opts), test: (xml) =>
    !/<podcast:value/.test(xml) && !/<item/.test(xml) && !/<itunes:author/.test(xml) },
  { kind: 'no value/item with a name either', build: (b) => b({ ...stored, ownerName: 'X' }, opts), test: (xml) =>
    !/<podcast:value/.test(xml) && !/<item/.test(xml) },
  // The maker's Nostr name, once, in the channel, escaped (Chad, 2026-11-15).
  { kind: 'author is the stored name', build: (b) => b({ ...stored, ownerName: `Tom & "Jerry" <3` }, opts), test: (xml) => {
    const all = xml.match(/<itunes:author>([\s\S]*?)<\/itunes:author>/g) ?? [];
    const m = /<itunes:author>([\s\S]*?)<\/itunes:author>/.exec(channelSlice(xml));
    return all.length === 1 && !!m && !/[<>"']/.test(m[1]) && decodeXmlText(m[1]) === `Tom & "Jerry" <3`;
  } },
  { kind: 'feedUrl only when known', build: (b) => b(stored, opts), test: (xml) =>
    (xml.match(/<podcast:remoteItem [^>]*itemGuid=[^>]*feedUrl=/g) ?? []).length === 1
    && xml.includes('feedUrl="https://x.example/f.xml?a=1&amp;b=2"') },
  // The back-link: once, in the channel, medium="publisher", and no itemGuid, so no
  // track reader (parsePlaylistRemoteItems above: still 12) takes it for a song.
  { kind: 'publisher back-link', build: (b) => b(stored, opts), test: (xml) => {
    const blocks = channelSlice(xml).match(/<podcast:publisher>([\s\S]*?)<\/podcast:publisher>/g) ?? [];
    const items = blocks.length === 1 ? blocks[0].match(/<podcast:remoteItem [^>]*\/>/g) ?? [] : [];
    return items.length === 1 && items[0].includes('medium="publisher"') && items[0].includes('rel="curator"')
      && items[0].includes(`feedGuid="${PUB_GUID}"`) && items[0].includes(`feedUrl="${escapeXml(PUB_URL)}"`)
      && !items[0].includes('itemGuid') && (xml.match(/<podcast:publisher>/g) ?? []).length === 1;
  } },
  // lastBuildDate is the later of the row's updatedAt and FEED_TEMPLATE_UPDATED_AT, so a
  // template change reaches every feed's date and an edit after it still moves the date.
  { kind: 'rfc822 lastBuildDate: an older row shows the template date', build: (b) => b(stored, opts), test: (xml) =>
    xml.includes(`<lastBuildDate>${new Date(FEED_TEMPLATE_UPDATED_AT).toUTCString()}</lastBuildDate>`)
    && Date.parse(stored.updatedAt) < Date.parse(FEED_TEMPLATE_UPDATED_AT) },
  // pubDate is the row's own last change, never the template date: a template change publishes nothing new.
  { kind: 'rfc822 pubDate is the row edit', build: (b) => b(stored, opts), test: (xml) =>
    (channelSlice(xml).match(/<pubDate>/g) ?? []).length === 1
    && xml.includes(`<pubDate>${new Date(stored.updatedAt).toUTCString()}</pubDate>`) },
  { kind: 'rfc822 lastBuildDate: a newer row shows its own edit', build: (b) => b({ ...stored, updatedAt: '2099-01-02T03:04:05.000Z' }, opts), test: (xml) =>
    xml.includes('<lastBuildDate>Fri, 02 Jan 2099 03:04:05 GMT</lastBuildDate>') },
  { kind: 'stored podcast:guid', build: (b) => b(stored, { ...opts, podcastGuid: STORED_GUID }), test: (xml) =>
    xml.includes(`<podcast:guid>${STORED_GUID}</podcast:guid>`) && !xml.includes(communityFeedGuid(opts.feedUrl)) },
  { kind: 'channel fields', build: (b) => b(stored, opts), test: (xml) =>
    xml.includes('xmlns:podcast="https://podcastindex.org/namespace/1.0"') && xml.includes('xmlns:itunes=')
    && xml.includes('<podcast:medium>musicL</podcast:medium>')
    && xml.includes(`<podcast:guid>${communityFeedGuid(opts.feedUrl)}</podcast:guid>`)
    && xml.includes(`<itunes:image href="${opts.coverUrl}"/>`)
    && xml.includes('<language>en</language>') },
  { kind: 'generator names Boost Me Buddy', build: (b) => b(stored, opts), test: (xml) =>
    (channelSlice(xml).match(/<generator>/g) ?? []).length === 1
    && xml.includes('<generator>Boost Me Buddy (https://www.boostmebuddy.com)</generator>') },
];
// The obvious wrong builder: the same document with nothing escaped.
const naiveBuild = (p, o) => buildPlaylistFeedXml(p, o)
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
for (const v of docVectors) {
  check('feed doc: ' + v.kind, v.test(v.build(buildPlaylistFeedXml)));
}
// The escapeXml before the control-character strip: same doc, title escaped the old way.
const oldEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const oldEscapeBuild = (p, o) => buildPlaylistFeedXml({ ...p, title: 'TT' }, o)
  .replaceAll('TT', oldEscape(p.title));
{
  const v = docVectors.find((x) => x.kind === 'xml-illegal chars stripped');
  check('feed doc: illegal chars vector fails against old escapeXml (can fail)', !v.test(v.build(oldEscapeBuild)));
}
// Only the escaping vectors must fail against the naive builder.
for (const v of docVectors.filter((x) => ['items', 'title well-formed', 'author is the stored name'].includes(x.kind))) {
  let passes;
  try { passes = v.test(v.build(naiveBuild)); } catch { passes = false; }
  check('feed doc: ' + v.kind + ' fails against naive (can fail)', !passes);
}
{
  // Can fail: the old builder recomputed the guid from the feed URL it was handed.
  const v = docVectors.find((x) => x.kind === 'stored podcast:guid');
  const recompute = (p, o) => buildPlaylistFeedXml(p, { ...o, podcastGuid: communityFeedGuid(o.feedUrl) });
  check('feed doc: stored-guid vector fails against recomputing from the URL (can fail)', !v.test(v.build(recompute)));
}
check('escapeXml', escapeXml(`&<>"'`) === '&amp;&lt;&gt;&quot;&apos;');

// ---- The MADE BY box: PlaylistDraft.ownerName, printed as <itunes:author> ----
{
  const nsec = nsecEncode(generateSecretKey());
  const name = (raw) => { const r = V(draft({ ownerName: raw })); return r.ok ? r.draft.ownerName : kinds(r); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const nameVectors = [
    { kind: 'plain', args: ['ChadF'], want: 'ChadF', alsoNaive: true },
    { kind: 'trimmed', args: ['  ChadF  '], want: 'ChadF', alsoNaive: true },
    { kind: 'absent is no name (an older draft)', args: [undefined], want: '', alsoNaive: true },
    { kind: 'not a string is no name', args: [42], want: '', alsoNaive: true },
    { kind: 'white space runs collapse', args: ['Chad \t\n  F'], want: 'Chad F' },
    { kind: 'control characters go', args: ['Ch\x00ad\x1F\x7F\x85F'], want: 'Ch ad F' },
    { kind: 'MAX_OWNER_NAME_LEN code points pass', args: ['é'.repeat(MAX_OWNER_NAME_LEN)], want: 'é'.repeat(MAX_OWNER_NAME_LEN), alsoNaive: true },
    { kind: 'one more is refused', args: ['é'.repeat(MAX_OWNER_NAME_LEN + 1)], want: ['name-too-long'] },
    { kind: 'a secret key is refused', args: [nsec], want: ['secret'] },
    { kind: 'a key inside a name is refused (and too long)', args: [`hi ${nsec}`], want: ['secret', 'name-too-long'] },
  ];
  // The obvious wrong version: take the box as typed, trimmed, with no limit or key test.
  const naive = (raw) => (typeof raw === 'string' ? raw.trim() : '');
  for (const v of nameVectors) {
    check('name box: ' + v.kind, same(name(...v.args), v.want));
    const n = naive(...v.args);
    if (v.alsoNaive) check('name box: ' + v.kind + ' (naive agrees)', same(n, v.want));
    else check('name box: ' + v.kind + ' fails against naive (can fail)', !same(n, v.want));
  }
  const r = V(draft({ ownerName: nsec }));
  check('name box: the secret refusal names the field "name"', !r.ok && r.problems.some((p) => p.kind === 'secret' && p.field === 'name'));
  check('foldName of a non-string is empty', foldName(null) === '' && foldName({}) === '');
}

// ---- the maker's Lightning address, the ZAP tile's stored HINT (cleanMakerLn) ----
// Three answers: undefined LEAVES the stored value, null CLEARS it, a string stores
// it. The naive version (`typeof raw === 'string' ? raw : null`) stores whatever a
// client sends, a secret key included, and turns "said nothing" into a clear.
{
  const nsec = nsecEncode(generateSecretKey());
  const naive = (raw) => (typeof raw === 'string' ? raw : null);
  const clean = (raw) => cleanMakerLn(raw, textHoldsSecret);
  const V = [
    { kind: 'a lud16 is kept, lower-cased', args: ['  SirTJ@GetAlby.com '], want: 'sirtj@getalby.com' },
    { kind: 'a long real lud16 is kept', args: ['a-playlist-maker-with-a-long-lightning-name@example.com'], want: 'a-playlist-maker-with-a-long-lightning-name@example.com', alsoNaive: true },
    { kind: 'a lud06 is kept', args: ['LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS'], want: 'lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexejxxepnxscrvwfnv9nxzcn9xq6xyefhvgcxxcmyxymnserxfq5fns' },
    { kind: 'absent says nothing (leave it)', args: [undefined], want: undefined },
    { kind: 'null clears', args: [null], want: null, alsoNaive: true },
    { kind: 'empty clears', args: ['   '], want: null },
    { kind: 'a secret key is never stored', args: [nsec], want: null },
    { kind: 'not an address is dropped', args: ['https://example.com/pay'], want: null },
    { kind: 'a number is dropped', args: [42], want: null, alsoNaive: true },
    { kind: 'too long is dropped', args: ['a'.repeat(MAX_MAKER_LN_LEN) + '@example.com'], want: null },
  ];
  for (const v of V) {
    check('maker ln: ' + v.kind, clean(...v.args) === v.want);
    const n = naive(...v.args);
    if (v.alsoNaive) check('maker ln: ' + v.kind + ' (naive agrees)', n === v.want);
    else check('maker ln: ' + v.kind + ' fails against naive (can fail)', n !== v.want);
  }
  check('makerLnOf: lud16 first', makerLnOf({ lud16: 'a@b.co', lud06: 'lnurl1x' }) === 'a@b.co');
  check('makerLnOf: lud06 when no lud16', makerLnOf({ lud06: 'lnurl1x' }) === 'lnurl1x');
  check('makerLnOf: a profile with no address clears', makerLnOf({ name: 'x' }) === null);
  check('makerLnOf: no profile says nothing', makerLnOf(undefined) === undefined && makerLnOf(null) === undefined);
}

// ---- the maker's publisher feed (buildPublisherFeedXml) ----
{
  const pIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const entries = [
    { feedUrl: communityFeedUrl(pIds[0]), podcastGuid: 'aaaaaaaa-0000-5000-8000-000000000001', coverUrl: 'https://img.example/a.jpg?x=1&y=2', updatedAt: '2026-11-15T00:00:00.000Z' },
    { feedUrl: communityFeedUrl(pIds[1]), podcastGuid: 'aaaaaaaa-0000-5000-8000-000000000002', coverUrl: communityCoverUrl(pIds[1], 7), updatedAt: '2026-11-14T00:00:00.000Z' },
  ];
  const popts = {
    feedUrl: PUB_URL, podcastGuid: PUB_GUID, ownerNpub, ownerName: `Tom & "Jerry"`,
    siteName: BRANDS.buddy.displayName, generator: opts.generator,
  };
  const xml = buildPublisherFeedXml(entries, popts);
  const ch = channelSlice(xml);
  const items = ch.match(/<podcast:remoteItem [^>]*\/>/g) ?? [];
  check('pubfeed URL: the feed origin, /feeds/publishers/, the npub',
    COMMUNITY_PUBLISHER_PATH === '/feeds/publishers/' && PUB_URL === `${COMMUNITY_FEED_ORIGIN}/feeds/publishers/${ownerNpub}.xml`);
  check('pubfeed: medium publisher, its guid, one channel',
    ch.includes('<podcast:medium>publisher</podcast:medium>') && ch.includes(`<podcast:guid>${PUB_GUID}</podcast:guid>`)
    && (xml.match(/<channel>/g) ?? []).length === 1);
  // medium="musicL", never "music": a music index then lists the maker as a curator of
  // playlists and not as a musician (Chad, 2026-11-16).
  check('pubfeed: one remoteItem per playlist, in order, medium="musicL", feedGuid/feedUrl/feedImg',
    items.length === 2 && items.every((t, i) => t.includes('medium="musicL"') && t.includes('rel="curator"')
      && t.includes(`feedGuid="${entries[i].podcastGuid}"`) && t.includes(`feedUrl="${escapeXml(entries[i].feedUrl)}"`)
      && t.includes(`feedImg="${escapeXml(entries[i].coverUrl)}"`)) && !/medium="music"/.test(xml));
  check('pubfeed: no itemGuid, no <item>, no value block', !xml.includes('itemGuid') && !/<item/.test(xml) && !/<podcast:value/.test(xml));
  check('pubfeed: title and author from the escaped name',
    titleOf(xml) === `Tom & "Jerry"'s playlists`
    && decodeXmlText(/<itunes:author>([\s\S]*?)<\/itunes:author>/.exec(ch)?.[1] ?? '') === `Tom & "Jerry"`);
  const BARE_AMP = /&(?!(amp|lt|gt|quot|apos);)/;
  const wellFormed = (doc) => {
    const c = channelSlice(doc);
    const title = /<title>([\s\S]*?)<\/title>/.exec(c)?.[1] ?? '';
    return (c.match(/<podcast:remoteItem [^>]*\/>/g) ?? []).every((t) => !BARE_AMP.test(t))
      && !BARE_AMP.test(title) && !/[<>"']/.test(title);
  };
  check('pubfeed: attribute values and title well-formed', wellFormed(xml));
  const naivePub = xml.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  check('pubfeed: well-formed vector fails against naive (can fail)', !wellFormed(naivePub));
  check('pubfeed: npub, generator, image is the newest playlist\'s cover',
    parseFeedNpubs(xml)?.[0]?.npub === ownerNpub && ch.includes(`<generator>${escapeXml(opts.generator)}</generator>`)
    && ch.includes(`<itunes:image href="${escapeXml(entries[0].coverUrl)}"/>`));
  check('pubfeed: pubDate is the newest playlist edit, lastBuildDate also counts the template date',
    ch.includes(`<pubDate>${new Date(entries[0].updatedAt).toUTCString()}</pubDate>`)
    && ch.includes(`<lastBuildDate>${new Date(Math.max(Date.parse(entries[0].updatedAt), Date.parse(FEED_TEMPLATE_UPDATED_AT))).toUTCString()}</lastBuildDate>`));
  const anon = buildPublisherFeedXml(entries, { ...popts, ownerName: '' });
  check('pubfeed: no name -> no author, and a title from the npub',
    !/<itunes:author/.test(anon) && titleOf(anon).includes(ownerNpub.slice(0, 16)));
  // Both ways: the playlist names this publisher feed, and the publisher feed lists it.
  const pl = buildPlaylistFeedXml(stored, opts);
  const back = (channelSlice(pl).match(/<podcast:publisher>[\s\S]*?<\/podcast:publisher>/) ?? [''])[0];
  const one = buildPublisherFeedXml([{ feedUrl: opts.feedUrl, podcastGuid: opts.podcastGuid, coverUrl: opts.coverUrl, updatedAt: stored.updatedAt }], popts);
  const relOf = (tag) => (/ rel="([^"]*)"/.exec(tag) ?? [])[1];
  check('the role is "curator", the same on both sides of the link (musicindex counts only an agreed role)',
    PLAYLIST_MAKER_REL === 'curator' && relOf(back) === 'curator'
    && relOf((channelSlice(one).match(/<podcast:remoteItem [^>]*\/>/) ?? [''])[0]) === relOf(back));
  check('pubfeed and playlist link both ways',
    back.includes(`feedGuid="${PUB_GUID}"`) && back.includes(`feedUrl="${escapeXml(PUB_URL)}"`)
    && one.includes(`<podcast:guid>${PUB_GUID}</podcast:guid>`)
    && one.includes(`feedGuid="${opts.podcastGuid}"`) && one.includes(`feedUrl="${escapeXml(opts.feedUrl)}"`));
}

// ---- NIP-98 (lib/community/auth.ts) ----
{
  const sk = generateSecretKey();
  const pub = getPublicKey(sk);
  const URL1 = 'https://example.test/api/community/playlists';
  const body = { title: 'T', songs: [{ feedGuid: 'a', itemGuid: 'b' }] };
  const bodyText = JSON.stringify(body);
  const sign = (over = {}) => (e) => finalizeEvent({ ...e, ...over }, sk);
  const tok = (url, method, b, over) => getToken(url, method, sign(over), true, b);
  const good = await tok(URL1, 'POST', body);
  const reason = async (h, url = URL1, m = 'POST', t = bodyText) => {
    const x = await verifyNip98(h, url, m, t);
    return x.ok ? 'ok' : x.reason;
  };
  let x = await verifyNip98(good, URL1, 'POST', bodyText);
  check('nip98: valid POST with body', x.ok && x.pubkey === pub);
  check('nip98: url mismatch', (await reason(good, 'https://example.test/other')) === 'url');
  check('nip98: url with trailing ? ok', (await reason(good, URL1 + '?')) === 'ok');
  check('nip98: method mismatch', (await reason(good, URL1, 'PUT')) === 'method');
  check('nip98: body changed after signing', (await reason(good, URL1, 'POST', JSON.stringify({ ...body, title: 'X' }))) === 'payload');
  check('nip98: same content, other whitespace, verifies', (await reason(good, URL1, 'POST', JSON.stringify(body, null, 2))) === 'ok');
  const noPayload = await tok(URL1, 'POST', undefined);
  check('nip98: body sent but token has no payload tag', (await reason(noPayload)) === 'payload');
  check('nip98: no body, no payload tag ok', (await reason(noPayload, URL1, 'POST', null)) === 'ok');
  check('nip98: unparseable body text', (await reason(good, URL1, 'POST', '{nope')) === 'payload');
  const old = await tok(URL1, 'POST', body, { created_at: Math.round(Date.now() / 1000) - 120 });
  check('nip98: 120 s old', (await reason(old)) === 'clock');
  const future = await tok(URL1, 'POST', body, { created_at: Math.round(Date.now() / 1000) + 120 });
  check('nip98: 120 s in the future', (await reason(future)) === 'clock');
  const k1 = await tok(URL1, 'POST', body, { kind: 1 });
  check('nip98: kind 1 refused', (await reason(k1)) !== 'ok');
  const ev = JSON.parse(atob(good.slice(6)));
  ev.sig = (ev.sig[0] === '0' ? '1' : '0') + ev.sig.slice(1);
  const badSig = 'Nostr ' + btoa(JSON.stringify(ev));
  check('nip98: tampered sig', (await reason(badSig)) === 'signature');
  check('nip98: null header', (await reason(null)) === 'missing');
  check('nip98: empty header', (await reason('')) === 'missing');
  check('nip98: garbage header', (await reason('Nostr !!!')) === 'malformed');
  check('nip98: no scheme', (await reason('Bearer abc')) === 'malformed');
  check('nip98: json but not an event', (await reason('Nostr ' + btoa('{"a":1}'))) === 'malformed');

  // Naive verifier: signature only. The url, method, payload and clock vectors must fail against it.
  const naive = async (h) => {
    try {
      const e = JSON.parse(atob(h.slice(6)));
      return verifyEvent(e) ? 'ok' : 'signature';
    } catch { return 'malformed'; }
  };
  const vecs = [
    ['url', good, 'url', URL1 + 'x', 'POST', bodyText],
    ['method', good, 'method', URL1, 'PUT', bodyText],
    ['payload', good, 'payload', URL1, 'POST', JSON.stringify({ ...body, title: 'X' })],
    ['clock', old, 'clock', URL1, 'POST', bodyText],
  ];
  for (const [n, h, want, u, m, t] of vecs) {
    check('nip98: ' + n + ' vector passes real', (await reason(h, u, m, t)) === want);
    check('nip98: ' + n + ' vector fails against naive (can fail)', (await naive(h)) !== want);
  }

  const npub = npubEncode(pub);
  const set = adminPubkeys(npub + ', junk');
  check('admins: one valid of two', set.size === 1 && set.has(pub));
  check('admins: empty / undefined', adminPubkeys('').size === 0);
  const others = [noteEncode(pub), nprofileEncode({ pubkey: pub }), nsecEncode(sk)].join(',');
  check('admins: note/nprofile/nsec are not admins', adminPubkeys(others).size === 0);
  const shortNpub = bech32.encode('npub', bech32.toWords(new Uint8Array(31).fill(7)), 1000);
  const longNpub = bech32.encode('npub', bech32.toWords(new Uint8Array(33).fill(7)), 1000);
  check('admins: wrong-length npub dropped', adminPubkeys(shortNpub + ',' + longNpub).size === 0);
  {
    // Can fail: without the type / length guards these would be accepted.
    const loose = (env) => new Set(env.split(',').map((t) => { try { return decodeAny(t); } catch { return null; } }).filter(Boolean));
    const decodeAny = (t) => { const w = bech32.decode(t, 1000); const d = bech32.fromWords(w.words); return d.length ? Buffer.from(d).toString('hex') : null; };
    check('admins: type vector fails against loose (can fail)', loose(others).size !== 0);
    check('admins: length vector fails against loose (can fail)', loose(shortNpub + ',' + longNpub).size !== 0);
  }
  {
    const evM = finalizeEvent({ kind: 27235, created_at: Math.round(Date.now() / 1000), content: '', tags: [['u', URL1], ['method']] }, sk);
    const hM = 'Nostr ' + btoa(JSON.stringify(evM));
    let res; let threw = false;
    try { res = await verifyNip98(hM, URL1, 'POST', null); } catch { threw = true; }
    check('nip98: method tag with no value does not throw', !threw && !res.ok && ['method', 'malformed'].includes(res.reason));
    // Can fail: the library's check throws on this token.
    let libThrew = false;
    try { validateEventMethodTag(evM, 'POST'); } catch { libThrew = true; }
    check('nip98: method-tag vector fails against library check (can fail)', libThrew);
  }
  check('authMessage clock', authMessage('clock') === 'Your device clock is off. Set it to automatic time and try again.');
  check('authMessage other', authMessage('url') === 'Sign-in check failed. Sign in again and retry.');
}

{
  const summary = {
    id: 'a', title: 'T', description: 'D', feedUrl: 'https://x.test/feeds/playlists/a.xml', podcastGuid: 'g',
    ownerPubkey: 'pk', ownerNpub: 'npub1z', coverUrl: 'https://x.test/feeds/playlists/a.jpg?v=1', songCount: 10,
    createdAt: '', updatedAt: '',
  };
  const want = {
    id: -fnvHash(summary.feedUrl), podcastGuid: 'g', title: 'T', description: 'D', image: summary.coverUrl,
    artwork: summary.coverUrl, url: summary.feedUrl, medium: 'musicL', isPreview: true,
    nostrNpubs: [{ npub: 'npub1z', pubkey: 'pk' }],
  };
  const got = communityPlaylistToPodcast(summary);
  check('communityPlaylistToPodcast: exact shape', JSON.stringify(got) === JSON.stringify(want));
  check('communityPlaylistToPodcast: id is negative', got.id < 0);
  // The list row's "who made it" line is `author`, as for a v4vmusic playlist.
  const named = communityPlaylistToPodcast({ ...summary, ownerName: 'ChadF' });
  check('communityPlaylistToPodcast: the maker name is the author', named.author === 'ChadF');
  check('communityPlaylistToPodcast: no name, no author key', !('author' in communityPlaylistToPodcast({ ...summary, ownerName: null })));
}

{
  // Note context for a song played from a playlist (Task 15).
  const HOSTED = 'https://www.boostmebuddy.com/feeds/playlists/';
  const list = { id: 1, podcastGuid: 'list-g', title: 'Road Trip', medium: 'musicL',
    url: HOSTED + 'abc.xml', nostrNpubs: [{ npub: 'npub1maker', pubkey: 'pk' }] };
  const song = { id: 9, title: 'Song', podcastGuid: 'album-g', feedTitle: 'The Album', feedId: 77, feedImage: 'https://x/a.jpg' };
  const ctx = playlistBoostContext(list, song, HOSTED);
  check('context: container is the playlist', ctx.container === list);
  check('context: show is the track\'s own feed', ctx.show.podcastGuid === 'album-g' && ctx.show.title === 'The Album');
  check('context: show carries NO container npubs', ctx.show.nostrNpubs === undefined);
  check('context: hosted true for the hosted prefix', ctx.hosted === true);
  const own = playlistBoostContext(list, { ...song, podcastGuid: 'list-g' }, HOSTED);
  check('context: same guid -> no container, show is podcast', own.container === null && own.show === list && own.hosted === false);
  const noEp = playlistBoostContext(list, undefined, HOSTED);
  check('context: no episode -> no container', noEp.container === null && noEp.show === list);
  const album = { id: 2, podcastGuid: 'al', title: 'Alb', medium: 'music', url: HOSTED + 'x.xml' };
  const alb = playlistBoostContext(album, song, HOSTED);
  check('context: a music album with a foreign guid is NOT a container', alb.container === null && alb.show === album && alb.hosted === false);
  const bare = { id: -5, title: 'Preview List', medium: 'musicL', url: HOSTED + 'p.xml', nostrNpubs: [{ npub: 'npub1maker', pubkey: 'pk' }] };
  const bc = playlistBoostContext(bare, song, HOSTED);
  check('context: a guid-less playlist is still the container', bc.container === bare);
  check('context: guid-less playlist -> show is the song\'s own feed',
    bc.show.podcastGuid === 'album-g' && bc.show.title === 'The Album' && bc.show.nostrNpubs === undefined && bc.show !== bare);
  check('context: guid-less playlist hosted per url', bc.hosted === true);
  check('context: guid-less playlist, foreign url -> not hosted', playlistBoostContext({ ...bare, url: 'https://e.com/x.xml' }, song, HOSTED).hosted === false);
  check('context: guid-less music album is NOT a container', playlistBoostContext({ ...bare, medium: 'music' }, song, HOSTED).container === null);
  const ext = playlistBoostContext({ ...list, url: 'https://example.com/pl.xml' }, song, HOSTED);
  check('context: hosted false for a foreign feed url', ext.container !== null && ext.hosted === false);
  const noUrl = playlistBoostContext({ ...list, url: undefined }, song, HOSTED);
  check('context: hosted false with no url', noUrl.hosted === false);

  const j = (v) => JSON.stringify(v);
  // ONE line, and no link (Chad, 2026-11-19): a client unfurled the playlist's
  // link to the site's general card. The playlist's `i` tag keeps the link.
  check('heardOn: with maker', j(heardOnLines(list, 'npub1maker')) ===
    j(['🎧 Heard on Road Trip by nostr:npub1maker']));
  check('heardOn: without maker', j(heardOnLines(list, null)) ===
    j(['🎧 Heard on Road Trip']));
  check('heardOn: no guid -> the same one line', j(heardOnLines({ ...list, podcastGuid: undefined }, 'npub1m')) ===
    j(['🎧 Heard on Road Trip by nostr:npub1m']));
  check('heardOn: never a link line, whatever the guid', heardOnLines({ ...list, podcastGuid: 'a b&c' }, null).length === 1);
}

{
  // The no-art cover: reached with an empty tile list, no font needed.
  check('noteSvg has no <text>', !/<text/i.test(noteSvg()));
  const jpg = await composeCover([null, null, null, null]);
  const m = await sharp(jpg).metadata();
  check('empty tile list -> 1400 x 1400 JPEG', m.format === 'jpeg' && m.width === 1400 && m.height === 1400);
  const px = async (x, y) => [...(await sharp(jpg).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];
  const corner = await px(5, 5);
  check('note canvas corner is #0A0A08', Math.abs(corner[0] - 10) < 6 && Math.abs(corner[1] - 10) < 6 && Math.abs(corner[2] - 8) < 6);
  const stem = await px(625, 700); // inside the first stem
  check('note stem is #FAE500', stem[0] > 230 && stem[1] > 210 && stem[2] < 40);
  const red = await sharp({ create: { width: 700, height: 700, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const g = await composeCover([red, null, red]);
  const gm = await sharp(g).metadata();
  check('grid with a missing tile -> 1400 x 1400', gm.width === 1400 && gm.height === 1400);
  const rep = [...(await sharp(g).extract({ left: 1000, top: 300, width: 1, height: 1 }).raw().toBuffer())];
  check('a missing tile repeats the previous one', rep[0] > 200 && rep[1] < 60);
}

// archiveDispatchBase — where GITHUB_ARCHIVE_TOKEN may go (lib/community/archive-notify.ts).
// The token can start this repo's workflows, so the only hosts are GitHub's API
// on a real-feed server and a loopback test stub.
{
  const GH = 'https://api.github.com';
  const vectors = [
    { kind: 'production feed origin, no override: GitHub', args: [undefined, PRODUCTION_FEED_ORIGIN], want: GH, alsoNaive: true },
    { kind: 'a local feed origin: nowhere', args: [undefined, 'http://localhost:3123'], want: null },
    { kind: 'a beta feed origin: nowhere', args: [undefined, 'https://beta.boostmebitch.com'], want: null },
    { kind: 'a loopback stub', args: ['http://127.0.0.1:48555', 'http://localhost:3123'], want: 'http://127.0.0.1:48555', alsoNaive: true },
    { kind: 'a localhost stub, path dropped', args: ['http://localhost:48555/x', 'http://localhost:3123'], want: 'http://localhost:48555' },
    { kind: 'a public host in the override: nowhere', args: ['https://evil.example', PRODUCTION_FEED_ORIGIN], want: null },
    { kind: 'a DNS name that resolves to loopback: nowhere', args: ['http://127.0.0.1.nip.io', PRODUCTION_FEED_ORIGIN], want: null },
    { kind: 'userinfo hiding another host: nowhere', args: ['http://localhost@evil.example', PRODUCTION_FEED_ORIGIN], want: null },
    { kind: 'a loopback with userinfo: nowhere', args: ['http://user:pw@127.0.0.1:1', PRODUCTION_FEED_ORIGIN], want: null },
    { kind: 'https to loopback: nowhere (the stub is http)', args: ['https://127.0.0.1:1', PRODUCTION_FEED_ORIGIN], want: null },
    { kind: 'an override typo: nowhere, never GitHub', args: ['127.0.0.1:48555', PRODUCTION_FEED_ORIGIN], want: null },
  ];
  // The obvious wrong version: the override if set, else GitHub.
  const naive = (override) => (override ? override.replace(/\/+$/, '') : GH);
  for (const v of vectors) {
    check('archive dispatch: ' + v.kind, archiveDispatchBase(...v.args) === v.want);
    const n = naive(...v.args);
    if (v.alsoNaive) check('archive dispatch: ' + v.kind + ' (naive agrees)', n === v.want);
    else check('archive dispatch: ' + v.kind + ' fails against naive (can fail)', n !== v.want);
  }
}

// piNotifyBase — where a playlist feed may be submitted (lib/community/pi-notify.ts).
// A Podcast Index submission is public and permanent, so: the switch, the real
// feed origin, and Vercel production or the `beta` branch; or a loopback stub.
{
  const PI = PI_API_BASE;
  const env = (o) => ({ notify: 'on', override: undefined, vercelEnv: undefined, gitRef: undefined, feedOrigin: PRODUCTION_FEED_ORIGIN, ...o });
  const vectors = [
    { kind: 'switch unset: nowhere', args: [env({ notify: undefined, vercelEnv: 'production' })], want: null, alsoNaive: true },
    { kind: 'switch "true", not "on": nowhere', args: [env({ notify: 'true', vercelEnv: 'production' })], want: null, alsoNaive: true },
    { kind: 'production: Podcast Index', args: [env({ vercelEnv: 'production', gitRef: 'main' })], want: PI, alsoNaive: true },
    { kind: 'the beta branch preview: Podcast Index', args: [env({ vercelEnv: 'preview', gitRef: 'beta' })], want: PI, alsoNaive: true },
    { kind: 'a PR preview: nowhere', args: [env({ vercelEnv: 'preview', gitRef: 'playlist-pi-submit' })], want: null },
    { kind: 'a preview with no branch: nowhere', args: [env({ vercelEnv: 'preview' })], want: null },
    { kind: 'a branch named like beta: nowhere', args: [env({ vercelEnv: 'preview', gitRef: 'beta-old' })], want: null },
    { kind: 'vercel dev: nowhere', args: [env({ vercelEnv: 'development', gitRef: 'beta' })], want: null, alsoNaive: true },
    { kind: 'off Vercel (next dev / next start): nowhere', args: [env({})], want: null, alsoNaive: true },
    { kind: 'production with a local feed origin: nowhere', args: [env({ vercelEnv: 'production', feedOrigin: 'http://localhost:3123' })], want: null, alsoNaive: true },
    { kind: 'a loopback stub', args: [env({ override: 'http://127.0.0.1:48555', feedOrigin: 'http://localhost:3123' })], want: 'http://127.0.0.1:48555/api/1.0', alsoNaive: true },
    { kind: 'a localhost stub, path dropped', args: [env({ override: 'http://localhost:48555/x/' })], want: 'http://localhost:48555/api/1.0' },
    { kind: 'switch off beats a stub: nowhere', args: [env({ notify: undefined, override: 'http://127.0.0.1:48555' })], want: null, alsoNaive: true },
    { kind: 'a DNS name that resolves to loopback: nowhere', args: [env({ override: 'http://127.0.0.1.nip.io:48555', vercelEnv: 'production' })], want: null },
    { kind: 'a public host in the override: nowhere', args: [env({ override: 'https://pi-proxy.example', vercelEnv: 'production' })], want: null },
    { kind: 'an override typo on production: nowhere, never the real API', args: [env({ override: '127.0.0.1:48555', vercelEnv: 'production' })], want: null },
  ];
  // The obvious wrong versions: any preview counts as deployed, and the
  // override is taken as written.
  const naive = (e) => {
    if (e.notify !== 'on') return null;
    if (e.override) return e.override.replace(/\/+$/, '') + '/api/1.0';
    return e.feedOrigin === PRODUCTION_FEED_ORIGIN && (e.vercelEnv === 'production' || e.vercelEnv === 'preview') ? PI : null;
  };
  for (const v of vectors) {
    check('pi notify: ' + v.kind, piNotifyBase(...v.args) === v.want);
    const n = naive(...v.args);
    if (v.alsoNaive) check('pi notify: ' + v.kind + ' (naive agrees)', n === v.want);
    else check('pi notify: ' + v.kind + ' fails against naive (can fail)', n !== v.want);
  }
}

// podpingEndpoint — where a podping (and PODPING_BEARER_TOKEN) may go
// (lib/community/podping-notify.ts). A podping is written to Hive, so it is public and
// permanent, and the request carries a bearer token: the switch, both variables, an
// https endpoint with no userinfo, the real feed origin, and Vercel production or the
// `beta` branch; or a loopback stub.
{
  const PUSHER = 'https://msp-podping-service-production.up.railway.app';
  const env = (o) => ({ notify: 'on', endpoint: PUSHER + '/', hasToken: true, vercelEnv: undefined, gitRef: undefined, feedOrigin: PRODUCTION_FEED_ORIGIN, ...o });
  const vectors = [
    { kind: 'switch unset: nowhere', args: [env({ notify: undefined, vercelEnv: 'production' })], want: null, alsoNaive: true },
    { kind: 'switch "true", not "on": nowhere', args: [env({ notify: 'true', vercelEnv: 'production' })], want: null, alsoNaive: true },
    { kind: 'no endpoint: nowhere', args: [env({ endpoint: undefined, vercelEnv: 'production' })], want: null, alsoNaive: true },
    { kind: 'no token: nowhere', args: [env({ hasToken: false, vercelEnv: 'production' })], want: null, alsoNaive: true },
    { kind: 'production: the pusher (path kept, query dropped)', args: [env({ vercelEnv: 'production', gitRef: 'main', endpoint: PUSHER + '/?x=1' })], want: PUSHER + '/', alsoNaive: false },
    { kind: 'production: the pusher', args: [env({ vercelEnv: 'production', gitRef: 'main' })], want: PUSHER + '/', alsoNaive: true },
    { kind: 'the beta branch preview: the pusher', args: [env({ vercelEnv: 'preview', gitRef: 'beta' })], want: PUSHER + '/', alsoNaive: true },
    { kind: 'a PR preview: nowhere', args: [env({ vercelEnv: 'preview', gitRef: 'feat/playlist-podping' })], want: null },
    { kind: 'a preview with no branch: nowhere', args: [env({ vercelEnv: 'preview' })], want: null },
    { kind: 'a branch named like beta: nowhere', args: [env({ vercelEnv: 'preview', gitRef: 'beta-old' })], want: null },
    { kind: 'vercel dev: nowhere', args: [env({ vercelEnv: 'development', gitRef: 'beta' })], want: null },
    { kind: 'off Vercel (next dev / next start) with the real values: nowhere', args: [env({})], want: null },
    { kind: 'production with a local feed origin: nowhere', args: [env({ vercelEnv: 'production', feedOrigin: 'http://localhost:3123' })], want: null },
    { kind: 'a loopback stub, no deploy checks', args: [env({ endpoint: 'http://127.0.0.1:48555/', feedOrigin: 'http://localhost:3123' })], want: 'http://127.0.0.1:48555/', alsoNaive: true },
    { kind: 'a localhost stub, query dropped', args: [env({ endpoint: 'http://localhost:48555/p?token=x' })], want: 'http://localhost:48555/p' },
    { kind: 'a stub still needs the switch', args: [env({ notify: undefined, endpoint: 'http://127.0.0.1:48555/' })], want: null, alsoNaive: true },
    { kind: 'a stub still needs the token', args: [env({ hasToken: false, endpoint: 'http://127.0.0.1:48555/' })], want: null, alsoNaive: true },
    { kind: 'https to loopback: nowhere (the stub is http)', args: [env({ endpoint: 'https://127.0.0.1:48555/', vercelEnv: 'production' })], want: null },
    { kind: 'plain http to a public host on production: nowhere (the token rides in a header)', args: [env({ endpoint: 'http://pusher.example/', vercelEnv: 'production' })], want: null },
    { kind: 'a DNS name that resolves to loopback: nowhere', args: [env({ endpoint: 'http://127.0.0.1.nip.io:48555/', vercelEnv: 'production' })], want: null },
    { kind: 'userinfo hiding another host: nowhere', args: [env({ endpoint: 'https://pusher.example@evil.example/', vercelEnv: 'production' })], want: null },
    { kind: 'a loopback with userinfo: nowhere', args: [env({ endpoint: 'http://user:pw@127.0.0.1:1/' })], want: null },
    { kind: 'an endpoint typo on production: nowhere, never sent as written', args: [env({ endpoint: 'msp-podping.example', vercelEnv: 'production' })], want: null },
  ];
  // The obvious wrong version: the switch, the two variables, and the endpoint as written.
  const naive = (e) => (e.notify === 'on' && e.endpoint && e.hasToken ? e.endpoint : null);
  for (const v of vectors) {
    check('podping endpoint: ' + v.kind, podpingEndpoint(...v.args) === v.want);
    const n = naive(...v.args);
    if (v.alsoNaive) check('podping endpoint: ' + v.kind + ' (naive agrees)', n === v.want);
    else check('podping endpoint: ' + v.kind + ' fails against naive (can fail)', n !== v.want);
  }

  // The request itself: musicL, update, the feed URL whole, and nothing else.
  const feed = 'https://www.boostmebuddy.com/feeds/playlists/0b5a7c0e-1111-4222-8333-444455556666.xml';
  const u = new URL(podpingRequestUrl(PUSHER + '/', feed));
  check('podping request: the pusher, no path change', u.origin === PUSHER && u.pathname === '/');
  check('podping request: url, reason and medium', u.searchParams.get('url') === feed
    && u.searchParams.get('reason') === 'update' && u.searchParams.get('medium') === 'musicL');
  check('podping request: the constants are what the updater sends', PODPING_MEDIUM === 'musicL' && PODPING_REASON === 'update');
  check('podping request: asks for the detailed answer', u.searchParams.get('detailed_response') === 'true');
  check('podping request: exactly four parameters, no token', [...u.searchParams.keys()].length === 4 && !u.href.toLowerCase().includes('bearer'));
  check('podping request: a query already on the endpoint is replaced', new URL(podpingRequestUrl(PUSHER + '/?medium=podcast', feed)).searchParams.get('medium') === 'musicL');
  check('podping request: a feed URL with a query survives whole', new URL(podpingRequestUrl(PUSHER + '/', feed + '?a=1&b=2')).searchParams.get('url') === feed + '?a=1&b=2');
  check('podping request: a non-http feed is refused', podpingRequestUrl(PUSHER + '/', 'javascript:alert(1)') === null && podpingRequestUrl(PUSHER + '/', 'file:///etc/passwd') === null);
  check('podping request: not a URL is refused', podpingRequestUrl(PUSHER + '/', 'nope') === null && podpingRequestUrl('nope', feed) === null);
  // The obvious wrong version builds the string by hand and leaves the feed unencoded.
  const naiveUrl = (e, f) => `${e}?url=${f}&reason=update&medium=musicL`;
  check('podping request: a hand-built string breaks on a feed URL with a query (can fail)',
    new URL(naiveUrl(PUSHER + '/', feed + '?a=1&b=2')).searchParams.get('url') !== feed + '?a=1&b=2');
}

// piNoticeAllowed — may a publish or SAVE announce its feed (lib/community/pi-notify.ts)?
// The notice needs no key and can add the feed to Podcast Index for good (no delete),
// and the podping is written to Hive, so: not banned, MIN_SONGS songs, one per feed per
// 10 minutes, and a FIRST notice counts against 5 per owner and 30 over all a day.
// The obvious wrong version is the code before #666's plan: a notice on every save.
{
  const NOW = Date.parse('2026-11-23T18:00:00Z');
  const f = (o) => ({
    banned: false, songCount: MIN_SONGS, inIndex: false, notifiedBefore: false, lastNotifiedAt: null,
    ownerFirstToday: 0, allFirstToday: 0, now: NOW, ...o,
  });
  const ago = (ms) => NOW - ms;
  const SEND_FIRST = 'send first';
  const SEND = 'send';
  const vectors = [
    { kind: 'a new playlist, nothing sent today: a first notice', args: [f({})], want: SEND_FIRST, alsoNaive: true },
    { kind: 'a SAVE 11 minutes after the last notice: a notice, not a first', args: [f({ notifiedBefore: true, lastNotifiedAt: ago(11 * 60_000) })], want: SEND, alsoNaive: true },
    { kind: 'exactly the window after: a notice', args: [f({ notifiedBefore: true, lastNotifiedAt: ago(PI_NOTICE_THROTTLE_MS) })], want: SEND, alsoNaive: true },
    { kind: 'a banned owner: none', args: [f({ banned: true })], want: 'banned' },
    { kind: 'nine songs: none', args: [f({ songCount: MIN_SONGS - 1 })], want: 'too-few-songs' },
    { kind: 'a SAVE 2 minutes after the last notice: none', args: [f({ notifiedBefore: true, lastNotifiedAt: ago(2 * 60_000) })], want: 'throttled' },
    { kind: 'one ms inside the window: none', args: [f({ notifiedBefore: true, lastNotifiedAt: ago(PI_NOTICE_THROTTLE_MS - 1) })], want: 'throttled' },
    { kind: 'a last notice in the future (a clock ahead): none', args: [f({ notifiedBefore: true, lastNotifiedAt: NOW + 60_000 })], want: 'throttled' },
    { kind: 'the owner\'s sixth new playlist today: none', args: [f({ ownerFirstToday: PI_NOTICE_OWNER_DAILY, allFirstToday: 5 })], want: 'owner-cap' },
    { kind: 'the owner\'s fifth new playlist today: a first notice', args: [f({ ownerFirstToday: PI_NOTICE_OWNER_DAILY - 1, allFirstToday: 9 })], want: SEND_FIRST, alsoNaive: true },
    { kind: 'the 31st new playlist today over all makers: none', args: [f({ ownerFirstToday: 0, allFirstToday: PI_NOTICE_GLOBAL_DAILY })], want: 'global-cap' },
    { kind: 'a guest key\'s playlist under the caps: a first notice (guests follow the same rules)', args: [f({ ownerFirstToday: 0, allFirstToday: PI_NOTICE_GLOBAL_DAILY - 1 })], want: SEND_FIRST, alsoNaive: true },
    { kind: 'an owner at the cap SAVEs a feed told before: a notice (the cap counts new feeds)', args: [f({ notifiedBefore: true, lastNotifiedAt: ago(60 * 60_000), ownerFirstToday: 9, allFirstToday: 99 })], want: SEND, alsoNaive: true },
    { kind: 'a feed already in the index, never told, at both caps: a notice, not a first', args: [f({ inIndex: true, ownerFirstToday: 9, allFirstToday: 99 })], want: SEND },
    { kind: 'a banned owner beats everything else', args: [f({ banned: true, notifiedBefore: true, lastNotifiedAt: ago(60 * 60_000) })], want: 'banned' },
    { kind: 'a count that is not a number: none', args: [f({ allFirstToday: NaN })], want: 'unknown' },
    { kind: 'a last time that is not a number: none', args: [f({ lastNotifiedAt: 'yesterday' })], want: 'unknown' },
    { kind: 'banned unknown (undefined): none', args: [f({ banned: undefined })], want: 'unknown' },
  ];
  const show = (v) => (v.send ? (v.first ? SEND_FIRST : SEND) : v.reason);
  // naive: a notice on every save, the first when nothing was sent before.
  const naive = (x) => (x.notifiedBefore ? SEND : SEND_FIRST);
  for (const v of vectors) {
    const got = show(piNoticeAllowed(...v.args));
    check('pi notice: ' + v.kind + ` (${got})`, got === v.want);
    const n = naive(...v.args);
    if (v.alsoNaive) check('pi notice: ' + v.kind + ' (naive agrees)', n === v.want);
    else check('pi notice: ' + v.kind + ' fails against naive (can fail)', n !== v.want);
  }
  check('pi notice: the window is 10 minutes and the caps are 5 and 30',
    PI_NOTICE_THROTTLE_MS === 600_000 && PI_NOTICE_OWNER_DAILY === 5 && PI_NOTICE_GLOBAL_DAILY === 30);

  // piSecondNotifyMs: a test may shorten the wait only toward a loopback stub.
  check('second pubnotify: the real API ignores the variable', piSecondNotifyMs('0', false) === PI_SECOND_NOTIFY_MS);
  check('second pubnotify: a stub with no variable waits the real time', piSecondNotifyMs(undefined, true) === PI_SECOND_NOTIFY_MS);
  check('second pubnotify: a stub takes the test value', piSecondNotifyMs('1000', true) === 1000 && piSecondNotifyMs('0', true) === 0);
  check('second pubnotify: never longer than the real wait', piSecondNotifyMs('999999', true) === PI_SECOND_NOTIFY_MS);
  check('second pubnotify: junk is the real wait', piSecondNotifyMs('-5', true) === PI_SECOND_NOTIFY_MS && piSecondNotifyMs('1e3', true) === PI_SECOND_NOTIFY_MS);

  // piFeedIdFrom: PI's lookup answers, recorded from the wire (byguid holds an object,
  // a miss is `feed: []`; byfeedurl's miss is a 400 with no feed).
  const idVectors = [
    { kind: 'byguid, listed', body: { status: 'true', feed: { id: 8125553, podcastGuid: 'x', medium: 'musicL' }, description: 'Found matching feed.' }, want: 8125553 },
    { kind: 'an array feed', body: { status: 'true', feed: [{ id: 7536878 }] }, want: 7536878 },
    { kind: 'byguid, not listed (feed: [])', body: { status: 'true', feed: [], description: 'No feeds match this guid.' }, want: null },
    { kind: 'byfeedurl, not listed (400 body)', body: { status: 'false', description: 'Feed url not found.' }, want: null },
    { kind: 'id 0', body: { status: 'true', feed: { id: 0 } }, want: null },
    { kind: 'an id as a string', body: { status: 'true', feed: { id: '8125553' } }, want: null },
    { kind: 'a negative id (our RSS fallbacks mint those)', body: { feed: { id: -5 } }, want: null },
    { kind: 'not an object', body: 'Feed url not found.', want: null },
    { kind: 'null', body: null, want: null },
  ];
  for (const v of idVectors) check('pi feed id: ' + v.kind, piFeedIdFrom(v.body) === v.want);
  check('pi feed id: the add form is PI\'s own page', PI_ADD_FORM === 'https://podcastindex.org/add');

  // The source: no add/byfeedurl call, and the pubnotify carries no key headers.
  const src = readFileSync(new URL('../lib/community/pi-notify.ts', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('pi-notify: no add/byfeedurl request in the code', !/add\/byfeedurl/.test(code));
  const body = /async function pubnotify\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
  check('pi-notify: pubnotify sends a User-Agent and no key headers', body.includes("'User-Agent'") && !/authHeaders|X-Auth|Authorization/i.test(body));
}

// localTarget — the app server and the database an e2e script that WRITES playlists
// may use (scripts/local-target.mjs). Beta submits every playlist it stores to Podcast
// Index and Hive, for good, so a test aimed at it makes a permanent public feed:
// loopback names only, and a postgres URL may not carry a host parameter that pg
// would connect to instead.
{
  const vectors = [
    { kind: 'app: the default dev server', args: ['http://localhost:3123', 'app'], want: 'http://localhost:3123', alsoNaive: true },
    { kind: 'app: a trailing slash is dropped', args: ['http://localhost:3123/', 'app'], want: 'http://localhost:3123', alsoNaive: true },
    { kind: 'app: 127.0.0.1', args: ['http://127.0.0.1:3000', 'app'], want: 'http://127.0.0.1:3000', alsoNaive: true },
    { kind: 'app: [::1]', args: ['http://[::1]:3000', 'app'], want: 'http://[::1]:3000', alsoNaive: true },
    { kind: 'app: beta is refused', args: ['https://beta.boostmebitch.com', 'app'], want: null },
    { kind: 'app: production is refused', args: ['https://www.boostmebitch.com', 'app'], want: null },
    { kind: 'app: the feed origin is refused', args: ['https://www.boostmebuddy.com', 'app'], want: null },
    { kind: "app: beta's Vercel branch URL is refused", args: ['https://boostmebitch-git-beta-chadfs-projects.vercel.app', 'app'], want: null },
    { kind: 'app: a DNS name that resolves to loopback is refused', args: ['http://127.0.0.1.nip.io:3123', 'app'], want: null },
    { kind: 'app: a name that starts with localhost is refused', args: ['http://localhost.example.com:3123', 'app'], want: null },
    { kind: 'app: userinfo hiding beta is refused', args: ['http://localhost@beta.boostmebitch.com', 'app'], want: null },
    { kind: 'app: a LAN address is refused', args: ['http://192.168.0.10:3000', 'app'], want: null },
    { kind: 'app: 0.0.0.0 is refused', args: ['http://0.0.0.0:3000', 'app'], want: null },
    { kind: 'app: a host with no scheme is refused', args: ['beta.boostmebitch.com', 'app'], want: null },
    { kind: 'app: another scheme on loopback is refused', args: ['ftp://localhost:3123', 'app'], want: null },
    { kind: 'app: empty is refused', args: ['', 'app'], want: null },
    { kind: 'db: the local test store', args: ['postgres://postgres:test@localhost:54329/postgres', 'db'], want: 'postgres://postgres:test@localhost:54329/postgres', alsoNaive: true },
    { kind: 'db: postgresql:// on 127.0.0.1', args: ['postgresql://u:p@127.0.0.1:5432/db', 'db'], want: 'postgresql://u:p@127.0.0.1:5432/db', alsoNaive: true },
    { kind: 'db: [::1]', args: ['postgres://u:p@[::1]:5432/db', 'db'], want: 'postgres://u:p@[::1]:5432/db', alsoNaive: true },
    { kind: 'db: a hosted store is refused', args: ['postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db?sslmode=require', 'db'], want: null },
    { kind: 'db: a host parameter overriding localhost is refused', args: ['postgres://u:p@localhost/db?host=db.example.com', 'db'], want: null },
    { kind: 'db: a hostaddr parameter is refused', args: ['postgres://u:p@localhost/db?hostaddr=203.0.113.5', 'db'], want: null },
    { kind: 'db: a socket path with no host is refused', args: ['postgres:///db?host=/tmp', 'db'], want: null },
    { kind: 'db: an http URL is refused', args: ['http://localhost:54329', 'db'], want: null },
  ];
  // The obvious wrong version, which every playlist script shipped: the value as written.
  const naive = (raw, kind) => (kind === 'app' ? raw.replace(/\/$/, '') : raw);
  for (const v of vectors) {
    check('local target: ' + v.kind, localTarget(...v.args) === v.want);
    const n = naive(...v.args);
    if (v.alsoNaive) check('local target: ' + v.kind + ' (naive agrees)', n === v.want);
    else check('local target: ' + v.kind + ' fails against naive (can fail)', n !== v.want);
  }
}

// addSong: the player's "+ PLAYLIST" collects into a local draft. A duplicate pair or a
// 501st song would make the maker's next SAVE fail on a problem the user did not cause
// there, so both are refused here. Replayed against naive(), which appends blindly.
{
  console.log('\naddSong');
  const naive = (list, s) => ({ songs: [...list, s], result: 'added' });
  const same = (a, b) => a.result === b.result && JSON.stringify(a.songs) === JSON.stringify(b.songs);
  const s1 = { feedGuid: 'F1', itemGuid: 'I1' };
  const vectors = [
    { name: 'adds to the end', args: [[{ feedGuid: 'F0', itemGuid: 'I0' }], s1],
      want: { result: 'added', songs: [{ feedGuid: 'F0', itemGuid: 'I0' }, s1] }, alsoNaive: true },
    { name: 'the same pair is not added twice', args: [[s1], { ...s1 }], want: { result: 'already', songs: [s1] } },
    { name: 'same item guid under ANOTHER feed is a different song', args: [[s1], { feedGuid: 'F2', itemGuid: 'I1' }],
      want: { result: 'added', songs: [s1, { feedGuid: 'F2', itemGuid: 'I1' }] }, alsoNaive: true },
    { name: 'no 501st song', args: [songs(MAX_SONGS), s1], want: { result: 'full', songs: songs(MAX_SONGS) } },
    { name: 'a client feedUrl is not copied', args: [[], { ...s1, feedUrl: 'https://evil.example/feed' }],
      want: { result: 'added', songs: [s1] } },
  ];
  for (const v of vectors) {
    const input = JSON.parse(JSON.stringify(v.args[0]));
    const got = addSong(...v.args);
    check(`addSong: ${v.name}`, same(got, v.want));
    check(`addSong: ${v.name} — input unchanged`, JSON.stringify(v.args[0]) === JSON.stringify(input));
    const n = naive(...v.args);
    const naiveAgrees = same(n, v.want);
    check(`addSong: ${v.name} — ${v.alsoNaive ? 'naive() still agrees' : 'fails against naive()'}`, naiveAgrees === !!v.alsoNaive);
  }
}

// songsAddedElsewhere: what the maker takes in from a draft slot that the player's
// "+ PLAYLIST" wrote behind it (PR #673's review: the maker's next edit wrote its own
// older list over the add, and the song was lost behind "✓ ADDED"). Two naive
// versions, each the shape a fix could take and be wrong:
// - makerWins(): what shipped. The maker's state is the truth, so nothing is taken in.
// - noBaseline(): everything on disk the maker does not show. A song the maker
//   removed while a stale disk still holds it comes back.
// Each vector names the naive versions it is ALSO right for (the must-still-work half).
{
  console.log('\nsongsAddedElsewhere');
  const makerWins = () => [];
  const noBaseline = (_seen, disk, cur) => disk.filter((s) => !cur.some((c) => c.feedGuid === s.feedGuid && c.itemGuid === s.itemGuid));
  const A = { feedGuid: 'FA', itemGuid: 'IA' };
  const B = { feedGuid: 'FB', itemGuid: 'IB' };
  const C = { feedGuid: 'FC', itemGuid: 'IC' };
  const vectors = [
    { name: 'a song added behind the maker is taken in', args: [[A, B], [A, B, C], [A, B]], want: [C], also: ['noBaseline'] },
    { name: 'a song removed in the maker, still on a stale disk, does not come back', args: [[A, B], [A, B], [A]], want: [], also: ['makerWins'] },
    { name: 'removed, written, then added again by the sheet: kept', args: [[A], [A, B], [A]], want: [B], also: ['noBaseline'] },
    { name: 'a song already on screen is not doubled', args: [[A], [A, B], [A, B]], want: [], also: ['makerWins', 'noBaseline'] },
    { name: 'a pair twice on disk comes in once', args: [[], [C, C], []], want: [C], also: [] },
    { name: 'the same item guid under ANOTHER feed is a different song', args: [[A], [A, { feedGuid: 'FX', itemGuid: 'IA' }], [A]],
      want: [{ feedGuid: 'FX', itemGuid: 'IA' }], also: ['noBaseline'] },
    { name: 'disk order is kept', args: [[A], [A, C, B], [A]], want: [C, B], also: ['noBaseline'] },
    { name: 'the maker wrote its own add: nothing new', args: [[A, B], [A, B], [A, B]], want: [], also: ['makerWins', 'noBaseline'] },
  ];
  const naives = { makerWins, noBaseline };
  for (const v of vectors) {
    const before = JSON.stringify(v.args);
    const got = songsAddedElsewhere(...v.args);
    check(`songsAddedElsewhere: ${v.name}`, JSON.stringify(got) === JSON.stringify(v.want));
    check(`songsAddedElsewhere: ${v.name} — inputs unchanged`, JSON.stringify(v.args) === before);
    for (const [n, f] of Object.entries(naives)) {
      const agrees = JSON.stringify(f(...v.args)) === JSON.stringify(v.want);
      const claimed = v.also.includes(n);
      check(`songsAddedElsewhere: ${v.name} — ${claimed ? `${n}() still agrees` : `fails against ${n}()`}`, agrees === claimed);
    }
  }
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall ok');
