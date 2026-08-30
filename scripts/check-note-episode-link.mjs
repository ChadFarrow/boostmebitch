#!/usr/bin/env node --experimental-strip-types --no-warnings
/**
 * Pins `episodeLinkInNote` (lib/util.ts) — which URL in a Nostr note's body is
 * the one that names the episode the note is tagged with.
 *
 * One function, two consequences, and they fail in opposite directions:
 *
 *   over-match  — a card unfurls under a note describing episode X while its
 *                 only outbound control goes somewhere else entirely. The card
 *                 carries PLAY, a favorite heart and BOOST, so "somewhere else"
 *                 is a link sitting inside a cluster of controls that spend
 *                 money on the thing the card NAMES. The two disagreeing is
 *                 invisible from the screen: both halves render perfectly.
 *   under-match — the note keeps a raw magenta URL and no card. Cosmetic, and
 *                 it is the safe direction, which is why the fallback tier below
 *                 refuses ambiguity rather than guessing at it.
 *
 * It also decides which URL is DELETED from the note body before render, so a
 * wrong answer here removes a link the author wrote and the card does not
 * replace.
 *
 * ── Why the vectors look like this ──────────────────────────────────────────
 *
 * Every tag array below is lifted verbatim from a real kind:1 pulled off
 * relay.damus.io / nos.lol / relay.fountain.fm on 2026-08-29 — 604 notes
 * matching the app's own global-feed filter (`#k: podcast:guid,
 * podcast:item:guid`). Building them from the parsed `DiscoveredNote` shape
 * instead would have been worthless: that shape drops the third slot of each
 * `i` tag, which is the entire input this function reads.
 *
 * What that sample actually contained, and why each number shaped a rule:
 *
 *   604  notes total
 *   353  carry at least one `i` tag URL hint
 *   291  carry a hint that also appears in the note's own body   → tier one
 *   370  carry a fountain.fm page URL in the body
 *    79  carry a fountain.fm page URL that NO hint matches       → tier two
 *
 * The 62-note gap between 353 and 291 is the thing that would not have been
 * invented: a hint is very often the RSS FEED URL rather than a web page —
 * `https://ableandthewolf.com/static/media/feed.xml`,
 * `https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU`,
 * `https://serve.podhome.fm/rss/<uuid>`. Those are correct NIP-73 and useless
 * as a link: unfurling one puts a card over a raw XML document. Requiring the
 * hint to appear in the BODY excludes them for free, because a note that links
 * its own feed XML in its text is not a thing that happens.
 *
 * `feeds.fountain.fm` is the vector that decides the shape of the host test.
 * It is a fountain.fm SUBDOMAIN serving feed XML, so every loose spelling of
 * "is this a Fountain link" accepts it: `content.includes('fountain.fm')`,
 * `hostname.endsWith('fountain.fm')`, and `/fountain\.fm/.test(url)` all say
 * yes. That is why the real implementation holds an explicit host SET, and why
 * naive() at the foot of this file is written as the suffix test — the most
 * plausible wrong version, not a strawman. The same test is what lets
 * `fountain.fm.example.com` put a card of an attacker's choosing under
 * somebody else's note.
 *
 * Music is not an edge case here. Fountain spells episode and show as `track`
 * and `album` for a music feed, and this app's feed is full of them, so the
 * path allowlist carries both. `artist` is excluded on purpose: it is the
 * `podcast:publisher:guid:` target, which is neither the item nor its show, and
 * a note tagging all three (a real shape, below) must not resolve to it.
 */
import { episodeLinkInNote, landingLinksInNote } from '../lib/util.ts';

let failures = 0;

/** Every recorded call, replayed against the wrong implementation below. */
const vectors = [];

function compare(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
}

/** Record a call AND assert it. `alsoNaive` marks a must-still-work input. */
function check(label, tags, body, expected, { alsoNaive = false } = {}) {
  compare(label, episodeLinkInNote(tags, body), expected);
  vectors.push({ label, kind: 'episodeLink', args: [tags, body], alsoNaive });
}

/**
 * The same, for `landingLinksInNote`. A SECOND `kind` rather than a second
 * script, because both functions answer "which of this note's URLs is the card
 * already restating" and both feed `removeUrl` — split across two files they
 * drift, and the replay at the foot of this one walks every recorded call
 * whatever its kind, so a vector still cannot be added without being proved.
 */
function checkLanding(label, tags, body, expected, { alsoNaive = false } = {}) {
  compare(label, landingLinksInNote(tags, body), expected);
  vectors.push({ label, kind: 'landing', args: [tags, body], alsoNaive });
}

function section(name) {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------------------
section('tier one — the note names its own link (NIP-73 i-tag hint)');
// ---------------------------------------------------------------------------

// Verbatim: the note in the report that started this work. rev.hodl on MMO #233.
const MMO_TAGS = [
  ['k', 'podcast:item:guid'],
  ['i', 'podcast:item:guid:5a551d85-c109-587c-bd1e-1ca7d4f95909', 'https://fountain.fm/episode/uyCpkvctFMptzgFD59C3'],
  ['k', 'podcast:guid'],
  ['i', 'podcast:guid:31740861-81e8-5dda-8801-a2abb2634271', 'https://fountain.fm/show/5jyQ8aZgLKyz2l3QBBb6'],
];
check(
  'item hint present in the body wins',
  MMO_TAGS,
  'A few years ago there were all these stories of "hackers" holding businesses ransom.\n\nhttps://fountain.fm/episode/uyCpkvctFMptzgFD59C3',
  'https://fountain.fm/episode/uyCpkvctFMptzgFD59C3',
  { alsoNaive: true },
);

// The item hint is preferred over the show hint even when BOTH are in the body.
// The card describes the episode, so the episode's page is the honest target.
//
// The SHOW tag is deliberately first in this array. Preferring the item has to
// be a real preference and not an accident of the order a client happened to
// write its tags in — which is exactly what a walk-the-tags-in-order
// implementation gives you, and what naive() does below. Fountain writes the
// item first, so a vector using its ordering would pass either way and prove
// nothing.
check(
  'item hint beats show hint regardless of tag order',
  [
    ['i', 'podcast:guid:31740861-81e8-5dda-8801-a2abb2634271', 'https://fountain.fm/show/5jyQ8aZgLKyz2l3QBBb6'],
    ['i', 'podcast:item:guid:5a551d85-c109-587c-bd1e-1ca7d4f95909', 'https://fountain.fm/episode/uyCpkvctFMptzgFD59C3'],
  ],
  'both\nhttps://fountain.fm/show/5jyQ8aZgLKyz2l3QBBb6\nhttps://fountain.fm/episode/uyCpkvctFMptzgFD59C3',
  'https://fountain.fm/episode/uyCpkvctFMptzgFD59C3',
);

// Verbatim music note: Fountain writes /track/ and /album/, plus an /artist/
// page under podcast:publisher:guid: — which must never be the answer.
const MUSIC_TAGS = [
  ['i', 'podcast:item:guid:aa047faf-4872-42a7-93cc-4e9b9712a25c', 'https://fountain.fm/track/3nQSt6pDku7j6oqhEIlV'],
  ['i', 'podcast:guid:33d1729a-d124-5880-8f99-5ac4df73de73', 'https://fountain.fm/album/mFVQFD0HEislfOMNUHRW'],
  ['i', 'podcast:publisher:guid:64569161-a8f7-52e5-8aae-9e0385043149', 'https://fountain.fm/artist/o4G8mlecYblN9FSIxaiI'],
];
check(
  'music note resolves to the track, not the album or the artist',
  MUSIC_TAGS,
  'Song still in my mind\n\nhttps://fountain.fm/track/3nQSt6pDku7j6oqhEIlV',
  'https://fountain.fm/track/3nQSt6pDku7j6oqhEIlV',
  { alsoNaive: true },
);

// A publisher hint is the ONLY hint in the body. It still must not answer: an
// artist page is not the item the card describes, and podcast:publisher:guid:
// does not start with podcast:guid: — which is the whole reason that prefix
// test is written against the full string rather than a `includes('guid')`.
check(
  'a publisher hint alone in the body is not an answer',
  MUSIC_TAGS,
  'go follow them\n\nhttps://fountain.fm/artist/o4G8mlecYblN9FSIxaiI',
  null,
);

// Verbatim: show hint in the body, no item hint in the body.
check(
  'show hint answers when no item hint is in the body',
  [
    ['i', 'podcast:guid:10c64709-5e01-5ff6-acfe-a1311d677b3a', 'https://fountain.fm/album/tadRkHTTH1ct9i5NzApT'],
    ['i', 'podcast:publisher:guid:64569161-a8f7-52e5-8aae-9e0385043149', 'https://fountain.fm/artist/o4G8mlecYblN9FSIxaiI'],
  ],
  'https://fountain.fm/album/tadRkHTTH1ct9i5NzApT',
  'https://fountain.fm/album/tadRkHTTH1ct9i5NzApT',
  { alsoNaive: true },
);

// The hint and the body are two independently-typed copies of one link, so a
// raw `===` between them misses real matches. A host written with capitals is
// the everyday version of that — the URL is the same URL to every browser and
// every relay, and only string equality disagrees.
//
// TWO candidates in the body, so the app-page fallback cannot answer this by a
// different route: it refuses an ambiguous body outright. Only the normalized
// hint match can pick the second one, and naive() takes the first.
//
// This vector used to run on a non-Fountain host, chosen so the fallback would
// not mask it. That premise is gone: a hint on a host outside the allowlist is
// no longer an answer at all, because the note supplies both sides of the hint
// test. See the attack vector below.
check(
  'hint and body differ only by host case',
  [['i', 'podcast:item:guid:x', 'https://Fountain.FM/episode/BBBBBB']],
  'two of them: https://fountain.fm/episode/AAAAAA and https://fountain.fm/episode/BBBBBB',
  'https://fountain.fm/episode/BBBBBB',
);

// ── The reason every tier ends at the host allowlist ───────────────────────
// The `i` tag and the body are written by the same author, so a hostile one
// satisfies "the note pointed at this" by writing both halves. Without the
// allowlist this note unfurls a card under the REAL show's artwork and title,
// with PLAY / ♡ / BOOST beside a link of the author's choosing — and
// `removeUrl` deletes the raw URL from the body, so what a reader would have
// seen as a full magenta link becomes a small `host ↗` chip.
//
// alsoNaive because naive() refuses it for the wrong reason: it can only ever
// return a URL containing 'fountain.fm', so it never had to make this choice.
// The vector is here to pin the refusal, not to discriminate.
check(
  'a hint the note itself supplies is not a licence to link anywhere',
  [
    ['i', 'podcast:item:guid:baa182e9-d088-4cc1-a3f7-e4af48ff112a', 'https://evil.example/phish'],
    ['i', 'podcast:guid:acddbb03-064b-5098-87ca-9b146beb12e8', 'https://evil.example/phish'],
  ],
  'new episode out now https://evil.example/phish',
  null,
  { alsoNaive: true },
);

// The returned token is the BODY's spelling, because the caller deletes exactly
// this substring from the text. A closing bracket with nothing opening it
// inside the URL is sentence punctuation — `trimUrlTail`'s rule, which a
// `[.,;:!?]+$` strip does not have.
check(
  'an unbalanced closing bracket is punctuation, not part of the URL',
  MMO_TAGS,
  '(go listen to https://fountain.fm/episode/uyCpkvctFMptzgFD59C3)',
  'https://fountain.fm/episode/uyCpkvctFMptzgFD59C3',
);

// ---------------------------------------------------------------------------
section('a hint that is a FEED URL is not a link — the 62-note gap');
// ---------------------------------------------------------------------------

// Verbatim: every hint is the same feed XML, none of them in the body. The body
// links podcastindex.org, which is not a page this unfurls.
check(
  'feed XML hints, none in the body → nothing to unfurl',
  [
    ['i', 'podcast:item:guid:34162516757', 'https://ableandthewolf.com/static/media/feed.xml'],
    ['i', 'podcast:guid:4630863', 'https://ableandthewolf.com/static/media/feed.xml'],
    ['i', 'podcast:guid:acddbb03-064b-5098-87ca-9b146beb12e8', 'https://ableandthewolf.com/static/media/feed.xml'],
    ['i', 'podcast:item:guid:baa182e9-d088-4cc1-a3f7-e4af48ff112a', 'https://ableandthewolf.com/static/media/feed.xml'],
  ],
  '⚡ 100 sats\n📱 via BoostMeBitch\n\nhttps://podcastindex.org/podcast/4630863',
  null,
  { alsoNaive: true },
);

// Verbatim, and the single most important vector in this file. Every loose
// spelling of the host test accepts `feeds.fountain.fm`, which serves RSS.
check(
  'feeds.fountain.fm is a FEED host, not an app page',
  [
    ['i', 'podcast:item:guid:59551210068', 'https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU'],
    ['i', 'podcast:guid:7683299', 'https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU'],
  ],
  'HELIPAD!!!!!\n\n⚡ 333 sats\n📱 via BoostMeBitch\n\nhttps://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU',
  // NULL, and this vector used to assert the URL. The hint is in the body, so
  // tier one matched it and the function returned a raw RSS document as the
  // card's only outbound control — while docs/nostr.md says unfurling one
  // "puts a card over a raw XML document" and must not happen. Body membership
  // was carrying the whole feed-URL exclusion on the reasoning that a note
  // linking its own feed XML does not occur; this note, captured verbatim off
  // the relays, is that note. The host allowlist now excludes it by
  // construction rather than by luck.
  null,
  { alsoNaive: true },
);

check(
  'feeds.fountain.fm with NO hint naming it is not unfurled',
  [['i', 'podcast:item:guid:59551210068']],
  'HELIPAD!!!!!\n\nhttps://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU',
  null,
);

// ---------------------------------------------------------------------------
section('tier two — a recognised app page, when no hint matched (79 of 604)');
// ---------------------------------------------------------------------------

// Verbatim tag shape: hints omitted entirely, which is what 251 of the 604
// notes did. The body still carries a real Fountain page.
check(
  'no hints at all, one fountain page in the body',
  [
    ['i', 'podcast:guid:56fbb1aa-da79-5e4b-bebc-3b934ab8914c'],
    ['i', 'podcast:item:guid:ff4a13aa-ab1a-48a5-a467-6a7332402eae'],
  ],
  '💬 Great episode\n\nhttps://fountain.fm/episode/0bstRozFMaUnNjH975K4',
  'https://fountain.fm/episode/0bstRozFMaUnNjH975K4',
  { alsoNaive: true },
);

check(
  'play.fountain.fm serves the same ids under /app/',
  [['i', 'podcast:item:guid:ff4a13aa']],
  'https://play.fountain.fm/app/episode/uyCpkvctFMptzgFD59C3',
  'https://play.fountain.fm/app/episode/uyCpkvctFMptzgFD59C3',
  { alsoNaive: true },
);

// Two different episodes named in one body means the note is not about one of
// them. Picking either puts a link under a card describing the other, so the
// safe direction is to answer nothing and leave both as plain links.
check(
  'two different fountain episodes in one body → ambiguous, no card',
  [['i', 'podcast:item:guid:ff4a13aa']],
  'compare these\nhttps://fountain.fm/episode/aaaaaaaaaaaa\nhttps://fountain.fm/episode/bbbbbbbbbbbb',
  null,
);

check(
  'the SAME url twice is not ambiguous',
  [['i', 'podcast:item:guid:ff4a13aa']],
  'https://fountain.fm/episode/aaaaaaaaaaaa and again https://fountain.fm/episode/aaaaaaaaaaaa',
  'https://fountain.fm/episode/aaaaaaaaaaaa',
  { alsoNaive: true },
);

// ---------------------------------------------------------------------------
section('hostile and lookalike hosts');
// ---------------------------------------------------------------------------

check(
  'a subdomain-suffix lookalike is not fountain.fm',
  [['i', 'podcast:item:guid:x']],
  'https://fountain.fm.example.com/episode/uyCpkvctFMptzgFD59C3',
  null,
);

check(
  'a prefix lookalike is not fountain.fm',
  [['i', 'podcast:item:guid:x']],
  'https://notfountain.fm/episode/uyCpkvctFMptzgFD59C3',
  null,
);

check(
  'the string in a PATH on another host is not a link to fountain',
  [['i', 'podcast:item:guid:x']],
  'https://example.com/fountain.fm/episode/uyCpkvctFMptzgFD59C3',
  null,
);

check(
  'a fountain.fm URL that is not an episode/show/track page',
  [['i', 'podcast:item:guid:x']],
  'https://fountain.fm/settings/notifications',
  null,
);

// A hint is trusted about WHICH url, never about the scheme. `httpUrl` is the
// same allowlist `safeUrlAttr` uses, and this href is rendered as an anchor.
check(
  'a non-http hint is refused',
  [['i', 'podcast:item:guid:x', 'javascript:alert(1)']],
  'javascript:alert(1)',
  null,
  { alsoNaive: true },
);

// ---------------------------------------------------------------------------
section('must still work — inputs a correct implementation leaves alone');
// ---------------------------------------------------------------------------

check('no tags, no body', [], '', null, { alsoNaive: true });
check('body with no URL at all', MMO_TAGS, 'just a sentence about a podcast', null, { alsoNaive: true });
check(
  'a note with only an image URL left in the body',
  [['i', 'podcast:item:guid:x']],
  'https://i.nostr.build/a6G5FkkfTlSyfJ7z.png',
  null,
  { alsoNaive: true },
);
check(
  'our own boost note — pod.link and boostmebitch.com are not unfurled here',
  [
    ['i', 'podcast:guid:acddbb03-064b-5098-87ca-9b146beb12e8'],
    ['i', 'podcast:item:guid:510f7879-071f-468b-91e1-d9766831bd9d'],
    ['r', 'https://pod.link/1'],
    ['r', 'https://www.boostmebitch.com/?podcast=acddbb03-064b-5098-87ca-9b146beb12e8&episode=510f7879-071f-468b-91e1-d9766831bd9d'],
  ],
  '⚡ Boost ⚡\n\nChadF boosted 100 sats → Stay Awhile\n\nhttps://pod.link/1\nhttps://www.boostmebitch.com/?podcast=acddbb03-064b-5098-87ca-9b146beb12e8&episode=510f7879-071f-468b-91e1-d9766831bd9d',
  null,
  { alsoNaive: true },
);
check(
  'a malformed tag array does not throw',
  [['i'], ['i', null], ['i', 'podcast:item:guid:x', 42], ['r'], []],
  'https://fountain.fm/episode/abc123',
  'https://fountain.fm/episode/abc123',
);

// ---------------------------------------------------------------------------
section('landingLinksInNote — the links a boost note we published wrote itself');
// ---------------------------------------------------------------------------

// Verbatim, off relay.damus.io / nos.lol / relay.primal.net on 2026-08-30, from
// the 148 notes on that pull carrying this app's own `client` tag. Every single
// one had the same shape: two `r` tags, both printed in the body, plus a third
// body URL — the boost banner — which is NOT r-tagged and which `extractImages`
// pulls out and draws. That asymmetry is the whole reason this reads tags
// instead of matching our own hostname: the banner lives on the same origin as
// the deep link, and a host test would hide the picture too.
const SALTY_R_TAGS = [
  ['r', 'https://podcastindex.org/podcast/7986910'],
  ['r', 'https://www.boostmebitch.com/?podcast=5d161187-b707-4699-b04f-012769e110be&episode=37e1c082-66b3-41dd-829d-68d5c829e327'],
];
const SALTY_BODY = '⚡ Boost ⚡\n\nTest boost with offensive message\n\nphifer boosted 420 sats → Salty Sessions\n📻 Salty Sessions with Salty Crayon\n\nhttps://podcastindex.org/podcast/7986910\nhttps://www.boostmebitch.com/?podcast=5d161187-b707-4699-b04f-012769e110be&episode=37e1c082-66b3-41dd-829d-68d5c829e327\n\nhttps://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fassets.podhome.fm%2Fbeee04e1-5e83-489f-9834-08de8b7e7dd5%2F63923685862705643380s%2520day.gif&art2=https%3A%2F%2Fassets.podhome.fm%2Fbeee04e1-5e83-489f-9834-08de8b7e7dd5%2F639220423166827866Pirate%2520Rdio%2520Live.gif&title=Salty+Sessions&ep=Salty+Sessions+with+Salty+Crayon&sats=420';
checkLanding(
  'both landing links, and NOT the banner sharing their origin',
  SALTY_R_TAGS,
  SALTY_BODY,
  [
    'https://podcastindex.org/podcast/7986910',
    'https://www.boostmebitch.com/?podcast=5d161187-b707-4699-b04f-012769e110be&episode=37e1c082-66b3-41dd-829d-68d5c829e327',
  ],
  // Must-still-work, and honestly so: `formatContent` and
  // `buildBoostNoteTemplate` build the tag and the body line from the SAME
  // string, so on a real note they are byte-identical and the wrong version
  // agrees. That is exactly why the real vectors cannot carry this on their own
  // — the two below are the ones that separate the implementations, and this
  // one is here to prove the common case still works.
  { alsoNaive: true },
);

// Verbatim, same pull: a show-level boost. No `&episode=`, no 📻 line, and a
// trailing `nostr:` mention — which `stripNostrUris` removes upstream, so it is
// left here exactly as the relay served it to prove this function does not care.
checkLanding(
  'show-level boost, with a nostr: mention still in the body',
  [
    ['r', 'https://podcastindex.org/podcast/7968805'],
    ['r', 'https://www.boostmebitch.com/?podcast=7c6f7875-2b73-491e-b32c-e2c8d6e91d53'],
  ],
  '⚡ Boost ⚡\n\nChadF and 33 others boosted 100 sats → Chad and Reeds Podcast\n\nhttps://podcastindex.org/podcast/7968805\nhttps://www.boostmebitch.com/?podcast=7c6f7875-2b73-491e-b32c-e2c8d6e91d53\n\nhttps://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fassets.podhome.fm%2F11708875-2ff3-4c2e-a00b-08dee99f0b15%2F639217942893260082e72b12f4-3295-40b6-abaa-9945ff051a09.jpg&title=Chad+and+Reeds+Podcast&sats=100\n\nnostr:npub1tjmdpxuwjp4p3p6jjete9lkx6tnu9ytgtjhagsk8df372kdz2trqtdjv95',
  [
    'https://podcastindex.org/podcast/7968805',
    'https://www.boostmebitch.com/?podcast=7c6f7875-2b73-491e-b32c-e2c8d6e91d53',
  ],
  { alsoNaive: true }, // same reason as above
);

// AN R TAG THE BODY NEVER PRINTED IS NOT AN ANSWER. `removeUrl` is an indexOf,
// so returning it is harmless the day you write it and wrong the day a caller
// counts them or shows "n links hidden". The real Salty tags, one body line
// deleted.
checkLanding(
  'an r tag absent from the body is not returned',
  SALTY_R_TAGS,
  '⚡ Boost ⚡\n\nphifer boosted 420 sats → Salty Sessions\n\nhttps://podcastindex.org/podcast/7986910',
  ['https://podcastindex.org/podcast/7986910'],
);

// THE BODY'S SPELLING, NEVER THE TAG'S — the one that decides the shape of the
// implementation. These two URLs are the same address to every browser and
// relay, and different strings to `indexOf`. Hand back the tag and the caller
// removes nothing, silently, forever.
checkLanding(
  'returns the body spelling when the tag differs by case and encoding',
  [['r', 'https://WWW.BoostMeBitch.com/?podcast=abc%2Ddef']],
  'boosted\n\nhttps://www.boostmebitch.com/?podcast=abc%2Ddef',
  ['https://www.boostmebitch.com/?podcast=abc%2Ddef'],
);

// Must still work: a note with no r tags at all keeps every URL it printed.
// Most of the feed is this, and the wrong version gets it right too.
checkLanding(
  'no r tags, nothing hidden',
  [['i', 'podcast:guid:31740861-81e8-5dda-8801-a2abb2634271']],
  'read this https://example.com/post',
  [],
  { alsoNaive: true },
);

// A malformed r tag is data, not a crash. Same hostile-input rule the tier-one
// vectors carry: a tag array is whatever its author put there.
checkLanding(
  'malformed r tags are skipped',
  [['r'], ['r', null], ['r', 42], ['r', 'not a url'], ['r', 'https://example.com/a']],
  'x https://example.com/a',
  ['https://example.com/a'],
);

// ---------------------------------------------------------------------------
section('total replay against naive()');
// ---------------------------------------------------------------------------

/**
 * The obvious wrong implementation, and deliberately a plausible one rather
 * than a strawman: read the hint if there is one, otherwise take the first URL
 * whose text contains "fountain.fm". That is what this feature looks like when
 * written straight through, and it is wrong in four separate ways the vectors
 * above each catch — the feed-XML subdomain, both lookalike hosts, the
 * non-page path, the artist page, and the ambiguous pair.
 */
function naive(tags, body) {
  const urls = (body.match(/https?:\/\/[^\s]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ''));
  for (const t of tags ?? []) {
    // `t[1].startsWith` and not `t[1]?.startsWith`, on purpose. Relay events are
    // arbitrary user-signed JSON and a tag array is whatever its author put
    // there — the optional chaining that makes this safe is the kind of thing
    // added after a crash report, so the wrong implementation does not have it.
    if (t[0] === 'i' && t[1].startsWith('podcast:')) {
      const hit = urls.find((u) => u === t[2]);
      if (hit) return hit;
    }
  }
  return urls.find((u) => u.includes('fountain.fm')) ?? null;
}

/**
 * The obvious wrong `landingLinksInNote`: hand back the `r` tag's own spelling
 * for every r tag, without asking whether that string is in the body.
 *
 * Plausible rather than a strawman — it is what "remove the links the note tags"
 * looks like written straight through, and it is wrong in the way that costs
 * nothing visible: the caller feeds each answer to `removeUrl`, an `indexOf`,
 * so a spelling the body does not contain removes NOTHING and the note renders
 * exactly as it did before. It also returns tags the body never printed.
 */
function naiveLanding(tags, body) {
  void body;
  return (tags ?? []).filter((t) => t[0] === 'r').map((t) => t[1]);
}

{
  const repr = (v) => {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  const call = (which, v) => {
    try {
      const real = v.kind === 'landing' ? landingLinksInNote : episodeLinkInNote;
      const wrong = v.kind === 'landing' ? naiveLanding : naive;
      return repr(which === 'real' ? real(...v.args) : wrong(...v.args));
    } catch (e) {
      // A wrong implementation is allowed to throw where the real one returns.
      // That still counts as differing — it is the loudest way to be wrong.
      return `threw ${(e && e.message) || e}`;
    }
  };

  let exempt = 0;
  for (const v of vectors) {
    const differs = call('real', v) !== call('naive', v);
    if (v.alsoNaive) {
      exempt += 1;
      console.log(`  ok    "${v.label}" is must-still-work — naive() may get it right`);
      continue;
    }
    if (differs) {
      console.log(`  ok    naive() gets "${v.label}" wrong`);
      continue;
    }
    failures += 1;
    console.error(`  FAIL  "${v.label}" passes against naive() too — the vector proves nothing.`);
    console.error('          Either it is a must-still-work input (mark it { alsoNaive: true })');
    console.error('          or it does not exercise anything the real module adds.');
  }
  console.log(`  ${vectors.length} vector(s) replayed, ${exempt} exempt as must-still-work`);
}

// lib/util.ts is deliberately NOT scanned by scripts/import-free.mjs — that
// scan is for modules with no imports at all, and util.ts has a type-only one
// (`import type { Podcast, ... } from './types'`). Type-only imports are erased
// by type stripping, so the module loads under plain Node, which is all this
// script needs. check:vts and check:art import it the same way.

if (failures) {
  console.error(`\n${failures} note-episode-link check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll note-episode-link checks passed.');
