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
import { fetchLatestEventDetailed } from '@/lib/nostr/event-queries';
import { resolvePublishRelays } from '@/lib/nostr/relays';
import { activeNostr } from '@/lib/nostr/signer';
import type { NostrIdentity } from '@/lib/nostr/auth';
import { NoSignerError, withSignTimeout, type CommunitySigner } from './client';
import {
  BLOSSOM_SERVER_LIST_KIND, artUploadServers, artUploadSize, blossomServersFromTags, uploadedArtUrl,
} from './rules';

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
/** Per server: a slow server must leave time for the next one inside AUTH_LIFETIME_S. */
const UPLOAD_TIMEOUT_MS = 45_000;
const SERVER_LIST_WAIT_MS = 4_000;

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
 * The user's own Blossom servers, from their kind:10063 (BUD-03), in their order.
 * `[]` for no list AND for a read that failed: the only cost of a miss is that
 * the upload goes to the default server, so an untrustworthy read needs no
 * second state here. Read from the relays the user WRITES to, where their own
 * replaceable lists live.
 */
export async function fetchBlossomServers(identity: NostrIdentity): Promise<string[]> {
  try {
    const { event } = await fetchLatestEventDetailed(
      resolvePublishRelays(identity),
      { kinds: [BLOSSOM_SERVER_LIST_KIND], authors: [identity.pubkey], limit: 1 },
      SERVER_LIST_WAIT_MS,
      { pubkey: identity.pubkey, kinds: [BLOSSOM_SERVER_LIST_KIND], dTag: '' },
    );
    return event ? blossomServersFromTags(event.tags) : [];
  } catch {
    return [];
  }
}

export interface ArtUploadResult {
  url: string;
  /** The server that took it. */
  server: string;
  /** The user's own servers that were tried first and did not take it. */
  skipped: string[];
}

/** BUD-01 `HEAD /<sha256>`: does this server already serve the blob? */
async function serves(server: string, hash: string): Promise<boolean> {
  try {
    const r = await fetch(`${server}/${hash}`, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** One PUT. Resolves with the link, rejects with ArtUploadError. */
async function putTo(server: string, blob: Blob, hash: string, authHeader: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${server}/upload`, {
      method: 'PUT',
      headers: { Authorization: authHeader, 'Content-Type': 'image/jpeg', 'X-SHA-256': hash },
      body: blob,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    // A server that sends no CORS headers lands here too: the preflight fails, so
    // the PUT never left and nothing was stored.
    throw new ArtUploadError('network', e instanceof Error ? e.message : undefined);
  }
  if (!res.ok) {
    // BUD-01: a refusal names its reason in `X-Reason`. Logged, never shown: it is
    // third-party text.
    console.warn('[blossom] upload refused', server, res.status, res.headers.get('X-Reason') ?? '');
    // A server that already holds this hash may refuse the copy. The address IS
    // the content, so if the server serves `<sha256>` the picture is there, and
    // that is a success. ASK, never infer it from the refusal: nostr.download
    // answers 409 "An identical image already exists" for a plain black JPEG
    // while `HEAD /<our sha256>` is 404 (measured 2026-11-15) — "identical" is
    // its own match, not our hash, and a link built from the 409 would be dead.
    if (await serves(server, hash)) return `${server}/${hash}.jpg`;
    throw new ArtUploadError('refused', String(res.status));
  }
  let answer: unknown;
  try {
    answer = await readCappedJson(res, 64 * 1024);
  } catch {
    throw new ArtUploadError('bad-answer');
  }
  const url = uploadedArtUrl(server, hash, answer);
  if (!url) throw new ArtUploadError('bad-answer');
  return url;
}

/**
 * Re-encode, sign ONCE, then try each server in `artUploadServers(userServers)`
 * order until one takes it. Rejects with the LAST server's `ArtUploadError`,
 * `NoSignerError` or `SignTimeoutError`.
 *
 * One signature covers every server: the authorization carries no `server` tag
 * (BUD-02 makes it optional), so a fallback costs no second Amber prompt.
 *
 * The hash is @noble's, not `crypto.subtle`'s: SubtleCrypto is secure-context
 * only, and this app is tested on a phone over `http://<LAN-IP>`.
 */
export async function uploadPlaylistArt(
  file: File,
  userServers: readonly string[] = [],
  signer?: CommunitySigner,
): Promise<ArtUploadResult> {
  const nostr = signer ?? activeNostr();
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
  const authHeader = `Nostr ${base64Utf8(JSON.stringify(auth))}`;

  const skipped: string[] = [];
  let last: unknown = new ArtUploadError('network');
  for (const server of artUploadServers(userServers)) {
    try {
      return { url: await putTo(server, blob, hash, authHeader), server, skipped };
    } catch (e) {
      last = e;
      if (userServers.includes(server)) skipped.push(server);
    }
  }
  throw last;
}
