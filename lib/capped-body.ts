// The capped body readers: read a response (or a request) body while COUNTING
// bytes, and refuse or stop past a ceiling.
//
// **Import-free on purpose, and `scripts/check-capped-body.mjs` asserts it.**
// These lived in lib/safe-fetch.ts beside the SSRF guard, which imports
// `node:dns/promises` — so browser code could not reach them, and the one
// browser read of a third-party body (lib/v4v/lnurl-fetch.ts, the direct LNURL
// fetch, in the origin that holds the NWC spending credential) went uncapped
// while every server read was metered. One capping loop for both sides now.
//
// `AbortSignal.timeout(...)` caps how LONG a fetch may run, not how much it may
// return. Eight seconds of a fast upstream is hundreds of megabytes, and every
// URL these read is feed- or user-supplied, so `await res.text()` handed an
// attacker a way to fill a heap from one request. Worse where the result is
// then cached: lib/pi.ts retains feed XML keyed by that same URL.
//
// Two shapes on one loop: `readCappedBytes` THROWS past the cap (a half-read
// feed is not a feed) and `readBytesUpTo` STOPS at it and says so (a prefix is
// exactly what /api/og/boost.png wants from a 19 MB animated cover).

/** 8 MB. Larger than any real RSS feed, chapters file or transcript. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The half of `Response` the capping loop below actually touches.
 *
 * A `Request` carries the same three members, so widening the parameter from
 * `Response` to this lets the INBOUND direction reuse one capping loop rather
 * than growing a second copy of it — see `readCappedRequestText` in
 * lib/api-handler.ts. Nothing else changes: every existing caller passes a
 * `Response`, which still satisfies this structurally.
 */
type CappableBody = Pick<Response, 'headers' | 'body' | 'arrayBuffer'>;

/**
 * Read a response body as text, refusing anything past `maxBytes`.
 *
 * `AbortSignal.timeout(...)` — which every caller here passes — caps how LONG a
 * fetch may run, not how much it may return. Eight seconds of a fast upstream is
 * hundreds of megabytes, and the URL is feed-supplied, so `await res.text()`
 * handed an attacker a way to fill a serverless instance's heap from one
 * request. Worse where the result is then cached: `lib/pi.ts` retains feed XML
 * keyed by that same URL.
 *
 * Streams and aborts mid-body rather than buffering first and measuring after,
 * which would defeat the point. `Content-Length` is only a fast path — it is
 * absent on chunked responses and trivially lied about, so the byte count while
 * reading is what actually enforces the limit.
 */
export async function readCappedText(
  res: CappableBody,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(res, maxBytes));
}

/**
 * Read at most `maxBytes` and **stop**, rather than refusing the response.
 *
 * The distinction from {@link readCappedBytes} is the whole point: that one
 * throws past the cap, which is right when a partial body is worthless (a
 * half-read feed is not a feed). Here a prefix is exactly what the caller
 * wants — `/api/og/boost.png` needs the first frame of an animated GIF, which
 * sits at the front of the file, and a real one measured 606 KB inside a 19 MB
 * episode artwork. Reading the prefix and cancelling costs 0.6 MB instead of 19.
 *
 * `truncated` says whether more was available, so a caller can tell the two
 * answers apart: "the whole file, which happens to be small" versus "as much as
 * you allowed". Those need different handling and the byte count alone cannot
 * separate them. (Worded without a quoted `from`: `scripts/import-free.mjs`
 * scans this file for import specifiers with a regex.)
 *
 * Cancelling the reader is what actually aborts the transfer; without it the
 * rest of the body keeps arriving on a socket nobody reads.
 */
export async function readBytesUpTo(
  res: CappableBody,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.byteLength > maxBytes
      ? { bytes: all.subarray(0, maxBytes), truncated: true }
      : { bytes: all, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      if (value.byteLength >= room) {
        chunks.push(value.subarray(0, room));
        total += room;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return { bytes: joined, truncated };
}

/**
 * {@link readCappedText}'s byte half — the same streaming cap, without the
 * decode. Artwork is binary, and `TextDecoder` over a PNG returns replacement
 * characters, so a caller that needs the bytes cannot go through the text
 * reader and must not fall back to a bare `res.arrayBuffer()`: that buffers the
 * whole body first and measures after, which is the behaviour this module
 * exists to prevent. One capping loop, two shapes on top of it.
 */
export async function readCappedBytes(
  res: CappableBody,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response too large (${declared} bytes, max ${maxBytes})`);
  }
  if (!res.body) {
    // No stream to meter, so the whole body is already buffered by the time
    // it can be measured — the one path in this module that cannot stop early.
    // It is still CAPPED: over the limit throws, exactly as the stream branch
    // does, rather than handing the caller a body it was promised never to see.
    // Pinned by `check:cappedbody`.
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.byteLength > maxBytes) {
      throw new Error(`response too large (${all.byteLength} bytes, max ${maxBytes})`);
    }
    return all;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`response too large (exceeded ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    // Releases the socket on the throw path too — an abandoned reader keeps the
    // connection half-open against the pool.
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return joined;
}

/** {@link readCappedText}, then `JSON.parse`. */
export async function readCappedJson(
  res: CappableBody,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<unknown> {
  return JSON.parse(await readCappedText(res, maxBytes));
}
