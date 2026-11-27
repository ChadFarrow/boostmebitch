// verify:ua — the User-Agent this service sends to Podcast Index.
//
// Pins the form every one of Chad's apps uses: `<name>/<version> (+<link>)`,
// the version equal to THIS package's `package.json`, a public https link, no
// email, no browser imitation. And `APP_NAME`: a blank value is unset, a set
// value wins (it exists as an override, meant to stay unset).
//
// Needs no database: `src/user-agent.ts` imports nothing from this service.

import { readFileSync } from 'node:fs';
import { INDEX_USER_AGENT, INDEX_VERSION, indexUserAgent } from '../src/user-agent.ts';

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : `\n      ${detail ?? ''}`}`);
  if (!cond) failed += 1;
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

console.log('\n  the index User-Agent');
const m = /^([A-Za-z][A-Za-z0-9-]*)\/(\d+\.\d+\.\d+) \(\+(https:\/\/[^\s)]+)\)$/.exec(INDEX_USER_AGENT);
ok('it has the form <name>/<version> (+<link>)', !!m, INDEX_USER_AGENT);
ok('its name is BoostMeBitch-Index', m?.[1] === 'BoostMeBitch-Index', m?.[1]);
ok('its version is package.json\'s', m?.[2] === pkg.version && INDEX_VERSION === pkg.version, `${m?.[2]} vs ${pkg.version}`);
ok('its link is the live site', m?.[3] === 'https://www.boostmebitch.com', m?.[3]);
ok('it carries no email and no browser name', !/@|mozilla|applewebkit|chrome\//i.test(INDEX_USER_AGENT), INDEX_USER_AGENT);

const saved = process.env.APP_NAME;
delete process.env.APP_NAME;
ok('unset APP_NAME sends the default', indexUserAgent() === INDEX_USER_AGENT);
process.env.APP_NAME = '   ';
ok('a blank APP_NAME counts as unset', indexUserAgent() === INDEX_USER_AGENT);
process.env.APP_NAME = 'override/1';
ok('a set APP_NAME wins', indexUserAgent() === 'override/1');
if (saved === undefined) delete process.env.APP_NAME; else process.env.APP_NAME = saved;

if (failed) {
  console.error(`\n  ${failed} failed\n`);
  process.exit(1);
}
console.log('\n  all passed\n');
