// End-to-end for the kind:33369 Value Playback Summary's read-decide-publish
// cycle (lib/nostr/value-playback.ts, `updateValuePlaybackSummary`), against
// two relays on this machine that cap a REQ the way real relays do.
//
// Usage:
//   npm run e2e:vpsummary
//
// Needs no dev server, no wallet and no Podcast Index key.
//
// WHY THIS EXISTS. check:vpsummary pins the walk (`walkReceiptHistory`) and the
// address gate as pure functions. This drives the SHIPPING cycle through the
// real relay pool, so the wiring between them is tested too: the per-relay
// fetchers, the `limit`, the verdict, and the signer. Full-code review,
// 2026-11-19, finding 17: the scan could skip receipts, so the public total
// stayed low, and a timed-out cycle could still sign.
//
// The relays: A holds every receipt and caps a REQ at 100. B missed the recent
// ones (it holds the oldest 80) and caps at 100 too. The walk before
// 2026-11-26 asked both for one page, took ONE cursor from the oldest event of
// either relay (B's), and called a 180-event page "short", so "the end": a
// summary of 180 receipts out of 250, permanently, because the address is
// monotonic.
//
// NOTHING LEAVES THIS MACHINE: the first import replaces the global WebSocket
// with one that opens to 127.0.0.1 only and ends the run on any other URL.

import { relayGuard } from './no-public-relays.mjs';
import { register } from 'node:module';
register('./e2e-resolve-hook.mjs', import.meta.url);

import { createRelay } from './local-relay.mjs';
import { checker } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

// --- the signer, as an extension would present it --------------------------
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.window = globalThis;
let signs = 0;
// `hold` makes the next signEvent wait until the test releases it: how a
// signer that prompts, or goes away, looks from here.
let hold = null;
globalThis.window.nostr = {
  getPublicKey: async () => pk,
  signEvent: async (e) => {
    signs++;
    if (hold) {
      const h = hold;
      hold = null;
      h.asked();
      await h.released;
    }
    return finalizeEvent(e, sk);
  },
};
const nextSecond = () => new Promise((r) => setTimeout(r, 1100));
globalThis.window.location = { origin: 'http://localhost:3000' };

const t = checker();
const relayA = createRelay({ port: 0, log: null, capAt: 100 });
const relayB = createRelay({ port: 0, log: null, capAt: 100 });
const A = `ws://127.0.0.1:${await relayA.ready}`;
const B = `ws://127.0.0.1:${await relayB.ready}`;

const { buildValuePlaybackReceipt, updateValuePlaybackSummary, VALUE_PLAYBACK_RECEIPT_KIND } =
  await import('../lib/nostr/value-playback.ts');
const { VALUE_PLAYBACK_SUMMARY_KIND } = await import('../lib/nostr/value-playback-summary.ts');

// --- the receipts: 250 of 1 sat, one a minute, written straight into the relays
const FEED = 'e2e-vp-summary-feed-0000-000000000000';
const ID = `podcast:guid:${FEED}`;
const T0 = Math.floor(Date.now() / 1000) - 250 * 60;
const receipts = Array.from({ length: 250 }, (_, i) => finalizeEvent({
  ...buildValuePlaybackReceipt({ feedGuid: FEED, msat: 1000, action: 'stream', startSec: T0 + i * 60, endSec: T0 + i * 60 + 60 }),
  created_at: T0 + i * 60 + 60,
}, sk));
for (const e of receipts) relayA.events.set(e.id, e);
for (const e of receipts.slice(0, 80)) relayB.events.set(e.id, e);
t.equal('the fixture: A holds 250 receipts, B the oldest 80', [relayA.events.size, relayB.events.size], [250, 80]);
t.equal('...of the receipt kind', receipts[0].kind, VALUE_PLAYBACK_RECEIPT_KIND);

const summaries = (relay) => [...relay.events.values()].filter((e) => e.kind === VALUE_PLAYBACK_SUMMARY_KIND);
const countOf = (e) => Number(e?.tags.find((x) => x[0] === 'count')?.[1]);
const args = { id: ID, idKind: 'podcast:guid', pubkey: pk, relays: [A, B], label: 'e2e' };

// ---------------------------------------------------------------------------
console.log('\n1. Every receipt is counted, past both relays\' caps');
// ---------------------------------------------------------------------------
await updateValuePlaybackSummary(args);
const first = summaries(relayA)[0];
t.equal('a summary is published', !!first, true);
t.equal('...counting all 250 receipts (the old walk counted 180)', countOf(first), 250);
t.equal('...to B too', countOf(summaries(relayB)[0]), 250);

// ---------------------------------------------------------------------------
console.log('\n2. A cycle aborted while it waits on the signer publishes nothing');
// ---------------------------------------------------------------------------
// Finding 17b: the flush's timeout used to stop only the WAITING, so a cycle
// stuck on a signer could still publish when the signer came back — beside a
// second cycle for the same address, or after a sign-out. A new receipt makes
// the cycle want to publish (251 > 250); the signer is held, the cycle is
// aborted while it waits, and then the signer answers.
const extra = finalizeEvent({
  ...buildValuePlaybackReceipt({ feedGuid: FEED, msat: 1000, action: 'stream', startSec: T0 + 250 * 60, endSec: T0 + 251 * 60 }),
  created_at: T0 + 251 * 60,
}, sk);
relayA.events.set(extra.id, extra);
await nextSecond(); // a wrong publish must be able to replace section 1's
let release;
const asked = new Promise((r) => {
  hold = { asked: r, released: new Promise((go) => { release = go; }) };
});
const stop = new AbortController();
const cycle = updateValuePlaybackSummary(args, stop.signal);
await asked;
stop.abort();
release();
await cycle;
await new Promise((r) => setTimeout(r, 300));
t.equal('the cycle reached the signer before the abort', hold, null);
t.equal('...and the signature that came back after it was never published', countOf(summaries(relayA)[0]), 250);
t.equal('...on either relay', countOf(summaries(relayB)[0]), 250);

// Aborted before it starts, as a sign-out does, it never asks at all.
const signsBefore = signs;
const early = new AbortController();
early.abort();
await updateValuePlaybackSummary(args, early.signal);
t.equal('a cycle aborted before it starts asks the signer nothing', signs - signsBefore, 0);

// The same cycle, not aborted, publishes the new receipt: the silence above
// was the abort, not a broken cycle.
await updateValuePlaybackSummary(args);
t.equal('without the abort, the next cycle publishes 251', countOf(summaries(relayA)[0]), 251);

// ---------------------------------------------------------------------------
console.log('\n3. A relay that stops answering publishes nothing');
// ---------------------------------------------------------------------------
// C accepts the socket and never answers a REQ. A total that leaves it out is
// a partial sum, so the cycle must refuse rather than publish.
const { WebSocketServer } = await import('ws');
const silent = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => silent.once('listening', r));
silent.on('connection', (ws) => ws.on('message', () => {}));
const C = `ws://127.0.0.1:${silent.address().port}`;
const another = finalizeEvent({
  ...buildValuePlaybackReceipt({ feedGuid: FEED, msat: 1000, action: 'stream', startSec: T0 + 251 * 60, endSec: T0 + 252 * 60 }),
  created_at: T0 + 252 * 60,
}, sk);
relayA.events.set(another.id, another);
await nextSecond();
const signsBeforeSilent = signs;
await updateValuePlaybackSummary({ ...args, relays: [A, B, C] });
t.equal('a silent relay in the set: nothing signed', signs - signsBeforeSilent, 0);
t.equal('...and the stored summary is unchanged', countOf(summaries(relayA)[0]), 251);

t.equal('every socket this run opened went to this machine',
  relayGuard.opened.length > 0 && relayGuard.opened.every((u) => u.startsWith('ws://127.0.0.1:')), true);

relayA.close?.(); relayB.close?.(); silent.close();
if (t.fails) {
  console.error(`\nVP SUMMARY E2E FAILED (${t.fails})`);
  process.exit(1);
}
console.log('\nVP SUMMARY E2E OK');
process.exit(0);
