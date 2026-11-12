// e2e for the community-playlist API, over HTTP only (imports nothing from the app).
// Needs a dev server started with COMMUNITY_DB_URL, ADMIN_NPUBS=<the admin npub below>,
// NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on and NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN=$APP_URL.
// See docs/testing.md. Prints `ok`/`FAIL` lines; exits non-zero on any FAIL.
const APP = process.env.APP_URL || 'http://localhost:3123';

let fails = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) { fails++; if (detail) console.log(`         ${detail}`); }
};

const res = await fetch(`${APP}/api/community-playlists`).catch((e) => ({ status: 0, json: async () => ({ error: String(e) }) }));
const body = await res.json().catch(() => null);
check('GET /api/community-playlists answers 200 { playlists: [] }',
  res.status === 200 && JSON.stringify(body) === JSON.stringify({ playlists: [] }),
  `status ${res.status} body ${JSON.stringify(body)}`);

process.exit(fails ? 1 : 0);
