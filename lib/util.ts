import type {
  Podcast, ValueBlock, ValueRecipient, Episode, AlternateEnclosure,
  BoostResult, StoredBoostLeg,
} from './types';

// True when the feed is a Podcasting 2.0 music album (`<podcast:medium>music`).
// Case-insensitive — PI doesn't normalize the tag. Drives album-specific UI
// (play overlay, track list, row-tap-to-play, track-order sort).
export function isMusicMedium(podcast: Pick<Podcast, 'medium'>): boolean {
  return podcast.medium?.toLowerCase() === 'music';
}

// True when a value block actually has payees — the gate for showing BOOST.
export function hasValueRecipients(value?: ValueBlock | null): boolean {
  return !!value?.recipients?.length;
}

/**
 * Whether a recipient pays over LNURL rather than keysend.
 *
 * `type` alone is not the answer, because an address containing an `@` is a
 * Lightning address whatever the wire claims. Both publishing sides mislabel
 * these as `"node"`: The Split Kit stores that type for lnaddress destinations
 * (which is why `live-block.ts` re-infers, and why the fixtures in
 * check-live-block.mjs carry `type:'node', address:'artist@fountain.fm'`), and
 * plenty of hand-written `<podcast:valueRecipient>` tags do the same. The three
 * feed-side parsers — lib/pi.ts twice and lib/musicl-resolver.ts — take the
 * declared type verbatim, so trusting it sends a keysend to an email-shaped
 * string, which no rail can route. Inferring here converts a leg that was
 * guaranteed to fail into one that pays.
 *
 * `live-block.ts` deliberately does NOT call this — it keeps its own inline
 * copy of the same rule, because its only import is `import type` and
 * check-live-block.mjs relies on that to load it under plain Node. The two
 * must agree; if you change the rule here, change it there too.
 */
export function isLnAddressRecipient(r: Pick<ValueRecipient, 'type' | 'address'>): boolean {
  return r.type === 'lnaddress' || r.address.includes('@');
}

/**
 * Fit the LUD-21 comment into the recipient's `commentAllowed` budget.
 *
 * Split into two arguments because they truncate differently, and the naive
 * single-string version gets it exactly backwards. `desc` is BoostBox's
 * `rss::payment::<action> <url>` descriptor — Fountain wrote that spec and
 * parses it, so for an LNURL leg it IS the metadata channel, and it is only
 * worth anything WHOLE. `message` is human prose that reads fine clipped.
 *
 * `${desc} — ${message}`.slice(0, budget) puts the fragile part first and cuts
 * from the right, so a tight budget shortens the URL into a dead link while
 * still spending the entire allowance on it: the recipient gets no metadata AND
 * no message, and nothing anywhere reports a problem. Many services allow 255 or
 * 500 and this never bites; some allow 32, and 0 means "no comment at all".
 *
 * So: keep `desc` only if it fits whole, spend what's left on `message`, and if
 * `desc` cannot fit, drop it entirely rather than send a broken URL — a clipped
 * message alone is strictly more use to the recipient than a link that 404s.
 */
export function buildLnurlComment(
  args: { desc?: string; message?: string },
  commentAllowed: number | undefined,
): string | undefined {
  const budget = commentAllowed ?? 0;
  if (budget <= 0) return undefined;
  const desc = args.desc?.trim() || undefined;
  const message = args.message?.trim() || undefined;

  if (!desc) return message?.slice(0, budget) || undefined;
  // Whole or not at all.
  if (desc.length > budget) return message?.slice(0, budget) || undefined;
  if (!message) return desc;

  const sep = ' — ';
  const room = budget - desc.length - sep.length;
  // No room for a separator plus at least one character of prose: send the
  // descriptor alone rather than a dangling em dash.
  if (room < 1) return desc;
  return `${desc}${sep}${message.slice(0, room)}`;
}

// A recipient's payment destination, shortened for display: an lnaddress verbatim
// (it's already human-readable and the whole point is that you can read it), a
// keysend node pubkey elided in the middle (66 hex chars never fits a modal row,
// and the head/tail is what people actually compare against). Every surface that
// shows a value split renders this, so the elision stays identical across them.
export function recipientAddress(r: Pick<ValueRecipient, 'type' | 'address'>): string {
  // isLnAddressRecipient, not `type === 'lnaddress'`, for the same reason
  // payOne uses it: a feed that mislabels an @-address as "node" would
  // otherwise get it elided into `someone…ntain.fm` on one screen and printed
  // verbatim on another, which is the drift this helper exists to prevent.
  if (isLnAddressRecipient(r) || r.address.length <= 20) return r.address;
  return `${r.address.slice(0, 8)}…${r.address.slice(-8)}`;
}

/**
 * Display order for a value split: biggest share first.
 *
 * Feed order is authoring order, which buries the lede — a block can list three
 * 0.5% housekeeping payees above the artist taking 98%, so the row that answers
 * "who is this actually paying?" is the one you have to hunt for. Sorting by
 * weight puts it first everywhere a split is shown.
 *
 * Returns INDICES, not recipients, because `<SplitsPreview>` reads `splits[i]`
 * and `results[i]` positionally — handing back a reordered array of recipients
 * would silently pair each row with someone else's sats and someone else's
 * ✓/✗. Ties keep feed order (the sort is stable), so equal-weight payees don't
 * shuffle between renders.
 *
 * This is no longer display-only: `sendBoost` traverses by it, so it decides
 * which artist is paid before a rail has a chance to die, and `storedBoostLegs`
 * below writes the permanent history record by it. The stability guarantee is
 * therefore a payment-determinism guarantee too.
 */
export function recipientOrder(recipients: readonly Pick<ValueRecipient, 'split'>[]): number[] {
  const weight = (i: number) => Math.max(0, recipients[i]?.split ?? 0);
  return recipients.map((_, i) => i).sort((a, b) => weight(b) - weight(a));
}

/**
 * A sent boost's per-recipient legs for the local log, biggest share first.
 *
 * Ordered rather than feed-ordered because `<BoostCard>` renders `legs`
 * verbatim and a stored leg carries no `split` weight — whatever order is
 * written here is the order that boost is remembered in, permanently, with no
 * way to re-sort at render time. Feed order meant the history card listed a
 * payment differently from the modal that sent it: the same "the screen
 * disagrees with the wallet" complaint, one screen removed.
 *
 * Derives its order from `results` alone. `sendBoost` guarantees
 * `results[i].recipient` IS `value.recipients[i]` on every path (including the
 * keysend upgrade, which re-stamps the feed's recipient), so there's no second
 * array for a caller to pass out of sync.
 */
export function storedBoostLegs(results: BoostResult[]): StoredBoostLeg[] {
  return recipientOrder(results.map((r) => r.recipient)).map((i) => {
    const r = results[i];
    return {
      recipient: r.recipient.address,
      recipientName: r.recipient.name,
      sats: r.sats,
      ok: r.ok,
      indeterminate: r.indeterminate,
      error: r.error,
      boostboxUrl: r.boostboxUrl,
    };
  });
}

/**
 * Distribute total sats across recipients by split weight, using the
 * largest-remainder (Hamilton) method: floor every share, then hand the
 * leftover sats out one at a time to the recipients whose exact share was
 * rounded down the most (fee recipients broken last on a tie).
 *
 * The naive "floor everyone, dump all remainder on the first recipient"
 * approach silently mispays small splits: a 100-sat boost to a 98%/1%/1%
 * block whose 1% legs are really ~0.8% floors both to 0 sats, then sends the
 * whole 100 to the artist and nothing to the other two. Largest-remainder
 * gives those legs their 1 sat each (→ 98/1/1) instead.
 *
 * Finally, every weighted recipient is guaranteed at least 1 sat — that's the
 * whole reason for the 100-sat minimum boost. If largest-remainder still left
 * a positive-weight recipient at 0, pull the make-up sat from the largest
 * allocation (which never drops below 1), so the total is preserved. When
 * there are more recipients than sats to go round it tops up as many as it
 * can and leaves the rest at 0.
 */
export function splitSats(total: number, recipients: ValueRecipient[]): number[] {
  // Clamp weights at 0: a malformed feed with a negative `split` would
  // otherwise poison totalWeight (even flip it negative) and produce nonsensical
  // — including negative — allocations.
  const w = (r: ValueRecipient) => Math.max(0, r.split || 0);
  const totalWeight = recipients.reduce((s, r) => s + w(r), 0);
  if (totalWeight === 0) return recipients.map(() => 0);
  const exact = recipients.map((r) => (total * w(r)) / totalWeight);
  const allocated = exact.map((x) => Math.floor(x));
  let remainder = total - allocated.reduce((a, b) => a + b, 0);
  if (remainder > 0) {
    const order = recipients
      .map((_, i) => i)
      .sort((a, b) => {
        const frac = exact[b] - allocated[b] - (exact[a] - allocated[a]);
        if (Math.abs(frac) > 1e-9) return frac;
        // Tie on fractional part: prefer non-fee recipients.
        return (recipients[a].fee ? 1 : 0) - (recipients[b].fee ? 1 : 0);
      });
    for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
      allocated[order[k]] += 1;
    }
  }
  // Floor of 1 sat per weighted recipient. Taking from the largest allocation
  // (only ever one with >1 sat) keeps the total constant and can't create a
  // new zero, so this terminates.
  const needy = () =>
    recipients.findIndex((r, i) => w(r) > 0 && allocated[i] === 0);
  for (let i = needy(); i !== -1; i = needy()) {
    let maxIdx = -1;
    for (let j = 0; j < allocated.length; j++) {
      if (allocated[j] > 1 && (maxIdx === -1 || allocated[j] > allocated[maxIdx])) maxIdx = j;
    }
    if (maxIdx === -1) break; // not enough sats to give everyone a sat
    allocated[maxIdx] -= 1;
    allocated[i] += 1;
  }
  return allocated;
}

/**
 * The `<podcast:valueTimeSplit>` window covering a playback position, or null.
 *
 * **Half-open — [startTime, startTime + duration).** Adjacent splits in a real
 * music show abut exactly: track B's `startTime` is the second track A's
 * duration runs out. An inclusive end puts that second inside two windows at
 * once, and since this returns the FIRST match, the boundary second would pay
 * the outgoing artist for the incoming one's audio. A zero-length window
 * therefore matches nothing, which is load-bearing rather than incidental:
 * `live-value.ts` synthesises live targets with `duration: 0` because a live
 * stream has no time base to anchor a window to, and `allocationAt` resolves
 * those by polling the feed above this call. A zero-length window that matched
 * its own start would route a pre-recorded position to a live artist.
 *
 * **It lives here, not in `lib/v4v/streaming.ts`, because two callers must not
 * drift.** The streaming engine credits per-second accrual by this rule and the
 * boost modal picks a payment target by it. If they disagree by one second at a
 * boundary, a boost pays one artist while streaming credits another — for the
 * same moment of the same episode, with nothing on screen saying so. Same
 * argument that moved `trackBucket` into `stream-ledger.ts`. `check:vts` pins
 * the boundaries.
 *
 * Feed data is third-party, so a malformed window (negative or absent duration)
 * simply never matches rather than throwing.
 */
export function splitAtPosition<T extends { startTime: number; duration: number }>(
  splits: readonly T[] | null | undefined,
  positionSec: number,
): T | null {
  if (!splits?.length || !Number.isFinite(positionSec)) return null;
  for (const s of splits) {
    const start = s.startTime;
    const dur = s.duration;
    if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
    if (positionSec >= start && positionSec < start + dur) return s;
  }
  return null;
}

/**
 * Divide a boost between the track a valueTimeSplit redirects to and the show
 * that redirected it.
 *
 * `remotePercentage` is the share the publisher sent to the remote item; the
 * remainder is still the show's (a valueTimeSplit *redirects* part of the
 * value, it doesn't replace it). Absent means the whole redirect — that is the
 * spec default, and it is also what a feed that just doesn't write the
 * attribute means.
 *
 * **Floor, never round.** Rounding up hands out a sat the user didn't authorise
 * and makes the two legs sum to more than the boost.
 *
 * **The show's share is paid even when it is tiny** — 100 sats at 97% is 97 to
 * the artist and 3 to the show, full stop. An earlier version folded a
 * too-small remainder back into the track, because 3 sats across a four-payee
 * show block leaves one payee at zero and `payOne` reports a zero-sat leg as
 * `ok: true` — a ✓ beside someone who received nothing. But that solved a
 * *display* problem by changing where money went, and it made a 100-sat boost
 * pay the show nothing at all, which is not what the feed asked for.
 * `payableSplit` fixes the actual problem instead, by not creating the zero-sat
 * leg. The only fold left is the one with nowhere else to go: a show with no
 * value block at all.
 *
 * Shared by `<BoostModal>` and `<BoostAllModal>` so the same feed can't be paid
 * two different ways depending on which button was pressed. `check:vts` pins it.
 */
export function splitTrackAndHost(args: {
  totalSats: number;
  remotePercentage: number | undefined;
  hostRecipientCount: number;
}): { trackSats: number; hostSats: number } {
  const total = Math.max(0, Math.floor(args.totalSats || 0));
  if (total <= 0) return { trackSats: 0, hostSats: 0 };

  const raw = args.remotePercentage;
  const pct = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw!)) : 100;

  const trackSats = Math.floor((total * pct) / 100);
  const hostSats = total - trackSats;

  // Nobody to pay the remainder to.
  if (hostSats > 0 && args.hostRecipientCount <= 0) return { trackSats: total, hostSats: 0 };
  return { trackSats, hostSats };
}

/**
 * The recipients an amount can actually pay, and what each gets.
 *
 * `splitSats` guarantees every positive-weight recipient at least one sat by
 * pulling make-up sats from the largest allocation — but it can only do that
 * while there is a larger allocation to pull from, and when there isn't it
 * gives up silently and leaves those recipients at zero (`maxIdx === -1;
 * break`). That is the honest arithmetic; three sats cannot be four payments.
 * The damage happens one layer down: `payOne` returns `ok: true` for a zero-sat
 * leg without contacting anyone, so the modal renders a ✓ and the boost log
 * records a payment, for a recipient who received nothing.
 *
 * So drop them from the leg rather than paying them zero. The remaining
 * recipients are re-split so the amount is spent on payees who can receive it
 * — 3 sats to a four-payee block becomes one sat each to the three largest,
 * not 1/1/1/0. One re-split always settles: every kept recipient has at least
 * one sat, so `kept.length <= total`, which is exactly the condition under
 * which `splitSats`' floor can satisfy everyone. The loop is bounded anyway.
 *
 * Deliberately NOT applied to a boost's primary leg, which is the whole amount
 * and is gated by the 100-sat minimum. This exists for the derived leg — a
 * `remotePercentage` remainder is arbitrarily small by construction.
 */
export function payableSplit(
  totalSats: number,
  recipients: ValueRecipient[],
): { recipients: ValueRecipient[]; splits: number[] } {
  let kept = recipients;
  for (let pass = 0; pass < 4; pass++) {
    const splits = splitSats(totalSats, kept);
    const payable = kept.filter((_, i) => splits[i] > 0);
    if (payable.length === kept.length || payable.length === 0) return { recipients: kept, splits };
    kept = payable;
  }
  return { recipients: kept, splits: splitSats(totalSats, kept) };
}

// FNV-1a hash → a stable non-negative 31-bit integer, for deterministic numeric
// IDs (e.g. synthesizing an Episode.id from a guid) that survive reloads.
export function fnvHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff;
}

// True when an enclosure URL is an HLS playlist (`.m3u8`). HLS needs hls.js
// (or native Safari support) and a <video> surface — not the native <audio>
// element the rest of the app uses. Nostr live streams (kind:30311) carry HLS
// URLs in their `streaming` tag.
export function isHlsUrl(url: string | undefined | null): boolean {
  return !!url && /\.m3u8(\?|#|$)/i.test(url);
}

// Whether an alternate enclosure is a video rendition. Covers progressive video
// (`video/mp4`, `video/webm`), HLS delivered with an mpegurl content type
// (`application/x-mpegurl` / `application/vnd.apple.mpegurl` — Fountain uses this
// for some video feeds), and an untyped `.m3u8` source. Excludes anything
// explicitly tagged `audio/…`.
function isVideoAlternate(a: AlternateEnclosure): boolean {
  if (!a.source) return false;
  const t = a.type?.toLowerCase() ?? '';
  if (t.startsWith('audio/')) return false;
  if (t.startsWith('video/') || t.includes('mpegurl')) return true;
  // No (or an unhelpful) type — infer from the source URL: an HLS playlist or a
  // known video container extension. Guards feeds that under-tag their <source>.
  if (!t.startsWith('image/') && !t.startsWith('text/')) {
    return isHlsUrl(a.source) || /\.(mp4|m4v|mov|webm|mkv|ogv)(\?|#|$)/i.test(a.source);
  }
  return false;
}

// The best video <podcast:alternateEnclosure> for an episode, or undefined when
// there's no video rendition. Prefers the publisher's `default`, then the
// highest-resolution variant, then the first listed. Drives the "Video" toggle
// in the player — a video rendition plays through the shared <video> element the
// HLS path already uses (progressive video plays natively; HLS via hls.js).
export function pickVideoAlternate(ep: Pick<Episode, 'alternateEnclosures'>): AlternateEnclosure | undefined {
  const videos = ep.alternateEnclosures?.filter(isVideoAlternate);
  if (!videos?.length) return undefined;
  return (
    videos.find((a) => a.default) ??
    [...videos].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]
  );
}

// Picture-in-Picture across the two web APIs: the standard `requestPictureInPicture`
// (Android Chrome, desktop Chrome/Edge/Firefox/Safari) and WebKit's
// `webkitSetPresentationMode` (iOS Safari, which doesn't implement the standard
// one). Only matters for the HLS <video> path — the native <audio> the rest of
// the app uses can't go into PiP. PiP also keeps a stream's audio playing while
// the app is backgrounded on mobile, so it doubles as background audio for video.
type WebkitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

export function pipSupported(el: HTMLVideoElement | null): boolean {
  if (!el || typeof document === 'undefined') return false;
  if (document.pictureInPictureEnabled && !el.disablePictureInPicture) return true;
  const w = el as WebkitVideo;
  return (
    typeof w.webkitSupportsPresentationMode === 'function' &&
    w.webkitSupportsPresentationMode('picture-in-picture')
  );
}

// Toggle PiP for the given <video>. Prefers the standard API, falls back to
// WebKit. Swallows errors (a missing user gesture / not-allowed throws and is
// not worth surfacing).
export async function togglePip(el: HTMLVideoElement | null): Promise<void> {
  if (!el || typeof document === 'undefined') return;
  if (document.pictureInPictureEnabled && !el.disablePictureInPicture) {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch { /* user gesture / not-allowed — silent */ }
    return;
  }
  const w = el as WebkitVideo;
  if (typeof w.webkitSetPresentationMode === 'function') {
    try {
      w.webkitSetPresentationMode(
        w.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture',
      );
    } catch { /* silent */ }
  }
}

// Coerce an unknown thrown value into a user-readable string. Use for the
// fallback in `catch (e) { return { error: getErrorMessage(e, '<x> failed') } }`
// patterns in API routes and UI handlers.
export function getErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

/**
 * A feed-supplied URL, validated as http(s) — else null. Same allowlist
 * direction as `safeUrlAttr`: it resolves what a browser would actually see
 * (the WHATWG parser normalizes entity/whitespace obfuscation and decimal host
 * forms) and requires the result to BE http/https, rather than enumerating bad
 * schemes. `<link>` and friends come from arbitrary third-party feeds, so
 * anything derived from them — an `href` we render, a URL we publish into a
 * public Nostr note — goes through here first.
 *
 * Returns the parser's normalized form, not the raw string, so a value that
 * only parses because the parser strips tab/CR/LF can't be re-emitted with
 * those characters intact.
 */
export function httpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * What ships as the boostagram's `sender_name` (and lands in the Nostr note
 * body) when the user has no name to send — either they left "From" empty or
 * they picked "Anonymous". A real default, NOT just the input's ghost text:
 * omitting the field entirely left presentation up to each recipient's
 * aggregator, so the same boost showed as blank in one client and "Unknown" in
 * another.
 *
 * **It lives here, not in `components/boost-modal/sender-name.tsx`, because
 * `lib/v4v/streaming.ts` needs it.** That module is inside the v4v swap-out
 * boundary, which exists so `lib/v4v/*` can be replaced wholesale without
 * touching `components/` — an import pointing the other way inverts it, and
 * drags a `'use client'` React component module into the payment engine.
 * `sender-name.tsx` re-exports this, so the modals' import sites are unchanged.
 * It belongs in `lib/util.ts` rather than `lib/v4v/` for the same reason: it is
 * a product string, and swapping the v4v toolkit must not delete it.
 */
export const DEFAULT_SENDER_NAME = 'boostmebitch.com user';

/**
 * The one place "From" becomes a wire value. Anonymous discards the typed name
 * outright rather than trimming it — see the anonymity note in CLAUDE.md's boost
 * flow: the promise covers the payment, not just the Nostr note.
 */
export function resolveSenderName(typed: string, anonymous: boolean): string {
  return (anonymous ? '' : typed.trim()) || DEFAULT_SENDER_NAME;
}

// Strip HTML tags and entity-decode. Used by server components (lib/format.tsx
// is 'use client' so can't be imported on the server side). Pure string regex,
// no DOM required — isomorphic.
export function stripHtml(s: string): string {
  return s
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
