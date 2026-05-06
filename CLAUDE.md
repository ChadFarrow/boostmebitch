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
cp .env.example .env.local       # PI key + secret + Breez key
npm run dev / build / start / lint
```

**No test runner, no typecheck script, no formatter.** `next build` is the de facto typecheck (strict mode on). Path alias: `@/*` → repo root.

`.env.local`: `PODCAST_INDEX_KEY`/`SECRET` (server-only), `NEXT_PUBLIC_BREEZ_API_KEY` (browser; the Spark SDK is self-custodial so the key gates SDK usage, not user funds), `APP_NAME` (optional).

## Server vs client boundary (don't cross it)

Podcast Index credentials must never reach the browser. Enforced by file conventions, not bundler config:

- **Server-only:** `lib/pi.ts` (uses `node:crypto`, reads `process.env`). Imported only by `app/api/*`. The BoostBox proxy at `app/api/lightning/boostbox/route.ts` follows the same pattern (reads `BOOSTBOX_URL`/`BOOSTBOX_API_KEY` and forwards).
- **Browser-only:** `lib/store.ts`, `lib/v4v/nwc.ts`/`webln.ts`/`lnaddr.ts`/`spark.ts`/`boostbox.ts`, `lib/nostr/`, `lib/storage.ts`, `lib/podcast-meta.ts` — they touch `window.*`, storage, IndexedDB, or load WASM. SSR guards exist but assume client context.
- **Isomorphic:** `lib/types.ts` (pure types), `lib/v4v/boost.ts` (orchestration).

Components fetch via local API routes (`fetch('/api/feed?id=…')`) — never call PI directly.

## Nostr identity enrichment

`loginWithExtension()` returns only `{ pubkey, npub }` from NIP-07. After login, `components/nostr-auth.tsx:loadProfile` runs in the background and merges five things in parallel (`Promise.all`):

- **Profile metadata (kind:0):** `name`, `display_name`, `picture`, `nip05`, `about` — header avatar, boost modal "From" auto-fill.
- **NIP-65 relay list (kind:10002):** unmarked + `write` entries → publish target.
- **NIP-51 favorites (kind:30003, `d:boostmebitch:favorites`):** see Favorites.
- **NIP-51 mute list (kind:10000):** public + NIP-04 private p-tags. See Mutes.
- **Spark wallet backup (kind:30078, `d:boostmebitch:wallet:spark`):** NIP-44 v2 encrypted-to-self mnemonic. Best-effort silent restore; failures are swallowed.

NIP-07 perms ever requested: `getPublicKey`, `signEvent`, `nip04.{en,de}crypt` (private mutes), `nip44.{en,de}crypt` (wallet backup). No kind:3 contacts, no DMs, no reactions.

**Fast-path identity hydration.** On page load, `nostr-auth.tsx` decodes cached `bmb:npub` synchronously via `nip19.decode`, sets a bare `{ pubkey, npub }` identity, and reads `storage.profile.get(pubkey)` + `storage.favorites.get(npub)` + `storage.muted.get(npub)` into the store within the same frame. The signer is only called lazily, when something actually needs to sign.

**Relay query timeouts.** Every `pool.querySync` site passes a `maxWait` from `lib/nostr/pool.ts`: `QUERY_MAX_WAIT_MS = 4000` for single-author lookups (kind:0/10000/10002/30003/30078/6) and `FEED_QUERY_MAX_WAIT_MS = 8000` for broad feed scans (kind:1 with `#i`/`#k`, reply-tree BFS, bulk profile fetches). Without these, a stalled relay pins the tab in loading. The 4s/8s split balances spinner duration vs. completeness.

`resolvePublishRelays(identity)` in `lib/nostr/` is the single source of truth for publish targets: localStorage `bmb:relays` override → identity NIP-65 write relays → `DEFAULT_RELAYS`. Capped at 20.

## Signers (NIP-07 + Amber NIP-55 + NIP-46 bunker)

The whole codebase reads from `window.nostr`. Three signer paths feed it, swapped in/out by `lib/nostr/signer.ts`:

- **NIP-07 extension** (Alby, nos2x, Flamingo, nostash on iOS Safari). Already at `window.nostr`; we don't polyfill. Sign-out clears `bmb:npub` but leaves `window.nostr` alone.
- **Amber on Android** (NIP-55, `lib/nostr/amber.ts`). Polyfills `window.nostr` with an `AmberSigner` that dispatches via `nostrsigner:` URL scheme and reads results back from the system clipboard. Round-trip: `nostrsigner:<urlEncoded payload>?compressionType=none&returnType=event&type=<…>` (no callbackUrl per spec) → user approves in Amber → first user gesture (`pointerdown`/`touchstart`/`keydown`) reads the clipboard with fresh transient activation. `restoreAmberSigner(pubkey)` is the synchronous fast-path on page load.
- **NIP-46 bunker / remote signer** (`lib/nostr/bunker.ts`, wraps nostr-tools `BunkerSigner`). Two flows: paste a `bunker://` URI or generate a `nostrconnect://` URI. Reconnect on reload is async (`restoreBunkerSigner()` rebuilds from `bmb:bunker:{uri,clientSk}`); signing calls before it resolves throw, but nothing signs unprompted post-load. Compatible with **Clave** (iOS-native, APNs-driven), **nsec.app**, **Amber-as-bunker**, Primal.

### `lib/nostr/signer.ts` — the swap point

Only one polyfill is active at a time. `captureOriginal()` snapshots the underlying NIP-07 extension on first activation so deactivation can restore it. `bmb:signer` holds `'amber' | 'bunker' | absent` so the fast-path useEffect knows what to restore. Capability accessors live here too: `getNip04()`/`getNip44()` (return API or null), `requireNip44()` (throws). Use these instead of inlining `typeof window !== 'undefined' && window.nostr?.nipXX`.

### Per-platform decision tree (`components/nostr-auth.tsx`)

```
extensionBrand = detectExtensionBrand()  // window.alby | window.nostr | null
android        = isLikelyAndroid()
ios            = isLikelyIOS()           // includes iPad-as-Mac UA fallback

signerKind =
  extension !== null ? 'extension'  // → loginWithExtension
  : android          ? 'amber'      // → loginWithAmber
  : ios              ? 'bunker'     // → opens bunker disclosure
  :                    'none'       // → throws install hint
```

Primary button label: `'Sign in with Alby'` (only Alby exposes `window.alby`; nos2x/Flamingo are indistinguishable, label stays generic), `'Sign in with Amber'`, `'Connect remote signer'` (iOS), or `'Sign in with Nostr'`.

**iOS surfaces the bunker flow as primary** because Safari iOS doesn't run NIP-07 in PWA mode. A helper line names Clave (TestFlight) as the recommended pairing target. The "◆ Use a remote signer" disclosure is hidden on iOS to avoid duplicating the primary action; it's available on Android/desktop.

### Re-detection at runtime

Two listeners in `nostr-auth.tsx`:

1. **Extension re-detection** on `window.focus` and `document.visibilitychange` — covers install-while-open. `signin()` itself also re-reads `detectExtensionBrand()` at click time, so install-then-click works without waiting for focus.
2. **Account-change detector** on `window.focus` while signed in via extension. Re-calls `getPublicKey()` (throttled 30s); if the active account changed, drives `loginWithExtension` + `completeSignIn` to switch identities. Multi-identity Alby/nos2x users are first-class.

### Lifecycle observables

- **`subscribeAmberStage(fn)`** in `amber.ts` — `'idle' | 'awaiting' | 'returned'`. `<AmberCompletion>` flips its hint copy in lockstep with `invokeAmber`'s real lifecycle. While in flight it always shows a "◆ Read clipboard manually" button + paste textarea — `visibilitychange` is unreliable on standalone-PWA returns, so the user always has a tap-able path.
- **`subscribeBunkerHealth(fn)`** in `bunker.ts` — `boolean` (stale or not). Adapter calls run through `trackBunkerCall` with a 30s timeout. `<BunkerHealthBanner>` inside `<AccountMenu>` shows "Signer disconnected — Reconnect" calling `restoreBunkerSigner()`. Targets the iOS-PWA-suspended-WebSocket case.

## PWA install

`public/manifest.json` + `public/sw.js` + `<SwRegister>` (mounted in `app/layout.tsx`). Display mode `standalone`; icons in `public/icons/` + `public/icon.svg`; iPhone splash screens in `public/splash/`. Header has `pt-[env(safe-area-inset-top)]` so the bolt + title clear the iPhone notch in standalone mode.

**The SW has no precaching.** Next.js emits hashed bundle URLs that change every build, so any stale cache would silently break installed users. The empty `fetch` handler exists only so Chrome/Edge surface the install prompt.

## Favorites (NIP-51 kind:30003)

♡ on a podcast row toggles a favorite. Authoritative event: kind:30003 with `d:boostmebitch:favorites`, one `i: podcast:guid:<guid>` + `k: podcast:guid` per favorite. Cache: `bmb:favorites:<npub>` (or `:guest`) holds the full `FavoritePodcast[]` for instant render. Toggles are optimistic; publish is **debounced 1.5s** via `schedulePublishFavorites`. Hydration in `loadProfile` does last-write-wins on `event.created_at` vs newest local `addedAt`, then resolves unknown guids via `/api/by-guid`.

**UUID filter at parse:** `lib/nostr/favorites.ts` enforces a UUID shape on every `i: podcast:guid:<value>` tag. Older versions (and other clients reusing the d-tag) wrote feed IDs and arbitrary strings. Bad values are returned as `droppedGuids`; when count > 0, `nostr-auth.tsx` registers `window.bmbCleanFavorites()` so the user can republish a cleaned event from devtools.

Sign-out clears in-memory favorites; the per-npub cache is left so re-signing in is fast. No episode-level favorites, no list categories, no share UI.

## Mutes (NIP-51 kind:10000)

🚫 on a `<NoteCard>` mutes that author. Interoperates with Damus/Amethyst/Coracle. `MuteListState` in `lib/nostr/mutes.ts` has parallel **public** p-tags (in event tags) and **private** p-tags (NIP-04-encrypted JSON tag-array in `event.content`). New mutes go to private (Damus default); when the signer doesn't expose `nip04`, the read path parks the raw ciphertext in `unreadablePrivateContent` and the publish path passes that blob through verbatim — we never destroy private mutes set in another client. New mutes degrade to public p-tags in that case. Non-`p` tags (`e`, `t`, `word`) are also preserved verbatim.

Filtering is at render time (`<NoteCard>` early-returns null; feeds filter top-level + replies before mapping). Storage `bmb:muted:<npub>` is `MuteListState` JSON; `lib/storage.ts` auto-promotes the legacy `{ pubkeys, otherTags }` shape on read. Account menu surfaces a collapsible "Muted accounts (N)" with kind:0 lookups firing only while expanded.

## Wallets — account menu

All wallet config now lives in **`components/wallet-modal.tsx`** — a portal'd overlay opened by `<WalletButton>` inside `<AccountMenu>` (`components/nostr-auth.tsx:853`). The modal is portal'd to `document.body` so `position: fixed` resolves against the viewport, not the sticky `<header>` (the header's `backdrop-blur` creates a containing block for fixed descendants per CSS spec — without the portal, mobile renders it clipped to the header).

All three sub-cards (NWC, Spark, WebLN) render unconditionally — each flips internally between its connected card and its connect form. This lets the user wire up a second rail (or switch wallets) without first disconnecting the active one. WebLN only appears when `weblnAvailable` (extension injected).

Sub-cards (each its own component): `nwc-wallet.tsx`, `spark-wallet.tsx`, `webln-wallet.tsx`. State changes propagate via `subscribeNwc()` + `subscribeSpark()`; the modal `setTick`s on either to flip between modes without remount.

**Boost modal rail picker.** When 2+ rails are available, `components/boost-modal/index.tsx` renders a small "Pay via [NWC] [Spark] [WebLN]" pill row above the AmountInput so the user can override `pickRail()`'s default per-boost. Single-rail users never see it. The picker subscribes to `subscribeNwc`/`subscribeSpark` so enabling a rail mid-modal flips the row in place. WebLN doesn't have its own subscribe (the extension is either injected at load or it isn't), so we read `hasWebln()` on each render. The `!rail` "no wallet connected" hint still renders below the picker as a fallback for the zero-rail case.

`<BunkerHealthBanner>` still sits at the top of `<AccountMenu>` (not the wallet modal), since it's signer health, not wallet health.

**Wallet balance display.** Two surfaces share one hook:

- `<WalletBalanceChip>` inside the `<AccountMenu>` trigger button — always-on glance, follows priority order.
- `<BoostModalBalance rail={rail}>` in the boost-modal sticky footer — accepts the modal's selected rail so the displayed balance always tracks the picker. Turns nostr-magenta when `amountSats > balance`.

Both come from `components/wallet-balance.tsx`. `useWalletBalance(railOverride?)` returns `{ balance, rail }`. With no override, priority is **NWC > Spark > WebLN** (matches `pickRail()` in `lib/v4v/boost.ts`). With an override, the hook fetches that specific rail's balance, collapsing to null if the override points at a disconnected/disabled rail.

- **Spark branch** mirrors `<ReadyPanel>`: subscribes to `subscribeSparkEvents` (`paymentSucceeded`/`claimedDeposits`/`newDeposits`/`synced`) and runs a 2s/5s/12s retry schedule after attach so a fresh restore doesn't sit on a stale 0.
- **NWC branch** uses `nwcGetBalance()` (NIP-47 `get_balance`, msat → floor to sats) plus `subscribeNwcNotifications` for `payment_received`/`payment_sent` push when supported. Falls back to `visibilitychange`/`focus` refreshes for wallets that don't support notifications.
- **WebLN branch** is gated on `isWeblnEnabled()` — module-level state set when the user explicitly clicks "Enable for this site" or completes a WebLN payment. We do **not** call `wl.enable()` speculatively to read balance, since that would prompt the user. After enable, `weblnGetBalance()` calls `wl.getBalance()` (defensively handling `currency: 'msat' | 'btc'` since the spec leaves the unit free). No notifications API in WebLN, so refresh fires on `subscribeWebln` events (post-payment notify) + `visibilitychange`/`focus`.

All three balance helpers swallow errors and return null so a missing capability (NWC connection without `get_balance` permission, WebLN provider without `getBalance`) just hides the chip rather than throwing.

**Last-known balance cache.** `useWalletBalance` writes the live `{ rail, balance }` to `storage.walletBalance` (per-npub) on every successful fetch, and reads it back on mount as a fallback. Without it, a returning user sees a blank chip for 5-10 s while Breez Spark cold-restores (relay query for the kind:30078 backup → NIP-44 decrypt → WASM load → `connect()` → initial sync). With it, the chip paints the cached number instantly and only swaps to the live value once the SDK is ready. Cleared on explicit Spark/NWC disconnect (`<SparkWallet>` and `<NwcWallet>` call `storage.walletBalance.clear(npub)`). The cached balance is only paired with a matching live rail — we never show a stale Spark balance under an NWC label.

## Spark rail (Breez SDK)

`lib/v4v/spark.ts` wraps `@breeztech/breez-sdk-spark`. WASM only lands in the bundle on first wallet open (dynamic import inside `sparkInitFromMnemonic`).

Load-bearing rules:

1. **BOLT11 only.** Spark cannot keysend. `lib/v4v/boost.ts` rejects every `node`-type recipient on the Spark rail per-leg with a clear error. lnaddress works because `payOne` fetches a BOLT11 from the LNURL-pay callback first.
2. **Network is `mainnet` or `regtest` — no public testnet exists.** Use `network: 'regtest'` against a local node for development; the type union enforces this.
3. **`storageDir` is keyed on `(ownerPubkey[:8], sha256(mnemonic)[:8])`.** Two wallets for the same npub get different SDK directories — `walletStorageDir()` does the hashing. Keying on pubkey alone collides on disconnect+recreate; the SDK either rejects re-init or corrupts state.
4. **Two-step send.** `sparkPayInvoice` runs `sdk.prepareSendPayment({ paymentRequest })` then `sdk.sendPayment({ prepareResponse })`. Preimage from `payment.preimage` or `payment.details.htlcDetails.preimage`.
5. **Events drive the balance, not polling.** `subscribeSparkEvents()` wraps the SDK's `addEventListener`. `paymentSucceeded`/`claimedDeposits`/`newDeposits`/`synced` trigger `sparkGetInfo()` in `<ReadyPanel>`; the first three also auto-dismiss any outstanding deposit invoice.

Mnemonic is published encrypt-to-self as kind:30078 (`lib/nostr/wallet-backup.ts`) — anyone with the user's nsec can decrypt; backup is convenience, not the only copy. The seed-display step is the user's chance to write it down. Re-create flow checks for an existing backup and confirms before overwrite (kind:30078 is NIP-33 replaceable — newer wins, prior is gone forever).

**Restore-side relay union.** `fetchEncryptedMnemonic` queries `resolvePublishRelays(identity) ∪ DEFAULT_RELAYS` (deduped, capped at 20) with the longer 8s `FEED_QUERY_MAX_WAIT_MS`. Otherwise a fresh Android Amber sign-in (where NIP-65 hasn't hydrated yet) falls back to defaults and misses backups on the user's outbox relays. `publishEncryptedMnemonic` stays on `resolvePublishRelays(identity)`.

**Post-restore balance race.** `<ReadyPanel>` attaches the SDK event listener BEFORE the first `getInfo()` call, then re-polls at 2s/5s/12s. Otherwise Breez Spark's initial sync after `connect()` can complete between our `connect` resolving and the listener attaching, leaving the panel stuck at a cached 0.

## Show-level boost

`BoostModal` accepts `episode` as optional. When omitted (`isShowBoost = !episode`):

- Headlines podcast title, skips the playback-timestamp line.
- Reads value from `podcast.value`.
- Boostagram includes `podcast`/`feedID`/`url`/`remote_feed_guid`, skips `episode`/`itemID`/`episode_guid`/`remote_item_guid`. `ts: 0`.
- Auto-formatted note body skips the `📻 <episode>` line and the `podcast:item:guid:` `i`-tag.

The "⚡ BOOST" button on the `EpisodeList` header opens this mode (gated on `podcast.value.recipients.length > 0`). The per-episode boost path in `Player` is unchanged.

## Boost flow invariants

`components/boost-modal/index.tsx` orchestrates; `lib/v4v/boost.ts` is the engine. Load-bearing:

1. **Lightning first, then Nostr.** `publishBoostNote` only fires after `sendBoost` returns *and* `collected.some(r => r.ok)`. Don't reorder — inverting publishes false "I boosted" notes when all payments fail.
2. **Rail priority is NWC > Spark > WebLN.** `pickRail()` returns `'nwc'` if URI saved, else `'spark'` if initialized, else `'webln'` if detected, else `null`. User can override.
3. **Episode value-block fallback happens server-side.** `app/api/feed/route.ts` does `e.value ?? podcast.value`. Don't re-implement in the modal.
4. **Splits use weights, not percentages.** `splitSats()` floors per-recipient, dumps the remainder onto the first non-fee recipient. `ValueRecipient.split` is a weight; total weight is the denominator.
5. **TLV record `7629169` only.** Boostagram JSON goes there (Podcasting 2.0 standard). `sender_id` lives inside that JSON. We deliberately do **not** also emit a separate `696969` sender record — that key collides with shared-node sub-account routing (e.g. getalby.com uses `customKey=696969 customValue=<sub-account>`). Per-recipient `customKey`/`customValue` from the value block IS attached to the keysend.
6. **WebLN `customRecords` are plain JSON, not hex.** WebLN providers hex-encode internally. Pre-hexing causes double-encoding and Helipad can't `JSON.parse`. NWC's `pay_keysend` is the opposite — NIP-47 requires hex-encoded TLV. See `tlvHexFor` (NWC) vs `recordsForKeysend` (WebLN) — symmetric-looking, genuinely different wire formats.
7. **Note amount is intent, not actual.** `formatContent` and the `amount` tag use `boostagram.value_msat_total`, not the sum of successful legs. A user who boosts 100 sats with one failed leg still posts "Boosted 100 sats"; partial breakdown is in the modal and Helipad.
8. **BoostBox is LNURL-only.** `lib/v4v/boostbox.ts` POSTs metadata via `/api/lightning/boostbox` *before* `fetchLnInvoice`, then puts the returned `desc` (`rss::payment::boost <url>`) in the LUD-21 `comment` field. Keysend recipients are untouched (TLV `7629169` carries the boostagram inline). BoostBox failure is non-fatal; LNURL falls back to `boostagram.message`.

## Nostr publish shape

`publishBoostNote()` in `lib/nostr/boost-notes.ts` builds a kind:1 with:

- NIP-73 `i`/`k` pairs for `podcast:guid:<feed-guid>` and (per-episode) `podcast:item:guid:<item-guid>`.
- `r` tag via `podcastLandingUrl`: prefers `https://pod.link/<itunesId>` (smart deep-link to the user's podcast app), falls back to `https://podcastindex.org/podcast/<feedId>`, then raw RSS URL.
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

`app/layout.tsx` renders `public/hero.jpg` as a fixed full-viewport layer with a 75% ink overlay and `<Image fill priority />` (AVIF/WebP). Same image doubles as the OG via `metadata.openGraph.images`.

**`bg-ink` lives on `<html>`, NOT `<body>`.** A `body` background propagates to the canvas and paints over the fixed image layer regardless of z-index. Moving `bg-ink` back to `<body>` silently breaks the hero — no errors, just a dark page.

## State + persistence

Zustand store (`lib/store.ts`) holds: `identity`, `current`, `isPlaying`, `positionSec`, `selectedPodcast` (lifted out of `app/page.tsx` so a podcast-name link inside a `<NoteCard>` can flip the layout without prop-drilling), `favorites`, `mutedPubkeys`, `boostsTick`. **In-memory only.**

Everything else lives in `localStorage` and is never sent server-side. **All `bmb:*` keys go through typed helpers in `lib/storage.ts`** — don't call `localStorage.getItem`/`setItem` directly anywhere else. If you add a persisted field, add an accessor and use the `bmb:*` prefix.

Keys (per-identity ones key on `<npub>` or `:guest`):

| Key | Purpose / quirk |
|---|---|
| `bmb:signer` | `'amber' \| 'bunker'` when a polyfill signer is active; absent for NIP-07 / signed out. Page-load fast-path branches on this. |
| `bmb:bunker` | NIP-46 `{ uri, clientSk }`. Persisting `clientSk` keeps the bunker treating us as the same logical client across reloads (no re-auth). |
| `bmb:nwc_uri` | NWC URI. |
| `bmb:rail_pref` | `'nwc' \| 'spark' \| 'webln'` — user's preferred boost rail, set when they click a rail in the boost-modal picker. Falls back to `pickRail()` priority when absent or when the preferred rail isn't available. |
| `bmb:wallet_balance:*` | `{ rail, balance, ts }` per npub — last-known wallet balance + rail. Read on mount so the header chip paints instantly while the SDK reconnects; written after every successful balance fetch; cleared on explicit Spark/NWC disconnect. |
| `bmb:relays` | JSON array, manual publish-relay override. |
| `bmb:sender_name` | Last "From" name in the boost modal. |
| `bmb:share_nostr` | `'0'` = default to NOT publishing a Nostr note for new boosts. |
| `bmb:npub` | Sentinel for silent re-login on page load. |
| `bmb:favorites:*` | `FavoritePodcast[]` cache. |
| `bmb:muted:*` | `MuteListState` JSON; `lib/storage.ts` auto-promotes the legacy shape. |
| `bmb:profile3:<pubkey>` | kind:0 cache. **7-day TTL on hits, 15-min on misses** (so PROFILE_RELAYS additions / temp outages re-resolve). The `3` suffix is a schema version — bump when shape changes. |
| `bmb:pmeta:<guid>` | `/api/by-guid` cache, 7-day TTL. |
| `bmb:feed:<key>` | `DiscoveredNote[]` per feed. **No TTL** — every mount paints it, then a full relay fetch replaces it. Legacy `{ t, v }` wrapper is tolerated on read. Keys: `'global'`, `'podcast:<guid>'`. |
| `bmb:boosts:*` | Local sent-boost log, capped 200 newest-first. Each entry holds intent + per-leg results + Nostr `noteId` patched in once `publishBoostNote` resolves. `boostsTick` wakes subscribers; `GlobalNostrFeed` mixes these in and dedupes against returned notes by `noteId`. |
| `bmb:pi:dead` (sessionStorage) | Circuit-breaker sentinel; cleared on hard-refresh-into-new-tab. |

External: the **Spark mnemonic** lives encrypted on Nostr as kind:30078. Breez SDK's wallet state (UTXOs, payment history) lives in IndexedDB at `bmb-spark-<pubkey:8>-<sha256(mnemonic):8>`.

## Styling tokens

Custom palette in `tailwind.config.ts` — don't introduce new colors without adding them here:

`ink` (#0a0a08, bg), `bone` (#fdfaf3, fg), `bolt` (#fae500, Lightning yellow), `nostr` (#ff2d92, magenta), `muted` (#8a857a, secondary), `line` (#1f1d18, borders). Fonts: `font-display` (Bricolage Grotesque), `font-mono` (JetBrains Mono). `animate-bolt` is a 1.4s opacity pulse.

Reusable element classes: `.card`, `.btn`, `.btn-bolt`, `.btn-ghost`, `.input`, `.stamp`, `.headline`, `.seek` — defined in `app/globals.css`. Read that before inventing new ones.

## Conventions worth keeping

- **Podcast artwork goes through `<PodcastCover>`** (`components/podcast-cover.tsx`). Tries `image` first, falls back to `artwork` on `onError`, then a deterministic colored-initial tile. The two-URL fallback exists because PI returns RSS `<image><url>` as `image` and `<itunes:image>` as `artwork`, and they often disagree (Homegrown Hits has a dead `bowlafterbowl.com` `image` but a working `artwork`). Always pass both fields; the renderer handles the rest. `<PodcastCover>` uses `<img>`, not `next/image` (per-host config required); the local hero IS served via `next/image`.
- **Auxiliary relay sets use `withExtraRelays`** (`lib/nostr/pool.ts`). It dedupes the union, runs your query inside the closure, and closes only newly-opened extras in `finally` (swallowing close errors). Don't write the open / track / try-finally / close pattern inline — four near-identical copies were collapsed.
- **Browse-mode layout is single-column** in `app/page.tsx`. Selecting a podcast (search result, favorite, or a podcast-name link inside a Nostr note) sets `selectedPodcast` in Zustand, flipping to detail view (full-width episode list + per-podcast feed). Don't reintroduce a right-pane "select a podcast on the left" empty state.
- Native HTML5 `<audio>` plays the enclosure URL directly — no proxy, no transcoding.
- API routes return `{ error }` JSON via `getErrorMessage(e, fallback)` from `lib/util.ts`; clients swallow errors silently. Match this shape on new routes.
- **Inline SVG `BoltIcon`** (`components/icons.tsx`) on yellow buttons — the `⚡` emoji is invisible on `bg-bolt`. Other places (yellow text on dark bg, V4V stamps) keep the emoji.
