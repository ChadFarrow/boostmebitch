// `BRAND.userAgent`, or `APP_NAME` when that is set: the `User-Agent` of the
// server requests that read `APP_NAME` before 2026-11-27 — Podcast Index, the
// RSS reads, chapters and transcripts, the musicL resolver, OPML, LNURL and
// keysend.
//
// SERVER-ONLY by convention: it reads `APP_NAME`. A browser fetch cannot set
// this header, so nothing in the browser calls it.
//
// `APP_NAME` is meant to stay unset (`.env.example`). Set, it replaces the
// brand's string on every route that calls this, so a buddy deploy whose
// environment was copied from the bmb project introduces itself as the other
// brand. A blank value counts as unset.
//
// EVERY OTHER server request reads `BRAND.userAgent` directly and takes no
// override: art, audio, audio-probe, the OG banner, the playlist art check,
// GIPHY, BoostBox, stamp-address, the podping viewer, the read index, the
// GitHub calls and the podping pusher; `lib/community/pi-notify.ts` sends
// `BRANDS.buddy.userAgent`, the FEED's brand. They sent Node's default `node`
// or the brand string before, never `APP_NAME`, and Buzzsprout's audio host
// refuses `node` (docs/feeds.md), so an override must not reach them.

import { BRAND } from './brand';

export function serverUserAgent(): string {
  return process.env.APP_NAME?.trim() || BRAND.userAgent;
}
