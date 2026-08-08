# Signers — NIP-07, Amber, bunker, local key, Google onboarding

Read before touching `lib/nostr/signer.ts`, `amber.ts`, `bunker.ts`, `local-signer.ts`, `google-auth.ts`, `drive-backup.ts`, `backup-crypto.ts`, `local-key-store.ts`, or `components/nostr-auth/`.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

## Signers (NIP-07 + Amber NIP-55 + NIP-46 bunker + local key)

The whole codebase reads `window.nostr`. Four paths feed it, swapped by `lib/nostr/signer.ts`:

- **NIP-07 extension** (Alby, nos2x, Flamingo, nostash on iOS Safari). Already at `window.nostr`; we don't polyfill. Sign-out clears `bmb:npub` and leaves `window.nostr` alone.
- **Amber on Android** (NIP-55, `lib/nostr/amber.ts`). Polyfills `window.nostr` with an `AmberSigner` dispatching via the `nostrsigner:` URL scheme and reading results from the system clipboard: `nostrsigner:<urlEncoded payload>?compressionType=none&returnType=event&type=<…>` (no callbackUrl, per spec) → user approves → first user gesture (`pointerdown`/`touchstart`/`keydown`) reads the clipboard with fresh transient activation. `restoreAmberSigner(pubkey)` is the synchronous page-load fast path.
- **NIP-46 bunker** (`lib/nostr/bunker.ts`, wraps nostr-tools `BunkerSigner`). Paste a `bunker://` URI or generate a `nostrconnect://` one. Reconnect on reload is async (`restoreBunkerSigner()` rebuilds from `bmb:bunker:{uri,clientSk}`); signing calls before it resolves throw, but nothing signs unprompted post-load. Works with Clave, nsec.app, Amber-as-bunker, Primal.
- **Local key** (`lib/nostr/local-signer.ts`). The only path where *we* hold the key; it exists for Google onboarding, where the user starts with no Nostr identity. Signs in-process via `finalizeEvent`, implements nip04 + nip44 directly. `restoreLocalSigner()` is **async** (IndexedDB read + decrypt), so it follows the bunker pattern, not Amber's. It **refuses a key whose pubkey doesn't match `bmb:npub`** — `putKey` swallows IndexedDB failures, so signing in as B on a device still holding A's ciphertext would run the session off the in-memory copy while disk keeps A, and after a reload sign everything as A while the UI says B.

> **`nostr-tools` is pinned to exact `2.19.4` — do NOT bump or relax the caret.** The `2.20.0+` NIP-46 rewrite added `limit: 0` to the `nostrconnect`/bunker subscription filters (`fromURI` + `setupSubscription`), which on our relays silently drops the remote signer's connect-ack, so **Primal's `nostrconnect://` login hangs and times out**. Latest (`2.23.5`) and `master` still carry it; `npm update` or a `^`/`~` range reintroduces the break. `NOSTRCONNECT_RELAYS` is a 4-relay set (nsec.app/damus/primal/nos.lol) for ack redundancy — a single relay loses the ack when iOS Safari suspends the WebSocket during the app-switch.

### `lib/nostr/signer.ts` — the swap point

One polyfill active at a time. `captureOriginal()` snapshots the underlying NIP-07 extension on first activation so deactivation restores it. `bmb:signer` holds `'amber' | 'bunker' | 'local' | absent` so the page-load fast path knows what to restore. Capability accessors live here: `getNip04()`/`getNip44()` (API or null), `requireNip44()` (throws). Use them instead of inlining `typeof window !== 'undefined' && window.nostr?.nipXX`.

**`signer.ts` publishes `localInstance.nostrApi`, never the `LocalSigner` instance.** `private sk` is a TypeScript annotation with no runtime effect, so assigning the instance exposes the raw secret key as **`window.nostr.sk`** to any script on the origin (Google's GIS script among them — we inject it and never remove it), turning "can use the signer while the tab is open" into permanent theft of the identity *and* its derived Lightning wallet. The bunker signer publishes a separate `nostrApi` for the same reason. Don't add a key-export method to `LocalSigner`; the one that existed had zero call sites and was deleted.

### Google onboarding — a key for users who have none

> **This format is published as [`google-key-backup-spec.md`](google-key-backup-spec.md)** so other apps (onlyboosts, potentially stablekraft.app) can restore the same blobs. Every constant below now has readers outside this repo: `bmb-google-backup`, `bmb-spark-wallet`, `bmb_bk_`, the Argon2 parameters and **both** PIN bounds. They are exported from `backup-crypto.ts`/`drive-backup.ts` and pinned by `npm run check:spark` for that reason — a rename is a breaking change to other people's users, not a cleanup. Cross-app restore additionally requires a **shared OAuth client**; see [`ops.md`](ops.md).

Ported from **Wisp** (github.com/barrydeen/wisp, `v1.1.0`). The central insight, because the obvious version is wrong: **Google is not an identity provider here — it's a zero-knowledge blob store.** The key is generated locally at random (`generateSecretKey()`); nothing derives from the Google account. Wisp shipped deterministic `sub`-derived nsecs once and reverted.

Construction (`lib/nostr/backup-crypto.ts`, mirroring Wisp's `BackupCrypto.kt`):

```
salt = HMAC-SHA256(key = "bmb-google-backup", msg = google `sub`)
key  = Argon2id(pin, salt, m=32MiB, t=3, p=1)         → 32 bytes  (~0.6s laptop)
blob = NIP-44 v2 over the hex nsec, with that key substituted for the
       usual ECDH conversation key
```

The Google `sub` is **salt, not a secret** — it makes the salt per-account without us storing one. **The PIN (6–8 digits) is the only secret**, so **raising `PIN_MIN_LENGTH` buys 10× per digit, more than any parameter change**. Use `argon2idAsync`, not the sync variant, or the KDF freezes the tab. Losing the PIN loses the account with no reset path — the setup screen must say so. (The first version used PBKDF2-SHA256/600k with a 4-digit floor and a comment claiming "weeks of compute per blob"; PBKDF2 is trivially GPU-parallel, so that was ~1 second of one consumer card. Argon2id is memory-hard, which is the part that hurts GPUs.)

**`lib/nostr/google-auth.ts`** — GIS token client for `openid` + `drive.appdata`, then `sub` from the userinfo endpoint.

- **Deliberately not One Tap.** `google.accounts.id.prompt()` can be silently suppressed (FedCM opt-out, prior dismissal, no Google session) and its callback then never fires, hanging the flow on a spinner with no error. The token client always presents UI.
- **`preloadGis()` runs when the sign-in modal opens** — fetching the script inside the click path burns that click's transient activation on a cold first visit and the popup gets blocked. The `await loadGis()` inside `signInWithGoogle()` stays: once preloaded it resolves in a microtask, which doesn't consume activation.
- **`refreshAccessToken()` is silent-first (`prompt: ''`)** — it runs mid-flow after a Drive 401 with no activation left, where a popup would be blocked. On failure it throws `GoogleReauthRequiredError`, pointing at the panel's Retry (a real click).
- **`gisErrorMessage` maps `error_callback` by `type`.** `popup_failed_to_open` and `popup_closed` are not the same thing — calling a blocked popup "cancelled" blames the user for something they didn't do.

**`lib/nostr/drive-backup.ts`** — blobs live in Drive **`appDataFolder`** (app-private, invisible in the user's Drive UI) as `bmb_bk_<uuid>.bin`.

- **Fresh UUID per upload, never an overwrite** — a create can't lose a race the way a read-modify-write can, and restore tries every file anyway.
- **No identifying metadata** — the npub exists only inside the ciphertext, so Google can't link a Google account to a Nostr identity.
- **A 401 throws `DriveAuthExpiredError`** so the caller re-requests a token. An expired token must never read as "no backups" — that walks a returning user into creating a second identity and orphaning their real one.
- **`listBackups` paginates.** `nextPageToken` must be named in the `fields` mask or every response looks like the last page. `orderBy: createdTime desc` + 10-page cap, so a truncated walk drops the least-wanted blobs rather than an arbitrary slice.
- **No delete path, deliberately** — `decryptNsec` fails identically for "different PIN" and "PIN the user forgot", so any prune risks destroying a recoverable identity.

**Restore** downloads every blob and tries the PIN against each; a failure isn't an error, just a blob belonging to a different PIN (shared Google account). Successes dedupe by npub into a picker.

**The orphan rule (`google-auth-panel.tsx`).** `setupPin` is reachable **only** from `files.length === 0`, or an explicit click while every listed blob downloaded. Files-listed-but-none-downloaded is a **hard-stop error**, not "new user" — falling through there is how a returning user mints a second identity.

- On *partial* failure (`missed > 0`) the create path becomes "Retry downloads", and a zero-match PIN can't claim "Incorrect PIN" (the matching blob may be one that failed).
- Every Drive call goes through **`withDrive`** — refreshes once on a 401, and **single-flight**, or parallel downloads all 401ing would each ask GIS for a token and open N popups.
- `createAccount` tracks an `uploaded` flag: upload-succeeded-then-sign-in-failed leaves a real account in Drive, so that error points at Retry-then-enter-your-PIN rather than letting the user create a second key.

**`drive.appdata` is NON-sensitive**, so `openid` + `drive.appdata` needs only brand verification — no demo video, no CASA assessment. (Earlier notes and PR #141 called it sensitive; that was wrong and inflated the launch cost.) The unverified-app screen and 100-user cap come from the consent screen being in Testing, not the scope. `NEXT_PUBLIC_GOOGLE_CLIENT_ID` absent ⇒ the entry point doesn't render. **Console state lives in [`ops.md`](ops.md) — don't duplicate it here.**

**Key at rest (`lib/nostr/local-key-store.ts`).** Wisp gets Android Keystore; the browser has no equivalent, and plaintext `localStorage` would mean anything reading storage walks away with the identity forever. Instead: an **AES-GCM `CryptoKey` with `extractable: false`**, persisted in IndexedDB (structured clone stores the handle; `localStorage` holds strings only), with the nsec encrypted under it and `{ iv, ct }` in the same store. **There is no `bmb:*` key for the nsec, by design.**

Be precise about what that buys: `extractable: false` is enforced by **WebCrypto, not on disk** — structured-cloning a `CryptoKey` into IndexedDB serializes the raw AES bytes into the record, so an attacker holding the profile directory decrypts offline. What it stops is same-origin script calling `exportKey`, and it keeps plaintext out of `localStorage`. That's the platform's best short of a passphrase prompt every load. Private-mode fallback is memory-only for the session (`isKeyEphemeral()`) — **never silently downgrade to a persistent plaintext copy**. `clearKey()` drops the wrap key too, not just the ciphertext.

**`isKeyEphemeral()` is surfaced in two places** — the panel's `ephemeral` stage and a soft-hint banner in `<AccountMenu>` (`LocalKeyEphemeralBanner`; a hint, not a modal). Both live **within the session that created the key**, since `memoryOnlyKey` is module state. That's not a gap to plug: in a storage-restricted browser the reload signs the user out anyway, so there's no session left to warn about — don't wire up a subscription to "fix" it. Neither warning is fatal; the Drive blob still exists, so Google + PIN gets the user back.

**Sign-out is confirmed for `'local'` only** (`window.confirm` in `signout()`, the repo's pattern for irreversible actions). It's the one signer kind where signing out *destroys* something: `clearLocalSigner()` wipes ciphertext **and** wrap key, and the only way back is the same Google account plus the PIN. The gate reads `storage.signer.get()` before `storage.signer.clear()`.

**No `script-src` CSP, deliberately** (see the comment in `next.config.mjs`). Two structural blockers: the FOUC blocker in `app/layout.tsx` is an inline script that must run pre-paint (needs nonce plumbing), and `connect-src` can't be constrained because the app talks to arbitrary relays, feed hosts and LNURL servers by design — so `script-src` alone would read as more protection than it delivers. What *is* set: `base-uri 'self'; object-src 'none'; frame-ancestors 'none'`.

### Spark provisioning from a local key

**A local-signer account skips the slow half of the Spark restore.** `deriveSparkFromLocalKey` (`components/nostr-auth/provision-spark.ts`) runs *before* `fetchEncryptedMnemonic` in `doLoadProfile` — we hold the key, so the seed derives in microseconds instead of after an 8 s-capped relay query plus a decrypt. Returns null for every other signer kind.

**It also sits above `doLoadProfile`'s `await Promise.all([profilePromise, relayListPromise])`, not below.** The derive touches no network: it needs the IndexedDB key plus `npub`/`pubkey`, which are identical on the bare `id` and the `enriched` identity (enriching only adds `profile` and `writeRelays`), so below the `Promise.all` the fast path was gated on a 4 s round trip it had no dependency on. Three knock-ons:

- `!hasSpark()` is captured **once** into `shouldRestoreSpark` — after a successful derive `hasSpark()` flips true, so re-evaluating below would skip the backup check that exists to notice a user's own pasted seed.
- The promise re-checks `storage.npub.get()` before initializing: a failed signer restore runs `sparkDisconnect()`, and a wallet landing after it would outlive its session.
- Because the derive sits above the `bmb:npub` guard, **Spark can come up for a session whose profile/settings hydration bailed** — that combination is a debugging signal, not a coincidence.

The backup stays authoritative: `fetchEncryptedMnemonic` continues and **re-inits only when the stored mnemonic differs from the derived one** (the pasted-own-seed case). Mirrors Wisp, where the derived wallet is the *default*, reachable from the nsec alone with no relay backup.

**A new account gets a Spark wallet for free.** `sparkMnemonicFromKey(skHex)` derives a 12-word BIP-39 phrase from `HMAC-SHA256("bmb-spark-wallet", sk)`. **Treat that label as v1 and never edit it in place — changing it silently moves every user to a different, empty wallet.** Deterministic, so the wallet survives losing the kind:30078 backup; the HMAC domain-separates it so the wallet seed can't be walked back to the signing key. It returns an ordinary mnemonic, so the init/publish/seed-display paths are untouched.

Two guards, both needed: `hasSpark()` before the SDK init, and **`sparkSeedIsActive(mnemonic)` before `publishEncryptedMnemonic`** — provisioning is fire-and-forget across seconds of handshake, and a user pasting their own seed in that window would otherwise have their real backup overwritten by the derived one (replaceable event, permanent loss). `hasSpark()` can't be the second guard: after our own init it's unconditionally true. Runs **only on the new-account branch** (on restore, `loadProfile`'s silent restore owns that path and a derived wallet could stomp the real one), best-effort, and `console.warn`s rather than swallowing — a silent rejection is indistinguishable from "still initializing".

**It lives in `lib/v4v/spark-derive.ts`, not `spark.ts`.** `spark.ts` is `'use client'` and statically imports `'../pubsub'` extensionless, so plain Node can't load it — leaving the one function whose silent change costs users their funds with no regression pin. `spark-derive.ts` has no directive and no static imports (crypto stays dynamically imported inside the function, keeping `@noble`/`@scure` out of the initial browser chunk), so `npm run check:spark` runs the *real* function against a frozen vector. It pins `deriveBackupKey` the same way — change the label, the Argon2 params or the salt construction and every user is locked out of their Drive blob. `spark.ts` re-exports, so call sites still import from `@/lib/v4v/spark`.

**`provisionSparkFromKey` doesn't consult `bmb:spark:opted_out`, and writes its `'0'` before its first `await`.** A key generated seconds ago has no opinion recorded, so there's nothing to honor — that's what scoping the flag per-npub bought. The write ordering is the load-bearing half: provisioning runs fire-and-forget while the caller races to `completeSignIn` → `loadProfile` → `deriveSparkFromLocalKey`, which *does* read the flag. Historically `storage.sparkOptOut.get` fell back to the legacy global key when an npub had no scoped value, so on any device where an earlier identity turned Spark off, a brand-new account inherited that opt-out; **that fallback has since been removed** (`lib/storage.ts` reads the scoped key only, and the bare key is dead — see [`storage.md`](storage.md)). Writing `'0'` first therefore now earns its keep on the second half alone: it makes a failed init retryable next login instead of permanent. *(The same stale legacy-fallback claim is repeated in the comment at `components/nostr-auth/provision-spark.ts`.)* The **restore** path does honor the flag (gated on `storage.sparkOptOut.get(identity.npub)`) — there the npub has a history. See [`storage.md`](storage.md) for the tri-state and the dead global key. **Spark is the user's wallet until they connect a different one.**

**A new account also gets a generated kind:0.** `lib/nostr/generated-profile.ts` derives a display name (adjective + noun word lists) and a 5×5 mirrored identicon from the **pubkey** — never from the Google account, which would need the `profile` scope and would publicly link the npub to a real-world identity. The avatar is an inline `data:image/svg+xml;base64` URI, so it depends on no hosting. Published by `provision-profile.ts` to `resolvePublishRelays(identity) ∪ PROFILE_RELAYS` — **the union matters**: purplepag.es is the profile outbox Damus and Amethyst read. **New-account branch only** (kind:0 is replaceable; publishing on restore would overwrite a profile set in another client). This is the only place the app writes a user's kind:0.

### Sign-in UI — `<SignInModal>` (`components/nostr-auth/sign-in-modal.tsx`)

The entry point lives in the combined **`<AuthControl>`** header control, not a standalone button — signed out, `<NostrAuth>` renders **only** the modal (its hydration effects and `completeSignIn` still run). Opening it flips `signInOpen`; the modal is a portal'd two-tab overlay (same pattern as `wallet-modal.tsx`):

- **Browser Extension** — `loginWithExtension` (NIP-07); the button is disabled with a hint when `window.nostr` is absent.
- **Remote Signer** — *Generate QR* (`nostrconnect://` via `loginWithNostrConnect`) and *Paste Bunker URI* (`loginWithBunker`) stacked, plus **"Sign in with Amber"** (`loginWithAmber`) on Android. Default tab when no extension is detected.

Both tabs stay available so a desktop extension user can still pick a remote signer. The modal owns its per-method busy/error state and the **iOS visibility-retry** that re-attempts the nostrconnect handshake when Safari suspends the relay WebSocket on app-switch. On success it calls `index.tsx:completeSignIn(id, kind)`. `login-methods.tsx` now holds only the shared `<AmberCompletion>` clipboard-recovery helper.

**`<GoogleAuthPanel>` is NOT reachable from inside this modal.** There is no "Continue with Google" button above the tab strip — `googleOpen` is seeded once and has no setter, so the panel renders only when the modal was opened with `signInIntent === 'google'`. `<AuthControl>`'s header dropdown is the sole entry point. While the panel is open the tab strip is hidden, and it carries its own **back affordance** on every non-destructive stage: `confirmPin` → `setupPin`, a PIN screen reached from the picker → the picker, otherwise `onCancel()`. The `working` stage is excluded — an upload may be in flight, and abandoning it is how you get a blob in Drive with no local key.

**The modal can open straight onto that panel via `signInIntent`.** `<AuthControl>`'s dropdown lists "Continue with Google" as a peer of the other logins and calls `setSignInOpen(true, 'google')`; the modal seeds `googleOpen` from that intent with a **lazy `useState` initializer — read once, never subscribed**, since a late store write would otherwise yank someone out of a half-entered PIN. The panel's `onCancel` is the modal's own close handler, so **backing out of its first stage closes the whole modal** rather than dropping the user into signer tabs they never asked for. The header entry exists because burying this flow inside "Sign in with Nostr" hid it from exactly the people it was built for.

**Modal open-state lives in the store** (`signInOpen`/`setSignInOpen`), so other surfaces (fullscreen player header, live-chat composer) can open the one modal `<NostrAuth>` owns — don't mount a second `<NostrAuth>`, it would double the profile-load and focus-listener effects. Portal'd at `z-[60]` so it clears the fullscreen player (`z-50`).

### Account-change detector

One `window.focus` listener in `components/nostr-auth/index.tsx`, active only while signed in via NIP-07 (`bmb:signer` absent). Re-calls `getPublicKey()` (throttled 30 s); on a change, drives `loginWithExtension` + `completeSignIn`. Multi-identity Alby/nos2x users are first-class. Extension presence is otherwise read at modal-open time.

### Lifecycle observables

- **`subscribeAmberStage(fn)`** — `'idle' | 'awaiting' | 'returned'`. `<AmberCompletion>` flips its hint copy in lockstep with `invokeAmber`. While in flight it always shows a "◆ Read clipboard manually" button + paste textarea, because `visibilitychange` is unreliable on standalone-PWA returns.
- **`subscribeBunkerHealth(fn)`** — boolean (stale or not); adapter calls run through `trackBunkerCall` with a 30 s timeout. `<BunkerHealthBanner>` in `<AccountMenu>` offers "Signer disconnected — Reconnect". Targets the iOS-PWA-suspended-WebSocket case.


