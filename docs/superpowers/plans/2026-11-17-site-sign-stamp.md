# Site-sign stamp Implementation Plan

> **Superseded in part — read the spec's "Change" sections first.** This plan was executed with LNbits. The stamp now pays a Lightning address (`SITE_STAMP_LNADDRESS`), its price is 1% of the boost, and `pay.boostmebitch.com` no longer exists (PR #591). The LNbits steps below are history, not instructions.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/api/nostr/site-sign` signs a boost note under the site's key only when a 1-sat invoice the site minted for exactly that event was paid; every other outcome posts the same note from a one-time key.

**Architecture:** One import-free leaf (`lib/site-stamp.ts`) holds every DECISION — the token, the route gate, and the client's signing ladder with its effects injected — so `check:sitestamp` pins all of it under plain Node. Thin server modules (LNbits client, stamp key, the moved template validator) and two routes do the I/O. The client ladder runs inside `publishBoostNoteViaSite`; the wallet payment is passed in from the modal as `payStampInvoice(rail, …)` from `lib/v4v/boost.ts`, so `lib/nostr/` imports no wallet.

**Tech Stack:** Next.js App Router routes, nostr-tools 2.19.4 (pinned), LNbits REST (`/api/v1/payments`), Node `crypto` HMAC, headless Chrome over CDP (`scripts/cdp.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-17-site-sign-stamp-design.md` (approved by Chad 2026-11-17).

## Global Constraints

- `STAMP_SATS = 1`; `STAMP_MAX_FEE_SATS = 10` (Spark only); invoice expiry 600 s; token lifetime 86,400 s.
- Memo: `` `${BRAND.displayName} note stamp` ``.
- Env (server-only, never in chat, never `NEXT_PUBLIC_`): `LNBITS_URL`, `LNBITS_INVOICE_KEY`, `SITE_SIGN_REQUIRE_STAMP` (`on` = phase 2).
- Phase 1: a bare template (today's body shape) is still signed while `SITE_SIGN_REQUIRE_STAMP !== 'on'`.
- The stamp is paid only where a site note posts today: after `sendBoost`, after `mintSummaryReceipt`, only when `shareNostr` and not self-signed. Never retried; RETRY NOTE never pays a second stamp.
- Any stamp-path failure posts the SAME template signed by `generateSecretKey()` in the browser, never stored. No copy may claim the sat stayed when it may have moved.
- Server rules: `rateLimit` first line; `requireJsonBody`; `readCappedRequestJson`; LNbits answers via `readCappedJson` with a timeout; 500s return a fixed fallback; `Cache-Control: no-store` on 200; `withCors` + `corsPreflight` on both stamp routes.
- `lib/nostr/` imports nothing from `lib/v4v/`. `lib/site-stamp.ts` has no imports at all.
- STE applies to chat only; code, comments, docs and the PR keep the repo's conventions.
- Do not touch `~/Vibe/boostmebitch` (main checkout). Work in this worktree; symlink `node_modules` and `.env.local` from the main checkout and remove both links at the end.

## Rulings made while planning

- **RETRY NOTE is pinned in the ladder, not in the browser.** The spec's browser case "RETRY NOTE after a failed relay publish" cannot happen: `publishSignedEvent` never throws, so a failed relay publish shows `done` with 0/N relays and no RETRY NOTE. After this change nothing on the site path throws past the ladder either. `signSiteNote` returning at once on a state that holds `signed` (Task 1) is what keeps a retry from paying twice. Cost if wrong: a future throw site re-runs the ladder; the state still stops a second stamp.
- **"LNbits not configured" is tested in the ladder, not the browser**: the server's env is fixed for a run. The route's 503 is one line; the ladder's answer to it is pinned in Task 1.
- **The notice never says the sat stayed.** The spec's "the 1-sat stamp did not go through" is false after a paid stamp whose signing failed, so each reason names what is known (`STAMP_FAILURE_TEXT`).
- **The client verifies the invoice amount before the wallet sees it** (`payStampInvoice`), the same rule as boost invariant 9.

## Review Focus

1. **× pressed during "Paying the 1-sat stamp…"** — the note still posts exactly once and exactly one stamp is paid; no unhandled rejection. Test: Task 4, section `close-mid-stamp`.
2. **LNbits hangs** — the route answers within ~10 s and the note falls back to a one-time key with the "could not confirm" notice; the modal never sits on the stamp step. Tests: Task 2 section 1 (`lookup hang → 502 < 10 s`), Task 4 section `lnbits-hang`.
3. **The server hands back an invoice that is not exactly 1 sat** (or not an invoice) — the wallet is never asked; the note is one-time. Test: Task 4 section `overcharge`.
4. **The Anonymous description wraps under the Buddy brand at 390 px** — the comment in `share-nostr-picker.tsx` forbids it (width jitter). Test: Task 4, a width measurement of the Buddy string in the live modal.
5. **The real LNbits answers in a shape the fake does not** — then every stamp reads unpaid and every anonymous note silently becomes one-time. Guard: Task 2 step 1 reads the live OpenAPI; `stampInvoicePaid` fails closed on a missing field; Chad's to-do gets one real 1-sat test per deploy.

---

### Task 1: The stamp rules (pure leaf + `check:sitestamp`)

**Files:**
- Create: `lib/site-stamp.ts`
- Create: `scripts/check-site-stamp.mjs`
- Modify: `package.json` (add `"check:sitestamp": "node --experimental-strip-types scripts/check-site-stamp.mjs"`)

**Interfaces:**
- Produces (all from `lib/site-stamp.ts`):
  - consts `STAMP_SATS`, `STAMP_MAX_FEE_SATS`, `STAMP_INVOICE_EXPIRY_SECS`, `STAMP_TTL_SECS`, `STAMP_PAY_TIMEOUT_MS = 30_000`, `STAMP_RECHECK_DELAYS_MS = [1500, 3000]`
  - `interface StampClaims { v: 1; id: string; ph: string; exp: number }`; `type Mac = (data: string) => string`
  - `encodeStamp(claims: StampClaims, mac: Mac): string` — `base64url(JSON) + '.' + mac(base64url(JSON))`
  - `readStamp(token: unknown, mac: Mac, nowSecs: number): { ok: true; claims: StampClaims } | { ok: false; reason: 'malformed' | 'forged' | 'expired' }` — MAC compared in constant time; `id`/`ph` must be 64 lowercase hex.
  - `splitSignBody(body: unknown): { template: unknown; stamp: unknown; legacy: boolean }` — a body with a `template` key is the new shape; anything else is a legacy bare template (`stamp: undefined`, `legacy: true`).
  - `type SignGate = { kind: 'sign' } | { kind: 'refuse'; status: 400 | 402; error: string } | { kind: 'check'; paymentHash: string }`
  - `stampGate(stamp: unknown, legacy: boolean, eventId: string, o: { requireStamp: boolean; mac: Mac; nowSecs: number }): SignGate`. Fixed errors: missing → 402 `a note stamp is required` (legacy with `requireStamp: false` → `sign`); malformed/forged → 400 `the note stamp is not valid`; expired → 400 `the note stamp has expired`; `claims.id !== eventId` → 400 `the note stamp is for a different note`.
  - `const STAMP_NOT_PAID = 'the note stamp is not paid'` (the route's 402 after LNbits; the ladder matches on it).
  - `interface NoteTemplate { kind: number; created_at: number; tags: string[][]; content: string }`
  - `type StampFailure = 'not-configured' | 'no-invoice' | 'wallet' | 'unconfirmed' | 'not-signed'`; `STAMP_FAILURE_TEXT: Record<StampFailure, string>` = `'note stamps are not set up on this site'`, `'the site could not make the stamp invoice'`, `'your wallet did not confirm the 1-sat stamp'`, `'the site could not confirm the 1-sat stamp'`, `'the site did not sign the note'`.
  - `interface SiteNoteState<E> { template?: NoteTemplate; stamp?: string; signed?: E; signer?: 'site' | 'one-time'; why?: StampFailure }`
  - `interface LadderDeps<E> { post(path: '/api/nostr/site-stamp' | '/api/nostr/site-sign', body: unknown): Promise<{ status: number; body: unknown }>; payStamp(bolt11: string): Promise<void>; signOneTime(t: NoteTemplate): E; sleep(ms: number): Promise<void>; onStamp?(): void }` — `post` reports a network error or timeout as `status: 0`, never throws.
  - `signSiteNote<E>(state: SiteNoteState<E>, deps: LadderDeps<E>): Promise<void>` — never throws; always leaves `state.signed` and `state.signer` set.

- [ ] **Step 1: Write the failing check.** Header comment per `CLAUDE.md` (what it pins, the failure it prevents, `naive()`). Start with `importFreeProblems('lib/site-stamp.ts')` → exit 1 on any import. Then:
  - **Token + gate vectors** as `{ label, kind: 'gate', args, alsoNaive? }`, replayed with `replayVectors`. `naive()` = a gate that base64-decodes any well-formed token and answers `check` with no MAC, expiry or id test, and signs every legacy body. MAC for tests: `createHmac('sha256', key)` in the script, two keys (`site`, `otherBrand`). Vectors (real answer in brackets):
    - valid token for `id` [`check`, `paymentHash`] `alsoNaive`
    - legacy body, `requireStamp: false` [`sign`] `alsoNaive`
    - legacy body, `requireStamp: true` [402 required]
    - new shape, no stamp, `requireStamp: false` [402 required]
    - one MAC character flipped [400 not valid]
    - token made with `otherBrand` key [400 not valid]
    - payload edited (`ph` swapped), old MAC kept [400 not valid]
    - `exp` one second in the past [400 expired]
    - valid token, different `eventId` [400 different note]
    - `id` not hex / token with no `.` / a number [400 not valid]
  - **Ladder scenarios** (plain assertions, fake deps that record every call; `sleep` resolves at once and records `ms`):
    - happy: posts site-stamp `{ template }`, calls `onStamp`, pays the invoice once, posts site-sign `{ template, stamp }` → `signer: 'site'`, `signed` = the route's event.
    - 402 `STAMP_NOT_PAID` twice then 200 → site; `sleep` saw `[1500, 3000]`.
    - 402 not paid three times → one-time, `why: 'unconfirmed'`, `payStamp` called once.
    - site-stamp 503 → one-time, `'not-configured'`, `payStamp` never called.
    - site-stamp 400 / 502 / status 0 / body without `invoice` → one-time, `'no-invoice'`, `payStamp` never called.
    - `payStamp` throws → one-time, `'wallet'`, site-sign never called.
    - `payStamp` never settles → one-time `'wallet'` after the `STAMP_PAY_TIMEOUT_MS` sleep wins.
    - site-sign 400 / 500 / status 0 after a paid stamp → one-time, `'not-signed'`, no second `payStamp`.
    - the one-time event is signed over the SAME `state.template` object (deep-equal content, tags, created_at).
    - second call on a state with `signed` set → zero calls of any dep (RETRY NOTE pays nothing).
- [ ] **Step 2: Run it** — `npm run check:sitestamp`. Expected: FAIL (`lib/site-stamp.ts` missing).
- [ ] **Step 3: Implement `lib/site-stamp.ts`** to the interfaces above. base64url via `btoa`/`atob` over UTF-8 bytes (no `Buffer`, it is isomorphic). The pay timeout is `Promise.race([payStamp(invoice), sleep(STAMP_PAY_TIMEOUT_MS).then(() => { throw … })])`.
- [ ] **Step 4: Run it** — `npm run check:sitestamp`. Expected: every vector proved or exempt, every scenario `ok`, exit 0. Then `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(site-stamp): the stamp token, the sign gate and the client ladder, pinned by check:sitestamp` (the CLAUDE.md hook stops the first try; re-run).

### Task 2: The server — LNbits, the stamp route, the gate on site-sign

**Files:**
- Create: `lib/lnbits.ts`, `lib/site-stamp-server.ts`, `lib/site-sign-template.ts`, `app/api/nostr/site-stamp/route.ts`, `scripts/fake-lnbits.mjs`, `scripts/e2e-site-stamp.mjs`
- Modify: `app/api/nostr/site-sign/route.ts` (validator moves out; gate goes in), `package.json` (`"e2e:sitestamp": "node scripts/e2e-site-stamp.mjs"`), `scripts/check-brand.mjs` (cross-brand CORS section)

**Interfaces:**
- Consumes: Task 1's `splitSignBody`, `stampGate`, `encodeStamp`, `STAMP_*`, `STAMP_NOT_PAID`.
- Produces:
  - `lib/site-sign-template.ts`: `validateBoostTemplate(body: unknown, site: string, opts: { checkCreatedAt: boolean }): EventTemplate` — the existing function and its constants and comments, moved verbatim; only the ±5-minute test becomes conditional.
  - `lib/site-stamp-server.ts`: `stampMac(): Mac | null` (key = `HMAC-SHA256(siteSecretKey, 'boostmebitch:site-stamp:v1')`, then `mac(d) = HMAC-SHA256(key, d)` as base64url); `requireStamp(): boolean` (`process.env.SITE_SIGN_REQUIRE_STAMP === 'on'`); `siteEventId(t: EventTemplate, sitePubkey: string): string` (`getEventHash`).
  - `lib/lnbits.ts`: `lnbitsConfigured(): boolean`; `createStampInvoice(sats: number, memo: string, expirySecs: number): Promise<{ paymentHash: string; bolt11: string }>`; `stampInvoicePaid(paymentHash: string, minSats: number): Promise<boolean>`. 8 s timeout each, 64 KB read cap, a fixed-string throw on any non-2xx or malformed answer. `stampInvoicePaid` is true only when `paid === true` AND the amount is ≥ `minSats * 1000` msat and positive (an outgoing payment is negative); a missing field is `false`.
  - `POST /api/nostr/site-stamp` `{ template }` → 200 `{ invoice, stamp }` | 400 validator message | 503 `note stamps are not configured` (no site key, or LNbits unset) | 502 `could not create the stamp invoice`. Rate limit key `site-stamp`, 30/min.
  - `POST /api/nostr/site-sign` accepts `{ template, stamp }` or a legacy bare template. `check` → 503 if LNbits unset; 502 `could not confirm the stamp` on an LNbits throw; 402 `STAMP_NOT_PAID`; else sign.
  - `scripts/fake-lnbits.mjs`: `createFakeLnbits({ port, key })` → `{ ready, minted: Array<{ hash, bolt11, amount, memo }>, markPaid(bolt11): boolean, mode: { mint: 'ok' | 'fail' | 'hang' | 'overcharge', lookup: 'ok' | 'hang' }, close() }`. Invoices are `lnbc10n1` + random bech32 characters (`lnbc20n1…` under `overcharge`), so `bolt11AmountMsat` reads 1,000 (2,000) msat.

- [ ] **Step 1: Pin the LNbits wire shape.** `curl -s https://pay.boostmebitch.com/openapi.json` (public, no key) and read the create-invoice request/response and the `GET /api/v1/payments/{payment_hash}` response. Write the field names you find into the header comment of `lib/lnbits.ts` and into `fake-lnbits.mjs`. If the instance does not serve OpenAPI, use the LNbits docs and say so in the ledger as a Ruling. Accept `payment_request` or `bolt11` on create.
- [ ] **Step 2: Write the failing e2e harness + section 1.** Header: usage block below, "nothing leaves the machine" (`--host-resolver-rules` as in `e2e-boost-note-wording.mjs`), and that the app runs under a THROWAWAY site key, never the real one.
  ```
  export E2E_SITE_SK=$(node -e "import('nostr-tools').then(m=>console.log(Buffer.from(m.generateSecretKey()).toString('hex')))")
  npm run build
  SITE_NOSTR_SK=$E2E_SITE_SK LNBITS_URL=http://127.0.0.1:3418 LNBITS_INVOICE_KEY=e2e-key SITE_SIGN_REQUIRE_STAMP=on npx next start -p 3417 -H 127.0.0.1
  APP_URL=http://127.0.0.1:3417 E2E_SITE_SK=$E2E_SITE_SK E2E_REQUIRE_STAMP=on npm run e2e:sitestamp
  ```
  The script starts `createFakeLnbits({ port: 3418, key: 'e2e-key' })` itself and `requireApp`s the app. Section 1 runs every request with `fetch` INSIDE the page (`Runtime.evaluate`), from a template built in Node with the fields a real note has (prefix `⚡ Boost ⚡`, `t` boostagram + value4value):
  - bare template → 402 `a note stamp is required` (with `E2E_REQUIRE_STAMP=on`); 200 and `event.pubkey === getPublicKey(E2E_SITE_SK)` when the switch is off.
  - `{ template }` to site-stamp → 200; `fake.minted.length` +1; memo ends ` note stamp`.
  - that stamp, unpaid → 402 `the note stamp is not paid`.
  - `markPaid` → 200; `event.id === claims.id` (decode the token payload in Node); pubkey is the site key.
  - the same paid stamp again → 200, same `event.id` (dedupe, no new mint).
  - the paid stamp with one character of `content` changed → 400 `the note stamp is for a different note`.
  - the paid stamp with its last MAC character flipped → 400 `the note stamp is not valid`.
  - a template the validator refuses (no `⚡ Boost ⚡` prefix) → site-stamp 400 and `fake.minted` unchanged.
  - `mode.mint = 'fail'` → 502; `mode.lookup = 'hang'` → site-sign answers 502 in under 10 s.
- [ ] **Step 2b: Pin the CORS in `check:brand`.** A source scan over `app/api/nostr/{site-sign,zap-receipt-sign,site-stamp}/route.ts`: each exports `OPTIONS` returning `corsPreflight(req)` and wraps its POST answer in `withCors(`. Run `npm run check:brand` → FAIL (no `site-stamp` route).
- [ ] **Step 3: Run it** (server built from the current tree). Expected: FAIL at the first site-stamp request (404).
- [ ] **Step 4: Implement** the three modules, the new route, and the site-sign changes. Keep both routes' "the only `e.message` reflection" `try` around the validator call alone. Order in site-sign: limit → JSON check → site key (503) → capped read → `splitSignBody` → validate (`checkCreatedAt: legacy`) → `siteEventId` → `stampGate` → for `check`: `lnbitsConfigured` (503) → `stampInvoicePaid` → sign.
- [ ] **Step 5: Rebuild, restart, run** — stop the server (by port, `lsof -nP -iTCP:3417 -sTCP:LISTEN`), `npm run build`, start as above, `npm run e2e:sitestamp`. Expected: section 1 all `ok`. Restart without `SITE_SIGN_REQUIRE_STAMP` and run `E2E_REQUIRE_STAMP= ONLY=1 npm run e2e:sitestamp`: the bare template is signed. Then `npm run check && npm run typecheck && npm run lint`.
- [ ] **Step 6: Commit** — `feat(site-sign): sign a stamped note; /api/nostr/site-stamp mints the 1-sat invoice (phase 1)`.

### Task 3: The client ladder in `publishBoostNoteViaSite` + the stamp payer

**Files:**
- Modify: `lib/nostr/boost-notes.ts:632-660` (`publishBoostNoteViaSite`), `lib/nostr/index.ts` (barrel), `lib/v4v/boost.ts` (new `payStampInvoice`), `lib/v4v/spark.ts:189` (`sparkPayInvoice(invoice, maxFeeSats = 100)`), `scripts/e2e-mentions.mjs` (the two fake `fetch`es at ~179 and ~428)

**Interfaces:**
- Consumes: Task 1's `signSiteNote`, `SiteNoteState`, `StampFailure`, `STAMP_SATS`, `STAMP_MAX_FEE_SATS`; Task 2's two routes.
- Produces:
  - `publishBoostNoteViaSite(args: PublishArgs, opts: { payStamp: (bolt11: string) => Promise<void>; state: SiteNoteState<Event>; onStamp?: () => void; origin?: string }): Promise<{ note: PublishedNote; signer: 'site' | 'one-time'; why?: StampFailure }>` — `state.template ??= buildBoostNoteTemplate(args, false)`, then `signSiteNote`, then `publishSignedEvent(state.signed, DEFAULT_RELAYS)`. `origin` (default `''`) prefixes BOTH routes — the seam #540 fills with the note's brand origin. `post` uses `AbortSignal.timeout(15_000)` and maps a throw to `status: 0`. `signOneTime` = `finalizeEvent(t, generateSecretKey())`.
  - Barrel: `publishBoostNoteViaSite`, `type SiteNoteState`, `STAMP_FAILURE_TEXT` (re-exported for the modals).
  - `payStampInvoice(rail: Rail, bolt11: string): Promise<void>` in `lib/v4v/boost.ts` — throws `the stamp invoice is not for exactly ${STAMP_SATS} sat` unless `bolt11AmountMsat(bolt11) === STAMP_SATS * 1000`, BEFORE any wallet call; then nwc → `nwcEngine().nwcPayInvoice`, spark → `sparkPayInvoice(bolt11, STAMP_MAX_FEE_SATS)`, webln → `weblnPayInvoice`.

- [ ] **Step 1: Update `e2e-mentions.mjs` first** so it fails against the old client: its fake `fetch` answers `/api/nostr/site-stamp` with `{ invoice: 'lnbc10n1…', stamp: 'x.y' }` and `/api/nostr/site-sign` with `{ event: finalizeEvent(body.template, siteSk) }`; `capture` reads `JSON.parse(init.body).template` from the site-stamp call; calls pass `{ payStamp: async () => {}, state: {} }`. Add: `check('the site path asked for a stamp first', firstUrl.endsWith('/api/nostr/site-stamp'), true)`.
- [ ] **Step 2: Run** `npm run e2e:mentions`. Expected: section 2 is SKIPPED on a machine that reaches the public relays (as before) — so also run `npm run typecheck`, which FAILS on the new `opts` argument until Step 3. Note in the ledger that section 2 only runs isolated.
- [ ] **Step 3: Implement** `publishBoostNoteViaSite`, the barrel exports, `payStampInvoice`, and the Spark fee parameter. Keep the JSDoc on `publishBoostNoteViaSite` true: it no longer throws on a 503/400.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm run check && npm run e2e:mentions`. Expected: green; e2e:mentions as before.
- [ ] **Step 5: Commit** — `feat(boost-notes): pay the stamp, then sign as the site; any failure signs with a one-time key`.

### Task 4: The modals, the copy, and the browser paths

**Files:**
- Modify: `components/boost-modal/index.tsx` (`SentBoost`, `maybePublishNote`, `finishBoost`), `components/boost-all-modal.tsx` (`postSummary`), `components/boost-modal/publish-status.tsx`, `components/boost-modal/share-nostr-picker.tsx`, `scripts/e2e-site-stamp.mjs` (sections 2–11)

**Interfaces:**
- Consumes: Task 3's `publishBoostNoteViaSite`, `payStampInvoice`, `STAMP_FAILURE_TEXT`, `SiteNoteState`.
- Produces:
  - `PublishState`: `{ kind: 'publishing'; step?: 'stamp' }` and `{ kind: 'done'; note: PublishedNote; notice?: string }`.
  - `SentBoost.siteNote: SiteNoteState<Event>` (a fresh `{}` per boost); `maybePublishNote(sent, results, track, itemArtist, minted, rail: Rail)` — `finishBoost` passes `opts.rail`, RETRY NOTE passes the same `rail`. BOOST ALL keeps `let siteNote: SiteNoteState<Event> = {}` beside `summaryReceipt` and pays on its `rail` state.

- [ ] **Step 1: Write sections 2–11 of `e2e:sitestamp`** (they fail until Step 3). Copy, don't import, from `e2e-boost-note-wording.mjs`: the episode, the `/api/item-value` stub (one keysend node), the NIP-07 binding. The WebLN stand-in gains `sendPayment(invoice)` → CDP binding `bmbPay` → `fake.markPaid(invoice)` (or throw, or a delay, per section), recorded in `window.__paid` with its kind. A page-level `WebSocket` wrapper, installed by `Page.addScriptToEvaluateOnNewDocument`, answers the four `DEFAULT_RELAYS` URLs with `["OK", id, true, ""]` and records each EVENT in `window.__published`; every other URL gets the real `WebSocket`. Each section asserts POSITIVELY that `__published` holds the event (a wrapper that intercepted nothing must fail). Sections:
  2. **signed-out WebLN**: one mint, one `sendPayment` after every keysend leg; published `pubkey === sitePk`; no notice.
  3. **wallet-refuses**: `sendPayment` throws → published pubkey ∉ {sitePk, userPk}; status shows `Posted from a one-time key` and `your wallet did not confirm the 1-sat stamp`; the legs show ✓.
  4. **mint-fails** (`mode.mint = 'fail'`) → one-time; `the site could not make the stamp invoice`; `sendPayment` never called.
  5. **overcharge** (`mode.mint = 'overcharge'`) → `sendPayment` never called; one-time.
  6. **lnbits-hang** (`mode.lookup = 'hang'`) → one-time within 30 s; `the site could not confirm the 1-sat stamp`.
  7. **close-mid-stamp**: `sendPayment` waits 3 s; press × while `Paying the 1-sat stamp…` shows → within 10 s exactly one event in `__published`, exactly one `sendPayment`, no `Runtime.exceptionThrown`.
  8. **BOOST ALL** signed out → one stamp; the summary note is site-signed.
  9. **Anonymous** (signed in, NIP-07, share as site) → site-signed; the NIP-07 binding never got a kind:1 `signEvent`.
  10. **NWC**: stub wallet copied from `e2e-nwc-relay.mjs` (the `answerFor`/`onmessage` block) on a local relay; its `pay_invoice` decrypts `params.invoice` and calls `fake.markPaid`; `bmb:rail_pref` = `nwc` → site-signed; the stub saw exactly one `pay_invoice`.
  11. **no stamp asked**: "Don't post" (signed in) and "My feed" → `fake.minted` unchanged and no request to `/api/nostr/site-stamp`.
  Plus, in section 2: the signed-out picker text contains `1 sat`; and (Review Focus 4) the Anonymous description, re-rendered with `boostmebuddy.com` in place of the domain, measures one line (`getClientRects().length === 1` on a clone in the same container) under CDP `Emulation.setDeviceMetricsOverride` 390×844 `mobile: true`.
- [ ] **Step 2: Run** against a rebuilt server. Expected: FAIL (no stamp asked, no `1 sat` text).
- [ ] **Step 3: Implement.** Copy (fixed):
  - publishing step: `◆ Paying the 1-sat stamp…`
  - done notice: `` `Posted from a one-time key, not ${BRAND.displayName}: ${STAMP_FAILURE_TEXT[why]}.` ``
  - signed-out picker, on: `` `${noteNoun} posted from ${BRAND.domain}'s Nostr account, for 1 sat plus a small network fee after the boost.` ``
  - Anonymous desc: keep the meaning "from the site's account, not your npub, 1 sat plus a small network fee" and stay one line under Buddy at 390 px; the section-2 measurement decides the wording.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint`, rebuild, restart, `npm run e2e:sitestamp`. Expected: sections 1–11 green. Then `npm run e2e:notewording` and `npm run e2e:boostnote` against the same server (they must stay green; if either blocks the site routes on purpose, say so in the ledger).
- [ ] **Step 5: Commit** — `feat(boost-modal): stamp the site note on every rail; say when a one-time key posted it`.

### Task 5: Docs, `CLAUDE.md`, full verification, Chad's to-do

**Files:**
- Modify: `docs/security.md` (the site-signing oracle section), `docs/money-boosts.md` (the stamp is a payment: when, which rail, the fee cap, never retried, the amount guard), `docs/ops.md` (the three env vars, the dedicated LNbits wallet, both Vercel projects, phase 2's switch and its condition), `CLAUDE.md` (server-only list: `lib/lnbits.ts`, `lib/site-stamp-server.ts`, `lib/site-sign-template.ts`; import-free list: `site-stamp.ts`; the check table row for `check:sitestamp`; boost invariant 1 gains "then the stamp, only for a site note"), `.env.example` (the three names, empty)
- Cross-repo, after this repo is committed: `~/Vibe/project-notes/notes/todo/boostmebitch.md`

- [ ] **Step 1: Write the docs and `CLAUDE.md` lines.** Rules only in `CLAUDE.md`, reasoning in `docs/`.
- [ ] **Step 2: Verify** — `npm run check:claudemd`, `npm run check` (all), `npm run typecheck`, `npm run lint`, stop the server, `npm run build`. Expected: zero failures; the one old lint warning only.
- [ ] **Step 3: Commit** — `docs: the site-sign stamp — security, money, ops, CLAUDE.md`.
- [ ] **Step 4: Chad's to-do.** Read `~/Vibe/project-notes/notes/TODO.md`, pull project-notes, and add to `notes/todo/boostmebitch.md` (group word, place word, `#N` of this PR): set `LNBITS_URL` + `LNBITS_INVOICE_KEY` on both Vercel projects (a dedicated stamp wallet each); one real signed-out boost per deploy whose note shows the site's name; one Spark boost on a phone; flip `SITE_SIGN_REQUIRE_STAMP=on` on both projects once production on both brands and beta carry the stamping client. Commit to `main` there; the push asks Chad.
- [ ] **Step 5: Clean up** — stop the server and Chrome (CDP `Browser.close`), delete `.next`, remove the `node_modules` and `.env.local` symlinks, run the `ps` check from `global.md`, run `node ~/Vibe/vibe-kit/vibe.mjs`.

The PR (base `feat/boost-note-wording`, stacked on #588) is opened only after Chad approves pushing #588 and this branch; it lists what was verified in the browser and what was not (Spark, a real LNbits, phones), and is never merged without Chad.
