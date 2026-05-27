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
| `bmb:nwc_uri` | NWC URI. |
| `bmb:rail_pref` | `'nwc' \| 'spark' \| 'webln'` — user's preferred boost rail, set when they click a rail in the boost-modal picker. Falls back to `pickRail()` priority when absent or when the preferred rail isn't available. |
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

External: the **Spark mnemonic** lives encrypted on Nostr as kind:30078. Breez SDK's wallet state (UTXOs, payment history) lives in IndexedDB at `bmb-spark-<pubkey:8>-<sha256(mnemonic):8>`.

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

- **Podcast artwork goes through `<PodcastCover>`** (`components/podcast-cover.tsx`). Tries `image` first, falls back to `artwork` on `onError`, then a deterministic colored-initial tile. The two-URL fallback exists because PI returns RSS `<image><url>` as `image` and `<itunes:image>` as `artwork`, and they often disagree (Homegrown Hits has a dead `bowlafterbowl.com` `image` but a working `artwork`). Always pass both fields; the renderer handles the rest. `<PodcastCover>` uses `<img>`, not `next/image` (per-host config required); the local hero IS served via `next/image`.
- **Auxiliary relay sets use `withExtraRelays`** (`lib/nostr/pool.ts`). It dedupes the union, runs your query inside the closure, and closes only newly-opened extras in `finally` (swallowing close errors). Don't write the open / track / try-finally / close pattern inline — four near-identical copies were collapsed.
- **Browse-mode layout is single-column** in `app/page.tsx`. Selecting a podcast (search result, favorite, or a podcast-name link inside a Nostr note) sets `selectedPodcast` in Zustand, flipping to detail view (full-width episode list + per-podcast feed). `discussionEpisode` adds a third full-page view on top of that (browse → detail → discussion; see Episode discussion). Both views are state-driven swaps in `app/page.tsx`, not routes. Don't reintroduce a right-pane "select a podcast on the left" empty state.
- Native HTML5 `<audio>` plays the enclosure URL directly — no proxy, no transcoding.
- API routes return `{ error }` JSON via `getErrorMessage(e, fallback)` from `lib/util.ts`; clients swallow errors silently. Match this shape on new routes.
- **Inline SVG `BoltIcon`** (`components/icons.tsx`) on yellow buttons — the `⚡` emoji is invisible on `bg-bolt`. Other places (yellow text on dark bg, V4V stamps) keep the emoji. `ShareIcon` and `Sun`/`MoonIcon` follow the same inherits-`currentColor` SVG pattern.
- **`FavHeart` has `size` variants** (`components/lists.tsx`). `'sm'` (default, used in `PodcastRow` list items) renders a slim border-chip; `'md'` (used in the show header) matches `.btn-ghost` dimensions so it's a visual peer to SHARE and BOOST. Both render `[♡ FAVORITE]` / `[♥ FAVORITED]` (magenta when on). The earlier bare-glyph `♡` rendering is gone — don't reintroduce it without also rethinking the header button cluster.
