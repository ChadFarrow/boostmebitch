# Wallets — the wallet modal and the Spark rail

Read before touching `components/wallet-modal.tsx`, `*-wallet.tsx`, `components/wallet-balance.tsx`, `lib/v4v/nwc.ts`, `spark.ts`, or `webln.ts`.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

## Wallets — the wallet modal

All wallet config lives in **`components/wallet-modal.tsx`**, a portal'd overlay opened from `<AuthControl>` (`walletOpen`). Portal'd to `document.body` so `position: fixed` resolves against the viewport, not the sticky `<header>` — the header's `backdrop-blur` creates a containing block for fixed descendants, and without the portal mobile renders the modal clipped to the header.

Picker order is **WebLN, NWC, Spark**; signed out, the **Spark row is disabled** with a "◆ Sign in with Nostr" hint (its seed is NIP-44-encrypted to the user's key), while NWC + WebLN work fully signed-out.

Three-view state machine — `WalletView = picker | connecting | connected` — showing **one rail at a time**. Opens on `connected` when `getActiveRail()` finds one (rail-pref first, then NWC > Spark > WebLN, WebLN gated on `isWeblnEnabled()`), else `picker`. "Switch wallet →" reopens the picker; tapping an already-connected rail there makes it the active payer, while connecting a new one clears the others. Sub-cards `nwc-wallet.tsx` / `spark-wallet.tsx` / `webln-wallet.tsx` take `mode="form" | "card"`; `subscribeNwc`/`subscribeSpark`/`subscribeWebln` drive a `setTick` so views flip without remount.

**NWC Nostr backup (opt-in).** An **"Encrypt & back up this connection to Nostr"** checkbox on both the connect form and the connected card, default **off** — an NWC URI is a budgeted spending credential. On → `publishEncryptedNwc` (kind:30078, `d:boostmebitch:wallet:nwc`, NIP-44 encrypted-to-self `{ uri }`) + `storage.nwcBackup.set(npub)`. Off → `deleteEncryptedNwc` tombstones it (empty-content replaceable event; `fetchEncryptedNwc` reads empty content as "no backup") + clears the flag. Gated on `getNip44()`. Auto-restored in `loadProfile` when the device has no local URI. Unlike the Spark seed (always backed up), this is explicit-opt-in and deletable.

- **Two restore layers.** `loadProfile` is best-effort (relay query + decrypt can lose a race; failures swallowed). The safety net: when the connect form mounts with no local URI and a NIP-44-capable identity, it quietly runs `fetchEncryptedNwc` itself — at most once per npub per page load (module-scope `autoCheckedNpubs`, so reopening the modal doesn't re-query). The manual "↩ Restore from Nostr backup" button remains for retries. Every restore path calls `markNwcRestored(npub)`; the connected card shows a one-time "✓ Connection restored" notice and clears the flag on unmount.
- **The card checkbox reads `storage.nwcBackup.get(npub)` live**, not init-once state, so an auto-restore or a late-arriving identity is reflected. The form keeps a local opt-in boolean applied on Connect.
- **`disconnect()` awaits the tombstone** before clearing the local URI/flag. A failed delete keeps the connection so the user can retry — fire-and-forgetting would leave the encrypted event to silently auto-restore next login.
- **Sign-out and npub-switch clear the global `bmb:nwc_uri` + the per-npub flag.** It's a single global key; without this the next account on a shared device inherits the previous one's wallet, and its own restore (gated on `!hasNwc()`) is blocked.

**Boost modal rail picker — `components/rail-picker.tsx`, shared by BOTH boost modals.** The "Pay via [NWC] [Spark] [WebLN]" pill row renders whenever 2+ rails are connected, nothing when there's no choice.

It used to live only in `BoostAllModal`, with `BoostModal` picking silently via `pickRail()`. **That asymmetry was a money bug.** `pickRail()` honors `storage.railPref` — the last rail that successfully paid — ahead of the priority fallback, so a user who once boosted through a WebLN extension keeps paying from it forever, *including* after funding a Spark wallet, with nothing on screen naming the rail. Hit live: a freshly funded Spark wallet sat untouched while the boost went out of the extension. The header chip is not a safeguard — `useWalletBalance()` resolves with the same pref-first logic and was faithfully showing the WebLN balance. Keep the picker in both modals; the shared component is what stops them drifting again.

Both modals subscribe to `subscribeNwc`/`subscribeSpark` so a mid-modal connect updates `rail` without remount, and `availableRails()` is called during render for the same reason. WebLN has no subscribe (the extension is injected at load or isn't), so `hasWebln()` is read each render. `<BunkerHealthBanner>` stays in `<AccountMenu>` — signer health, not wallet health.

**Wallet balance display.** Two surfaces, one hook (`components/wallet-balance.tsx`): `<WalletBalanceChip>` in the `<AuthControl>` button (follows priority order) and `<BoostModalBalance rail={rail}>` in the boost-modal footer (tracks the picker; turns nostr-magenta when `amountSats > balance`). `useWalletBalance(railOverride?)` returns `{ balance, rail }`; with no override, priority is **NWC > Spark > WebLN** (matching `pickRail()`), and with one it collapses to null if that rail is disconnected/disabled.

- **Spark** mirrors `<ReadyPanel>`: subscribes to `subscribeSparkEvents` and runs a 2s/5s/12s retry schedule after attach so a fresh restore doesn't sit on a stale 0.
- **NWC** uses `nwcGetBalance()` (NIP-47 `get_balance`, msat → floor to sats) plus `subscribeNwcNotifications` for `payment_received`/`payment_sent` push where supported, falling back to `visibilitychange`/`focus`.
- **WebLN** is gated on `isWeblnEnabled()` — module state set when the user clicks "Enable for this site" or completes a WebLN payment. We do **not** call `wl.enable()` speculatively to read balance, since that prompts. `weblnGetBalance()` handles `currency: 'msat' | 'btc'` defensively (the spec leaves the unit free). No notifications API, so refresh fires on `subscribeWebln` events + `visibilitychange`/`focus`.

All three swallow errors and return null, so a missing capability hides the chip rather than throwing.

**Last-known balance cache.** `useWalletBalance` writes `{ rail, balance }` to `storage.walletBalance` (per-npub) on every successful fetch and reads it on mount. Without it a returning user sees a blank chip for 5–10 s while Spark cold-restores (relay query → decrypt → SDK load → `initialize()` → initial sync). Cleared on explicit Spark/NWC disconnect. **The cached balance is only shown paired with a matching live rail** — never a stale Spark balance under an NWC label.

## Spark rail (Spark Labs SDK)

`lib/v4v/spark.ts` wraps `@buildonspark/spark-sdk` (an `eventemitter3`-based `SparkWallet`). The heavy SDK lands in the bundle only on first wallet open (dynamic import inside `sparkInitFromMnemonic`). No API key — it talks directly to Spark's signing operators.

1. **BOLT11 only.** Spark cannot keysend. `lib/v4v/boost.ts` rejects every `node`-type recipient on this rail per-leg with a clear error. lnaddress works because `payOne` fetches a BOLT11 from the LNURL-pay callback first.
2. **Account number = the SDK's per-network default (1 on mainnet, 0 on regtest).** `sparkInitFromMnemonic` sets `accountNumber: network === 'regtest' ? 0 : 1`. Primal and BlitzWallet both use the default, so mirroring it makes the same seed derive the **same account and balance** as those wallets. ⚠️ Hardcoding `0` on mainnet derives a *different, empty* account — the first-cut bug, symptom being a connected wallet stuck at 0 sats. No auto-migration from the old Breez wallets exists (Breez derived its own keys); users must paste/restore a seed.
3. **Network is `MAINNET` or `REGTEST`** — no public testnet exists. Our `network?: 'mainnet' | 'regtest'` maps to the SDK's `options.network`.
4. **Init returns `{ wallet }`.** No `storageDir`/`walletStorageDir` — that was Breez-only.
5. **Send is one-shot.** `sparkPayInvoice` calls `payLightningInvoice({ invoice, maxFeeSats: 100 })`. The preimage isn't returned synchronously, so we return `''` (`BoostResult.preimage` is optional and unread by the UI).
6. **Receive.** `sparkReceiveInvoice` calls `createLightningInvoice({ amountSats, memo })` → BOLT11 at `result.invoice.encodedInvoice`. No settle fee exposed, so `feeSats` is always 0 (ReadyPanel hides the line when 0).
7. **Balance.** `sparkGetInfo` reads `getBalance()` → `satsBalance.available` (bigint, `Number()`-cast), falling back to the deprecated `balance` field.
8. **Events drive the balance, not polling.** `subscribeSparkEvents()` maps SDK events into the existing `SparkSdkEvent` union: `'transfer:claimed'` → `paymentSucceeded`, `'deposit:confirmed'` → `claimedDeposits` (both clear the open deposit invoice in `<ReadyPanel>`), `'balance:update'`/`'stream:connected'` → `synced`. The `newDeposits`/`optimization`/`lightningAddressChanged` arms are no longer emitted but kept so consumers don't change.

**Onboarding (3 paths in `components/spark-wallet.tsx`).** Paste an existing seed (the Primal-balance-sharing path), **Create new** (`sparkGenerateMnemonic`, SDK-independent `@scure/bip39`), or **Restore from Nostr**. All publish the seed encrypt-to-self as kind:30078; paste/create **confirm before overwriting a different existing backup** (replaceable event — newer wins, prior is gone forever).

**Restore-side relay union.** `fetchEncryptedMnemonic` queries `resolvePublishRelays(identity) ∪ DEFAULT_RELAYS` (deduped, capped 20) with the longer 8 s `FEED_QUERY_MAX_WAIT_MS` — otherwise a fresh Amber sign-in, where NIP-65 hasn't hydrated, falls back to defaults and misses backups on the user's outbox relays. `publishEncryptedMnemonic` stays on `resolvePublishRelays(identity)`.

**Login-time backfill, and why a bare null can't drive it.** A local signer's wallet is derived from the key (`deriveSparkFromLocalKey`), so it works whether or not a kind:30078 exists — which is exactly how an account ends up with no backup and no symptom. `provisionSparkFromKey` publishes one on the **new-account** branch only, so anyone whose signup publish failed, or who predates that publish, kept a working wallet whose only copy lived behind *our* `bmb-spark-wallet` derivation label. No other client reproduces that label, and "Restore from Nostr" on a second device found nothing. `doLoadProfile`'s `sparkPromise` now republishes the derived seed when it can confirm the backup is genuinely absent, retrying on each sign-in.

That confirmation is the whole design, because **kind:30078 is replaceable and a wrong publish destroys a funded user's real backup permanently.** A null from the relay query means "nobody had it" *or* "nothing answered" — the general never-record-an-unobserved-absence rule, here with money attached. So the backfill reads through **`fetchEncryptedMnemonicDetailed`**, which surfaces `fetchLatestEventDetailed`'s `trustworthy` flag, and fires only on all four of: `trustworthy`, a non-null `derived` (we derived this seed ourselves this session — never republish a seed we merely read, and null for every non-local signer), `sparkSeedIsActive(derived)` (the 8 s query window is long enough for the user to paste their own seed into the modal, and theirs must not be overwritten by the derived default), and `storage.npub.get() === id.npub` (don't publish under a session `abandonRestoredSession` already tore down). A decrypt failure on an event that *does* exist propagates as a rejection rather than reading as absence — a backup demonstrably present and unread is the worst possible input to a replaceable write.

Deliberately **no `bmb:*` "already backed up" flag**: `doLoadProfile` is deduped per-pubkey, so this costs at most one event per sign-in, and retry-next-load *is* the recovery mechanism.

**A publish that reached zero relays is a failure.** `signAndPublish` resolves once every relay has settled, accepted or not, so a total failure awaits cleanly with an empty `acceptedRelays` — which read as success for as long as the provisioning path existed. It bites hardest there: a seconds-old npub has no kind:10002, so `resolvePublishRelays` falls back to `DEFAULT_RELAYS`. `provisionSparkFromKey` now throws on it (the caller `console.warn`s the message, never the error — the SDK echoes its options back and that would print the seed) and the backfill warns; `publishProfile` checks the same thing for the same reason.

**Post-restore balance race.** `<ReadyPanel>` attaches the SDK event listener BEFORE the first balance call, then re-polls at 2s/5s/12s — otherwise the initial sync can complete between init resolving and the listener attaching, leaving the panel stuck at a cached 0.


