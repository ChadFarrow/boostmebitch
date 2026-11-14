// Pins the community-playlist rules: validatePlaylistDraft (with the secret-key test it is
// handed, textHoldsSecret), withIndexFeedUrls, artVerdict, cleanText, the feed document
// and the feed URL helpers in lib/curated-playlists.ts. Imports the real modules.
import {
  COMMUNITY_FEED_ORIGIN, COMMUNITY_FEED_PATH, COMMUNITY_PLAYLISTS_ON,
  communityFeedUrl, communityCoverUrl, communityIdFromFeedUrl, coverVersion,
} from '../lib/curated-playlists.ts';
import {
  validatePlaylistDraft, artVerdict, withIndexFeedUrls, MAX_PLAYLIST_BODY_BYTES, MAX_SONGS, MAX_URL_LEN,
} from '../lib/community/rules.ts';
import { textHoldsSecret, looksLikeSecretKey } from '../lib/nostr/npub-input.ts';
import { cleanText } from '../lib/community/clean-text.ts';
import {
  escapeXml, communityFeedGuid, buildPlaylistFeedXml, FEED_TEMPLATE_UPDATED_AT,
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
  updatedAt: '2026-11-12T00:00:00.000Z', title: TITLE, description: 'A & B <c>', artUrl: null, songs: docSongs,
};
const opts = {
  feedUrl: communityFeedUrl(id), coverUrl: communityCoverUrl(id, 1),
  ownerNpub, fallbackDescription: 'Fallback & co', podcastGuid: communityFeedGuid(communityFeedUrl(id)),
  generator: `${BRANDS.buddy.displayName} (${BRANDS.buddy.origin})`,
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
  { kind: 'no value/item/author', build: (b) => b(stored, opts), test: (xml) =>
    !/<podcast:value/.test(xml) && !/<item/.test(xml) && !/<itunes:author/.test(xml) },
  { kind: 'feedUrl only when known', build: (b) => b(stored, opts), test: (xml) =>
    (xml.match(/feedUrl=/g) ?? []).length === 1 && xml.includes('feedUrl="https://x.example/f.xml?a=1&amp;b=2"') },
  // lastBuildDate is the later of the row's updatedAt and FEED_TEMPLATE_UPDATED_AT, so a
  // template change reaches every feed's date and an edit after it still moves the date.
  { kind: 'rfc822 lastBuildDate: an older row shows the template date', build: (b) => b(stored, opts), test: (xml) =>
    xml.includes(`<lastBuildDate>${new Date(FEED_TEMPLATE_UPDATED_AT).toUTCString()}</lastBuildDate>`)
    && Date.parse(stored.updatedAt) < Date.parse(FEED_TEMPLATE_UPDATED_AT) },
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
for (const v of docVectors.filter((x) => ['items', 'title well-formed'].includes(x.kind))) {
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
  check('heardOn: with maker', j(heardOnLines(list, 'npub1maker', 'https://www.boostmebuddy.com')) ===
    j(['🎧 Heard on Road Trip by nostr:npub1maker', 'https://www.boostmebuddy.com/?podcast=list-g']));
  check('heardOn: without maker', j(heardOnLines(list, null, 'https://o.example')) ===
    j(['🎧 Heard on Road Trip', 'https://o.example/?podcast=list-g']));
  check('heardOn: no guid -> no link line', j(heardOnLines({ ...list, podcastGuid: undefined }, 'npub1m', 'https://o.example')) ===
    j(['🎧 Heard on Road Trip by nostr:npub1m']));
  check('heardOn: guid is URI-encoded', heardOnLines({ ...list, podcastGuid: 'a b&c' }, null, 'https://o.example')[1] === 'https://o.example/?podcast=a%20b%26c');
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall ok');
