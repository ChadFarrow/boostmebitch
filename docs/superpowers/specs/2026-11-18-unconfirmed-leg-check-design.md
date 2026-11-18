# An unconfirmed boost leg: ask the wallet, retry only what it says failed

Chad, 2026-11-18, after a boost whose Spencer leg showed `?` ("your wallet didn't
answer in time"): *"Can we add a retry split also?"* Then: the boost stalled while
the app was in the background on his iPhone, and on a second boost left open the
leg also timed out — Spencer WAS paid — and *"that one split timing out also kept
the rest of the boost from being paid. So if one split times out, can we just move
on to the rest of them … and then when the user comes back, they see the modal
there with retry the splits."* He chose the single BOOST panel only (not BOOST ALL).

## What happens today (measured / read)

- A NIP-47 `pay_*` request waits for its reply up to 60 s (`@getalby/sdk`). AlbyHub
  answers only when the payment settles, so a slow route trips the cap while the
  payment is still in flight → `NwcIndeterminateError` → the leg renders `?`.
- Legs are strictly sequential, so that one leg holds every later leg for 60 s.
- In the background the page stops. Measured in Chrome (`Page.setWebLifecycleState
  frozen`, local relay only): a reply sent while the page was frozen never arrived,
  the socket was closed on wake, and an overdue timer fired as soon as the page woke
  (the time away counts). The reply is an ephemeral kind:23195 that relays do not
  keep, so waiting longer can never recover it. An iPhone was not tested; Chad's
  report fits the same pattern.
- A `?` leg is never retried (invariant 11): it may have paid.

## The design

1. **Every NWC leg knows its payment hash.** A keysend's preimage is made by the
   app (`nwcKeysend` already passes one), so its hash is `sha256(preimage)`. An LNURL
   leg's hash is in its BOLT11 (`bolt11PaymentHash`). An unanswered leg carries
   `BoostResult.nwcCheck = { paymentHash, resend }`, in memory only.
2. **Ask, never guess.** `lookup_invoice { payment_hash }` → `lookupVerdict`:
   `paid` (state `settled`, or `settled_at`), `pending`, `failed`, or `unknown`
   (no permission or method, `NOT_FOUND`, no answer, a malformed or contradictory
   answer). A preimage in the answer is never proof: the app made it.
3. **The panel checks by itself**: when a leg comes back `?`, again each time the
   app comes back to the front, and every 15 s while the wallet says "pending"
   (8 times at most). Asking pays nothing.
4. **RETRY only after the wallet says `failed`**, and it pays the SAME hash: the same
   preimage and TLV for a keysend, the same invoice for LNURL. A node refuses a second
   payment to a hash it already took, so even a wrong `failed` cannot pay twice. A
   leg that once went unanswered is never in "Retry N failed" (`retryableLegs`),
   which pays with a fresh hash.
5. **`unknown` pays nothing** and says so: "Your wallet cannot tell if this payment
   went through. Look in your wallet's history before you boost again." CHECK AGAIN
   stays available.
6. **Move on from a slow leg.** On the NWC rail, the single BOOST panel starts the
   next leg once the current one has had 15 s with no answer; the slow leg keeps
   waiting in the background. Starts stay in order, one at a time; only waiting
   overlaps. A redirect's show block starts once every track leg has started.
   WebLN (a prompt per payment), Spark, BOOST ALL and streaming are unchanged.
7. **The panel stays open while a leg shows `?`**, and a check or retry never
   closes it. While a boost sends it says "Keep the app open until the boost is
   done."

## Non-goals

- BOOST ALL (Chad: single boosts only). Streaming. A boost after a reload (the
  hash is in memory only, like the "Retry failed" button).
- Any retry when the wallet cannot tell. Any payment under a new hash for a leg
  that once went unanswered.

## Calls I made (Claude)

- 15 s before moving on; 15 s × 8 for "pending" re-checks.
- Controls live under the yellow "unconfirmed" line, one line per leg, not inside
  the RECIPIENTS scroll box (which may scroll the button away, and is `aria-live`).
- A resend that does not succeed leaves the leg `?` and checks again: only the
  wallet's answer about that hash decides the next step.
