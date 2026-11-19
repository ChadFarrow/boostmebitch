// A WebSocket that opens to THIS MACHINE only. Import it FIRST, before
// anything that imports nostr-tools, and nothing in the process can open a
// socket to a public relay.
//
// Usage, as the first import of a script:
//   import { relayGuard } from './no-public-relays.mjs';
//
// WHY IT EXISTS. On 2026-11-17 nine runs of e2e:mentions put 117 test boost
// notes on relay.primal.net and relay.fountain.fm, under one-time keys nobody
// holds, so they can never be deleted (lib/nostr/test-boost-notes.ts). That
// script checked isolation instead of enforcing it: it probed the public relays,
// skipped the one section it believed published to them, and was wrong about
// which sections did. A guard that knows the rule needs no list of sections.
//
// WHY IT WORKS WHERE AN EARLIER ONE DID NOT. e2e:mentions once tried to swap
// the socket after its imports, and nothing reached the constructor: static
// imports are hoisted, so nostr-tools had already read the global `WebSocket`
// when its module evaluated (`var _WebSocket = WebSocket` in its pool), and
// every SimplePool after that was built with the real one. ES modules evaluate
// their static imports in source order, so a module imported FIRST runs before
// nostr-tools loads, and this one replaces the global then. nostr-tools'
// AbstractRelay also falls back to the global at construction, which this
// covers too.
//
// AND IT MUST PROVE IT. A guard that is not in the path records nothing and
// looks exactly like a guard with nothing to block — the failure the earlier
// attempt had. `relayGuard.opened` counts every socket the guard let through,
// so a script can assert that its local publishes went through it, and
// `expectRefusal(url, fn)` lets a script aim the SHIPPING publish path at a
// public-looking URL and confirm the guard refused it, before the run starts.
// Use an `.invalid` host for that (RFC 2606): if the guard were not in the
// path, the connection would still fail on DNS and carry nothing.
//
// ANY OTHER refused socket ends the process at once, exit 1, with the URL —
// before a byte is sent. A refusal is a broken test, never a skipped one.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export const relayGuard = {
  /** Every socket URL the guard let through, in order. */
  opened: [],
  /** Every socket URL the guard refused, in order. */
  refused: [],
  /** The one HOST a self-test may aim at without ending the process. A host,
   *  not a URL: nostr-tools normalizes a relay URL before it opens it. */
  expectedHost: null,
};

const Real = globalThis.WebSocket;
if (typeof Real !== 'function') {
  console.error('no-public-relays: this Node has no global WebSocket to guard (Node 22 or newer has one).');
  process.exit(1);
}

function parse(url) {
  try { return new URL(url); } catch { return null; }
}

function isLocal(url) {
  const u = parse(url);
  return !!u && (u.protocol === 'ws:' || u.protocol === 'wss:') && LOOPBACK.has(u.hostname);
}

class LocalOnlyWebSocket extends Real {
  constructor(url, protocols) {
    const href = String(url);
    if (!isLocal(href)) {
      relayGuard.refused.push(href);
      if (!relayGuard.expectedHost || parse(href)?.hostname !== relayGuard.expectedHost) {
        console.error(`\n  REFUSED: something tried to open ${href}.`);
        console.error('  Only a relay on this machine may be used here. Nothing was sent; the run stops.');
        process.exit(1);
      }
      throw new Error(`no-public-relays: refused ${href}`);
    }
    super(url, protocols);
    relayGuard.opened.push(href);
  }
}

globalThis.WebSocket = LocalOnlyWebSocket;

/**
 * Run `fn` with `url` allowed to be refused without ending the process, and
 * answer whether the guard refused it. `fn` should aim the shipping code at
 * `url`; `true` means the guard sits in front of that code's sockets.
 */
export async function expectRefusal(url, fn) {
  const host = parse(url)?.hostname;
  if (!host || LOOPBACK.has(host)) throw new Error(`expectRefusal needs a non-local relay URL, got ${url}`);
  const before = relayGuard.refused.length;
  relayGuard.expectedHost = host;
  try {
    await fn();
  } catch {
    // The refusal surfaces as a failed publish, which is the point.
  } finally {
    relayGuard.expectedHost = null;
  }
  return relayGuard.refused.slice(before).some((u) => parse(u)?.hostname === host);
}
