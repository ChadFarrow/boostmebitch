// Small RSS/XML readers shared by the feed parsers, split out of lib/pi.ts so
// `node --experimental-strip-types` can load them.
//
// Deliberately carries NO runtime imports beyond `nostr-tools` and no Node
// APIs — same reasoning as lib/v4v/stream-ledger.ts and lib/v4v/spark-derive.ts.
// pi.ts itself can't be strip-typed (PiHttpError uses a parameter property) and
// pulls in safe-fetch, so keeping parseNostrTxtNpubs here means
// `npm run check:npub` pins the REAL production parser rather than a copy of
// it. A copy stays green while the shipping parser drifts, which is the exact
// failure the check exists to catch.
import { nip19 } from 'nostr-tools';
import type { FeedNpub } from './types';

/**
 * Read one attribute off a raw tag's attribute string. Quote-agnostic.
 *
 * **The name is anchored to a whitespace or start-of-string boundary, NOT to
 * `\b`, and that is a money invariant — see `npm run check:feedxml`.**
 *
 * `\b` is a *word* boundary and `-` is a non-word character, so `\baddress`
 * matches inside `x-address`, `\bhref` inside `data-href`, `\bsplit` inside
 * `w-split`. Since `String.match` returns the FIRST hit, a feed that writes a
 * decoy attribute ahead of the real one wins:
 *
 *     <podcast:valueRecipient name="Real Artist" type="node"
 *         x-address="03ATTACKER…" address="03REALARTIST…"
 *         w-split="1" split="100"/>
 *
 * Under `\b` that parses to address `03ATTACKER…` and split `1`. The recipient
 * this app pays is then a different node than the one the feed nominates, and
 * the substitution is invisible to review: every other Podcasting 2.0 client
 * reads `address=`, so the artist, the aggregators and anyone eyeballing the
 * XML all see a correct feed. Only this parser is steered.
 *
 * The same trick reaches `href`/`src` in show notes (`data-href` satisfying an
 * `href` lookup, routing a link to an attacker's URL past the reader's eye) and
 * `url` on funding/enclosure tags.
 *
 * `(?:^|\s)` requires the name to actually start an attribute. Namespaced
 * attributes (`xml:lang`) deliberately do NOT satisfy a bare-name lookup —
 * nothing here reads one, and treating `foo:url` as `url` is the same bug.
 */
export function readAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = attrs.match(re);
  return m ? (m[1] ?? m[2]) : undefined;
}

// Decode the handful of XML entities that show up in short text nodes
// (funding labels). Mirrors the entity pass inside extractText.
export function decodeXmlText(raw: string): string {
  return raw
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1')
    .trim()
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

const LIVE_ITEM_RE = /<podcast:liveItem\b[^>]*>[\s\S]*?<\/podcast:liveItem>/gi;

/**
 * The channel header: everything before the first <item>, with any
 * <podcast:liveItem> blocks removed.
 *
 * `/<item\b/` does not match `<podcast:liveItem>` (the `<` is followed by
 * `podcast:`), so a live item published in the channel header — where the spec
 * puts it, and where publishers actually put it — lands INSIDE this slice
 * along with its own <podcast:value>, <podcast:funding> and <title>. Reading
 * channel fields off that gives the live item's value block as the SHOW's,
 * which is a money-path answer, not a cosmetic one. Same trap for
 * <podcast:txt>: it would make one broadcast's guest the show's npub forever.
 */
export function channelSlice(xml: string): string {
  const firstItem = xml.search(/<item\b/i);
  return (firstItem === -1 ? xml : xml.slice(0, firstItem)).replace(LIVE_ITEM_RE, '');
}

/** Cap on how many npubs one feed level contributes. */
const MAX_FEED_NPUBS = 4;

/**
 * `purpose` values that mean "this is our Nostr identity".
 *
 * There is no registered vocabulary for <podcast:txt purpose> — the spec leaves
 * it free-form — so hosts picked their own spelling and both are in the wild.
 * **Podhome writes `purpose="npub"`**, which is what the Chad and Reeds feed
 * publishes; `nostr` is the other spelling. Filtering on only one of them looks
 * identical to a feed with no tag at all, which is exactly how this shipped and
 * why the first live boost tagged nobody.
 *
 * Widening this list is safe ONLY because the value is still checksum-validated
 * below: the allowlist decides which tags we *look* at, nip19.decode decides
 * what we accept. Don't collapse it into "any purpose whose value happens to
 * decode" — a verification token that parses as bech32 is not an identity
 * claim. Add a third spelling here when one is observed, with the host named.
 */
const NOSTR_TXT_PURPOSES = new Set(['nostr', 'npub']);

/**
 * Parse <podcast:txt purpose="nostr|npub">npub1…</podcast:txt> into validated
 * npubs. Same paired-or-self-closing shape as parseFunding, which is the tag
 * this most resembles: attributes plus a text node.
 *
 * Three things this must keep doing:
 *
 *  - **Filter on `purpose`, against NOSTR_TXT_PURPOSES.** <podcast:txt> is a
 *    general-purpose container — the same feed routinely carries `verify`,
 *    `applepodcastsverify` and free-text entries. Accepting an unqualified
 *    <podcast:txt> would p-tag whatever a domain-verification token happens to
 *    be. Hosts disagree on the spelling, hence a set rather than one string.
 *  - **Validate, don't shape-check.** The text is arbitrary publisher input and
 *    ends up in a *signed* event's tags, so it goes through nip19.decode (which
 *    throws — hence the try/catch) rather than a bech32 regex. That rejects a
 *    truncated or mistyped npub instead of emitting a `p` tag pointing at
 *    nobody, and yields the hex the tag needs so the browser never re-decodes.
 *    nprofile/note/nevent are rejected too: only an npub names a person here.
 *  - **Cap the list.** Length is publisher-chosen and every entry becomes a tag
 *    on an event the site may sign; the site-sign route caps tags for the same
 *    reason. Four is far above any real feed.
 */
function decodeNpub(raw: string): FeedNpub | null {
  const npub = raw.trim().replace(/^nostr:/i, '');
  if (!npub) return null;
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') return null;
    return { npub, pubkey: decoded.data as string };
  } catch {
    // Not a decodable npub — a typo'd or truncated value is dropped, not tagged.
    return null;
  }
}

function txtNpubs(xml: string): FeedNpub[] {
  const out: FeedNpub[] = [];
  const re = /<podcast:txt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/podcast:txt>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const purpose = readAttr(m[1], 'purpose')?.toLowerCase();
    if (!purpose || !NOSTR_TXT_PURPOSES.has(purpose)) continue;
    if (m[2] == null) continue;
    const n = decodeNpub(decodeXmlText(m[2]));
    if (n) out.push(n);
  }
  return out;
}

/**
 * `<podcast:person npub="npub1…">Name</podcast:person>` — the OTHER place a
 * feed names a real person's key, and the only one that scales past a single
 * identity: <podcast:txt> is one claim for the whole feed level, while
 * <podcast:person> is per-person and legal per-<item>, so it's where a guest,
 * a featured artist or a second co-host gets named.
 *
 * Not in the spec's attribute list (which is href/img/role/group) but written
 * in the wild — MSP 2.0 emits it on music feeds, alongside a matching
 * <podcast:txt>. That overlap is why this is worth having and also why it's
 * cheap: dedupe by pubkey means a feed carrying the same key in both places
 * still produces exactly one `p` tag.
 */
function personNpubs(xml: string): FeedNpub[] {
  const out: FeedNpub[] = [];
  const re = /<podcast:person\b([^>]*?)(?:\/>|>[\s\S]*?<\/podcast:person>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const raw = readAttr(m[1], 'npub');
    if (!raw) continue;
    const n = decodeNpub(raw);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Every Nostr identity this slice of feed declares, from both conventions,
 * deduped by pubkey and capped.
 *
 * <podcast:txt> comes first because it's the feed's claim about *itself*; a
 * <podcast:person> npub is a claim about a participant, which is the better
 * match only when it's someone the txt tag doesn't already name. Order matters
 * because the cap truncates.
 */
export function parseFeedNpubs(xml: string): FeedNpub[] | undefined {
  const out: FeedNpub[] = [];
  const seen = new Set<string>();
  for (const n of [...txtNpubs(xml), ...personNpubs(xml)]) {
    if (seen.has(n.pubkey)) continue;
    seen.add(n.pubkey);
    out.push(n);
    if (out.length >= MAX_FEED_NPUBS) break;
  }
  return out.length ? out : undefined;
}

/**
 * One `<podcast:remoteItem>` of a `musicL` playlist — a track that lives in
 * somebody else's album feed.
 *
 * Structurally identical to `EpisodeRef` in lib/pi-batch.ts, and deliberately
 * re-declared rather than imported: this module must keep loading under
 * `node --experimental-strip-types`, and pi-batch.ts pulls in lib/pi.ts.
 */
export interface PlaylistItemRef {
  feedGuid: string;
  itemGuid: string;
  /**
   * The `<podcast:txt purpose="episode">` heading this track sat under, if the
   * playlist published one. Free text written by the feed — a caption, never an
   * identifier, and never a key.
   */
  episode?: string;
}

/**
 * Cap on an episode caption, which is feed-supplied text rendered as a heading.
 * Real ones are like "Homegrown Hits - Episode 147"; this only stops a
 * pathological feed pushing a novel into the list.
 */
const MAX_PLAYLIST_EPISODE_LEN = 200;

/**
 * A `<podcast:podroll>` block, whose remoteItems are NOT playlist tracks.
 *
 * `parsePodroll` scopes itself *into* this block, so the two parsers don't
 * collide from that direction — but a channel-wide scan reads the host's
 * recommended shows as songs, and there is nothing on the entry itself to tell
 * them apart. The nesting is the only signal, so it has to be honoured here.
 */
const PODROLL_BLOCK_RE = /<podcast:podroll\b[^>]*>[\s\S]*?<\/podcast:podroll>/gi;

/**
 * Ceiling on how many tracks one playlist contributes.
 *
 * The list is feed-supplied and `safeFetch` accepts 8 MB, which is roughly
 * 88,000 entries — so without a cap one document decides how much this process
 * allocates and how many pages a client can ask for. The live HGH playlist is
 * 1217; 5000 is far above any real one. The caller REPORTS what was dropped
 * rather than truncating in silence, for the reason lib/musicl-resolver.ts
 * gives about its own cap: silent truncation reads as "we listed everything".
 */
export const MAX_PLAYLIST_REFS = 5000;

/**
 * Per-guid length caps, mirroring app/api/episode-by-guid/batch/route.ts.
 * A feed guid is a UUID; an item guid is any globally-unique string and real
 * feeds use permalink URLs, so the two limits differ by a lot.
 */
const MAX_FEED_GUID_LEN = 120;
const MAX_ITEM_GUID_LEN = 2048;

/**
 * The tracks of a `<podcast:medium>musicL</podcast:medium>` playlist.
 *
 * A playlist feed publishes NO `<item>` elements at all: its contents are
 * channel-level `<podcast:remoteItem feedGuid=… itemGuid=…/>` entries, each
 * naming one track in another artist's album feed. So this is the whole
 * document as far as the reader is concerned, which is why three properties
 * below are correctness rules rather than tidiness.
 *
 * **Pass `channelSlice(xml)`, never raw XML.** A `<podcast:liveItem>` carries
 * its own `<podcast:remoteItem>` — the "now playing" pointer a live show
 * rewrites per track (see `Episode.liveRemoteItem`) — and reading that as a
 * playlist entry puts one broadcast's current song into the track list of an
 * unrelated feed. `channelSlice` already strips those blocks; `<podcast:podroll>`
 * it does not, so that is stripped here.
 *
 * **Order is the data.** A playlist's running order is the order the entries
 * are written in, and nothing on an entry restates it — unlike an album, whose
 * tracks carry `<podcast:episode>` numbers. Dedupe therefore keeps the FIRST
 * occurrence and the array is never sorted. (The live HGH playlist writes 1770
 * entries of which 1217 are distinct: a song replayed on a later show is listed
 * again, and rendering it twice is a duplicate row a listener has no way to
 * explain.)
 *
 * **Both guids are required.** PI's /episodes/byguid needs `podcastguid` to
 * disambiguate, so an entry with only one half is not a lookup key and is
 * dropped rather than half-resolved.
 *
 * Attributes go through `readAttr` for the reason its own comment gives: a feed
 * writing `x-feedGuid="…"` ahead of the real attribute steers a `\b`-anchored
 * reader to a different feed entirely, and every other Podcasting 2.0 client
 * would read the same document correctly. Pinned by `npm run check:playlist`.
 */
export function parsePlaylistRemoteItems(channelXml: string): PlaylistItemRef[] {
  const scoped = channelXml.replace(PODROLL_BLOCK_RE, '');
  const out: PlaylistItemRef[] = [];
  const seen = new Set<string>();
  // ONE pass over both tag types, so the caption and the items it captions are
  // read in DOCUMENT ORDER. Two separate scans could not associate them: a
  // marker's only claim on a track is that it appears above it.
  const re = /<podcast:txt\b([^>]*)>([\s\S]*?)<\/podcast:txt>|<podcast:remoteItem\b([^>]*?)\/?>/gi;
  let episode: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scoped))) {
    if (m[1] !== undefined) {
      // `<podcast:txt>` is a general container — the same feeds carry
      // `purpose="source-feed"`, and others carry platform verification tokens
      // and npubs (see NOSTR_TXT_PURPOSES). An unqualified one is not a caption,
      // so the purpose is READ, through `readAttr` like every other attribute.
      if (readAttr(m[1], 'purpose')?.toLowerCase() !== 'episode') continue;
      const raw = m[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
      const label = decodeXmlText(raw).trim().slice(0, MAX_PLAYLIST_EPISODE_LEN);
      // An EMPTY caption clears the group rather than captioning the rest of the
      // playlist with a blank heading.
      episode = label || undefined;
      continue;
    }
    const feedGuid = readAttr(m[3], 'feedGuid');
    const itemGuid = readAttr(m[3], 'itemGuid');
    if (!feedGuid || !itemGuid) continue;
    if (feedGuid.length > MAX_FEED_GUID_LEN || itemGuid.length > MAX_ITEM_GUID_LEN) continue;
    const key = `${feedGuid}:${itemGuid}`;
    // First occurrence wins, so a track replayed on a later show keeps the
    // caption of the FIRST (newest) episode it appeared under — which is where
    // the reader will look for it.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(episode ? { feedGuid, itemGuid, episode } : { feedGuid, itemGuid });
    if (out.length >= MAX_PLAYLIST_REFS) break;
  }
  return out;
}
