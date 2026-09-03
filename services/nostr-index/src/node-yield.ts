// Select nostr-tools' Node yield path instead of its browser one.
//
// IMPORT THIS FIRST, BEFORE ANY RELAY WORK. It has no exports on purpose: the
// whole effect is the side effect, and an import with no binding is harder to
// "tidy up" than an unused function call.
//
// ## What it fixes
//
// `AbstractRelay` pumps every incoming relay message through `handleNext()` and
// then `await yieldThread()`. nostr-tools 2.19.4's `yieldThread` is:
//
//     if (typeof MessageChannel !== 'undefined') {
//       const ch = new MessageChannel();
//       ...
//       ch.port1.addEventListener('message', handler);
//       ch.port2.postMessage(0);
//       ch.port1.start();
//     } else if (typeof setImmediate !== 'undefined') {
//       setImmediate(resolve);
//     }
//
// Neither port is ever closed. In Node a `MessagePort` is a native handle and
// `start()` refs it, so it is not collectable — one leaked handle per message
// RECEIVED. The MessageChannel branch is there for browsers, which have no
// `setImmediate`; Node has both, so it takes the browser path by accident and
// pays for it forever. Removing the global selects the branch the library
// already ships for this runtime. Nothing is monkey-patched.
//
// ## Why this was hard to find, so nobody re-derives it
//
// The cost is per message DELIVERED, and the indexer's own `seen` set counts
// distinct event IDS. Relays redeliver the same events on every reconnect and
// every resubscribe, so `seen` grew ~1,200/hour while the leak ran at many
// times that — which is exactly why a curve of `seen` against heap ruled out
// every collection we own and pointed at nothing.
//
// ## Measured, with a control
//
// Shipping `Relay` against a local relay streaming 60,000 messages, forced GC
// before sampling, one process per mode and nothing else different:
//
//     stock        drained=60000  heap +135.9MB  rss +456.9MB  -> 2375 B/msg
//     setImmediate drained=60000  heap +  0.8MB  rss + 81.9MB  ->   15 B/msg
//
// 2,375 B/message against production's message rate is the ~35 MB/hour that
// #301 could not account for after the resubscribe fix. `verify/check-yield.mjs`
// replays that comparison; it is a measurement with a control rather than a
// pure-function pin, because the thing being asserted is a memory property.
//
// ## Why deleting a global is acceptable HERE and would not be in the app
//
// This is a dedicated single-purpose process. Nothing else in its dependency
// tree reads the global: the only other references under `node_modules` are in
// `thread-stream` and `pino-abstract-transport` TEST files, and they take it
// from `require('worker_threads')`, not from `globalThis`. Fastify runs with
// `logger: false`, so those transports never load at all.
//
// The browser build has the same leak and MUST NOT be fixed this way — a page
// has no `setImmediate`, so removing `MessageChannel` there would fall through
// to `resolve()` and turn the yield into a no-op, starving the event loop
// under exactly the burst this is about.
if (typeof globalThis.MessageChannel !== 'undefined' && typeof setImmediate !== 'undefined') {
  delete (globalThis as { MessageChannel?: unknown }).MessageChannel;
}
