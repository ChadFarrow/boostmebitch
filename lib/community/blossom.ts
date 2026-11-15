// Browser-only: the playlist maker's UPLOAD button. Puts a picked picture on a
// Blossom server (BUD-01/02) and returns the cover link the art field takes.
//
// The site hosts NOTHING here. The user's own key signs the kind:24242 upload
// authorization, the server stores the file, and the playlist stores only the
// link, which then goes through the same server-side art check as a typed link.
//
// THE PICTURE IS RE-ENCODED IN THE BROWSER, ALWAYS, before a byte leaves:
//   - A phone photo carries EXIF, often with the GPS position of the place it
//     was taken. Primal stores the bytes as given (measured 2026-11-15: the GET
//     returned the uploaded file byte for byte), so only a re-encode strips it.
//   - A 24 MP photo is over the art check's pixel limit (`artUploadSize`).
//   - The file input's type is the browser's guess; drawing it through a canvas
//     is what proves it is a picture, and the result is always a JPEG.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readCappedJson } from '@/lib/capped-body';
import { activeNostr } from '@/lib/nostr/signer';
import { NoSignerError, withSignTimeout } from './client';
import { ART_UPLOAD_SERVER, artUploadSize, uploadedArtUrl } from './rules';

/** Why an upload failed, in a form the maker turns into one short line. */
export type ArtUploadFailure = 'not-image' | 'too-small' | 'refused' | 'network' | 'bad-answer';

export class ArtUploadError extends Error {
  constructor(public readonly reason: ArtUploadFailure, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ArtUploadError';
  }
}

const JPEG_QUALITY = 0.9;
/** How long the signed authorization is valid. BUD-02 requires an expiration. */
const AUTH_LIFETIME_S = 300;
const UPLOAD_TIMEOUT_MS = 60_000;

async function decode(file: File): Promise<ImageBitmap> {
  try {
    // `from-image` applies the EXIF rotation, so a portrait phone photo stays upright
    // after the re-encode drops the EXIF that said so.
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ArtUploadError('not-image');
  }
}

/** The picked file as a clean JPEG at the upload size. */
export async function reencodeArt(file: File): Promise<Blob> {
  const bmp = await decode(file);
  try {
    const size = artUploadSize(bmp.width, bmp.height);
    if (!size) throw new ArtUploadError('too-small');
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ArtUploadError('not-image', 'no 2d context');
    // JPEG has no alpha: a transparent PNG would otherwise turn black at the edges.
    ctx.fillStyle = '#0A0A08';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new ArtUploadError('not-image', 'toBlob');
    return blob;
  } finally {
    bmp.close();
  }
}

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Re-encode, sign, upload. Resolves with the cover link; rejects with
 * `ArtUploadError`, `NoSignerError` or `SignTimeoutError`.
 *
 * The hash is @noble's, not `crypto.subtle`'s: SubtleCrypto is secure-context
 * only, and this app is tested on a phone over `http://<LAN-IP>`.
 */
export async function uploadPlaylistArt(file: File): Promise<string> {
  const nostr = activeNostr();
  if (!nostr) throw new NoSignerError();

  const blob = await reencodeArt(file);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = bytesToHex(sha256(bytes));

  const now = Math.floor(Date.now() / 1000);
  const auth = await withSignTimeout(
    nostr.signEvent({
      kind: 24242,
      created_at: now,
      content: 'Upload playlist art',
      tags: [['t', 'upload'], ['x', hash], ['expiration', String(now + AUTH_LIFETIME_S)]],
    }),
  );

  let res: Response;
  try {
    res = await fetch(`${ART_UPLOAD_SERVER}/upload`, {
      method: 'PUT',
      headers: {
        Authorization: `Nostr ${base64Utf8(JSON.stringify(auth))}`,
        'Content-Type': 'image/jpeg',
        'X-SHA-256': hash,
      },
      body: blob,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ArtUploadError('network', e instanceof Error ? e.message : undefined);
  }
  if (!res.ok) {
    // BUD-01: a refusal names its reason in `X-Reason`. Logged, never shown: it is
    // third-party text.
    console.warn('[blossom] upload refused', res.status, res.headers.get('X-Reason') ?? '');
    throw new ArtUploadError('refused', String(res.status));
  }
  let answer: unknown;
  try {
    answer = await readCappedJson(res, 64 * 1024);
  } catch {
    throw new ArtUploadError('bad-answer');
  }
  const url = uploadedArtUrl(ART_UPLOAD_SERVER, hash, answer);
  if (!url) throw new ArtUploadError('bad-answer');
  return url;
}
