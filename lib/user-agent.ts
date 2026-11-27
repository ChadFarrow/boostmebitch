// The `User-Agent` of every request the server sends.
//
// SERVER-ONLY by convention: it reads `APP_NAME`. A browser fetch cannot set
// this header, so nothing in the browser calls it.
//
// The value is `BRAND.userAgent` (`lib/brand.ts`, pinned by `check:brand`):
// `BoostMeBitch/<version> (+https://www.boostmebitch.com)` on one deploy,
// `BoostMeBuddy/<version> (+https://www.boostmebuddy.com)` on the other.
//
// `APP_NAME` OVERRIDES it, and is meant to stay unset (`.env.example`). Set, it
// replaces the brand's string on every route that calls this, so a buddy deploy
// whose environment was copied from the bmb project introduces itself as the
// other brand. A blank value counts as unset.
//
// A few call sites name `BRAND.userAgent` or `BRANDS.buddy.userAgent` directly,
// on purpose, and take no override: the GitHub calls, the podping pusher, and
// `lib/community/pi-notify.ts` (the FEED's brand, whatever the deploy).

import { BRAND } from './brand';

export function serverUserAgent(): string {
  return process.env.APP_NAME?.trim() || BRAND.userAgent;
}
