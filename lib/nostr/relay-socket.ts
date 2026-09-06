import { Relay } from 'nostr-tools';

// Closes the WebSocket that nostr-tools 2.19.4 leaves behind when a relay
// connect fails. Upstream nbd-wtf/nostr-tools#550; fixed there in 2.25.2, which
// we cannot take — 2.20.0+ still carries the `limit: 0` NIP-46 subscription
// filters that break `nostrconnect://` pairing, so the pin stays and the fix
// comes here instead. See docs/nostr.md ("The leaked relay socket").
//
// Two distinct holes in the pinned build, both verified against
// `node_modules/nostr-tools/lib/esm/abstract-relay.js`:
//
//   connect()  On the connection timeout it rejects, clears `connectionPromise`
//              and closes every subscription — and never touches `this.ws`,
//              which is still CONNECTING. Same on the `onerror` branch, which
//              routes to `handleHardClose` and that does not touch it either.
//
//   close()    Guarded on `readyState === OPEN`, so an explicit close cannot
//              reclaim a socket that never finished connecting. This is the
//              half the upstream issue does not mention and the one that costs
//              us most: `withExtraRelays` (pool.ts) closes its one-off extras
//              precisely so they do not accumulate, and for a dead extra that
//              close is a no-op. 2.15.0 closed unconditionally, so this is a
//              regression the pin froze us onto.
//
// A CONNECTING socket is not garbage — the browser holds it until the handshake
// resolves, and it counts against the per-renderer WebSocket budget. In a tab
// left open for a day, every dead relay in every scan spends one more slot;
// past the cap, new sockets are refused and feeds hang and publishes silently
// reach nobody.

/** The part of a WebSocket the reclaim touches. Structural on purpose: the
 *  check script drives it with a fake, and `lib/nostr/` has no DOM lib. */
export type ReclaimableSocket = {
  readyState: number;
  close: () => void;
  onopen?: unknown;
  onerror?: unknown;
  onclose?: unknown;
};

// The numeric `readyState` values, written out rather than read off the
// constructor. `AbstractRelay` compares against `this._WebSocket.OPEN`, which
// is whatever implementation was injected; these four are fixed by the WHATWG
// spec and every implementation that calls itself a WebSocket agrees.
export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSING = 2;
export const SOCKET_CLOSED = 3;

/**
 * Close `ws` unless it is already closing or closed. Returns whether it called
 * `close()`.
 *
 * Detaching the handlers first is not tidying. Closing a CONNECTING socket
 * fires its `onclose`, which in the pinned build re-enters `handleHardClose` →
 * the relay's own `onclose` → `SimplePool`'s map delete, on a relay that has
 * already been torn down once. Nothing there is unsafe to run twice, but a
 * second teardown is a second chance to be wrong, and 2.25.2 detaches in its
 * own `close()` for the same reason.
 *
 * The already-closing case returns BEFORE detaching. A socket the library
 * closed itself is mid-handshake with its own `onclose` still to come, and that
 * one it is entitled to see.
 */
export function reclaimSocket(ws: ReclaimableSocket | null | undefined): boolean {
  if (!ws) return false;
  if (ws.readyState === SOCKET_CLOSING || ws.readyState === SOCKET_CLOSED) return false;
  ws.onopen = null;
  ws.onerror = null;
  ws.onclose = null;
  try {
    ws.close();
  } catch {
    // A socket that throws on close is already gone; nothing left to reclaim.
    return false;
  }
  return true;
}

/** The slice of `AbstractRelay` this patches. */
type RelayInternals = {
  ws?: ReclaimableSocket | null;
  connect: (...args: unknown[]) => Promise<void>;
  close: () => void;
};

let installed = false;

/**
 * Patch the leak onto the class every pool in this app actually builds.
 * Idempotent; returns whether this call was the one that installed it.
 *
 * THE HANDLE IS `Object.getPrototypeOf(Relay.prototype)` AND IT HAS TO BE.
 * `nostr-tools/lib/esm/index.js` is a bundle carrying its OWN copy of
 * `AbstractRelay`, and the `nostr-tools/abstract-relay` subpath is a second
 * module with a second copy. `SimplePool` — imported from the root, like
 * everything here — instantiates the bundled one, so patching the subpath's
 * class type-checks, runs, and silently does nothing. The root does not export
 * `AbstractRelay` at all; `Relay` is exported and `extends` it, so its
 * prototype's prototype is the object those pool relays inherit from.
 * `scripts/check-relay-socket.mjs` asserts the patch fires through a real
 * `SimplePool.ensureRelay`, which is the only way that claim stays true.
 */
export function installRelaySocketFix(): boolean {
  if (installed) return false;
  installed = true;

  const proto = Object.getPrototypeOf(Relay.prototype) as RelayInternals;
  const origConnect = proto.connect;
  const origClose = proto.close;

  proto.connect = function connect(this: RelayInternals, ...args: unknown[]): Promise<void> {
    // The rejection is re-thrown unchanged — callers read the reason (`pool.ts`
    // counts them, `relay-health.ts` scores them), and this only reclaims the
    // socket the library dropped. The `.catch` also means the memoized
    // `connectionPromise` always has a handler, so a connect nobody awaited
    // cannot surface as an unhandled rejection.
    return origConnect.apply(this, args).catch((err: unknown) => {
      reclaimSocket(this.ws);
      throw err;
    });
  };

  proto.close = function close(this: RelayInternals): void {
    origClose.call(this);
    // Only a CONNECTING socket is still open here: the library already closed
    // an OPEN one, leaving it CLOSING, which `reclaimSocket` declines.
    reclaimSocket(this.ws);
  };

  return true;
}
