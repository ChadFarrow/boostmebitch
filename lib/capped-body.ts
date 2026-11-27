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
// `readPrefixThenScan` keeps a prefix and reads past it WITHOUT keeping it, to
// prove a named tag is absent from the rest (a live read of a feed past 8 MB).

/**
 * 8 MB. Larger than almost every real RSS feed, chapters file or transcript —
 * NOT every one: a Podhome feed with 2,400 episodes measured 11.9 MB on
 * 2026-11-25. A live read goes past it with `readPrefixThenScan`.
 */
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
 * Refuse a response WITHOUT reading it, and let the socket go.
 *
 * Every refusal that happens before the read loop — a declared length over the
 * cap, a needle the scanner cannot take — used to throw with the body untouched.
 * An unread body is not a finished one: undici keeps the connection half-open
 * and the bytes arriving until something consumes or cancels the stream, so a
 * burst of oversized answers under load held one socket each (full-code review
 * 2026-11-19, `check:cappedbody`). `cancel()` rejects on a locked stream, which
 * is nothing to act on here.
 */
async function refuse(res: CappableBody, message: string): Promise<never> {
  await res.body?.cancel().catch(() => {});
  throw new Error(message);
}

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
    return refuse(res, `response too large (${declared} bytes, max ${maxBytes})`);
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

/**
 * Keep the first `keepBytes` of a body, read the REST without keeping it, and
 * say whether `needle` appears anywhere past what was kept.
 *
 * The fourth shape, for a document that can outgrow every cap we will hold in
 * memory while the caller needs only a part of it that it can NAME. A live read
 * (`lib/pi.ts`) wants only the `<podcast:liveItem>` blocks of a feed. Measured
 * 2026-11-25: one Podhome feed with 2,400 episodes was 11.9 MB, past
 * `MAX_BODY_BYTES`, so every live read of it threw and `/live` showed Podcast
 * Index's two stale rows for that show as LIVE, UNCHECKED — one of them a
 * broadcast scheduled for the next day.
 *
 * A prefix alone proves PRESENCE, never ABSENCE: a live item past the cut is
 * missed, and a live read that answers `ok` deletes every item it omits
 * (`mergeLiveOverPi`). So the rest is scanned, and `needleAfterKept: false` is
 * the proof that nothing past the cut mentions the needle. The scan is ASCII
 * case-insensitive and carries `needle.length - 1` bytes across every seam —
 * the kept prefix's own included — so a tag split across two chunks, or across
 * the cut, is still found. A match stops the read at once: the answer is known.
 * A match inside CDATA is a false alarm, and a false alarm only costs the read
 * (the caller reports it as unreadable, which is what it was before this).
 *
 * Still CAPPED: past `maxBytes` in all it THROWS, like `readCappedBytes`, because
 * an unbounded drain is an unbounded download even when nothing is kept. Memory
 * is `keepBytes` plus one chunk. `truncated` says whether the body went past
 * `keepBytes` at all; when it did not, `bytes` is the whole body and the scan
 * never ran.
 */
export async function readPrefixThenScan(
  res: CappableBody,
  keepBytes: number,
  maxBytes: number,
  needle: string,
): Promise<{ bytes: Uint8Array; truncated: boolean; needleAfterKept: boolean }> {
  let pat: Uint8Array;
  try {
    pat = asciiLowerBytes(needle);
  } catch (e) {
    return refuse(res, e instanceof Error ? e.message : String(e));
  }
  if (!pat.length) return refuse(res, 'readPrefixThenScan: empty needle');
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return refuse(res, `response too large (${declared} bytes, max ${maxBytes})`);
  }

  const kept: Uint8Array[] = [];
  let keptLen = 0;
  let total = 0;
  let truncated = false;
  let found = false;
  // The last `pat.length - 1` bytes seen, so a match across a seam is whole.
  // `null` until the first byte past the cut, when it is seeded from the kept
  // prefix's tail.
  let carry: Uint8Array | null = null;

  /** Feed one chunk in. Returns true once the answer is known (a match). */
  const take = (value: Uint8Array): boolean => {
    total += value.byteLength;
    if (total > maxBytes) throw new Error(`response too large (exceeded ${maxBytes} bytes)`);
    const room = keepBytes - keptLen;
    let rest = value;
    if (room > 0) {
      const head = value.byteLength > room ? value.subarray(0, room) : value;
      kept.push(head);
      keptLen += head.byteLength;
      rest = value.subarray(head.byteLength);
    }
    if (!rest.byteLength) return false;
    truncated = true;
    if (carry === null) carry = tailOf(kept, pat.length - 1);
    const window = joinBytes([carry, rest]);
    if (indexOfAsciiCi(window, pat) !== -1) {
      found = true;
      return true;
    }
    carry = window.slice(Math.max(0, window.byteLength - (pat.length - 1)));
    return false;
  };

  if (!res.body) {
    // Same as `readCappedBytes`' bodyless branch: already buffered, so it can
    // only be measured after — but it is still measured and still refused.
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.byteLength > maxBytes) {
      throw new Error(`response too large (${all.byteLength} bytes, max ${maxBytes})`);
    }
    take(all);
  } else {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (take(value)) break;
      }
    } finally {
      // Stops the transfer on a match and on the throw alike.
      await reader.cancel().catch(() => {});
    }
  }
  return { bytes: joinBytes(kept), truncated, needleAfterKept: found };
}

function asciiLowerBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) throw new Error('readPrefixThenScan: the needle must be ASCII');
    out[i] = c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
  }
  return out;
}

/** First index of `pat` (already lower-case) in `hay`, ASCII case-insensitive. */
function indexOfAsciiCi(hay: Uint8Array, pat: Uint8Array): number {
  const last = hay.byteLength - pat.byteLength;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < pat.byteLength; j++) {
      const b = hay[i + j];
      if ((b >= 0x41 && b <= 0x5a ? b + 0x20 : b) !== pat[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function tailOf(chunks: Uint8Array[], n: number): Uint8Array {
  if (n <= 0) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let need = n;
  for (let i = chunks.length - 1; i >= 0 && need > 0; i--) {
    const c = chunks[i];
    const piece = c.byteLength > need ? c.subarray(c.byteLength - need) : c;
    parts.unshift(piece);
    need -= piece.byteLength;
  }
  return joinBytes(parts);
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** {@link readCappedText}, then `JSON.parse`. */
export async function readCappedJson(
  res: CappableBody,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<unknown> {
  return JSON.parse(await readCappedText(res, maxBytes));
}
