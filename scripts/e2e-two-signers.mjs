// End-to-end for TWO SIGNER APPS HOLDING ONE KEY, against nothing but this
// machine.
//
// Usage:
//   npm run dev                  # in another terminal
//   npm run e2e:twosigners       # headless
//   npm run e2e:twosigners -- --headed --keep
//   APP_URL=http://localhost:3001 npm run e2e:twosigners
//
// THE FIELD BUG. Reported from an iPhone (2026-11-01): a brand-new "Sign in with
// Clave" pairing, then the account menu sat on "Waiting for you to approve in
// your signer (asked 5×) — Request: reading your public key" until the budget
// ran out. Clave had answered every one of those requests correctly, within a
// second.
//
// The cause was a SECOND signer app holding the same key: Amber on the user's
// Android phone. A NIP-46 request is addressed to the user's PUBKEY, so every
// signer app that holds that key and listens on the relay sees it — and Amber
// answers any client it was never paired with with `no permission`
// (`EventNotificationConsumer.kt`, `BunkerResponse(id, "", "no permission")`).
// It listens on the same two relays this app pairs over, because the user's
// Android pairing with this app put them there. The relays' stored kind:24133
// traffic showed it: two answers per request from the one key, a 176-character
// error on relay.nostrconnect.com and a 220-character result (a 64-hex pubkey)
// on relay.powr.build.
//
// nostr-tools 2.19.4 settles a request on the FIRST answer for its id and then
// deletes the listener, so Amber's faster `no permission` won and Clave's
// pubkey was dropped. `isApprovalPending` reads `no permission` as "queued for
// the user", so `withApprovalWait` asked again — and Amber won again, every time.
//
// So this runs ONE relay and TWO stub responders on ONE key:
//   - the imposter answers every request at once with `no permission`, exactly
//     as Amber does for a client it does not know;
//   - the real signer answers correctly, REAL_DELAY_MS later, as Clave does.
//
// NOTHING REACHES A PUBLIC RELAY and every key is generated per run.
//
// What it pins:
//   1. A cold-load restore completes: one `connect`, one `get_public_key`, no
//      approval notice, a live `window.nostr`.
//   2. A signature completes on the FIRST request, with the real signer's event.
//   3. MUST STILL WORK — a real refusal is still a refusal. The real signer says
//      `user rejected` after the imposter's `no permission`, and the call fails
//      with the real signer's words, inside the grace window, without a re-issue.
//   4. MUST STILL WORK — with no real signer answering at all, the old path is
//      intact: the imposter's `no permission` reaches `withApprovalWait` after
//      the grace window and the approval notice still appears, with Stop waiting.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
// Clave answered about a second after Amber in the field traffic. Well inside
// the grace window, and long enough that the imposter always answers first.
const REAL_DELAY_MS = 700;
// NIP46_ERROR_GRACE_MS in lib/nostr/nip46-errors.ts — asserted equal there by
// `check:nip46error`, because a plain .mjs cannot import the .ts constant.
const GRACE_MS = 5000;

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.
(and \`rm -rf .next\` first if you have just run a production build)`);

const { page } = await launchChrome({ name: 'two-signers', args: ['--disable-gpu'] });

// The user's key, held by BOTH responders. That is the whole condition.
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const clientSk = generateSecretKey();
const clientPk = getPublicKey(clientSk);
const rpcKey = nip44.v2.utils.getConversationKey(sk, clientPk);

const PORT = await createRelay({ port: 0, log: null }).ready;

/**
 * One responder = one socket and one subscription, so the two really are two
 * programs on the relay rather than one handler with a branch in it.
 * `decide(req)` returns the reply object, or null to stay silent.
 */
async function responder(name, decide, delayMs) {
  const seen = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.send(JSON.stringify(['REQ', name, { kinds: [24133], '#p': [pk] }]));
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg[0] !== 'EVENT' || msg[1] !== name) return;
    let req;
    try { req = JSON.parse(nip44.v2.decrypt(msg[2].content, rpcKey)); } catch { return; }
    seen.push(req.method);
    const reply = decide(req);
    if (!reply) return;
    const sendIt = () => ws.send(JSON.stringify(['EVENT', finalizeEvent({
      kind: 24133,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', clientPk]],
      content: nip44.v2.encrypt(JSON.stringify(reply), rpcKey),
    }, sk)]));
    if (delayMs) setTimeout(sendIt, delayMs); else sendIt();
  });
  return seen;
}

// ---- the two responders ----------------------------------------------------
let imposterOn = true;
/** 'answer' | 'reject-sign' | 'silent' */
let realMode = 'answer';

// AMBER, for a client it has no permission row for. Every method, every time.
const imposterSeen = await responder('imposter',
  (req) => (imposterOn ? { id: req.id, result: '', error: 'no permission' } : null), 0);

// CLAVE. `connect` echoes the secret when one was sent, else "ack" — that is
// LightSigner.processRequest's own rule.
const realSeen = await responder('real', (req) => {
  if (realMode === 'silent') return null;
  if (req.method === 'connect') return { id: req.id, result: req.params?.[1] || 'ack' };
  if (req.method === 'get_public_key') return { id: req.id, result: pk };
  if (req.method === 'ping') return { id: req.id, result: 'pong' };
  if (req.method === 'sign_event') {
    if (realMode === 'reject-sign') return { id: req.id, result: '', error: 'user rejected' };
    return { id: req.id, result: JSON.stringify(finalizeEvent(JSON.parse(req.params[0]), sk)) };
  }
  return { id: req.id, result: '', error: `unsupported: ${req.method}` };
}, REAL_DELAY_MS);

// ---- CDP -------------------------------------------------------------------
const { send } = page;
const js = page.jsOrThrow;
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const t = checker();
const check = (label, got, want) => t.equal(label, got, want);
const count = (seen, method) => seen.filter((m) => m === method).length;

// The approval notice is anchored under the account button while the menu is
// CLOSED, so the whole document is read rather than `[role="menu"]`.
const approvalNotice = () => js(`/Waiting for you to approve in your signer/.test(document.body.innerText || '')`);
const hasWindowNostr = () => js(`typeof window.nostr?.signEvent === 'function'`);

const bootstrap = () => `(() => { localStorage.clear();
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'bunker');
  localStorage.setItem('bmb:bunker', ${JSON.stringify(JSON.stringify({ uri: `bunker://${pk}?relay=ws://127.0.0.1:${PORT}`, clientSk: hex(clientSk) }))});
  return 1; })()`;

async function coldLoad() {
  await send('Page.navigate', { url: APP }); await wait(2000);
  await js(bootstrap());
  realSeen.length = 0;
  imposterSeen.length = 0;
  await send('Page.navigate', { url: APP });
}

/** Ask for a signature through the adapter the app publishes, and record the outcome. */
async function startSign(content) {
  await js(`(() => {
    window.__signed = null;
    window.__signedAt = null;
    // Scenario 1 failing leaves no adapter; say so rather than crash the run.
    if (!window.nostr) { window.__signed = { ok: false, err: 'no window.nostr' }; return 1; }
    const t0 = Date.now();
    window.nostr.signEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: ${JSON.stringify(content)} })
      .then((e) => { window.__signed = { ok: true, pubkey: e.pubkey, content: e.content }; window.__signedAt = Date.now() - t0; })
      .catch((e) => { window.__signed = { ok: false, err: String(e && e.message ? e.message : e) }; window.__signedAt = Date.now() - t0; });
    return 1;
  })()`);
}

await send('Page.enable'); await send('Runtime.enable');

// ---- 1. the restore, with the imposter answering first ---------------------
console.log('\n1. a cold-load restore while a second signer app answers "no permission" first');
await coldLoad();
await wait(9000);
check('the real signer saw the restore connect', count(realSeen, 'connect') >= 1, true);
check('...and the imposter saw it too — both hold the key', count(imposterSeen, 'connect') >= 1, true);
check('connect went out ONCE — no re-issue', count(realSeen, 'connect'), 1);
check('get_public_key went out ONCE — no re-issue', count(realSeen, 'get_public_key'), 1);
check('no approval notice for a request the real signer answered', await approvalNotice(), false);
check('the restore completed: window.nostr is live', await hasWindowNostr(), true);

// ---- 2. a signature, with the imposter answering first ---------------------
console.log('\n2. a signature while the imposter answers "no permission" first');
await startSign('two-signers probe');
await wait(4000);
const signed = await js(`window.__signed`);
check('the signature completed', signed?.ok, true);
check('...signed by the user key, through the real signer', signed?.pubkey, pk);
check('...on the FIRST request', count(realSeen, 'sign_event'), 1);
check('...and no approval notice', await approvalNotice(), false);

// ---- 3. MUST STILL WORK: a real refusal is still a refusal -----------------
console.log('\n3. the real signer refuses — the refusal still lands, in its own words');
realMode = 'reject-sign';
realSeen.length = 0;
await startSign('two-signers refusal');
await wait(GRACE_MS + 4000);
const refused = await js(`window.__signed`);
const refusedAt = await js(`window.__signedAt`);
check('the call failed', refused?.ok, false);
check('...with the REAL signer\'s words, not the imposter\'s', /user rejected/.test(refused?.err ?? ''), true);
check('...at the end of the grace window, not after a re-issue',
  typeof refusedAt === 'number' && refusedAt >= GRACE_MS && refusedAt < GRACE_MS + 2000, true);
check('...and it was not re-issued', count(realSeen, 'sign_event'), 1);
check('...and no approval notice was raised for it', await approvalNotice(), false);

// ---- 4. MUST STILL WORK: only the imposter answers -------------------------
//
// The real signer is gone (or is holding the request for its user, which looks
// identical from here). The imposter's `no permission` is the ONLY answer, so
// after the grace window it must reach `withApprovalWait` exactly as before —
// the notice up, Stop waiting on it — rather than vanishing into the hold.
console.log('\n4. only the imposter answers — the old approval path is intact');
realMode = 'silent';
realSeen.length = 0;
imposterSeen.length = 0;
await startSign('two-signers silent');
// The window, then the first 2.5 s gap, then the re-issue's own round trip.
await wait(GRACE_MS + 5000);
check('the approval notice is up', await approvalNotice(), true);
check('the request was re-issued after the grace window', count(imposterSeen, 'sign_event') >= 2, true);
check('the call is still outstanding, not failed', await js(`window.__signed`), null);
await js(`(() => { const b = [...document.querySelectorAll('button')].find((el) => /^Stop waiting/i.test((el.innerText || '').trim())); if (b) b.click(); return !!b; })()`);
await wait(7000);
check('Stop waiting ends it', (await js(`window.__signed`))?.ok, false);
check('...and the notice is gone', await approvalNotice(), false);

console.log(t.fails === 0 ? '\nAll two-signer checks passed.\n' : `\n${t.fails} FAILED\n`);
await exit(t.fails === 0 ? 0 : 1);
