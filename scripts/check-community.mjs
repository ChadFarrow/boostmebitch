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
import { npubEncode } from 'nostr-tools/nip19';
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
// Only the escaping vectors must fail against the naive builder.
for (const v of docVectors.filter((x) => ['items', 'title well-formed'].includes(x.kind))) {
  let passes;
  try { passes = v.test(v.build(naiveBuild)); } catch { passes = false; }
  check('feed doc: ' + v.kind + ' fails against naive (can fail)', !passes);
}
check('escapeXml', escapeXml(`&<>"'`) === '&amp;&lt;&gt;&quot;&apos;');

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall ok');
