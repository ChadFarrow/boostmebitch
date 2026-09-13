// Pins the three pure decisions the downloads feature rests on.
//
// Usage:
//   npm run check:downloads
//
// Run it after ANY edit to lib/downloads/download-rules.ts.
//
// Why this earns a check script. Downloads spend the listener's bandwidth and
// then sit on their disk, and all three of these fail SILENTLY.
//
// `downloadKey` is the contract between the two halves of the feature: the key
// derived when the bytes are saved must equal the key derived when the player
// looks for them. Get it wrong and the download completes, the button turns
// green, the bytes are really on disk — and playback never finds them. Nothing
// errors. The listener pays for the file twice, and the second time they are on
// the connection they downloaded it to avoid.
//
// `isDownloadable` is the refusal. An HLS `.m3u8` is a manifest, not a file:
// downloading it stores a few hundred bytes of playlist and calls it an
// episode. The failure is a green tick over nothing.
//
// `roomVerdict` is the one with a blast radius outside this feature. The
// obvious version — usage + bytes <= quota — is wrong twice, and both are
// measured behaviours rather than hypotheticals. It fills the origin to the
// brim, and this origin's localStorage holds the wallet credential and the
// favorites baseline; CLAUDE.md's storage rules exist because a full store on
// iOS Safari makes every later write fail, down to a one-byte setting, while
// reads keep working so nothing else looks wrong. And it answers 'no' when
// `navigator.storage.estimate()` is simply unavailable, which is a DEAD BUTTON
// on the device this app is mostly listened on rather than a refusal.
//
// So the decisions live in an import-free module and this script imports the
// REAL one under `--experimental-strip-types`. A reimplemented copy here would
// stay green while the shipping code drifted.
//
// EVERY VECTOR IS A RECORDED CALL, NOT A BARE ASSERTION. The `naive*` functions
// at the foot are the obvious wrong versions, and the whole list is replayed
// against them, because a vector that passes the moment it is written has
// proved nothing. Exemptions are named one at a time with `alsoNaive: true` —
// the must-still-work half, where over-blocking would be its own regression.
//
// THE VECTORS COME FROM THE WIRE. Every URL below was fetched on 2026-09-09 and
// answered 200 with `Accept-Ranges: bytes`, and each sent an
// `Access-Control-Allow-Origin` header — which is what a plain `fetch()` needs
// and an `<audio src>` does not, and is why this feature needs no audio proxy.
// A fixture invented from the struct cannot carry the shapes nobody thinks to
// invent: the double redirect, the `.wav`, the query string that is part of the
// signature.

import { chaptersRequestUrl, downloadKey, isDownloadable, roomVerdict, transcriptRequestUrl } from '../lib/downloads/download-rules.ts';
import { isHlsUrl } from '../lib/util.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';
import { replayVectors } from './replay-vectors.mjs';

let failures = 0;

/** Every recorded call, replayed against the wrong implementations below. */
const vectors = [];

function compare(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${label}`); return; }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
}

/** A downloadKey vector. `alsoNaive` marks a must-still-work input. */
function checkKey(label, input, expected, { alsoNaive = false } = {}) {
  compare(label, downloadKey(input), expected);
  vectors.push({ label, kind: 'key', args: [input], alsoNaive });
}

/** An isDownloadable vector. */
function checkDl(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, isDownloadable(...args), expected);
  vectors.push({ label, kind: 'dl', args, alsoNaive });
}

/** A doc-URL vector. `kind` picks which builder. */
function checkDoc(label, kind, args, expected, { alsoNaive = false } = {}) {
  compare(label, (kind === 'chapters' ? chaptersRequestUrl : transcriptRequestUrl)(...args), expected);
  vectors.push({ label, kind, args, alsoNaive });
}

/** A roomVerdict vector. */
function checkRoom(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, roomVerdict(...args), expected);
  vectors.push({ label, kind: 'room', args, alsoNaive });
}

function section(name) { console.log(`\n${name}`); }

// Measured 2026-09-09.
const HGH = 'https://feed.homegrownhits.xyz/assets/episodes/episode-149.mp3';
const PODTRAC = 'https://www.podtrac.com/pts/redirect.mp3/pdst.fm/e/pscrb.fm/rss/p/mgln.ai/e/257/traffic.megaphone.fm/VMP6399424177.mp3';
const SIMPLECAST = 'https://dts.podtrac.com/redirect.mp3/pdst.fm/e/pfx.vpixl.com/6qj4J/pscrb.fm/rss/p/nyt.simplecastaudio.com/03d8b493-87fc-4bd1-931f-8a8e9b945d8a/episodes/5660b118-2266-4c84-97ce-180d41d2e172/audio/128/default.mp3?aid=rss_feed&awEpisodeId=5660b118-2266-4c84-97ce-180d41d2e172&feed=54nAGcIl';
// 53,523,520 bytes for ONE track. The size warning exists because of this URL.
const WAV = 'https://feeds.fountain.fm/1N6xa5VJEYtIiIpn2DLp/items/hjqw6AqpkDudvX3HxFks/files/AUDIO---DEFAULT---10d80388-6230-4d0e-a244-53394c4ab58a.wav';

// The endless icecast stream that Homegrown Hits episode 150 pointed at while
// its <podcast:liveItem> was `pending`. It ends in `.mp3` and answers 200, so
// nothing about the URL says "not a file" — only the liveStatus does.
const LIVE_STREAM = 'https://stream.bowlafterbowl.com/listen/bowlafterbowl/stream.mp3';

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
section('A real enclosure URL is its own key, unchanged');
// ---------------------------------------------------------------------------
{
  // The overwhelming majority. If normalization touched these it would be
  // rewriting URLs the host is about to serve.
  checkKey('a self-hosted mp3', HGH, HGH, { alsoNaive: true });
  checkKey('a .wav', WAV, WAV, { alsoNaive: true });
  // NOT unwrapped. A Podtrac prefix is part of the URL the host serves, and a
  // signed CDN URL underneath one is not ours to rewrite.
  checkKey('a Podtrac redirect is kept whole', PODTRAC, PODTRAC, { alsoNaive: true });
  // The query string is load-bearing here: it can carry the signature.
  checkKey('a double redirect with a query string is kept whole', SIMPLECAST, SIMPLECAST, { alsoNaive: true });
}

// ---------------------------------------------------------------------------
section('...and the normalizations are the ones that change no bytes on the wire');
// ---------------------------------------------------------------------------
{
  // A feed that writes http: and a feed that writes https: name one file. The
  // app is https-only, so the http form would fail anyway.
  checkKey('http is upgraded to https', HGH.replace('https:', 'http:'), HGH);
  // A fragment is never sent to the server, so two URLs differing only by one
  // are the same resource and must not download twice.
  checkKey('a fragment is dropped', `${HGH}#t=30`, HGH);
  checkKey('an empty fragment is dropped', `${HGH}#`, HGH);
  // Copy-paste, and feed writers who indent their XML inside the attribute.
  // Exempt: trimming is the ONE thing the naive version does, so it gets this
  // right by construction. Tolerating the whitespace is still a requirement —
  // an indented enclosure attribute is common — so the vector stays.
  checkKey('surrounding whitespace goes', `\n  ${HGH} \t`, HGH, { alsoNaive: true });
  // A literal space is illegal in a URL and fetch() encodes it anyway — so the
  // key must encode it too, or the save key and the play key disagree.
  checkKey('a literal space is encoded', 'https://ex.com/a b.mp3', 'https://ex.com/a%20b.mp3');
}

// ---------------------------------------------------------------------------
section('...and nothing that is not a fetchable URL becomes a key');
// ---------------------------------------------------------------------------
{
  checkKey('undefined', undefined, null);
  checkKey('null', null, null);
  checkKey('the empty string', '', null);
  checkKey('whitespace only', '   ', null);
  // A relative path has no host to fetch from.
  checkKey('a relative path', '/episodes/1.mp3', null);
  // None of these is an enclosure, and each would be a problem to hand to
  // fetch(): a blob: URL is already local, and the other two are not fetches.
  checkKey('a data: URL', 'data:audio/mpeg;base64,AAAA', null);
  checkKey('a blob: URL', 'blob:https://boostmebitch.com/abc', null);
  checkKey('a javascript: URL', 'javascript:alert(1)', null);
}

// ---------------------------------------------------------------------------
section('downloadKey is IDEMPOTENT — the save key equals the play key');
// ---------------------------------------------------------------------------
{
  // The one property the whole feature rests on. A key that changes when it is
  // re-derived makes a download that exists and can never be found.
  // `alsoNaive` marks the three URLs that arrive already canonical: nothing is
  // rewritten on the first pass, so re-deriving trivially agrees and even the
  // naive version is idempotent on them. They are still the must-still-work
  // half — the common case has to hold — and the three below them, where a byte
  // really does change on the first pass, are what prove the property.
  for (const [name, url, alsoNaive] of [
    ['a self-hosted mp3', HGH, true],
    ['a double redirect', SIMPLECAST, true],
    ['a .wav', WAV, true],
    ['an http URL', HGH.replace('https:', 'http:'), false],
    ['a URL with a fragment', `${HGH}#t=30`, false],
    ['a URL with a space', 'https://ex.com/a b.mp3', false],
  ]) {
    const once = downloadKey(url);
    compare(`${name} re-derives to itself`, downloadKey(once), once);
    vectors.push({ label: `idempotent: ${name}`, kind: 'idem', args: [url], alsoNaive });
  }
}

// ---------------------------------------------------------------------------
section('isDownloadable accepts a real file');
// ---------------------------------------------------------------------------
{
  checkDl('an mp3', [HGH], true, { alsoNaive: true });
  checkDl('a wav', [WAV], true, { alsoNaive: true });
  checkDl('a Podtrac redirect', [PODTRAC], true, { alsoNaive: true });
  checkDl('a query-string URL', [SIMPLECAST], true, { alsoNaive: true });
  checkDl('an m4a', ['https://ex.com/ep.m4a'], true, { alsoNaive: true });
  // No extension at all is ordinary — plenty of hosts serve audio off a path
  // with none. Refusing it would be over-blocking.
  checkDl('a URL with no extension', ['https://ex.com/download/1234'], true, { alsoNaive: true });
}

// ---------------------------------------------------------------------------
section('...and refuses what cannot be a file');
// ---------------------------------------------------------------------------
{
  // A manifest, not a file. Downloading it stores a playlist and reports success.
  checkDl('an HLS manifest', ['https://ex.com/live/stream.m3u8'], false);
  checkDl('an HLS manifest with a query', ['https://ex.com/live/stream.m3u8?token=x'], false);
  checkDl('an HLS manifest with a fragment', ['https://ex.com/live/stream.m3u8#x'], false);
  checkDl('an uppercase HLS manifest', ['https://ex.com/live/STREAM.M3U8'], false);
  // EVERY `<podcast:liveItem>`, whatever its status. Measured 2026-09-09:
  // Homegrown Hits episode 150 sat at `pending` pointing at
  // stream.bowlafterbowl.com/listen/bowlafterbowl/stream.mp3 — an ENDLESS
  // icecast stream. Refusing only 'live' let the download button offer it, and
  // an endless source sends no Content-Length, so nothing downstream could size
  // it either. This is the vector that bug produced.
  checkDl('a live item', [HGH, 'live'], false);
  checkDl('a PENDING live item', [HGH, 'pending'], false);
  // 'ended' is refused too, and that is the deliberate direction to be wrong in:
  // refusing one costs a single episode, allowing one costs a download that
  // never finishes. A publisher who keeps the recording republishes it as an
  // ordinary <item>, which has no liveStatus and is accepted above.
  checkDl('an ENDED live item', [HGH, 'ended'], false);
  checkDl('an unknown live status', [HGH, 'whatever'], false);
  // Exempt: a null check is precisely what the naive version IS, so it cannot
  // get this wrong. "No URL, no button" is still a requirement worth stating.
  // The URL alone cannot save you: it ends in .mp3 and it is a real 200. The
  // status is the only signal, which is why the status test has to be total.
  checkDl('an endless stream URL with no status looks downloadable', [LIVE_STREAM], true, { alsoNaive: true });
  checkDl('...and is refused once its live status is known', [LIVE_STREAM, 'pending'], false);
  checkDl('nothing at all', [undefined], false, { alsoNaive: true });
  checkDl('a relative path', ['/ep.mp3'], false);
}

// ---------------------------------------------------------------------------
section('roomVerdict allows when it does not know');
// ---------------------------------------------------------------------------
{
  // navigator.storage.estimate() is absent on older iOS — the device this app
  // is mostly listened on. Refusing here is a button that does nothing, with no
  // explanation, on exactly the platform the feature is for. Let a real
  // QuotaExceededError be the answer instead.
  checkRoom('no estimate at all', [null, 10 * MB], 'unknown');
  checkRoom('an estimate with no quota', [{ usage: 0 }, 10 * MB], 'unknown');
  checkRoom('an estimate with a zero quota', [{ usage: 0, quota: 0 }, 10 * MB], 'unknown');
  // The feed gave no length and no Content-Length arrived. We cannot decide.
  checkRoom('an unknown size', [{ usage: 0, quota: 1000 * MB }, null], 'unknown');
  checkRoom('a zero size', [{ usage: 0, quota: 1000 * MB }, 0], 'unknown');
}

// ---------------------------------------------------------------------------
section('...and leaves headroom, because a full origin breaks more than downloads');
// ---------------------------------------------------------------------------
{
  // The must-still-work half, and it is the larger half in practice: an
  // ordinary download onto a device with room must go ahead. Headroom that
  // refused these would be worse than no headroom at all. Naturally the naive
  // version agrees about them — that is what makes them the common case rather
  // than evidence — so all four are exempt, deliberately.
  checkRoom('50 MB into a 1 GB quota', [{ usage: 0, quota: 1000 * MB }, 50 * MB], 'yes', { alsoNaive: true });
  checkRoom('50 MB beside 500 MB used', [{ usage: 500 * MB, quota: 1000 * MB }, 50 * MB], 'yes', { alsoNaive: true });
  // Over the quota outright. Exempt for the mirror reason: under-blocking here
  // is a regression too, and the arithmetic is obvious enough that the naive
  // version also refuses. The vectors below are where the two part company.
  checkRoom('600 MB into 500 MB left', [{ usage: 500 * MB, quota: 1000 * MB }, 600 * MB], 'no', { alsoNaive: true });
  // THE ONE THAT MATTERS. It fits arithmetically and must still be refused:
  // filling the origin to the brim is what makes every later localStorage write
  // fail, and this origin's localStorage holds the wallet credential and the
  // favorites baseline. The naive version says yes.
  checkRoom('a download that exactly fills the quota', [{ usage: 900 * MB, quota: 1000 * MB }, 100 * MB], 'no');
  checkRoom('a download leaving only 10 MB', [{ usage: 900 * MB, quota: 1000 * MB }, 90 * MB], 'no');
  // The headroom is a floor AND a fraction: on a small quota a flat reserve
  // would refuse everything, and on a huge one a fraction is the more honest
  // reserve. 53 MB is the real .wav above.
  checkRoom('a 53 MB track into a 200 MB quota', [{ usage: 0, quota: 200 * MB }, 53 * MB], 'yes', { alsoNaive: true });
  checkRoom('a 53 MB track into a 60 MB quota', [{ usage: 0, quota: 60 * MB }, 53 * MB], 'no');
  // The fraction's job: a flat floor alone would allow this, because 64 MB of
  // headroom against a 40 GB quota is not a reserve. Exempt because it is the
  // must-still-work direction — 5% of 40 GB still leaves room for 1 GB.
  checkRoom('1 GB into a 40 GB quota with 30 GB used', [{ usage: 30000 * MB, quota: 40000 * MB }, 1000 * MB], 'yes', { alsoNaive: true });
  // ...and the same quota with the fraction actually binding. A flat 64 MB
  // floor would say yes here; 5% of 40 GB is 2 GB, so this is refused.
  checkRoom('3 GB into a 40 GB quota with 36 GB used', [{ usage: 36000 * MB, quota: 40000 * MB }, 3000 * MB], 'no');
}

// ---------------------------------------------------------------------------
section('The document request URLs are built ONCE, because the key IS the string');
// ---------------------------------------------------------------------------
{
  // `useChapters` builds this URL to FETCH and the download builds it to CACHE,
  // and the cache is keyed by the URL — so the two agreeing character for
  // character is the whole feature. A copy on each side is the shape that broke
  // StableKraft's downloads: its proxy-first and direct-first domain lists were
  // hand-mirrored and drifted to 16 entries against 14, and the symptom was
  // "streams fine, won't download". Here the symptom would be quieter still —
  // every download silently re-fetching its chapters.
  const DOC = 'https://feed.homegrownhits.xyz/assets/chapters/149.json';
  checkDoc('a chapters document', 'chapters', [DOC], `/api/chapters?url=${encodeURIComponent(DOC)}`);
  checkDoc('no chapters url', 'chapters', [undefined], null);
  checkDoc('an empty chapters url', 'chapters', [''], null);

  const T = 'https://feed.homegrownhits.xyz/assets/transcripts/149.srt';
  // The TYPE is part of the request, so it is part of the key. Dropping it here
  // would write one cache entry and read another.
  checkDoc('a transcript with a type', 'transcript', [T, 'application/x-subrip'],
    `/api/transcript?url=${encodeURIComponent(T)}&type=${encodeURIComponent('application/x-subrip')}`);
  checkDoc('a transcript with no type', 'transcript', [T], `/api/transcript?url=${encodeURIComponent(T)}`);
  checkDoc('no transcript url', 'transcript', [undefined], null);

  // A real document URL carries its own query string, and appending to it
  // rather than encoding it would change the UPSTREAM request instead of ours —
  // the same trap `artProxyUrl` documents.
  const Q = 'https://ex.com/ch.json?token=a&b=c';
  checkDoc('a document url with its own query string is encoded whole', 'chapters', [Q],
    `/api/chapters?url=${encodeURIComponent(Q)}`);
}

// ---------------------------------------------------------------------------
section("The HLS refusal AGREES with lib/util.ts, which is the app's one answer");
// ---------------------------------------------------------------------------
{
  // download-rules.ts is import-free, so it cannot call isHlsUrl and has to
  // carry its own test. That is a second copy, and a second copy drifts. This
  // section is the guard: the two must never disagree about a URL. If it fails,
  // isHlsUrl moved — change download-rules.ts to match, not this list.
  const urls = [
    HGH, WAV, PODTRAC, SIMPLECAST,
    'https://ex.com/live/stream.m3u8',
    'https://ex.com/live/stream.m3u8?token=x',
    'https://ex.com/live/stream.m3u8#x',
    'https://ex.com/live/STREAM.M3U8',
    'https://ex.com/ep.m4a',
    // The near-misses that separate a real test from `includes('.m3u8')`.
    'https://ex.com/notes-about-m3u8-files.mp3',
    'https://ex.com/ep.mp3?next=stream.m3u8',
  ];
  let disagreed = 0;
  for (const u of urls) {
    // isDownloadable refuses HLS and nothing else about these URLs, so its
    // negation is the same question isHlsUrl answers.
    if (isDownloadable(u) === isHlsUrl(u)) {
      disagreed += 1;
      failures += 1;
      console.error(`  FAIL  download-rules.ts and isHlsUrl disagree about ${u}`);
    }
  }
  if (!disagreed) console.log(`  ok    ${urls.length} URL(s), and the two copies agree on every one`);
}

// ---------------------------------------------------------------------------
section('Every vector above is replayed against the obvious wrong version');
// ---------------------------------------------------------------------------
{
  // What someone writes when the key looks like string tidying: trim it, ship
  // it. Right on the four URLs that were already canonical, wrong on every one
  // that is not — and it never returns null, so `undefined` becomes the string
  // "undefined" and a data: URL becomes a key.
  const naiveKey = (raw) => String(raw ?? '').trim();

  // What someone writes when the refusal looks like a null check.
  const naiveDl = (url) => !!url;

  // What someone writes when the quota looks like arithmetic: subtract and
  // compare. It says yes to a download that fills the origin to the last byte,
  // and no to every download on a device that cannot estimate.
  const naiveRoom = (est, bytes) =>
    est && est.quota && est.usage + bytes <= est.quota ? 'yes' : 'no';

  // What someone writes inline at one of the two call sites: concatenate, don't
  // encode, and don't handle an absent URL. It differs on the query-string case
  // and returns the string "undefined" for a missing document.
  const naiveDoc = (url, type) =>
    type ? `/api/transcript?url=${url}&type=${type}` : `/api/chapters?url=${url}`;

  const call = (impl, v) => {
    try {
      const real = impl === 'real';
      switch (v.kind) {
        case 'key': return JSON.stringify(real ? downloadKey(...v.args) : naiveKey(...v.args));
        case 'dl': return JSON.stringify(real ? isDownloadable(...v.args) : naiveDl(...v.args));
        case 'room': return JSON.stringify(real ? roomVerdict(...v.args) : naiveRoom(...v.args));
        case 'chapters': return JSON.stringify(real ? chaptersRequestUrl(...v.args) : naiveDoc(...v.args));
        case 'transcript': return JSON.stringify(real ? transcriptRequestUrl(...v.args) : naiveDoc(...v.args));
        case 'idem': {
          // The property, not the value: does re-deriving change the answer?
          const f = real ? downloadKey : naiveKey;
          const once = f(...v.args);
          return JSON.stringify([once, f(once)]);
        }
        default: throw new Error(`unknown vector kind ${v.kind}`);
      }
      // A wrong implementation is allowed to throw where the real one returns.
      // That still counts as differing — it is the loudest way to be wrong.
    } catch (e) {
      return `threw ${(e && e.message) || e}`;
    }
  };

  // THE SHARED REPLAY. See `scripts/replay-vectors.mjs` — an
  // `{ alsoNaive: true }` vector used to have its `differs` result discarded, so
  // the exemption hid exactly what it was granted to protect.
  replayVectors({ vectors, invoke: call, fail: (msg) => { failures += 1; console.error(`  FAIL  ${msg}`); } });
}

// ---------------------------------------------------------------------------
console.log('\ndownload-rules.ts stays loadable under plain Node');
// ---------------------------------------------------------------------------
{
  // The arrangement this whole script depends on: it imports the REAL module,
  // so the module must keep resolving under `node --experimental-strip-types`.
  // It is also WHY the HLS test is duplicated above — see that section.
  const problems = importFreeProblems('lib/downloads/download-rules.ts');
  if (problems.length) { explainImportFree('lib/downloads/download-rules.ts', problems); failures += problems.length; }
  else console.log('  ok    lib/downloads/download-rules.ts has no imports that plain Node cannot resolve');
}

if (failures) {
  console.error(`\n${failures} downloads check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll downloads checks passed.');
