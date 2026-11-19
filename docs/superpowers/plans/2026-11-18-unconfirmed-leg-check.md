# Unconfirmed leg check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a `?` leg in the single BOOST panel is checked with the wallet by its payment hash, retried only under that hash after the wallet says it failed, and a slow NWC leg no longer holds the others.

**Architecture:** pure rules in `lib/v4v/nwc-errors.ts` (`lookupVerdict`, `lookupErrorVerdict`), `lib/v4v/bolt11.ts` (`bolt11PaymentHash`) and `lib/util.ts` (`payInOrder`, `retryableLegs`); wiring in `lib/v4v/nwc.ts` (preimage, `nwcLookupPayment`) and `lib/v4v/boost.ts` (`nwcCheck`, `checkLeg`, `resendLeg`, `moveOnAfterMs`); UI in `components/boost-modal/`.

**Tech Stack:** Next 15, React 19, `@getalby/sdk` 5.1, `@noble/hashes` 2.

**Spec:** `docs/superpowers/specs/2026-11-18-unconfirmed-leg-check-design.md`

## Global Constraints

- A leg that may have paid is paid again ONLY after `lookup_invoice` says `failed`, and only under its first payment hash.
- `nwcCheck` (it holds a keysend preimage) never reaches storage: `storedBoostLegs` maps fields explicitly.
- Move-on is NWC only and opt-in (`moveOnAfterMs`); only the single BOOST panel passes it.
- Tests are private: a fake NIP-47 wallet on a local relay, stand-in public relays, `--host-resolver-rules` that resolve nothing but this machine.

## Review Focus

1. A `lookup_invoice` answer that echoes our keysend preimage on a pending or failed payment — must not read as paid.
2. A wallet that ignores our preimage — lookup `NOT_FOUND` → unknown, never RETRY.
3. A leg resent and unanswered again — `?` again, same hash, checked again; never "Retry N failed".
4. Two legs in flight on one NWC socket, and a later leg discarding a suspect socket under the slow one — the slow one becomes `?` and is checked; nothing pays twice.
5. The panel woken after the app was in the background — the check runs on `visibilitychange`/`resume`, and the remaining legs go out.

---

### Task 1: the pure rules

**Files:** `lib/v4v/bolt11.ts`, `lib/v4v/nwc-errors.ts`, `lib/util.ts`, `lib/types.ts`, `scripts/check-nwcerror.mjs`, `scripts/check-lnurl-comment.mjs`, new `scripts/fake-bolt11.mjs`.

**Produces:** `bolt11PaymentHash(invoice: string): string | null`; `type LegVerdict`; `lookupVerdict(tx: unknown, paymentHash: string): LegVerdict`; `lookupErrorVerdict(e: unknown): LegVerdict`; `payInOrder(order, pay, { moveOnAfterMs?, timer?, onAllStarted? }): Promise<void>`; `BoostResult.nwcCheck?: NwcLegCheck`; `retryableLegs` skips a leg with `nwcCheck`.

- [ ] Vectors first (RED): `bolt11PaymentHash` (real invoice from light-bolt11-decoder's tests → `f5636521…c3e5`; `s` and `h` fields before `p`; upper case; `lightning:`; garbage → null), `lookupVerdict` (naive = "a preimage means paid, no settlement means failed"), `lookupErrorVerdict` (naive = "NOT_FOUND means never sent → failed"), `payInOrder` (a slow leg does not hold the next; starts stay in order; `onAllStarted` fires before the slow leg settles; without `moveOnAfterMs` it waits), `retryableLegs` (a nothing-sent leg with `nwcCheck` is not retryable).
- [ ] Run `npm run check:nwcerror` and `npm run check:lnurl`: FAIL (functions missing).
- [ ] Implement; both checks PASS; `npm run typecheck`.
- [ ] Commit.

### Task 2: the engine

**Files:** `lib/v4v/nwc.ts`, `lib/v4v/boost.ts`.

**Consumes:** Task 1. **Produces:** `checkLeg(r: BoostResult): Promise<LegVerdict>`, `resendLeg(r: BoostResult): Promise<BoostResult>`, `sendBoost({ moveOnAfterMs?, onAllStarted? })`, `SLOW_LEG_MS = 15_000`.

- [ ] `nwcKeysend` takes the preimage; `keysendPreimage()` returns `{ preimage, paymentHash }` (`@noble/hashes`, no `crypto.subtle`: a phone on `http://LAN` has none).
- [ ] `nwcLookupPayment(hash)`: skip the request when the method list lacks `lookup_invoice`; reads retry a suspect socket.
- [ ] `payKeysend`/`payLnurl` tag an unanswered NWC error with its `NwcLegCheck` (a `WeakMap`); the keysend→LNURL wrapper carries the tag; `payOne` copies it to `nwcCheck`.
- [ ] `sendBoost` traverses with `payInOrder`, moving on only when `rail === 'nwc'` and `moveOnAfterMs` is set.
- [ ] `npm run typecheck && npm run lint`; commit.

### Task 3: the panel

**Files:** `components/boost-modal/index.tsx`, `components/boost-modal/splits-preview.tsx`.

- [ ] `go()`: both blocks pass `moveOnAfterMs: SLOW_LEG_MS`; the show block starts on the track block's `onAllStarted`.
- [ ] Per-leg check state; auto-check after a send/retry, on `visibilitychange` (visible) and `resume`, and every 15 s × 8 while pending; CHECK AGAIN and RETRY under the "unconfirmed" line; a paid answer updates the log and posts a note not yet posted; nothing closes the panel after a check.
- [ ] `finishBoost` keeps the panel open while a leg is `?`; "Keep the app open until the boost is done." while sending.
- [ ] typecheck, lint, build; commit.

### Task 4: e2e, docs

**Files:** new `scripts/e2e-unconfirmed-leg.mjs`, `package.json`, `docs/money-boosts.md`, `CLAUDE.md` (invariants 10–11, the `check:nwcerror` row).

- [ ] Sections: (1) move on + paid/failed→RETRY same preimage/pending→paid/NOT_FOUND→no pay, in one boost; (2) a wallet without `lookup_invoice`: no request, no pay; (3) frozen page during a leg, reply lost, woken → `?` → checked → ✓, remaining legs paid, note posted to the stand-in relays; (4) an LNURL leg checked by its invoice hash; (5) 390 px phone layout of the unconfirmed lines: no overflow, buttons ≥ 24×24.
- [ ] `npm run check`, typecheck, lint, build, e2e green; docs; commit; final review; PR.
