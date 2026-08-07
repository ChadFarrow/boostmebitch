# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**How to read this file.** Each entry is a rule plus the consequence of breaking it. The consequence is there so you can judge a trade-off, not as history — where a rule says "this shipped broken once," treat that as evidence the obvious version is wrong, not as an invitation to re-litigate. The README at the repo root is the architecture spec; treat overlap with this file as the README's job.

**What lives here vs `docs/`.** This file holds only what must be in mind *before* you know which file you're opening: money-path and security invariants, boundaries, repo-wide conventions, and the stop-ship checks. Everything else — the deep "why the obvious version is wrong" reasoning for each subsystem — lives in `docs/`, indexed below. **When you learn a new rule, it goes in the relevant `docs/` file unless it (a) can lose funds or leak a credential, (b) governs where code may go, or (c) applies to edits in files you haven't opened yet.** Only those three go here. Without that test this file grows back.

## Read before you edit

These docs hold the "this shipped broken once" reasoning that is not in the code. **Read the relevant one before editing in its area** — the rules in it are not reconstructible from reading the source.

| Doc | Read before touching |
|---|---|
| [`docs/money-boosts.md`](docs/money-boosts.md) | `lib/v4v/boost.ts`, `components/boost-modal/`, `boost-all-modal.tsx`, `lib/v4v/keysend-lookup.ts`, `lib/boost-sound.ts`, `app/.well-known/keysend/` |
| [`docs/streaming.md`](docs/streaming.md) | `lib/v4v/streaming.ts`, `stream-ledger.ts`, `live-value.ts`, `live-block.ts`, `components/streaming-settings.tsx` |
| [`docs/signers.md`](docs/signers.md) | `lib/nostr/signer.ts`, `amber.ts`, `bunker.ts`, `local-signer.ts`, `google-auth.ts`, `drive-backup.ts`, `backup-crypto.ts`, `components/nostr-auth/` |
| [`docs/nostr.md`](docs/nostr.md) | `lib/nostr/*` (non-signer), `components/*note*`, `components/*feed*`, `live-chat.tsx` |
| [`docs/wallets.md`](docs/wallets.md) | `components/wallet-modal.tsx`, `*-wallet.tsx`, `wallet-balance.tsx`, `lib/v4v/nwc.ts`, `spark.ts`, `webln.ts` |
| [`docs/feeds.md`](docs/feeds.md) | `app/api/*`, `lib/pi.ts`, `lib/podcast-meta.ts`, `lib/live-status.ts`, `components/podroll.tsx` |
| [`docs/ui.md`](docs/ui.md) | `components/player.tsx`, `lists.tsx`, `chapter*`, `transcript*`, `home-page.tsx`, `episode-detail-view.tsx`, theme/PWA |
| [`docs/storage.md`](docs/storage.md) | Adding or changing any `bmb:*` key |
| [`docs/security.md`](docs/security.md) | `lib/safe-fetch.ts`, `safe-url-attr.ts`, `sanitizeShowNotes`, `app/api/transcript`, `app/api/nostr/site-sign` |
| [`docs/ops.md`](docs/ops.md) | Google Cloud console, DNS, OAuth consent screen |

## Names

- **`boostmebitch`** — repo, working directory, npm package name, and `APP_NAME` default for the Podcast Index `User-Agent`.
- **"Boost Me Bitch"** — display name in the page header and `<title>`.
- **`BoostMeBitch`** — `app_name` in the boostagram TLV JSON and `client` tag on Nostr notes (CamelCase, no spaces — matches the Helipad-aggregator convention used by Fountain, StableKraft, etc.).

## Commands

```bash
npm install
cp .env.example .env.local       # PI key + secret (Spark rail needs no key)
npm run dev / build / start / lint
```

**No test runner, no formatter.** Checks are `npm run typecheck` (`tsc --noEmit`, strict), `npm run lint` (ESLint 9 flat config in `eslint.config.mjs` — `next/core-web-vitals` + `next/typescript`, `no-explicit-any` off for PI's untyped JSON), and `next build`. Path alias `@/*` → repo root.

**Five `check:*` scripts stand in for the tests this repo doesn't have.** Each guards a function whose silent breakage costs a user something irreversible — treat a failure as a stop:

| Command | Guards | Cost of silent breakage |
| --- | --- | --- |
| `npm run check:spark` (`scripts/check-spark-derivation.mjs`) | `sparkMnemonicFromKey`, `deriveBackupKey` | every derived Spark wallet moves; every Drive backup becomes undecryptable |
| `npm run check:sanitizer` (`scripts/check-sanitizer.mjs`) | `safeUrlAttr` — show-notes URL allowlist | a podcast feed runs JS in the origin holding the NWC spending credential |
| `npm run check:ssrf` (`scripts/check-ssrf-guard.mjs`) | `assertSafeFetchUrl` | feed data points the server at cloud metadata |
| `npm run check:liveblock` (`scripts/check-live-block.mjs`) | `parseLiveBlock` — the Split Kit live-value payload → value block | a live show pays the wrong node, drops an artist, or keysends at an email-shaped address |
| `npm run check:stream` (`scripts/check-stream-ledger.mjs`) | `accrue`, `creditFixed`, `clearCreditedRun`, `settlePlan`, `settleBatch`, `accruedSats`, `trackBucket`, and the money constants (rate + per-track defaults and ceilings, settle interval, floor, tick + carry caps, minimum play + credit debounce). **`distribute` is module-private, so it's exercised transitively through `accrue`/`creditFixed` rather than imported** — it's the one name here without a direct pin. | streaming drains a wallet at 60× the chosen rate, silently pays nothing, pays a whole batch to the wrong artist, settles one artist per ten minutes while the rest wait, charges a per-track amount *and* a per-minute rate at once, or pays the same song again every time the page reloads |

Each **imports the real module** via `node --experimental-strip-types` — a reimplemented copy passes green while shipping code drifts, the exact failure being guarded. Each carries a *must-still-work* half (legitimate URLs, real podcast hosts, valid mnemonics), because over-blocking is a real regression too. **Vectors were generated by the shipping code; if one fails, fix the code — never edit the vector to match.**

Run all of them alongside typecheck/lint/build before anything ships. **Stop the dev server before `npm run build`** — the build rewrites `.next` and the running server then serves a mismatched chunk manifest.

`.env.local`: `PODCAST_INDEX_KEY`/`SECRET` (server-only), `APP_NAME` (optional). The Spark rail needs **no** API key.

## Server vs client boundary (don't cross it)

Podcast Index credentials must never reach the browser. Enforced by file conventions, not bundler config.

**Server-only:** `lib/pi.ts` (uses `node:crypto`, reads `process.env`), imported by `app/api/*` and by `app/page.tsx`'s `generateMetadata` — both server-side, so the credential invariant holds, but don't read the rule as "API routes only"; the BoostBox proxy `app/api/lightning/boostbox/route.ts` (reads `BOOSTBOX_URL`/`BOOSTBOX_API_KEY` and forwards); `lib/safe-fetch.ts`; `lib/rate-limit.ts` (per-IP sliding window, first line of every API route).

**Browser-only:** `lib/store.ts`, `lib/v4v/nwc.ts`/`webln.ts`/`lnaddr.ts`/`spark.ts`/`boostbox.ts`, `lib/nostr/`, `lib/storage.ts`, `lib/podcast-meta.ts` — they touch `window.*`, storage, IndexedDB, or WASM. SSR guards exist but assume client context.

**Isomorphic:** `lib/types.ts` (pure types), `lib/v4v/boost.ts` (orchestration).

Components fetch via local API routes (`fetch('/api/feed?id=…')`) — never call PI directly.

## Cross-cutting rules

Each of these has cost something real. The reasoning is in the linked doc; the rule is here because you can break it from a file that looks unrelated.

- **`safeUrlAttr` is a scheme ALLOWLIST and must stay one.** Never "improve" it into a denylist of bad schemes — it shipped that way and six vectors reached the DOM as live `javascript:`. Show notes render via `dangerouslySetInnerHTML` and this origin's `localStorage` holds a spending credential. → [`docs/security.md`](docs/security.md)
- **Every server-side fetch of a feed/chapter/transcript URL goes through `safeFetch(url, init)`, never a bare `fetch`** — it re-validates every redirect hop, not just the initial URL. → [`docs/security.md`](docs/security.md)
- **`nostr-tools` is pinned to exact `2.19.4` — do NOT bump it or relax the caret.** `2.20.0+` breaks `nostrconnect://` login. `npm update` reintroduces it. → [`docs/signers.md`](docs/signers.md)
- **Publish a signer's `nostrApi`, never the signer instance.** `private sk` has no runtime effect, so assigning the instance exposes the raw secret key as `window.nostr.sk` to every script on the origin. Don't add a key-export method. → [`docs/signers.md`](docs/signers.md)
- **Never publish a kind:3 follow list you didn't reliably fetch.** A blind republish wipes the user's whole follow list. → [`docs/nostr.md`](docs/nostr.md)
- **Never record an absence you didn't reliably observe.** A null from a relay query means "nobody had it" *or* "nothing answered in time" — any new negative cache must tell them apart. → [`docs/nostr.md`](docs/nostr.md)
- **A Podcast Index "not found" must reach the client as 404, never 500.** A 5xx trips the client-side breaker and disables *all* metadata resolution for the rest of the tab. → [`docs/feeds.md`](docs/feeds.md)
- **A route that fans out to PI must cap the fan-out** and follow probe-first-then-batch — an attacker-chosen list length otherwise turns one request into N parallel PI calls. → [`docs/feeds.md`](docs/feeds.md)
- **The rail picker stays in BOTH boost modals** (`components/rail-picker.tsx`). Letting one pick silently via `pickRail()` was a money bug: a funded Spark wallet sat untouched while boosts went out of an old WebLN extension. → [`docs/wallets.md`](docs/wallets.md)
- **New API route starts with `rateLimit(req, '<route>', N)`** and sets `Cache-Control` on **200 responses only**. Returns `{ error }` via `getErrorMessage(e, fallback)`.
- **All `bmb:*` access goes through the typed helpers in `lib/storage.ts`** — never `localStorage.getItem`/`setItem` anywhere else. New persisted field ⇒ new accessor. → [`docs/storage.md`](docs/storage.md)

## Boost flow invariants

`components/boost-modal/index.tsx` orchestrates; `lib/v4v/boost.ts` is the engine.

0. **Live-stream boosts go out as real NIP-57 zaps** — a branch at the top of `go()`, before the boostagram path, when signed-in + active signer + single lnaddress recipient + host supports NIP-57 (pre-checked via `lnaddrSupportsZaps` BEFORE paying → no double-pay). Uses `sendZap` with `aTag = streamChatAddr(id)`. Falls through to the normal path otherwise. Both paths share `logStoredBoost(legs)` and `maybePublishNote(results)` — extracted so the StoredBoost/publish blocks can't drift. On a real zap the kind:1311 text line is skipped (the receipt already shows); on the fallback it's posted. The modal auto-closes ~1.5 s after success.
1. **Lightning first, then Nostr.** `publishBoostNote` fires only after `sendBoost` returns *and* `collected.some(r => r.ok)`. Don't reorder — inverting publishes false "I boosted" notes when every payment fails.
2. **`pickRail()` = rail pref first, then NWC > Spark > WebLN.** `storage.railPref` wins when that rail is still connected/enabled; otherwise priority order. The user can override per-boost. `storage.railPref.set/clear` notify `subscribeRailPref` so the balance chip, account-menu summary and open wallet modal re-resolve on a switch.
3. **Episode value-block fallback happens server-side** — `app/api/feed/route.ts` does `e.value ?? podcast.value`. Don't re-implement in the modal.
4. **Splits use weights, not percentages.** `ValueRecipient.split` is a weight; total weight is the denominator. `splitSats()` is **largest-remainder (Hamilton)**: floor every share, then hand the leftover sats out one at a time to whoever was rounded down the most, fee recipients losing ties. Every positive-weight recipient is then guaranteed **at least 1 sat**, funded from the largest allocation so the total is preserved — that's what the 100-sat minimum boost is for. The obvious alternative, floor-everyone-then-dump-the-remainder-on-the-first, is the bug this replaced: a 100-sat boost to a 98%/1%/1% block floors both small legs to 0 and sends the whole 100 to the artist.
5. **TLV record `7629169` only.** Boostagram JSON goes there (PC2.0 standard), with `sender_id` inside it. We deliberately do **not** also emit a `696969` sender record — that key collides with shared-node sub-account routing (getalby.com uses `customKey=696969 customValue=<sub-account>`). Per-recipient `customKey`/`customValue` from the value block IS attached to the keysend.
6. **WebLN `customRecords` are plain JSON, not hex.** WebLN providers hex-encode internally; pre-hexing double-encodes and Helipad can't `JSON.parse`. NWC's `pay_keysend` is the opposite — NIP-47 requires hex-encoded TLV. `tlvHexFor` (NWC) vs `recordsForKeysend` (WebLN) look symmetric and are genuinely different wire formats.
7. **Note amount is intent, not actual.** `formatContent` and the `amount` tag use `boostagram.value_msat_total`, not the sum of successful legs. A user who boosts 100 sats with one failed leg still posts "Boosted 100 sats"; the partial breakdown is in the modal and Helipad.
8. **BoostBox is LNURL-only.** `lib/v4v/boostbox.ts` POSTs metadata via `/api/lightning/boostbox` *before* `fetchLnInvoice`, then puts the returned `desc` (`rss::payment::boost <url>`) in the LUD-21 `comment` field. Keysend recipients are untouched (TLV carries the boostagram inline). BoostBox failure is non-fatal; LNURL falls back to `boostagram.message`.
9. **LNURL invoices are amount-verified before paying.** `fetchLnInvoice` and `sendZap` decode the returned BOLT11 via `bolt11AmountMsat` (`lib/v4v/bolt11.ts`, a pure HRP parser shared with the zap-receipt reader) and throw on an amountless invoice or any mismatch — a malicious LNURL server can't substitute a larger one. Strict equality is safe because we only request whole-sat msat values; the throw surfaces as a normal per-leg `{ ok: false, error }`.
10. **Payment order IS display order — `sendBoost` traverses `recipientOrder(recipients)`,** biggest share first, the same helper `<SplitsPreview>` and `<ValueSplitRows>` render by. Feed order is *authoring* order: a live block held the artist at 94.1% (311 of 333 sats) and listed them first in the modal, while four 1-sat housekeeping payees settled with a ✓ ahead of them — the screen said one thing and the wallet did another. It also maximised the failure surface, since legs are sequential and a rail can die mid-boost; descending by weight means a partial failure drops the dust.
    - **It reorders the TRAVERSAL, never the array.** `recipients`, `splits` and `results` stay positionally coupled, so `results[i]` is always `recipients[i]`'s leg. Sorting the array instead would perturb `splitSats`' largest-remainder tie-break by a sat per payee and repoint every positional read downstream. `results` is **pre-sized and assigned by index** — `results.push(r)` type-checks, lints and builds while pairing every leg with the wrong recipient.
    - **`onProgress` reports the recipient's index, not the settle sequence.** Consumers must write `results[index]`; the boost modal's old `[...prev, res]` append was correct only while the two coincided. Its `results` state is therefore `(BoostResult | undefined)[]` — the union is load-bearing, since this repo doesn't enable `noUncheckedIndexedAccess` and a bare `BoostResult[]` would type-check while lying about the holes. `<LightningStatus>` counts what's present rather than reading `results.length`, which is the recipient count from the first render.
    - **Legs stay sequential — never parallelize.** NWC is a single relay connection, WebLN prompts per payment, and `streaming.ts`'s design invariant is that settles are serialized.

**Anonymity applies to the payment, not just the Nostr note — and to BOTH sender fields.** When the share picker's **"Anonymous"** is active (`anonymous = !!identity && shareNostr && shareAs === 'site'`), every boostagram drops `sender_id` and substitutes `sender_name` — single plus boost-all per-track/host/summary legs. Each leaked the identity on its own:

- **`sender_id`** is the user's pubkey, which recipient aggregators resolve to their profile (avatar + name). Shipped first, while the note was already site-signed — the PFP leaked despite the promise. **Omitted outright.**
- **`sender_name`** is the "From" field, which recipients display verbatim **and** which `formatContent` prints into the note body as `<name> boosted N sats`. So the site-signed "anonymous" note still read *"Crimson Rook boosted 100 sats"* under the BMB npub, and `BoostAllModal`'s hand-built `contentOverride` did the same. **Replaced, not omitted** — see below.

**`DEFAULT_SENDER_NAME` (`'boostmebitch.com user'`, defined in `lib/util.ts` and re-exported by `sender-name.tsx`) is a real default, not the input's ghost text.** Both modals call `resolveSenderName(typed, anonymous)` (`lib/util.ts`), which is `(anonymous ? '' : typed.trim()) || DEFAULT_SENDER_NAME`, so it covers two cases at once: an anonymous boost, and any boost where "From" was left empty (every signed-out user who never typed one). Substituting beats omitting because `JSON.stringify` drops an `undefined` key entirely, leaving presentation to each recipient's aggregator — the same boost rendered blank in one and "Unknown" in the next. One const per modal feeds every wire site: the boostagram legs, the local `StoredBoost` (so the log matches what was sent), and `BoostAllModal`'s summary body. **Don't reintroduce a bare `name` at a wire site**, and note the summary line no longer needs a no-name branch — `senderName` is always non-empty. `formatContent`'s `'Boosted …'` fallback stays as library defense.

`<SenderName anonymous>` disables the From input, blanks it, and says the boost is sent as `DEFAULT_SENDER_NAME` — a filled-in "From" beside an anonymity promise reads as *"this is what recipients see"*. The typed value stays in parent state (not wiped), so flipping back to "My feed" restores it, and `storage.senderName` still persists the **typed** name only, never the default — anonymity is about what leaves the device.

**`anonymous` is gated on `identity`.** Signed out, the picker is a bare checkbox with no anonymous option and every note is site-signed, so the typed name is that note's *only* attribution — but `bmb:share_nostr_as` is a single global key, so a user who chose Anonymous while signed in would otherwise sign out and silently have their name replaced by the default, with no control to turn it back on. `sender_id` is unaffected by the gate (it's `identity?.pubkey`, already absent signed out). "My feed"/"Don't post" identify the sender as before.

## Streaming sats — money invariants

The engine is `lib/v4v/streaming.ts` + `lib/v4v/stream-ledger.ts`. **Off by default.** Full reasoning, including valueTimeSplits and the Split Kit live-value channel, is in [`docs/streaming.md`](docs/streaming.md) — read it before touching any of those files. These are the rules you can break from outside them:

**Every rule here follows from one property: this spends money unattended, on a timer, with no confirmation step.** A mistake has no screen in front of it to be noticed on.

- **It is not a new payment path.** Settlement calls the same `sendBoost()` with `action: 'auto'` on the boostagram. Rails, splits, TLV and the lnaddress→keysend upgrade are untouched. Keep it that way.
- **`action` is `'auto'`, not `'stream'`** — a ten-minute lump for time already listened, not a per-minute drip. `lib/v4v/boostbox.ts` must keep downgrading `'auto'` → `'stream'` for LNURL legs, whose enum rejects `'auto'` silently.
- **The ledger is debited BEFORE the payment is awaited.** Crediting after leaves the same sats for the next tick to spend again — a real double-spend. **Losing sats is recoverable; sending them twice is not.**
- **The double-pay guards live on the LEDGER, not the context.** The context is rebuilt on every reload and Fast Refresh while the balance is restored from `bmb:stream_pending` — putting them on the context charged the same track again after a refresh.
- **Settles are serialized** through a promise `chain`. Never parallelize legs or settles.
- **Elapsed time is `min(wall-clock delta, playback-position delta)`, capped at 5 min.** Wall alone bills a sleeping laptop; position alone bills a forward seek.
- **A batch below `max(10, recipientCount)` sats carries instead of sending — even when forced.**
- **Two consecutive failed settles stop streaming for that item.** A dead wallet must not accrue an unpayable debt in silence.
- **`stopStreamingEngine` persists but does NOT settle.** `<Player>`'s cleanup runs on every Fast Refresh — a settling teardown means *editing a comment in dev fires a real Lightning payment*.
- **No Nostr note, no confetti, no `playBoostSound`.** Streaming is ambient.
- **Logs to `bmb:streamed:<npub>`, never `bmb:boosts:*`** — that log is capped and rendered into the user's feed; six settlements an hour would evict real boosts within a day.
- **`sender_id` honors the same anonymity signal as the boost modal.** The background path must not leak a pubkey the user was told doesn't ride along.

## v4v-toolkit swap-out boundary

`lib/v4v/*` and `lib/nostr/` are intentionally the only files that talk to wallets/signers. Components reach them through a deliberately small surface — `lib/v4v/boost.ts` (orchestrator), `nwc.ts`, `spark.ts`, `webln.ts`, `wallets.ts`, `zap.ts`, `streaming.ts`, `stream-ledger.ts`, `live-value.ts`, plus the `lib/nostr/` barrel (and `lib/nostr/google-auth` directly). Swap toolkits by replacing internals here without touching `components/` or `app/`.

**The arrow only points one way, and `DEFAULT_SENDER_NAME` is where that nearly broke.** It lived in `components/boost-modal/sender-name.tsx` — reasonable, that's the "From" field — until `lib/v4v/streaming.ts` needed it and imported it from there, inverting the boundary and dragging a `'use client'` React module into the payment engine. It now lives in **`lib/util.ts`** (with `resolveSenderName`, the one place "From" becomes a wire value), and `sender-name.tsx` re-exports it so every modal import site is unchanged. `lib/util.ts` rather than `lib/v4v/` because it's a *product string*: swapping the toolkit must not delete it.

**`lib/v4v/boost.ts` importing `recipientOrder` from `lib/util.ts` is that arrow pointing the right way** — `lib/util.ts` has only a type-only import, so it drags no React or browser globals into the payment engine. **Keep `recipientOrder` there.** Moving it into `lib/v4v/` would force `components/value-split-rows.tsx` — a read-only component that touches no wallet — to import the payment engine to render a list.

## State + persistence

Zustand store (`lib/store.ts`), **in-memory only**: `identity`, `current`, `isPlaying`, `positionSec`, `playerExpanded` (lifted so a live-stream card can open the player `<Player>` owns), `signInOpen` (lifted so the fullscreen player / live chat can open the modal `<NostrAuth>` owns), `walletOpen` (lifted so any surface can open the one `<WalletModal>` `<AuthControl>` owns), `selectedPodcast` (lifted out of `app/page.tsx` so a podcast-name link in a `<NoteCard>` can flip the layout without prop-drilling), `discussionEpisode` (cleared by `selectPodcast`), `favorites`, `mutedPubkeys`, `boostsTick`, `seekReq` (`{ t, n }`, consumed by `<Player>`).

Everything else lives in `localStorage` and is never sent server-side. **All `bmb:*` keys go through typed helpers in `lib/storage.ts`** — don't call `localStorage.getItem`/`setItem` anywhere else. New persisted field ⇒ new accessor, `bmb:*` prefix.

### `safeSet` must never silently swallow a failed write

A settings control here has no local state — it writes through `storage` and renders whatever reads back. So a discarded write doesn't degrade the UI, it **freezes the control**: tap it, nothing moves, no error anywhere. That shipped, and the reported symptom was "I can't turn on streaming sats in Safari on iOS" — the switch was the most visible casualty precisely because it's a pure read-through.

Two causes, both silent and both real on iOS Safari:

- **A full store.** `setItem` throws `QuotaExceededError` for *every* subsequent write, down to a one-byte `bmb:stream_on`. Safari's per-origin quota is the tightest in the wild and this app caches whole nostr events (`bmb:feed:*` and `bmb:social:*` are unbounded in size, `bmb:profile4:*`/`bmb:pmeta:*` in count), so a long-lived install fills it. **Reads keep working**, which is why nothing else on screen looks wrong and why this is invisible in testing — a fresh profile never reproduces it.
- **A blocked store.** Private Browsing, "Block All Cookies", content blockers — `setItem` throws `SecurityError` and no amount of freeing space helps.

`safeSet` returns whether the value reached disk, and handles both:

- On a full store it **evicts one cache namespace at a time and retries**, in `EVICTABLE_PREFIXES` order (`bmb:social` → `bmb:feed` → `bmb:profile4` → `bmb:pmeta`) — the note blobs first because they're nearly all the bytes, the small-but-numerous caches last because losing them costs a visible refetch. Everything on that list is network-regenerable: **no setting, no identity, no credential.** The rule is **a cache never displaces a setting, and a setting always displaces a cache** — so a failing write of an *evictable* key is left to fail rather than dropping other caches to fit one more cache.
- When the write still can't land, the value goes into `memoryMirror` and `safeGet` reads through it, so the control the user just touched works for the session. `safeRemove` deletes the mirror entry **first** — clearing only disk would let the in-memory copy resurrect a disconnected wallet or a cleared override on the next read — and `safeKeys` unions it, or a memory-held setting is invisible to the scans that count it (`showsExplicitlyOn`).
- Session-only values are surfaced, never hidden: `storage.nwcUri.isEphemeral()` and `storage.streaming.isEphemeral(showKey?)` back soft "won't survive a reload" hints. This generalizes the hand-rolled `memoryFallback.nwcUri` that used to sit in this file for the same reason.

The full `bmb:*` key table — every key, its purpose and its quirks — is in [`docs/storage.md`](docs/storage.md), along with what deliberately does *not* live in `localStorage`.

## Background art and the canvas-bg gotcha

`app/layout.tsx` renders `public/hero.jpg` as a fixed full-viewport layer with a `bg-ink/75` overlay and `<Image fill priority />`. The overlay's opacity mutes the image; in light mode `--ink` flips to cream so the same class becomes a 75% bone wash automatically. Same image doubles as the OG image.

- **The page background is set in CSS (`app/globals.css`, on `html, body`), never as a Tailwind class on `<body>`.** A background applied to `<body>` in the JSX propagates to the canvas and paints over the fixed image layer regardless of z-index — the hero breaks with no errors, just a flat-color page. The CSS rule is safe because the hero layer is a *child* of `<body>` and so paints above body's own background box.
- **`html, body` use `overflow-x: clip`, NOT `hidden`.** `hidden` computes `overflow-y` to `auto`, turning html/body into a scroll container that traps `position: sticky` descendants (the page header scrolled away instead of pinning). `clip` blocks sideways scroll without creating a scroll container. Don't switch it back.
- **Modals must portal to `document.body` — the layout traps `fixed` overlays.** `app/layout.tsx` wraps page content in `<div className="relative z-0">` (to sit above the fixed hero), and `<Player>` is a body-level **sibling** at `z-30`. `relative z-0` creates a **stacking context**, so a `fixed` modal inside page content is sealed in it — its `z-40`/`z-[60]` only competes *within* the wrapper and can never rise above the mini-player (symptom: the player bar paints over the modal footer). Every overlay `createPortal`s to `document.body`, guarded by a mounted `portalTarget` state so SSR renders nothing: `wallet-modal`, `sign-in-modal`, `BoostModal`, `BoostAllModal`, note-card `ZapDialog`. The `BoostModal` opened *from* `<Player>` happened to work pre-portal because it shared the player's body-level context. Modals also add `pb-28` so the centered card clears the mini-player bar.

## Styling tokens

Custom palette in `tailwind.config.ts` — don't introduce new colors without adding them here: `ink` (page bg), `bone` (primary fg), `bolt` (Lightning yellow), `nostr` (magenta), `muted` (secondary), `line` (borders). Fonts: `font-display` (Bricolage Grotesque), `font-mono` (JetBrains Mono). `animate-bolt` is a 1.4 s opacity pulse.

Reusable element classes — `.card`, `.btn`, `.btn-bolt`, `.btn-ghost`, `.input`, `.stamp`, `.headline`, `.seek` — are defined in `app/globals.css`. Read that before inventing new ones.

## Conventions worth keeping

- **A read-only value split renders through `<ValueSplitRows>`** (`components/value-split-rows.tsx`) — the show header, the episode detail page and the fullscreen player's disclosure all use it, ordered by `recipientOrder` (biggest share first; feed order is authoring order and buries the recipient that matters). It was three copies, and they had already drifted: `lists.tsx` carried its own inlined address elision instead of `recipientAddress`, which is exactly what that helper's comment forbids, so the same pubkey rendered differently depending on the screen. **`<SplitsPreview>` in the boost modal is deliberately separate** — it carries per-leg sats and ✓/✗ delivery status against a live payment, and sharing would mean one component branching on a flag.
- **`recipientOrder(recipients)` (`lib/util.ts`) returns INDICES, not recipients.** `<SplitsPreview>` reads `splits[i]` and `results[i]` positionally, so a reordered array would pair each row with someone else's sats and someone else's ✓/✗ — a display bug indistinguishable from a payment bug. The sort is stable, so equal weights keep feed order. **It is no longer display-only:** `sendBoost` traverses by it (invariant 10) and `storedBoostLegs` writes the permanent history record by it, so this one function decides both the payment sequence and how a boost is remembered — and its stability guarantee is now a payment-determinism guarantee. Don't give it fee-awareness or an opt-out: it's shared with `<ValueSplitRows>`, so any semantic change silently restyles the show header, the episode page and the fullscreen player.
- **A sent boost's `StoredBoost.legs` are built by `storedBoostLegs(results)` (`lib/util.ts`)** — three sites hand-rolled the identical `results.map(…)` (`boost-modal/index.tsx`, and twice in `boost-all-modal.tsx`). It orders biggest-share-first because `<BoostCard>` renders `legs` verbatim and a stored leg carries **no `split` weight**, so whatever order is written is permanent and can't be re-sorted at render time — feed order meant the history card listed a payment differently from the modal that sent it, the same complaint as invariant 10 one screen removed. Order derives from `results` alone (`results[i].recipient` *is* `recipients[i]`), so there's no second array to pass out of sync. Boosts stored before this keep feed order; **deliberately not migrated**, since rewriting a user's local money log for cosmetics is a bad trade.
- **`isMusicMedium(podcast)` and `hasValueRecipients(value)` live in `lib/util.ts`** (isomorphic, type-only imports). Use them instead of inlining `podcast.medium?.toLowerCase() === 'music'` or `!!value?.recipients?.length`. `hasValueRecipients` returns a boolean and does **not** narrow its argument — at a site that then uses the value as non-null, assert `value!` after the guard. These are the **boolean gate** helpers; expressions rendering the recipient *count* stay inline.
- **`isHlsUrl(url)` and `fnvHash(s)` also live in `lib/util.ts`.** `isHlsUrl` (matches `.m3u8`) branches the HLS-video path from native `<audio>`. `fnvHash` is the FNV-1a → stable 31-bit int for deterministic numeric IDs; one copy, imported by `lib/pi.ts` and `lib/nostr/live-streams.ts`.
- **Transport buttons go through `<TransportControls size>`** (`components/transport-controls.tsx`) — never re-inline ⏮/play/⏭. It reads playback + `episodeQueue` from the store, computes prev/next-disabled, and renders as a fragment into the parent's flex row.
- **Live-stream id parsing goes through `lib/nostr/live-streams.ts` helpers** — `streamIdOf` / `parseStreamId` / `isLiveStreamId`, and `streamChatAddr` in live-chat.ts.
- **Time-of-day formatters live in `lib/format.tsx`:** `fmtClock(unixSec)` and `fmtLiveTime(unixSec)` (clock for today, else "Mon D <clock>"). `fmt`/`fmtDuration` are for playback *durations*, `timeAgo` for relative. Don't re-inline `toLocaleTimeString`.
- **`NoteCard` is memoized** (`memo(NoteCardImpl)`). Feed surfaces re-render wholesale (podcast metadata resolving, `boostsTick`) and note refs are stable, so memo skips untouched cards. Two rules keep it correct: `repostedIds` must be **replaced, not mutated in place**, and store-driven values (identity, mutes) stay read via `useApp` selectors *inside* the component so they bypass memo.
- **Horizontal card rows use `useHorizontalWheelScroll()`** (`lib/use-horizontal-wheel.ts`) — a mouse has no sideways wheel, so without it the off-screen cards are unreachable. React's `onWheel` is passive, so the listener attaches natively, and it hijacks the gesture only when the row overflows, the gesture is vertical, and it isn't at the edge, so page scroll still takes over at the end. **It returns a callback ref** — `const rowRef = useHorizontalWheelScroll<HTMLDivElement>()` then `<div ref={rowRef}>` — and that's load-bearing: both consumers render a skeleton with no ref until data resolves, so a `useEffect` reading `ref.current` sees null, bails, and never re-runs unless its dep array happens to change when the row mounts. The original leaned on `[podcasts.length]`/`[resolved.length]` for exactly that, which reads like an unrelated perf dep and got "simplified" away once, silently killing the wheel on both rows. A callback ref has no dependency to get wrong.
- **`<FavHeart>` lives in `components/fav-heart.tsx`**, not `lists.tsx` — three surfaces render it (`lists.tsx`, `fullscreen-player.tsx`, `podroll.tsx`), and having `podroll.tsx` import it from `lists.tsx` while `lists.tsx` imports `<Podroll>` made a module cycle. `lists.tsx` re-exports it. It calls `stopPropagation()`/`preventDefault()` itself, so it's safe inside a clickable row. **`size` variants:** `'sm'` (default, list rows and podroll cards) is a slim border-chip; `'md'` (show header) matches `.btn-ghost` so it's a peer to SHARE and BOOST. Both render `[♡ FAVORITE]` / `[♥ FAVORITED]` (magenta when on) — don't reintroduce the old bare-glyph `♡` without rethinking the header cluster.
- **Profile avatars go through `<Avatar>`** (`components/avatar.tsx`) — `<img src={picture}>` with a deterministic colored-initial `<DefaultAvatar>` fallback on error/missing. For *user* avatars, distinct from `<PodcastCover>`.
- **Podcast artwork goes through `<PodcastCover>`** (`components/podcast-cover.tsx`). Tries `image`, falls back to `artwork` on `onError`, then a colored-initial tile. The two-URL fallback exists because PI returns RSS `<image><url>` as `image` and `<itunes:image>` as `artwork`, and they often disagree (Homegrown Hits has a dead `image` but a working `artwork`). Always pass both. Uses `<img>`, not `next/image` (arbitrary hosts); the local hero IS served via `next/image`.
- **Auxiliary relay sets use `withExtraRelays`** (`lib/nostr/pool.ts`) — it dedupes the union, runs the query in the closure, and closes only newly-opened extras in `finally`. Don't write the open/track/try-finally/close pattern inline; four near-identical copies were collapsed.
- **Browse-mode layout is single-column** in `app/page.tsx`. Selecting a podcast sets `selectedPodcast`, flipping to detail view; `discussionEpisode` adds a third full-page view. Both are state-driven swaps, not routes. Don't reintroduce a right-pane "select a podcast on the left" empty state.
- Native HTML5 `<audio>` plays the enclosure URL directly — no proxy, no transcoding. The one exception is HLS live streams.
- **API routes** return `{ error }` JSON via `getErrorMessage(e, fallback)`; clients swallow errors silently. New routes start with `rateLimit(req, '<route>', N)` (per-IP, 60 s window; by-guid runs at 300/min to absorb the favorites-hydration burst) and set `Cache-Control` on **200 responses only**.
- **A route that fans out to Podcast Index must cap the fan-out, and the cap belongs on any list that came from a feed.** `/api/publisher` used to `Promise.all` `getPodcastByFeedUrl` over *every* album URL in a third-party publisher feed — an attacker-chosen list length turning one cheap request into N parallel PI calls, a request-amplification lever aimed at our own PI quota. It now slices to `MAX_PUBLISHER_ALBUMS` and follows **probe-first-then-batch**. The probe is deliberately **uncaught** — `getPodcastByFeedUrl` already turns PI's 400/404 into `null`, so a throw means PI itself is down and the resulting 5xx is exactly what should trip the client-side breaker.
- **Inline SVG `BoltIcon`** (`components/icons.tsx`) on yellow buttons — the `⚡` emoji is invisible on `bg-bolt`. Yellow-text-on-dark and V4V stamps keep the emoji. `ShareIcon` and `Sun`/`MoonIcon` follow the same inherits-`currentColor` pattern.
