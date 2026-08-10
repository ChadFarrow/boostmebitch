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

/** Cap on how many npubs one feed level contributes. */
const MAX_FEED_NPUBS = 4;

/**
 * Parse <podcast:txt purpose="nostr">npub1…</podcast:txt> into validated npubs.
 *
 * Works on either a channel slice (the show's own npub) or an <item> inner (a
 * track's artist). Same paired-or-self-closing shape as parseFunding, which is
 * the tag this most resembles: attributes plus a text node.
 *
 * Three things this must keep doing:
 *
 *  - **Filter on `purpose`.** <podcast:txt> is a general-purpose container —
 *    the same feed routinely carries `verify`, `applepodcastsverify` and
 *    free-text entries. Accepting an unqualified <podcast:txt> would p-tag
 *    whatever a domain-verification token happens to be.
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
export function parseNostrTxtNpubs(xml: string): FeedNpub[] | undefined {
  const out: FeedNpub[] = [];
  const seen = new Set<string>();
  const re = /<podcast:txt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/podcast:txt>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (readAttr(m[1], 'purpose')?.toLowerCase() !== 'nostr') continue;
    if (m[2] == null) continue;
    const raw = decodeXmlText(m[2]).replace(/^nostr:/i, '');
    if (!raw) continue;
    try {
      const decoded = nip19.decode(raw);
      if (decoded.type !== 'npub') continue;
      const pubkey = decoded.data as string;
      if (seen.has(pubkey)) continue;
      seen.add(pubkey);
      out.push({ npub: raw, pubkey });
      if (out.length >= MAX_FEED_NPUBS) break;
    } catch {
      // Not a decodable npub — a typo'd or truncated value is dropped, not tagged.
    }
  }
  return out.length ? out : undefined;
}
