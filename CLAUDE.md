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

`resolvePublishRelays(identity)` in `lib/nostr/relays.ts` is the single source of truth for publish targets: localStorage `bmb:relays` override → identity NIP-65 write relays → `DEFAULT_RELAYS`. Capped at 20.

**`sanitizeRelays(urls)`** (also `lib/nostr/relays.ts`) drops any entry that isn't a parseable `ws://`/`wss://` URL, then dedupes and strips trailing slashes. Applied at the two points untrusted relay lists enter: the NIP-65 parse in `fetchRelayList` and the output of `resolvePublishRelays` (covers the `bmb:relays` override too; falls back to `DEFAULT_RELAYS` if sanitizing empties the list). A corrupt entry — e.g. a NIP-65 `r`-tag value of `"avatar wss://purplerelay.com"` — otherwise reaches nostr-tools' `normalizeURL`, which **throws `Invalid URL` synchronously inside `pool.querySync`**; that rejection escapes per-call try/catch and aborts the whole flow (it killed the Spark "Create new" backup check). A survivor of `sanitizeRelays` is guaranteed to parse, so `normalizeURL` can't throw on it.

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

The "⚡ BOOST" button on the `EpisodeList` header opens this mode (gated on `podcast.value.recipients.length > 0`). The per-episode boost path in `Player` is unchanged.

## Show-page URL contract (`?podcast=<guid>`)

`selectedPodcast` is mirrored to the URL via two `useEffect`s in `app/page.tsx` — no Next.js routing involved. One reads `?podcast=<guid>` on mount and calls `resolvePodcastByGuid` (`lib/podcast-meta.ts`) to hydrate the detail view; the other watches `selected?.podcastGuid` and writes/clears the param. Hydration uses `useApp.getState()` re-checks before `setSelected` to avoid the StrictMode double-mount race overwriting a user click that landed during resolution.

**`history.replaceState`, not `pushState`.** Deliberate: the explicit "← back to results" button stays the only in-app way out of detail view. `pushState` would make browser-back a second exit and require a `popstate` listener to keep Zustand and the URL in sync. Bad/unresolvable guids fall back to the browse view silently via the PI breaker (`bmb:pi:dead` sessionStorage sentinel).

The **SHARE button** in `EpisodeList`'s header (`components/lists.tsx:ShareButton`) copies `origin + ?podcast=<guid>` to the clipboard with a 1.8 s "COPIED" label flip. Clipboard-only by design — no Web Share API, no pod.link option (that's already what the Nostr boost note links to via `podcastLandingUrl`).

Header action cluster order: `[♡ FAVORITE] [↗ SHARE] [⚡ BOOST]`. BOOST is still gated on `showHasValue`; SHARE and FAVORITE are always visible.

## Episode discussion (`podcast:socialInteract`, Nostr)

Episodes (and RSS live items) can carry `<podcast:socialInteract protocol="nostr" uri="nostr:nevent1…|note1…">` pointing at a publisher-designated Nostr root note that anchors that episode's discussion. `lib/pi.ts` parses them into `Episode.socialInteract: SocialInteract[]` (sorted by `priority`), normalizing both spec `nostr:<bech32>` and non-standard `https://njump.me/<bech32>` URIs via `extractNostrUri`. PI's `/episodes/byfeedid` doesn't expose the tag, so `getSocialInteractsFromRss` fetches the feed and the `/api/feed` route merges by guid. Only `protocol="nostr"` is kept.

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

1. **Lightning first, then Nostr.** `publishBoostNote` only fires after `sendBoost` returns *and* `collected.some(r => r.ok)`. Don't reorder — inverting publishes false "I boosted" notes when all payments fail.
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

## /api/by-guid resilience and PI breaker

`/api/by-guid` 5xxs when PI keys are missing or PI is down. A returning user with a 100-guid favorites set would otherwise hammer the broken endpoint on every reload (StrictMode + Fast Refresh amplifies into thousands).

`lib/podcast-meta.ts` is the single resolver. Four guards stacked:

1. In-memory `Map<guid, Podcast | null>` — also caches misses so each guid is attempted at most once per page.
2. `storage.podcastMeta` (localStorage, 7-day TTL) — survives reloads.
3. **Circuit breaker.** First 5xx trips `sessionStorage['bmb:pi:dead'] = '1'`. Persists across reloads in the same tab; a hard refresh starts a new session. `piMaybeUp()` lets callers gate parallel batches.
4. Network.

Fan-out callers use **probe-first-then-batch**: await one resolve, check `piMaybeUp()`, only then `Promise.all` the rest. The global feed resolver runs in a `useEffect` that depends only on `notes` (not `podcasts` state); attempted-guid tracking lives in a `useRef<Set<string>>` so `setPodcasts` doesn't re-fire the effect (that bug caused a fetch storm pinning the dev server).

## Background art and the canvas-bg gotcha

`app/layout.tsx` renders `public/hero.jpg` as a fixed full-viewport layer with a `bg-ink/75` overlay and `<Image fill priority />` (AVIF/WebP). The overlay's opacity is what mutes the image; in light mode `--ink` flips to cream so the same `bg-ink/75` becomes a 75% bone wash automatically. Same image doubles as the OG via `metadata.openGraph.images`.

**The page background lives on `<html>`, NOT `<body>`.** It's set via CSS in `app/globals.css` (`html, body { background: rgb(var(--ink)) }` + the explicit rule on `html`), not via a Tailwind class. A `body` background propagates to the canvas and paints over the fixed image layer regardless of z-index. Moving the background to `<body>` (or putting `bg-ink` back on `<body>`) silently breaks the hero — no errors, just a flat-color page.

## State + persistence

Zustand store (`lib/store.ts`) holds: `identity`, `current`, `isPlaying`, `positionSec`, `selectedPodcast` (lifted out of `app/page.tsx` so a podcast-name link inside a `<NoteCard>` can flip the layout without prop-drilling), `discussionEpisode` (the episode whose `socialInteract` thread the full-page discussion view shows; `selectPodcast` clears it), `favorites`, `mutedPubkeys`, `boostsTick`. **In-memory only.**

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
| `bmb:pmeta:<guid>` | `/api/by-guid` cache, 7-day TTL. |
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

- **`NoteCard` is memoized** (`export const NoteCard = memo(NoteCardImpl)`). Feed surfaces re-render wholesale (podcast metadata resolving, `boostsTick`); note object refs are stable so memo skips untouched cards. Two rules keep it correct: `repostedIds` must be **replaced, not mutated in place**, and store-driven values (identity, mutes) stay read via `useApp` selectors *inside* the component so they bypass memo.
- **Podcast artwork goes through `<PodcastCover>`** (`components/podcast-cover.tsx`). Tries `image` first, falls back to `artwork` on `onError`, then a deterministic colored-initial tile. The two-URL fallback exists because PI returns RSS `<image><url>` as `image` and `<itunes:image>` as `artwork`, and they often disagree (Homegrown Hits has a dead `bowlafterbowl.com` `image` but a working `artwork`). Always pass both fields; the renderer handles the rest. `<PodcastCover>` uses `<img>`, not `next/image` (per-host config required); the local hero IS served via `next/image`.
- **Auxiliary relay sets use `withExtraRelays`** (`lib/nostr/pool.ts`). It dedupes the union, runs your query inside the closure, and closes only newly-opened extras in `finally` (swallowing close errors). Don't write the open / track / try-finally / close pattern inline — four near-identical copies were collapsed.
- **Browse-mode layout is single-column** in `app/page.tsx`. Selecting a podcast (search result, favorite, or a podcast-name link inside a Nostr note) sets `selectedPodcast` in Zustand, flipping to detail view (full-width episode list + per-podcast feed). `discussionEpisode` adds a third full-page view on top of that (browse → detail → discussion; see Episode discussion). Both views are state-driven swaps in `app/page.tsx`, not routes. Don't reintroduce a right-pane "select a podcast on the left" empty state.
- Native HTML5 `<audio>` plays the enclosure URL directly — no proxy, no transcoding.
- API routes return `{ error }` JSON via `getErrorMessage(e, fallback)` from `lib/util.ts`; clients swallow errors silently. Match this shape on new routes. New routes also start with `rateLimit(req, '<route>', N)` from `lib/rate-limit.ts` (per-IP, 60s window; by-guid runs at 300/min to absorb the favorites-hydration burst) and set `Cache-Control` on **200 responses only** — never on errors.
- **Inline SVG `BoltIcon`** (`components/icons.tsx`) on yellow buttons — the `⚡` emoji is invisible on `bg-bolt`. Other places (yellow text on dark bg, V4V stamps) keep the emoji. `ShareIcon` and `Sun`/`MoonIcon` follow the same inherits-`currentColor` SVG pattern.
- **`FavHeart` has `size` variants** (`components/lists.tsx`). `'sm'` (default, used in `PodcastRow` list items) renders a slim border-chip; `'md'` (used in the show header) matches `.btn-ghost` dimensions so it's a visual peer to SHARE and BOOST. Both render `[♡ FAVORITE]` / `[♥ FAVORITED]` (magenta when on). The earlier bare-glyph `♡` rendering is gone — don't reintroduce it without also rethinking the header button cluster.
