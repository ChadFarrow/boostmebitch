// A refcounted lease over ONE expensive resource, closed once nothing holds it.
//
// DELIBERATELY IMPORT-FREE, so `scripts/check-lease.mjs` can load the real thing
// under `node --experimental-strip-types` rather than a copy. Its only consumer
// is `nwc.ts`, which cannot be loaded that way (it imports `../storage`), so
// extracting the state machine is the only way to pin it at all.
//
// It exists for the NIP-47 client. Alby's relay — Cloudflare in front of it —
// rate-limits how many WebSocket connections you OPEN, not how many you hold: a
// HAR of three boosts showed 28 dials in 83 seconds, 19 upgrades, then
// `429 Too Many Requests` with `Retry-After: 600`, after which no payment can be
// published at all. Sharing one connection is the fix; this is the sharing.
//
// The refcount is the part worth pinning, because every way it goes wrong is
// silent and lands on the money path:
//
//   - a double `release` (callers run it from a `finally`) drops refs below zero
//     and closes the socket underneath whoever still holds it — a payment in
//     flight dies for no visible reason;
//   - a `release` or `discard` arriving from a STALE lease, after the pool has
//     already moved on to a new resource, must not touch the new one — that is
//     the same failure with a longer fuse;
//   - a missed cancel of the idle timer closes a resource that has just been
//     re-acquired;
//   - a `discard` (the socket looks bad) that closes the resource while ANOTHER
//     holder is mid-request: that request dies with a plain socket error, which
//     for a payment reads as "failed" when it may have been paid.

/** Injectable so a test can drive the idle timer without real time passing. */
export interface Scheduler {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Lease<T> {
  value: T;
  /** Give the lease back. Idempotent — safe to call from a `finally`. */
  release: () => void;
  /** Drop the underlying resource now, so the next acquire builds a fresh one. */
  discard: () => void;
}

export interface LeasePool<T> {
  /**
   * Take a lease. Re-uses the live resource when `key` matches; a different key
   * disposes the old one first, because a shared resource outliving the identity
   * it was built for is worse than an extra dial.
   */
  acquire: (key: string) => Lease<T>;
  /** Close the resource now, whoever holds it. */
  dispose: () => void;
  /** Observability, and what the check script asserts against. */
  stats: () => { open: boolean; refs: number; key: string | null; creates: number };
}

export function createLeasePool<T>(opts: {
  create: (key: string) => T;
  close: (value: T) => void;
  idleMs: number;
  scheduler?: Scheduler;
}): LeasePool<T> {
  const timers = opts.scheduler ?? defaultScheduler;

  interface Live { value: T; key: string; refs: number; idle: unknown | null; closed: boolean }
  let live: Live | null = null;
  let creates = 0;

  // Close one resource, once. `close` can throw, and a resource can be reached
  // from more than one place (the pool, a retired holder's last release).
  const closeResource = (dying: Live) => {
    if (dying.closed) return;
    dying.closed = true;
    if (dying.idle !== null) { timers.clear(dying.idle); dying.idle = null; }
    try { opts.close(dying.value); } catch { /* already closed / never opened */ }
  };

  const closeNow = () => {
    if (!live) return;
    const dying = live;
    // Clear the field FIRST. `close` can throw, and every release/discard
    // compares against `live` by identity — leaving it set while closing would
    // let a stale handle believe it still owns the current resource.
    live = null;
    closeResource(dying);
  };

  return {
    acquire(key) {
      if (live && live.key !== key) closeNow();
      if (!live) {
        creates += 1;
        live = { value: opts.create(key), key, refs: 0, idle: null, closed: false };
      }
      const held = live;
      // Re-acquired inside the idle window: cancel the pending close, or it
      // fires against a resource that is now in use again.
      if (held.idle !== null) { timers.clear(held.idle); held.idle = null; }
      held.refs += 1;

      let spent = false;
      return {
        value: held.value,
        release() {
          if (spent) return;          // idempotent
          spent = true;
          if (held.closed) return;    // the pool already closed it: nothing to count
          held.refs -= 1;
          if (held.refs > 0) return;
          if (held !== live) {
            // RETIRED by a `discard` while others still held it: this was the
            // last holder, so the socket it kept alive can go now.
            closeResource(held);
            return;
          }
          held.idle = timers.set(() => {
            // Re-check: it may have been re-acquired or disposed since.
            if (held === live && held.refs <= 0) closeNow();
          }, opts.idleMs);
        },
        discard() {
          if (held !== live) return;  // stale: never close someone else's
          if (!spent) { spent = true; held.refs -= 1; }
          if (held.refs <= 0) { closeNow(); return; }
          // Others still hold it, and one of them may be a PAYMENT waiting for
          // its answer on this very socket: closing now kills that request with
          // a plain socket error, which reads as "failed" for a payment that may
          // have gone through. Stop handing the resource out (the next acquire
          // builds a fresh one) and let the last holder close it.
          live = null;
          if (held.idle !== null) { timers.clear(held.idle); held.idle = null; }
        },
      };
    },
    dispose: closeNow,
    stats: () => ({
      open: live !== null,
      refs: live?.refs ?? 0,
      key: live?.key ?? null,
      creates,
    }),
  };
}
