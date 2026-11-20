import { nip19, finalizeEvent, generateSecretKey } from 'nostr-tools';
import type { Event, EventTemplate } from 'nostr-tools';
import type { Boostagram, Episode, FeedNpub, Podcast, BoostResult, ValueTimeSplit } from '../types';
import { boostNoteTrack, boostSentence, heardOnLines, httpUrl, itemFeedGuid, playlistBoostContext, showShareUrl, type BoostNoteTrack } from '../util';
import type { QuotedZapReceipt } from './zap-summary-receipt';
import { BRAND, clientTag, noteBrandFor, type Brand } from '../brand';
import { COMMUNITY_FEED_ORIGIN, COMMUNITY_FEED_PATH } from '../curated-playlists';
import { DEFAULT_RELAYS } from './relays';
import { signAndPublish, publishSignedEvent, type PublishedNote } from './publish';
import { noteMentionTags, type MentionNpub, inlineMentions, withMentionRun } from './mention-tags';
import { signSiteNote, type SiteNoteState, type StampFailure, type NoteTemplate } from '../site-stamp';

/** How long either site route may take before the ladder reads it as no answer. */
const SITE_ROUTE_TIMEOUT_MS = 15_000;

interface PublishArgs {
  podcast: Podcast;
  episode?: Episode;        // omit for show-level boosts
  boostagram: Boostagram;
  results: BoostResult[];
  relays?: string[];
  /**
   * The ONE receipt this note quotes: the site-signed summary for the sats the
   * boost actually paid (`mintSummaryReceipt`). No boost payment is a zap, so
   * there is no provider receipt to quote instead, and a leg's would never be
   * quoted anyway — Fountain renders the FIRST quote and nothing else, and a leg's
   * figure under a note stating the total reads as a contradiction.
   */
  summaryReceipt?: QuotedZapReceipt;
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
  /**
   * The TRACK this boost paid, when it paid one — a `<podcast:valueTimeSplit>`
   * window or a live show's Split Kit block — with the legs that paid that
   * track's block (not the show's remainder). The note's sentence then names the
   * song (`boostSentence`) and the tags carry its NIP-73 identifiers;
   * `boostNoteTrack` (lib/util.ts) decides whether it may, and says nothing
   * unless a track leg settled. Ignored by `contentOverride`'s body, never by
   * its tags.
   */
  track?: {
    split: Pick<ValueTimeSplit, 'title' | 'artist' | 'remoteItem'>;
    results: BoostResult[];
  };
  /**
   * Who made a playlist ROW — an item whose own feed is not the container
   * (`itemFeedGuid`). Display only: the sentence's "by <artist>". The boost
   * modal looks it up while the wallet pays and gives up after two seconds, so
   * a missing one costs those words and nothing else.
   */
  itemArtist?: string;
  /**
   * The brand the NOTE wears — its links, its picture, its `client` tag, the
   * sentence's `via <app>`, and the deploy whose key signs it on the site path.
   * `noteBrandFor(ctx.hosted, COMMUNITY_FEED_ORIGIN)` (lib/brand.ts): Buddy for a
   * song from a playlist BMB hosts on the production Buddy origin, on either
   * deploy; otherwise `BRAND`. Omitted, the builder makes the same decision
   * itself. The boostagram is never touched.
   */
  brand?: Brand;
  /**
   * The name the NOTE prints as the sender, in `brand`'s words
   * (`resolveSenderName(name, anonymous, brand)`). Defaults to the boostagram's
   * `sender_name`, which keeps the deploy's own default for the payment.
   */
  senderName?: string;
}

/**
 * What one note is about, decided once per note: `show` names the feed the song
 * belongs to (for a playlist song, its OWN album, never the playlist), `container`
 * is the playlist it was heard on (or null), and `heardOrigin` is where that
 * playlist's page is, for the hint on its `i` tag — the community feed origin
 * for a playlist BMB hosts (a test store's playlist lives on the test origin,
 * never on boostmebuddy.com), the note brand's origin for any other.
 *
 * The SENTENCE still names the playlist as the `from <where>` (`boostSentence`,
 * the shared format's rule 3): `show` decides the links and the hints, which
 * point at the song's own feed, never the words.
 */
interface NoteContext {
  show: Podcast;
  container: Podcast | null;
  brand: Brand;
  heardOrigin: string;
}

function noteContext(args: PublishArgs): NoteContext {
  const ctx = playlistBoostContext(args.podcast, args.episode, COMMUNITY_FEED_ORIGIN + COMMUNITY_FEED_PATH);
  // The caller's brand when it gave one; otherwise the same decision the modals
  // make, so a future publisher that forgets `brand` still writes Buddy's words
  // for a playlist on the Buddy origin rather than the other brand's — and never
  // for a test store's playlist (final review C1).
  const brand = args.brand ?? noteBrandFor(ctx.hosted, COMMUNITY_FEED_ORIGIN);
  return {
    show: ctx.show,
    container: ctx.container,
    brand,
    heardOrigin: ctx.hosted ? COMMUNITY_FEED_ORIGIN : brand.origin,
  };
}

/**
 * The app the sentence ends `via`, and the `client` tag: the boostagram's
 * `app_name` (the shared format's rule 7), except on a note in ANOTHER brand's
 * words, which names that brand (spec decision 17) — a Buddy-signed kind:1 that
 * said "via BoostMeBitch" would carry the other brand's word forever. One
 * expression, so the body and the tag cannot disagree (`noteNamesClient`).
 */
function noteAppName(boostagram: Boostagram, brand: Brand): string | undefined {
  return brand.id === BRAND.id ? boostagram.app_name : brand.wireName;
}

/** The note's track, decided against the guids this note tags as its own. */
function noteTrack(args: PublishArgs): BoostNoteTrack | null {
  if (!args.track) return null;
  return boostNoteTrack({
    split: args.track.split,
    trackResults: args.track.results,
    // The show the note's FIRST tag names: a playlist row's own feed when it
    // has one, so a song in that feed is not tagged twice.
    showGuid: itemFeedGuid(args.podcast, args.episode) ?? args.podcast.podcastGuid,
    episodeGuid: args.episode?.guid,
  });
}

/**
 * The site-sign route's MAX_TAGS_TOTAL_LEN — the sum of every tag item's
 * length. It rejects the WHOLE template past it, so the track's optional tags
 * give way before the note does. Keep the two numbers together.
 */
const SITE_SIGN_TAGS_TOTAL_LEN = 4096;
/**
 * The site-sign route's MAX_CONTENT (lib/site-sign-template.ts, which the stamp
 * route applies too). Keep the two numbers together.
 *
 * It sits JUST ABOVE THE LARGEST REAL NOTE, so a real boost never meets it
 * (Chad, 2026-11-17: the route refused 2032 characters at 2000, and RETRY NOTE
 * with it). The route is unauthenticated and asks for no proof of payment, so
 * the limit is what bounds the free text a stranger can have the site sign —
 * not far above, then. The parts of the body and their maximums: the modal's
 * 250-character message, 120 characters a name (`noteTrackText`), eight
 * mentions, links within 512 (`noteLink`, this site's own link included),
 * banner titles within 120, BOOST ALL's list within `BOOST_ALL_LISTED_MAX`
 * tracks. The receipt's relay hints are the user's own write relays and have
 * no maximum; three long real ones (filter.nostr.wine puts the npub in the
 * URL) add ~390 characters. Measured with all of them at once and a song
 * inside an episode: about 5,030 (`e2e:mentions` prints it and fails if the
 * limit drifts 1,000 above it). Past that the body gives way part by part
 * (`SHEDS`). One body still has no maximum: a message that repeats one
 * @mention dozens of times, since each becomes a 69-character `nostr:npub`.
 */
const SITE_SIGN_MAX_CONTENT = 5500;

/**
 * The longest link the note carries, in its body or its `r` tags or as an `i`
 * tag's hint: the site-sign route's MAX_TAG_ITEM_LEN, which refuses the whole
 * template past it. A longer link is LEFT OUT, never cut — a cut URL is a dead
 * link in a note nobody can edit.
 */
const NOTE_LINK_MAX = 512;
const noteLink = (url: string | null | undefined): string | null =>
  url && url.length <= NOTE_LINK_MAX ? url : null;
const tagsLen = (tags: string[][]) =>
  tags.reduce((n, t) => n + t.reduce((m, x) => m + x.length, 0), 0);

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
 * **Levels 4 and 5 only when this site's own link is NOT in the note.** Both
 * name the SHOW and nothing more, while `bmbLandingUrl` names the same show AND
 * the episode, so with both in the body a client drew two cards for one album
 * (Chad, on a beta note, 2026-11-19: "too many links"). The test is the same
 * one `bmbLandingUrl` makes — a guid, and a link within `noteLink`'s length —
 * spelled through `siteLandingUrl` so the rule needs no brand: the two brand
 * origins are the same length. Without that link (no guid: a live stream, or
 * a guid too long to print) the fallback stays, so a note is never left
 * without a link it had.
 *
 * Both episode sources are feed-supplied, so both are http(s)-validated before
 * going in a public note. Levels 3–5 are show-level: neither pod.link nor PI
 * has an episode URL constructible from a guid (pod.link's episode paths key
 * on an id of their own), so a feed with neither a `<link>` nor a URL guid
 * falls back to the show here. The BMB link below stays episode-specific
 * either way.
 */
function podcastLandingUrl(podcast: Podcast, episode?: Episode): string | null {
  // Each candidate within `noteLink`'s length, or the next one stands in.
  const episodePage = noteLink(httpUrl(episode?.link)) ?? noteLink(httpUrl(episode?.guid));
  if (episodePage) return episodePage;
  if (podcast.itunesId) return `https://pod.link/${podcast.itunesId}`;
  if (podcast.podcastGuid && noteLink(siteLandingUrl(podcast.podcastGuid, episode?.guid))) return null;
  if (podcast.id) return `https://podcastindex.org/podcast/${podcast.id}`;
  return noteLink(podcast.url);
}

/**
 * BoostMeBitch in-app deep link. Episode-specific when boosting an episode:
 * `?podcast=<guid>&episode=<guid>` is a restorable view per the URL contract
 * (components/home-page.tsx hydrates it), and app/page.tsx emits episode-level
 * Open Graph tags for it, so the unfurl shows the episode's own title and art.
 * Emitted alongside the listen-link (not as a replacement) so readers get both
 * affordances: listen elsewhere, or boost back here.
 *
 * Both guids are encodeURIComponent'd. The episode guid is an arbitrary
 * feed-chosen string and is routinely a URL. The podcast guid is MEANT to be a
 * UUID, but it is still a feed-supplied string, and one carrying `&`, `#` or a
 * space breaks a link that can never be edited. For a UUID the encoding is the
 * identity, so every note already published reads the same.
 *
 * The `www` host is deliberate and must match app/layout.tsx's metadataBase:
 * the apex 307-redirects here, and this URL is written into a signed, immutable
 * kind:1 — an unfurler that doesn't follow the redirect gets no card at all,
 * and every note already published carries whichever host we chose forever.
 */
function bmbLandingUrl(podcast: Podcast, episode: Episode | undefined, origin: string): string | null {
  if (!podcast.podcastGuid) return null;
  // A long URL guid, percent-encoded, can pass `noteLink`'s length: then the
  // note goes without this link (and without it as an `i` hint), never cut.
  return noteLink(siteLandingUrl(podcast.podcastGuid, episode?.guid, origin));
}

/**
 * The same deep link from bare guids, for a publisher holding no `Podcast` —
 * the episode like (`likes.ts`) writes it as its NIP-73 `i` hints, and a boost
 * note's track hints use it too. Everything said above holds: it goes into a
 * signed event, so the host is `BRAND.origin` and never `window.location`,
 * which on a dev server is `localhost`. **One builder, so the encoding cannot
 * differ between copies** — the track hints encoded the feed guid while this
 * did not.
 *
 * `origin` is the NOTE's brand origin: a boost note for a song from a playlist
 * BMB hosts links to Buddy on either deploy. The likes and comments that import
 * this pass nothing and keep the deploy's own.
 */
export function siteLandingUrl(feedGuid: string, itemGuid?: string, origin: string = SITE_ORIGIN): string {
  const url = `${origin}/?podcast=${encodeURIComponent(feedGuid)}`;
  return itemGuid ? `${url}&episode=${encodeURIComponent(itemGuid)}` : url;
}

/**
 * The URL hints of a summary receipt's NIP-73 refs (`Nip73Refs.podcastUrl` /
 * `episodeUrl`), in the NOTE's brand.
 *
 * The receipt is minted and signed by the note brand's deploy, which writes
 * these hints into a kind:9735 under its key, permanently. For this deploy's own
 * brand they are the share URL on this origin, as always (`showShareUrl`). For
 * the other brand — a song from a playlist BMB hosts on the Buddy origin — they are that brand's
 * deep links, so a Buddy-signed receipt never carries a boostmebitch.com (or a
 * dev server's) URL. Both modals build their snapshot's refs here.
 */
export function receiptRefUrls(
  brand: Brand,
  podcastGuid: string | undefined,
  itemGuid?: string,
): { podcastUrl?: string; episodeUrl?: string } {
  if (!podcastGuid) return {};
  if (brand.id === BRAND.id) {
    // `{ podcastGuid }` with no medium keeps these `?podcast=`, as
    // `siteLandingUrl` writes for the other brand: a hint signed into a receipt
    // is never re-spelled, and `?podcast=` opens every kind of show.
    return {
      podcastUrl: showShareUrl({ podcastGuid }) ?? undefined,
      episodeUrl: showShareUrl({ podcastGuid }, itemGuid) ?? undefined,
    };
  }
  return {
    podcastUrl: siteLandingUrl(podcastGuid, undefined, brand.origin),
    episodeUrl: siteLandingUrl(podcastGuid, itemGuid, brand.origin),
  };
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
  // A playlist row's container is not its parent, so the playlist's cover is
  // not the track's art — the row's own image and its feed's are.
  const showArt = itemFeedGuid(podcast, episode) ? [] : [podcast.image, podcast.artwork];
  for (const c of [episode?.image, episode?.feedImage, ...showArt]) {
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
 *
 * The DEFAULT only. A boost note takes its origin from its brand
 * (`PublishArgs.brand`), which is Buddy's for a song from a playlist BMB hosts
 * on the production Buddy origin (`noteBrandFor`).
 */
const SITE_ORIGIN = BRAND.origin;

/** The most of a title the banner URL carries; see `boostBannerUrl`. */
const BANNER_TITLE_MAX = 120;

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
 *
 * `origin` is the note brand's, never a dev or test origin: the site-sign route
 * of the deploy that signs refuses an `imeta` on any origin but its own.
 */
function boostBannerUrl(
  podcast: Podcast,
  episode: Episode | undefined,
  boostagram: Boostagram,
  origin: string,
): string {
  const params = new URLSearchParams();
  // `art`, then `art2`, then `art3` — the route tries them in order and keeps
  // the first that answers with something it can draw. New names rather than a
  // repeated key: the route's parameters are a permanent public contract, and
  // every note already published names `art` alone.
  const arts = boostArtUrls(podcast, episode);
  arts.forEach((url, i) => params.set(i === 0 ? 'art' : `art${i + 1}`, url));
  // At most 120 characters of each title: the banner draws 47 at most, and a
  // raw feed title has no length of its own, so the rest only made the note
  // longer (the site-sign limit counts it).
  const title = (t: string) => Array.from(t).slice(0, BANNER_TITLE_MAX).join('');
  if (podcast.title) params.set('title', title(podcast.title));
  if (episode?.title) params.set('ep', title(episode.title));
  const sats = Math.round((boostagram.value_msat_total ?? 0) / 1000);
  if (sats > 0) params.set('sats', String(sats));
  return `${origin}/api/og/boost.png?${params.toString()}`;
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
 * The receipts this note quotes: the summary receipt, or nothing.
 *
 * ONE, and it is the summary. Fountain renders a boost's ⚡ figure off the
 * first quoted kind:9735 — measured 2026-09-16: two 33-sat leg receipts
 * quoted under a 100-sat note rendered "⚡ 33". A client-side split can never
 * hand Fountain a provider receipt for the whole, so the note quotes the
 * site-signed summary for the sats actually paid (lib/nostr/zap-request.ts),
 * and the per-leg receipts stay unquoted — they still reach the artist's own
 * zap feed on their own. When there is no summary (Anonymous, signed out, the
 * oracle off, no relay took it) the note quotes nothing rather than a leg.
 */
function quotedReceipts(args: PublishArgs): QuotedZapReceipt[] {
  return args.summaryReceipt ? [args.summaryReceipt] : [];
}

/**
 * Append the `nostr:nevent…` reference for the quoted receipt.
 *
 * BOTH FORMS, AND THIS IS THE ONE FOUNTAIN'S BADGE READS. #405 dropped the body
 * form because every general client unfurls it into an embedded zap card. The
 * next test (note b88137ca…, 2026-09-16) settled what each form buys: a note
 * with `q` tags alone LISTS in Fountain, with its episode card, and draws no ⚡
 * figure; the same note with a body reference draws it. Fountain's own writer
 * emits only the body form, with `kind: 9735` in the nevent. So the body line
 * is the price of the figure, and there is exactly one of it now.
 *
 * Placed LAST, below the mention run: the shared format's block order
 * (PC20-Nostr pc20-boost-notes.md, rule 12 — the receiver bots already write
 * it so). It sat above the mentions until 2026-11-16. The relay hints are the
 * relays that accepted the receipt (`mintSummaryReceipt`).
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


/**
 * What the body leaves out to fit the site-sign cap. A real note never needs
 * any of it (`SITE_SIGN_MAX_CONTENT`); a note past every real maximum — a cover
 * URL thousands of characters long, relay hints no relay has — gives way part
 * by part rather than be refused whole.
 */
interface Shed { heard: boolean; banner: boolean; song: boolean; by: boolean; receipt: boolean }

/**
 * The order it gives way in, each step keeping the last. The Heard-on lines
 * FIRST: the sentence already names the playlist as its `from`, and the
 * playlist's own `i` tag still records it, so they are the one part the note
 * says twice. Then the BANNER: a picture URL is the one part with no real
 * maximum (its cover URLs), and the song's name is worth more than a picture of
 * it. Then the song, then the "by <artist>", then the receipt's `nostr:nevent`
 * line LAST — its `q` tag stays, so Fountain still lists the note and only its
 * ⚡ figure is lost.
 */
const SHEDS: readonly Shed[] = [
  { heard: false, banner: false, song: false, by: false, receipt: false },
  { heard: true, banner: false, song: false, by: false, receipt: false },
  { heard: true, banner: true, song: false, by: false, receipt: false },
  { heard: true, banner: true, song: true, by: false, receipt: false },
  { heard: true, banner: true, song: true, by: true, receipt: false },
  { heard: true, banner: true, song: true, by: true, receipt: true },
];

/**
 * `🎧 Heard on <playlist>[ by nostr:<maker>]` — for a song played from a
 * playlist, and nothing otherwise. The maker is the first npub the playlist
 * declares, the same one `noteNpubs` already `p`-tags through the container.
 */
function noteHeardOn(nc: NoteContext): string[] {
  if (!nc.container) return [];
  return heardOnLines(nc.container, nc.container.nostrNpubs?.[0]?.npub ?? null);
}

function formatContent(args: PublishArgs, nc: NoteContext, shed: Shed, heard: string[]): string {
  const { podcast, episode, boostagram } = args;
  // The song's OWN feed for a playlist song (the container rule): both landing
  // links name the album. The sentence's `from` stays the playlist (`podcast`).
  const { show } = nc;
  const totalSats = Math.round((boostagram.value_msat_total ?? 0) / 1000);

  const lines: string[] = ['⚡ Boost ⚡', ''];
  if (boostagram.message?.trim()) {
    lines.push(boostagram.message.trim(), '');
  }
  // ONE sentence: what got the sats, by whom, then where it was found
  // (`boostSentence`, pinned by check:vts). The sender's "From" name opens it —
  // load-bearing for site-signed notes, which are authored by the site's
  // identity, so without it the sender appears nowhere. The song the boost
  // paid is named only when a track leg settled (boostNoteTrack). The song and
  // the "by <artist>" — up to ~250 characters the sentence can do without —
  // are what the sentence gives way when the body would pass the site-sign cap
  // (`SHEDS`; a real note never does).
  const track = shed.song ? null : noteTrack(args);
  const keepBy = !shed.by;
  lines.push(boostSentence({
    // The NOTE's own name when the caller gave one: its default is the note
    // brand's, which for a playlist BMB hosts is not the boostagram's.
    sender: args.senderName ?? boostagram.sender_name,
    sats: totalSats,
    // Without an author there is no album "by"; the title, medium and guid
    // still decide everything else.
    show: keepBy ? podcast : { ...podcast, author: undefined },
    item: episode,
    itemArtist: keepBy ? args.itemArtist : undefined,
    song: track?.title ? { title: track.title, artist: track.artist } : null,
    // The name the payment carried, so the note and the boostagram agree on
    // which app the listener used (pc20-boost-notes.md rule 7) — except in
    // another brand's words (`noteAppName`).
    via: noteAppName(boostagram, nc.brand),
  }));
  // Where it was heard, as a block of its own under the sentence: the shared
  // format puts one blank line between blocks, and a client otherwise runs the
  // two into one paragraph (Chad, on a beta note, 2026-11-19).
  if (heard.length) lines.push('', ...heard);
  const link = podcastLandingUrl(show, episode);
  if (link) lines.push('', link);
  const bmbLink = bmbLandingUrl(show, episode, nc.brand.origin);
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
  //
  // For a song played from a playlist, `show` is the song's OWN feed, so the
  // item's hint opens it on its album (rule 15 pairs the item with its own
  // feed), and every link is on the NOTE brand's origin (`noteContext`).
  const nc = noteContext(args);
  const { show, brand } = nc;
  const showHint = bmbLandingUrl(podcast, undefined, brand.origin);
  const itemHint = episode ? bmbLandingUrl(show, episode, brand.origin) : null;
  // A playlist ROW lives in another feed than the playlist, and readers take a
  // note's FIRST `podcast:guid:` as the item's show (`useNoteMeta`, and every
  // client that looks an item up by its feed). Pairing the playlist's guid with
  // the row's item named a feed that item is not in, so no reader could resolve
  // it — rev.hodl's note b1d67bdd… unfurled as the playlist alone. The row's own
  // feed goes first, the item second, and the playlist after them, so the
  // playlist's page still lists the note. The boostagram's `remote_feed_guid`
  // and the summary receipt already name the row's own feed.
  const ownFeed = itemFeedGuid(podcast, episode);
  if (ownFeed) {
    tags.push(['i', `podcast:guid:${ownFeed}`, siteLandingUrl(ownFeed, undefined, brand.origin)]);
    tags.push(['k', 'podcast:guid']);
  } else if (podcast.podcastGuid) {
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
  // The TRACK the boost paid, as NIP-73 identifiers after the show's and the
  // episode's own, which stay first. No `k` tag: `k` names the KIND of
  // identifier, and both kinds are already declared above — a second pair would
  // say nothing new. A track whose guid IS the note's own adds no tag (a musicL
  // playlist row); see boostNoteTrack. Placed here, sized below.
  const track = noteTrack(args);
  const trackAt = tags.length;
  // The playlist the row was found on comes LAST, after the song's pair: the
  // shared format's rule 15 (PC20-Nostr pc20-boost-notes.md) keeps each item
  // guid right after its own feed's guid, so a reader pairs them by order. No
  // second `k`: the kind is declared above. Its hint is the playlist's page:
  // the community feed origin for a playlist BMB hosts. The body no longer
  // prints that link (`heardOnLines`), so this tag is where it is kept.
  if (ownFeed && podcast.podcastGuid) {
    const playlistHint = noteLink(siteLandingUrl(podcast.podcastGuid, undefined, nc.heardOrigin));
    tags.push(playlistHint
      ? ['i', `podcast:guid:${podcast.podcastGuid}`, playlistHint]
      : ['i', `podcast:guid:${podcast.podcastGuid}`]);
  }
  const trackTags = (withHints: boolean): string[][] => {
    if (!track) return [];
    const out: string[][] = [];
    const feed = track.feedGuid ?? ownFeed ?? podcast.podcastGuid;
    if (track.feedGuid) {
      const hint = withHints ? siteLandingUrl(track.feedGuid, undefined, brand.origin) : null;
      out.push(hint ? ['i', `podcast:guid:${track.feedGuid}`, hint] : ['i', `podcast:guid:${track.feedGuid}`]);
    }
    if (track.itemGuid) {
      const hint = withHints && feed ? siteLandingUrl(feed, track.itemGuid, brand.origin) : null;
      out.push(hint && hint.length <= 512
        ? ['i', `podcast:item:guid:${track.itemGuid}`, hint]
        : ['i', `podcast:item:guid:${track.itemGuid}`]);
    }
    return out;
  };
  const linkUrl = podcastLandingUrl(show, episode);
  if (linkUrl) tags.push(['r', linkUrl]);
  const bmbUrl = bmbLandingUrl(show, episode, brand.origin);
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
  //
  // `podcast`, never `show`: for a playlist song `podcast` is the playlist, so
  // its maker is tagged here (and the album's facts carry no npub of the
  // playlist's — see ownShowOf).
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
  const banner = boostBannerUrl(podcast, episode, boostagram, brand.origin);
  if (`url ${banner}`.length <= 512) {
    tags.push(['imeta', `url ${banner}`, 'm image/png', 'dim 1200x300']);
  }
  if (totalMsat > 0) tags.push(['amount', String(totalMsat)]);
  // The `q` tag half of the quote; `withZapReceipts` below writes the body
  // half, which is the one Fountain's badge reads. Same shape
  // `publishQuoteRepost` writes (./interactions.ts): id, relay hint, author —
  // the author is the site, which signs the summary receipt. `parseQuoteRefs`
  // (./discover.ts) reads either form, so the explorer's wrapper-vs-receipt
  // dedupe holds.
  //
  // `amount` above stays `value_msat_total`, the whole boost as INTENDED; the
  // summary receipt carries the sats actually PAID. They differ only when a
  // leg failed, and then the receipt is the one telling the truth.
  const receipts = quotedReceipts(args);
  for (const r of receipts) tags.push(['q', r.id, r.relays[0] ?? '', r.pubkey]);
  // ON PURPOSE (spec decision 17): a note for a song from a playlist BMB hosts
  // on the Buddy origin carries Buddy's `wireName` here, on either deploy, while
  // the boostagram's `app_name` keeps naming the deploy that PAID
  // (`noteAppName`, the same name the sentence ends `via`).
  tags.push(clientTag(noteAppName(boostagram, brand)));
  tags.push(['t', 'boostagram']);
  tags.push(['t', 'value4value']);
  // Sized last, against everything else the note carries: the hints go first,
  // then the track's tags, and the note itself never. A track the tags cannot
  // hold is still named in the body.
  for (const candidate of [trackTags(true), trackTags(false)]) {
    if (candidate.length === 0) break;
    if (tagsLen(tags) + tagsLen(candidate) <= SITE_SIGN_TAGS_TOTAL_LEN) {
      tags.splice(trackAt, 0, ...candidate);
      break;
    }
  }

  // Inline first, then append only what could not be placed. The two halves
  // are one decision: a mention put where the sender typed it must NOT also
  // appear in the trailing run, or the note names the same person twice.
  const build = (shed: Shed) => {
    const heard = shed.heard ? [] : noteHeardOn(nc);
    // Boost-all's summary replaces the body, so its Heard-on lines go under
    // it — the same convergence `withArt` and the mention run use.
    const text = args.contentOverride != null
      ? (heard.length ? `${args.contentOverride}\n\n${heard.join('\n')}` : args.contentOverride)
      : formatContent(args, nc, shed, heard);
    const body = withArt(text, shed.banner ? null : banner);
    const { content: inlined, remaining } = inlineMentions(body, inBody);
    // `withMentionRun` skips a person the body already names — the
    // playlist's maker, in the Heard-on line. Its `p` tag is unaffected.
    return withZapReceipts(withMentionRun(inlined, remaining), shed.receipt ? [] : receipts);
  };
  // The first body the route takes, measured on both paths so a note never
  // differs by which key signs it. The last step fits every real note but one
  // shape — a message repeating an @mention dozens of times (see
  // SITE_SIGN_MAX_CONTENT); that one the route still refuses.
  const shed = SHEDS.find((s) => build(s).length <= SITE_SIGN_MAX_CONTENT) ?? SHEDS[SHEDS.length - 1];
  const content = build(shed);
  // NIP-92's `imeta` describes a picture the body names; once the body gives
  // the banner up, it describes nothing.
  const finalTags = shed.banner ? tags.filter((t) => t[0] !== 'imeta') : tags;

  return {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: finalTags,
    content,
  };
}

export async function publishBoostNote(
  args: PublishArgs,
  // `signal` stops the wait for the signer (a hung NIP-07 extension); a
  // signature that arrives afterwards is dropped, never published.
  // `onSigned` fires once the signer has answered. See `signAndPublish`.
  opts: { signal?: AbortSignal; onSigned?: () => void } = {},
): Promise<PublishedNote> {
  const relays = args.relays ?? DEFAULT_RELAYS;
  // Signed by the user's own key, so a mention they typed is attributable to
  // them and may carry a `p` tag.
  return signAndPublish(buildBoostNoteTemplate(args, true), relays, { signal: opts.signal, onSigned: opts.onSigned });
}

/**
 * Publish the boost note as the SITE, for a signed-out user or the signed-in
 * "Anonymous" choice — and only with a paid NOTE STAMP (lib/site-stamp.ts):
 * `/api/nostr/site-stamp` gets an invoice for exactly this note, priced at 1%
 * of its boost, from the site's own Lightning address, `payStamp` pays it on the boost's rail, and
 * `/api/nostr/site-sign` signs once that invoice's verify link says settled. ANY failure on that path signs
 * the SAME template with a one-time key instead, so the note always goes out;
 * `signer` and `why` say which happened, for the screen.
 *
 * Pass the SAME `state` on every attempt at one boost's note (RETRY NOTE): it
 * keeps the template, the paid stamp and the signed event, so a retry never
 * pays a second stamp and never builds a second note.
 *
 * A note in ANOTHER brand's words (`args.brand`, Buddy's for a song from a
 * playlist BMB hosts on the Buddy origin) asks THAT deploy for both the stamp
 * and the signature, so this deploy never holds the other's `SITE_NOSTR_SK`
 * (CLAUDE.md, Names). Both routes answer this origin with CORS
 * (`lib/cross-brand-cors.ts`). When that deploy cannot be reached, the ladder
 * signs one-time like any other failure — never with THIS deploy's key, which
 * would put Buddy's words under the other brand's.
 *
 * `relays` is where the signed note goes: DEFAULT_RELAYS unless a caller names
 * others. Both modals leave it out. It exists for `e2e:mentions`, which must
 * reach only its own local relay — without it, nine runs of that script put 117
 * one-time-key test notes on the public relays (2026-11-17,
 * lib/nostr/test-boost-notes.ts). It is an option here and deliberately NOT
 * `args.relays`: that field is the sender's own NIP-65 write set, which both
 * modals hand `publishBoostNote` for a self-signed note, so reading it here
 * would move the site's notes off DEFAULT_RELAYS the day a caller shares one
 * argument object between the two paths.
 *
 * Does not throw on a refused stamp or signature. It THROWS when no relay took
 * the note — a phone between networks — so the modal shows RETRY NOTE; `state`
 * keeps the signed event, so the retry posts the same note and pays nothing.
 * (`publishSignedEvent` itself never rejects: a 0/N answer is the only sign.)
 */
export async function publishBoostNoteViaSite(
  args: PublishArgs,
  opts: {
    payStamp: (bolt11: string, sats: number) => Promise<void>;
    state: SiteNoteState<Event>;
    onStamp?: (sats: number) => void;
    relays?: string[];
  },
): Promise<{ note: PublishedNote; signer: 'site' | 'one-time'; why?: StampFailure }> {
  const { state } = opts;
  // `false`: this template goes to an UNAUTHENTICATED endpoint that signs under
  // the site's NIP-05-verified identity, so the sender's @mentions lose their
  // `p` tags here. The feed's own npubs keep theirs. A one-time-key fallback
  // signs this same template, which is still not the sender's own key.
  if (!state.template) {
    state.template = buildBoostNoteTemplate(args, false);
    // The receipt its `q` tag quotes, set WITH the template: site-stamp checks
    // that it is the site's and claims no more than the note.
    state.receipt = args.summaryReceipt?.event;
  }
  // The SAME decision the template's words came from (`noteContext`), never a
  // separate default: a template in Buddy's words sent to this deploy's route
  // would be signed under the other brand's key.
  const { brand } = noteContext(args);
  const origin = brand.id === BRAND.id ? '' : brand.origin;
  // `state` itself, never a copy: the ladder records the paid stamp and the
  // signed event ON it, which is what makes RETRY NOTE free.
  await signSiteNote(state as SiteNoteState<Event> & { template: NoteTemplate }, {
    post: async (path, body) => {
      try {
        const res = await fetch(`${origin}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(SITE_ROUTE_TIMEOUT_MS),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      } catch {
        return { status: 0, body: null };
      }
    },
    payStamp: opts.payStamp,
    // Never stored: the key exists for this one signature.
    signOneTime: (t) => finalizeEvent({ ...t, tags: t.tags.map((tag) => [...tag]) }, generateSecretKey()),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onStamp: opts.onStamp,
  });
  const note = await publishSignedEvent(state.signed!, opts.relays ?? DEFAULT_RELAYS);
  if (note.acceptedRelays.length === 0) throw new Error('no relay accepted the note');
  return { note, signer: state.signer!, why: state.why };
}
