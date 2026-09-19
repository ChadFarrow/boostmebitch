// The rejections nostr-tools creates INSIDE a relay, where no caller ever holds
// the promise — and the one process-level handler that stops them ending the
// process. Import-free so verify/check-rejections.mjs loads this exact module.
//
// Node's default for an unhandled rejection is to throw, so each of these was a
// crash. Seven between 2026-09-03 and 2026-09-18, every one in the library:
//
//   4× SendingOnClosedConnection: Tried to send message '["CLOSE","forced-ping:…"]
//      on a closed connection to wss://relay.damus.io/
//   2× "connection timed out"
//   1× "Received network error or non-101 status code."
//
// Neither shape can be caught where it starts. `AbstractRelay.send()` is async
// and THROWS when the connection promise is gone, so the try/catch around it in
// `Subscription.close()` never sees the rejection. And while a connection is
// still pending, `send()` hangs `connectionPromise.then(...)` off it with no
// catch, so a connect that then times out rejects a promise nobody has.
// `verify/check-rejections.mjs` reproduces both against the shipping library.
//
// A crash is not a clean recovery either. Railway restarts the process, which
// re-downloads every subscription's history from every relay, and spends one of
// `restartPolicyMaxRetries`: running out of those is how #301 became a
// three-day outage. Left alone, the relay recovers on its own — the ping times
// out, the socket closes, and reconnect re-fires the subscriptions — and the
// watchdog in `Indexer.checkConnectivity` covers the case where it does not.

/**
 * Is this rejection one nostr-tools made inside a relay?
 *
 *  - A bare STRING. `AbstractRelay.connect()` rejects with one in every branch
 *    (`"connection timed out"`, `ev.message || "websocket error"`,
 *    `ev.message || "websocket closed"`). Nothing else in this process rejects
 *    with a string: our code, pg and fastify all reject with an Error.
 *  - A `SendingOnClosedConnection`, matched by NAME rather than `instanceof`,
 *    so a second copy of the library cannot defeat it.
 *
 * Deliberately NOT a match on message text. "timeout exceeded when trying to
 * connect" is pg's, and a database rejection that escapes its loop is a bug in
 * this service, which must stay loud and fatal.
 */
export function isRelayLibraryRejection(reason: unknown): boolean {
  if (typeof reason === 'string') return true;
  return reason instanceof Error && reason.name === 'SendingOnClosedConnection';
}

let installed = false;

/**
 * Install once, before any relay opens. A relay-library rejection is logged
 * and survived; anything else ends the process with exit code 1, as Node's
 * default would.
 */
export function guardRelayRejections(): void {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => {
    if (isRelayLibraryRejection(reason)) {
      const what = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
      console.warn(`[index] nostr-tools rejected with no handler (not fatal): ${what}`);
      return;
    }
    console.error('[index] unhandled rejection, exiting:', reason);
    process.exit(1);
  });
}
