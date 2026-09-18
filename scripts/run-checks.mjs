// `npm run check` — every `check:*` script in package.json, one after another,
// with one line each and the full output of anything that failed.
//
// The list is READ from package.json, never written out here: a second list
// is a place a new check can be added to one and not the other, and then it
// sits unrun behind a green summary.
//
// `check:conformance` is REPORTED, never gating. It runs the PC20-Nostr spec's
// vectors, which are red on purpose where the spec is ahead of this app (see
// scripts/conformance.mjs), and it exits 2 when the sibling checkout is absent.
// Gating on it would make this command red on every run, which teaches people
// to stop reading it.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPORTED_ONLY = new Set(['check:conformance']);

const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const names = Object.keys(scripts).filter((n) => n.startsWith('check:'));

let failed = 0;
const started = Date.now();
for (const name of names) {
  const t0 = Date.now();
  const r = spawnSync('npm', ['run', '-s', name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (REPORTED_ONLY.has(name)) {
    if (r.status === 2) {
      console.log(`SKIP      ${name} (${secs} s) — ${out.trim().split('\n')[0]}`);
    } else {
      const tally = [...out.matchAll(/^# (pass|fail) (\d+)$/gm)].map((m) => `${m[1]} ${m[2]}`).join(', ');
      console.log(`REPORTED  ${name} (${secs} s) — ${tally || `exit ${r.status}`}; never gating`);
      // A stale spec checkout makes the tally meaningless; pass its warning on.
      const warn = out.match(/^conformance: WARNING .*$/m);
      if (warn) console.log(`          ${warn[0]}`);
    }
    continue;
  }
  if (r.status === 0) {
    console.log(`PASS      ${name} (${secs} s)`);
  } else {
    failed++;
    console.log(`FAIL      ${name} (${secs} s, exit ${r.status ?? r.signal})`);
    console.log(out.trimEnd().split('\n').map((l) => `    ${l}`).join('\n'));
  }
}

const total = ((Date.now() - started) / 1000).toFixed(1);
const gating = names.filter((n) => !REPORTED_ONLY.has(n)).length;
console.log(failed
  ? `\n${failed} of ${gating} checks FAILED (${total} s)`
  : `\nall ${gating} checks passed (${total} s)`);
process.exit(failed ? 1 : 0);
