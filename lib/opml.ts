/**
 * OPML import and export — the rules, with no I/O.
 *
 * OPML is the subscription list every podcast app can write and read. A new
 * user brings one from their current app so they do not have to find every
 * show again, and a user leaving takes one with them. In this app a
 * "subscription" is a favorite SHOW, so an import adds feed favorites and an
 * export writes them. Episode and track favorites have no place in the format.
 *
 * Reading the file is `parseOpml` in lib/feed-xml.ts, beside the linear scanner
 * every XML reader here must walk a document with. This module decides what
 * happens to what was read:
 *
 *  - which addresses may LEAVE THE DEVICE to be looked up (`planOpmlImport`),
 *  - what each lookup answer means (`sortOpmlAnswers`),
 *  - and the bytes an export writes (`buildOpml`).
 *
 * IMPORT-FREE, so `npm run check:opml` loads this shipping module under
 * `node --experimental-strip-types` rather than a copy of it.
 */

/** A bigger file is refused before it is read. Overcast's extended export
 *  nests every episode under its show, so a real library runs to megabytes. */
export const OPML_MAX_BYTES = 16 * 1024 * 1024;

/** Feeds past this many in one file are counted and not planned at all. */
export const OPML_MAX_FEEDS = 2000;

/**
 * Feeds looked up per press. Each is one Podcast Index call, and a list this
 * size is already ~30 KB of `i` tags — about half of the 64 KB event ceiling
 * common relays enforce. The rest wait for the user to ask for the next run.
 */
export const OPML_LOOKUP_PER_RUN = 500;

/** `/api/by-guid/batch` drops a `url:` key over 2048 characters. */
export const OPML_URL_MAX = 2000;

/** What the reader found, before any rule here ran — `OpmlOutline` in feed-xml.ts. */
export interface OpmlOutlineIn {
  xmlUrl: string;
  title: string;
}

/** A feed this import will ask Podcast Index about. `url` is normalized. */
export interface OpmlFeed {
  url: string;
  title: string;
}

/**
 * `not-web` — not an http(s) address; nothing to look up.
 * `private` — looks like a paid or members-only feed; never sent anywhere.
 * `repeat`  — the same address again, earlier in the file.
 */
export type OpmlSkipReason = 'not-web' | 'private' | 'repeat';

export interface OpmlSkip {
  /** As written in the file. Rendered as its host only when `private`. */
  url: string;
  title: string;
  reason: OpmlSkipReason;
}

export interface OpmlPlan {
  /** In file order. */
  feeds: OpmlFeed[];
  skipped: OpmlSkip[];
  /** Valid feeds past `OPML_MAX_FEEDS`, neither planned nor looked up. */
  overCap: number;
}

/** The normalized http(s) address, or null. Same allowlist as `httpUrl`. */
export function opmlFeedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.href.length <= OPML_URL_MAX ? u.href : null;
}

// Hosts that serve paid or members-only feeds, where the address IS the key.
const PRIVATE_FEED_HOSTS = ['patreon.com', 'supercast.com', 'supportingcast.fm', 'memberful.com', 'glow.fm'];
// Query parameters that carry a credential. `auth` and `key` exactly, because
// as substrings they match `author` and `monkey`; the rest anywhere in the name.
const SECRET_PARAMS = new Set(['auth', 'key', 'apikey', 'sid', 'pass', 'pwd', 'sig']);
const SECRET_PARAM_PARTS = ['token', 'secret', 'passw', 'signature', 'session', 'api_key'];

/**
 * True when an address looks like a paid or members-only feed.
 *
 * **A private feed address is a CREDENTIAL, so it never leaves the device.**
 * Paid feeds put the subscriber's key in the URL — Patreon's `?auth=`,
 * Supercast and Supporting Cast in the path — and an export from the user's
 * current app lists them beside the public shows. A lookup sends each address
 * to our server, to the read index (which STORES the key it was asked about)
 * and to Podcast Index. None of them could become a favorite anyway: Podcast
 * Index does not list a private feed, and a favorite needs the `podcast:guid`
 * it would answer with. Keeping one back costs nothing; sending one puts a
 * paid feed's key in three databases this app does not control the retention
 * of.
 *
 * A heuristic that leans towards keeping back. A public feed that trips it is
 * named on screen ("looks private, not looked up") and can be found by search;
 * the opposite mistake cannot be taken back.
 */
export function looksPrivate(href: string): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.username || u.password) return true;
  const host = u.hostname.toLowerCase();
  if (PRIVATE_FEED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  if (u.pathname.toLowerCase().split('/').includes('private')) return true;
  for (const name of u.searchParams.keys()) {
    const n = name.toLowerCase();
    if (SECRET_PARAMS.has(n) || SECRET_PARAM_PARTS.some((p) => n.includes(p))) return true;
  }
  return false;
}

/**
 * Which of the file's feeds may be looked up, in file order.
 *
 * Validation, the private test and the repeat test all run BEFORE anything is
 * sent, which is the point of doing them here rather than on the server: the
 * server is one of the places a private address must not reach.
 */
export function planOpmlImport(outlines: readonly OpmlOutlineIn[]): OpmlPlan {
  const feeds: OpmlFeed[] = [];
  const skipped: OpmlSkip[] = [];
  const seen = new Set<string>();
  let overCap = 0;
  for (const o of outlines) {
    const url = opmlFeedUrl(o.xmlUrl);
    if (!url) {
      skipped.push({ url: o.xmlUrl, title: o.title, reason: 'not-web' });
    } else if (looksPrivate(url)) {
      skipped.push({ url: o.xmlUrl, title: o.title, reason: 'private' });
    } else if (seen.has(url)) {
      skipped.push({ url: o.xmlUrl, title: o.title, reason: 'repeat' });
    } else if (feeds.length >= OPML_MAX_FEEDS) {
      overCap += 1;
    } else {
      seen.add(url);
      feeds.push({ url, title: o.title });
    }
  }
  return { feeds, skipped, overCap };
}

/** The part of a Podcast Index record this module reads. */
export interface OpmlAnswer {
  podcastGuid?: string;
}

export interface OpmlSorted<P> {
  /** Will become a favorite, one per show. */
  add: { feed: OpmlFeed; podcast: P }[];
  /** Already a favorite, or the same show under an address earlier in the file. */
  already: OpmlFeed[];
  /** Podcast Index answered: it does not hold this feed. */
  notFound: OpmlFeed[];
  /** Podcast Index holds it with no `podcast:guid`, so it cannot be a favorite. */
  noGuid: OpmlFeed[];
  /** No answer yet — not asked, or asking failed. Never a "not found". */
  unasked: OpmlFeed[];
}

/**
 * What each lookup answer means, given `answers` keyed by `OpmlFeed.url`.
 *
 * **A key that is ABSENT is "we could not ask", and it is never "not found".**
 * That is the three-state contract `/api/by-guid/batch` returns (see
 * lib/pi-batch.ts), and collapsing it here would tell a user whose lookup hit
 * a rate limit that Podcast Index has never heard of half their library — with
 * no button to try again, because a "not found" is a final answer.
 *
 * The `podcast:guid` is what a favorite is keyed by, so two addresses for one
 * show add ONE favorite, and a show already favorited is left exactly as it is
 * — its `addedAt` and its place in the list included.
 */
export function sortOpmlAnswers<P extends OpmlAnswer>(
  feeds: readonly OpmlFeed[],
  answers: Readonly<Record<string, P | null>>,
  isFavorite: (podcastGuid: string) => boolean,
): OpmlSorted<P> {
  const out: OpmlSorted<P> = { add: [], already: [], notFound: [], noGuid: [], unasked: [] };
  const taking = new Set<string>();
  for (const feed of feeds) {
    if (!Object.prototype.hasOwnProperty.call(answers, feed.url)) {
      out.unasked.push(feed);
      continue;
    }
    const podcast = answers[feed.url];
    if (!podcast) {
      out.notFound.push(feed);
      continue;
    }
    const guid = podcast.podcastGuid;
    if (!guid) {
      out.noGuid.push(feed);
    } else if (isFavorite(guid) || taking.has(guid)) {
      out.already.push(feed);
    } else {
      taking.add(guid);
      out.add.push({ feed, podcast });
    }
  }
  return out;
}

/** One show to write. Entries without a usable `url` are left out. */
export interface OpmlShow {
  url?: string;
  title?: string;
}

/**
 * The OPML 2.0 document an export writes, and how many shows went into it.
 *
 * Every value is escaped for an attribute, and that is what keeps the file
 * importable at all: a feed address routinely carries `&` in its query string,
 * and a title routinely carries `&` and quotes. An unescaped one is not a
 * cosmetic flaw — the next app's XML parser rejects the whole document.
 * `check:opml` round-trips every vector through `parseOpml` to prove it.
 */
export function buildOpml(
  shows: readonly OpmlShow[],
  head: { title: string; created: Date },
): { xml: string; written: number } {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const show of shows) {
    const url = show.url ? opmlFeedUrl(show.url) : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = xmlAttr(show.title?.replace(/\s+/g, ' ').trim() || url);
    lines.push(`    <outline type="rss" text="${title}" title="${title}" xmlUrl="${xmlAttr(url)}"/>`);
  }
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${xmlAttr(head.title)}</title>`,
    `    <dateCreated>${head.created.toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
    ...lines,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
  return { xml, written: lines.length };
}

/**
 * A value made safe inside a double-quoted XML attribute or a text node.
 *
 * The characters XML 1.0 forbids outright are removed rather than escaped — a
 * numeric reference to one is still an error to a conforming parser — and a
 * lone surrogate becomes U+FFFD for the same reason. Tab, CR and LF are legal
 * but an attribute normalizer folds them to spaces, so they are written as
 * spaces here and the file says what every reader will see.
 */
function xmlAttr(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')
    .replace(/[\t\n\r]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `<site>-shows-<YYYY-MM-DD>.opml`, in the same shape as the favorites backup. */
export function opmlFilename(domain: string, created: Date): string {
  const site = domain.split('.')[0];
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}`;
  return `${site}-shows-${stamp}.opml`;
}
