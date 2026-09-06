// Pins the reclaim of a relay WebSocket the pinned nostr-tools drops.
//
// Usage:
//   npm run check:relaysocket
//
// Run it after ANY edit to lib/nostr/relay-socket.ts, and after ANY change to
// the `nostr-tools` version in package.json.
//
// Why this earns a check script
// -----------------------------
// nostr-tools is pinned to exact 2.19.4 and cannot move: 2.20.0+ added
// `limit: 0` to the NIP-46 subscription filters, which breaks `nostrconnect://`
// pairing, and 2.25.2 — the release that fixes this leak upstream
// (nbd-wtf/nostr-tools#550) — still carries it. So the leak is fixed here, in
// our own code, against a dependency that will not be updated out from under
// it. That is a monkey patch on a library prototype, and it fails SILENTLY in
// two different ways:
//
//   1. THE WRONG CLASS. `nostr-tools/lib/esm/index.js` is a bundle carrying its
//      own copy of `AbstractRelay`; `nostr-tools/abstract-relay` is a second
//      module with a second copy. `SimplePool` comes from the root and builds
//      the bundled one. Patch the subpath's class and everything type-checks,
//      lints, builds and does nothing at all. The root does not export
//      `AbstractRelay`, so the handle is `Object.getPrototypeOf(Relay.prototype)`
//      — and the ONLY way to keep that claim honest is to drive a real
//      `SimplePool.ensureRelay` and watch the socket close, which is what the
//      integration section below does.
//
//   2. THE WRONG VERSION. A future bump changes the shape this wraps. 2.25.2
//      already moved `connectionTimeout` out of the constructor and into a
//      `connect(opts)` argument, so a build that ships no timeout by default
//      would never take the branch this exists for. The integration section
//      fails loudly if the patch stops firing.
//
// The leak itself, verified against node_modules/nostr-tools/lib/esm/abstract-relay.js:
//
//   connect()  the connection-timeout branch rejects, clears `connectionPromise`
//              and closes every subscription, and never touches `this.ws`. It is
//              left CONNECTING. The `onerror` branch routes to `handleHardClose`,
//              which does not touch it either.
//   close()    guarded on `readyState === OPEN`, so an explicit close cannot
//              reclaim a socket that never connected. 2.15.0 closed
//              unconditionally; this is a regression the pin froze us onto, it
//              is not in the upstream issue, and it is the half that defeats
//              `withExtraRelays` — whose whole job is to close its one-off
//              extras so they do not accumulate.
//
// A CONNECTING socket is held by the browser until the handshake resolves and
// counts against the per-renderer WebSocket budget. Past the cap, sockets stop
// opening: feeds hang and publishes reach nobody, with nothing in the console.
//
// The vectors and the replay
// --------------------------
// Vectors are recorded as calls (`{ kind, args }`) and the whole list is
// replayed against BOTH wrong implementations below, so a vector cannot be
// added without being proved against something. The two naives are different
// mistakes and a vector is exempted from each one separately, by name:
//
//   pinnedClose      what 2.19.4 already does — close only a socket that
//                    reached OPEN. This is the bug. It gets the already-closed
//                    cases right, because declining to act is right there.
//   uncheckedClose   what someone writes porting the upstream fix in a hurry:
//                    call `ws.close()` and move on. It reclaims the CONNECTING
//                    socket, so it looks like a fix, and it re-enters a
//                    teardown that already ran and slams a socket the library
//                    is still closing.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module.
// `pool.ts` cannot be loaded that way — it imports `./relay-socket`, an
// extensionless relative specifier Node's resolver rejects — which is why the
// logic lives in `relay-socket.ts` behind a bare npm import and `newPool()` in
// pool.ts is a two-line wrapper. Keep it that way.

import { SimplePool } from 'nostr-tools';
import {
  installRelaySocketFix,
  reclaimSocket,
  SOCKET_CLOSED,
  SOCKET_CLOSING,
  SOCKET_CONNECTING,
  SOCKET_OPEN,
} from '../lib/nostr/relay-socket.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failures = 0;

/** Every recorded call, replayed against the wrong implementations below. */
const vectors = [];

function compare(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
}

function section(name) {
  console.log(`\n${name}`);
}

/**
 * A socket in a given `readyState`, with every handler attached — which is the
 * state the library leaves one in. `close()` notifies `onclose` the way a real
 * WebSocket does, so a reclaim that forgets to detach first is visible as a
 * re-entrant teardown rather than as nothing at all.
 */
function makeSocket(readyState) {
  const ws = {
    readyState,
    closeCalls: 0,
    reentered: 0,
    onopen: () => {},
    onerror: () => {},
    onclose: () => {},
    close() {
      this.closeCalls += 1;
      this.readyState = SOCKET_CLOSED;
      if (this.onclose) {
        this.reentered += 1;
        this.onclose({ message: 'closed' });
      }
    },
  };
  return ws;
}

/** What the reclaim is asked to guarantee, in the terms the leak is about. */
function outcome(ws, returned) {
  if (!ws) return { returned, socket: 'none' };
  return {
    returned,
    closeCalls: ws.closeCalls,
    detached: ws.onopen === null && ws.onerror === null && ws.onclose === null,
    reentered: ws.reentered,
    readyState: ws.readyState,
  };
}

/** A reclaimSocket vector. `exempt` names the naives allowed to agree. */
function checkReclaim(label, state, expected, { exempt = [] } = {}) {
  const ws = state === null ? null : makeSocket(state);
  const returned = reclaimSocket(ws);
  compare(label, outcome(ws, returned), expected);
  vectors.push({ label, kind: 'reclaim', args: [state], exempt });
}

// ---------------------------------------------------------------------------
section('A socket that never finished connecting is reclaimed');
// ---------------------------------------------------------------------------
{
  // THE LEAK. Every failed relay connect in the pinned build lands here: the
  // library rejected, tore down its subscriptions, and walked away from a
  // socket the browser is still holding.
  checkReclaim('CONNECTING is closed, handlers detached first', SOCKET_CONNECTING, {
    returned: true,
    closeCalls: 1,
    detached: true,
    // Detaching before closing is what keeps this 0. Closing a CONNECTING
    // socket fires its onclose, which re-enters handleHardClose on a relay that
    // has already been torn down once.
    reentered: 0,
    readyState: SOCKET_CLOSED,
  });

  // An open socket is closed too. Nothing in the connect path can reach here —
  // a rejected connect never had an OPEN socket — so this is the reclaim being
  // a reclaim rather than a special case, and it must not regress into one.
  checkReclaim('OPEN is closed, handlers detached first', SOCKET_OPEN, {
    returned: true,
    closeCalls: 1,
    detached: true,
    reentered: 0,
    readyState: SOCKET_CLOSED,
  });
}

// ---------------------------------------------------------------------------
section('A socket already going away is left entirely alone');
// ---------------------------------------------------------------------------
{
  // The `close()` wrapper runs after the library's own close(), which for an
  // OPEN socket has already called close() and left it CLOSING. Touching it
  // again would double-close it and, worse, detach the onclose it is still
  // owed — the library is entitled to see that one.
  checkReclaim('CLOSING is not touched', SOCKET_CLOSING, {
    returned: false,
    closeCalls: 0,
    detached: false,
    reentered: 0,
    readyState: SOCKET_CLOSING,
  }, { exempt: ['pinnedClose'] });

  // The connect path reaches this on the `onclose` rejection: the socket closed
  // itself, there is nothing to reclaim, and the reclaim must be a no-op rather
  // than an error.
  checkReclaim('CLOSED is not touched', SOCKET_CLOSED, {
    returned: false,
    closeCalls: 0,
    detached: false,
    reentered: 0,
    readyState: SOCKET_CLOSED,
  }, { exempt: ['pinnedClose'] });

  // `this.ws` is undefined when the WebSocket constructor itself threw — the
  // one connect rejection that never made a socket at all.
  checkReclaim('no socket at all', null, { returned: false, socket: 'none' }, {
    exempt: ['pinnedClose', 'uncheckedClose'],
  });
}

// ---------------------------------------------------------------------------
section('Every vector above is replayed against the obvious wrong implementations');
// ---------------------------------------------------------------------------
{
  // The pinned build's own close(): act only on a socket that reached OPEN.
  // This IS the bug — it declines the one case the reclaim exists for.
  const pinnedClose = (ws) => {
    if (!ws) return false;
    if (ws.readyState !== SOCKET_OPEN) return false;
    ws.close();
    return true;
  };

  // The upstream fix, ported without reading it: close the socket, done. It
  // reclaims the CONNECTING socket — so it passes the headline case and looks
  // finished — while re-entering a teardown that already ran and closing a
  // socket the library is mid-way through closing itself.
  const uncheckedClose = (ws) => {
    if (!ws) return false;
    ws.close();
    return true;
  };

  const naives = { pinnedClose, uncheckedClose };

  const call = (impl, v) => {
    const ws = v.args[0] === null ? null : makeSocket(v.args[0]);
    try {
      const returned = impl === 'real' ? reclaimSocket(ws) : naives[impl](ws);
      return JSON.stringify(outcome(ws, returned));
      // A wrong implementation is allowed to throw where the real one returns.
      // That still counts as differing — it is the loudest way to be wrong.
    } catch (e) {
      return `threw ${(e && e.message) || e}`;
    }
  };

  let exempt = 0;
  let proved = 0;
  for (const v of vectors) {
    for (const name of Object.keys(naives)) {
      if (v.exempt.includes(name)) {
        exempt += 1;
        console.log(`  ok    "${v.label}" is must-still-work for ${name}() — it may agree`);
        continue;
      }
      if (call('real', v) !== call(name, v)) {
        proved += 1;
        console.log(`  ok    ${name}() gets "${v.label}" wrong`);
        continue;
      }
      failures += 1;
      console.error(`  FAIL  "${v.label}" passes against ${name}() too — the vector proves nothing.`);
      console.error(`          Either it is must-still-work for that one (add '${name}' to { exempt })`);
      console.error('          or it does not exercise anything the real module adds.');
    }
  }
  console.log(`  ${vectors.length} vector(s) x ${Object.keys(naives).length} naive(s): ${proved} proved, ${exempt} exempt`);
}

// ---------------------------------------------------------------------------
section('The patch reaches the class SimplePool actually builds');
// ---------------------------------------------------------------------------
{
  // A WebSocket that never connects — the dead relay this is all about. The
  // library gets it via `websocketImplementation`, which `SimplePool` fixes to
  // the platform's; `_WebSocket` is the field it hands to each relay it builds,
  // and setting it is how a test drives the real ensureRelay off the network.
  class DeadSocket {
    static CONNECTING = SOCKET_CONNECTING;
    static OPEN = SOCKET_OPEN;
    static CLOSING = SOCKET_CLOSING;
    static CLOSED = SOCKET_CLOSED;
    static made = [];
    constructor(url) {
      this.url = url;
      this.readyState = SOCKET_CONNECTING;
      DeadSocket.made.push(this);
    }
    close() {
      this.readyState = SOCKET_CLOSED;
      if (this.onclose) this.onclose({ message: 'closed' });
    }
  }

  const poolWith = () => {
    const p = new SimplePool();
    p._WebSocket = DeadSocket;
    return p;
  };
  const lastSocket = () => DeadSocket.made[DeadSocket.made.length - 1];

  // BEFORE the fix, so the section proves the leak rather than assuming it.
  // Order matters: the patch is on a shared prototype and cannot be taken back.
  {
    const pool = poolWith();
    await pool.ensureRelay('wss://check-relay-socket.invalid', { connectionTimeout: 30 })
      .then(() => {}, () => {});
    compare(
      'unpatched: a timed-out connect leaves the socket CONNECTING',
      lastSocket().readyState,
      SOCKET_CONNECTING,
    );
  }

  compare('installRelaySocketFix() reports the install', installRelaySocketFix(), true);
  compare('installRelaySocketFix() is idempotent', installRelaySocketFix(), false);

  // AFTER: the same call, through the same public entry point.
  {
    const pool = poolWith();
    await pool.ensureRelay('wss://check-relay-socket-2.invalid', { connectionTimeout: 30 })
      .then(() => {}, () => {});
    compare(
      'patched: a timed-out connect closes the socket',
      lastSocket().readyState,
      SOCKET_CLOSED,
    );
  }

  // The connect rejection still reaches the caller. `relay-health.ts` scores
  // relays on it and `pool.ts` counts them, so swallowing it would degrade a
  // dead relay into a silent one.
  {
    const pool = poolWith();
    let rejected = false;
    await pool.ensureRelay('wss://check-relay-socket-3.invalid', { connectionTimeout: 30 })
      .then(() => {}, () => { rejected = true; });
    compare('patched: the connect still rejects', rejected, true);
  }

  // The close() half, which the upstream issue does not cover: a socket still
  // CONNECTING when the pool closes it. This is `withExtraRelays`' teardown —
  // the one place this app explicitly tries to reclaim a socket, and the place
  // the pinned build's OPEN guard makes a no-op.
  {
    const pool = poolWith();
    // Not awaited: ensureRelay only settles once the connect does, and the
    // point is to close it while it is still in flight. The relay is in the
    // pool's map and the socket constructed by the time this returns.
    const pending = pool.ensureRelay('wss://check-relay-socket-4.invalid', { connectionTimeout: 5000 });
    pending.then(() => {}, () => {});
    const ws = lastSocket();
    compare('a connect in flight really is CONNECTING', ws.readyState, SOCKET_CONNECTING);
    pool.close(['wss://check-relay-socket-4.invalid']);
    compare('patched: pool.close() reclaims a CONNECTING socket', ws.readyState, SOCKET_CLOSED);
  }
}

// ---------------------------------------------------------------------------
section('relay-socket.ts stays loadable under plain Node');
// ---------------------------------------------------------------------------
{
  // The check imports the shipping module rather than a copy, which only works
  // while its imports stay bare-npm. A relative import here — `./pool`, say —
  // makes this script die at load with ERR_MODULE_NOT_FOUND.
  const path = 'lib/nostr/relay-socket.ts';
  const problems = importFreeProblems(path, { allowBare: true });
  if (problems.length) {
    explainImportFree(path, problems);
    failures += problems.length;
  } else {
    console.log(`  ok    ${path} imports only bare npm specifiers`);
  }
}

// ---------------------------------------------------------------------------
console.log('');
if (failures) {
  console.error(`check:relaysocket FAILED with ${failures} problem(s)`);
  process.exit(1);
}
console.log('check:relaysocket passed');
