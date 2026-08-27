// A throwaway Nostr relay that speaks just enough NIP-01 to exercise this app
// against nothing but this machine.
//
// Usage:
//   npm run relay              # ws://127.0.0.1:7447
//   npm run relay -- --port 8000 --verbose
//
// WHY THIS EXISTS. "Testing locally" and "testing against local data" are
// different things, and the gap is the whole hazard here: a dev server on
// localhost still publishes to damus.io / primal.net / nos.lol under your real
// npub, to the kind:10333 event StableKraft shares. A replaceable event has no
// history and no undo, so a bug found that way is found in production, on
// someone else's device too.
//
// Point the app here with `bmb:relays` (which REPLACES the defaults rather than
// joining them) and nothing leaves the machine:
//
//   localStorage.setItem('bmb:relays', JSON.stringify(['ws://127.0.0.1:7447']))
//
// It is in-memory only: restart it and every event is gone, which is a feature
// — "what happens on a device that has never seen this list" is one of the
// states worth testing, and here it is one Ctrl-C away.
//
// Replaceable-event semantics ARE implemented (kinds 0, 3, 10000-19999 and
// parameterized 30000-39999), because that is the behaviour under test: the
// whole favorites feature turns on one event replacing another.
//
// `createRelay` is exported so `e2e-favorites.mjs` runs against THIS relay
// rather than a second copy of it. That matters more than it looks: the e2e
// asserts on replacement — one publish superseding another is the entire
// mechanism the favorites feature rests on — so a reimplemented relay in the
// test would let the test and the tool a human runs by hand drift apart, and
// the test would keep passing while proving something else. Same reason
// `check:favsync` imports the shipping module instead of a copy.

import { WebSocketServer } from 'ws';

const isReplaceable = (k) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
const isAddressable = (k) => k >= 30000 && k < 40000;
const dTagOf = (e) => e.tags.find((t) => t[0] === 'd')?.[1] ?? '';

/** The coordinate a replaceable event occupies, or null if it holds none. */
function slotOf(e) {
  if (isReplaceable(e.kind)) return `${e.kind}:${e.pubkey}`;
  if (isAddressable(e.kind)) return `${e.kind}:${e.pubkey}:${dTagOf(e)}`;
  return null;
}

function matches(filter, e) {
  if (filter.ids && !filter.ids.includes(e.id)) return false;
  if (filter.kinds && !filter.kinds.includes(e.kind)) return false;
  if (filter.authors && !filter.authors.includes(e.pubkey)) return false;
  if (filter.since && e.created_at < filter.since) return false;
  if (filter.until && e.created_at > filter.until) return false;
  for (const [key, want] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue;
    const letter = key.slice(1);
    const have = e.tags.filter((t) => t[0] === letter).map((t) => t[1]);
    if (!want.some((v) => have.includes(v))) return false;
  }
  return true;
}

/**
 * Start the relay. Returns `{ events, close }` — `events` is the live id→event
 * map, so a caller can seed it directly instead of dialling itself.
 *
 * `onEvent(e)` fires for every accepted EVENT and `onReq(filters, hits)` for
 * every REQ, which is how a test builds a timeline without parsing log lines.
 * `log` defaults to `console.log` for the CLI and is passed `null` by the e2e,
 * whose own output is the report.
 */
export function createRelay({ port = 7447, host = '127.0.0.1', onEvent, onReq, log = console.log, verbose = false } = {}) {
  /** id -> event */
  const events = new Map();
  const say = log ?? (() => {});
  const wss = new WebSocketServer({ host, port });

  /** Open subscriptions: ws -> Map(subId -> filters). */
  const subs = new Map();

  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('close', () => subs.delete(ws));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!Array.isArray(msg)) return;
      const [verb] = msg;

      if (verb === 'EVENT') {
        const e = msg[1];
        if (!e?.id || !e?.pubkey) return;
        // Deliberately NOT verifying the signature. This is a test fixture, not
        // a relay, and a signature check here would only ever fail for a reason
        // that has nothing to do with what is being tested. It cannot become an
        // injection path either: SimplePool verifies every relay-fetched event
        // client-side, so a forged one is dropped before the app's merge sees it.
        const slot = slotOf(e);
        if (slot) {
          for (const [id, prev] of events) {
            if (slotOf(prev) !== slot) continue;
            // NIP-01: the newer created_at wins; ties break on the lower id.
            if (prev.created_at > e.created_at
              || (prev.created_at === e.created_at && prev.id < e.id)) {
              ws.send(JSON.stringify(['OK', e.id, false, 'replaced: a newer version is stored']));
              return;
            }
            events.delete(id);
          }
        }
        events.set(e.id, e);
        ws.send(JSON.stringify(['OK', e.id, true, '']));
        // LIVE PUSH. NIP-01 says a relay sends matching NEW events to every open
        // subscription, and without it this fixture only ever answers what it
        // already held when the REQ arrived.
        //
        // That is invisible to a test that reloads the page to see a result —
        // which is what e2e-favorites.mjs does — and fatal to anything
        // request/response, because the reply is published AFTER the requester
        // subscribed. NIP-46 is entirely that shape: a bunker session could not
        // complete a single call against this relay, and the symptom was a
        // connect that simply never resolved.
        for (const [sock, forSock] of subs) {
          if (sock === ws || sock.readyState !== sock.OPEN) continue;
          for (const [sub, filters] of forSock) {
            if (filters.some((f) => matches(f, e))) sock.send(JSON.stringify(['EVENT', sub, e]));
          }
        }
        onEvent?.(e);
        const priv = typeof e.content === 'string' && e.content.length ? ` content=${e.content.length}B` : '';
        say(`  EVENT  kind ${e.kind}  ${e.tags.length} tags${priv}  ${e.id.slice(0, 8)}  (${events.size} stored)`);
        if (verbose) say(`         ${JSON.stringify(e.tags)}`);
        return;
      }

      if (verb === 'REQ') {
        const sub = msg[1];
        const filters = msg.slice(2);
        const hits = [...events.values()]
          .filter((e) => filters.some((f) => matches(f, e)))
          .sort((a, b) => b.created_at - a.created_at);
        for (const e of hits) ws.send(JSON.stringify(['EVENT', sub, e]));
        ws.send(JSON.stringify(['EOSE', sub]));
        // Registered AFTER the stored hits and the EOSE, so the subscription
        // carries on receiving whatever arrives next.
        subs.get(ws)?.set(sub, filters);
        onReq?.(filters, hits);
        say(`  REQ    ${JSON.stringify(filters.map((f) => ({ kinds: f.kinds, authors: f.authors?.map((a) => a.slice(0, 8)) })))} -> ${hits.length}`);
        return;
      }

      if (verb === 'CLOSE') {
        subs.get(ws)?.delete(msg[1]);
        ws.send(JSON.stringify(['CLOSED', msg[1], '']));
      }
    });
  });

  return { events, close: () => wss.close() };
}

// --- CLI ---------------------------------------------------------------------
// `npm run relay`. Guarded so importing this module starts nothing.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const port = Number(arg('port', 7447));
  createRelay({ port, verbose: argv.includes('--verbose') });
  console.log(`local relay listening on ws://127.0.0.1:${port}  (in-memory; Ctrl-C forgets everything)`);
  console.log('point the app at it from the browser console:');
  console.log(`  localStorage.setItem('bmb:relays', JSON.stringify(['ws://127.0.0.1:${port}']))`);
  console.log('and back to the real ones with:');
  console.log("  localStorage.removeItem('bmb:relays')\n");
}
