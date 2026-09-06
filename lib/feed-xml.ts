// Small RSS/XML readers shared by the feed parsers, split out of lib/pi.ts so
// `node --experimental-strip-types` can load them — the attribute reader, the
// entity decoder, and the LINEAR tag/block scanner every parser walks a
// document with (see the scanner header below, and `npm run check:feedscan`).
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

// ── Linear tag / block scanner ──────────────────────────────────────────────
//
// **Every feed parser and the show-notes sanitizer go through these, never a
// regex with a `[\s\S]*?` or `[^>]*` body — pinned by `npm run check:feedscan`.**
//
// The failure this replaces: `/api/feed?url=` fetches a caller-chosen URL, caps
// it at 8 MB, and used to walk it with regexes of the shape
// `<item\b[^>]*>([\s\S]*?)<\/item>`. A regex retries from every candidate start,
// so a document that is N open tags with no close tag makes each attempt scan
// to the end and fail — O(N²). Measured on this machine: 800 KB of `<!--` took
// 38.7 s in the sanitizer's comment strip, 720 KB of `<script >` 10.8 s, 420 KB
// of `<item >` 6.3 s, and the 8 MB cap licences tens of minutes of pinned CPU
// for one unauthenticated request. The `[^>]*` half has the same shape with the
// `>` missing instead of the close tag: each `<enclosure` start scans to the
// end looking for a `>` that is not there.
//
// A forward scan cannot retry. It finds the next open tag with `indexOf`, walks
// its attributes once (quote-aware, so `feedGuid="a>b"` reads correctly, which
// the regexes got wrong), finds the close tag with `indexOf`, and resumes AFTER
// the hit. The two rules that make it linear are also the two that make it
// fail closed:
//
//   - An open tag with no `>` after it (or an unterminated quote) STOPS the
//     scan and returns what was found. Nothing after that point can be a
//     complete tag, so there is nothing to search for.
//   - A block whose close tag is absent STOPS the scan. No later open of that
//     name can be closed either, so a match is impossible from here on.
//
// Both answer with FEWER tags, never a wrong one — a malformed feed loses its
// tail rather than costing a request its lifetime. The regexes recovered at the
// next `>`; a feed that depends on that is a broken feed.
//
// Case folding is ASCII-only and LENGTH-PRESERVING (`asciiLower`), because the
// indices found in the lowered copy are used to slice the original.
// `String.prototype.toLowerCase` can change length (`İ` becomes two code units),
// which would shift every index after it. Tag names are ASCII, and the regexes'
// `i` flag folded ASCII names the same way.
//
// A tag name must END at whitespace, `/` or `>`. That is tighter than the
// regexes' `\b` (a word boundary), under which `<item-x>` and `<item:x>`
// satisfied `<item\b` — the same class of decoy `readAttr`'s comment documents,
// one level up.

/** One open tag: `<name …>` or `<name …/>`. */
export interface TagHit {
  /**
   * The text between the name and the closing `>`, with a self-closing tag's
   * trailing `/` removed — exactly what `readAttr` takes. Leading whitespace is
   * kept; `readAttr` anchors on it.
   */
  attrs: string;
  selfClosing: boolean;
  /** Index of the `<`. */
  start: number;
  /** Index just past the open tag's `>`. */
  openEnd: number;
}

/** An open tag with its matching close: `<name …>inner</name>`. */
export interface BlockHit extends TagHit {
  /**
   * The raw text between the open tag's `>` and the close tag's `<`. CDATA is
   * NOT unwrapped — `decodeXmlText` and `extractText` do that, as before.
   * Empty for a self-closing tag.
   */
  inner: string;
  /** Index just past `</name>`; equals `openEnd` for a self-closing tag. */
  end: number;
}

export function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

// XML's whitespace set. Deliberately not `\s`: the lowered copy is
// length-preserving, so a Unicode space would not misalign anything, but a tag
// name followed by U+00A0 is not a tag name followed by whitespace to any XML
// parser, and agreeing with them is the point.
function isNameEnd(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '/' || ch === '>';
}

/** `nextOpen` found `<name` but the tag never closes — the scan must stop. */
interface Malformed {
  malformed: true;
  start: number;
}

/**
 * The next `<name …>` at or after `from`, or null when there is none, or a
 * `Malformed` marker when one starts but has no `>` (a quote left open counts:
 * the `>` inside it belongs to the attribute).
 */
function nextOpen(xml: string, lower: string, lname: string, from: number): TagHit | Malformed | null {
  const needle = '<' + lname;
  let i = from;
  for (;;) {
    i = lower.indexOf(needle, i);
    if (i === -1) return null;
    const after = i + needle.length;
    if (after < xml.length && !isNameEnd(xml[after]!)) {
      // `<items` when looking for `item`: not this tag. Resume past the `<`.
      i += 1;
      continue;
    }
    let j = after;
    let quote: string | null = null;
    for (; j < xml.length; j++) {
      const ch = xml[j]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
    }
    if (j >= xml.length) return { malformed: true, start: i };
    let attrs = xml.slice(after, j);
    let selfClosing = false;
    if (attrs.endsWith('/')) {
      selfClosing = true;
      attrs = attrs.slice(0, -1);
    }
    return { attrs, selfClosing, start: i, openEnd: j + 1 };
  }
}

/**
 * The next `</name>` at or after `from` — optional whitespace before the `>`
 * is accepted, as XML allows — or null when there is none.
 */
function nextClose(xml: string, lower: string, lname: string, from: number): { at: number; end: number } | null {
  const needle = '</' + lname;
  let i = from;
  for (;;) {
    i = lower.indexOf(needle, i);
    if (i === -1) return null;
    let j = i + needle.length;
    while (j < xml.length && (xml[j] === ' ' || xml[j] === '\t' || xml[j] === '\n' || xml[j] === '\r')) j++;
    if (j < xml.length && xml[j] === '>') return { at: i, end: j + 1 };
    i += 1;
  }
}

/**
 * Every `<name …>` open tag in document order, self-closing ones included.
 * Stops at the first malformed one (see the header). `max` bounds the walk.
 */
export function findTags(xml: string, name: string, opts?: { max?: number }): TagHit[] {
  const lower = asciiLower(xml);
  const lname = asciiLower(name);
  const max = opts?.max ?? Infinity;
  const out: TagHit[] = [];
  let from = 0;
  while (out.length < max) {
    const hit = nextOpen(xml, lower, lname, from);
    if (!hit || 'malformed' in hit) break;
    out.push(hit);
    from = hit.openEnd;
  }
  return out;
}

export function firstTag(xml: string, name: string): TagHit | undefined {
  return findTags(xml, name, { max: 1 })[0];
}

/**
 * Every `<name …>…</name>` block in document order. A self-closing tag is a
 * block with an empty `inner`; the caller decides whether that counts. The
 * FIRST close tag wins, so nested same-name tags end at the inner close — the
 * same answer `[\s\S]*?` gave. Stops at a malformed open tag or a missing
 * close (see the header).
 */
export function findBlocks(xml: string, name: string, opts?: { max?: number }): BlockHit[] {
  const lower = asciiLower(xml);
  const lname = asciiLower(name);
  const max = opts?.max ?? Infinity;
  const out: BlockHit[] = [];
  let from = 0;
  while (out.length < max) {
    const hit = nextOpen(xml, lower, lname, from);
    if (!hit || 'malformed' in hit) break;
    if (hit.selfClosing) {
      out.push({ ...hit, inner: '', end: hit.openEnd });
      from = hit.openEnd;
      continue;
    }
    const close = nextClose(xml, lower, lname, hit.openEnd);
    if (!close) break;
    out.push({ ...hit, inner: xml.slice(hit.openEnd, close.at), end: close.end });
    from = close.end;
  }
  return out;
}

export function firstBlock(xml: string, name: string): BlockHit | undefined {
  return findBlocks(xml, name, { max: 1 })[0];
}

/**
 * Remove every `<name …>…</name>` block (and every self-closing `<name …/>`)
 * for each name, in the order given.
 *
 * `unclosed` decides what an open tag with NO close does. `'keep'` (the
 * default) leaves it and everything after it in place — XML parity, since the
 * regex this replaces did not match either. `'consume'` drops from the open
 * tag to the end of input, which is what a browser does with an unclosed
 * `<script>` or `<style>`: the sanitizer wants the browser's answer, because
 * text we keep that the browser would treat as script is the whole hazard.
 */
export function stripBlocks(
  xml: string,
  names: readonly string[],
  opts?: { unclosed?: 'keep' | 'consume' },
): string {
  const unclosed = opts?.unclosed ?? 'keep';
  let out = xml;
  for (const name of names) out = stripOne(out, asciiLower(name), unclosed);
  return out;
}

function stripOne(xml: string, lname: string, unclosed: 'keep' | 'consume'): string {
  const lower = asciiLower(xml);
  const parts: string[] = [];
  let kept = 0;
  let from = 0;
  for (;;) {
    const hit = nextOpen(xml, lower, lname, from);
    if (!hit) break;
    if ('malformed' in hit) {
      if (unclosed === 'consume') {
        parts.push(xml.slice(kept, hit.start));
        kept = xml.length;
      }
      break;
    }
    if (hit.selfClosing) {
      parts.push(xml.slice(kept, hit.start));
      kept = hit.openEnd;
      from = hit.openEnd;
      continue;
    }
    const close = nextClose(xml, lower, lname, hit.openEnd);
    if (!close) {
      if (unclosed === 'consume') {
        parts.push(xml.slice(kept, hit.start));
        kept = xml.length;
      }
      break;
    }
    parts.push(xml.slice(kept, hit.start));
    kept = close.end;
    from = close.end;
  }
  parts.push(xml.slice(kept));
  return parts.join('');
}

/**
 * Remove every `<!-- … -->`. An unclosed `<!--` consumes to the end of input,
 * and `<!-->` / `<!--->` are complete comments — both are the HTML tokenizer's
 * rules, and being at least as aggressive as the browser is the safe direction:
 * text we drop is text it would never have shown.
 */
export function stripComments(html: string): string {
  const parts: string[] = [];
  let kept = 0;
  let from = 0;
  for (;;) {
    const i = html.indexOf('<!--', from);
    if (i === -1) break;
    parts.push(html.slice(kept, i));
    const j = html.indexOf('-->', i + 2);
    if (j === -1) {
      kept = html.length;
      break;
    }
    kept = j + 3;
    from = kept;
  }
  parts.push(html.slice(kept));
  return parts.join('');
}

/**
 * Split sanitized HTML on its `<a …>…</a>` blocks: even indices are text
 * (which may still hold other tags), odd indices are whole anchors. The shape
 * `String.split` with a capturing group produced. An unclosed `<a>` stays in
 * the text half, as it did under the regex.
 */
export function splitAnchors(html: string): string[] {
  const out: string[] = [];
  let kept = 0;
  for (const b of findBlocks(html, 'a')) {
    out.push(html.slice(kept, b.start), html.slice(b.start, b.end));
    kept = b.end;
  }
  out.push(html.slice(kept));
  return out;
}

/**
 * Turn every `<` that has no `>` anywhere after it into `&lt;`.
 *
 * The sanitizer keeps two greedy `[^>]*` regexes after this (the allowlist tag
 * pass and `mapNotesText`'s tag split), and each is linear ONLY when every `<`
 * is followed by a `>` somewhere: then a `[^>]*` run always terminates at the
 * next `>` and the match consumes what it scanned. A tail of `<<<<` with no
 * `>` is the input that made each start re-scan to the end. Only the tail
 * after the LAST `>` can hold such a `<`, so that is all this touches;
 * everything before it is unchanged. Idempotent, and the browser would not have
 * rendered those characters as a tag anyway.
 */
export function escapeDanglingLt(html: string): string {
  const k = html.lastIndexOf('>');
  const tail = html.slice(k + 1);
  if (!tail.includes('<')) return html;
  return html.slice(0, k + 1) + tail.replace(/</g, '&lt;');
}

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
 *
 * The first-item search is a single `search` with no `[^>]*` body, so it is
 * linear as it stands. It is deliberately looser than `findBlocks` (it accepts
 * `<item-x` as the first item where the scanner would not): the cost of that
 * disagreement is a SHORTER channel slice, which is the fail-closed direction.
 */
export function channelSlice(xml: string): string {
  const firstItem = xml.search(/<item\b/i);
  return stripBlocks(firstItem === -1 ? xml : xml.slice(0, firstItem), ['podcast:liveItem']);
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
  for (const hit of findBlocks(xml, 'podcast:txt')) {
    const purpose = readAttr(hit.attrs, 'purpose')?.toLowerCase();
    if (!purpose || !NOSTR_TXT_PURPOSES.has(purpose)) continue;
    // A self-closing tag carries no text node, so it names nobody.
    if (hit.selfClosing) continue;
    const n = decodeNpub(decodeXmlText(hit.inner));
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
  // Open tags only: the npub is an attribute, and the text node is the name.
  for (const hit of findTags(xml, 'podcast:person')) {
    const raw = readAttr(hit.attrs, 'npub');
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
  /**
   * The `<podcast:txt purpose="playcount">` marker this track sat under, as a
   * number of plays. The Greatest Hits playlist is "organized by play count":
   * it writes `24 plays` above the run of tracks played 24 times, then
   * `21 plays`, and so on down to `2 plays`. A NUMBER, not the marker's text:
   * the row prints it, so free text is never carried, and a marker with no
   * leading integer stamps nothing. Independent of `episode` — one marker kind
   * never clears the other.
   */
  plays?: number;
}

/**
 * Cap on an episode caption, which is feed-supplied text rendered as a heading.
 * Real ones are like "Homegrown Hits - Episode 147"; this only stops a
 * pathological feed pushing a novel into the list.
 */
const MAX_PLAYLIST_EPISODE_LEN = 200;

/**
 * The number a `<podcast:txt purpose="playcount">` marker carries, or undefined.
 *
 * The live marker is `24 plays`; a bare `24` is accepted too. Only a LEADING
 * run of digits counts, so `plays: 24` is not read as 24 and `0 plays` is not
 * a count — a track on a most-played list with zero plays is a data error, and
 * printing it would state the error as a fact. Nine digits is far above any
 * real count and keeps the number a safe integer.
 */
function parsePlayCount(text: string): number | undefined {
  const m = /^(\d{1,9})(?!\d)/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 ? n : undefined;
}

/**
 * A `<podcast:podroll>` block, whose remoteItems are NOT playlist tracks.
 *
 * `parsePodroll` scopes itself *into* this block, so the two parsers don't
 * collide from that direction — but a channel-wide scan reads the host's
 * recommended shows as songs, and there is nothing on the entry itself to tell
 * them apart. The nesting is the only signal, so it has to be honoured here.
 */
const PODROLL_BLOCK_TAG = 'podcast:podroll';

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
/**
 * The show a playlist was built FROM — `<podcast:txt purpose="source-feed">`.
 *
 * Every playlist in the collection carries one, at channel level, naming the
 * podcast whose episodes the tracks were played on. It is the missing half of
 * the `purpose="episode"` markers `parsePlaylistRemoteItems` reads: those give
 * a bare episode title like "Saddle Up", which on screen reads as a random
 * word until something says which show it is an episode of.
 *
 * **Pass `channelSlice(xml)`, never raw XML**, for the same reason that parser
 * does — a `<podcast:liveItem>` carries its own tags and must not contribute.
 * The `purpose` is READ rather than assumed: other feeds put verification
 * tokens and npubs under an unqualified `<podcast:txt>`, so matching the tag
 * alone would return somebody's Twitter handle as a feed URL.
 *
 * Returns the first one, or undefined. Never throws — a playlist without a
 * marker is ordinary. (The Greatest Hits list's marker names the GitHub repo
 * rather than a feed, so `getFeedTitle` answers null for it and no heading
 * renders — it publishes `purpose="playcount"` markers instead, see
 * `parsePlaylistRemoteItems`.)
 */
export function parsePlaylistSourceFeed(channelXml: string): string | undefined {
  for (const hit of findBlocks(channelXml, 'podcast:txt')) {
    if (hit.selfClosing) continue;
    // Through `readAttr`, never a local regex — `-` is a non-word character, so
    // a `\b`-anchored test for `purpose` matches inside `x-purpose` and a decoy
    // attribute ahead of the real one would steer this. Same rule the ref
    // parser above follows.
    if (readAttr(hit.attrs, 'purpose')?.toLowerCase() !== 'source-feed') continue;
    const raw = hit.inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    const url = decodeXmlText(raw).trim();
    // It is going to be FETCHED, so the shape is checked here rather than at
    // the call site: a non-http string is not worth carrying, and the length
    // cap matches every other feed-supplied URL in this module. `safeFetch`
    // still re-validates it — this is a cheap reject, not the security guard.
    if (/^https?:\/\//i.test(url) && url.length <= 2048) return url;
  }
  return undefined;
}

export function parsePlaylistRemoteItems(channelXml: string): PlaylistItemRef[] {
  const scoped = stripBlocks(channelXml, [PODROLL_BLOCK_TAG]);
  const out: PlaylistItemRef[] = [];
  const seen = new Set<string>();
  // Both tag types, merged into DOCUMENT ORDER, so the caption and the items it
  // captions are read in sequence. Two scans that were not merged could not
  // associate them: a marker's only claim on a track is that it appears above
  // it. A remoteItem that sits INSIDE a txt block belongs to the caption, not
  // the list — the one-pass regex this replaces consumed the whole block and
  // never saw it, and that is kept.
  const txts = findBlocks(scoped, 'podcast:txt');
  const items = findTags(scoped, 'podcast:remoteItem');
  type Entry = { at: number; txt?: BlockHit; item?: TagHit };
  const merged: Entry[] = [];
  let ti = 0;
  let ii = 0;
  while (ti < txts.length || ii < items.length) {
    const t = txts[ti];
    const it = items[ii];
    if (t && (!it || t.start <= it.start)) {
      merged.push({ at: t.start, txt: t });
      ti++;
      // Skip every remoteItem the block encloses.
      while (ii < items.length && items[ii]!.start < t.end) ii++;
    } else if (it) {
      merged.push({ at: it.start, item: it });
      ii++;
    }
  }
  let episode: string | undefined;
  let plays: number | undefined;
  for (const entry of merged) {
    if (entry.txt) {
      // `<podcast:txt>` is a general container — the same feeds carry
      // `purpose="source-feed"`, and others carry platform verification tokens
      // and npubs (see NOSTR_TXT_PURPOSES). An unqualified one is not a caption,
      // so the purpose is READ, through `readAttr` like every other attribute.
      const purpose = readAttr(entry.txt.attrs, 'purpose')?.toLowerCase();
      if (purpose !== 'episode' && purpose !== 'playcount') continue;
      const raw = entry.txt.inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
      const text = decodeXmlText(raw).trim();
      if (purpose === 'playcount') {
        // Two INDEPENDENT states: a play-count marker never clears an episode
        // caption and an episode marker never clears a count. A marker that
        // carries no number clears the count, for the same reason an empty
        // caption clears the group — carrying the previous run's number onto
        // this one would state a count the curator did not write.
        plays = parsePlayCount(text);
        continue;
      }
      const label = text.slice(0, MAX_PLAYLIST_EPISODE_LEN);
      // An EMPTY caption clears the group rather than captioning the rest of the
      // playlist with a blank heading.
      episode = label || undefined;
      continue;
    }
    const attrs = entry.item!.attrs;
    const feedGuid = readAttr(attrs, 'feedGuid');
    const itemGuid = readAttr(attrs, 'itemGuid');
    if (!feedGuid || !itemGuid) continue;
    if (feedGuid.length > MAX_FEED_GUID_LEN || itemGuid.length > MAX_ITEM_GUID_LEN) continue;
    const key = `${feedGuid}:${itemGuid}`;
    // First occurrence wins, so a track replayed on a later show keeps the
    // caption of the FIRST (newest) episode it appeared under — which is where
    // the reader will look for it.
    if (seen.has(key)) continue;
    seen.add(key);
    const ref: PlaylistItemRef = { feedGuid, itemGuid };
    if (episode) ref.episode = episode;
    if (plays) ref.plays = plays;
    out.push(ref);
    if (out.length >= MAX_PLAYLIST_REFS) break;
  }
  return out;
}
