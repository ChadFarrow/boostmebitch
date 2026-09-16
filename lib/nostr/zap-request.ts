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
