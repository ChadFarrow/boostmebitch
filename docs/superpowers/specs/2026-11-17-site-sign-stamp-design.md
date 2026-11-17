# The site signs only a stamped boost note — design

**Status:** draft for Chad's review (2026-11-17). Chad chose approach A ("A", via the dispatcher).
**Base:** stacked on PR #588 (`feat/boost-note-wording`), branch `feat/site-sign-stamp`.

## Chad's decisions (2026-11-17)

1. **Approach A**, the 1-sat stamp to the site.
2. **A signed-out boost still posts as the site by default.** The "Post to Nostr" box stays on, and its
   label says it costs 1 sat. So by default every signed-out boost pays the stamp, and on WebLN asks for
   one more approval.
3. **The fee:** the stamp's fee limit on Spark is **10 sats**; past it, the note posts from a one-time
   key. NWC and WebLN let the wallet set the fee (the app cannot), so the wallet's own limits apply. The
   screen says "1 sat plus a small network fee".

## Intent

`/api/nostr/site-sign` signs boost-shaped kind:1 notes with the site's key, which carries the site's
NIP-05-verified name (`BRAND.siteNpub`). It is unauthenticated and asks for no proof of payment, so
anyone with `curl` can publish up to 5,500 characters of their own text under "Boost Me Bitch" (or
"Boost Me Buddy"), 30 times a minute per IP. Chad's goal: **only someone who really paid gets the
site's name on a note — and no real boost ever loses its note.** A spammer who gets the site key
flagged by relays hurts every real anonymous boost, which is the harm worth preventing.

## What we found (why approach A)

- **A boost payment cannot be proven to a third party in most cases.** A keysend payment's preimage
  is made by the SENDER (`lib/v4v/nwc.ts:510` draws it at random before paying), so a server cannot
  tell paid from unpaid. Most legs are keysend: a Lightning address upgrades to keysend when it can.
- An LNURL leg has a BOLT11 invoice and a preimage, but Spark returns no preimage
  (`lib/v4v/spark.ts:185`), and anyone who owns a feed and a Lightning address can mint that "proof"
  without paying.
- The summary receipt the site signs (`/api/nostr/zap-receipt-sign`) is not proof either: that route
  also signs on request with no payment check.
- **The one payment the site can check for certain is a payment to itself.** `chadf@boostmebitch.com`
  is an LNbits instance (`pay.boostmebitch.com`) in front of Chad's LND node (`docs/money-boosts.md`
  "Serving our own lightning address"); an LNbits invoice/read key lets the server mint an invoice and
  ask whether it was paid, and that key cannot spend.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | **A 1-sat stamp to the site.** After the boost, the wallet pays a 1-sat invoice the site minted; the site checks it was paid, then signs. If the stamp fails, the note posts under a fresh random key. | Real proof; every rail can pay a BOLT11; every real boost keeps the site's name when the stamp works. Costs one more payment (one more approval on WebLN), an LNbits key on Vercel, and 1 sat a note is a low price for a determined spammer. |
| B | A fresh random key for every anonymous note; delete the route. | Nothing to abuse, nothing to fail — but no anonymous note shows under the site's name, and web-of-trust filters (Primal, Damus) can hide a key with no followers. |
| C | Keep #588 as is (5,500-character limit, rate limit, no proof). | Every real boost keeps working; a stranger still posts for free. |

## Goals

1. `site-sign` signs a note only when the request carries a **stamp**: proof, checked by the server
   against its own LNbits wallet, that an invoice the server minted **for exactly this event** was paid.
2. **No real boost loses its note.** Every failure on the stamp path ends in the note being published
   anyway — under a one-time random key — and the screen says which.
3. Every rail can pay the stamp: NWC, WebLN, Spark. Both surfaces: the single BOOST modal and BOOST ALL.
   RETRY NOTE never pays a second stamp for the same note.
4. The user sees the 1-sat cost before they boost, and sees the outcome after.

## Non-goals

- Proving the boost legs themselves (impossible for keysend; see above).
- The receipt oracle (`zap-receipt-sign`): it still signs on request. Its content is empty and its
  claims are bounded (`validateSummaryRequest`), so it is a smaller target; reusing the stamp for it is
  a follow-up, not this change.
- Self-signed notes (the user's own key): unchanged, no stamp.
- Streaming: posts no kind:1, unchanged.
- Raising or removing the 5,500-character body limit: it stays — it is above every real note and bounds
  relay-side size.

## Anti-goals (a failure even if it "works")

- A real boost whose note never appears.
- Two stamps paid for one note (a retry, a double tap, a re-render).
- A stamp paid when no note posts ("Don't post", self-signed, or a boost where every leg failed).
- A charge the user was not told about.
- The LNbits key, or anything that can spend, reaching the browser.
- `lib/nostr/` importing a wallet module (the v4v-toolkit boundary in `CLAUDE.md`).
- A stamp that signs anything other than the one event it was minted for.

## Constraints (from `CLAUDE.md` and the docs it points to)

- **Lightning first, then Nostr** (boost invariant 1). The stamp is paid only after `sendBoost` returns
  with `collected.some(r => r.ok)`, i.e. only when a note will be published.
- **An unanswered wallet did not fail and is never retried** (invariant 11). An indeterminate stamp is
  not retried; the note falls back to the one-time key. Losing a sat is recoverable; paying twice is not.
- The rail picker decides the rail; the stamp uses **the rail the boost used**.
- Server: `rateLimit` first line; `readCappedRequestJson` for the body; `readCappedJson` for every
  LNbits answer; a 500 returns its fallback, never `e.message`; `Cache-Control` on 200 only;
  `requireJsonBody`; the cross-brand CORS the two signing routes already carry.
- `nostr-tools` stays pinned at 2.19.4.
- The two brands are two deploys with two site keys; each deploy has its own LNbits configuration.

## The design (decided parts)

### Protocol: two requests

1. **`POST /api/nostr/site-stamp`** — body `{ template }`. The route validates the template with the
   **same validator** `site-sign` uses (moved to one server-only module so the two cannot drift), computes
   the template's NIP-01 event id **as the site key would sign it** (`[0, sitePubkey, created_at, kind,
   tags, content]`), mints an LNbits invoice for `STAMP_SATS = 1` with the memo
   `"<BRAND.displayName> note stamp"` and a 10-minute expiry, and answers
   `{ invoice, stamp }`. `stamp` is a token: `base64url(JSON{ v:1, id, ph, exp })` + `.` +
   `HMAC-SHA256(stampKey, payload)`, where `id` is the event id, `ph` the invoice's payment hash, and
   `exp` mint time + 24 h. `stampKey` is derived from `SITE_NOSTR_SK` (e.g. SHA-256 of a fixed label and
   the key bytes), so no new secret is needed and each brand's stamps verify only on its own deploy.
2. **`POST /api/nostr/site-sign`** — body `{ template, stamp }`. The route validates the template as
   today, checks the token's HMAC and `exp`, recomputes the event id and requires it to equal the token's
   `id`, then asks LNbits whether `ph` is paid for at least `STAMP_SATS`. Only then does it sign. A body
   without a stamp — today's shape — gets **402** `a note stamp is required`. An unpaid stamp gets 402
   `the note stamp is not paid`. A mismatched id, a bad HMAC or an expired token gets 400.

**Why bind the event id:** a paid stamp can then only ever produce **one** event. Asking again yields
the same id (relays dedupe it), so a paid stamp cannot be replayed into many notes, while RETRY NOTE can
ask as often as it needs. No server state is needed.

**`created_at`:** the stamp route applies today's ±5-minute rule. The sign route accepts a stamped
template whose `created_at` is older than 5 minutes, because the id (which includes `created_at`) was
already bound inside a token minted within 5 minutes of it. Unstamped requests no longer exist.

### LNbits

A server-only module (`lib/lnbits.ts`, added to `CLAUDE.md`'s server-only list) with two calls:
`createInvoice(sats, memo, expirySecs) → { paymentHash, bolt11 }` (LNbits `POST /api/v1/payments`,
`out: false`) and `isPaid(paymentHash, minSats) → boolean` (`GET /api/v1/payments/{hash}`). Header
`X-Api-Key: LNBITS_INVOICE_KEY`; base URL `LNBITS_URL`. Both env vars are server-only and stored as
*sensitive* on both Vercel projects. Missing either → both routes answer **503**. Each call has a
timeout and a capped read. LNbits versions differ in field names (`payment_request` vs `bolt11`); accept
both, and confirm against Chad's instance before shipping.

The LNbits URL comes from env, not from a feed, so it is not a `safeFetch` case — but it is still read
capped and with a timeout.

### Client

`publishBoostNoteViaSite(args, { payStamp })` in `lib/nostr/boost-notes.ts`:

1. Build the template once (`buildBoostNoteTemplate(args, false)`, unchanged).
2. `POST /api/nostr/site-stamp` → `{ invoice, stamp }`.
3. `await payStamp(invoice)`, capped at 30 s.
4. `POST /api/nostr/site-sign` with `{ template, stamp }`. If the answer is 402 "not paid", ask once more
   after ~2 s (settlement can lag the payer's answer).
5. Publish the signed event to `DEFAULT_RELAYS`, as today.

`payStamp` is passed in by the modal: `(bolt11) => payStampOn(rail, bolt11)`, a small new export in
`lib/v4v/boost.ts`. It pays like an LNURL leg's invoice, except on Spark, where the fee limit is
`STAMP_MAX_FEE_SATS = 10` instead of a boost leg's 100 (decision 3). This keeps `lib/nostr/` free of
wallet imports.

**Fallback.** Any failure in steps 2–4 — 503, a refused mint, a wallet that refuses, cancels or times out,
an indeterminate payment, a 402/400 after the one re-ask — signs **the same template** in the browser
with a one-time key (`generateSecretKey`, never stored) and publishes it. The result tells the modal which
key signed (`signer: 'site' | 'one-time'`) and, for a one-time note, why the stamp failed.

**Retry.** The modal keeps the stamp state across RETRY NOTE for that boost: if the stamp was paid, a
retry reuses `{ template, stamp }` (or the already-signed event, if only the relay publish failed) and
never pays again. A relay-publish failure keeps today's RETRY NOTE behaviour.

**Order.** The stamp is paid after the boost's legs and after the summary receipt is minted — exactly
where the site note is published today — so nothing changes for "Don't post", self-signed notes, or a
boost whose legs all failed.

### What the user sees (copy is the builder's, meaning is fixed)

- **Before:** wherever the note will be site-signed (signed out with "Post to Nostr" on — the default,
  decision 2; signed in with Anonymous), the share picker says that posting as the site costs 1 sat plus a
  small network fee, paid after the boost.
- **During:** the publish status names the stamp step ("paying the 1-sat stamp…").
- **After, site key:** as today ("posted as Boost Me Bitch").
- **After, one-time key:** "Posted from a one-time key — the 1-sat stamp did not go through (<reason>)."

### The other brand's notes (PR #540) — my call

PR #540 (open; its head is already on `origin/beta`) sends a note for a song from a hosted playlist to
the OTHER deploy's `site-sign` (`${brand.origin}/api/nostr/site-sign`, `lib/nostr/boost-notes.ts:699` on
beta). The stamp must follow the note's signer, so:

- The client sends **both** requests (`site-stamp` and `site-sign`) to the origin of the deploy whose key
  signs the note — chosen by the note's brand, never by `BRAND`. One helper picks that origin, and both
  requests use it.
- `site-stamp` carries the same cross-brand CORS as the two signing routes, and `check:brand` covers it.
- A hosted-playlist note on boostmebitch.com pays its stamp into **Buddy's** LNbits wallet, because
  Buddy's key signs it. Each Vercel project needs its own `LNBITS_*` settings.
- Whichever of #540 and this branch merges second rebases onto the other; the conflict is in
  `publishBoostNoteViaSite`, and the helper above is the shape both need.

### Rollout in two phases — my call

A route that demands a stamp breaks every client that does not send one: a page loaded before the deploy,
and — through #540 — beta.boostmebitch.com, whose code sends bare templates to Buddy production and has
no fallback. So the demand is a switch, not a deploy:

1. **Phase 1 (this PR).** Clients stamp every site note and fall back to a one-time key. The route
   signs a stamped request after checking it, and still signs a bare template while
   `SITE_SIGN_REQUIRE_STAMP` is not `on` — so no deployed client breaks.
2. **Phase 2 (Chad flips the switch).** After production on both brands and beta carry the stamping
   client, Chad sets `SITE_SIGN_REQUIRE_STAMP=on` on both Vercel projects. From then on a bare template
   gets 402. No code change, and it can be turned off again in a minute.

The switch goes on Chad's to-do list with the condition for flipping it.

### Deploy order

`LNBITS_URL` and `LNBITS_INVOICE_KEY` must be set on **both** Vercel projects before the merge. If they
are missing, every site note falls back to a one-time key: nothing breaks, but the site's name
disappears from anonymous notes until they are set. Recommended: a **dedicated LNbits wallet** for stamps,
so the key on Vercel can read only that wallet's history. Chad creates the wallet and types the key into
Vercel and `.env.local` himself; it is never sent in chat.

A browser holding JavaScript from before the deploy sends a bare template; in phase 1 it is still signed,
and in phase 2 it gets 402 until the page reloads.

### Tests

- **`check:sitestamp`** (pure, import-free leaf with the HMAC injected): token encode/verify; the id
  binding; `exp`; the `created_at` rule; a tampered payload, a swapped `ph`, a swapped `id`, the other
  brand's key. Vectors recorded as calls with a `naive()` that accepts any well-formed token, per
  `CLAUDE.md`'s replay rules.
- **`e2e:sitestamp`** in headless Chrome over CDP, against `next start` with `LNBITS_URL` pointed at a
  **fake LNbits** server inside the script (mints fake invoices, marks one paid when the WebLN stand-in
  "pays" it). Cases:
  1. Refusals, by direct POST: a bare template with the switch on → 402 (and signed with it off); a stamp for an unpaid invoice → 402; a paid stamp
     with a changed template → 400; an expired token → 400; a token from the other brand's key → 400.
  2. Signed out, WebLN: boost → one stamp paid → the note on the local relay is signed by the site key.
  3. Stamp refused by the wallet → the note is on the relay under a one-time key; the screen says so.
  4. No LNbits configured (503) → one-time key; the screen says so.
  5. RETRY NOTE after a failed relay publish → the same event id; exactly one stamp paid.
  6. BOOST ALL signed out → one stamp, site-signed.
  7. Signed in + Anonymous (NIP-07 stand-in) → stamped, site-signed.
  8. NWC: the stamp is paid through the NWC stub (`e2e-nwc-relay.mjs` harness).
  9. "Don't post" and self-signed → no stamp request at all.
- **Not testable here:** Spark (its SDK needs the network), a real LNbits instance, a real 1-sat payment,
  and phones — these go on Chad's to-do list (`project-notes/notes/todo/boostmebitch.md`).

### Docs to update in the same change

`docs/security.md` (the site-signing oracle: what the stamp proves and what it does not),
`docs/money-boosts.md` (the stamp is a payment: when, which rail, never retried), `docs/ops.md` (the two
env vars, the dedicated wallet, deploy order), `CLAUDE.md` (server-only list: `lib/lnbits.ts`; boost
invariant 1 gains the stamp; the check table gains `check:sitestamp`).

## Left to the builder

File and function names beyond those fixed above; the exact copy within the meanings above; the
stamp-key derivation label; the timeout values within the bounds given; the test file layout.
