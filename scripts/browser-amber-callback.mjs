// End-to-end check of /amber-callback in a REAL browser.
//
// Usage:
//   npm run dev                                   # in another shell
//   node scripts/browser-amber-callback.mjs       # defaults to :3000
//   ORIGIN=http://localhost:3005 node scripts/browser-amber-callback.mjs
//
// NOT a check:* script and deliberately not in that list: it needs a running
// dev server, so it cannot be part of a suite that must pass from a clean
// checkout. Run it after touching app/amber-callback/page.tsx,
// lib/nostr/amber.ts, or the Amber resume in components/nostr-auth/index.tsx.
//
// WHY IT EXISTS. check:amber pins the pure wire format under plain Node, which
// is the half that can be pinned that way. The half it cannot reach is the one
// that actually failed in production twice: does a fragment arriving on a real
// page get parsed, matched against sessionStorage, parked, and picked up by the
// resume — and does each refusal put something on SCREEN rather than a
// console.warn. That needs a browser, so this drives one over CDP.
//
// Amber is stood in for by a hand-built URL of exactly the shape the Pixel 6
// produced (see the AMBER_WIRE_* fixtures in scripts/check-amber.mjs). What is
// NOT covered here is the hop this cannot fake: whether Android hands Amber's
// ACTION_VIEW to the browser tab that made the request. That is a device fact.
//
// TWO HARNESS TRAPS, RECORDED BECAUSE BOTH READ AS PRODUCT BUGS:
//
//   1. `Page.navigate` to a URL that differs from the current one ONLY by
//      fragment is a SAME-DOCUMENT navigation. The page does not reload, the
//      effect does not re-run, and every assertion fails in a way that looks
//      exactly like the page ignoring the fragment. Hence the bounce through
//      /privacy before each callback URL.
//   2. Asserting before React has hydrated reads as "the page did nothing".
//      `settled()` waits for the effect to have run rather than sleeping a
//      guessed interval.
import { checker, exit, launchChrome, wait } from './cdp.mjs';

const ORIGIN = process.env.ORIGIN || 'http://localhost:3000';
const PUBKEY = 'f7922a0adb3fa4dda5eecaa62f6f7ee6159f7f55e08036686c68e08382c34788';
const RID = '0123456789abcdef0123456789abcdef';
const OTHER_RID = 'ffffffffffffffffffffffffffffffff';

// The browser comes from scripts/cdp.mjs: CHROME_PATH (this script used to
// hard-code the macOS path, so it could not run on Linux at all), muted, on a
// free debug port, and closed with its profile on any exit.
const browser = await launchChrome({ name: 'amber-callback', args: ['--disable-gpu'] });
const { send } = browser.page;
const evaluate = browser.page.jsOrThrow;
const sleep = wait;
async function goto(url) {
  // Bounce through another route first. Page.navigate to a URL that differs
  // from the current one ONLY by fragment is a same-document navigation, so the
  // page never reloads and the effect never re-runs — which reads as a product
  // failure and is not one. sessionStorage survives the bounce (same origin,
  // same tab), which is what the fixtures depend on.
  if (url.includes('#')) {
    await send('Page.navigate', { url: `${ORIGIN}/privacy` });
    await sleep(700);
  }
  await send('Page.navigate', { url });
  // Poll for the new document rather than sleeping a guessed interval: an
  // about:blank context throws SecurityError on sessionStorage, which reads as
  // a product bug rather than a harness one.
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    try {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState + "|" + location.href', returnByValue: true });
      const v = r.result?.result?.value;
      if (i === 20) console.log('    [harness] readyState/href =', v, JSON.stringify(r).slice(0, 200));
      if (typeof v === 'string' && v.startsWith('complete|') && v.includes('localhost')) { await sleep(400); return; }
    } catch { /* context swapping */ }
  }
  throw new Error(`navigation to ${url} never completed`);
}

async function settled() {
  // Next dev hydrates slowly on a cold compile; checking before the effect runs
  // reads as a product failure. Wait for the page to stop saying "Finishing".
  for (let i = 0; i < 80; i++) {
    const t = await evaluate('document.body ? document.body.innerText : ""');
    if (t && !t.includes('Finishing')) return t;
    if (await evaluate("location.pathname !== '/amber-callback'")) return '';
    await sleep(250);
  }
  return await evaluate('document.body.innerText');
}

await send('Page.enable');
await send('Runtime.enable');

const t = checker();
const check = (label, actual, expected) => t.equal(label, actual, expected);

const CB = (rid) => `${ORIGIN}/amber-callback#r=${rid};event=${PUBKEY}`;

console.log('\n1. a callback with NO pending record refuses, visibly, and shows the value');
await goto(`${ORIGIN}/amber-callback`);
await evaluate('localStorage.clear(); sessionStorage.clear(); true');
await goto(CB(RID));
await settled();
check('the fragment is gone from the address bar', await evaluate('location.hash'), '');
check('...and from the history entry', await evaluate('location.pathname + location.search + location.hash'), '/amber-callback');
check('it says so on screen', await evaluate("document.body.innerText.includes('was not waiting')"), true);
check('and hands the value back for a manual paste', await evaluate(`document.body.innerText.includes('${PUBKEY}')`), true);
check('nothing was parked', await evaluate("localStorage.getItem('bmb:amber_result')"), null);

console.log('\n2. a callback whose id does not match the pending record refuses');
await evaluate(`localStorage.setItem('bmb:amber_pending', JSON.stringify({ rid: '${OTHER_RID}', type: 'get_public_key', ts: Date.now(), origin: '/' })); true`);
await goto(CB(RID));
await settled();
check('it names the mismatch', await evaluate("document.body.innerText.includes('different request')"), true);
check('nothing was parked', await evaluate("localStorage.getItem('bmb:amber_result')"), null);
check('the pending record is left alone for the real answer', await evaluate("JSON.parse(localStorage.getItem('bmb:amber_pending')).rid"), OTHER_RID);

console.log('\n3. an EXPIRED pending record refuses');
await evaluate(`localStorage.setItem('bmb:amber_pending', JSON.stringify({ rid: '${RID}', type: 'get_public_key', ts: Date.now() - 6*60*1000, origin: '/' })); true`);
await goto(CB(RID));
await settled();
check('it says the request is too old', await evaluate("document.body.innerText.includes('too old')"), true);
check('nothing was parked', await evaluate("localStorage.getItem('bmb:amber_result')"), null);

console.log('\n4. a result of the wrong SHAPE refuses');
await evaluate(`localStorage.setItem('bmb:amber_pending', JSON.stringify({ rid: '${RID}', type: 'get_public_key', ts: Date.now(), origin: '/' })); true`);
await goto(`${ORIGIN}/amber-callback#r=${RID};event=${encodeURIComponent('{"sig":"aa"}')}`);
await settled();
check('it says the shape is wrong', await evaluate("document.body.innerText.includes('does not look like')"), true);
check('nothing was parked', await evaluate("localStorage.getItem('bmb:amber_result')"), null);

console.log('\n5. the happy path parks the result and redirects');
await evaluate(`localStorage.setItem('bmb:amber_pending', JSON.stringify({ rid: '${RID}', type: 'get_public_key', ts: Date.now(), origin: '/favorites' })); true`);
await goto(CB(RID));
await settled();
await sleep(2500);
check('it went back to where the user was, not to /', await evaluate('location.pathname + location.search'), '/favorites');
check('the pending record was consumed', await evaluate("localStorage.getItem('bmb:amber_pending')"), null);
check('bmb:signer says amber', await evaluate("localStorage.getItem('bmb:signer')"), 'amber');
check('bmb:npub was written', await evaluate("(localStorage.getItem('bmb:npub')||'').startsWith('npub1')"), true);
check('the parked result was consumed by the resume', await evaluate("localStorage.getItem('bmb:amber_result')"), null);

console.log('\n5b. THE CASE THIS DESIGN EXISTS FOR: the callback lands in a DIFFERENT tab');
{
  // Measured on a Pixel 6: Brave opens Amber's callback in a NEW TAB rather
  // than reusing the one that dispatched. sessionStorage is per-tab, so the
  // first version of this feature found no pending record and fell back to a
  // manual paste every time. The records are localStorage for exactly this, and
  // a second CDP target is the only honest way to assert it — a second tab has
  // its own sessionStorage and shares localStorage, same as the phone.
  await evaluate("localStorage.clear(); sessionStorage.clear(); true");
  await evaluate(`localStorage.setItem('bmb:amber_pending', JSON.stringify({ rid: '${RID}', type: 'get_public_key', ts: Date.now(), origin: '/favorites' })); true`);
  // Prove the premise rather than assuming it: the dispatching tab's
  // sessionStorage must NOT be visible to the tab the callback lands in.
  await evaluate("sessionStorage.setItem('probe', 'dispatching-tab'); true");

  const tab2 = await browser.openTab(CB(RID));
  const send2 = tab2.send;
  const ev2 = tab2.js;
  await send2('Runtime.enable'); await send2('Page.enable');
  for (let i = 0; i < 60; i++) { await sleep(250); if (await ev2("location.pathname !== '/amber-callback'")) break; }
  // Wait for the sign-in to be RECORDED, not a guessed interval. The redirect
  // lands first and the resume signs in after the route has hydrated, which on
  // a dev server's first compile of /favorites took longer than the 1.2 s this
  // used to sleep — the check below then read null over a sign-in that was
  // still on its way. Bounded, so a sign-in that never happens still fails it.
  await tab2.until("localStorage.getItem('bmb:signer') !== null", 10000, 250);
  await sleep(300);

  check('the new tab really has its own sessionStorage', await ev2("sessionStorage.getItem('probe')"), null);
  check('the callback completed in the tab it landed in', await ev2('location.pathname'), '/favorites');
  check('and signed the user in there', await ev2("localStorage.getItem('bmb:signer')"), 'amber');
  check('the pending record was consumed', await ev2("localStorage.getItem('bmb:amber_pending')"), null);
  await tab2.close();
}

console.log('\n6. a callback naming a DIFFERENT account than the signed-in one is refused');
const otherPk = 'a'.repeat(64);
await evaluate(`localStorage.setItem('bmb:amber_pending', JSON.stringify({ rid: '${RID}', type: 'get_public_key', ts: Date.now(), origin: '/' })); true`);
await goto(`${ORIGIN}/amber-callback#r=${RID};event=${otherPk}`);
await settled();
await sleep(2500);
const npubAfter = await evaluate("localStorage.getItem('bmb:npub')");
check('bmb:npub was NOT switched to the other account', npubAfter?.startsWith('npub1') && !(await evaluate(`'${otherPk}'`)) === false, true);
check('the signed-in npub is unchanged', await evaluate("localStorage.getItem('bmb:npub')"), npubAfter);
check('the stale result was consumed, not left to replay', await evaluate("localStorage.getItem('bmb:amber_result')"), null);

console.log(t.fails ? `\n${t.fails} browser check(s) FAILED.` : '\nAll browser checks passed.');
await exit(t.fails ? 1 : 0);
