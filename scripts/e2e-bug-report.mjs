// The bug report's two privacy rules (lib/bug-report.ts), end to end: a secret
// is refused wherever it sits in the typed text, and the page path names no
// Nostr entity. The report becomes a PUBLIC GitHub issue under the owner's name.
//
// Usage:
//   npm run dev                  # in another terminal
//   npm run e2e:bugreport [-- --headed --keep]
// Run it at most once a minute: section 2 spends the route's whole per-IP limit.
//
// WHY THIS EXISTS. `secretInReport` split the text on whitespace and tested the
// START of each token, so a key glued to other text — `"nsec":"nsec1…"`,
// `key=nsec1…`, `uri:nostr+walletconnect://…`, `sk:<64 hex>` — passed the modal
// AND the route, and was burnt on filing. `reportPath` elided `npub1` and
// `nprofile1` segments only, so `/stream/<naddr>` put the stream and its host's
// pubkey in a public issue. Full-code review, 2026-11-19, finding 15.
//
// PART 1 needs no server. It imports the SHIPPING module through the e2e
// resolve hook (lib/bug-report.ts has relative imports, so no check:* can load
// it) and replays every vector against `naive()`, the code before 2026-11-26.
//
// PART 2 drives the modal and the route in a real browser. Signed out, nothing
// reaches a relay. Every report goes to the REAL route as a dry run:
// scripts/cdp.mjs adds `X-Bug-Report-Dry-Run: 1` to each `/api/bug-report`
// fetch, and the route answers `{ dryRun: true }` after every check and files
// nothing, token or not. The keys here are generated per run and never used.

import { register } from 'node:module';
register('./e2e-resolve-hook.mjs', import.meta.url);

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { replayVectors } from './replay-vectors.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const { secretInReport, reportPath, parseBugReport } = await import('../lib/bug-report.ts');
const { looksLikeSecretKey } = await import('../lib/nostr/npub-input.ts');
const { wordlist } = await import('@scure/bip39/wordlists/english.js');

const t = checker();
const section = (n) => console.log(`\n${n}`);

const sk = generateSecretKey();
const NSEC = nip19.nsecEncode(sk);
const HEX = Buffer.from(sk).toString('hex');
const PK = getPublicKey(sk);
const NWC = `nostr+walletconnect://${PK}?relay=wss%3A%2F%2Frelay.example&secret=${HEX}`;
const NADDR = nip19.naddrEncode({ kind: 30311, pubkey: PK, identifier: 'e2e-stream' });
const NEVENT = nip19.neventEncode({ id: 'a'.repeat(64), author: PK });
const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

// ---------------------------------------------------------------------------
section('1. The shipping module, against the code before 2026-11-26');
// ---------------------------------------------------------------------------
// naive(): the whitespace split and the two-prefix path rule, verbatim.
const BIP39 = new Set(wordlist);
function naiveSecret(text, typed = true) {
  let run = 0;
  for (const raw of text.split(/[\s,;]+/)) {
    const token = raw.replace(/^[^a-z0-9]+/i, '');
    if (!token) continue;
    if (looksLikeSecretKey(token)) return 'nsec';
    if (token.toLowerCase().startsWith('nostr+walletconnect:')) return 'nwc';
    if (!typed) continue;
    const bare = token.replace(/[^a-z0-9]+$/i, '');
    if (/^(?:0x)?[0-9a-f]{64}$/i.test(bare)) return 'hex';
    if (/^\d{1,2}[.):]?$/.test(bare)) continue;
    run = BIP39.has(bare.toLowerCase()) ? run + 1 : 0;
    if (run >= 12) return 'mnemonic';
  }
  return null;
}
const naivePath = (p) => p.split('/').map((s) => (/^(?:npub1|nprofile1)/i.test(s) ? '…' : s)).join('/');

const vectors = [
  // Glued to other text: every one passed before.
  { label: 'a JSON-glued nsec', kind: 'secret', args: [`{"nsec":"${NSEC}"}`], expect: 'nsec' },
  { label: 'key=nsec', kind: 'secret', args: [`my key=${NSEC} broke it`], expect: 'nsec' },
  { label: 'an nsec after a URL path', kind: 'secret', args: [`https://x.example/login/${NSEC}`], expect: 'nsec' },
  { label: 'an NWC string after a label', kind: 'secret', args: [`uri:${NWC}`], expect: 'nwc' },
  { label: 'an NWC string in JSON', kind: 'secret', args: [`{"nwc":"${NWC}"}`], expect: 'nwc' },
  { label: 'a hex key glued by a colon', kind: 'secret', args: [`sk:${HEX}`], expect: 'hex' },
  { label: 'a hex key glued by =', kind: 'secret', args: [`privkey=${HEX}`], expect: 'hex' },
  { label: 'a JSON-glued seed phrase', kind: 'secret', args: [`{"mnemonic":"${SEED}"}`], expect: 'mnemonic' },
  { label: 'a glued nsec in the SNAPSHOT (typed=false)', kind: 'secret', args: [`x:${NSEC}`, false], expect: 'nsec' },
  // Must still work: what was refused before is refused now, and ordinary text passes.
  { label: 'a bare nsec', kind: 'secret', args: [`here ${NSEC}`], expect: 'nsec', alsoNaive: true },
  { label: 'a quoted nsec', kind: 'secret', args: [`"${NSEC}"`], expect: 'nsec', alsoNaive: true },
  { label: 'a bare NWC string', kind: 'secret', args: [NWC], expect: 'nwc', alsoNaive: true },
  { label: 'a bare hex key', kind: 'secret', args: [HEX], expect: 'hex', alsoNaive: true },
  { label: 'a numbered seed list', kind: 'secret', args: [SEED.split(' ').map((w, i) => `${i + 1}. ${w}`).join('\n')], expect: 'mnemonic', alsoNaive: true },
  { label: 'an npub is not a secret', kind: 'secret', args: [`my npub is ${nip19.npubEncode(PK)}`], expect: null, alsoNaive: true },
  { label: 'a nostr.build URL with a 64-hex name is not a secret', kind: 'secret', args: [`https://image.nostr.build/${HEX}.jpg did not load`], expect: null, alsoNaive: true },
  { label: 'an event link with a 64-hex id is not a secret', kind: 'secret', args: [`https://njump.me/e/${'b'.repeat(64)}`], expect: null, alsoNaive: true },
  { label: 'plain prose', kind: 'secret', args: ['The next song did not play after the screen locked, on my Pixel.'], expect: null, alsoNaive: true },
  { label: 'a word that contains nsec is not one', kind: 'secret', args: ['Insect1 mix is great'], expect: null, alsoNaive: true },
  { label: 'a 64-hex guid in the SNAPSHOT is not refused', kind: 'secret', args: [`/x/${HEX}`, false], expect: null, alsoNaive: true },
  // The page path.
  { label: '/stream/<naddr> is elided', kind: 'path', args: [`/stream/${NADDR}`], expect: '/stream/…' },
  { label: 'a nevent segment is elided', kind: 'path', args: [`/e/${NEVENT}`], expect: '/e/…' },
  { label: 'a percent-encoded nostr:naddr is elided', kind: 'path', args: [`/stream/nostr%3A${NADDR}`], expect: '/stream/…' },
  { label: '/npub/<npub> is elided', kind: 'path', args: [`/npub/${nip19.npubEncode(PK)}`], expect: '/npub/…', alsoNaive: true },
  { label: '/live/<npub> is elided', kind: 'path', args: [`/live/${nip19.npubEncode(PK)}`], expect: '/live/…', alsoNaive: true },
  { label: 'an ordinary path is kept', kind: 'path', args: ['/favorites'], expect: '/favorites', alsoNaive: true },
  { label: 'a playlist feed path is kept', kind: 'path', args: ['/feeds/playlists/abc.xml'], expect: '/feeds/playlists/abc.xml', alsoNaive: true },
];
const call = (which, v) => {
  try {
    if (v.kind === 'secret') return JSON.stringify(which === 'real' ? secretInReport(...v.args) : naiveSecret(...v.args));
    return JSON.stringify(which === 'real' ? reportPath(...v.args) : naivePath(...v.args));
  } catch (e) {
    return `threw: ${e.message}`;
  }
};
for (const v of vectors) t.equal(v.label, JSON.parse(call('real', v)), v.expect);
replayVectors({ vectors, invoke: call, fail: (m) => t.equal(m, true, false) });

// The route runs the same parse: a glued key in the typed text is refused, and
// the page it is sent is elided again (the POST is unauthenticated).
const parsed = parseBugReport({ answers: { happened: 'it broke' }, info: { page: `/stream/${NADDR}` } });
t.equal('parseBugReport elides a /stream/<naddr> page the client sent raw', parsed.ok && parsed.info.page, '/stream/…');
t.equal('parseBugReport refuses a glued nsec',
  parseBugReport({ answers: { happened: `{"nsec":"${NSEC}"}` } }).ok, false);

// ---------------------------------------------------------------------------
section('2. The modal and the route, in a real browser');
// ---------------------------------------------------------------------------
const APP = process.env.APP_URL ?? 'http://localhost:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);
const { page } = await launchChrome({ name: 'bugreport', args: ['--disable-gpu', '--window-size=1200,900'] });
const { send } = page;
const js = page.jsOrThrow;
await send('Page.enable'); await send('Runtime.enable');
// `/stream/<naddr>` has no header: there the report opens from the fullscreen
// player's own <AuthControl>, which needs a stream playing. The modal reads the
// path from `window.location` when it opens (`takeSnapshot`), so the page is
// opened where the trigger is and the address bar is moved to the stream's
// path first — the same input the modal reads on the stream page.
await send('Page.navigate', { url: `${APP}/favorites` }); await wait(8000);
await js(`(() => { history.replaceState(history.state, '', ${JSON.stringify(`/stream/${NADDR}`)}); return location.pathname; })()`);

const DIALOG = `[...document.querySelectorAll('[role="dialog"]')].find((d) => /Report a bug/.test(d.querySelector('h2')?.textContent ?? ''))`;
const opened = await js(`(async () => {
  const tick = () => new Promise((r) => setTimeout(r, 400));
  const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find((b) => /Sign in/.test(b.textContent));
  if (!trigger) return 'no trigger';
  trigger.click(); await tick();
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((b) => /Report a bug/.test(b.textContent));
  if (!item) return 'no item';
  item.click(); await tick();
  const d = ${DIALOG};
  if (!d) return 'no dialog';
  d.querySelector('details').open = true;
  return true;
})()`);
t.equal('the report modal opens with the address bar on /stream/<naddr>', opened, true);
const snap = await js(`(${DIALOG}).querySelector('details').textContent`);
t.equal('the snapshot the user is shown names the page as /stream/…', snap.includes('/stream/…'), true);
t.equal('...and carries no naddr', /naddr1/i.test(snap), false);

const typed = async (text) => js(`(async () => {
  const dlg = ${DIALOG};
  const ta = dlg.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const alert = dlg.querySelector('[role="alert"]')?.textContent ?? null;
  const btn = [...dlg.querySelectorAll('button')].find((b) => /Send report/.test(b.textContent));
  return { alert, disabled: !!btn?.disabled };
})()`);
for (const [label, text, word] of [
  ['a JSON-glued nsec', `my app said {"nsec":"${NSEC}"}`, 'Nostr secret key'],
  ['a labelled NWC string', `uri:${NWC}`, 'wallet connection string'],
  ['a glued hex key', `sk:${HEX}`, 'hex secret key'],
]) {
  const r = await typed(text);
  t.equal(`the modal refuses ${label}, and says why`, r.alert?.includes(word), true);
  t.equal('...and SEND is disabled', r.disabled, true);
}
const clean = await typed('The stream page froze when I pressed play.');
t.equal('ordinary text clears the refusal', clean, { alert: null, disabled: false });

// The route on its own: the modal is not the only client of an unauthed POST.
// The route takes 3 reports a minute per IP (`rateLimit(req, 'bug-report', 3)`),
// so three requests: two glued secrets and one clean report. The hex refusal is
// the same `parseBugReport` section 1 ran.
const statuses = await js(`(async () => {
  const post = async (happened) => (await fetch('/api/bug-report', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers: { happened }, info: {}, log: [] }),
  })).status;
  return {
    nsec: await post(${JSON.stringify(`{"nsec":"${NSEC}"}`)}),
    nwc: await post(${JSON.stringify(`uri:${NWC}`)}),
    clean: await post('e2e: bug report privacy check'),
  };
})()`);
t.equal('the route refuses each glued secret (400) and takes clean text as a dry run (200)',
  statuses, { nsec: 400, nwc: 400, clean: 200 });

if (t.fails) {
  console.error(`\nBUG REPORT E2E FAILED (${t.fails})`);
  await exit(1);
}
console.log('\nBUG REPORT E2E OK');
await exit(0);
