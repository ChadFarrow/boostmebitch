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
//   playlists/index.json   one entry per copied feed, derived from the files.
//   README.md, vercel.json the branch's own description, and Vercel told not to
//                          build it (a commit here must never start a deploy).
//
// FOUR RULES, each a way the obvious version loses or corrupts a copy:
//
// 1. ONLY A 410 DELETES A COPY. A playlist missing from the list is not proof it
//    is gone: the list stops at 200, the beta site can be down, and with both
//    community switches off EVERY feed answers 404 (docs/ops.md). A deleted
//    playlist answers 410, and that answer alone removes its file. The same rule
//    as `read-trust.ts`: an empty answer is "nothing answered", never "nobody has it".
// 2. EVERY COPY ON DISK IS ASKED AGAIN, listed or not (`idsToVisit`), so a feed past
//    the list's cap still refreshes, and a deletion still reaches it.
// 3. A COPY IS REPLACED ONLY BY A WHOLE PLAYLIST FEED FOR THAT ID (`feedVerdict`):
//    a 200 that is an error page, another playlist's feed, or a body cut off before
//    `</rss>` keeps the old file. A redirect is not followed.
// 4. NOTHING HERE CHANGES WITH THE CLOCK. No "generated at" field: the workflow
//    commits only when a file changed, and a timestamp would commit every run.
//
// The id is the file name, so it is checked against a lower-case UUID before it
// touches a path (`canonicalId`). Pure functions are exported for
// `npm run check:playlistarchive`; this file has no imports but node: built-ins.

import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The origin every community feed address is on (`COMMUNITY_FEED_ORIGIN`). */
export const FEED_ORIGIN = 'https://www.boostmebuddy.com';

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

/**
 * What to do with one file: 'write', 'remove', 'keep' (an old copy stays),
 * 'unchanged', or 'none' (no copy, and nothing to write).
 */
export function fileAction(verdict, existingXml) {
  const exists = typeof existingXml === 'string';
  if (verdict.kind === 'feed') return exists && existingXml === verdict.xml ? 'unchanged' : 'write';
  if (verdict.kind === 'gone') return exists ? 'remove' : 'none';
  return exists ? 'keep' : 'none';
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

/** `playlists/index.json`: newest change first, then by id. No clock in it. */
export function buildIndex(entries) {
  const sorted = [...entries].sort((a, b) => (
    (b.updated ?? '').localeCompare(a.updated ?? '') || a.id.localeCompare(b.id)
  ));
  return `${JSON.stringify({ origin: FEED_ORIGIN, count: sorted.length, playlists: sorted }, null, 2)}\n`;
}

/** The commit message for one run, or null when nothing changed. */
export function commitMessage(changes) {
  const { added = [], changed = [], removed = [] } = changes;
  if (!added.length && !changed.length && !removed.length) return null;
  const parts = [];
  if (added.length) parts.push(`${added.length} added`);
  if (changed.length) parts.push(`${changed.length} changed`);
  if (removed.length) parts.push(`${removed.length} removed`);
  const line = (e) => `- ${e.id}${e.title ? ` ${e.title.replace(/[\r\n]+/g, ' ')}` : ''}`;
  const body = [
    ...(added.length ? ['Added:', ...added.map(line)] : []),
    ...(changed.length ? ['Changed:', ...changed.map(line)] : []),
    ...(removed.length ? ['Removed (the feed answers 410):', ...removed.map(line)] : []),
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
- \`playlists/index.json\` lists every copy: title, \`podcast:guid\`, feed address,
  song count and the time it last changed.

To use a playlist in a podcast app, subscribe to its \`feedUrl\`. To use one as a
test playlist, read the \`.xml\` file here. A deleted playlist leaves this branch;
its old copy stays in the history.
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
    headers: { 'User-Agent': 'boostmebitch-playlist-archive' },
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = join(args.root, 'playlists');
  await mkdir(dir, { recursive: true });

  // Only a file named exactly `<lower-case uuid>.xml` is a copy this script owns.
  const existing = (await readdir(dir))
    .filter((f) => f.endsWith('.xml') && f === `${canonicalId(f.slice(0, -4))}.xml`)
    .map((f) => f.slice(0, -4));
  const list = await readList(args.lists);
  if (!list.ids) warn(`no playlist list answered (${args.lists.join(', ')}); only the copies on disk are refreshed`);

  const ids = idsToVisit(list.ids, existing);
  const verdicts = await mapLimit(ids, FEED_CONCURRENCY, (id) => readFeed(args.origin, id));

  const changes = { added: [], changed: [], removed: [] };
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
    if (action === 'write') {
      (old === undefined ? changes.added : changes.changed).push({ id, title: tagText(v.xml, 'title') });
      if (!args.dryRun) await writeFile(path, v.xml);
    } else if (action === 'remove') {
      changes.removed.push({ id, title: tagText(old, 'title') });
      if (!args.dryRun) await rm(path);
    }
  }

  if (!args.dryRun) {
    const entries = [];
    for (const f of (await readdir(dir)).sort()) {
      const id = f.endsWith('.xml') ? canonicalId(f.slice(0, -4)) : null;
      if (!id || f !== `${id}.xml`) continue;
      entries.push(indexEntry(id, args.origin, await readFile(join(dir, f), 'utf8')));
    }
    await writeIfChanged(join(dir, 'index.json'), buildIndex(entries));
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
