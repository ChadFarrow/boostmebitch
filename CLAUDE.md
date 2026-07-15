# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Names

- **`boostmebitch`** — repo, working directory, npm package name, and `APP_NAME` default for the Podcast Index `User-Agent`.
- **"Boost Me Bitch"** — display name in the page header and `<title>`.
- **`BoostMeBitch`** — `app_name` in the boostagram TLV JSON and `client` tag on Nostr notes (CamelCase, no spaces — matches the Helipad-aggregator convention used by Fountain, StableKraft, etc.).

The README at the repo root is the architecture spec; treat overlap with this file as the README's job, not CLAUDE.md's.

## Commands

```bash
npm install
cp .env.example .env.local       # PI key + secret (Spark rail needs no key)
npm run dev / build / start / lint
```

**No test runner, no formatter.** Checks are `npm run typecheck` (`tsc --noEmit`, strict), `npm run lint` (ESLint 9 flat config in `eslint.config.mjs` — `next/core-web-vitals` + `next/typescript`, `no-explicit-any` off for PI's untyped JSON), and `next build`. Path alias: `@/*` → repo root.

`.env.local`: `PODCAST_INDEX_KEY`/`SECRET` (server-only), `APP_NAME` (optional). The Spark rail (`@buildonspark/spark-sdk`) needs **no** API key — it talks straight to Spark's signing operators.

## Server vs client boundary (don't cross it)

Podcast Index credentials must never reach the browser. Enforced by file conventions, not bundler config:

- **Server-only:** `lib/pi.ts` (uses `node:crypto`, reads `process.env`). Imported only by `app/api/*`. The BoostBox proxy at `app/api/lightning/boostbox/route.ts` follows the same pattern (reads `BOOSTBOX_URL`/`BOOSTBOX_API_KEY` and forwards). `lib/safe-fetch.ts` (`assertSafeFetchUrl` — SSRF guard called inside the try of every server-side RSS fetch in `lib/pi.ts` + `lib/musicl-resolver.ts`; hostname-level only, no DNS-rebinding protection) and `lib/rate-limit.ts` (per-IP sliding-window limiter, first line of every API route) are server-only too.
- **Browser-only:** `lib/store.ts`, `lib/v4v/nwc.ts`/`webln.ts`/`lnaddr.ts`/`spark.ts`/`boostbox.ts`, `lib/nostr/`, `lib/storage.ts`, `lib/podcast-meta.ts` — they touch `window.*`, storage, IndexedDB, or load WASM. SSR guards exist but assume client context.
- **Isomorphic:** `lib/types.ts` (pure types), `lib/v4v/boost.ts` (orchestration).

Components fetch via local API routes (`fetch('/api/feed?id=…')`) — never call PI directly.

## Nostr identity enrichment

`loginWithExtension()` returns only `{ pubkey, npub }` from NIP-07. After login, `components/nostr-auth/index.tsx:loadProfile` runs in the background and merges these in parallel:

- **Profile metadata (kind:0):** `name`, `display_name`, `picture`, `nip05`, `about` — header avatar, boost modal "From" auto-fill.
- **NIP-65 relay list (kind:10002):** unmarked + `write` entries → publish target.
- **NIP-51 favorites (kind:30003, `d:boostmebitch:favorites`):** see Favorites.
- **NIP-51 mute list (kind:10000):** public + NIP-04 private p-tags. See Mutes.
- **Spark wallet backup (kind:30078, `d:boostmebitch:wallet:spark`):** NIP-44 v2 encrypted-to-self mnemonic. Best-effort silent restore; failures are swallowed.
- **Synced settings (kind:30078, `d:boostmebitch:settings`):** NIP-44 encrypted-to-self JSON; currently just `railPref` (last-used boost rail) → applied to `storage.railPref`. `lib/nostr/settings-backup.ts`.
- **NWC connection backup (kind:30078, `d:boostmebitch:wallet:nwc`):** NIP-44 encrypted-to-self `{ uri }`, **opt-in only**. Restored to `bmb:nwc_uri` when this device has no NWC URI yet. See Wallets. `lib/nostr/wallet-backup.ts`.

NIP-07 perms ever requested: `getPublicKey`, `signEvent`, `nip04.{en,de}crypt` (private mutes), `nip44.{en,de}crypt` (wallet backup). No kind:3 contacts, no DMs, no reactions.

**Fast-path identity hydration.** On page load, `nostr-auth/index.tsx` decodes cached `bmb:npub` synchronously via `nip19.decode`, sets a bare `{ pubkey, npub }` identity, and reads `storage.profile.get(pubkey)` + `storage.favorites.get(npub)` + `storage.muted.get(npub)` into the store within the same frame. The signer is only called lazily, when something actually needs to sign.

**Relay query timeouts.** Every `pool.querySync` site passes a `maxWait` from `lib/nostr/pool.ts`: `QUERY_MAX_WAIT_MS = 4000` for single-author lookups (kind:0/10000/10002/30003/30078/6) and `FEED_QUERY_MAX_WAIT_MS = 8000` for broad feed scans (kind:1 with `#i`/`#k`, reply-tree BFS, bulk profile fetches). Without these, a stalled relay pins the tab in loading. The 4s/8s split balances spinner duration vs. completeness. **Single-latest-event lookups don't querySync:** `fetchLatestEvent` (`lib/nostr/event-queries.ts`, behind profile/favorites/mutes/settings/wallet-backup reads) uses `subscribeMany` and resolves at the earliest of all-relays-EOSE, **1.5s after the first matching event** (grace window for a newer replaceable version), or `maxWait` — querySync waits for every relay, so one dead relay in a 20-relay union pinned every restore at the full timeout.

`resolvePublishRelays(identity)` in `lib/nostr/relays.ts` is the single source of truth for publish targets: localStorage `bmb:relays` override → otherwise the identity's NIP-65 write relays **unioned with `DEFAULT_RELAYS`**. Capped at 20. The union (rather than write-relays-*instead-of* defaults) is deliberate: a user whose NIP-65 write relays are all dead/unreachable/AUTH-gated was getting "published to 0/N relays" even though the boost itself paid — always including the known-good defaults guarantees the note lands somewhere. A manual `bmb:relays` override is still used as-is (advanced users opt out).

**`sanitizeRelays(urls)`** (also `lib/nostr/relays.ts`) drops any entry that isn't a parseable `ws://`/`wss://` URL (gated on `new URL()`), then dedupes and strips trailing slashes. Applied at **every point an untrusted relay list enters a pool query**: the NIP-65 parse in `fetchRelayList`, the output of `resolvePublishRelays` (covers the `bmb:relays` override too; falls back to `DEFAULT_RELAYS` if sanitizing empties the list), and — in the feed path (`lib/nostr/discover.ts`) — `fetchAuthorWriteRelays` (other authors' NIP-65 `r`-tags), `fetchQuotedEvents` (`q`/`e`/nevent quote-ref hints), and `fetchSocialInteractThread` (nevent hints). A corrupt entry — e.g. a NIP-65 `r`-tag value of `"avatar wss://purplerelay.com"`, or a spammer's ad stuffed into an `r`-tag as `"wss://SOLUTION TO ALL PHONE HACKING…, …"` (note: a bare `startsWith('wss://')` check does **not** catch this — only `new URL()` does, because the comma in the host is what throws) — otherwise reaches nostr-tools' `normalizeURL`, which **throws `Invalid URL` synchronously inside `pool.querySync`/`subscribeMany`**; that rejection escapes per-call try/catch and aborts the whole flow (it killed the Spark "Create new" backup check, and surfaced raw spam as a feed error on show pages). A survivor of `sanitizeRelays` is guaranteed to parse, so `normalizeURL` can't throw on it. Defense in depth: `collectEventsByAuthors` (`lib/nostr/event-queries.ts`) also wraps its `subscribeMany` so a relay that slips past sanitizing resolves the query empty instead of aborting.

## Signers (NIP-07 + Amber NIP-55 + NIP-46 bunker)

The whole codebase reads from `window.nostr`. Three signer paths feed it, swapped in/out by `lib/nostr/signer.ts`:

- **NIP-07 extension** (Alby, nos2x, Flamingo, nostash on iOS Safari). Already at `window.nostr`; we don't polyfill. Sign-out clears `bmb:npub` but leaves `window.nostr` alone.
- **Amber on Android** (NIP-55, `lib/nostr/amber.ts`). Polyfills `window.nostr` with an `AmberSigner` that dispatches via `nostrsigner:` URL scheme and reads results back from the system clipboard. Round-trip: `nostrsigner:<urlEncoded payload>?compressionType=none&returnType=event&type=<…>` (no callbackUrl per spec) → user approves in Amber → first user gesture (`pointerdown`/`touchstart`/`keydown`) reads the clipboard with fresh transient activation. `restoreAmberSigner(pubkey)` is the synchronous fast-path on page load.
- **NIP-46 bunker / remote signer** (`lib/nostr/bunker.ts`, wraps nostr-tools `BunkerSigner`). Two flows: paste a `bunker://` URI or generate a `nostrconnect://` URI. Reconnect on reload is async (`restoreBunkerSigner()` rebuilds from `bmb:bunker:{uri,clientSk}`); signing calls before it resolves throw, but nothing signs unprompted post-load. Compatible with **Clave** (iOS-native, APNs-driven), **nsec.app**, **Amber-as-bunker**, Primal.

> **`nostr-tools` is pinned to exact `2.19.4` — do NOT bump or relax the caret.** The `2.20.0+` NIP-46 rewrite added `limit: 0` to the `nostrconnect`/bunker subscription filters (`fromURI` + `setupSubscription`). On the relays we use, that silently drops the remote signer's connect-ack, so **Primal's `nostrconnect://` "scan/paste a URI" login hangs and times out**. `2.19.4` (no `limit: 0`) is the last known-good version; latest (`2.23.5`) and `master` still carry the regression. `npm update` or a `^`/`~` range will reintroduce the break. `NOSTRCONNECT_RELAYS` in `bunker.ts` is the 4-relay set (`nsec.app`/`damus`/`primal`/`nos.lol`) for connect-ack redundancy — single-relay loses the ack when iOS Safari suspends the WebSocket during the app-switch to the signer.

### `lib/nostr/signer.ts` — the swap point

Only one polyfill is active at a time. `captureOriginal()` snapshots the underlying NIP-07 extension on first activation so deactivation can restore it. `bmb:signer` holds `'amber' | 'bunker' | absent` so the fast-path useEffect knows what to restore. Capability accessors live here too: `getNip04()`/`getNip44()` (return API or null), `requireNip44()` (throws). Use these instead of inlining `typeof window !== 'undefined' && window.nostr?.nipXX`.

### Sign-in UI — one button → `<SignInModal>` (`components/nostr-auth/sign-in-modal.tsx`)

The header shows a single **"Sign in with Nostr"** button (`components/nostr-auth/index.tsx`); clicking it opens a portal'd two-tab modal (same overlay pattern as `wallet-modal.tsx`):

- **Browser Extension** — `loginWithExtension` (NIP-07). The "Connect with Extension" button is disabled with a hint when `window.nostr` is absent.
- **Remote Signer** — both options stacked: *Option 1 — Generate QR* (`nostrconnect://` via `loginWithNostrConnect`, with QR + copy) and *Option 2 — Paste Bunker URI* (`loginWithBunker`), plus a **"Sign in with Amber"** button (`loginWithAmber`) on Android. Default tab when no extension is detected.

Both tabs are always available so a desktop extension user can still pick a remote signer. The modal owns its own per-method busy/error state and the **iOS visibility-retry** that re-attempts the nostrconnect handshake when Safari suspends the relay WebSocket on app-switch. On success it calls back to `index.tsx:completeSignIn(id, kind)`. `login-methods.tsx` now holds only the shared `<AmberCompletion>` clipboard-recovery helper (the old per-platform `signin()` branching, `OtherSignIn` disclosure, and extension re-detection effect were removed).

**The modal open-state lives in the store** (`signInOpen` / `setSignInOpen`), not local `<NostrAuth>` state, so other surfaces (the fullscreen player header, the live-chat composer prompt) can open the one modal `<NostrAuth>` owns without leaving the page — don't mount a second `<NostrAuth>` (it would double the profile-load / focus-listener effects). `SignInModal` is portal'd at `z-[60]` so it renders above the fullscreen player (`z-50`).

### Account-change detector

One `window.focus` listener in `components/nostr-auth/index.tsx`, active only while signed in via a NIP-07 extension (`bmb:signer` absent). Re-calls `getPublicKey()` (throttled 30s); if the active account changed, drives `loginWithExtension` + `completeSignIn` to switch identities. Multi-identity Alby/nos2x users are first-class. Extension presence is otherwise read at modal-open time (the modal does its own `window.nostr` check), so there's no separate install-while-open re-detection effect anymore.

### Lifecycle observables

- **`subscribeAmberStage(fn)`** in `amber.ts` — `'idle' | 'awaiting' | 'returned'`. `<AmberCompletion>` flips its hint copy in lockstep with `invokeAmber`'s real lifecycle. While in flight it always shows a "◆ Read clipboard manually" button + paste textarea — `visibilitychange` is unreliable on standalone-PWA returns, so the user always has a tap-able path.
- **`subscribeBunkerHealth(fn)`** in `bunker.ts` — `boolean` (stale or not). Adapter calls run through `trackBunkerCall` with a 30s timeout. `<BunkerHealthBanner>` inside `<AccountMenu>` shows "Signer disconnected — Reconnect" calling `restoreBunkerSigner()`. Targets the iOS-PWA-suspended-WebSocket case.

## PWA install

`public/manifest.json` + `public/sw.js` + `<SwRegister>` (mounted in `app/layout.tsx`). Display mode `standalone`; icons in `public/icons/` + `public/icon.svg`; iPhone splash screens in `public/splash/`. Header has `pt-[env(safe-area-inset-top)]` so the bolt + title clear the iPhone notch in standalone mode.

**The SW has no precaching.** Next.js emits hashed bundle URLs that change every build, so any stale cache would silently break installed users. The empty `fetch` handler exists only so Chrome/Edge surface the install prompt.

## Favorites (NIP-51 kind:30003)

♡ on a podcast row toggles a favorite. Authoritative event: kind:30003 with `d:boostmebitch:favorites`, one `i: podcast:guid:<guid>` + `k: podcast:guid` per favorite. Cache: `bmb:favorites:<npub>` (or `:guest`) holds the full `FavoritePodcast[]` for instant render. Toggles are optimistic; publish is **debounced 1.5s** via `schedulePublishFavorites`. Hydration in `loadProfile` does last-write-wins on `event.created_at` vs newest local `addedAt`, then resolves unknown guids via `/api/by-guid`.

**UUID filter at parse:** `lib/nostr/favorites.ts` enforces a UUID shape on every `i: podcast:guid:<value>` tag. Older versions (and other clients reusing the d-tag) wrote feed IDs and arbitrary strings. Bad values are returned as `droppedGuids`; when count > 0, `nostr-auth/index.tsx` registers `window.bmbCleanFavorites()` so the user can republish a cleaned event from devtools.

Sign-out clears in-memory favorites; the per-npub cache is left so re-signing in is fast. No episode-level favorites, no list categories, no share UI.

## Mutes (NIP-51 kind:10000)

🚫 on a `<NoteCard>` mutes that author. Interoperates with Damus/Amethyst/Coracle. `MuteListState` in `lib/nostr/mutes.ts` has parallel **public** p-tags (in event tags) and **private** p-tags (NIP-04-encrypted JSON tag-array in `event.content`). New mutes go to private (Damus default); when the signer doesn't expose `nip04`, the read path parks the raw ciphertext in `unreadablePrivateContent` and the publish path passes that blob through verbatim — we never destroy private mutes set in another client. New mutes degrade to public p-tags in that case. Non-`p` tags (`e`, `t`, `word`) are also preserved verbatim.

Filtering is at render time (`<NoteCard>` early-returns null; feeds filter top-level + replies before mapping). Storage `bmb:muted:<npub>` is `MuteListState` JSON; `lib/storage.ts` auto-promotes the legacy `{ pubkeys, otherTags }` shape on read. Account menu surfaces a collapsible "Muted accounts (N)" with kind:0 lookups firing only while expanded.

## Wallets — account menu

All wallet config now lives in **`components/wallet-modal.tsx`** — a portal'd overlay opened by `<WalletButton>` inside `<AccountMenu>` (`components/nostr-auth/account-menu.tsx`). The modal is portal'd to `document.body` so `position: fixed` resolves against the viewport, not the sticky `<header>` (the header's `backdrop-blur` creates a containing block for fixed descendants per CSS spec — without the portal, mobile renders it clipped to the header).

All three sub-cards (NWC, Spark, WebLN) render unconditionally — each flips internally between its connected card and its connect form. This lets the user wire up a second rail (or switch wallets) without first disconnecting the active one. WebLN only appears when `weblnAvailable` (extension injected).

Sub-cards (each its own component): `nwc-wallet.tsx`, `spark-wallet.tsx`, `webln-wallet.tsx`. State changes propagate via `subscribeNwc()` + `subscribeSpark()`; the modal `setTick`s on either to flip between modes without remount.

**NWC Nostr backup (opt-in).** `nwc-wallet.tsx` has an **"Encrypt & back up this connection to Nostr"** checkbox on both the connect form and the connected card (default **off** — an NWC URI is a budgeted spending credential). On → `publishEncryptedNwc` (kind:30078, `d:boostmebitch:wallet:nwc`, NIP-44 encrypted-to-self `{ uri }`) + `storage.nwcBackup.set(npub)`. Off → `deleteEncryptedNwc` tombstones it (empty-content replaceable event; `fetchEncryptedNwc` treats empty content as "no backup") + clears the flag. Gated on a NIP-44-capable signer (`getNip44()`). Auto-restored in `loadProfile` when the device has no local NWC URI. Unlike the Spark seed (always backed up), this is explicit-opt-in + deletable.

Load-bearing details:
- **Two restore layers.** `loadProfile` is best-effort (relay query + NIP-44 decrypt can lose a race or time out; failures swallowed). The safety net is in `nwc-wallet.tsx`: when the connect form mounts with no local URI and a NIP-44-capable identity, it quietly runs `fetchEncryptedNwc` itself ("Checking Nostr for a saved connection…") — at most once per npub per page load (module-scope `autoCheckedNpubs` Set, so reopening the modal doesn't re-query). The manual "↩ Restore from Nostr backup" button remains for retries. Every restore path (login-time, form auto-check, manual) calls `markNwcRestored(npub)`; the connected card shows a one-time "✓ Connection restored from your Nostr backup" notice and clears the flag on unmount, so it appears on the first wallet-modal view after a restore only.
- **The card checkbox reads `storage.nwcBackup.get(npub)` live** (not init-once state), so an auto-restore or an async-arriving identity is reflected. The form keeps a local opt-in boolean (applied on Connect).
- **`disconnect()` awaits the tombstone** before clearing the local URI/flag. A failed delete keeps the connection (so the user can retry) rather than fire-and-forgetting — otherwise the still-present encrypted event would silently auto-restore on the next login.
- **Sign-out and npub-switch clear the global `bmb:nwc_uri` + the per-npub flag** (`signout()` / `completeSignIn` in `nostr-auth/index.tsx`). `bmb:nwc_uri` is a single global key; without this, the next account on a shared device would inherit the previous one's wallet (and its own restore, gated on `!hasNwc()`, would be blocked).

**Boost modal rail picker.** Single-boost `BoostModal` picks a rail silently via `pickRail()` (NWC > Spark > WebLN priority); the only mid-modal feedback is the "no wallet connected" hint when `!rail`. The visible "Pay via [NWC] [Spark] [WebLN]" pill row lives in `BoostAllModal` (`components/boost-all-modal.tsx`) — see the boost-all section below. Both modals subscribe to `subscribeNwc`/`subscribeSpark` so a wallet connected mid-modal updates `rail` without remount. WebLN doesn't have its own subscribe (the extension is either injected at load or it isn't), so `hasWebln()` is read on each render.

`<BunkerHealthBanner>` still sits at the top of `<AccountMenu>` (not the wallet modal), since it's signer health, not wallet health.

**Wallet balance display.** Two surfaces share one hook:

- `<WalletBalanceChip>` inside the `<AccountMenu>` trigger button — always-on glance, follows priority order.
- `<BoostModalBalance rail={rail}>` in the boost-modal sticky footer — accepts the modal's selected rail so the displayed balance always tracks the picker. Turns nostr-magenta when `amountSats > balance`.

Both come from `components/wallet-balance.tsx`. `useWalletBalance(railOverride?)` returns `{ balance, rail }`. With no override, priority is **NWC > Spark > WebLN** (matches `pickRail()` in `lib/v4v/boost.ts`). With an override, the hook fetches that specific rail's balance, collapsing to null if the override points at a disconnected/disabled rail.

- **Spark branch** mirrors `<ReadyPanel>`: subscribes to `subscribeSparkEvents` (`paymentSucceeded`/`claimedDeposits`/`newDeposits`/`synced`) and runs a 2s/5s/12s retry schedule after attach so a fresh restore doesn't sit on a stale 0.
- **NWC branch** uses `nwcGetBalance()` (NIP-47 `get_balance`, msat → floor to sats) plus `subscribeNwcNotifications` for `payment_received`/`payment_sent` push when supported. Falls back to `visibilitychange`/`focus` refreshes for wallets that don't support notifications.
- **WebLN branch** is gated on `isWeblnEnabled()` — module-level state set when the user explicitly clicks "Enable for this site" or completes a WebLN payment. We do **not** call `wl.enable()` speculatively to read balance, since that would prompt the user. After enable, `weblnGetBalance()` calls `wl.getBalance()` (defensively handling `currency: 'msat' | 'btc'` since the spec leaves the unit free). No notifications API in WebLN, so refresh fires on `subscribeWebln` events (post-payment notify) + `visibilitychange`/`focus`.

All three balance helpers swallow errors and return null so a missing capability (NWC connection without `get_balance` permission, WebLN provider without `getBalance`) just hides the chip rather than throwing.

**Last-known balance cache.** `useWalletBalance` writes the live `{ rail, balance }` to `storage.walletBalance` (per-npub) on every successful fetch, and reads it back on mount as a fallback. Without it, a returning user sees a blank chip for 5-10 s while the Spark wallet cold-restores (relay query for the kind:30078 backup → NIP-44 decrypt → SDK load → `SparkWallet.initialize()` → initial sync). With it, the chip paints the cached number instantly and only swaps to the live value once the SDK is ready. Cleared on explicit Spark/NWC disconnect (`<SparkWallet>` and `<NwcWallet>` call `storage.walletBalance.clear(npub)`). The cached balance is only paired with a matching live rail — we never show a stale Spark balance under an NWC label.

## Spark rail (Spark Labs SDK)

`lib/v4v/spark.ts` wraps `@buildonspark/spark-sdk` (the SDK ships an `eventemitter3`-based `SparkWallet`). The heavy SDK only lands in the bundle on first wallet open (dynamic import inside `sparkInitFromMnemonic`). No API key — the SDK talks directly to Spark's signing operators.

Load-bearing rules:

1. **BOLT11 only.** Spark cannot keysend. `lib/v4v/boost.ts` rejects every `node`-type recipient on the Spark rail per-leg with a clear error. lnaddress works because `payOne` fetches a BOLT11 from the LNURL-pay callback first.
2. **Account number = the SDK's per-network default (1 on mainnet, 0 on regtest).** `sparkInitFromMnemonic` sets `accountNumber: network === 'regtest' ? 0 : 1`. Spark's mainnet default is **1**, and Primal + BlitzWallet both use the default — so mirroring it makes the same seed derive the **same account and balance** as those wallets. ⚠️ Hardcoding `0` on mainnet derives a *different, empty* account (this was the first-cut bug — symptom was a connected wallet stuck at 0 sats). There is **no auto-migration** from the old Breez wallets (Breez derived its own keys); users must paste/restore a seed.
3. **Network is `MAINNET` or `REGTEST` — no public testnet exists.** Our `network?: 'mainnet' | 'regtest'` arg maps to the SDK's `options.network` (`'REGTEST'` for dev against a local node, else `'MAINNET'`).
4. **Init returns `{ wallet }`.** `const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed, accountNumber: 0, options: { network } })`. No `storageDir`/`walletStorageDir` concept — that was Breez-only (the SDK keeps no local WASM storage dir we manage).
5. **Send is one-shot.** `sparkPayInvoice` calls `sdk.payLightningInvoice({ invoice, maxFeeSats: 100 })`. The preimage is **not** returned synchronously, so we return `''` (`BoostResult.preimage` is optional and unread by the UI).
6. **Receive.** `sparkReceiveInvoice` calls `sdk.createLightningInvoice({ amountSats, memo })` → BOLT11 at `result.invoice.encodedInvoice`. The SDK exposes no settle fee here, so `feeSats` is always 0 (ReadyPanel hides the fee line when 0).
7. **Balance.** `sparkGetInfo` reads `sdk.getBalance()` → `satsBalance.available` (bigint, `Number()`-cast), falling back to the deprecated `balance` field.
8. **Events drive the balance, not polling.** `subscribeSparkEvents()` registers `eventemitter3` `.on`/`.off` handlers and maps SDK events into the existing `SparkSdkEvent` union: `'transfer:claimed'` → `paymentSucceeded`, `'deposit:confirmed'` → `claimedDeposits` (both clear the open deposit invoice in `<ReadyPanel>`), `'balance:update'`/`'stream:connected'` → `synced` (plain refresh). The `newDeposits`/`optimization`/`lightningAddressChanged` union arms are no longer emitted but kept so consumers don't change.

**Onboarding (3 paths in `components/spark-wallet.tsx`).** Paste an existing seed (the Primal-balance-sharing path), **Create new** (mints via `sparkGenerateMnemonic`, SDK-independent `@scure/bip39`), or **Restore from Nostr**. All publish the seed encrypt-to-self as kind:30078 (`lib/nostr/wallet-backup.ts`) so silent auto-restore works next load; paste/create confirm before overwriting a *different* existing backup (kind:30078 is NIP-33 replaceable — newer wins, prior is gone forever).

**Restore-side relay union.** `fetchEncryptedMnemonic` queries `resolvePublishRelays(identity) ∪ DEFAULT_RELAYS` (deduped, capped at 20) with the longer 8s `FEED_QUERY_MAX_WAIT_MS`. Otherwise a fresh Android Amber sign-in (where NIP-65 hasn't hydrated yet) falls back to defaults and misses backups on the user's outbox relays. `publishEncryptedMnemonic` stays on `resolvePublishRelays(identity)`.

**Post-restore balance race.** `<ReadyPanel>` attaches the SDK event listener BEFORE the first balance call, then re-polls at 2s/5s/12s. Otherwise the SDK's initial sync after `initialize()` can complete between init resolving and the listener attaching, leaving the panel stuck at a cached 0.

## Show-level boost

`BoostModal` accepts `episode` as optional. When omitted (`isShowBoost = !episode`):

- Headlines podcast title, skips the playback-timestamp line.
- Reads value from `podcast.value`.
- Boostagram includes `podcast`/`feedID`/`url`/`remote_feed_guid`, skips `episode`/`itemID`/`episode_guid`/`remote_item_guid`. `ts: 0`.
- Auto-formatted note body skips the `📻 <episode>` line and the `podcast:item:guid:` `i`-tag.

The "⚡ BOOST" button on the `EpisodeList` header opens this mode (gated on `showHasValue`). The per-episode boost path in `Player` is unchanged.

**Per-track BOOST on each row.** Every `EpisodeList` row also carries a far-right `⚡ BOOST` button (`boostTrack` state → `<BoostModal episode={boostTrack}>`), shown when `hasValueRecipients(e.value)`. `ev.stopPropagation()` keeps it from triggering the row's play/open handler. Not music-only — any feed whose tracks carry a value block gets it.

## Episode list pagination + music-feed behaviors (`EpisodeList`, `components/lists.tsx`)

`/api/feed` returns up to ~50 episodes and they all arrive client-side at once, so pagination is pure client-side slicing — no extra fetch. `EpisodeList` holds `visibleCount` (starts at 10, reset to 10 in the `[feedId]` effect on podcast switch) and renders `data.episodes.slice(0, visibleCount)`. A **"Load more episodes (N)"** `.btn-ghost` (N = remaining) sits right after the `<ul>` and reveals +10 per tap; it's gone once all are shown.

Two load-bearing choices: (1) **A button, not infinite scroll** — the per-podcast Nostr comments feed renders *below* the episode list, and auto-loading on scroll would make the list grow as the user scrolls toward the comments ("footer runs away"), burying them on mobile. The button keeps the comments at a stable, reachable position. (2) **No fixed-height inner scroll box** — that would be a second scroll container fighting mobile momentum scroll, the sticky `top-[var(--app-header-h)]` header, and the mobile `scrollIntoView` fix (the panel is brought into frame on `window.innerWidth < 1024` when a podcast is tapped). Slicing keeps the page a single scroll container. The section-divider labels ("Live & upcoming" / "Episodes") derive `prev` from the **sliced** array so they stay correct.

**Music feeds (`isMusic = isMusicMedium(data.podcast)`) behave like albums, not podcasts:**

- **No pagination** — `visibleEpisodes = isMusic ? data.episodes : data.episodes.slice(0, visibleCount)`. The whole album shows at once; `remaining` is 0 so the "Load more" button never renders. (Still capped at the ~50 `/api/feed` returns.)
- **Row tap plays the track** instead of `openEpisode(e)` (tracks carry little extra metadata, so the detail page isn't worth it). Non-music rows still open the detail view.
- **Header album art is a play button** — when `isMusic && firstPlayable`, the header `<PodcastCover>` is wrapped in a `<button>` with an always-visible `bg-ink/45` scrim + `▶`/`❚❚` glyph (same overlay pattern as the per-row play button). Click plays the album from `firstPlayable` (first non-pending track), or toggles play/pause if a track from this show is already current (`showIsCurrent`, matched by `podcastGuid`/`id`).

## Players (mini + fullscreen)

Two surfaces share one `<audio>` and the store's playback state: the always-mounted mini-player (`components/player.tsx`, fixed bottom bar) and the `<FullscreenPlayer>` (`components/fullscreen-player.tsx`) it opens on tap. **`<Player>` is mounted in `app/layout.tsx`** (the root layout), not in any page — so playback and the fullscreen overlay survive route changes (e.g. browse ↔ `/stream/<naddr>`).

- **Transport controls are shared.** `<TransportControls size="sm"|"lg">` (`components/transport-controls.tsx`) renders the ⏮ / play-pause / ⏭ buttons as a **fragment** (drops into each parent's flex row) and owns the queue-neighbor math: `idx = episodeQueue.findIndex(...)`, prev disabled at `idx === 0`, next disabled at the last index. Backed by store actions `playPrev`/`playNext` (mirror images — walk `episodeQueue`, reset `positionSec`) and `togglePlay`. The mini-player uses `size="sm"` (plain `.btn`), the fullscreen player `size="lg"` (sized `w-12/14 h-12/14`). Don't re-inline these buttons — both players import the component.
- **`playNext` auto-advances on `onEnded` only for music** (`isMusicMedium(current.podcast)`); other media just stop.
- **Fullscreen layout** is a two-pane flow inside one scroll container (`flex-1 overflow-y-auto flex flex-col sm:flex-row`): art **centered** in a sticky left half (`sm:sticky sm:h-[calc(100vh-3.5rem)]`), info in the right half (no separate scroll region — the page scrolls as one). On mount while `open` it locks scroll on **both `<html>` and `<body>`** (the page scrolls at `<html>`, where the background lives) so the underlying page's scrollbar doesn't show through; restored on close.
- **Fullscreen content (right pane):** title/seek → control row (`<TransportControls size="lg">` + `⚡ BOOST` with an `ml-28` gap + `<FavHeart size="md">`) → value-split disclosure → **album tracklist** for music (`Album · N tracks`, the `episodeQueue` rendered clickable, current track highlighted, `max-h-80` internal scroll) → `<EpisodeInfoPanel>` (About / Chapters, see Chapters) → `socialInteract` thread. `FavHeart` comes from `components/fav-heart.tsx` and is reused here (album-level favorite). **For Nostr live streams the right pane is replaced by the live chat** (see Nostr live streams).
- **HLS video lives alongside the `<audio>`.** Most playback is the native `<audio>`; HLS (`.m3u8`) enclosures — Nostr live streams — play through a separate `<video>` + `hls.js` instead. See Nostr live streams for the reverse-portal video and the `isHlsUrl` branching in `player.tsx`.
- **`playerExpanded` (store), not local state.** Whether the fullscreen player is open lives in the store (`useApp`), so surfaces outside `<Player>` (a live-stream card) can open it; `<Player>` still owns the `<FullscreenPlayer>` render. The header `← back` button and the ✕ both call `onClose` (collapse, not stop). When signed out, the header shows a `◆ Sign in` button (opens the shared modal via `signInOpen`).
- **The "About this episode" box wraps long tokens.** It's `whitespace-pre-wrap break-words … overflow-y-auto overflow-x-hidden`. The `break-words` + `overflow-x-hidden` are both load-bearing: `overflow-y-auto` makes the browser *compute* `overflow-x` to `auto`, so a single unbreakable token (e.g. a bare URL in show notes) wider than the box otherwise spawns a horizontal scrollbar. Same CSS gotcha as the html/body `overflow-x: clip` note below.

## Chapters (Podcasting 2.0 `<podcast:chapters>`)

`Episode.chaptersUrl` comes straight from Podcast Index's `chaptersUrl` (`buildEpisode` in `lib/pi.ts`) — no RSS enrichment needed; PI indexes it reliably. `useChapters(url)` (`lib/chapters.ts`) fetches the JSON (`{ chapters: [{ startTime, title }] }`); it **no-ops on an empty `url`** so callers can invoke it unconditionally (React hook rules) when chapters may be absent. `lib/chapters.ts` is the single home for chapter logic, exporting `chapterUrlFor(current)` (the gating — see below), `chapterState(chapters, pos, dur)` → `{ index, chapter, end }`, and `buildChapterNav(chapters, idx, pos, seek)` → the `<TransportControls>` `prev`/`next` override (or undefined). Three surfaces render chapters: the episode detail view (`components/episode-detail-view.tsx`, read-only list), the fullscreen player, and the mini-player.

**One fetch per episode, owned by `<Player>`.** `<Player>` always mounts `<FullscreenPlayer>` (just translated off-screen when collapsed), so if both called `useChapters` the JSON would be fetched **twice** per play. Instead `Player` does the single `useChapters(chapterUrlFor(current))` and passes `chapters`/`chaptersLoading` down as props; `FullscreenPlayer` never fetches. `chapterUrlFor` is also the **single gate**: it returns `''` (→ no-op) for live streams and music feeds, so chapters are a podcasts-only feature everywhere at once (no per-component `!isMusic` checks).

**Both players** carry the same chapter affordances: seek-bar **tick marks** (`<ChapterTicks>`), a **current-chapter label** (`<ChapterLabel>`, `start–end · title`) — both in `components/chapter-ui.tsx` — and **chapter-stepping ⏮/⏭** via `buildChapterNav` feeding the optional `prev`/`next` override on `<TransportControls>` (`{ onClick, disabled, label }`; absent → falls back to episode/track nav). Prev restarts the current chapter if >3s in, else jumps back. The seek-bar tick wrapper uses a `block` input + `flex items-center` so the absolute ticks center on the 2px track (an inline-block input leaves a baseline descender gap that drops them below the line).

**Fullscreen `<EpisodeInfoPanel>`** merges the about-text and chapters into one section with an **About / Chapters tab strip**. The tabs appear only when *both* exist; with just one it renders that section under a plain label, and with neither (nor anything loading) it returns null. Chapters there are clickable seek targets with an active-chapter highlight (`fmt(startTime)` + title). It receives `chapters`/`loading` as props (from `Player`, via `FullscreenPlayer`). The list **flows with the page's single scroll** — no inner `max-h`/`overflow` box (a nested scroll container fought the right pane's own scroll). The about-text wraps long tokens (`break-words`). The non-live right pane is split into a **pinned header** (title, seek, transport/boost, value-split, album) and a **scrollable body** (`<EpisodeInfoPanel>` + discussion) so the controls stay put while About/Chapters scroll (desktop `sm+` only; mobile stays a single scroll).

**The fetch goes through `/api/chapters?url=<encoded>`, not directly.** Many chapter hosts (notably `feeds.fountain.fm`) serve the JSON with **no `Access-Control-Allow-Origin` header**, so a direct browser `fetch` is CORS-blocked → the hook's `.catch()` silently rendered no chapters. `app/api/chapters/route.ts` is the server-side proxy (same pattern as `/api/by-guid`: `rateLimit` → `assertSafeFetchUrl` SSRF guard → fetch with timeout → return upstream JSON verbatim, `Cache-Control` on the 200 only). The client parser stays the single source of truth.

## Nostr live streams (NIP-53 kind:30311)

A **"Live on Nostr"** horizontal card row renders above the global feed on the browse view only (`components/nostr-live-streams.tsx`, mounted in `app/page.tsx` when `!inDetailView`). Independent of Podcast Index — pure Nostr.

**Stream id is `<64hex pubkey>:<dTag>`** (the NIP-33 address tail), carried as `episode.guid`. Helpers in `lib/nostr/live-streams.ts`: `streamIdOf(pubkey, dTag)`, `parseStreamId(id) → {pubkey,dTag}|null` (validates 64-hex pubkey), `isLiveStreamId(s)`. Use them instead of inlining `indexOf(':')`/`slice`/`/^[0-9a-f]{64}:/`. `streamChatAddr(streamId)` (live-chat.ts) prefixes `30311:` to make the chat/zap `a`-tag address.

**Fetch + filter (`lib/nostr/live-streams.ts`).** `fetchNostrLiveStreams()` queries kind:30311 over `LIVE_STREAM_RELAYS` (`DEFAULT_RELAYS` ∪ `wss://relay.zap.stream` + `wss://nostr.wine`, sanitized) within a 7-day `since` window, dedupes replaceable events by address (newest `created_at` wins), then:
- **Drops stale `live` events** older than `LIVE_FRESH_SECS` (2h) by `created_at` — an active 30311 event is re-published periodically while broadcasting, but most clients never publish the `ended` status (they just stop updating), so a stale `live` event is a dead broadcast. **Planned streams are exempt** (set once, ahead of time).
- **Sorts upcoming-first**, then live; within each group **newest start first** (`startsAt` descending).

`fetchLiveStreamByAddr(pubkey, dTag, relayHints)` fetches ONE stream for the `/stream/<naddr>` deep link. It queries by **author only** (`{kinds:[30311], authors:[pubkey]}`) and filters the d-tag **client-side** — NOT a `#d` filter: a stream's event often lives only on the host's relay (e.g. `fountain.fm`), which doesn't honor the `#d` tag filter reliably in-browser, so the filtered query came back empty and said "not found" even when the main-page list (a broad, unfiltered query) found it. The stream page also **retries** the call (cold Firefox-private tabs have no warm DNS/TLS/WS to the host relay, so the first query can time out before it responds; a refresh works because the connection is warm).

**`streamNaddr(pubkey, dTag)`** encodes the shareable `naddr` with stream-relay hints (`zap.stream`/`fountain`/`nos.lol`) — generic defaults aren't enough for other clients to resolve a fountain-only stream.

**Stream → player/boost bridge.** `streamToEpisode(stream, value)` / `streamToPodcast(stream, profile)` map a stream onto the existing `Episode`/`Podcast` so the player, boost modal, and `liveStatus` UI work unmodified. `episode.guid = stream.id`, `episode.enclosureUrl =` the HLS `streaming` URL, `liveStatus` from status; `id`/`feedId` synthetic (`fnvHash`/0).

**V4V (`resolveStreamV4V`).** A `ValueBlock` of `lnaddress` recipients from each participant's kind:0 `lud16`/`lud06`. Source: NIP-53 `zap` split tags when present, else the host pubkey alone. Explicit weight `0` = host opted that participant out — preserved (not coerced to 1) and dropped; falls back to the host if every split is zeroed. Profiles are fetched against the **broad `LIVE_STREAM_RELAYS` set** (not just defaults) and **re-fetched on a cached miss** — a streamer's lud16 often lives on the stream's relays, and a transient miss otherwise hid BOOST for the 15-min profile-miss TTL.

**HLS video (`player.tsx`).** A single `<video>` in a **reverse portal** (`react-reverse-portal`) moves between the mini-bar thumbnail and the fullscreen art pane **without remounting** (a remount kills playback + the `hls.js` attachment) — keeps audio playing when collapsed. `isHlsUrl(url)` (`lib/util.ts`) gates the video path; everything else stays on native `<audio>` (the inactive element is left srcless). `hls.js` is **dynamic-imported** on first stream play; native HLS (Safari `canPlayType`) skips it. The portal node is **created client-only** (`createHtmlPortalNode()` touches `document` → crashes Next SSR). Mouse-wheel over the card row scrolls it horizontally (native non-passive `wheel` listener). **`<Player>` is mounted in the root layout** (`app/layout.tsx`), not `app/page.tsx`, so playback + the fullscreen overlay survive route changes (browse ↔ `/stream/<naddr>`).

**Dedicated route `app/stream/[naddr]/page.tsx`.** A shared stream link is a real route, so refresh restores it. The page renders ONLY a loading / "not found" state and opens the layout's player on top (no browse header/feeds mount, so nothing main-page-related loads). Collapsing the player navigates home (`router.push('/')`); the stream keeps playing in the mini-bar. A **fast-path** skips the fetch when `current` already matches the naddr (a card click pre-played it). Tapping a card calls `play(...)` instantly + `router.push('/stream/<naddr>')` (so the URL reflects it); the card's PLAY button stays in the mini-bar (no nav). It also mounts a hidden `<NostrAuth>` so you can sign in there (identity hydration + the sign-in modal) without leaving — home isn't mounted on this route. Old `/?stream=<naddr>` links redirect here.

**Live chat (`lib/nostr/live-chat.ts` + `components/live-chat.tsx`).** Shown in the fullscreen right pane for live streams. `subscribeLiveChat(streamId, onEvent)` owns its own long-lived `SimplePool` and runs three phases on it: (1) `querySync` a complete history backfill — relays trickle stored events slowly over a bare `subscribeMany`, so a reload would show only a handful; (2) `subscribeMany` for live messages; (3) a **re-sync backstop** — every 12s and on `visibilitychange`/focus, a `since`-bounded re-query — because the persistent subscription goes stale when a device backgrounds or a relay socket drops, so the chat diverges across devices / from Fountain. It subscribes to **kind:[1311, 9735]**: 1311 = chat messages, 9735 = zap receipts (boosts) tagged to the stream. `<LiveChat>` renders both through one `<ChatRow>` (zap rows add a `⚡ N sats` badge + tint), shows a **total-sats-zapped** line at the top (sum of all 9735 amounts via `zapInfo`), resolves author/zapper/`@mention` profiles against `LIVE_STREAM_RELAYS`, renders `nostr:npub` mentions as `@names` + http links as anchors, applies the mute filter, and gates the composer on sign-in. `publishLiveChat(streamId, content)` posts a kind:1311.

**Boosting a live stream → real NIP-57 zap (`components/boost-modal/index.tsx`).** When you boost a live stream signed-in, with an active signer, a single lnaddress recipient, and a host that supports NIP-57 (pre-checked via `lnaddrSupportsZaps` BEFORE paying, so no double-pay), the boost is sent as a **real zap** (`sendZap` with `aTag = streamChatAddr(id)`) so the recipient's LN service publishes a kind:9735 receipt — it shows up as a boost in Fountain / tunestr / zap.stream AND in BMB's chat. Anything that doesn't qualify (signed out, host without zap support, multi-recipient splits) falls back to the existing boostagram payment + a kind:1311 `⚡ Boosted N sats` text line (so it's at least visible as chat). Interop is the shared NIP-53 standard, not per-platform code — the only variable is relay coverage.

## Show-page URL contract (`?podcast=<guid>`)

`selectedPodcast` is mirrored to the URL via two `useEffect`s in `app/page.tsx` — no Next.js routing involved. One reads `?podcast=<guid>` on mount and calls `resolvePodcastByGuid` (`lib/podcast-meta.ts`) to hydrate the detail view; the other watches `selected?.podcastGuid` and writes/clears the param. Hydration uses `useApp.getState()` re-checks before `setSelected` to avoid the StrictMode double-mount race overwriting a user click that landed during resolution.

**`history.replaceState`, not `pushState`.** Deliberate: the explicit "← back to results" button stays the only in-app way out of detail view. `pushState` would make browser-back a second exit and require a `popstate` listener to keep Zustand and the URL in sync. Bad/unresolvable guids fall back to the browse view silently via the PI breaker (`bmb:pi:dead` sessionStorage sentinel).

**Every page-level view is URL-restorable on refresh** — the mount-hydrate + mirror effects in `app/page.tsx` cover: `?podcast=<guid>` (detail), **`?feed=<id>`** (detail fallback for shows with no `podcastGuid`, resolved via `/api/feed`), `?episode=<guid>` (episode detail), **`?discussion=1`** (layered on podcast/feed + episode → the Nostr thread; needs `socialInteract` from `/api/feed`), and **`?publisher=<feedUrl>`** (publisher albums; reconstructs a minimal stub — the back-button label shows "Publisher" on a cold restore). Live streams use the dedicated `/stream/<naddr>` route (see Nostr live streams). All restores re-check `useApp.getState()` before `set` (StrictMode guard) and gate on the PI breaker. Audio resume (what's playing) is NOT restored — only the view; the live-stream route inherently reopens its player.

The **SHARE button** in `EpisodeList`'s header (`components/lists.tsx:ShareButton`) copies `origin + ?podcast=<guid>` to the clipboard with a 1.8 s "COPIED" label flip. Clipboard-only by design — no Web Share API, no pod.link option (that's already what the Nostr boost note links to via `podcastLandingUrl`).

Header action cluster order: `[♡ FAVORITE] [↗ SHARE] [⚡ BOOST]`. BOOST is still gated on `showHasValue`; SHARE and FAVORITE are always visible.

## Feed ordering + RSS enrichment (`/api/feed`)

`app/api/feed/route.ts` builds the episode list from PI's `/episodes/byfeedid`, then enriches and re-sorts it. `getRssEpisodeEnrichment(podcast.url)` (`lib/pi.ts`) fetches the raw RSS **once** and returns `{ episodes, feedMedium, feedPodroll }` (`RssFeedEnrichment`): a per-guid map of fields PI doesn't index, plus the channel-level `<podcast:medium>` and `<podcast:podroll>`. The route merges those onto each episode by guid.

**Why RSS, not just PI:** PI's episode API only surfaces the iTunes namespace (`itunes:season`/`itunes:episode`), not the Podcasting 2.0 `<podcast:season>`/`<podcast:episode>` tags many music album feeds use (e.g. Henrik Flyman's album feeds). So `buildEpisode` leaves `season`/`episode` null for those, and without the RSS pass the music sort would treat every track as `season=1, episode=0` → tracks render in PI's date order, not track order. The enrichment fills them in:

- **Per item:** `<podcast:season>` (prefer the `number=` attr, fall back to text) and `<podcast:episode>` (text) → merged as fallbacks only when PI's value is null: `season: e.season ?? rss?.season ?? null`. Same pass also carries `socialInteract` + `content:encoded` (see below).
- **Channel:** `<podcast:medium>` parsed from the XML slice before the first `<item>` → `feedMedium`. The music check is case-insensitive **and** falls back to RSS: `isMusic = isMusicMedium(podcast) || feedMedium === 'music'` — because PI doesn't reliably index `medium` either. The route then **backfills `podcast.medium` from `feedMedium`** before responding (`if (!podcast.medium && feedMedium) podcast.medium = feedMedium`) so the client gets the same music signal the sort used — the client only receives `podcast.medium`, not `feedMedium`, and every client-side `isMusicMedium(podcast)` check depends on this. `<podcast:podroll>` comes off the same channel slice → `feedPodroll` → `podcast.podroll` (see Podroll below).

**Sort order:** live (live > pending, `LIVE_RANK`) first; then **music feeds** sort by `season` (disc) then `episode` (track) ascending; **everything else** by `datePublished` desc. Enrichment is best-effort — a failed RSS fetch falls back to `{ episodes: new Map(), feedMedium: undefined, feedPodroll: undefined }`, leaving episodes unenriched rather than breaking the feed. `getRssEpisodeEnrichment` has a single caller (this route); changing its return shape means updating the `.catch()` fallback there too.

## Podroll (`<podcast:podroll>`, host-recommended shows)

A channel-level `<podcast:podroll>` block holds `<podcast:remoteItem feedGuid=… feedUrl=…>` entries pointing at other shows the host recommends. PI doesn't index it, so it rides the same single RSS pass as `feedMedium`: `parsePodroll(channelXml)` (`lib/pi.ts`) → `feedPodroll` → `podcast.podroll: PodrollItem[]` attached by `/api/feed`. Entries without a `feedGuid` are skipped (the spec requires it; `feedUrl` is an optional hint).

`components/podroll.tsx` renders the row on the podcast detail view, mounted from `EpisodeList` behind `<DeferredOnScroll>` with **no placeholder** — the component owns its own skeleton and renders nothing when no entry resolves, so a placeholder heading would flash in and vanish.

Load-bearing details:

- **Two-step resolution, guid then feedUrl.** `resolvePodcastByGuid(item.feedGuid)` first; on a miss, `resolvePodcastByFeedUrl(item.feedUrl)` when the entry carries one. Both live in `lib/podcast-meta.ts` and share one `resolveVia(cacheKey, query)` internal, so the four guards (memo → `bmb:pmeta` 7-day TTL → PI breaker → fetch) apply identically. feedUrl entries are cache-keyed `url:<feedUrl>` so they can't collide with a guid. The fallback exists because PI doesn't index every feed by guid — the same coverage gap that forced the RSS fallback in `resolveValueTimeSplits`; without it those cards silently vanish (and the null miss is cached for the page, so they stay gone).
- **`/api/by-guid` takes `guid` **or** `url`** (`getPodcastByGuid` / `getPodcastByFeedUrl`). The `url` branch is not an SSRF surface — it's forwarded to PI's `/podcasts/byfeedurl` as a query param; we never fetch it ourselves. Length-capped at 2048 (guid at 120).
- **A PI "not found" must 404, never 500** — this is load-bearing. PI answers an unknown feed URL with **HTTP 400** `{"status":"false","description":"Feed url not found."}`, and `pi()` throws on any non-2xx. If that reached `withErrorHandling` it would 500, and `resolveVia` treats **any 5xx as "PI is down" and trips the breaker** — so a single podroll entry pointing at a feed PI doesn't index would disable *all* podcast metadata resolution (favorites hydration, feed podcast chips) for the rest of the tab. `getPodcastByFeedUrl` therefore catches `PiHttpError` with status 400/404 and returns null (→ route 404s). 401/403 and 5xx still throw: those genuinely are breaker-worthy. `PiHttpError` (exported from `lib/pi.ts`) exists to carry the status for exactly this distinction — don't go back to a bare `Error`.
- **Probe-first-then-batch**, per the `/api/by-guid` breaker convention: resolve entry 0, check `piMaybeUp()`, only then `Promise.all` the rest.
- **`genRef` generation guard, not a mounted flag.** Switching shows swaps `items` *without* unmounting `<Podroll>` (`EpisodeList` holds the previous feed's `data` until the new fetch lands), so two resolves can overlap and a slow one for show A could settle last and paint A's recommendations under show B. Only the newest generation commits. Also covers StrictMode's double-mount, which is why there's no unmount cleanup (React 18 no-ops `setState` after unmount).

`parsePodroll` only sees the pre-first-`<item>` channel slice, so a podroll authored *after* the items is missed — same limitation as `feedMedium`, and conventional feeds put channel metadata first.

## Episode discussion (`podcast:socialInteract`, Nostr)

Episodes (and RSS live items) can carry `<podcast:socialInteract protocol="nostr" uri="nostr:nevent1…|note1…">` pointing at a publisher-designated Nostr root note that anchors that episode's discussion. `lib/pi.ts` parses them into `Episode.socialInteract: SocialInteract[]` (sorted by `priority`), normalizing both spec `nostr:<bech32>` and non-standard `https://njump.me/<bech32>` URIs via `extractNostrUri`. PI's `/episodes/byfeedid` doesn't expose the tag, so the `/api/feed` route picks it up from the shared RSS pass (`getRssEpisodeEnrichment`, see above) and merges by guid. Only `protocol="nostr"` is kept.

**Fetch + render.** `fetchSocialInteractThread(uri, opts)` (`lib/nostr/discover.ts`) decodes the note1/nevent1, unions `DEFAULT_RELAYS` with up to 4 nevent relay hints, fetches the root, and BFS-assembles the reply tree via the same `assembleNotes` as the feed. Contract: returns `[]` for an undecodable URI or a root no relay carries; **throws** when the relay query itself fails — so the UI can tell a transient outage (offer retry) from genuine emptiness. `components/episode-social-thread.tsx` is the self-contained surface (shared by the discussion view AND the fullscreen player): status union `loading | ready | error`, loading skeleton, retry button, a reply count that excludes the root anchor, and a sign-in-gated comment composer.

**Comment composer.** A signed-in user replies to the thread root via `publishReply({ parent: notes[0].rawEvent })` (`lib/nostr/interactions.ts`) — a real reply to the publisher root, so it interoperates with other PC2.0 clients. Insert is **optimistic**: `signAndPublish` returns the signed `event` on `PublishedNote`, and `noteFromEvent` (`discover.ts`) builds a `DiscoveredNote` appended under the root's `replies`. Optimistic rather than refetch because the publish (write) relays may not overlap the query relays; a `pendingOptimistic` ref re-merges the comment if a wholesale revalidation lands during the reply-stream window.

**Faster first paint.** The component used to await the whole tree (root + up to 6 sequential 8 s BFS levels + profile/quote resolution) before painting anything. Now `fetchSocialInteractThread` fires an `onRoot(root)` callback the moment the root resolves (built from the cached profile, no extra network), so the anchor + composer appear in ~1 s while replies stream in behind them. Repeat visits paint instantly from `storage.socialThread` (per-URI cache, no TTL, stale-while-revalidate — mirrors `storage.feedNotes`); an error after a cache/root paint keeps what's shown and flips a quiet "couldn't refresh" hint instead of wiping it.

**Full-page discussion view (not inline, not a modal).** The `· 💬 discussion` button in the `EpisodeList` info row (only when `e.socialInteract?.length`) calls `openDiscussion(e)`; `app/page.tsx` then renders `<DiscussionView>` *ahead of* the detail/browse branches — a third page-level view (browse → detail → discussion) with a `← back to episodes` button. `discussionEpisode` lives in the store and `selectPodcast` clears it, so a thread can't outlive its show. Earlier iterations (thread inline in the expanded panel, then a scroll-to-thread shortcut) were dropped because a long thread ballooned the episode row and broke list scanning. The fullscreen player keeps its own inline `<EpisodeSocialThread>` — its scroll container absorbs the height.

**Inline images in notes.** `NoteCard` (`components/nostr-note-card.tsx`) pulls image URLs (`jpg/jpeg/png/gif/webp/avif/bmp`, optional query string) out of the body via `extractImages` and renders them as `<img>` thumbnails (clickable, lazy, `max-h-80`) instead of raw links — applies to every note surface (discussion thread, per-podcast feed, global feed), not just the thread. Detection is extension-based; URLs without an extension (some `i.nostr.build/<hash>`) aren't caught — that would need NIP-92 `imeta` parsing. Uses `<img>`, not `next/image` (arbitrary hosts), like `PodcastCover`.

## Boost-all tracks (valueTimeSplits)

Music podcasts (Homegrown Hits, Lightning Thrashes, etc.) tag each track in their RSS with a `<podcast:valueTimeSplit>` block — a startTime/duration window plus a `<podcast:remoteItem feedGuid="…" itemGuid="…" />` pointing at the track's own album feed. PI surfaces these as **`e.timesplits[]`** (flat top-level array on the episode object, NOT nested under `e.value.valueTimeSplits` despite what the field name suggests). Each entry has `feedGuid`/`itemGuid`/`medium` directly — `parseRawValueTimeSplits` in `lib/pi.ts` maps the flat shape to the consumer-facing nested `ValueTimeSplit.remoteItem`.

The `⚡ BOOST N TRACKS` button on each episode row in `components/lists.tsx` opens `<BoostAllModal>` (`components/boost-all-modal.tsx`). Sequential per-track sends, not parallel.

**Resolution pipeline** (`/api/value-splits` → `lib/pi.ts:resolveValueTimeSplits`):

1. **Probe-first-then-batch.** Try the first resolvable split synchronously. If it throws, return the whole batch unresolved instead of hammering PI when it's degraded. The remaining splits fan out in parallel with per-call try/catch.
2. **PI's `/episodes/byguid` requires `podcastguid`** (lowercase param name — `feedGuid`/`feedid` are silently rejected with "This call requires either a valid feedid, feedurl or podcastguid argument").
3. **Fallback to RSS chain** (`lib/musicl-resolver.ts:resolveRemoteItemFromRss`) when PI returns "Episode not found". Server-side, two cases:
   - feedGuid is an album feed → find `<item>` with matching `<guid>`, extract `<podcast:value>` (or fall back to channel-level value).
   - feedGuid is a publisher feed (`<podcast:medium>publisher</podcast:medium>`) → walk `<podcast:remoteItem feedUrl="…">` entries, fetch each album feed in parallel, return the first match.
   5-min in-memory cache keyed on feed URL. 5s `AbortSignal.timeout` per fetch. Without this fallback, ~50% of music-podcast tracks fail to resolve because PI doesn't index every album feed.

**Modal-side filtering.** The modal drops splits whose remote items couldn't be resolved to a value block. Header reads `Tracks (N of M — K unresolved)` when there's a gap. Remaining gaps are usually host-RSS authoring problems (stale feedGuid, no feedUrl hint, feed not in PI) and are unrecoverable from the client.

**Per-track payment loop** (`BoostAllModal.go()`):

1. **Two legs per track.** Each track sends `floor(sats × remotePercentage / 100)` to its own value block recipients (track artists). The (100 − remotePercentage) remainder fires as a SEPARATE host-share leg to `episode.value` (or `podcast.value`) immediately after, **per-track, not aggregated**. Both legs carry the same `remote_feed_guid`/`remote_item_guid` so the show host's Helipad can correlate which track triggered each share. Default `remotePercentage` = 100 (no host leg).
2. **Boostagram shape.** Primary fields (`podcast`, `feedID`, `episode`, `episode_guid`) = HOST episode. `remote_feed_guid`/`remote_item_guid` = the TRACK. Mirrors `BoostModal`'s convention so recipient artists see the listener's host context, not mangled track-as-podcast metadata.
3. **Each successful leg logs its own `StoredBoost`** to `bmb:boosts:<npub>` so the user's local sent-boost feed reflects every payment.
4. **StrictMode guard.** `cancelled.current` ref is **reset to `false` on mount AND set to `true` on unmount**. Without the mount-side reset, dev StrictMode's mount → unmount → mount cycle leaves the ref stuck at `true` and the loop bails on the first iteration with no Lightning traffic at all (silent failure mode that took an HAR dump to diagnose).
5. **Confetti on success** (mirrors `BoostModal`'s celebration) when at least one track pays.
6. **Single Nostr summary note.** When `shareNostr` is on and at least one track paid, fires ONE kind:1 note via `publishBoostNote` with `contentOverride` listing every successful track title (no truncation). NOT one note per track.

**Rail picker** (mid-modal wallet connect support). Unlike `BoostModal` which picks rail silently via `pickRail()`, `BoostAllModal` renders a "Pay via [NWC] [Spark] [WebLN]" pill row when 2+ rails are available. Computed inline (no `useMemo`) so the existing `subscribeNwc`/`subscribeSpark` re-render path lets newly-connected wallets appear without remount.

## Boost flow invariants

`components/boost-modal/index.tsx` orchestrates; `lib/v4v/boost.ts` is the engine. Load-bearing:

0. **Live-stream boosts go out as real NIP-57 zaps** (a branch at the top of `go()`, before the boostagram path) when signed-in + active signer + single lnaddress recipient + the host supports NIP-57 (pre-checked via `lnaddrSupportsZaps` BEFORE paying → no double-pay). Uses `sendZap` (`lib/v4v/zap.ts`) with `aTag = streamChatAddr(id)` so the recipient's LN service publishes a kind:9735 receipt that renders as a boost in Fountain/tunestr/zap.stream + BMB. Falls through to the normal path otherwise. The two paths share `logStoredBoost(legs)` and `maybePublishNote(results)` (extracted to avoid the StoredBoost / publish blocks drifting). On a real zap the kind:1311 text line is skipped (the receipt already shows); on the fallback it's posted. The modal auto-closes ~1.5s after a successful send.
1. **Lightning first, then Nostr.** `publishBoostNote` only fires after `sendBoost` returns *and* `collected.some(r => r.ok)`. Don't reorder — inverting publishes false "I boosted" notes when all payments fail.
1a. **Success celebration = `fireConfetti()` + `playBoostSound()`** (both in `lib/format.tsx`), called together at every boost-success point: `BoostModal`'s live-stream zap path and boostagram path, plus `BoostAllModal.go()`. `fireConfetti()` is `canvas-confetti`; `playBoostSound()` plays a lazily-created singleton `Audio('/boost.mp3')` (`public/boost.mp3`) — SSR-guarded, resets `currentTime`, and swallows play/decode errors so a missing/blocked asset is a **silent no-op**. Always-on, no toggle. **Mobile gotcha — the sound plays AFTER the async payment, not at the tap.** `fireConfetti()` (canvas) has no gesture requirement, but `playBoostSound()` fires seconds after the click, past the button's transient user-activation; iOS Safari then blocks the unprimed `play()` (worked on desktop, silent on mobile). Fix: **`primeBoostSound()` is called synchronously at the top of every boost `go()` handler, before any `await`** — it does a muted play+pause to unlock the singleton element inside the real gesture, so the later `playBoostSound()` (which unmutes) is permitted. Both go through `ensureBoostAudio()`. If you add a new boost entry point, call `primeBoostSound()` in its click handler before the first await. Add a mute option later by mirroring the `shareNostr` boolean in `lib/storage.ts` and gating both.
2. **`pickRail()` = rail pref first, then NWC > Spark > WebLN.** `storage.railPref` wins when that rail is still connected/enabled; otherwise priority order ('nwc' if URI saved, else 'spark' if initialized, else 'webln' if detected, else null). User can override per-boost. `storage.railPref.set/clear` notify `subscribeRailPref` (exported from `lib/storage.ts`) so the balance chip, account-menu summary, and open wallet modal re-resolve on a switch.
3. **Episode value-block fallback happens server-side.** `app/api/feed/route.ts` does `e.value ?? podcast.value`. Don't re-implement in the modal.
4. **Splits use weights, not percentages.** `splitSats()` floors per-recipient, dumps the remainder onto the first non-fee recipient. `ValueRecipient.split` is a weight; total weight is the denominator.
5. **TLV record `7629169` only.** Boostagram JSON goes there (Podcasting 2.0 standard). `sender_id` lives inside that JSON. We deliberately do **not** also emit a separate `696969` sender record — that key collides with shared-node sub-account routing (e.g. getalby.com uses `customKey=696969 customValue=<sub-account>`). Per-recipient `customKey`/`customValue` from the value block IS attached to the keysend.
6. **WebLN `customRecords` are plain JSON, not hex.** WebLN providers hex-encode internally. Pre-hexing causes double-encoding and Helipad can't `JSON.parse`. NWC's `pay_keysend` is the opposite — NIP-47 requires hex-encoded TLV. See `tlvHexFor` (NWC) vs `recordsForKeysend` (WebLN) — symmetric-looking, genuinely different wire formats.
7. **Note amount is intent, not actual.** `formatContent` and the `amount` tag use `boostagram.value_msat_total`, not the sum of successful legs. A user who boosts 100 sats with one failed leg still posts "Boosted 100 sats"; partial breakdown is in the modal and Helipad.
8. **BoostBox is LNURL-only.** `lib/v4v/boostbox.ts` POSTs metadata via `/api/lightning/boostbox` *before* `fetchLnInvoice`, then puts the returned `desc` (`rss::payment::boost <url>`) in the LUD-21 `comment` field. Keysend recipients are untouched (TLV `7629169` carries the boostagram inline). BoostBox failure is non-fatal; LNURL falls back to `boostagram.message`.
9. **LNURL invoices are amount-verified before paying.** `fetchLnInvoice` (boost legs) and `sendZap` both decode the returned BOLT11 via `bolt11AmountMsat` (`lib/v4v/bolt11.ts`, pure HRP parser shared with the zap-receipt reader in `discover.ts`) and throw on an amountless invoice or any mismatch with the requested msat — a malicious LNURL server can't substitute a larger invoice. Strict equality is safe because we only ever request whole-sat msat values; the throw surfaces as a normal per-leg `{ ok: false, error }`.

## Nostr publish shape

`publishBoostNote()` in `lib/nostr/boost-notes.ts` builds a kind:1 with:

- NIP-73 `i`/`k` pairs for `podcast:guid:<feed-guid>` and (per-episode) `podcast:item:guid:<item-guid>`.
- **Two `r` tags** when both URLs differ. (1) Listen-link via `podcastLandingUrl`: prefers `https://pod.link/<itunesId>`, falls back to `https://podcastindex.org/podcast/<feedId>`, then raw RSS URL. (2) BMB deep-link via `bmbLandingUrl`: `https://boostmebitch.com/?podcast=<podcastGuid>` (only emitted when the podcast has a guid). Both URLs are also appended to the rendered body so Nostr readers see "listen elsewhere" + "boost back on BMB" as separate affordances.
- `amount` in millisats from `value_msat_total` (intent).
- `client` tag from `app_name`, defaults to `BoostMeBitch`.
- `t`: `boostagram` + `value4value`.

Publish target is `resolvePublishRelays(identity)`. Body lives in `formatContent()` (override per call with `contentOverride`):

```
⚡ Boost ⚡

[message, if present]

Boosted N sats → [podcast title]
📻 [episode title, omitted on show-level boosts]

[pod.link or PI URL]
```

`signAndPublish` handles both kind:1 boost notes and kind:30003 favorites — a third event kind is ~10 lines.

## v4v-toolkit swap-out boundary

`lib/v4v/*` and `lib/nostr/` are intentionally the only files that talk to wallets/signers. Components import only: `lib/v4v/boost.ts` (orchestrator), `lib/v4v/nwc.ts` (URI persistence), `lib/v4v/spark.ts` (wallet surface), `lib/nostr/` barrel (auth + publish + wallet backup). Swap toolkit by replacing internals here without touching `components/` or `app/`.

## Feed loading (`useNostrFeed`)

`lib/nostr/use-feed.ts` is the stale-while-revalidate hook behind global + per-podcast feeds. Three load-bearing rules:

1. **Cache always paints first.** `storage.feedNotes.get(cacheKey)` returns whatever's there regardless of age (no TTL gate). Set into state synchronously inside the mount effect.
2. **Full fetch on every load.** Both mount and user-triggered `refresh()` do a full relay fetch (no `since` filter). Stale cached state is replaced, not merged. Simpler and prevents stale notes from blocking new relay activity.
3. **No auto-refresh.** Mount + user-clicks-refresh only — never on a timer. Local-mutation surfaces (e.g. `boostsTick` after a sent boost) intermix client-side, not via re-fetch.

**Album-page track union.** `fetchPodcastNotes(podcastGuid, opts, episodeGuids?)` (`lib/nostr/discover.ts`) widens its `#i` filter to `podcast:guid:<guid>` **plus** `podcast:item:guid:<g>` for each `episodeGuids` entry (OR semantics in one filter). `PodcastNostrFeed` passes every track guid **only for music feeds** (`isMusic ? data.episodes.map(e => e.guid)… : undefined`, keyed into the fetch deps via a joined `guidsKey`) — since music tracks have no per-track pages, this guarantees the album page surfaces boosts that tagged only a track's item guid (other PC2.0 clients) and not the feed guid. Regular podcasts keep their per-episode pages, so they don't pass the union (avoids duplication).

**Substance filter (`noteHasSubstance`, `lib/nostr/discover.ts`).** The global/per-podcast/per-episode feeds are a firehose: they fetch *every* kind:1 tagged with NIP-73 `podcast:guid`/`podcast:item:guid`. Some clients (notably **Amplify**) publish an empty kind:1 per listen — `content: ""` plus the podcast `i`/`k` tags — which renders as a bare podcast chip; at ~1/3 of all podcast-tagged traffic these drowned out real posts. `noteHasSubstance(note)` keeps boosts always (`isBoost`), otherwise strips `nostr:` refs + image URLs the way `<NoteCard>` does and requires non-empty body text or an image. **Filter on content, not the `client` tag** — real human comments made *via* those same clients (incl. Amplify) survive, and Fountain notes (which carry no `client` tag at all) are unaffected. Applied at render time in `components/{global,podcast,episode}-nostr-feed.tsx` beside the `mutedPubkeys` filter (same render-time pattern as mutes; doesn't touch the `bmb:feed:*` cache, so a stale paint can briefly flash filtered cards until the relay fetch replaces it). Mirrors what Fountain surfaces.

## /api/by-guid resilience and PI breaker

`/api/by-guid` 5xxs when PI keys are missing or PI is down. A returning user with a 100-guid favorites set would otherwise hammer the broken endpoint on every reload (StrictMode + Fast Refresh amplifies into thousands).

`lib/podcast-meta.ts` is the single resolver module. It exports two lookups — `resolvePodcastByGuid(guid)` (canonical) and `resolvePodcastByFeedUrl(feedUrl)` (the podroll fallback for feeds PI doesn't index by guid) — both thin wrappers over one `resolveVia(cacheKey, query)` internal, so the guards below apply identically to each. Keep new lookups going through `resolveVia`; don't hand-roll a fourth copy of the guards. Four guards stacked:

1. In-memory `Map<cacheKey, Podcast | null>` — also caches misses so each key is attempted at most once per page. `cacheKey` is the bare guid, or `url:<feedUrl>` for the feed-URL branch so the two can't collide.
2. `storage.podcastMeta` (localStorage, 7-day TTL) — survives reloads. Same `cacheKey`.
3. **Circuit breaker.** First 5xx trips `sessionStorage['bmb:pi:dead'] = '1'`. Persists across reloads in the same tab; a hard refresh starts a new session. `piMaybeUp()` lets callers gate parallel batches. **This is why a PI "not found" must never reach the client as a 5xx** — see the Podroll section: PI answers an unknown feed URL with a 400, and letting that become a 500 would trip this breaker and disable *all* metadata resolution for the tab.
4. Network.

Fan-out callers use **probe-first-then-batch**: await one resolve, check `piMaybeUp()`, only then `Promise.all` the rest. The global feed resolver runs in a `useEffect` that depends only on `notes` (not `podcasts` state); attempted-guid tracking lives in a `useRef<Set<string>>` so `setPodcasts` doesn't re-fire the effect (that bug caused a fetch storm pinning the dev server).

## Background art and the canvas-bg gotcha

`app/layout.tsx` renders `public/hero.jpg` as a fixed full-viewport layer with a `bg-ink/75` overlay and `<Image fill priority />` (AVIF/WebP). The overlay's opacity is what mutes the image; in light mode `--ink` flips to cream so the same `bg-ink/75` becomes a 75% bone wash automatically. Same image doubles as the OG via `metadata.openGraph.images`.

**The page background lives on `<html>`, NOT `<body>`.** It's set via CSS in `app/globals.css` (`html, body { background: rgb(var(--ink)) }` + the explicit rule on `html`), not via a Tailwind class. A `body` background propagates to the canvas and paints over the fixed image layer regardless of z-index. Moving the background to `<body>` (or putting `bg-ink` back on `<body>`) silently breaks the hero — no errors, just a flat-color page.

**`html, body` use `overflow-x: clip`, NOT `hidden`.** `overflow-x: hidden` computes `overflow-y` to `auto`, turning html/body into a scroll container that traps `position: sticky` descendants (the `sticky top-0` page header scrolled away instead of pinning). `clip` blocks sideways scroll without creating a scroll container, so sticky works against the viewport again. Don't switch it back to `hidden`. (The fullscreen player's header doesn't rely on this — it's a `fixed` app shell whose header sits outside the scrolling region.)

## State + persistence

Zustand store (`lib/store.ts`) holds: `identity`, `current`, `isPlaying`, `positionSec`, `playerExpanded` (fullscreen player open — lifted so a live-stream card can open the player `<Player>` owns), `signInOpen` (sign-in modal open — lifted so the fullscreen player / live chat can open the modal `<NostrAuth>` owns), `selectedPodcast` (lifted out of `app/page.tsx` so a podcast-name link inside a `<NoteCard>` can flip the layout without prop-drilling), `discussionEpisode` (the episode whose `socialInteract` thread the full-page discussion view shows; `selectPodcast` clears it), `favorites`, `mutedPubkeys`, `boostsTick`. **In-memory only.**

Everything else lives in `localStorage` and is never sent server-side. **All `bmb:*` keys go through typed helpers in `lib/storage.ts`** — don't call `localStorage.getItem`/`setItem` directly anywhere else. If you add a persisted field, add an accessor and use the `bmb:*` prefix.

Keys (per-identity ones key on `<npub>` or `:guest`):

| Key | Purpose / quirk |
|---|---|
| `bmb:signer` | `'amber' \| 'bunker'` when a polyfill signer is active; absent for NIP-07 / signed out. Page-load fast-path branches on this. |
| `bmb:bunker` | NIP-46 `{ uri, clientSk }`. Persisting `clientSk` keeps the bunker treating us as the same logical client across reloads (no re-auth). |
| `bmb:nwc_uri` | NWC URI. Global (one key, not per-npub). Restored from the opt-in Nostr backup (`d:boostmebitch:wallet:nwc`) on login when absent; **cleared on sign-out and npub-switch** so it can't leak across accounts on a shared device. |
| `bmb:rail_pref` | `'nwc' \| 'spark' \| 'webln'` — preferred boost rail, written by `recordLastRail` after a successful boost AND by the wallet modal's "Switch wallet" picker (tapping an already-connected rail makes it the active payer without disconnecting the others) — both **synced to Nostr** (`d:boostmebitch:settings`). Honored by `pickRail()`; falls back to NWC > Spark > WebLN priority when absent or when the preferred rail isn't available. Setter notifies `subscribeRailPref`. |
| `bmb:nwc_backup:*` | Per-npub `'1'` when the user opted in (the NWC card checkbox) to backing up their NWC connection string to Nostr. Set on backup publish + on auto-restore; cleared (and the Nostr event tombstoned) on toggle-off/disconnect. |
| `bmb:wallet_balance:*` | `{ rail, balance, ts }` per npub — last-known wallet balance + rail. Read on mount so the header chip paints instantly while the SDK reconnects; written after every successful balance fetch; cleared on explicit Spark/NWC disconnect. |
| `bmb:theme` | `'light'` when user chose light mode; absent = dark (default). The FOUC-blocker `<script>` in `app/layout.tsx` reads this synchronously and sets `data-theme="light"` on `<html>` before first paint — without it light-mode users see a dark flash on every navigation. |
| `bmb:relays` | JSON array, manual publish-relay override. |
| `bmb:sender_name` | Last "From" name in the boost modal. |
| `bmb:share_nostr` | `'0'` = default to NOT publishing a Nostr note for new boosts. |
| `bmb:npub` | Sentinel for silent re-login on page load. |
| `bmb:favorites:*` | `FavoritePodcast[]` cache. |
| `bmb:muted:*` | `MuteListState` JSON; `lib/storage.ts` auto-promotes the legacy shape. |
| `bmb:profile3:<pubkey>` | kind:0 cache. **7-day TTL on hits, 15-min on misses** (so PROFILE_RELAYS additions / temp outages re-resolve). The `3` suffix is a schema version — bump when shape changes. |
| `bmb:pmeta:<key>` | `/api/by-guid` cache, 7-day TTL. `<key>` is a podcast guid, or `url:<feedUrl>` for the podroll feed-URL fallback (namespaced so the two can't collide). |
| `bmb:feed:<key>` | `DiscoveredNote[]` per feed. **No TTL** — every mount paints it, then a full relay fetch replaces it. Legacy `{ t, v }` wrapper is tolerated on read. Keys: `'global'`, `'podcast:<guid>'`. |
| `bmb:social:<uri>` | `DiscoveredNote[]` per `podcast:socialInteract` URI. Same no-TTL stale-while-revalidate paint as `bmb:feed` (reuses its `replies` normalizer + legacy-wrapper tolerance). Written on every successful thread fetch and after an optimistic comment; never on fetch error. |
| `bmb:boosts:*` | Local sent-boost log, capped 200 newest-first. Each entry holds intent + per-leg results + Nostr `noteId` patched in once `publishBoostNote` resolves. `boostsTick` wakes subscribers; `GlobalNostrFeed` mixes these in and dedupes against returned notes by `noteId`. |
| `bmb:pi:dead` (sessionStorage) | Circuit-breaker sentinel; cleared on hard-refresh-into-new-tab. |
| `bmb:nwc_uri_sess:<npub>` (sessionStorage) | NWC URI stashed at sign-out so a same-tab sign-back-in restores instantly without a relay query + NIP-44 decrypt (which hangs when iOS kills the extension's service worker mid-wait). Consumed (and removed) by the fast-path at the top of `doLoadProfile`; cleared on explicit NWC disconnect so a disconnected wallet can't resurrect. |

External: the **Spark mnemonic** lives encrypted on Nostr as kind:30078. The `@buildonspark/spark-sdk` `SparkWallet` keeps its own wallet state (leaves, transfer history) keyed off the seed + `accountNumber: 0`; we don't manage a storage dir for it.

## Styling tokens

Custom palette in `tailwind.config.ts` — don't introduce new colors without adding them here:

`ink` (page bg), `bone` (primary fg), `bolt` (Lightning yellow), `nostr` (magenta), `muted` (secondary), `line` (borders). Fonts: `font-display` (Bricolage Grotesque), `font-mono` (JetBrains Mono). `animate-bolt` is a 1.4s opacity pulse.

Reusable element classes: `.card`, `.btn`, `.btn-bolt`, `.btn-ghost`, `.input`, `.stamp`, `.headline`, `.seek` — defined in `app/globals.css`. Read that before inventing new ones.

## Theme system (light + dark)

**Tokens are role-based, not literal.** `ink` means "page bg", `bone` means "primary fg" — their *values* swap between modes, not their names. Tailwind reads each color as `rgb(var(--token) / <alpha-value>)` (see `tailwind.config.ts`); the actual values are CSS variables defined twice in `app/globals.css`:

- `:root` — dark mode default. `--ink: 10 10 8`, `--bone: 253 250 243`, `--bolt: 250 229 0`, `--nostr: 255 45 146`, `--muted: 138 133 122`, `--line: 31 29 24`, `color-scheme: dark`.
- `:root[data-theme='light']` — light mode. Values flip: `--ink: 253 250 243`, `--bone: 10 10 8`. Brand colors deepen because the brand yellow/magenta on bone is invisible: `--bolt: 224 168 0` (vibrant amber-gold — the earlier `191 138 0` read as muddy mustard), `--nostr: 197 20 117`. `--muted: 110 105 95`, `--line: 225 220 207`, `color-scheme: light`.

Result: `bg-ink`, `text-bone`, `border-bone/40`, `bg-ink/75` (hero overlay), `bg-ink/90` (sticky header) all work in both modes without per-component class changes. The hero overlay automatically becomes a 75% bone wash in light mode.

**Single-token tradeoff for `bolt`.** `text-bolt` has ~30 callsites (headlines, stamps, hover states, status indicators); `bg-bolt` is only `.btn-bolt` + a couple `bg-bolt/10` tints. So one token serves both fg and bg roles — light-mode `--bolt` is a vivid mid-amber that's recognizable as Lightning-yellow on the button background AND visible enough as text on bone. Don't split into two tokens unless you're prepared to refactor every callsite.

**FOUC blocker** lives inline in `<head>` in `app/layout.tsx` — reads `bmb:theme` synchronously and sets `data-theme="light"` on `<html>` before paint. `<html suppressHydrationWarning>` so React doesn't complain about the attribute the script added pre-hydration. Don't move this script to a `useEffect` — it has to run before first paint or light-mode users get a dark flash on every navigation.

**Toggle component** is `components/theme-toggle.tsx` — sun/moon button slotted in the header (`app/page.tsx`) between the spacer and `<NostrAuth />`. Persistence: `bmb:theme` localStorage key (only `'light'` is ever written; absent = dark). On toggle the component also updates `<meta name="theme-color">` so iOS Safari's status-bar tint follows. Subscribe to changes via `subscribeTheme()` (parallel to `subscribeNwc`/`subscribeSpark`) — currently unused but exposed for future per-component reactions.

Don't introduce a token whose name implies a fixed color (e.g. avoid `dark-gray`); follow the role pattern.

## Conventions worth keeping

- **`isMusicMedium(podcast)` and `hasValueRecipients(value)` live in `lib/util.ts`** (isomorphic, type-only imports from `lib/types`). Use them instead of inlining `podcast.medium?.toLowerCase() === 'music'` or `!!value?.recipients?.length`. `hasValueRecipients` returns a boolean and does **not** narrow its argument's type — at a site that then uses the value as non-null (e.g. `sendBoost({ value })`), assert `value!` after the guard. These are the **boolean gate** helpers; expressions that render the recipient *count* (`recipients?.length ?? 0`) are left inline.
- **Transport buttons go through `<TransportControls size>`** (`components/transport-controls.tsx`) — never re-inline ⏮/play/⏭. It reads playback + `episodeQueue` from the store, computes prev/next-disabled, and renders as a fragment into the parent's flex row. Used by both `player.tsx` (`sm`) and `fullscreen-player.tsx` (`lg`).
- **`NoteCard` is memoized** (`export const NoteCard = memo(NoteCardImpl)`). Feed surfaces re-render wholesale (podcast metadata resolving, `boostsTick`); note object refs are stable so memo skips untouched cards. Two rules keep it correct: `repostedIds` must be **replaced, not mutated in place**, and store-driven values (identity, mutes) stay read via `useApp` selectors *inside* the component so they bypass memo.
- **`isHlsUrl(url)` and `fnvHash(s)` live in `lib/util.ts`** (isomorphic). `isHlsUrl` (matches `.m3u8`) branches the HLS-video path from native `<audio>`. `fnvHash` is the FNV-1a → stable 31-bit int used for deterministic numeric IDs (e.g. an `Episode.id` from a guid) — one copy, imported by `lib/pi.ts` and `lib/nostr/live-streams.ts`; don't re-inline it.
- **Live-stream id parsing goes through `lib/nostr/live-streams.ts` helpers** — `streamIdOf` / `parseStreamId` / `isLiveStreamId` (and `streamChatAddr` in live-chat.ts for the `30311:` address). Don't inline `indexOf(':')`/`slice`/`/^[0-9a-f]{64}:/`.
- **Time-of-day formatters live in `lib/format.tsx`:** `fmtClock(unixSec)` (clock, e.g. "3:45 PM") and `fmtLiveTime(unixSec)` (clock for today, else "Mon D <clock>"). `fmt`/`fmtDuration` are for playback *durations*, `timeAgo` for relative. Don't re-inline `toLocaleTimeString`.
- **Horizontal card rows use `useHorizontalWheelScroll()`** (`lib/use-horizontal-wheel.ts`) to translate vertical mouse-wheel into horizontal scroll (a mouse has no sideways wheel, so without it the off-screen cards are unreachable). React's `onWheel` is passive so the listener must be attached natively, and it only hijacks the gesture when the row overflows, the gesture is vertical, and it isn't at the edge — so page scroll still takes over at the end. Used by the "Live on Nostr" row and the podroll row; don't re-inline it. **It returns a callback ref — `const rowRef = useHorizontalWheelScroll<HTMLDivElement>()` then `<div ref={rowRef}>` — and that's load-bearing.** Both consumers render a skeleton with no ref on it until their data resolves, so the real row doesn't exist at first paint. A `useEffect` reading `ref.current` sees null, bails, and never re-runs unless its dep array happens to change when the row mounts (the original code leaned on `[podcasts.length]`/`[resolved.length]` for exactly that, which reads like an unrelated perf dep and got "simplified" away once already, silently killing the wheel on both rows). A callback ref fires when the node mounts and again with null on unmount, so there's no dependency to get wrong.
- **`<FavHeart>` lives in `components/fav-heart.tsx`**, not `lists.tsx` — three surfaces render it (`lists.tsx`, `fullscreen-player.tsx`, `podroll.tsx`), and having `podroll.tsx` import it from `lists.tsx` while `lists.tsx` imports `<Podroll>` made a module cycle. `lists.tsx` re-exports it for existing import sites. It calls `stopPropagation()`/`preventDefault()` itself, so it's safe to nest inside a clickable row or card.
- **Profile avatars go through `<Avatar>`** (`components/avatar.tsx`) — `<img src={picture}>` with a deterministic colored-initial `<DefaultAvatar>` fallback on error/missing. Pass `pubkey`/`picture`/`name`/`className`. This is for *user* avatars (distinct from `<PodcastCover>` for podcast art); used by `NoteCard`, boost cards, muted-accounts, and live chat.
- **Podcast artwork goes through `<PodcastCover>`** (`components/podcast-cover.tsx`). Tries `image` first, falls back to `artwork` on `onError`, then a deterministic colored-initial tile. The two-URL fallback exists because PI returns RSS `<image><url>` as `image` and `<itunes:image>` as `artwork`, and they often disagree (Homegrown Hits has a dead `bowlafterbowl.com` `image` but a working `artwork`). Always pass both fields; the renderer handles the rest. `<PodcastCover>` uses `<img>`, not `next/image` (per-host config required); the local hero IS served via `next/image`.
- **Auxiliary relay sets use `withExtraRelays`** (`lib/nostr/pool.ts`). It dedupes the union, runs your query inside the closure, and closes only newly-opened extras in `finally` (swallowing close errors). Don't write the open / track / try-finally / close pattern inline — four near-identical copies were collapsed.
- **Browse-mode layout is single-column** in `app/page.tsx`. Selecting a podcast (search result, favorite, or a podcast-name link inside a Nostr note) sets `selectedPodcast` in Zustand, flipping to detail view (full-width episode list + per-podcast feed). `discussionEpisode` adds a third full-page view on top of that (browse → detail → discussion; see Episode discussion). Both views are state-driven swaps in `app/page.tsx`, not routes. Don't reintroduce a right-pane "select a podcast on the left" empty state.
- Native HTML5 `<audio>` plays the enclosure URL directly — no proxy, no transcoding. The one exception is HLS (`.m3u8`) live streams, which go through `<video>` + `hls.js` (see Nostr live streams).
- API routes return `{ error }` JSON via `getErrorMessage(e, fallback)` from `lib/util.ts`; clients swallow errors silently. Match this shape on new routes. New routes also start with `rateLimit(req, '<route>', N)` from `lib/rate-limit.ts` (per-IP, 60s window; by-guid runs at 300/min to absorb the favorites-hydration burst) and set `Cache-Control` on **200 responses only** — never on errors.
- **Inline SVG `BoltIcon`** (`components/icons.tsx`) on yellow buttons — the `⚡` emoji is invisible on `bg-bolt`. Other places (yellow text on dark bg, V4V stamps) keep the emoji. `ShareIcon` and `Sun`/`MoonIcon` follow the same inherits-`currentColor` SVG pattern.
- **`FavHeart` has `size` variants** (`components/fav-heart.tsx`). `'sm'` (default, used in `PodcastRow` list items and podroll cards) renders a slim border-chip; `'md'` (used in the show header) matches `.btn-ghost` dimensions so it's a visual peer to SHARE and BOOST. Both render `[♡ FAVORITE]` / `[♥ FAVORITED]` (magenta when on). The earlier bare-glyph `♡` rendering is gone — don't reintroduce it without also rethinking the header button cluster.
