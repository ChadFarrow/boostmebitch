/**
 * Cut an animated GIF down to its first frame, by walking the block structure
 * and appending a trailer — no pixel decoding of any kind.
 *
 * **Why this exists.** Podcast artwork is arbitrary third-party media and it is
 * routinely enormous: Homegrown Hits ships a 19 MB animated GIF as episode art,
 * against a 2 MB ceiling in the banner route that exists so one feed cannot
 * starve the renderer. Raising the ceiling is not the answer — a 19 MB decode
 * inside a request that has to answer is the problem, not the byte count. The
 * first frame is a few hundred KB and sits at the front of the file, so the
 * route reads a bounded prefix, this cuts it, and the show's real art gets
 * drawn instead of a different (older) image from a fallback URL.
 *
 * **It never decodes pixels.** Every offset here comes from a length byte the
 * format itself supplies: sub-block chains are `<len><len bytes>…<0>`, colour
 * tables are `3 * 2^(N+1)` bytes where N is three bits of a packed byte. The
 * output is a byte-range copy of the input plus a one-byte trailer. So the
 * attack surface is the arithmetic below, not an LZW decoder — and every read
 * is bounds-checked, because the input is attacker-chosen and a truncated file
 * is the ORDINARY case here (the caller stops the download early on purpose).
 *
 * **Import-free on purpose**, so `scripts/check-gif.mjs` can load this exact
 * module under plain Node rather than testing a copy. See CLAUDE.md.
 *
 * Spec: GIF89a, https://www.w3.org/Graphics/GIF/spec-gif89a.txt
 */

const TRAILER = 0x3b;
const EXTENSION = 0x21;
const IMAGE_DESCRIPTOR = 0x2c;

/** `'more'` = the prefix is valid so far but ends mid-frame — read further. */
export type GifScan = { end: number } | 'more' | null;

/** Bytes in a colour table described by a packed field's low three bits. */
function colorTableSize(packed: number): number {
  return 3 * 2 ** ((packed & 0b111) + 1);
}

/**
 * Walk a sub-block chain (`<len><len bytes>` … terminated by a zero length).
 * Returns the offset just past the terminator, or `'more'` when the prefix ends
 * inside the chain, which is what a deliberately truncated download looks like.
 */
function skipSubBlocks(bytes: Uint8Array, at: number): { end: number } | 'more' {
  let i = at;
  for (;;) {
    if (i >= bytes.length) return 'more';
    const len = bytes[i]!;
    if (len === 0) return { end: i + 1 };
    i += 1 + len;
  }
}

/**
 * Where the first frame ends, given a (possibly truncated) GIF prefix.
 *
 * Returns `{ end }` — an exclusive offset just past the first image's sub-block
 * chain — or `'more'` if the prefix is too short to tell, or `null` if this is
 * not a GIF or the structure is malformed. `null` and `'more'` are deliberately
 * distinct: the caller must not keep reading a file that will never parse, and
 * must not discard one that merely needs more bytes.
 */
export function firstFrameEnd(bytes: Uint8Array): GifScan {
  if (bytes.length < 6) return 'more';
  // "GIF87a" / "GIF89a" — 87a has no extension blocks, but the frame walk is
  // identical, so both are accepted.
  const sig = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!);
  if (sig !== 'GIF') return null;
  const ver = String.fromCharCode(bytes[3]!, bytes[4]!, bytes[5]!);
  if (ver !== '87a' && ver !== '89a') return null;

  // Logical Screen Descriptor: 7 bytes, then the global colour table if the
  // packed field's high bit says there is one.
  if (bytes.length < 13) return 'more';
  const packed = bytes[10]!;
  let i = 13;
  if (packed & 0b1000_0000) i += colorTableSize(packed);

  for (;;) {
    if (i >= bytes.length) return 'more';
    const marker = bytes[i]!;

    if (marker === TRAILER) {
      // A GIF with no image block at all. Nothing to cut down to.
      return null;
    }

    if (marker === EXTENSION) {
      // <0x21><label><sub-blocks>. Kept in the output rather than skipped: a
      // Graphic Control Extension carries the frame's transparency index, and
      // dropping it turns transparent pixels into whatever the palette holds
      // at that slot.
      if (i + 2 > bytes.length) return 'more';
      const next = skipSubBlocks(bytes, i + 2);
      if (next === 'more') return 'more';
      i = next.end;
      continue;
    }

    if (marker === IMAGE_DESCRIPTOR) {
      // <0x2C><left,top,w,h: 2 bytes each><packed>, then an optional local
      // colour table, then <LZW minimum code size><sub-blocks>.
      const packedAt = i + 9;
      if (packedAt >= bytes.length) return 'more';
      const imgPacked = bytes[packedAt]!;
      let j = packedAt + 1;
      if (imgPacked & 0b1000_0000) j += colorTableSize(imgPacked);
      j += 1; // LZW minimum code size
      if (j > bytes.length) return 'more';
      const data = skipSubBlocks(bytes, j);
      if (data === 'more') return 'more';
      return { end: data.end };
    }

    // Not a block marker the format defines — the file is malformed, or this
    // isn't really a GIF. Either way there is no frame to find.
    return null;
  }
}

/**
 * The first frame as a standalone GIF, or `null` when the prefix holds no
 * complete frame.
 *
 * The result is the input's own bytes up to the end of frame one, plus the
 * trailer the format requires — so a decoder that could read the original can
 * read this, and nothing was re-encoded. A file that is already a single frame
 * comes back byte-identical apart from that trailer.
 */
export function firstGifFrame(bytes: Uint8Array): Uint8Array | null {
  const scan = firstFrameEnd(bytes);
  if (scan === 'more' || scan === null) return null;
  const out = new Uint8Array(scan.end + 1);
  out.set(bytes.subarray(0, scan.end));
  out[scan.end] = TRAILER;
  return out;
}
