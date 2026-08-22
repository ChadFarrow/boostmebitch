import type {
  Podcast, ValueBlock, ValueRecipient, Episode, AlternateEnclosure,
  BoostResult, StoredBoostLeg, ChapterEntry, ValueTimeSplit,
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
  return elideAddress(r.address, isLnAddressRecipient(r));
}

/**
 * The elision itself, for callers that hold an address WITHOUT its recipient.
 *
 * `StoredBoost.legs` is the one — a leg records `recipient` as a bare string
 * with no `type`, so `<BoostCard>` can't call `recipientAddress` and grew its
 * own `shortAddr` instead: `6…4` against this function's `8…8`, and
 * `.includes('@')` against `isLnAddressRecipient`. The result was that
 * <SplitsPreview> showed a pubkey as `03ae9f2b…41d4f2a1` while the permanent
 * history card for THAT SAME PAYMENT showed `03ae9f…f2a1`. Someone checking
 * where their sats went saw two different strings for one recipient.
 *
 * CLAUDE.md names this exact failure for a copy that used to live in
 * lists.tsx. One elision, one place — pass `isLnAddress` when you know it.
 */
export function elideAddress(address: string, isLnAddress = address.includes('@')): string {
  if (isLnAddress || address.length <= 20) return address;
  return `${address.slice(0, 8)}…${address.slice(-8)}`;
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
 * How a feed's items are ordered for display: a music album sorts by disc
 * (`<podcast:season>`) then track (`<podcast:episode>`) ASCENDING; everything
 * else sorts newest-first by `datePublished`.
 *
 * Shared because it was written out twice — in `getFeedFromRss` (lib/pi.ts) and
 * in the merge step of app/api/feed/route.ts — with each copy's comment naming
 * the other as the authority ("same rule as /api/feed" / "matches /api/feed").
 * That is two implementations of one rule with no mechanism keeping them equal,
 * and the failure is quiet rather than loud: the same album served through the
 * PI-backed route and through the raw-RSS preview would simply list its tracks
 * in different orders, and nothing would report a fault. Track order is also
 * what the player's prev/next walks, so on a music feed this is the running
 * order of the record.
 *
 * The defaults are load-bearing and deliberately asymmetric. `season ?? 1`
 * treats an untagged item as disc 1 (most albums are single-disc and tag no
 * season at all), while `episode ?? 0` sorts an untagged track to the FRONT of
 * its disc. Don't "tidy" them to match.
 *
 * Returns a comparator rather than sorting, because the API route needs this as
 * the tail of a larger sort that ranks live items above everything else.
 */
export function compareEpisodeOrder(
  isMusic: boolean,
): (a: Pick<Episode, 'season' | 'episode' | 'datePublished'>, b: Pick<Episode, 'season' | 'episode' | 'datePublished'>) => number {
  return (a, b) => {
    if (isMusic) {
      const seasonDiff = (a.season ?? 1) - (b.season ?? 1);
      if (seasonDiff !== 0) return seasonDiff;
      return (a.episode ?? 0) - (b.episode ?? 0);
    }
    return (b.datePublished ?? 0) - (a.datePublished ?? 0);
  };
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
 * One row of the merged episode-contents list: either a track the show played
 * (a `<podcast:valueTimeSplit>` window) or a chapter.
 *
 * The two are kept as distinct variants rather than flattened into a common
 * `{ title, image, startTime }` shape on purpose. A track row carries the
 * `remoteItem` identifiers a favorite is made of; a chapter row carries none and
 * must never be offered one. Making them structurally different is what stops a
 * later edit from hanging a heart on the wrong one — the type simply has no
 * `split` to hand `<FavTrackHeart>` on a chapter row.
 */
export type EpisodeContentRow =
  | {
      kind: 'track';
      startTime: number;
      split: ValueTimeSplit;
      /**
       * The title of the chapter this window absorbed, when it absorbed exactly
       * one and that chapter had a title. **Display fallback only** — see rule 5
       * on `mergeEpisodeContents`. Never an input to the favorite.
       */
      absorbedTitle?: string;
    }
  | { kind: 'chapter'; startTime: number; chapter: ChapterEntry };

/** How close a chapter has to sit to a window before it's read as naming the
 *  same moment. See the note on `mergeEpisodeContents`. */
const CONTENT_DEDUPE_SEC = 2;

/**
 * Interleave the tracks a show played with its chapters into ONE list, in time
 * order — the list the episode page and the fullscreen player both render.
 *
 * **This is a presentational merge and nothing more. A chapter is never mapped
 * to a window.** That distinction is the whole reason this function is shaped
 * the way it is, and it is not a style preference — it was measured. On
 * *Mutton, Mead & Music* 150 the episode publishes 15 windows against 25
 * chapters: ten of the chapters are the host's own talk breaks, two chapters
 * tie on a `28:20` start with the tie resolving to the talk break, and a talk
 * break at `33:49` falls INSIDE the `28:21`–`33:50` window. So both of the
 * obvious mappings — "the chapter nearest this window" and "the window covering
 * this chapter" — attach a row to a song it isn't naming. A favorite is an
 * irreversible write to a kind:10333 list other apps read, so a silently wrong
 * one is the expensive kind of wrong.
 *
 * What this does instead is put both sources on one timeline and let each row
 * keep its own provenance. A track row is built from a window and carries that
 * window; a chapter row is built from a chapter and carries no identifiers at
 * all. `<FavTrackHeart>` reads the window object, exactly as it did when the
 * tracks had a tab of their own.
 *
 * Five rules, in descending order of how much they cost to break:
 *
 * 1. **Every window becomes a row, always.** Windows are never deduped against
 *    each other and never dropped. Dropping one removes a heart, and it does so
 *    invisibly — the row it collided with still looks like the song.
 * 2. **Only a chapter may be dropped.** A chapter within `toleranceSec` of some
 *    window's start is naming the same moment as that window, and the window is
 *    the half carrying the identifiers, so the chapter goes. Reverse this and
 *    every song the host also chaptered loses its heart — which on a music show
 *    is most of them.
 * 3. **A tolerance, not exact equality**, and the live feed is emphatic about
 *    it. Homegrown Hits 146 publishes 14 windows against 31 chapters, and every
 *    one of the 14 has a chapter within **0.445 s** — because Podcast Index
 *    hands back integer `startTime`s while the chapters JSON is fractional
 *    (`34` against `33.778`, `351` against `350.981`, `1149` against
 *    `1148.691`). Exactly ONE pair matches exactly. So exact-equality dedupe
 *    leaves thirteen duplicate pairs standing, one row of each pair carrying a
 *    heart and the other not, both naming the same song. The other direction is
 *    bounded too: the closest two distinct chapters on that episode are 14 s
 *    apart, so 2 s cannot over-merge.
 * 4. **A track sorts ahead of a chapter at the same second**, so the row with
 *    the heart is the one the eye lands on. The sort is otherwise stable, so
 *    feed order survives among equal starts.
 * 5. **An absorbed chapter leaves its title behind, and only its title.** The
 *    window at `5046` on that episode is one Podcast Index hasn't crawled, so
 *    it renders as *"Track not yet indexed"* — while the chapter at `5045.605`
 *    that rule 2 just dropped is titled *"Shanti"*. Discarding that is a
 *    regression against the chapters list this replaces, so the row keeps it as
 *    `absorbedTitle` and the component prefers `split.title` over it.
 *    **Guarded on the pairing being unambiguous**: a chapter is absorbed by its
 *    NEAREST window, and a window that absorbed more than one publishes no
 *    title at all. That is the *Mutton, Mead & Music* case — two chapters tied
 *    on `28:20`, one a talk break and one the song — where any pick is a coin
 *    flip. **This is decoration and cannot reach a favorite**: the heart is
 *    built from `remoteItem`, which is untouched here, so the worst a bad
 *    borrow can do is mislabel a row, never mis-favorite one.
 *
 * Malformed feed data is skipped rather than thrown on, the same posture
 * `splitAtPosition` takes: a non-finite `startTime` matches no tolerance test
 * and sorts last.
 *
 * `check:vts` pins all of it against the real 14-window/31-chapter wire arrays,
 * including a `naive()` pass that fails the run if the window-dropping or
 * exact-equality versions would have survived the vectors.
 */
export function mergeEpisodeContents(
  splits: readonly ValueTimeSplit[] | null | undefined,
  chapters: readonly ChapterEntry[] | null | undefined,
  toleranceSec: number = CONTENT_DEDUPE_SEC,
): EpisodeContentRow[] {
  const windows = splits ?? [];
  const tol = Number.isFinite(toleranceSec) ? Math.abs(toleranceSec) : CONTENT_DEDUPE_SEC;

  // Rule 1: every window, unconditionally. No dedupe pass runs over these.
  const rows: EpisodeContentRow[] = windows.map((split) => ({
    kind: 'track' as const,
    startTime: split.startTime,
    split,
  }));
  // Which chapters each window swallowed, by window index — rule 5 needs the
  // COUNT, not just the first, so an ambiguous pairing can decline to borrow.
  const absorbed: (ChapterEntry[] | undefined)[] = [];

  // Rule 2/3: a chapter survives only if no window is naming its moment, and it
  // is absorbed by the NEAREST such window. A non-finite start on either side
  // fails the comparison and so keeps the chapter, which is the safe direction
  // — an extra row, never a missing heart.
  for (const chapter of chapters ?? []) {
    let nearest = -1;
    let bestGap = Infinity;
    if (Number.isFinite(chapter.startTime)) {
      windows.forEach((w, i) => {
        if (!Number.isFinite(w.startTime)) return;
        const gap = Math.abs(w.startTime - chapter.startTime);
        if (gap <= tol && gap < bestGap) {
          bestGap = gap;
          nearest = i;
        }
      });
    }
    if (nearest < 0) {
      rows.push({ kind: 'chapter', startTime: chapter.startTime, chapter });
    } else {
      (absorbed[nearest] ??= []).push(chapter);
    }
  }

  // Rule 5. Exactly one absorbed chapter, and it has a title, or nothing is
  // borrowed — a window that swallowed two chapters cannot tell which of them
  // named the song.
  absorbed.forEach((list, i) => {
    const row = rows[i];
    if (row?.kind !== 'track' || list?.length !== 1) return;
    const title = list[0].title;
    if (title) row.absorbedTitle = title;
  });

  // Rule 4. `Array.prototype.sort` is stable per spec, so equal keys keep the
  // order built above — windows in feed order, then chapters in feed order.
  // Non-finite starts compare false either way and settle at the end.
  return rows.sort((a, b) => {
    const av = Number.isFinite(a.startTime) ? a.startTime : Infinity;
    const bv = Number.isFinite(b.startTime) ? b.startTime : Infinity;
    if (av !== bv) return av - bv;
    if (a.kind === b.kind) return 0;
    return a.kind === 'track' ? -1 : 1;
  });
}

/**
 * The name the merged tracks+chapters tab wears, and the count beside it.
 *
 * **Chapters win when the episode has any**, because chapters are what that
 * list is mostly made of and a window is the rarer thing. The precedence used to
 * run the other way — any window at all renamed the tab `Tracks` — and on
 * *Chad and Reeds* 002 that reads as a lie: one `<podcast:valueTimeSplit>`
 * against a dozen-plus chapters rendered **`TRACKS (1)`** above a list of
 * chapters, so the count named 1/14th of the rows and the noun named none of
 * them. A pure music episode publishing windows and no chapters still says
 * `Tracks`, which is the only case where that word describes the whole list.
 *
 * **The count is never the merged row count.** `Chapters (31)` on 14 songs and
 * 17 talk breaks claims 31 chapters; the label and the number have to name the
 * same thing or the number is worse than absent.
 *
 * Shared by `<EpisodeDetailView>` and `<FullscreenPlayer>`, which held identical
 * copies of the expression — two tab strips over one `<EpisodeContents>` list is
 * exactly the shape that drifts into naming the same rows two different ways.
 */
export function episodeContentsLabel(
  splits: readonly ValueTimeSplit[] | null | undefined,
  chapters: readonly ChapterEntry[] | null | undefined,
): string {
  const chapterCount = chapters?.length ?? 0;
  return chapterCount
    ? `Chapters (${chapterCount})`
    : `Tracks (${splits?.length ?? 0})`;
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
/**
 * Canonical deep link to a show: the site ROOT with `?podcast=<guid>`. Null
 * when there's no guid (nothing stable to link to) or during SSR.
 *
 * **The root, not the current pathname**, and that distinction is the whole
 * function. `?podcast=` is restored by exactly one thing — `<HomePage>`'s
 * mount effect, which only ever runs on `/`. Every other route ignores it. So
 * `origin + pathname`, which is what this shipped as, produces a link that
 * opens the page the sharer happened to be standing on and silently drops the
 * show: `/npub/<npub>?podcast=…` renders a boost explorer, `/favorites?podcast=…`
 * renders a favorites list. The bug is invisible to the person sharing,
 * because the copy succeeds and the URL looks right.
 *
 * It reaches every route, not just the one you would guess: `<FullscreenPlayer>`
 * is mounted in `app/layout.tsx`, so its SHARE button is live wherever the user
 * is while something plays.
 *
 * Lives here rather than in either component because both need it and
 * `fullscreen-player` importing from `lists` is the component-to-component edge
 * that already caused one module cycle in this repo (podroll ↔ lists, fixed by
 * moving <FavHeart> out). Two private `ShareButton` copies had already drifted
 * into two different URLs for the same show before it was centralized here.
 */
export function showShareUrl(podcastGuid: string | undefined): string | null {
  if (!podcastGuid || typeof window === 'undefined') return null;
  const url = new URL('/', window.location.origin);
  url.searchParams.set('podcast', podcastGuid);
  return url.toString();
}

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

// Whether WE need to draw a PiP button over a large <video>. Chrome and Firefox
// paint their OWN Picture-in-Picture control on hover over any sizeable video —
// both implement the standard API, and both paint that overlay whether or not
// the element carries `controls` — so our button lands as a second, identical
// icon in the same corner. Safari (desktop and iOS) implements only
// webkitSetPresentationMode and paints nothing without `controls`, so there the
// button is the only way in.
//
// `disablepictureinpicture` would suppress the browser's overlay, but it also
// disables the very API our button calls, so hiding ours is the only lever.
//
// This is for the big fullscreen stage only. The 48px mini-bar thumbnail is far
// below the size at which browsers paint their overlay, so it keeps using
// `pipSupported`.
export function pipNeedsOwnButton(el: HTMLVideoElement | null): boolean {
  if (!el || typeof document === 'undefined') return false;
  if (document.pictureInPictureEnabled && !el.disablePictureInPicture) return false;
  const w = el as WebkitVideo;
  return (
    typeof w.webkitSupportsPresentationMode === 'function' &&
    w.webkitSupportsPresentationMode('picture-in-picture')
  );
}

// Native fullscreen for the video stage. Two APIs again: the standard
// `Element.requestFullscreen` (desktop, Android, iPadOS) and WebKit's prefixed
// `webkitRequestFullscreen`. iPhone Safari implements NEITHER for arbitrary
// elements — only `video.webkitEnterFullscreen()`, which hands off to the native
// iOS player — hence the two-element signature.
//
// The STAGE goes fullscreen rather than the <video>, so our own overlay controls
// (tap-to-play, PiP, the exit button) ride along on top of the picture. The iOS
// fallback loses them, which is fine: iOS owns that UI and its Done button exits.
type WebkitFsElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type WebkitFsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};
type WebkitFsVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

export function fullscreenElement(): Element | null {
  if (typeof document === 'undefined') return null;
  return document.fullscreenElement ?? (document as WebkitFsDocument).webkitFullscreenElement ?? null;
}

export function fullscreenSupported(
  stage: HTMLElement | null,
  video: HTMLVideoElement | null,
): boolean {
  if (typeof document === 'undefined') return false;
  if (document.fullscreenEnabled && stage?.requestFullscreen) return true;
  if (typeof (stage as WebkitFsElement | null)?.webkitRequestFullscreen === 'function') return true;
  return typeof (video as WebkitFsVideo | null)?.webkitEnterFullscreen === 'function';
}

export async function exitFullscreen(): Promise<void> {
  if (!fullscreenElement()) return;
  const d = document as WebkitFsDocument;
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else d.webkitExitFullscreen?.();
  } catch { /* silent */ }
}

export async function toggleFullscreen(
  stage: HTMLElement | null,
  video: HTMLVideoElement | null,
): Promise<void> {
  if (typeof document === 'undefined') return;
  if (fullscreenElement()) return exitFullscreen();
  const s = stage as WebkitFsElement | null;
  try {
    if (document.fullscreenEnabled && s?.requestFullscreen) {
      await s.requestFullscreen();
      return;
    }
    if (typeof s?.webkitRequestFullscreen === 'function') {
      s.webkitRequestFullscreen();
      return;
    }
  } catch { /* fall through to the iPhone video-only path */ }
  (video as WebkitFsVideo | null)?.webkitEnterFullscreen?.();
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
 * Extensions a Nostr client will render inline when it meets a bare URL in a
 * note body. The list is the intersection of what the common clients accept;
 * `?query` is tolerated because CDNs sign and size artwork that way.
 *
 * **This lives here, not in `lib/format.tsx`, because `lib/nostr/boost-notes.ts`
 * needs it too** — that module writes the note, `format.tsx` reads it back, and
 * a second copy is how the writer comes to emit a URL the reader renders as a
 * plain link. `format.tsx` is a `'use client'` React module, so importing it
 * from inside the Nostr boundary would drag React into it (the same inversion
 * `DEFAULT_SENDER_NAME` caused before it moved here).
 */
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp)(\?[^\s]*)?$/i;

/** True when a URL ends in an image extension a note reader will render. */
export function isImageUrl(url: string): boolean {
  return IMAGE_EXT_RE.test(url);
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

// Bare http(s) URLs in running text. `<`, `>`, quotes and backtick terminate a
// match so this can be run over a segment of already-sanitized show-notes HTML
// without ever eating into a tag.
const BARE_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
// Sentence punctuation a feed wrote AFTER the URL, not part of it. A closing
// bracket only counts as punctuation when nothing opened it inside the URL —
// plenty of real links (Wikipedia, docs anchors) carry balanced pairs.
const URL_TAIL_RE = /[.,;:!?'"]/;

function trimUrlTail(url: string): string {
  let end = url.length;
  for (; end > 0; end--) {
    const c = url[end - 1];
    if (URL_TAIL_RE.test(c)) continue;
    if (c === ')' && !url.slice(0, end).includes('(')) continue;
    if (c === ']' && !url.slice(0, end).includes('[')) continue;
    break;
  }
  const trimmed = url.slice(0, end);
  // Require something after the scheme — a lone "https://" is not a link.
  return /^https?:\/\/[^/?#]/i.test(trimmed) ? trimmed : '';
}

/**
 * Split plain text into alternating segments: EVEN indices are the text
 * between links, ODD indices are bare http(s) URLs. Mirrors the
 * split-with-capture idiom `linkifyNostrRefs` uses, and is the same shape both
 * consumers want — `sanitizeShowNotes` wraps the odd segments in `<a>` on the
 * server, `<LinkedText>` renders them as anchors on the client.
 *
 * **It is shared rather than written twice on purpose.** The same episode's
 * notes reach the screen two ways — as sanitized `contentEncoded` HTML on the
 * episode page, and as `stripHtml`'d plain `description` in the fullscreen
 * player's About pane — so two copies of "what counts as a URL" means the same
 * link is clickable on one screen and dead text on the other, which reads as a
 * broken app rather than a formatting difference.
 *
 * Punctuation the feed wrote after a URL stays in the FOLLOWING text segment,
 * so nothing is lost: `join('')` reproduces the input exactly.
 */
export function splitOnBareUrls(text: string): string[] {
  const re = new RegExp(BARE_URL_RE.source, 'gi');
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const url = trimUrlTail(m[0]);
    if (!url) continue;
    out.push(text.slice(last, m.index), url);
    last = m.index + url.length;
  }
  out.push(text.slice(last));
  return out;
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
