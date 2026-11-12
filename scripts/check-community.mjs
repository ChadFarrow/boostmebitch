// Pins the community-playlist rules: validatePlaylistDraft, artVerdict, cleanText
// and the feed URL helpers in lib/curated-playlists.ts. Imports the real modules.
import {
  COMMUNITY_FEED_ORIGIN, COMMUNITY_FEED_PATH, COMMUNITY_PLAYLISTS_ON,
  communityFeedUrl, communityCoverUrl, communityIdFromFeedUrl, coverVersion,
} from '../lib/curated-playlists.ts';
import { validatePlaylistDraft, artVerdict } from '../lib/community/rules.ts';
import { cleanText } from '../lib/community/clean-text.ts';
import {
  escapeXml, communityFeedGuid, buildPlaylistFeedXml,
} from '../lib/community/feed-doc.ts';
import { channelSlice, parsePlaylistRemoteItems, parseFeedNpubs, decodeXmlText } from '../lib/feed-xml.ts';
import { npubEncode, noteEncode, nprofileEncode, nsecEncode } from 'nostr-tools/nip19';
import { bech32 } from '@scure/base';
import { generateSecretKey, finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { getToken, validateEventMethodTag } from 'nostr-tools/nip98';
import { verifyNip98, adminPubkeys, authMessage } from '../lib/community/auth.ts';
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
]) {
  const p = importFreeProblems(f, opts);
  if (p.length) { explainImportFree(f, p); failed++; } else ok(f + ' import-free');
}

const songs = (n) => Array.from({ length: n }, (_, i) => ({ feedGuid: 'f' + i, itemGuid: 'i' + i }));
const draft = (o = {}) => ({ title: 'T', description: '', artUrl: '', songs: songs(10), ...o });
const kinds = (r) => (r.ok ? [] : r.problems.map((p) => p.kind));

let r = validatePlaylistDraft({ title: '  ', description: '', artUrl: '', songs: [] });
check('blank title + no songs', !r.ok && kinds(r).includes('title-missing')
  && r.problems.some((p) => p.kind === 'too-few-songs' && p.have === 0));
r = validatePlaylistDraft(draft({ songs: songs(9) }));
check('9 songs too few', !r.ok && r.problems.some((p) => p.kind === 'too-few-songs' && p.have === 9));
check('10 songs ok', validatePlaylistDraft(draft()).ok);
check('500 songs ok', validatePlaylistDraft(draft({ songs: songs(500) })).ok);
r = validatePlaylistDraft(draft({ songs: songs(501) }));
check('501 songs too many', !r.ok && r.problems.some((p) => p.kind === 'too-many-songs' && p.have === 501));
r = validatePlaylistDraft(draft({ songs: [...songs(10), { feedGuid: 'f0', itemGuid: 'i0' }] }));
check('duplicate song', !r.ok && r.problems.some((p) => p.kind === 'duplicate-song' && p.itemGuid === 'i0'));
check('same itemGuid, other feed is not a duplicate',
  validatePlaylistDraft(draft({ songs: [...songs(10), { feedGuid: 'other', itemGuid: 'i0' }] })).ok);
check('http art refused', kinds(validatePlaylistDraft(draft({ artUrl: 'http://x/a.png' }))).includes('art-not-https'));
r = validatePlaylistDraft(draft({ artUrl: '' }));
check('empty art -> null', r.ok && r.draft.artUrl === null);
r = validatePlaylistDraft(draft({ artUrl: 'https://x/a.png' }));
check('https art kept', r.ok && r.draft.artUrl === 'https://x/a.png');
check('121-char title', kinds(validatePlaylistDraft(draft({ title: 'a'.repeat(121) }))).includes('title-too-long'));
check('120-char title ok', validatePlaylistDraft(draft({ title: 'a'.repeat(120) })).ok);
check('120-emoji title ok', validatePlaylistDraft(draft({ title: '😀'.repeat(120) })).ok);
check('121-emoji title refused', kinds(validatePlaylistDraft(draft({ title: '😀'.repeat(121) }))).includes('title-too-long'));
check('1001-char description', kinds(validatePlaylistDraft(draft({ description: 'a'.repeat(1001) }))).includes('description-too-long'));
check('1000-emoji description ok', validatePlaylistDraft(draft({ description: '😀'.repeat(1000) })).ok);
r = validatePlaylistDraft(draft({ title: '  Hi  ', description: ' d ' }));
check('trims', r.ok && r.draft.title === 'Hi' && r.draft.description === 'd');
r = validatePlaylistDraft(draft({ songs: [{ feedGuid: '', itemGuid: 'x' }, ...songs(10)] }));
check('empty feedGuid is bad-song index 0', !r.ok && r.problems.some((p) => p.kind === 'bad-song' && p.index === 0));
r = validatePlaylistDraft(draft({ songs: [...songs(10), { feedGuid: 'f', itemGuid: 'x'.repeat(2049) }] }));
check('long itemGuid bad-song', !r.ok && r.problems.some((p) => p.kind === 'bad-song' && p.index === 10));
r = validatePlaylistDraft(draft({ songs: [...songs(10), { feedGuid: 'f'.repeat(121), itemGuid: 'x' }] }));
check('long feedGuid bad-song', !r.ok && r.problems.some((p) => p.kind === 'bad-song' && p.index === 10));
r = validatePlaylistDraft(draft({ songs: [{ feedGuid: 'a', itemGuid: 'b', feedUrl: 'javascript:1' }, ...songs(9)] }));
check('non-http feedUrl dropped', r.ok && r.draft.songs[0].feedUrl === undefined);
r = validatePlaylistDraft(draft({ songs: [{ feedGuid: 'a', itemGuid: 'b', feedUrl: 'https://x/f.xml' }, ...songs(9)] }));
check('https feedUrl kept', r.ok && r.draft.songs[0].feedUrl === 'https://x/f.xml');
check('garbage rejected', !validatePlaylistDraft(null).ok && !validatePlaylistDraft('x').ok);
r = validatePlaylistDraft({ title: 5, description: 5, artUrl: 5, songs: 'x' });
check('wrong types report problems', !r.ok && r.problems.length > 0);

const A = (o) => artVerdict(o);
check('png 1400 ok', A({ format: 'png', width: 1400, height: 1400, hasAlpha: false }).ok);
check('jpeg 3000 ok', A({ format: 'jpeg', width: 3000, height: 3000 }).ok);
check('1399 too-small', A({ format: 'jpeg', width: 1399, height: 1399 }).reason === 'too-small');
check('3001 too-large', A({ format: 'jpeg', width: 3001, height: 3001 }).reason === 'too-large');
check('1400x1500 not-square', A({ format: 'jpeg', width: 1400, height: 1500 }).reason === 'not-square');
check('webp format', A({ format: 'webp', width: 1400, height: 1400 }).reason === 'format');
check('png alpha', A({ format: 'png', width: 1400, height: 1400, hasAlpha: true }).reason === 'alpha');
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
  ownerNpub, fallbackDescription: 'Fallback & co',
};
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
  { kind: 'rfc822 lastBuildDate', build: (b) => b(stored, opts), test: (xml) =>
    xml.includes('<lastBuildDate>Thu, 12 Nov 2026 00:00:00 GMT</lastBuildDate>') },
  { kind: 'channel fields', build: (b) => b(stored, opts), test: (xml) =>
    xml.includes('xmlns:podcast="https://podcastindex.org/namespace/1.0"') && xml.includes('xmlns:itunes=')
    && xml.includes('<podcast:medium>musicL</podcast:medium>')
    && xml.includes(`<podcast:guid>${communityFeedGuid(opts.feedUrl)}</podcast:guid>`)
    && xml.includes(`<itunes:image href="${opts.coverUrl}"/>`)
    && xml.includes('<language>en</language>') },
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

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall ok');
