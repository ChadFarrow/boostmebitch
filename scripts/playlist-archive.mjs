#!/usr/bin/env node
// The GitHub copy of every community playlist (Chad, 2026-11-19: "when someone
// hits publish, it saves to the Boost Me Bitch repo in a folder with just all the
// playlists"). `.github/workflows/playlist-archive.yml` runs this and commits what
// it writes to the `playlists` branch. Reasoning: docs/feeds.md, "The GitHub copy".
//
// WHAT IT WRITES, under --root:
//   playlists/<uuid>.xml   the feed EXACTLY as www.boostmebuddy.com serves it, so a
//                          playlist can be rebuilt, or pulled in as a test playlist,
//                          from GitHub alone. Test playlists are copied too (Chad).
//   playlists/removed/<uuid>.xml
//                          the last copy of a playlist that was deleted from the
//                          site (its feed answers 410), unchanged. Chad, 2026-11-19:
//                          "if I delete one from the admin page, can we note on
//                          GitHub that it was removed from the site?"
//   playlists/index.json   one entry per copied feed, derived from the files, and
//                          under `removed` one per removed copy, with the time a
//                          run first saw the 410 (`removed`).
//   README.md, vercel.json the branch's own description, and Vercel told not to
//                          build it (a commit here must never start a deploy).
//
// FIVE RULES, each a way the obvious version loses or corrupts a copy:
//
// 1. ONLY A 410 MOVES A COPY TO removed/. A playlist missing from the list is not
//    proof it is gone: the list stops at 200, the beta site can be down, and with
//    both community switches off EVERY feed answers 404 (docs/ops.md). A deleted
//    playlist answers 410, and that answer alone moves its file. The same rule as
//    `read-trust.ts`: an empty answer is "nothing answered", never "nobody has it".
//    No answer DELETES a copy: a removed playlist keeps its last feed here.
// 2. EVERY LIVE COPY ON DISK IS ASKED AGAIN, listed or not (`idsToVisit`), so a feed
//    past the list's cap still refreshes, and a deletion still reaches it. A copy in
//    removed/ is not asked again: the site cannot undo a delete. If its id is LISTED
//    again (a row restored by hand in the database), its new feed is written and the
//    removed copy goes, so one id is never in both places.
// 3. A COPY IS REPLACED ONLY BY A WHOLE PLAYLIST FEED FOR THAT ID (`feedVerdict`):
//    a 200 that is an error page, another playlist's feed, or a body cut off before
//    `</rss>` keeps the old file. A redirect is not followed.
// 4. NOTHING HERE CHANGES WITH THE CLOCK. No "generated at" field: the workflow
//    commits only when a file changed, and a timestamp would commit every run.
// 5. THE REMOVAL TIME IS WRITTEN ONCE (`removalTimes`). The run that moves a copy
//    stamps it; every later run carries the time from the last `index.json`, so
//    rule 4 holds. Only a removed copy with no readable time gets the run's clock.
//
// The id is the file name, so it is checked against a lower-case UUID before it
// touches a path (`canonicalId`). Pure functions are exported for
// `npm run check:playlistarchive`; this file has no imports but node: built-ins.

import { readFile, writeFile, readdir, mkdir, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The origin every community feed address is on (`COMMUNITY_FEED_ORIGIN`). */
export const FEED_ORIGIN = 'https://www.boostmebuddy.com';

/**
 * `BRANDS.bmb.userAgent` (`lib/brand.ts`), written out: the Action that runs this
 * script checks out `scripts/` only, so it cannot import that module or read
 * `package.json`. `check:brand` asserts the two are equal, so a version bump or
 * a change of form fails there rather than drifting here.
 */
export const USER_AGENT = 'BoostMeBitch/0.1.0 (+https://www.boostmebitch.com)';

/**
 * Where the list of playlists is read, first answer wins. The list route is on
 * only where `NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on`: today that is beta alone, and
 * www.boostmebuddy.com answers 404 until launch, then answers first.
 */
export const LIST_URLS = [
  'https://www.boostmebuddy.com/api/community-playlists',
  'https://beta.boostmebitch.com/api/community-playlists',
];

/** A real 500-song feed is about 150 KB. A body past this is not ours. */
export const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const FEED_CONCURRENCY = 4;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The id as a file name, or null. Lower-cased first: macOS and Windows file
 * systems ignore case, so two spellings of one id must not become two files.
 */
export function canonicalId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.toLowerCase();
  return UUID.test(id) ? id : null;
}

/**
 * The ids in a `/api/community-playlists` body, sorted and unique, or null when
 * the body is not that answer. An entry with a bad id is skipped, not fatal.
 */
export function listedIds(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.playlists)) return null;
  const ids = new Set();
  for (const p of body.playlists) {
    const id = canonicalId(p && typeof p === 'object' ? p.id : null);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

/** Every id to ask about: the listed ones and every copy already on disk. */
export function idsToVisit(listed, existing) {
  return [...new Set([...(listed ?? []), ...existing])].sort();
}

/** The address of one playlist's feed. */
export function feedUrlFor(origin, id) {
  return `${origin}/feeds/playlists/${id}.xml`;
}

/**
 * What one feed answer means for its copy:
 *   { kind: 'feed', xml }  a whole playlist feed for THIS id: write it
 *   { kind: 'gone' }       410: the playlist was deleted, so the copy goes
 *   { kind: 'unknown', why } anything else: keep whatever copy there is
 */
export function feedVerdict(id, origin, status, text) {
  if (status === 410) return { kind: 'gone' };
  if (status !== 200) return { kind: 'unknown', why: `HTTP ${status}` };
  if (typeof text !== 'string' || !text) return { kind: 'unknown', why: 'empty body' };
  if (text.length > MAX_FEED_BYTES) return { kind: 'unknown', why: 'too large' };
  const head = text.trimStart();
  if (!head.startsWith('<?xml') && !head.startsWith('<rss')) return { kind: 'unknown', why: 'not XML' };
  if (!text.trimEnd().endsWith('</rss>')) return { kind: 'unknown', why: 'cut off before </rss>' };
  if (!text.includes('<podcast:medium>musicL</podcast:medium>')) return { kind: 'unknown', why: 'not a musicL feed' };
  if (!tagText(text, 'podcast:guid')) return { kind: 'unknown', why: 'no podcast:guid' };
  if (tagText(text, 'link') !== feedUrlFor(origin, id)) return { kind: 'unknown', why: 'another feed' };
  return { kind: 'feed', xml: text };
}

/** The folder, inside `playlists/`, that holds the copies of removed playlists. */
export const REMOVED_DIR = 'removed';

/**
 * What to do with one live file: 'write', 'move-to-removed' (rule 1), 'keep' (an
 * old copy stays), 'unchanged', or 'none' (no copy, and nothing to write).
 */
export function fileAction(verdict, existingXml) {
  const exists = typeof existingXml === 'string';
  if (verdict.kind === 'feed') return exists && existingXml === verdict.xml ? 'unchanged' : 'write';
  if (verdict.kind === 'gone') return exists ? 'move-to-removed' : 'none';
  return exists ? 'keep' : 'none';
}

/**
 * The removal time of each removed copy, read from the LAST `index.json` text
 * (rule 5): a Map of id to an ISO time. Anything unreadable gives no entry, never
 * a throw: that copy is then stamped again, once.
 */
export function removalTimes(indexText) {
  const out = new Map();
  let body;
  try {
    body = JSON.parse(indexText);
  } catch {
    return out;
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.removed)) return out;
  for (const e of body.removed) {
    const id = canonicalId(e && typeof e === 'object' ? e.id : null);
    const at = e && typeof e === 'object' ? e.removed : null;
    if (!id || typeof at !== 'string' || Number.isNaN(Date.parse(at))) continue;
    out.set(id, new Date(Date.parse(at)).toISOString());
  }
  return out;
}

/** The index entry of a removed copy: the feed's entry, its file in removed/, and when. */
export function removedEntry(id, origin, xml, removedAt) {
  return { ...indexEntry(id, origin, xml), file: `${REMOVED_DIR}/${id}.xml`, removed: removedAt };
}

/** The text of the FIRST `<tag>…</tag>` in a document, unescaped, or ''. */
export function tagText(xml, tag) {
  const open = `<${tag}>`;
  const start = xml.indexOf(open);
  if (start < 0) return '';
  const from = start + open.length;
  const end = xml.indexOf(`</${tag}>`, from);
  if (end < 0) return '';
  return unescapeXml(xml.slice(from, end).trim());
}

/** XML character references and the five named entities; `&amp;` last. */
export function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (m, h) => codePoint(parseInt(h, 16), m))
    .replace(/&#([0-9]{1,7});/g, (m, d) => codePoint(parseInt(d, 10), m))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function codePoint(n, fallback) {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

/**
 * How many songs a playlist feed lists: `<podcast:remoteItem>` tags that carry an
 * `itemGuid`. The channel's `<podcast:publisher>` back-link is a remoteItem too
 * and has none, so counting every remoteItem is one too many (docs/feeds.md).
 */
export function songCount(xml) {
  let n = 0;
  let at = 0;
  for (;;) {
    const i = xml.indexOf('<podcast:remoteItem', at);
    if (i < 0) return n;
    const end = xml.indexOf('>', i);
    if (end < 0) return n;
    if (/\sitemGuid="/.test(xml.slice(i, end))) n += 1;
    at = end + 1;
  }
}

/** One index entry, read from a copied feed. */
export function indexEntry(id, origin, xml) {
  const updated = Date.parse(tagText(xml, 'pubDate'));
  return {
    id,
    title: tagText(xml, 'title'),
    podcastGuid: tagText(xml, 'podcast:guid'),
    feedUrl: feedUrlFor(origin, id),
    file: `${id}.xml`,
    songs: songCount(xml),
    updated: Number.isNaN(updated) ? null : new Date(updated).toISOString(),
  };
}

/**
 * `playlists/index.json`: the live copies newest change first, then by id; the
 * removed copies (`removed`) newest removal first, then by id. No run's clock in
 * it: a removal time is carried, never restamped (rules 4 and 5).
 */
export function buildIndex(entries, removedEntries = []) {
  const sorted = [...entries].sort((a, b) => (
    (b.updated ?? '').localeCompare(a.updated ?? '') || a.id.localeCompare(b.id)
  ));
  const removed = [...removedEntries].sort((a, b) => (
    (b.removed ?? '').localeCompare(a.removed ?? '') || a.id.localeCompare(b.id)
  ));
  return `${JSON.stringify({ origin: FEED_ORIGIN, count: sorted.length, playlists: sorted, removed }, null, 2)}\n`;
}

/** The commit message for one run, or null when nothing changed. */
export function commitMessage(changes) {
  const { added = [], changed = [], removed = [], restored = [] } = changes;
  if (!added.length && !changed.length && !removed.length && !restored.length) return null;
  const parts = [];
  if (added.length) parts.push(`${added.length} added`);
  if (changed.length) parts.push(`${changed.length} changed`);
  if (removed.length) parts.push(`${removed.length} removed from the site`);
  if (restored.length) parts.push(`${restored.length} back on the site`);
  const line = (e) => `- ${e.id}${e.title ? ` ${e.title.replace(/[\r\n]+/g, ' ')}` : ''}`;
  const body = [
    ...(added.length ? ['Added:', ...added.map(line)] : []),
    ...(changed.length ? ['Changed:', ...changed.map(line)] : []),
    ...(removed.length
      ? [`Removed from the site (the feed answers 410). The last copy moves to playlists/${REMOVED_DIR}/:`, ...removed.map(line)]
      : []),
    ...(restored.length ? [`Back on the site (moved out of playlists/${REMOVED_DIR}/):`, ...restored.map(line)] : []),
  ];
  return `playlists: ${parts.join(', ')}\n\n${body.join('\n')}\n`;
}

export const README = `# Boost Me Bitch / Boost Me Buddy playlists

Every playlist that listeners made on Boost Me Bitch or Boost Me Buddy, test
playlists included. This branch holds only these files. A GitHub Action
(\`.github/workflows/playlist-archive.yml\` on \`main\`) copies them from the
live site when a playlist is published, edited or deleted, and every 15 minutes.

- \`playlists/<id>.xml\` is the playlist's Podcasting 2.0 feed (\`musicL\`), exactly
  as the site serves it. Each song is a \`<podcast:remoteItem>\` that names the
  song's own feed. The playlist takes no payment: a boost pays the song's artist.
- \`playlists/${REMOVED_DIR}/<id>.xml\` is the last copy of a playlist that was removed
  from the site, by its maker or by the site's admin. Its feed address answers
  \`410 Gone\` now, so a podcast app cannot use it.
- \`playlists/index.json\` lists every copy: title, \`podcast:guid\`, feed address,
  song count and the time it last changed. Under \`removed\` it lists the removed
  copies, each with \`removed\`: the time (UTC) the copy job first saw the \`410\`.
  The playlist was removed a short time before that.

To use a playlist in a podcast app, subscribe to its \`feedUrl\`. To use one as a
test playlist, read the \`.xml\` file here.
`;

/** Vercel builds every pushed branch unless the branch's own config says no. */
export const VERCEL_JSON = `${JSON.stringify({ git: { deploymentEnabled: false } }, null, 2)}\n`;

// ---------------------------------------------------------------------------
// I/O below. Nothing above this line touches the network or the disk.

async function readCapped(res, cap) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function get(url, cap, redirect) {
  const res = await fetch(url, {
    redirect,
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await readCapped(res, cap);
  return { status: res.status, text };
}

async function readList(urls) {
  for (const url of urls) {
    try {
      const { status, text } = await get(url, MAX_LIST_BYTES, 'follow');
      if (status !== 200 || text === null) continue;
      const ids = listedIds(JSON.parse(text));
      if (ids) return { source: url, ids };
    } catch {
      // the next source
    }
  }
  return { source: null, ids: null };
}

async function readFeed(origin, id) {
  try {
    // A redirect is never followed: the feed origin answers its own feeds.
    const { status, text } = await get(feedUrlFor(origin, id), MAX_FEED_BYTES, 'manual');
    return feedVerdict(id, origin, status, text ?? '');
  } catch (e) {
    return { kind: 'unknown', why: e instanceof Error ? e.message : 'fetch failed' };
  }
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function writeIfChanged(path, text) {
  if ((await readIfExists(path)) === text) return false;
  await writeFile(path, text);
  return true;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

function parseArgs(argv) {
  const a = { root: null, lists: [], origin: FEED_ORIGIN, messageFile: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--root') a.root = argv[++i];
    else if (k === '--list') a.lists.push(argv[++i]);
    else if (k === '--feed-origin') a.origin = argv[++i];
    else if (k === '--message-file') a.messageFile = argv[++i];
    else if (k === '--dry-run') a.dryRun = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.root) throw new Error('usage: playlist-archive.mjs --root <dir> [--list <url>]… [--feed-origin <origin>] [--message-file <path>] [--dry-run]');
  if (!a.lists.length) a.lists = LIST_URLS;
  return a;
}

function warn(msg) {
  // A GitHub annotation in Actions, a plain line elsewhere.
  console.log(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `warning: ${msg}`);
}

/** The ids of the copies in one folder: only a file named exactly `<lower-case uuid>.xml`. */
async function copyIds(path) {
  let names;
  try {
    names = await readdir(path);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith('.xml') && f === `${canonicalId(f.slice(0, -4))}.xml`)
    .map((f) => f.slice(0, -4))
    .sort();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = join(args.root, 'playlists');
  const removedDir = join(dir, REMOVED_DIR);
  await mkdir(dir, { recursive: true });

  // This run's time is used only for a copy that moves to removed/ now, or one
  // with no readable time; every other removal time is carried (rule 5).
  const now = new Date().toISOString();
  const times = removalTimes((await readIfExists(join(dir, 'index.json'))) ?? '');

  const existing = await copyIds(dir);
  const alreadyRemoved = new Set(await copyIds(removedDir));
  const list = await readList(args.lists);
  if (!list.ids) warn(`no playlist list answered (${args.lists.join(', ')}); only the copies on disk are refreshed`);

  const ids = idsToVisit(list.ids, existing);
  const verdicts = await mapLimit(ids, FEED_CONCURRENCY, (id) => readFeed(args.origin, id));

  const changes = { added: [], changed: [], removed: [], restored: [] };
  const kept = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const v = verdicts[i];
    const path = join(dir, `${id}.xml`);
    const old = await readIfExists(path);
    const action = fileAction(v, old);
    if (v.kind === 'unknown') {
      kept.push(id);
      warn(`${id}: ${v.why}; ${old === undefined ? 'no copy yet' : 'the old copy stays'}`);
    }
    // Rule 2: a removed id whose feed answers again is back on the site; one id, one place.
    const back = v.kind === 'feed' && alreadyRemoved.has(id);
    if (back) {
      changes.restored.push({ id, title: tagText(v.xml, 'title') });
      if (!args.dryRun) await rm(join(removedDir, `${id}.xml`));
      times.delete(id);
    }
    if (action === 'write') {
      if (!back) (old === undefined ? changes.added : changes.changed).push({ id, title: tagText(v.xml, 'title') });
      if (!args.dryRun) await writeFile(path, v.xml);
    } else if (action === 'move-to-removed') {
      // Rule 1: the copy is kept, unchanged, and the move is the note.
      changes.removed.push({ id, title: tagText(old, 'title') });
      times.set(id, now);
      if (!args.dryRun) {
        await mkdir(removedDir, { recursive: true });
        await rename(path, join(removedDir, `${id}.xml`));
      }
    }
  }

  if (!args.dryRun) {
    const entries = [];
    for (const id of await copyIds(dir)) {
      entries.push(indexEntry(id, args.origin, await readFile(join(dir, `${id}.xml`), 'utf8')));
    }
    const removedEntries = [];
    for (const id of await copyIds(removedDir)) {
      const xml = await readFile(join(removedDir, `${id}.xml`), 'utf8');
      removedEntries.push(removedEntry(id, args.origin, xml, times.get(id) ?? now));
    }
    await writeIfChanged(join(dir, 'index.json'), buildIndex(entries, removedEntries));
    await writeIfChanged(join(args.root, 'README.md'), README);
    await writeIfChanged(join(args.root, 'vercel.json'), VERCEL_JSON);
  }

  const message = commitMessage(changes);
  if (args.messageFile) await writeFile(args.messageFile, message ?? 'playlists: refresh the index\n');
  console.log(JSON.stringify({
    listSource: list.source,
    listed: list.ids?.length ?? null,
    visited: ids.length,
    added: changes.added.length,
    changed: changes.changed.length,
    removed: changes.removed.length,
    restored: changes.restored.length,
    keptOnFailure: kept.length,
    dryRun: args.dryRun,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
