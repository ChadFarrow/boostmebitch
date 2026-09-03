import { NextResponse } from 'next/server';
import { finalizeEvent, type EventTemplate } from 'nostr-tools/pure';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { siteSecretKey } from '@/lib/nostr/site-key';

// Server-side signer for the SITE's own Nostr identity. Lets a signed-OUT user
// still post their boost note to Nostr — signed by the app's key, not theirs.
//
// The private key (SITE_NOSTR_SK, nsec or hex) is server-only and NEVER shipped
// to the browser (a signing key in the bundle is extractable by anyone). The
// client POSTs an unsigned boost-note template here; we sign it and return the
// signed event, which the client then publishes to relays itself.
//
// Absent SITE_NOSTR_SK => 503, so the feature is simply off when unconfigured
// (the checkbox still shows; the note just isn't posted). Mirrors the graceful
// degradation used elsewhere (e.g. the non-fatal Libre postinstall).

const MAX_CONTENT = 2000;
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
const ALLOWED_TAG_NAMES = new Set(['i', 'k', 'r', 'p', 'amount', 'client', 't', 'imeta']);

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

// Bound the signing oracle: this endpoint must only ever sign boost-shaped
// kind:1 notes as the site, never arbitrary events (DMs, kind:0 hijack, etc.).
function validateBoostTemplate(body: unknown): EventTemplate {
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
  if (Math.abs(createdAt - now) > CREATED_AT_SKEW_SECS) {
    throw new Error('created_at out of range');
  }
  return { kind: 1, created_at: createdAt, tags: strTags, content: t.content };
}

export async function POST(req: Request) {
  const limited = rateLimit(req, 'site-sign', 30);
  if (limited) return limited;

  const sk = siteSecretKey();
  if (!sk) {
    return NextResponse.json(
      { error: 'site Nostr identity not configured' },
      { status: 503 },
    );
  }

  return withErrorHandling(async () => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }
    let template: EventTemplate;
    try {
      template = validateBoostTemplate(body);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'invalid template' },
        { status: 400 },
      );
    }
    const signed = finalizeEvent(template, sk);
    return NextResponse.json(
      { event: signed },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }, 'site-sign failed');
}
