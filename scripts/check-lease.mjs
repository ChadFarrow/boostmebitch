// Pins the refcounted lease that lets every NIP-47 call share one WebSocket.
//
// Usage:
//   npm run check:lease
//
// Run it after ANY edit to lib/v4v/lease.ts.
//
// Why this earns a check script: the resource being shared is the connection a
// boost pays over. Alby's relay — Cloudflare in front of it — rate-limits how
// many WebSocket connections you OPEN, so the app dials once and every payment
// leg and balance read rides that one socket. Which means a refcount bug does
// not leak memory, it closes the socket **underneath a payment in flight**, and
// the leg fails for no reason anything on screen can explain.
//
// Every assertion below is a way that goes wrong silently:
//
//   - a double `release` — callers run it from a `finally`, so this is the
//     normal shape, not an abuse — dropping refs below zero and closing while
//     someone still holds it;
//   - a `release` or `discard` arriving from a STALE lease after the pool has
//     moved to a new resource, closing the NEW one: same failure, longer fuse,
//     and the reason `closeNow` clears `live` before calling `close`;
//   - an idle timer that isn't cancelled on re-acquire, firing against a
//     resource that is in use again;
//   - a key change that reuses the old resource, which for NWC means paying
//     from the wallet the user just disconnected.
//
// The scheduler is injected so the idle window is exercised deterministically
// rather than by sleeping — a timing-flaky money-path test would get muted.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module.
// `nwc.ts` itself can't be loaded that way (it imports `../storage`), which is
// precisely why the state machine lives in its own import-free module. Keep
// lease.ts free of imports.

import { createLeasePool } from '../lib/v4v/lease.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
    return true;
  }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
  return false;
}

function section(name) {
  console.log(`\n${name}`);
}

/** A scheduler the test drives by hand. */
function manualScheduler() {
  let next = 1;
  const pending = new Map();
  return {
    scheduler: {
      set: (fn) => { const h = next++; pending.set(h, fn); return h; },
      clear: (h) => { pending.delete(h); },
    },
    /** Fire every timer currently armed. */
    flush() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    armed: () => pending.size,
  };
}

/** A pool over a fake resource that records opens and closes. */
function makePool(idleMs = 1000) {
  const clock = manualScheduler();
  const opened = [];
  const closed = [];
  const pool = createLeasePool({
    create: (key) => { const v = { key, id: opened.length + 1 }; opened.push(v); return v; },
    close: (v) => { closed.push(v); },
    idleMs,
    scheduler: clock.scheduler,
  });
  return { pool, clock, opened, closed };
}

// ---------------------------------------------------------------------------
section('One resource, shared');
// ---------------------------------------------------------------------------
{
  const { pool, opened } = makePool();
  const a = pool.acquire('wallet-1');
  const b = pool.acquire('wallet-1');
  check('two acquires build one resource', opened.length, 1);
  check('...and hand out the same value', a.value === b.value, true);
  check('...with both counted', pool.stats().refs, 2);
}

// ---------------------------------------------------------------------------
section('Closed only when nothing holds it');
// ---------------------------------------------------------------------------
{
  const { pool, clock, closed } = makePool();
  const a = pool.acquire('w');
  const b = pool.acquire('w');

  a.release();
  check('one holder left: no close scheduled yet', clock.armed(), 0);
  check('...and still open', pool.stats().open, true);

  b.release();
  check('last holder gone: an idle close is armed', clock.armed(), 1);
  check('...but not closed yet — a re-acquire can still save it', closed.length, 0);

  clock.flush();
  check('idle fires and closes it', closed.length, 1);
  check('...and the pool reports empty', pool.stats(), { open: false, refs: 0, key: null, creates: 1 });
}

// ---------------------------------------------------------------------------
section('Re-acquired inside the idle window');
// ---------------------------------------------------------------------------
{
  const { pool, clock, opened, closed } = makePool();
  const a = pool.acquire('w');
  a.release();
  check('idle armed', clock.armed(), 1);

  const b = pool.acquire('w');
  check('re-acquire cancels the pending close', clock.armed(), 0);
  check('...reuses the same resource', b.value === a.value, true);
  check('...and does NOT build a second', opened.length, 1);

  clock.flush(); // nothing armed; must not close a resource now in use
  check('a stale timer cannot close a re-acquired resource', closed.length, 0);
  check('...still open with one holder', pool.stats().refs, 1);
}

// ---------------------------------------------------------------------------
section('release() is idempotent — callers run it from a finally');
// ---------------------------------------------------------------------------
{
  const { pool, clock, closed } = makePool();
  const a = pool.acquire('w');
  const b = pool.acquire('w');

  a.release();
  a.release();
  a.release();
  check('a repeated release does not double-decrement', pool.stats().refs, 1);
  check('...so nothing is scheduled while b still holds it', clock.armed(), 0);
  check('...and it is NOT closed underneath b', closed.length, 0);

  b.release();
  clock.flush();
  check('the real last release still closes it', closed.length, 1);
}

// ---------------------------------------------------------------------------
section('A different key never reuses the old resource');
// ---------------------------------------------------------------------------
{
  const { pool, opened, closed } = makePool();
  const a = pool.acquire('wallet-1');
  const b = pool.acquire('wallet-2');
  // For NWC this is a wallet switch: paying from the previous connection would
  // charge an account the user has just disconnected.
  check('the old resource is closed immediately', closed.length, 1);
  check('...a new one is built', opened.length, 2);
  check('...and it is not the old value', b.value === a.value, false);
  check('...keyed to the new identity', pool.stats().key, 'wallet-2');
  check('...with only the new holder counted', pool.stats().refs, 1);
}

// ---------------------------------------------------------------------------
section('A stale lease can never close the CURRENT resource');
// ---------------------------------------------------------------------------
{
  // The subtle one, and the reason `closeNow` clears `live` before calling
  // `close`. `stale` was taken against wallet-1; by the time it is released or
  // discarded the pool is serving wallet-2, which may have a payment in flight.
  const { pool, closed } = makePool();
  const stale = pool.acquire('wallet-1');
  pool.acquire('wallet-2');           // disposes wallet-1, opens wallet-2
  const closedSoFar = closed.length;

  stale.release();
  check('a stale release does not touch the live refcount', pool.stats().refs, 1);
  check('...and closes nothing', closed.length, closedSoFar);

  stale.discard();
  check('a stale discard does not close the live resource', closed.length, closedSoFar);
  check('...which is still open', pool.stats().open, true);
}

// ---------------------------------------------------------------------------
section('discard() drops a suspect resource now');
// ---------------------------------------------------------------------------
{
  const { pool, opened, closed } = makePool();
  const a = pool.acquire('w');
  a.discard();
  check('closed immediately, not after the idle window', closed.length, 1);
  check('...pool is empty', pool.stats().open, false);

  const b = pool.acquire('w');
  check('the next acquire builds a fresh one', opened.length, 2);
  check('...not the discarded value', b.value === a.value, false);

  // A release arriving after its own discard must be inert.
  a.release();
  check('a release after discard does not disturb the new resource', pool.stats().refs, 1);
  check('...and closes nothing further', closed.length, 1);
}

// ---------------------------------------------------------------------------
section('dispose() closes whoever holds it');
// ---------------------------------------------------------------------------
{
  const { pool, clock, closed } = makePool();
  const a = pool.acquire('w');
  pool.acquire('w');
  pool.dispose();
  check('closed even with two live holders', closed.length, 1);
  check('...and reports empty', pool.stats(), { open: false, refs: 0, key: null, creates: 1 });

  a.release();
  check('a release after dispose is inert', closed.length, 1);
  clock.flush();
  check('...and arms nothing', closed.length, 1);

  pool.dispose();
  check('dispose is idempotent', closed.length, 1);
}

// ---------------------------------------------------------------------------
section('A throwing close cannot wedge the pool');
// ---------------------------------------------------------------------------
{
  // `NWCClient.close()` can throw on an already-dead socket. If that escaped,
  // the pool would keep handing out a resource nobody can replace.
  let closes = 0;
  const clock = manualScheduler();
  const pool = createLeasePool({
    create: (key) => ({ key }),
    close: () => { closes += 1; throw new Error('socket already gone'); },
    idleMs: 10,
    scheduler: clock.scheduler,
  });
  const a = pool.acquire('w');
  a.discard();
  check('the throw is swallowed', closes, 1);
  check('...and the pool is empty rather than stuck', pool.stats().open, false);
  const b = pool.acquire('w');
  check('...so a fresh resource can still be built', b.value !== a.value, true);
}

// ---------------------------------------------------------------------------
console.log('\nlease.ts stays loadable under plain Node');
// ---------------------------------------------------------------------------
{
  // The arrangement this whole script depends on: it imports the REAL module,
  // so the module must keep resolving under `node --experimental-strip-types`.
  // See scripts/import-free.mjs for why a type-only relative import counts.
  const problems = importFreeProblems('lib/v4v/lease.ts');
  if (problems.length) { explainImportFree('lib/v4v/lease.ts', problems); failures += problems.length; }
  else console.log('  ok    lib/v4v/lease.ts has no imports that plain Node cannot resolve');
}

if (failures) {
  console.error(`\n${failures} lease check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll lease checks passed.');
