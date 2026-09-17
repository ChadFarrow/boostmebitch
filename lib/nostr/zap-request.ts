// The tag list of a kind:9734 zap request, and the NIP-73 podcast references
// that ride on it.
//
// WHY THIS IS A LEAF AND NOT TWENTY LINES INSIDE `sendZap`. The recipient's
// LNURL server reads this event before any relay does, and what it carries is
// then mirrored by that server onto the kind:9735 receipt — the event a boost
// note quotes and the event Fountain renders. So the shape here is a wire
// contract with somebody else's parser, and a drift in it is invisible from
// the app: the invoice still comes back, the sats still move, and the receipt
// simply says less. `check:zapreceipt` pins it against two real receipts.
//
// FIXTURE PROVENANCE. Two Fountain zap requests, read verbatim out of the
// `description` tag of the receipts their server published — kind:9735
// aeacff064116be8628a88a1d801e5e072a16c2a4c29ee1177cf673890d31477b (captured
// 2026-09-16 from relay.damus.io) and
// 881b07bc7ca11abb0fbd52099cef79fdff77ce779a5af0c752982ebe93ef4567 (captured
// the same day from relay.fountain.fm). Both carry, after `relays`, `amount`
// and `p`:
//
//     ["k","podcast:item:guid"]
//     ["i","podcast:item:guid:<item guid>","https://fountain.fm/episode/…"]
//     ["k","podcast:guid"]
//     ["i","podcast:guid:<feed guid>","https://fountain.fm/show/…"]
//
// and their server copies all four onto the receipt. Neither carries an `e`
// tag, a `client` tag, or a `lnurl` tag; both have empty `content`.
//
// WHY THE REFERENCES GO ON THE REQUEST AT ALL. This repo reads them back off
// exactly this place — `parseZapReceipt` (lib/nostr/zap-receipt.ts) resolves
// `description` → kind:9734 → `i` tags to learn which show and episode a
// receipt is about, because "NIP-73 refs ride on the zap REQUEST (the podcast
// client wrote it)". A request that omits them produces a receipt that parses
// as no show and no episode, in our own boost explorer and in every aggregator
// keyed the same way. The rule that forbids a `client` tag here (CLAUDE.md,
// Names) is about that tag: an app-identity claim the money path would carry.
// It was read as "no tags at all" once, and that reading cost every receipt
// this app produced its podcast linkage.
//
// THE URL HINT IS OPTIONAL PER NIP-73 AND FOUNTAIN ALWAYS WRITES ONE. Ours is
// the show or episode share URL on this site (`showShareUrl`, lib/util.ts),
// which is a restorable deep link. It is a hint for a reader that does not
// index the guid; it is never parsed back here.
//
// Import-free on purpose: this is loaded by `check:zapreceipt` under plain
// Node (see scripts/import-free.mjs). The URL test below is a local regex for
// that reason — it guards a hint this app built itself, not feed input.

/** Which show and item a zap is for, as a Podcasting 2.0 client names them. */
export interface Nip73Refs {
  /** The feed's `<podcast:guid>`. */
  podcastGuid?: string;
  /** The item's `<guid>`. */
  episodeGuid?: string;
  /** Where a reader may open the show. Written as the `i` tag's third element. */
  podcastUrl?: string;
  /** Where a reader may open the item. Written as the `i` tag's third element. */
  episodeUrl?: string;
}

const HTTP_URL = /^https?:\/\/\S+$/i;

function withHint(tag: string[], url: string | undefined): string[] {
  const u = url?.trim();
  return u && HTTP_URL.test(u) ? [...tag, u] : tag;
}

/**
 * The NIP-73 `k`/`i` pairs for `refs`, in the order Fountain writes them: the
 * item first, then the show, `k` before its `i`. A missing guid emits neither
 * half of its pair; a missing URL emits the `i` tag without a hint.
 */
export function nip73Tags(refs: Nip73Refs | undefined): string[][] {
  if (!refs) return [];
  const out: string[][] = [];
  const item = refs.episodeGuid?.trim();
  const show = refs.podcastGuid?.trim();
  if (item) {
    out.push(['k', 'podcast:item:guid']);
    out.push(withHint(['i', `podcast:item:guid:${item}`], refs.episodeUrl));
  }
  if (show) {
    out.push(['k', 'podcast:guid']);
    out.push(withHint(['i', `podcast:guid:${show}`], refs.podcastUrl));
  }
  return out;
}

/**
 * Every tag a kind:9734 this app signs carries. NIP-57 Appendix D: `relays`,
 * `amount`, optional `lnurl`, exactly one `p`, optional `e` or `a`. Then the
 * NIP-73 pairs. No `client` tag — see the file header.
 */
export function zapRequestTags(args: {
  relays: string[];
  amountMsat: number;
  lnurl?: string;
  recipientPubkey: string;
  eventId?: string;
  aTag?: string;
  refs?: Nip73Refs;
}): string[][] {
  const tags: string[][] = [
    ['relays', ...args.relays],
    ['amount', String(args.amountMsat)],
  ];
  if (args.lnurl) tags.push(['lnurl', args.lnurl]);
  tags.push(['p', args.recipientPubkey]);
  if (args.eventId) tags.push(['e', args.eventId]);
  if (args.aTag) tags.push(['a', args.aTag]);
  tags.push(...nip73Tags(args.refs));
  return tags;
}

// ── The summary receipt ─────────────────────────────────────────────────────
//
// WHAT IT IS. One kind:9735 for the sats a boost ACTUALLY PAID, signed by this
// site's key, quoted by the boost note. Fountain renders a boost's ⚡ figure off
// the first quoted receipt and nothing else, and a client-side split can never
// produce a provider receipt for the whole: four recipients are four invoices
// from four providers, and two of them are keysends with no receipt at all. The
// first production boost showed "⚡ 33" under a note that said 100.
//
// Fountain's own boosts carry a receipt for the total because Fountain IS the
// recipient: its zap request names Fountain's key and its node issues one
// invoice for the whole, then Fountain splits server-side. Asked, Fountain's
// developer said they sign the receipt for the total being sent, and that this
// app should do the same with its own key (2026-09-17). So the receipt mirrors
// Fountain's shape: `p` is the signing key, `P` the sender, `description` the
// sender-signed kind:9734, the NIP-73 pairs mirrored from it.
//
// WHAT IT IS NOT. Not a provider's proof of payment. NIP-57 Appendix F has a
// validating client check a receipt's signer against the recipient's lnurl
// provider, and this receipt fails that test by construction — it renders
// where Fountain renders it and may be refused by a client that validates.
// NIP-57 itself says a receipt "is not a proof of payment ... you are trusting
// the author"; this one's author is the site, attesting that a boost this app
// sent settled. That is the same trust level as the site-signed boost notes
// the site-sign oracle already publishes, and no higher.
//
// WHY `bolt11` IS ABSENT. Appendix E makes it mandatory, and there is no
// invoice for the total — the legs each had their own. A minted invoice nobody
// can pay would be a fabricated payment record, which is a different thing
// from an attestation. The amount rides in the request's `amount` tag and in
// an `amount` tag on the receipt (the optional one Appendix E allows and this
// repo's own reader takes first). Whether Fountain's reader takes an amount
// without a bolt11 is the one thing a boost has to prove.
//
// WHAT BOUNDS THE ORACLE. `/api/nostr/zap-receipt-sign` is unauthenticated,
// like site-sign. It never signs a caller-supplied receipt: it takes a kind:9734
// the SENDER signed, validates it here, and derives the 9735 itself. So a
// stranger can only make the site attest a payment from their OWN key, `P`-
// tagged to them — the same claim they can already make with a boost note. It
// cannot attest a payment from anyone else's key, quote a note, or carry prose.

/** A signed event as a caller hands it over — untrusted until validated. */
export interface SummaryRequest {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** 1,000,000 sats. A boost above this is not one this app sends. */
export const SUMMARY_MAX_MSAT = 1_000_000_000;
export const SUMMARY_MAX_RELAYS = 8;
/** ±5 min, the site-sign oracle's skew. */
export const SUMMARY_SKEW_SECS = 300;
const SUMMARY_TAG_NAMES = new Set(['relays', 'amount', 'lnurl', 'p', 'k', 'i']);
const SUMMARY_K_VALUES = new Set(['podcast:guid', 'podcast:item:guid']);
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX128_RE = /^[0-9a-f]{128}$/;
const MAX_TAGS = 16;
const MAX_TAG_ITEMS = 10;
const MAX_TAG_ITEM_LEN = 512;

/**
 * The shape a kind:9734 must have before the site derives a receipt from it.
 * Pure — the SIGNATURE is checked by the route with `verifyEvent`; this decides
 * everything else, so `check:zapreceipt` can pin it. Returns the request
 * rebuilt from exactly its seven fields, so nothing a caller appended can
 * reach the `description` tag.
 */
export function validateSummaryRequest(
  input: unknown,
  sitePubkey: string,
  nowSecs: number,
): { ok: true; request: SummaryRequest } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return no('not an event');
  const e = input as Record<string, unknown>;
  if (e.kind !== 9734) return no('not a zap request');
  if (typeof e.id !== 'string' || !HEX64_RE.test(e.id)) return no('bad id');
  if (typeof e.pubkey !== 'string' || !HEX64_RE.test(e.pubkey)) return no('bad pubkey');
  if (typeof e.sig !== 'string' || !HEX128_RE.test(e.sig)) return no('bad sig');
  if (typeof e.created_at !== 'number' || !Number.isInteger(e.created_at)) return no('bad created_at');
  if (Math.abs(e.created_at - nowSecs) > SUMMARY_SKEW_SECS) return no('created_at out of range');
  // Fountain's summary requests carry no prose and neither do ours: the note
  // has the message. An oracle that signs text under the site key is the
  // site-sign oracle's problem, and this one does not take it on.
  if (e.content !== '') return no('content must be empty');
  if (!Array.isArray(e.tags) || e.tags.length > MAX_TAGS) return no('bad tags');
  for (const t of e.tags) {
    if (!Array.isArray(t) || t.length === 0 || t.length > MAX_TAG_ITEMS) return no('bad tag');
    if (!t.every((x) => typeof x === 'string' && x.length <= MAX_TAG_ITEM_LEN)) return no('bad tag');
    if (!SUMMARY_TAG_NAMES.has(t[0])) return no(`unsupported tag ${t[0]}`);
  }
  const tags = e.tags as string[][];
  const named = (n: string) => tags.filter((t) => t[0] === n);
  const p = named('p');
  if (p.length !== 1 || p[0][1] !== sitePubkey) return no('p must be the site key, once');
  const amount = named('amount');
  if (amount.length !== 1 || !/^[1-9][0-9]*$/.test(amount[0][1] ?? '')) return no('amount missing');
  const msat = Number(amount[0][1]);
  if (!Number.isSafeInteger(msat) || msat % 1000 !== 0 || msat > SUMMARY_MAX_MSAT) return no('amount out of range');
  const relays = named('relays');
  if (relays.length !== 1) return no('relays missing');
  const urls = relays[0].slice(1);
  if (urls.length === 0 || urls.length > SUMMARY_MAX_RELAYS || !urls.every((u) => u.startsWith('wss://'))) {
    return no('bad relays');
  }
  if (named('lnurl').length > 1) return no('too many lnurl tags');
  const ks = named('k');
  const is = named('i');
  if (ks.length > 2 || is.length > 2) return no('too many refs');
  if (!ks.every((t) => t.length === 2 && SUMMARY_K_VALUES.has(t[1]))) return no('bad k tag');
  for (const t of is) {
    const kind = t[1]?.startsWith('podcast:item:guid:') ? 'podcast:item:guid'
      : t[1]?.startsWith('podcast:guid:') ? 'podcast:guid' : null;
    if (!kind || t[1].length <= kind.length + 1) return no('bad i tag');
    if (t.length > 3 || (t.length === 3 && !HTTP_URL.test(t[2]))) return no('bad i hint');
    if (!ks.some((k) => k[1] === kind)) return no('i without k');
  }
  return {
    ok: true,
    request: {
      id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: 9734,
      tags: tags.map((t) => [...t]), content: '', sig: e.sig,
    },
  };
}

/**
 * What the client sends when the SITE must author the request too: a boost
 * whose note is site-published — signed out, or Anonymous — has no sender key
 * that may sign a kind:9734 (the request's `pubkey` becomes the receipt's `P`,
 * and naming the user is exactly what Anonymous refuses). The site then signs
 * both halves, and the receipt's sender is the site, as its note's author is.
 *
 * Bounded to the three facts a request carries and nothing else: the site
 * builds the template itself through `zapRequestTags`, signs it, and runs the
 * result through `validateSummaryRequest` like any other. A caller cannot put
 * a tag, a `p`, or a character of prose into it.
 */
export interface SummarySpec {
  amountMsat: number;
  relays: string[];
  refs?: Nip73Refs;
}

export function summaryRequestTemplateFromSpec(
  input: unknown,
  sitePubkey: string,
  nowSecs: number,
): { kind: 9734; created_at: number; content: ''; tags: string[][] } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const spec = input as Record<string, unknown>;
  const amountMsat = spec.amountMsat;
  if (typeof amountMsat !== 'number' || !Number.isSafeInteger(amountMsat)) return null;
  if (amountMsat <= 0 || amountMsat % 1000 !== 0 || amountMsat > SUMMARY_MAX_MSAT) return null;
  if (!Array.isArray(spec.relays)) return null;
  const relays = [...new Set(
    spec.relays.filter((r): r is string => typeof r === 'string' && r.startsWith('wss://') && r.length <= 256),
  )].slice(0, SUMMARY_MAX_RELAYS);
  if (relays.length === 0) return null;
  const rawRefs = spec.refs && typeof spec.refs === 'object' && !Array.isArray(spec.refs)
    ? (spec.refs as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 512 ? v : undefined);
  const refs: Nip73Refs = {
    podcastGuid: str(rawRefs.podcastGuid),
    episodeGuid: str(rawRefs.episodeGuid),
    podcastUrl: str(rawRefs.podcastUrl),
    episodeUrl: str(rawRefs.episodeUrl),
  };
  return {
    kind: 9734,
    created_at: nowSecs,
    content: '',
    tags: zapRequestTags({ relays, amountMsat, recipientPubkey: sitePubkey, refs }),
  };
}

/**
 * The kind:9735 the site signs for a validated summary request — Fountain's
 * receipt shape (captured, file header) minus the invoice that does not exist:
 * `p` the site, `P` the sender, `description` the request verbatim, `amount`,
 * and the NIP-73 pairs mirrored as Fountain's server mirrors them.
 */
export function summaryReceiptTemplate(
  request: SummaryRequest,
  sitePubkey: string,
  createdAt: number,
): { kind: 9735; created_at: number; content: ''; tags: string[][] } {
  const amount = request.tags.find((t) => t[0] === 'amount')?.[1] ?? '0';
  const refs = request.tags.filter((t) => t[0] === 'k' || t[0] === 'i').map((t) => [...t]);
  return {
    kind: 9735,
    created_at: createdAt,
    content: '',
    tags: [
      ['p', sitePubkey],
      ['P', request.pubkey],
      ['description', JSON.stringify(request)],
      ['amount', amount],
      ...refs,
    ],
  };
}
