import { nip19 } from 'nostr-tools';
import type { Event, EventTemplate } from 'nostr-tools';
import type { Boostagram, Episode, FeedNpub, Podcast, BoostResult } from '../types';
import { httpUrl } from '../util';
import type { QuotedZapReceipt } from './zap-receipt-wait';
import { BRAND, clientTag } from '../brand';
import { DEFAULT_RELAYS } from './relays';
import { signAndPublish, publishSignedEvent, type PublishedNote } from './publish';
import { noteMentionTags, type MentionNpub, inlineMentions, withMentionRun } from './mention-tags';

interface PublishArgs {
  podcast: Podcast;
  episode?: Episode;        // omit for show-level boosts
  boostagram: Boostagram;
  results: BoostResult[];
  relays?: string[];
  /** Override the note body. Otherwise we auto-format. */
  contentOverride?: string;
  /**
   * People the SENDER named with an @mention, on top of the ones the feed
   * declares for itself.
   *
   * Whether these become `p` tags is not a caller's decision and deliberately
   * has no field here — it follows from which publish function is used. See
   * noteMentionTags.
   */
  mentions?: MentionNpub[];
}

/**
 * Best public listen-link for what was boosted, in preference order:
 *  1. the EPISODE's own web page (RSS `<link>`, via PI's `link` or the RSS
 *     pass) when boosting an episode — a boost note should land the reader on
 *     that episode, not the show's front door.
 *  2. the item guid when it's an http(s) URL. RSS defines `<guid>` as a
 *     permalink unless `isPermaLink="false"` says otherwise, and plenty of
 *     feeds (Bowl After Bowl among them) use the episode page URL verbatim.
 *     We don't parse that attribute, so this is a heuristic — but it only runs
 *     when the feed published no `<link>` at all, where the alternative is
 *     dropping the reader on the show, and the `?p=123`-style guids that set
 *     isPermaLink="false" still redirect to the post.
 *  3. pod.link smart-link by Apple iTunes ID — auto-routes the visitor to
 *     their preferred podcast app on click
 *  4. Podcast Index page — human-readable feed metadata
 *  5. raw RSS feed URL
 *
 * Both episode sources are feed-supplied, so both are http(s)-validated before
 * going in a public note. Levels 3–5 are show-level: neither pod.link nor PI
 * has an episode URL constructible from a guid (pod.link's episode paths key
 * on an id of their own), so a feed with neither a `<link>` nor a URL guid
 * falls back to the show here. The BMB link below stays episode-specific
 * either way.
 */
function podcastLandingUrl(podcast: Podcast, episode?: Episode): string | null {
  const episodePage = httpUrl(episode?.link) ?? httpUrl(episode?.guid);
  if (episodePage) return episodePage;
  if (podcast.itunesId) return `https://pod.link/${podcast.itunesId}`;
  if (podcast.id) return `https://podcastindex.org/podcast/${podcast.id}`;
  return podcast.url ?? null;
}

/**
 * BoostMeBitch in-app deep link. Episode-specific when boosting an episode:
 * `?podcast=<guid>&episode=<guid>` is a restorable view per the URL contract
 * (components/home-page.tsx hydrates it), and app/page.tsx emits episode-level
 * Open Graph tags for it, so the unfurl shows the episode's own title and art.
 * Emitted alongside the listen-link (not as a replacement) so readers get both
 * affordances: listen elsewhere, or boost back here.
 *
 * The episode guid is encodeURIComponent'd — unlike the podcast guid (a UUID),
 * it's an arbitrary feed-chosen string and is routinely a URL.
 *
 * The `www` host is deliberate and must match app/layout.tsx's metadataBase:
 * the apex 307-redirects here, and this URL is written into a signed, immutable
 * kind:1 — an unfurler that doesn't follow the redirect gets no card at all,
 * and every note already published carries whichever host we chose forever.
 */
function bmbLandingUrl(podcast: Podcast, episode?: Episode): string | null {
  if (!podcast.podcastGuid) return null;
  const url = `${SITE_ORIGIN}/?podcast=${podcast.podcastGuid}`;
  return episode?.guid ? `${url}&episode=${encodeURIComponent(episode.guid)}` : url;
}

/**
 * The artwork this boost note shows, in preference order: the episode's own
 * image, the show image the feed put on the item, then the show's two
 * channel-level images (RSS `<image><url>` first, `<itunes:image>` second — the
 * same pair, in the same order, that `<PodcastCover>` tries on screen).
 *
 * Feed-supplied, so http(s)-validated before it goes anywhere public. It is
 * deliberately NOT gated on an image extension here: this URL is handed to the
 * banner route as a parameter, and that route fetches it and checks the real
 * `Content-Type`, which is the honest test. An extension only matters for a URL
 * a CLIENT must recognize on sight, and the client only ever sees the banner.
 *
 * **Every candidate is sent, not just the first, because the first one is
 * routinely unusable and nothing here can tell.** `<PodcastCover>` already
 * carries this rule on screen ("Always pass both"), and Homegrown Hits is the
 * feed that proves it twice over: its channel `image` is a **404** on a domain
 * that still resolves, and its episode art is a **19 MB animated GIF** — over
 * the route's 2 MB ceiling, which is the same ceiling that stops a feed
 * starving the renderer. One dead, one too big, one fine, and the difference is
 * only visible after a fetch the note-builder never makes. Sending one URL
 * meant a boost to that show drew a bannner with an empty left third.
 *
 * Capped at three: the fourth is a fourth sequential fetch inside a request
 * that has to answer, and the list has only four entries anyway.
 */
const MAX_ART_CANDIDATES = 3;

function boostArtUrls(podcast: Podcast, episode?: Episode): string[] {
  const out: string[] = [];
  for (const c of [episode?.image, episode?.feedImage, podcast.image, podcast.artwork]) {
    const url = httpUrl(c);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= MAX_ART_CANDIDATES) break;
  }
  return out;
}

/**
 * Where a published note's links and banner must point.
 *
 * Per-brand, and each deploy names its OWN origin: a note published from
 * boostmebuddy.com must deep-link back to boostmebuddy.com, and a kind:1 cannot
 * be edited, so the choice is permanent per note. Both origins keep serving
 * `/api/og/boost.png` forever for exactly that reason.
 */
const SITE_ORIGIN = BRAND.origin;

/**
 * The picture the note shows: `/api/og/boost.png`, drawn from the artwork, the
 * sats and the titles.
 *
 * **A bare image URL in the BODY is what renders a picture** — an `imeta` tag
 * describes one the body already names, it does not add one.
 *
 * Why not name the artwork URL directly: a cover is square, and a square in a
 * note column is a tall block that pushes the sats, the show and the message
 * apart. The banner is 4:1 and spends the width the column has. It also removes
 * two dependencies on the feed's own URL — one carrying no image extension is
 * invisible to every client, and a feed with no artwork has nothing to show;
 * both still get a branded banner.
 *
 * The route's path and parameter names are a permanent public contract, because
 * every note ever published names them. See the route for what that forbids.
 *
 * **Always {@link SITE_ORIGIN}, even under `next dev`.** Building it against
 * the dev server so the picture can be previewed before deploy is the obvious
 * convenience and it is wrong twice: the URL is `http://localhost:3000`, which
 * nobody else can resolve, and every serious Nostr client is served over HTTPS,
 * so the browser blocks it as mixed content and shows nothing even on the
 * machine that published it. Measured on jumble.social. Naming the production
 * route instead means a note published before this ships is blank only until
 * the deploy, and correct forever after — the note cannot be edited, so that is
 * the only version of "later" that exists. Preview a design change by fetching
 * the local route directly, not by publishing a note.
 */
function boostBannerUrl(
  podcast: Podcast,
  episode: Episode | undefined,
  boostagram: Boostagram,
): string {
  const params = new URLSearchParams();
  // `art`, then `art2`, then `art3` — the route tries them in order and keeps
  // the first that answers with something it can draw. New names rather than a
  // repeated key: the route's parameters are a permanent public contract, and
  // every note already published names `art` alone.
  const arts = boostArtUrls(podcast, episode);
  arts.forEach((url, i) => params.set(i === 0 ? 'art' : `art${i + 1}`, url));
  if (podcast.title) params.set('title', podcast.title);
  if (episode?.title) params.set('ep', episode.title);
  const sats = Math.round((boostagram.value_msat_total ?? 0) / 1000);
  if (sats > 0) params.set('sats', String(sats));
  return `${SITE_ORIGIN}/api/og/boost.png?${params.toString()}`;
}

/**
 * Append the artwork URL to a note body.
 *
 * Applied to the FINAL content for the same reason `withMentionRun` is:
 * boost-all-modal hand-builds its summary body and passes it as a
 * `contentOverride`, so art added inside `formatContent` would be silently
 * missing from every boost-all note. It sits ABOVE the mentions because a
 * trailing `nostr:npub…` run is what every compose box writes last, and a URL
 * after it reads as part of that line.
 */
function withArt(content: string, art: string | null): string {
  return art ? `${content}\n\n${art}` : content;
}

/**
 * Cap on quoted receipts. A boost with more zap legs than this still pays them
 * all; the note just stops naming them, the same way it stops naming people.
 */
const MAX_QUOTED_RECEIPTS = 4;

/**
 * The zap receipts this note quotes, biggest share first.
 *
 * WHY QUOTE A RECEIPT AT ALL. Fountain renders a boost's sat amount off a quoted
 * kind:9735, not off our `amount` tag and not off the prose — which is why our
 * notes showed the sats as text and nothing else. This repo already reads that
 * shape in the other direction (`buildNote` in ./discover.ts resolves a quoted
 * receipt through `zapReceiptAmountMsat`), so a note we publish this way is read
 * by our own explorer exactly as a Fountain wrapper is.
 *
 * ORDERED BY SETTLED SATS, largest first — not by `recipientOrder`. The first
 * quote is the one a client that renders only one will pick, so it must be the
 * artist's and never a 1-sat fee payee's; but `recipientOrder` ranks by split
 * WEIGHT, and a redirected boost hands this function legs from TWO value blocks
 * whose weights are on different scales, so a show-block fee payee at
 * `split=100` outranked a track artist at `split=50`. Settled sats are an
 * absolute per-payee number and compare across blocks. The sort is stable, so
 * equal legs keep the order they were paid in — which is `recipientOrder`
 * within each block already.
 */
function quotedReceipts(results: BoostResult[]): QuotedZapReceipt[] {
  // Holes are filtered FIRST, and that is not defensive tidiness. The modal's
  // in-flight `results` state is `(BoostResult | undefined)[]` because legs
  // settle biggest-share-first, and `totalMsat` above only walks this array when
  // `value_msat_total` is absent — so a hole reaching here used to be harmless
  // and now would throw inside the note builder, losing the whole note for a
  // boost that had already paid.
  const legs = results
    .filter((r): r is BoostResult => !!r && !!r.zapReceipt)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.sats - a.r.sats || a.i - b.i)
    .map(({ r }) => r);
  const out: QuotedZapReceipt[] = [];
  const seen = new Set<string>();
  for (const leg of legs) {
    const z = leg.zapReceipt!;
    if (seen.has(z.id)) continue;
    seen.add(z.id);
    out.push(z);
    if (out.length >= MAX_QUOTED_RECEIPTS) break;
  }
  return out;
}

/**
 * Append the `nostr:nevent…` reference for each quoted receipt.
 *
 * The BODY reference is the half that matters for interop — Fountain writes its
 * own quote that way and reads it that way, and `parseQuoteRefs` (./discover.ts)
 * exists because a `q`-tag scan alone misses it. The `q` tag goes on the event
 * too; neither replaces the other.
 *
 * Placed below the artwork and above the mention run, for the reason `withArt`
 * gives: the trailing `nostr:npub…` run is what a compose box writes last.
 *
 * `kind: 9735` is carried in the nevent because Fountain's own wrapper notes carry
 * it — read off a real one, event f0416267…50e0 — and it is the half a reader can
 * act on without fetching anything: it says the quote is a payment receipt rather
 * than another note. Fountain ships no relay hints there and we do; that direction
 * is additive, so ours stay.
 */
function withZapReceipts(content: string, receipts: QuotedZapReceipt[]): string {
  if (receipts.length === 0) return content;
  const refs = receipts.map(
    (r) =>
      `nostr:${nip19.neventEncode({
        id: r.id,
        relays: r.relays.slice(0, 3),
        author: r.pubkey,
        kind: 9735,
      })}`,
  );
  return `${content}\n\n${refs.join('\n')}`;
}

/** Cap on how many people one boost note tags. */
const MAX_NOTE_NPUBS = 4;

/**
 * The people this boost note tags — the npubs the feed declared for itself via
 * <podcast:txt purpose="nostr">, episode's first (the track's own artist is the
 * closer match) then the show's, deduped by pubkey.
 *
 * lib/feed-xml.ts already validated and hex-decoded these, and capped each
 * list; the cap is re-applied here because this merges two of them.
 */
/**
 * The npubs a boost note `p`-tags for the FEED, in the order it tags them.
 *
 * Exported because the @-mention picker must offer exactly this set, and it is
 * the one place that knows the answer. Both levels are CONCATENATED, not
 * `??`-chained: an episode declaring its own npub does not displace the show's,
 * and both get tagged. Both modals reproduced that expression by hand as
 * `episode?.nostrNpubs ?? podcast.nostrNpubs`, so on any feed where the episode
 * declared one, the show's npub was tagged on a published note while never
 * appearing in the picker and never being warmed. The picker and the tagger
 * disagreeing is invisible from either side.
 */
export function noteNpubs(podcast: Podcast, episode?: Episode): FeedNpub[] {
  const out: FeedNpub[] = [];
  const seen = new Set<string>();
  for (const n of [...(episode?.nostrNpubs ?? []), ...(podcast.nostrNpubs ?? [])]) {
    if (seen.has(n.pubkey)) continue;
    seen.add(n.pubkey);
    out.push(n);
    if (out.length >= MAX_NOTE_NPUBS) break;
  }
  return out;
}


function formatContent(args: PublishArgs): string {
  const { podcast, episode, boostagram } = args;
  const totalSats = Math.round((boostagram.value_msat_total ?? 0) / 1000);

  const lines: string[] = ['⚡ Boost ⚡', ''];
  if (boostagram.message?.trim()) {
    lines.push(boostagram.message.trim(), '');
  }
  // Attribute the sender by their "From" name when set. Load-bearing for
  // site-signed notes (signed-out users): the note is authored by the site's
  // identity, so without this their name appears nowhere. Natural for the
  // self-signed case too ("ChadF boosted …").
  const sender = boostagram.sender_name?.trim();
  lines.push(`${sender ? `${sender} boosted` : 'Boosted'} ${totalSats} sats → ${podcast.title}`);
  if (episode?.title) lines.push(`📻 ${episode.title}`);
  const link = podcastLandingUrl(podcast, episode);
  if (link) lines.push('', link);
  const bmbLink = bmbLandingUrl(podcast, episode);
  if (bmbLink && bmbLink !== link) lines.push(bmbLink);
  return lines.join('\n');
}

// The unsigned kind:1 boost-note template — shared by the user-signed path
// (signAndPublish, via window.nostr) and the site-signed path (server route).
//
// `selfSigned` is a POSITIONAL argument rather than a field on PublishArgs, and
// that is the point: it is not a caller's choice, it follows from which of the
// two publish functions below was used. A field would let a call site assert
// "this is self-signed" about a note the site is about to sign, which is the
// one thing noteMentionTags exists to prevent. Only those two functions pass
// it, and each passes a literal.
function buildBoostNoteTemplate(args: PublishArgs, selfSigned: boolean): EventTemplate {
  const { podcast, episode, boostagram, results } = args;
  const totalMsat =
    boostagram.value_msat_total ??
    results.reduce((sum, r) => sum + r.sats * 1000, 0);

  // NIP-73 external content tags + boost-specific metadata.
  //
  // The `i` tag carries the show's or item's page on this site as its optional
  // third element — the URL hint NIP-73 allows and Fountain always writes (a
  // fountain.fm show or episode page, on every boost note it publishes). It is
  // a hint for a reader that does not index the guid; nothing here parses it
  // back. `bmbLandingUrl` is the same restorable deep link the `r` tag carries.
  const tags: string[][] = [];
  const showHint = bmbLandingUrl(podcast);
  const itemHint = episode ? bmbLandingUrl(podcast, episode) : null;
  if (podcast.podcastGuid) {
    tags.push(showHint
      ? ['i', `podcast:guid:${podcast.podcastGuid}`, showHint]
      : ['i', `podcast:guid:${podcast.podcastGuid}`]);
    tags.push(['k', 'podcast:guid']);
  }
  if (episode?.guid) {
    tags.push(itemHint
      ? ['i', `podcast:item:guid:${episode.guid}`, itemHint]
      : ['i', `podcast:item:guid:${episode.guid}`]);
    tags.push(['k', 'podcast:item:guid']);
  }
  const linkUrl = podcastLandingUrl(podcast, episode);
  if (linkUrl) tags.push(['r', linkUrl]);
  const bmbUrl = bmbLandingUrl(podcast, episode);
  if (bmbUrl && bmbUrl !== linkUrl) tags.push(['r', bmbUrl]);
  // <podcast:txt purpose="nostr"> — tag the show/track artist so the boost
  // lands in their mentions instead of being a post about them they never see.
  //
  // Deliberately NOT gated on the share picker's "Anonymous": that setting
  // exists to stop the SENDER leaking (it drops sender_id and replaces
  // sender_name), and a `p` tag names the RECIPIENT. An anonymous boost should
  // still reach the artist.
  //
  // Sender-chosen @mentions join them here, but only on the self-signed path —
  // noteMentionTags owns that rule and returns the two lists separately,
  // because a mention the site may not TAG is still written into the body.
  const { tagged, inBody } = noteMentionTags(
    noteNpubs(podcast, episode),
    args.mentions,
    selfSigned,
  );
  for (const n of tagged) tags.push(['p', n.pubkey]);
  // NIP-92: describe the image the body already names, so a client that renders
  // from tags shows the same picture as one that scans the text. `dim` lets it
  // reserve the space before the bytes arrive, which is why the banner has one
  // fixed size rather than the artwork's.
  //
  // The length test mirrors the site-sign route's MAX_TAG_ITEM_LEN. That route
  // rejects the WHOLE template when one tag item is too long, and this URL
  // carries the artwork address and both titles, so a long one is reachable —
  // it would stop a signed-out user's note being published at all. Dropping the
  // tag is the soft failure: the body still names the banner, and every client
  // that scans text still renders it. Keep the two numbers together if either
  // moves.
  const banner = boostBannerUrl(podcast, episode, boostagram);
  if (`url ${banner}`.length <= 512) {
    tags.push(['imeta', `url ${banner}`, 'm image/png', 'dim 1200x300']);
  }
  if (totalMsat > 0) tags.push(['amount', String(totalMsat)]);
  // Same shape `publishQuoteRepost` writes (./interactions.ts): id, relay hint,
  // author. The author is the recipient's LNURL server, which is who signed the
  // receipt — not the payee and not us.
  //
  // `amount` above deliberately stays `value_msat_total`, the whole boost before
  // the value block divides it. A receipt's amount is this leg's settled figure,
  // so the two numbers answer different questions and neither is wrong.
  const receipts = quotedReceipts(args.results);
  for (const r of receipts) tags.push(['q', r.id, r.relays[0] ?? '', r.pubkey]);
  tags.push(clientTag(boostagram.app_name));
  tags.push(['t', 'boostagram']);
  tags.push(['t', 'value4value']);

  return {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    // Inline first, then append only what could not be placed. The two halves
    // are one decision: a mention put where the sender typed it must NOT also
    // appear in the trailing run, or the note names the same person twice.
    content: (() => {
      const body = withArt(args.contentOverride ?? formatContent(args), banner);
      const { content: inlined, remaining } = inlineMentions(body, inBody);
      return withMentionRun(withZapReceipts(inlined, receipts), remaining);
    })(),
  };
}

export async function publishBoostNote(
  args: PublishArgs,
): Promise<PublishedNote> {
  const relays = args.relays ?? DEFAULT_RELAYS;
  // Signed by the user's own key, so a mention they typed is attributable to
  // them and may carry a `p` tag.
  return signAndPublish(buildBoostNoteTemplate(args, true), relays);
}

/**
 * Publish the boost note signed by the SITE's own Nostr identity, for users who
 * aren't signed into Nostr. The unsigned template is sent to /api/nostr/site-sign
 * (which holds the server-only key), and the signed event is published from here
 * to DEFAULT_RELAYS. Throws on a 503 (feature not configured) / 400 / network
 * error — callers (maybePublishNote) already swallow publish failures, so a boost
 * still succeeds even if the note can't be posted.
 */
export async function publishBoostNoteViaSite(
  args: PublishArgs,
): Promise<PublishedNote> {
  // `false`: this template goes to an UNAUTHENTICATED endpoint that signs under
  // the site's NIP-05-verified identity, so the sender's @mentions lose their
  // `p` tags here. The feed's own npubs keep theirs.
  const template = buildBoostNoteTemplate(args, false);
  const res = await fetch('/api/nostr/site-sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(template),
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => null);
    throw new Error(msg?.error ?? `site-sign ${res.status}`);
  }
  const { event } = (await res.json()) as { event: Event };
  return publishSignedEvent(event, DEFAULT_RELAYS);
}
