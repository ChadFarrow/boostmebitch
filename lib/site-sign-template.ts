// SERVER-ONLY. The boost-note template rules BOTH site-key routes apply:
// `/api/nostr/site-stamp` before it mints a stamp invoice, and
// `/api/nostr/site-sign` before it signs. One copy, so a template the stamp
// route accepts is never one the sign route refuses after the user paid.
//
// Every throw below is a string literal written here: both routes reflect
// `e.message` as their 400, and that is safe only while this stays true. Read
// the comment at the call site in app/api/nostr/site-sign/route.ts before
// adding any call that can throw something this file did not write.
import type { EventTemplate } from 'nostr-tools/pure';
import { httpUrl } from '@/lib/util';
import { BRAND } from '@/lib/brand';

// Just above the largest REAL boost note (about 4,025 characters, and BOOST ALL
// about 4,280, measured by `e2e:mentions` with every part at its maximum), so a
// real boost never meets it — at 2000 a real note measured 2032 and was
// refused, RETRY NOTE with it. It is still the bound on the free text a caller
// can have this key sign, so not far above. It was 5500 until 2026-11-22, when
// the body still carried two links of up to 512 characters each.
// lib/nostr/boost-notes.ts keeps the same number (SITE_SIGN_MAX_CONTENT);
// change both together.
const MAX_CONTENT = 4800;
const MAX_TAGS = 40;
// MAX_TAGS bounds the tag COUNT; these bound their size. Without them the
// oracle would sign an event whose tags carry megabytes of attacker-chosen
// text under the site's NIP-05-verified identity — the content prefix check
// below constrains only `content`, so tags were the way around it. Generous
// next to real boost notes, whose largest tag is an `r` URL.
const MAX_TAG_ITEMS = 8;
const MAX_TAG_ITEM_LEN = 512;
const MAX_TAGS_TOTAL_LEN = 4096;
const CREATED_AT_SKEW_SECS = 300; // reject notes back/post-dated beyond ±5 min
// Every genuine boost note — single and boost-all summary alike — is framed by
// formatContent()/the summary override with this exact prefix.
//
// BE CLEAR ABOUT WHAT THIS DOES AND DOESN'T BUY. It constrains the first ten
// characters. It was commented as stopping "the oracle being repurposed to sign
// arbitrary free-text (spam, harassment, defamation)", and it does not: the
// remaining MAX_CONTENT characters are still whatever the caller sends, under
// the site's NIP-05-verified identity. That can't be regexed away, because a
// boost note legitimately carries the user's own typed message — arbitrary text
// is the feature, not a hole in it.
//
// What CAN be bounded is the amplifier, and that's what the tag rules below do.
const BOOST_CONTENT_PREFIX = '⚡ Boost ⚡';

// The complete tag vocabulary `buildBoostNoteTemplate` emits
// (lib/nostr/boost-notes.ts) — NIP-73 `i`/`k`, landing-page `r`, artist `p`,
// `amount`, `client`, and the two `t` markers. An allowlist rather than a
// denylist, for the same fail-closed reason as safeUrlAttr.
//
// It costs nothing and closes the one thing that made this oracle worth
// attacking: an `e` tag. A boost note never has one, so refusing them outright
// is provably not a regression — and with one, a signed event from the site key
// appears to REPLY to any note in the world, which is a far better vehicle for
// harassment than a standalone post nobody is subscribed to.
//
// If buildBoostNoteTemplate ever emits a new tag, add it here in the same
// change or site-signed notes start failing.
const ALLOWED_TAG_NAMES = new Set(['i', 'k', 'r', 'p', 'amount', 'client', 't', 'imeta', 'q']);

// One `q` (NIP-18), and ONLY when the quoted event's author is the site itself.
// A site-published boost note quotes its summary receipt — a kind:9735 this
// same key signed through /api/nostr/zap-receipt-sign — and that is the whole
// reason `q` is here. Bound to the site's own pubkey as author, it cannot be
// what an `e` tag would have been: a signed instruction from a verified
// identity to render some stranger's note beneath the site's words. The check
// is on the tag's author field, which is the only thing this oracle can see;
// a reader that fetches the event checks the signature itself.
const MAX_Q_TAGS = 1;
const HEX64_RE = /^[0-9a-f]{64}$/;

// One `imeta` (NIP-92), because the note names one piece of artwork. The cap is
// the same reasoning as MAX_P_TAGS one level down: the tag carries a URL a
// client will FETCH, so an unbounded list turns one unauthed POST into a signed
// instruction to load N attacker-chosen hosts from every reader's device.
const MAX_IMETA_TAGS = 1;

// A real boost `p`-tags the artists a feed names — one to a few, and a
// compilation is still nowhere near this. The cap is what stops one unauthed
// POST becoming a mention-spam blast at 40 strangers from a verified identity.
//
// A sender's own @mentions are a SECOND source of `p` tags, and they never
// reach this route: noteMentionTags (lib/nostr/mention-tags.ts) strips them
// from any template bound for site-signing, precisely because this endpoint is
// unauthenticated. So what arrives here is still only what a feed declared,
// and this cap still means what it says. Nothing here should learn about
// mentions — its job is to be a dumb bound, and a bound that trusts the client
// to have already filtered is not one.
const MAX_P_TAGS = 8;

// The two tags that carry a URL a reader's client will render or FETCH, bound
// to the shape `buildBoostNoteTemplate` (lib/nostr/boost-notes.ts) actually
// emits, rather than to "any 512-character string":
//
//   - `r` is this site's own deep link. A note built before 2026-11-22 (an old
//     open tab) also carries the episode's listen link, so at most two, and
//     each one an http(s) URL. Tested with `httpUrl(v) !== null`, not
//     `httpUrl(v) === v`: `bmbLandingUrl` does not encode the guid it embeds,
//     so the normalised form can differ from the literal by a character.
//   - `imeta` names the banner, which is ALWAYS this deploy's own
//     `/api/og/boost.png` (`boostBannerUrl`, from `BRAND.origin`). A note that
//     names a different host is not one this app built.
//
// Both are cheap to prove and close the one thing left in this oracle worth
// abusing after the `e`-tag refusal below: a signed instruction, from a
// NIP-05-verified identity, to render or load an attacker-chosen URL.
const MAX_R_TAGS = 2;
const BANNER_PREFIX = `url ${BRAND.origin}/api/og/boost.png?`;

// The WHOLE `imeta` tag, not just its first entry. NIP-92 makes every element
// a `<key> <value>` pair, and a client reads them all: an `imeta` whose first
// entry was this site's banner could still carry `fallback https://evil/…`, a
// second `url`, or a `thumb`/`image` pointing anywhere, as elements 2 to 7 —
// a signed instruction, under the site's NIP-05-verified name, to load an
// attacker-chosen host from every reader's device, which is the one thing the
// `url` rule exists to refuse. `buildBoostNoteTemplate` writes exactly one
// shape (`['imeta', 'url <banner>', 'm image/png', 'dim 1200x300']`, since the
// banner replaced the cover art), so the rule is that shape and nothing else.
// The URL may hold no whitespace: a client splitting an entry on its spaces
// would read a second key out of it. `URLSearchParams` encodes a space as `+`,
// so a real banner never has one.
const BANNER_IMETA_REST = ['m image/png', 'dim 1200x300'];
function bannerImetaOk(imeta: string[]): boolean {
  const url = imeta[1] ?? '';
  return imeta.length === 2 + BANNER_IMETA_REST.length
    && url.startsWith(BANNER_PREFIX)
    && !/\s/.test(url.slice('url '.length))
    && BANNER_IMETA_REST.every((entry, i) => imeta[i + 2] === entry);
}

// Bound the signing oracle: this endpoint must only ever sign boost-shaped
// kind:1 notes as the site, never arbitrary events (DMs, kind:0 hijack, etc.).
export function validateBoostTemplate(
  body: unknown,
  site: string,
  opts: { checkCreatedAt: boolean },
): EventTemplate {
  if (!body || typeof body !== 'object') throw new Error('bad template');
  const t = body as Record<string, unknown>;
  if (t.kind !== 1) throw new Error('only kind:1 boost notes may be signed');
  if (typeof t.content !== 'string' || t.content.length > MAX_CONTENT) {
    throw new Error('invalid content');
  }
  if (!t.content.startsWith(BOOST_CONTENT_PREFIX)) {
    throw new Error('not a boost note');
  }
  if (!Array.isArray(t.tags) || t.tags.length > MAX_TAGS) throw new Error('invalid tags');
  const tags = t.tags as unknown[];
  const flat = tags.every(
    (tag) =>
      Array.isArray(tag) &&
      tag.length <= MAX_TAG_ITEMS &&
      tag.every((x) => typeof x === 'string' && x.length <= MAX_TAG_ITEM_LEN),
  );
  if (!flat) throw new Error('invalid tags');
  const strTags = tags as string[][];
  const tagsLen = strTags.reduce(
    (n, tag) => n + tag.reduce((m, x) => m + x.length, 0),
    0,
  );
  if (tagsLen > MAX_TAGS_TOTAL_LEN) throw new Error('invalid tags');
  if (!strTags.every((tag) => tag.length > 0 && ALLOWED_TAG_NAMES.has(tag[0]!))) {
    throw new Error('unsupported tag');
  }
  if (strTags.filter((tag) => tag[0] === 'p').length > MAX_P_TAGS) {
    throw new Error('too many p tags');
  }
  if (strTags.filter((tag) => tag[0] === 'imeta').length > MAX_IMETA_TAGS) {
    throw new Error('too many imeta tags');
  }
  const rTags = strTags.filter((tag) => tag[0] === 'r');
  if (rTags.length > MAX_R_TAGS) throw new Error('too many r tags');
  if (!rTags.every((tag) => tag.length === 2 && httpUrl(tag[1]) !== null)) {
    throw new Error('invalid r tag');
  }
  const imeta = strTags.find((tag) => tag[0] === 'imeta');
  if (imeta && !bannerImetaOk(imeta)) throw new Error('invalid imeta tag');
  const qTags = strTags.filter((tag) => tag[0] === 'q');
  if (qTags.length > MAX_Q_TAGS) throw new Error('too many q tags');
  for (const q of qTags) {
    const [, id, relay, author] = q;
    if (q.length !== 4 || !HEX64_RE.test(id ?? '') || author !== site) {
      throw new Error('a site-signed note may only quote the site’s own receipt');
    }
    if (relay !== '' && !relay.startsWith('wss://')) throw new Error('invalid q relay');
  }
  const hasT = (v: string) => strTags.some((tag) => tag[0] === 't' && tag[1] === v);
  // The two markers publishBoostNote always emits — proves this is a boost note.
  if (!hasT('boostagram') || !hasT('value4value')) {
    throw new Error('not a boost note');
  }
  const now = Math.floor(Date.now() / 1000);
  const createdAt =
    typeof t.created_at === 'number' && Number.isFinite(t.created_at)
      ? t.created_at
      : now;
  // A STAMPED template skips the window: its id — `created_at` included — was
  // bound inside a token minted while this check passed, so the sign route may
  // re-sign that one event for RETRY NOTE long after five minutes.
  if (opts.checkCreatedAt && Math.abs(createdAt - now) > CREATED_AT_SKEW_SECS) {
    throw new Error('created_at out of range');
  }
  return { kind: 1, created_at: createdAt, tags: strTags, content: t.content };
}
