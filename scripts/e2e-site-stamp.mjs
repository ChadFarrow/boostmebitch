// End-to-end for THE NOTE STAMP: `/api/nostr/site-sign` signs a boost note under
// the site's verified name only when a 1-sat invoice the site minted for EXACTLY
// that event was paid, and every boost that cannot get the stamp still posts its
// note — from a one-time key. Reasoning: docs/security.md and
// docs/money-boosts.md, "the site-sign stamp".
//
// Usage (a THROWAWAY site key — never run this against the real SITE_NOSTR_SK):
//   export E2E_SITE_SK=$(node -e "import('nostr-tools').then(m=>console.log(Buffer.from(m.generateSecretKey()).toString('hex')))")
//   npm run build
//   SITE_NOSTR_SK=$E2E_SITE_SK LNBITS_URL=http://127.0.0.1:3418 LNBITS_INVOICE_KEY=e2e-key \
//     SITE_SIGN_REQUIRE_STAMP=on npx next start -p 3417 -H 127.0.0.1
//   APP_URL=http://127.0.0.1:3417 E2E_SITE_SK=$E2E_SITE_SK E2E_REQUIRE_STAMP=on npm run e2e:sitestamp
// Phase 1 (the switch off): start the server WITHOUT SITE_SIGN_REQUIRE_STAMP and run
//   E2E_REQUIRE_STAMP= ONLY=1 npm run e2e:sitestamp
// `ONLY=1,3` runs those sections alone; `--headed` to watch, `--keep` to leave it open.
//
// NOTHING LEAVES THE MACHINE. Chrome resolves no host but this one
// (`--host-resolver-rules`); the LNbits wallet is `fake-lnbits.mjs`, started by
// this script on port 3418, which is why the server's LNBITS_URL names it; the
// site key is the throwaway above, and the first signature proves the server
// holds it.
//
// What it pins:
//   1. The routes, called with `fetch` from inside the page: a bare template is
//      refused with the switch on and signed with it off; an unpaid stamp is
//      402; a paid stamp signs exactly its own event, as often as asked; a
//      changed note, a flipped MAC and a refused template are 400; an LNbits that
//      fails or hangs is a 502 inside the route's own timeout.

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { createFakeLnbits } from './fake-lnbits.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3417';
const SITE_SK_HEX = process.env.E2E_SITE_SK ?? '';
const REQUIRE_STAMP = process.env.E2E_REQUIRE_STAMP === 'on';
const ONLY = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const runs = (n) => ONLY.length === 0 || ONLY.includes(String(n));
const LNBITS_PORT = 3418;
const LNBITS_KEY = 'e2e-key';

if (!/^[0-9a-f]{64}$/.test(SITE_SK_HEX)) {
  console.error('E2E_SITE_SK must be the 64-hex throwaway key the server was started with (see the header).');
  process.exit(2);
}
const siteSk = Uint8Array.from(Buffer.from(SITE_SK_HEX, 'hex'));
const sitePk = getPublicKey(siteSk);

const lnbits = createFakeLnbits({ port: LNBITS_PORT, key: LNBITS_KEY });
await lnbits.ready;
await requireApp(`${APP}/privacy`, `Nothing is serving ${APP}. Start it as the header says.`);

const t = checker();
const section = (s) => console.log(`\n--- ${s} ---`);

const { page } = await launchChrome({
  name: 'site-stamp',
  args: ['--disable-gpu', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
});
const { send, js } = page;
const exceptions = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails?.exception?.description ?? 'exception').slice(0, 300));
  }
});
await send('Page.enable');
await send('Runtime.enable');

// ---- helpers ----------------------------------------------------------------
const nowSecs = () => Math.floor(Date.now() / 1000);
/** The smallest template the validator takes: the prefix and the two `t` markers. */
const template = (content = '⚡ Boost ⚡\n\ne2e: a note stamp test') => ({
  kind: 1,
  created_at: nowSecs(),
  tags: [['t', 'boostagram'], ['t', 'value4value'], ['client', 'e2e']],
  content,
});
/** POST from INSIDE the page, so the browser's own fetch is what is refused. */
const post = (path, body) => js(`fetch(${JSON.stringify(path)}, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: ${JSON.stringify(JSON.stringify(body))},
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
const claimsOf = (stamp) => JSON.parse(Buffer.from(String(stamp).split('.')[0], 'base64url').toString());
const flipLast = (s) => s.slice(0, -1) + (s.at(-1) === 'A' ? 'B' : 'A');

await send('Page.navigate', { url: `${APP}/privacy` });
await page.until('document.readyState === "complete"', 20000);

// =============================================================================
if (runs(1)) {
  section('1. the routes refuse what is not paid');
  lnbits.reset();

  const bare = await post('/api/nostr/site-sign', template());
  if (REQUIRE_STAMP) {
    t.equal('a bare template, switch on → 402', [bare?.status, bare?.body?.error], [402, 'a note stamp is required']);
  } else {
    t.equal('a bare template, switch off → 200 (phase 1)', bare?.status, 200);
    t.equal('...signed by the throwaway site key', bare?.body?.event?.pubkey, sitePk);
  }

  if (!ONLY.length || REQUIRE_STAMP) {
    const before = lnbits.minted.length;
    const note = template();
    const minted = await post('/api/nostr/site-stamp', { template: note });
    t.equal('site-stamp answers 200', minted?.status, 200);
    t.equal('...and minted one invoice', lnbits.minted.length - before, 1);
    const inv = lnbits.minted.at(-1);
    t.ok('...for 1 sat (1000 msat)', inv?.amount === 1000, JSON.stringify(inv));
    t.ok('...with the brand\'s stamp memo', / note stamp$/.test(inv?.memo ?? ''), inv?.memo);
    t.equal('...expiring in 600 s', inv?.expiry, 600);
    t.equal('...and handed back that invoice', minted?.body?.invoice, inv?.bolt11);
    const stamp = minted?.body?.stamp;
    const claims = stamp ? claimsOf(stamp) : {};
    t.equal('the token names the invoice\'s payment hash', claims.ph, inv?.hash);

    const unpaid = await post('/api/nostr/site-sign', { template: note, stamp });
    t.equal('an unpaid stamp → 402 not paid', [unpaid?.status, unpaid?.body?.error], [402, 'the note stamp is not paid']);

    t.ok('the page pays it (fake LNbits)', lnbits.markPaid(inv?.bolt11));
    const signed = await post('/api/nostr/site-sign', { template: note, stamp });
    t.equal('a paid stamp → 200', signed?.status, 200);
    if (signed?.body?.event?.pubkey && signed.body.event.pubkey !== sitePk) {
      t.fail('THE SERVER IS NOT RUNNING UNDER E2E_SITE_SK — stop and restart it as the header says');
      await lnbits.close();
      await exit(1);
    }
    t.equal('...signed by the site key', signed?.body?.event?.pubkey, sitePk);
    t.equal('...as exactly the event the stamp was minted for', signed?.body?.event?.id, claims.id);

    const again = await post('/api/nostr/site-sign', { template: note, stamp });
    t.equal('asked again (RETRY NOTE): the same event id', again?.body?.event?.id, claims.id);
    t.equal('...and no new invoice', lnbits.minted.length - before, 1);

    const changed = await post('/api/nostr/site-sign', { template: { ...note, content: `${note.content}!` }, stamp });
    t.equal('the paid stamp on a changed note → 400', [changed?.status, changed?.body?.error], [400, 'the note stamp is for a different note']);

    const forged = await post('/api/nostr/site-sign', { template: note, stamp: flipLast(stamp ?? 'x.y') });
    t.equal('a flipped MAC character → 400', [forged?.status, forged?.body?.error], [400, 'the note stamp is not valid']);

    const otherKey = generateSecretKey();
    const stranger = finalizeEvent(template(), otherKey);
    const smuggled = await post('/api/nostr/site-sign', { template: note, stamp: `${Buffer.from(JSON.stringify({ v: 1, id: stranger.id, ph: inv?.hash, exp: nowSecs() + 60 })).toString('base64url')}.${stamp?.split('.')[1]}` });
    t.equal('another payload under the paid MAC → 400', [smuggled?.status, smuggled?.body?.error], [400, 'the note stamp is not valid']);

    const mintedBefore = lnbits.minted.length;
    const refused = await post('/api/nostr/site-stamp', { template: template('not a boost note') });
    t.equal('a template the validator refuses → 400 from site-stamp', [refused?.status, refused?.body?.error], [400, 'not a boost note']);
    t.equal('...and no invoice was minted for it', lnbits.minted.length, mintedBefore);

    lnbits.mode.mint = 'fail';
    const mintFail = await post('/api/nostr/site-stamp', { template: template() });
    t.equal('LNbits refuses to mint → 502', [mintFail?.status, mintFail?.body?.error], [502, 'could not create the stamp invoice']);
    lnbits.reset();

    const second = template('⚡ Boost ⚡\n\ne2e: the lookup hangs');
    const m2 = await post('/api/nostr/site-stamp', { template: second });
    lnbits.markPaid(m2?.body?.invoice);
    lnbits.mode.lookup = 'hang';
    const started = Date.now();
    const hang = await post('/api/nostr/site-sign', { template: second, stamp: m2?.body?.stamp });
    const took = Date.now() - started;
    t.equal('LNbits never answers the lookup → 502', [hang?.status, hang?.body?.error], [502, 'could not confirm the stamp']);
    t.ok(`...inside 10 s (took ${took} ms)`, took < 10_000);
    lnbits.reset();
  }
}

// =============================================================================
t.equal('no uncaught exception in the page', exceptions, []);
console.log(`\n${t.count - t.fails}/${t.count} passed`);
await lnbits.close();
await wait(50);
await exit(t.fails ? 1 : 0);
