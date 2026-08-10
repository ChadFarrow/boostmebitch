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

/** Read one attribute off a raw tag's attribute string. Quote-agnostic. */
export function readAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
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
