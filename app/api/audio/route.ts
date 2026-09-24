import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { safeFetch } from '@/lib/safe-fetch';
import { getErrorMessage, httpUrl } from '@/lib/util';
import { MAX_DOWNLOAD_BYTES } from '@/lib/downloads/download-rules';

/**
 * The enclosure proxy, and it exists ONLY because some hosts refuse the browser.
 *
 * **`docs/downloads.md` used to say this app has no audio proxy and must not
 * grow one, and that was right on the evidence it had.** The evidence changed:
 * `<audio src>` needs no `Access-Control-Allow-Origin` and `fetch()` does, and
 * an iPhone found on 2026-09-20 that `mmmusic.show` sends none — so Mutton,
 * Mead & Music streamed perfectly and could not be saved. Re-measured that day:
 * op3.dev, libsyn, megaphone, transistor and buzzsprout send the header;
 * `mmmusic.show`, `anchor.fm` and `mp3s.nashownotes.com` do not, and that last
 * one is the same audio the op3.dev prefix serves successfully. Self-hosted
 * shows are the gap, and V4V podcasts are disproportionately self-hosted.
 *
 * **THE SHAPE IS `lnurlFetch`'s, NOT A NEW ONE.** `lib/v4v/lnurl-fetch.ts` tries
 * the provider directly and falls back to `/api/lnurl` only when the browser
 * THROWS — on the money path, with CLAUDE.md's blessing. `downloadBytes` now
 * does the same: the direct `mode: 'cors'` fetch is unchanged and still the
 * path every working host takes, so op3.dev, libsyn and the rest never touch
 * this route. **There is no host allowlist**, which was the third objection in
 * that doc: the browser's own refusal is the trigger, so nothing can drift out
 * of date.
 *
 * WHY NOT THE SERVICE-WORKER ROUTE. The alternative was `mode: 'no-cors'` plus
 * a worker serving the opaque response. It needs no server bandwidth and it is
 * very likely broken on the one platform this is for: iOS Safari plays media
 * with byte-range requests and expects `206 Partial Content`, and an opaque
 * response can never produce one — its body is unreadable by definition, which
 * is also why `URL.createObjectURL(await res.blob())` cannot consume it. This
 * route keeps the bytes READABLE, so the blob-URL playback path, the progress
 * bar, the room check and `MAX_DOWNLOAD_BYTES` all keep working unchanged.
 *
 * WHAT IT COSTS, stated plainly: audio bytes through our host for these shows
 * only, ONCE per download — playback afterwards is from the blob and never
 * touches the network. Bounded three ways: the direct path takes every host
 * that allows it, `MAX_DOWNLOAD_BYTES` caps one file, and `rateLimit` caps a
 * client. `safeFetch` answers the SSRF objection the same way it already does
 * for `/api/transcript`, `/api/chapters` and `/api/art`, which proxy
 * feed-supplied URLs today.
 */

// A download is a long single response. The default would cut a large episode
// off mid-stream on a slow connection, which reads as a corrupt file rather
// than a timeout. MAX_DOWNLOAD_BYTES at 300 KB/s needs well over 120 s.
export const maxDuration = 300;
// Audio is never rendered, so nothing here may be cached by a shared cache: the
// URL carries a third party's address and the body is someone's episode.
export const dynamic = 'force-dynamic';

/**
 * Deliberately low. A download is a rare, deliberate act — six in a minute is
 * already someone hammering the button — and every request through here is
 * potentially MAX_DOWNLOAD_BYTES of our bandwidth, the one cost this route adds.
 */
const AUDIO_LIMIT_PER_MIN = 6;

export async function GET(req: Request) {
  const limited = rateLimit(req, 'audio', AUDIO_LIMIT_PER_MIN);
  if (limited) return limited;

  const raw = new URL(req.url).searchParams.get('url');
  // `httpUrl` at the PARSE boundary, the same guard a feed-supplied href gets:
  // it rejects every scheme but http/https before the string reaches safeFetch.
  const url = httpUrl(raw ?? undefined);
  if (!url) return NextResponse.json({ error: 'bad url' }, { status: 400 });

  try {
    // `safeFetch` re-validates every redirect hop and resolves each hostname —
    // an IP-literal test alone is beaten by a public DNS record. An enclosure
    // URL comes from a feed, so it is exactly the hostile input it exists for.
    // No `redirect` option: safeFetch sets `manual` itself and walks each hop,
    // re-validating the URL and re-resolving the hostname every time. Passing
    // `follow` here would be overridden and would read as if it were not.
    const upstream = await safeFetch(url, {
      // Never forward credentials or the caller's headers: this request is ours,
      // not theirs, and an enclosure needs neither.
      headers: { Accept: '*/*' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok) {
      // Release the socket: an unread body holds the connection open.
      await upstream.body?.cancel().catch(() => {});
      // The host's own answer, not a 500: a 404 enclosure is a fact about the
      // feed and the client renders it. 502 keeps our own failures distinct.
      return NextResponse.json(
        { error: `host answered ${upstream.status}` },
        { status: upstream.status === 404 ? 404 : 502 },
      );
    }

    const ct = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (ct && !ct.startsWith('audio/') && !ct.startsWith('video/') && ct !== 'application/octet-stream') {
      await upstream.body?.cancel().catch(() => {});
      return NextResponse.json({ error: 'not an audio file' }, { status: 415 });
    }

    // REFUSE BEFORE STREAMING when the host declares a size over the cap. The
    // client enforces the same ceiling on what actually arrives, because
    // `Content-Length` is a claim and an endless source sends none at all —
    // this is the cheap half, not the guard.
    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      await upstream.body?.cancel().catch(() => {});
      return NextResponse.json({ error: 'episode too large' }, { status: 413 });
    }
    if (!upstream.body) {
      return NextResponse.json({ error: 'audio fetch failed' }, { status: 502 });
    }

    const headers = new Headers();
    // `audio/*` verbatim would let a hostile host pick our Content-Type. The
    // client only ever turns this into a Blob, so an opaque octet-stream is
    // enough and nosniff stops the browser inferring anything else.
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('X-Content-Type-Options', 'nosniff');
    // Only when the body arrives as the host sent it: fetch DECODES a
    // `Content-Encoding`, so the declared length is the compressed size and the
    // client would stop short and keep a truncated file as complete.
    const encoded = !!upstream.headers.get('content-encoding');
    if (!encoded && Number.isFinite(declared) && declared > 0) {
      // Carried so the progress bar has a denominator — the one upstream header
      // worth reflecting.
      headers.set('Content-Length', String(declared));
    }
    headers.set('Cache-Control', 'no-store');

    return new NextResponse(upstream.body.pipeThrough(capBytes(MAX_DOWNLOAD_BYTES)), {
      status: 200,
      headers,
    });
  } catch (e) {
    // THE MESSAGE IS LOGGED, NEVER RETURNED — the same split `withErrorHandling`
    // makes, and for the reason CLAUDE.md states: `assertSafeFetchUrl` names the
    // host it rejected, so reflecting it here would turn the SSRF guard into an
    // oracle that answers "is this address internal?" for any URL a caller
    // wants tested. The client only needs to know the read failed.
    console.error('[api] audio fetch failed:', getErrorMessage(e, 'unknown error'));
    return NextResponse.json({ error: 'audio fetch failed' }, { status: 502 });
  }
}

/**
 * THE CAP ON WHAT ACTUALLY ARRIVES. `Content-Length` is a claim, and a source
 * that sends none would otherwise stream for the whole of `maxDuration` — the
 * client stops at `MAX_DOWNLOAD_BYTES`, but a caller that is not our client
 * need not. Past the cap the stream ERRORS rather than ending, so no reader can
 * mistake a cut-off body for a whole file.
 */
function capBytes(max: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) {
        controller.error(new Error('episode too large'));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
