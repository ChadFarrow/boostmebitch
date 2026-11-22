// The app server and the database an e2e script that WRITES community playlists
// may use: this machine only.
//
// Usage:
//   import { localAppUrl, localDbUrl } from './local-target.mjs';
//   const APP = localAppUrl('http://localhost:3123'); // APP_URL, else the fallback
//   const DB_URL = localDbUrl();                       // COMMUNITY_DB_URL, or undefined
//
// WHY IT EXISTS. Since 2026-11-22 beta runs with COMMUNITY_PI_NOTIFY=on and the
// two PODPING_* values, so every playlist beta publishes, saves or deletes goes to
// Podcast Index (add/byfeedurl + hub/pubnotify) and to Hive (a podping). Both are
// public and permanent: Podcast Index has no delete. The SERVER decides that
// (`piNotifyBase`, `podpingEndpoint` in lib/community/rules.ts), and a laptop's dev
// server never sends, so a playlist a test makes LOCALLY stays on the machine. But
// these scripts took `APP_URL` as written: `APP_URL=https://beta.boostmebitch.com`
// made a real playlist on beta, in the store production's feeds read, and beta
// submitted it. Two scripts also write the store directly (`COMMUNITY_DB_URL`),
// which skips every rule of the API and puts a row behind a public feed URL.
//
// So the script checks its own target: anything that is not a loopback address
// ends the process at once, exit 2, before the first request. A refusal is a
// broken test, never a skipped one. No DNS name passes, not even one that resolves
// to 127.0.0.1 (`127.0.0.1.nip.io`): the check reads the name, and a name can point
// anywhere. A database URL's `host`/`hostaddr` parameter is refused too, because
// pg connects to it in place of the host the URL names.
//
// The refusal names the host only, never the URL: a database URL carries a password.
// Pinned by `check:community` ("local target").

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `raw` when it names this machine, else null. `kind` is `'app'` (http or https;
 * the trailing slash is dropped, as the scripts always did) or `'db'` (a postgres
 * URL with no `host`/`hostaddr` parameter; returned as written).
 */
export function localTarget(raw, kind) {
  if (typeof raw !== 'string' || raw === '') return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!LOOPBACK.has(u.hostname)) return null;
  if (kind === 'app') {
    return u.protocol === 'http:' || u.protocol === 'https:' ? raw.replace(/\/+$/, '') : null;
  }
  if (kind === 'db') {
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return null;
    if (u.searchParams.has('host') || u.searchParams.has('hostaddr')) return null;
    return raw;
  }
  return null;
}

const hostOf = (raw, kind) => {
  try {
    const u = new URL(raw);
    const param = kind === 'db' ? u.searchParams.get('host') ?? u.searchParams.get('hostaddr') : null;
    return param ? `${param} (its host parameter)` : u.host || '(no host)';
  } catch {
    return '(not a URL)';
  }
};

function refuse(name, raw, kind) {
  const what = kind === 'db' ? 'database' : 'server';
  console.error(`Refusing ${name}: ${hostOf(raw, kind)} is not this machine.`);
  console.error(`This script writes community playlists, so it only talks to a ${what} on localhost,`);
  console.error('127.0.0.1 or [::1]. Beta sends every playlist it stores to Podcast Index and Hive,');
  console.error('for good (scripts/local-target.mjs).');
  process.exit(2);
}

/** `APP_URL`, else `fallback`, with no trailing slash; ends the process when it is not this machine. */
export function localAppUrl(fallback) {
  const raw = process.env.APP_URL || fallback;
  const url = localTarget(raw, 'app');
  if (url === null) refuse('APP_URL', raw, 'app');
  return url;
}

/** `COMMUNITY_DB_URL`, or undefined when unset; ends the process when it is not this machine. */
export function localDbUrl() {
  const raw = process.env.COMMUNITY_DB_URL;
  if (!raw) return undefined;
  const url = localTarget(raw, 'db');
  if (url === null) refuse('COMMUNITY_DB_URL', raw, 'db');
  return url;
}
