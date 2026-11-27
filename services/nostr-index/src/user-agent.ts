// The `User-Agent` this service sends to Podcast Index.
//
// The same form as the app's (`BRAND.userAgent` in the app's `lib/brand.ts`):
// `<name>/<version> (+<link>)`, a public link that answers 200, no email. The
// version is THIS package's own `package.json`, read at start, so a bump there
// changes the header with no second edit. `verify:ua` pins the form.
//
// A leaf with no imports from this service, so `pi.ts` (which must not import
// `config.ts`: that module throws without DATABASE_URL) can read it too.
//
// `APP_NAME` OVERRIDES it, and is meant to stay unset; a blank value counts as
// unset.

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };

/** This package's version, as `package.json` states it. */
export const INDEX_VERSION = typeof pkg.version === 'string' ? pkg.version : '0.0.0';

/** The default, before any `APP_NAME` override. */
export const INDEX_USER_AGENT = `BoostMeBitch-Index/${INDEX_VERSION} (+https://www.boostmebitch.com)`;

export function indexUserAgent(): string {
  return process.env.APP_NAME?.trim() || INDEX_USER_AGENT;
}
