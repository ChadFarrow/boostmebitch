// Pins what `/api/audio`'s headers look like ON THE WIRE — after Next's own
// `sendResponse` has decided which of them leave the server.
//
// Usage:
//   npm run check:audiowire
//
// Run it after ANY change to the `next` version, to `audioProxyHeaders`,
// `statedDownloadBytes` or `endedShort` (lib/downloads/download-rules.ts), or to
// how app/api/audio/route.ts and lib/downloads/downloads-cache.ts call them.
//
// THE FAILURE IT WAS WRITTEN AGAINST. #662 moved `next` to 15.5.29 on
// 2026-11-22, and 15.5.29's `sendResponse` drops `content-length`,
// `content-encoding` and `transfer-encoding` from EVERY route handler's response
// (`FORBIDDEN_HEADERS`, its fix for GHSA-pc58-hwjq-p385). The route set
// `Content-Length` from the host's declared size, the client read
// `content-length`, and production then served every proxied download with no
// length at all — measured on boostmebitch.com the same day, and on a local
// `next build && next start`: 15.5.28 answered `content-length: 8945229`,
// 15.5.29 answered `Transfer-Encoding: chunked` and nothing else. The progress
// bar lost its denominator, the second room check stopped running, and nothing
// on the wire said how long a whole file is. A green typecheck, lint, build and
// every other check: they all stop at the Response object, and the header is
// removed after it.
//
// WHY NOT PIN 15.5.28. 16.4.5, 16.4.6 and the 16.5 canary drop the same three
// headers, so a pin lasts until the next Next security release and then this
// breaks again. The length now travels on `X-Expected-Length`, which Next does
// not know and passes untouched, and the client counts the bytes itself.
//
// SO THIS DRIVES NEXT'S REAL `sendResponse` OVER A REAL SOCKET, with the REAL
// header builder and the REAL client reader imported from the shipping leaf
// under `--experimental-strip-types`. The client is Node's `fetch`, the same
// undici family whose framing rules a browser follows: a chunked body that ends
// cleanly is a whole body to it, which is the case the count exists for.
//
// `naive` is the code before this fix: the route set `Content-Length` only, the
// client read `content-length` only and counted nothing. On a Next that strips
// the header it MUST fail the vectors not marked `alsoNaive`, or they prove
// nothing. On a Next that passes the header (15.5.28 and older) naive is
// reported, not gated, because there it was right.
//
// The upstream host headers are from the wire: the plain vector is
// `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3` as it answered
// `curl -sI` on 2026-11-22 (`content-length: 8945229`, `content-type: audio/mpeg`).

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  PROXY_LENGTH_HEADER,
  audioProxyHeaders,
  endedShort,
  proxyBodyLength,
  statedDownloadBytes,
} from '../lib/downloads/download-rules.ts';

const require = createRequire(import.meta.url);
const { sendResponse } = require('next/dist/server/send-response.js');
const { NodeNextRequest, NodeNextResponse } = require('next/dist/server/base-http/node.js');
const NEXT = require('next/package.json').version;

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);

const SOUNDHELIX = 8_945_229;

// ---------------------------------------------------------------------------
// The two implementations: the shipping leaf, and the code before this fix.
// ---------------------------------------------------------------------------
const shipping = {
  headers: audioProxyHeaders,
  stated: statedDownloadBytes,
  short: endedShort,
};
const naive = {
  headers(upstream) {
    const h = new Headers({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    const declared = Number(upstream.get('content-length'));
    if (!upstream.get('content-encoding') && Number.isFinite(declared) && declared > 0) h.set('Content-Length', String(declared));
    return h;
  },
  stated(headers) {
    const n = Number(headers.get('content-length'));
    return Number.isFinite(n) && n > 0 ? n : null;
  },
  short() { return false; },
};

// ---------------------------------------------------------------------------
// One server: each request names its vector and its implementation.
// ---------------------------------------------------------------------------
const VECTORS = {
  // A host that declares its length and sends exactly that many bytes.
  whole: { upstream: { 'content-type': 'audio/mpeg', 'content-length': String(SOUNDHELIX) }, send: SOUNDHELIX, end: 'close' },
  // fetch DECODED this body, so the host's length is the compressed size and
  // the route must promise nothing. 900 decoded bytes under a 1000-byte header
  // is a gzipped mp3: gzip makes incompressible audio LARGER.
  encoded: { upstream: { 'content-type': 'audio/mpeg', 'content-encoding': 'gzip', 'content-length': '1000' }, send: 900, end: 'close', alsoNaive: true },
  // The stream ends CLEANLY halfway: the case nothing on the wire catches once
  // the length is gone.
  'cut-clean': { upstream: { 'content-type': 'audio/mpeg', 'content-length': String(SOUNDHELIX) }, send: SOUNDHELIX / 2 | 0, end: 'close' },
  // The stream ERRORS halfway. Next destroys the socket, so the read rejects
  // with or without a length — Next's own behaviour, measured, kept so that a
  // Next that starts ending such a body cleanly is caught here.
  'cut-error': { upstream: { 'content-type': 'audio/mpeg', 'content-length': String(SOUNDHELIX) }, send: SOUNDHELIX / 2 | 0, end: 'error', alsoNaive: true },
};

function body(bytes, end) {
  let sent = 0;
  return new ReadableStream({
    pull(c) {
      if (sent >= bytes) {
        if (end === 'error') c.error(new Error('upstream terminated'));
        else c.close();
        return;
      }
      const n = Math.min(65_536, bytes - sent);
      sent += n;
      c.enqueue(new Uint8Array(n));
    },
  });
}

const server = createServer(async (rawReq, rawRes) => {
  const [, impl, name] = rawReq.url.split('/');
  const v = VECTORS[name];
  const headers = (impl === 'naive' ? naive : shipping).headers(new Headers(v.upstream));
  const response = new Response(body(v.send, v.end), { status: 200, headers });
  try {
    await sendResponse(new NodeNextRequest(rawReq), new NodeNextResponse(rawRes), response);
  } catch {
    // Next rethrows "failed to pipe response" after it destroys the socket;
    // the client side is what this check reads.
  }
});
// A response that ends short of a Content-Length it sent leaves the socket
// waiting for bytes that never come, until keep-alive closes it.
server.keepAliveTimeout = 300;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

/** What `downloadBytes` would do with this response — its reader, our count. */
async function download(impl, name) {
  const m = impl === 'naive' ? naive : shipping;
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/${impl}/${name}`);
  } catch (e) {
    return { outcome: 'rejected', wire: null, stated: null, received: 0, why: e.cause?.code ?? e.message };
  }
  const wire = Object.fromEntries(res.headers);
  const stated = m.stated(res.headers, true);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
    }
  } catch (e) {
    return { outcome: 'rejected', wire, stated, received, why: e.cause?.code ?? e.message };
  }
  if (m.short(true, received, stated)) return { outcome: 'caught-short', wire, stated, received };
  return { outcome: 'accepted', wire, stated, received };
}

/** The verdict a vector must reach. Returns a problem string, or null. */
function judge(name, r) {
  const v = VECTORS[name];
  switch (name) {
    case 'whole':
      if (r.outcome !== 'accepted') return `a whole file was ${r.outcome} (${r.why ?? ''})`;
      if (r.received !== v.send) return `received ${r.received} of ${v.send}`;
      if (r.stated !== v.send) return `the client read a length of ${r.stated}, not ${v.send}: no progress bar, no room check`;
      return null;
    case 'encoded':
      if (r.outcome !== 'accepted') return `a whole decoded file was ${r.outcome}`;
      if (r.stated !== null) return `stated ${r.stated} for a body fetch decoded — that is the compressed size`;
      return null;
    case 'cut-clean':
    case 'cut-error':
      if (r.outcome === 'accepted') return `${r.received} of ${SOUNDHELIX} bytes were accepted as a whole file`;
      return null;
  }
}

// ---------------------------------------------------------------------------
console.log(`\nNext ${NEXT}: what reaches the client from /api/audio`);
// ---------------------------------------------------------------------------
const plain = await download('naive', 'whole');
const nextStrips = plain.wire !== null && !('content-length' in plain.wire);
console.log(`  info  Next ${NEXT} ${nextStrips ? 'DROPS' : 'passes'} a route's Content-Length`);

for (const name of Object.keys(VECTORS)) {
  const r = await download('shipping', name);
  const problem = judge(name, r);
  if (problem) fail(`${name}: ${problem}`);
  else ok(`${name}: ${r.outcome}, ${r.received} bytes, stated ${r.stated}`);
}

// ---------------------------------------------------------------------------
console.log('\nThe headers the builder moved out of the route still arrive');
// ---------------------------------------------------------------------------
{
  const r = await download('shipping', 'whole');
  const want = {
    'content-type': 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    [PROXY_LENGTH_HEADER.toLowerCase()]: String(SOUNDHELIX),
  };
  for (const [k, val] of Object.entries(want)) {
    if (r.wire?.[k] !== val) fail(`${k} arrived as ${JSON.stringify(r.wire?.[k])}, not ${val}`);
    else ok(`${k}: ${val}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nnaive (the code before this fix) must fail where Next strips the length');
// ---------------------------------------------------------------------------
for (const name of Object.keys(VECTORS)) {
  const v = VECTORS[name];
  const problem = judge(name, await download('naive', name));
  if (v.alsoNaive) {
    if (problem) fail(`${name}: marked alsoNaive, but naive fails it (${problem}) — the exemption is wrong`);
    else ok(`${name}: alsoNaive, and naive agrees`);
  } else if (!nextStrips) {
    console.log(`  info  ${name}: naive ${problem ? `fails (${problem})` : 'passes'} — Next ${NEXT} passes Content-Length, so not gated`);
  } else if (!problem) {
    fail(`${name}: naive passes on a Next that strips Content-Length — this vector proves nothing`);
  } else {
    ok(`${name}: naive fails, as it should (${problem})`);
  }
}

server.closeAllConnections();
server.close();

// ---------------------------------------------------------------------------
console.log('\nThe pure rules, as recorded calls');
// ---------------------------------------------------------------------------
{
  const H = (o) => new Headers(o);
  const calls = [
    [proxyBodyLength, [H({ 'content-length': String(SOUNDHELIX) })], SOUNDHELIX],
    [proxyBodyLength, [H({ 'content-length': '1000', 'content-encoding': 'gzip' })], null],
    [proxyBodyLength, [H({ 'content-length': '1000', 'content-encoding': 'identity' })], null],
    [proxyBodyLength, [H({})], null],
    [proxyBodyLength, [H({ 'content-length': '0' })], null],
    [proxyBodyLength, [H({ 'content-length': '12.5' })], null],
    [proxyBodyLength, [H({ 'content-length': '0x10' })], null],
    [proxyBodyLength, [H({ 'content-length': '-5' })], null],
    [proxyBodyLength, [H({ 'content-length': '99999999999999999999' })], null],
    [statedDownloadBytes, [H({ [PROXY_LENGTH_HEADER]: '7' }), true], 7],
    // A deploy that still sends Content-Length: the same number, read as before.
    [statedDownloadBytes, [H({ 'content-length': '5' }), true], 5],
    [statedDownloadBytes, [H({ [PROXY_LENGTH_HEADER]: '7', 'content-length': '5' }), true], 7],
    // A HOST's response: our header promises nothing there.
    [statedDownloadBytes, [H({ [PROXY_LENGTH_HEADER]: '7', 'content-length': '5' }), false], 5],
    [statedDownloadBytes, [H({ [PROXY_LENGTH_HEADER]: '7' }), false], null],
    [endedShort, [true, 100, 200], true],
    [endedShort, [true, 200, 200], false],
    [endedShort, [true, 100, null], false],
    // Direct from a host: a gzipped mp3 decodes SHORTER than its header and is whole.
    [endedShort, [false, 900, 1000], false],
  ];
  for (const [fn, args, want] of calls) {
    const got = fn(...args);
    const label = `${fn.name}(${args.map((a) => (a instanceof Headers ? JSON.stringify(Object.fromEntries(a)) : JSON.stringify(a))).join(', ')})`;
    if (got !== want) fail(`${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    else ok(`${label} = ${JSON.stringify(want)}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nThe route and the client use the leaf, not a copy');
// ---------------------------------------------------------------------------
{
  const route = readFileSync(new URL('../app/api/audio/route.ts', import.meta.url), 'utf8');
  const cache = readFileSync(new URL('../lib/downloads/downloads-cache.ts', import.meta.url), 'utf8');
  const scans = [
    [route, /audioProxyHeaders\(upstream\.headers\)/, true, 'route.ts builds its headers with audioProxyHeaders(upstream.headers)'],
    [route, /new Headers\(|headers\.set\(/, false, 'route.ts sets no header of its own on the streamed response'],
    [cache, /statedDownloadBytes\(res\.headers, proxied\)/, true, 'downloads-cache.ts reads the length with statedDownloadBytes(res.headers, proxied)'],
    [cache, /endedShort\(proxied, receivedBytes, totalBytes\)/, true, 'downloads-cache.ts counts the bytes with endedShort'],
    [cache, /\.get\(['"]content-length['"]\)/i, false, "downloads-cache.ts reads no 'content-length' itself"],
  ];
  for (const [src, re, present, label] of scans) {
    if (re.test(src) !== present) fail(label);
    else ok(label);
  }
}

if (failures) {
  console.error(`\n${failures} audio wire check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll audio wire checks passed.');
