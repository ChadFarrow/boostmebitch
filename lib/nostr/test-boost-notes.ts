// The test boost notes that reached the public relays, and the rule that keeps
// them off every feed here.
//
// IMPORT-FREE on purpose: `check:testnotes` loads this file under plain Node
// (`--experimental-strip-types`), and a relative import would stop it loading.
//
// WHAT HAPPENED. On 2026-11-17 nine runs of `npm run e2e:mentions` published
// 117 kind:1 boost notes to relay.primal.net and relay.fountain.fm (11:37 to
// 16:52 UTC). Section 5b's `capture()` drove `publishBoostNoteViaSite`, which
// could only publish to DEFAULT_RELAYS, and its stamp stand-in answered 599, so
// every note went out from a ONE-TIME key — 117 notes, 117 keys. They showed on
// this app's home page, on the pages of the two REAL feeds the fixture tags
// (`fce40d63-…`, the Wavlake album "Birdfeeder", on all 117; `e88a4a67-…`, Matt
// Finlay's "Kulture Collection", on 18 — the body says "Homegrown Hits", the
// tags do not) and on onlyboosts.social, 36 of them claiming 9,999,999,999
// sats. The leak itself is fixed in that script; this hides what is out there.
//
// WHY A RULE AND NOT A LIST OF IDS. One key per note leaves no author to mute,
// and nobody holds those keys, so no NIP-09 deletion can ever come. A list of
// 117 ids would work for these and for nothing else, while the marks below are
// the script's own fixtures, which any further leaked run would carry too.
//
// WHY THIS NARROW (Chad's choice, "strict filter"). A note is hidden only when
// BOTH halves hold: it says it was written by this app, AND it carries at least
// one mark no real boost can carry. Never a match on a feed guid: the test
// notes tag two real feeds' guids and NAME a third show, Homegrown Hits, that
// real people boost every week. Over-hiding is the failure nobody reports — nothing on screen
// says a card is missing — so every mark here is one a real note cannot make:
//
//   - `amount` 9999999999000 msat: the site-sign size fixture's
//     `value_msat_total`. No wallet sends ten billion sats.
//   - "Tester boosted" in the body: the script's `sender_name` is `Tester`.
//   - an `i` or `r` tag naming an https://example.com/ link: RFC 2606 reserves
//     example.com, so no real feed can serve an episode there.
//   - an item guid of only `g`s, or a feed guid of only `f`s, 16 or more: the
//     size fixture's 200-character guids. A real guid is a UUID, a URL or a
//     feed's own string, and a UUID of all `f`s still has its dashes.
//
// The `client` half is the LITERAL 'BoostMeBitch', not `BRAND.wireName`, and
// that is deliberate: the boostagram fixture in e2e:mentions writes
// `app_name: 'BoostMeBitch'`, the one string these notes carry, and both deploys
// read the same relays — the family-friendly site must hide them too.

/** The `client` tag every leaked test note carries. Not per-brand: see above. */
export const TEST_NOTE_CLIENT = 'BoostMeBitch';

/** `value_msat_total` of e2e:mentions' site-sign size fixture. */
export const TEST_NOTE_AMOUNT_MSAT = '9999999999000';

/** The shape this reads: a signed event's tags and body, nothing more. */
export interface TestNoteCandidate {
  tags?: unknown;
  content?: unknown;
}

const EXAMPLE_LINK = 'https://example.com/';
const ITEM_GUID_PREFIX = 'podcast:item:guid:';
const FEED_GUID_PREFIX = 'podcast:guid:';
const ALL_G = /^g{16,}$/;
const ALL_F = /^f{16,}$/;

function tagList(event: TestNoteCandidate): string[][] {
  if (!Array.isArray(event.tags)) return [];
  return event.tags.filter((t): t is string[] =>
    Array.isArray(t) && typeof t[0] === 'string' && typeof t[1] === 'string');
}

/** The link an `i` or `r` tag names: an `r` tag is one, an `i` tag carries one after its NIP-73 prefix. */
function linkOf(tag: string[]): string {
  if (tag[0] === 'r') return tag[1];
  if (tag[1].startsWith(ITEM_GUID_PREFIX)) return tag[1].slice(ITEM_GUID_PREFIX.length);
  if (tag[1].startsWith(FEED_GUID_PREFIX)) return tag[1].slice(FEED_GUID_PREFIX.length);
  return '';
}

/**
 * Which test mark a note carries, or `null` for none. Exported so the check
 * script can prove each mark hides a note ON ITS OWN; a caller deciding what to
 * render asks `isTestBoostNote`, which also requires the client.
 */
export function testNoteMark(
  event: TestNoteCandidate,
): 'amount' | 'tester' | 'example-link' | 'g-item-guid' | 'f-feed-guid' | null {
  const tags = tagList(event);
  if (tags.some((t) => t[0] === 'amount' && t[1] === TEST_NOTE_AMOUNT_MSAT)) return 'amount';
  if (typeof event.content === 'string' && event.content.includes('Tester boosted')) return 'tester';
  if (tags.some((t) => (t[0] === 'i' || t[0] === 'r') && linkOf(t).startsWith(EXAMPLE_LINK))) return 'example-link';
  for (const t of tags) {
    if (t[0] !== 'i') continue;
    if (t[1].startsWith(ITEM_GUID_PREFIX) && ALL_G.test(t[1].slice(ITEM_GUID_PREFIX.length))) return 'g-item-guid';
    if (t[1].startsWith(FEED_GUID_PREFIX) && ALL_F.test(t[1].slice(FEED_GUID_PREFIX.length))) return 'f-feed-guid';
  }
  return null;
}

/**
 * A boost note one of this repo's test scripts published to a public relay:
 * written by this app (`client` BoostMeBitch) AND carrying a test mark. Feeds
 * leave it out (`visibleNotes`, and every read of the index).
 *
 * Takes the WIRE event — `DiscoveredNote.rawEvent` — because the marks are
 * tags the parsed note does not keep. A missing or malformed event is not a
 * test note: a note this cannot read stays on screen, the behaviour before
 * this existed.
 */
export function isTestBoostNote(event: TestNoteCandidate | null | undefined): boolean {
  if (!event || typeof event !== 'object') return false;
  const fromThisApp = tagList(event).some((t) => t[0] === 'client' && t[1] === TEST_NOTE_CLIENT);
  return fromThisApp && testNoteMark(event) !== null;
}
