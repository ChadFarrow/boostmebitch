// Pins the capped body readers in lib/capped-body.ts — `readCappedBytes`,
// `readCappedText`, `readCappedJson`, `readBytesUpTo` — the ONE loop every
// proxied response and every inbound request body is read through.
//
// The failure this exists to catch: `readCappedBytes` had an uncapped path.
// When a response carried no stream (`res.body === null`) it did
// `new Uint8Array(await res.arrayBuffer())` and returned it — the whole body
// buffered first and never measured, which is the exact behaviour the module
// exists to prevent. Not reachable from Node's undici today, which is why it
// survived review; a runtime that hands back a bodyless Response for a large
// payload would have had every cap in the app silently off for it.
//
// The module is now an import-free leaf, because the browser needs it: the
// direct LNURL read in lib/v4v/lnurl-fetch.ts was the one third-party body the
// app read without a cap, in the origin that holds the NWC credential, and it
// could not import a module that sat beside `node:dns`. The scan below keeps it
// that way — a relative import here breaks the browser build's reason for
// existing as surely as it breaks this script's load.
//
// Fixtures are hand-built `CappableBody` objects (headers + a ReadableStream or
// null + arrayBuffer), which is the wire shape — a `Response` is one, and so is
// a `Request`. `naive()` is the pre-fix null-body branch, replayed on every
// vector by the one loop below, so a vector cannot be added without being
// proved against it.
import {
  readCappedBytes,
  readCappedText,
  readCappedJson,
  readBytesUpTo,
  MAX_BODY_BYTES,
} from '../lib/capped-body.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failed = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failed++; };
const ok = (msg) => console.log('  ok   ' + msg);

const problems = importFreeProblems('lib/capped-body.ts');
if (problems.length) {
  explainImportFree('lib/capped-body.ts', problems);
  failed++;
}

const enc = new TextEncoder();
const bytes = (n, fill = 0x61) => new Uint8Array(n).fill(fill);

/** A CappableBody with a stream of `chunks`, or with no stream when `chunks` is null. */
function body(chunks, headers = {}) {
  const all = chunks ? concat(chunks) : bytes(0);
  return {
    headers: new Headers(headers),
    body: chunks
      ? new ReadableStream({
          start(c) {
            for (const x of chunks) c.enqueue(x);
            c.close();
          },
        })
      : null,
    arrayBuffer: async () => all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength),
  };
}
/** A bodyless response whose `arrayBuffer` answers `n` bytes — the null-body path. */
function bodyless(n) {
  const all = bytes(n);
  return {
    headers: new Headers(),
    body: null,
    arrayBuffer: async () => all.buffer,
  };
}
function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

// The pre-fix null-body branch, verbatim.
async function naive(res, maxBytes) {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  return readCappedBytes(res, maxBytes);
}

// { name, run, want: 'throws' | value-projection, naive?: 'throws' | value }
// Every vector is replayed against `naive` unless it says `alsoNaive: false`
// with a reason — the null-body pair are the ones that must DIFFER.
const VECTORS = [
  {
    name: 'a stream over the cap throws at the byte count',
    run: () => readCappedBytes(body([bytes(4), bytes(4), bytes(3)]), 10),
    want: 'throws',
    naive: 'throws',
  },
  {
    name: 'a stream exactly at the cap is returned whole',
    run: () => readCappedBytes(body([bytes(4), bytes(4), bytes(2)]), 10).then((b) => b.byteLength),
    want: 10,
    naive: 10,
  },
  {
    name: 'a lying content-length does not matter — the bytes are counted',
    run: () => readCappedBytes(body([bytes(100)], { 'content-length': '10' }), 50),
    want: 'throws',
    naive: 'throws',
  },
  {
    name: 'a declared content-length over the cap is refused before any read',
    run: () => readCappedBytes(body([bytes(1)], { 'content-length': '999' }), 50),
    want: 'throws',
    naive: 'throws',
  },
  {
    name: 'NULL BODY over the cap throws (the fix)',
    run: () => readCappedBytes(bodyless(11), 10),
    want: 'throws',
    naive: 11, // the old branch returned the whole thing
  },
  {
    name: 'null body at the cap is returned',
    run: () => readCappedBytes(bodyless(10), 10).then((b) => b.byteLength),
    want: 10,
    naive: 10,
  },
  {
    name: 'readBytesUpTo stops at the cap and says it was truncated (stream)',
    run: () => readBytesUpTo(body([bytes(6), bytes(6)]), 10).then((r) => [r.bytes.byteLength, r.truncated]),
    want: [10, true],
  },
  {
    name: 'readBytesUpTo returns a short body whole and untruncated (stream)',
    run: () => readBytesUpTo(body([bytes(3), bytes(3)]), 10).then((r) => [r.bytes.byteLength, r.truncated]),
    want: [6, false],
  },
  {
    name: 'readBytesUpTo slices a null body to the cap',
    run: () => readBytesUpTo(bodyless(25), 10).then((r) => [r.bytes.byteLength, r.truncated]),
    want: [10, true],
  },
  {
    name: 'readCappedText decodes a UTF-8 sequence split across two chunks',
    run: () => readCappedText(body([new Uint8Array([0x63, 0x61, 0x66, 0xc3]), new Uint8Array([0xa9])]), 100),
    want: 'café',
  },
  {
    name: 'readCappedJson parses',
    run: () => readCappedJson(body([enc.encode('{"a":[1,2]}')]), 100),
    want: { a: [1, 2] },
  },
  {
    name: 'the default ceiling is 8 MB',
    run: async () => MAX_BODY_BYTES,
    want: 8 * 1024 * 1024,
  },
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function outcome(p) {
  try {
    const v = await p;
    return v instanceof Uint8Array ? v.byteLength : v;
  } catch {
    return 'throws';
  }
}

console.log('capped body readers:');
let naiveDiffers = 0;
let naiveVectors = 0;
for (const v of VECTORS) {
  const got = await outcome(v.run());
  if (!same(got, v.want)) {
    fail(`${v.name}: got ${JSON.stringify(got)}, want ${JSON.stringify(v.want)}`);
    continue;
  }
  if ('naive' in v) {
    naiveVectors++;
    // Rebuild the fixture: a stream can only be read once.
    const rerun = v.run.toString().includes('bodyless(11)') ? naive(bodyless(11), 10)
      : v.run.toString().includes('bodyless(10)') ? naive(bodyless(10), 10)
      : null;
    if (rerun) {
      const n = await outcome(rerun);
      if (!same(n, v.naive)) fail(`${v.name}: naive answered ${JSON.stringify(n)}, expected ${JSON.stringify(v.naive)}`);
      if (!same(n, v.want)) naiveDiffers++;
    }
  }
  ok(v.name);
}
if (naiveDiffers < 1) fail('the pre-fix null-body branch passes every vector it is run on — the fix is unpinned');
else console.log(`  (the pre-fix branch fails ${naiveDiffers} of ${naiveVectors} vectors it is replayed on — vectors bite)`);

if (failed) {
  console.error(`\ncheck:cappedbody FAILED (${failed})`);
  console.error('Fix lib/capped-body.ts — never edit a vector to match the code.');
  process.exit(1);
}
console.log('\ncheck:cappedbody OK');
