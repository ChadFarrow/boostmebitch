# Signers — NIP-07, Amber, bunker, local key, Google onboarding

Read before touching `lib/nostr/signer.ts`, `amber.ts`, `amber-callback-url.ts`, `amber-safe-text.ts`, `bunker.ts`, `local-signer.ts`, `google-auth.ts`, `drive-backup.ts`, `backup-crypto.ts`, `local-key-store.ts`, or `components/nostr-auth/`.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

## Signers (NIP-07 + Amber NIP-55 + NIP-46 bunker + local key)

The whole codebase reads `window.nostr`. Four paths feed it, swapped by `lib/nostr/signer.ts`:

- **NIP-07 extension** (Alby, nos2x, Flamingo, nostash on iOS Safari). Already at `window.nostr`; we don't polyfill. Sign-out clears `bmb:npub` and leaves `window.nostr` alone.
- **Amber on Android, primary path: NIP-46 over a `nostrconnect://` link — since 2026-09-03, and this is how StableKraft's "Amber (Android)" button has always worked** (`components/Nostr/Nip46Connect.tsx` there: `window.location.href = nostrconnect://…` on Android, then the ordinary relay session). The modal's Android "Sign in with Amber" calls `loginWithNostrConnect` and opens the URI in Amber; Amber's installed build (the `free` flavor on Zapstore and F-Droid) registers `nostrconnect` as a BROWSABLE scheme on `SignerActivity`, and `getIntentData` routes a `nostrconnect:` intent BEFORE the `Browser.EXTRA_APPLICATION_ID` branch, so the Chromium change below never touches it. Nothing returns by URL: no callback tab, no clipboard, no reload, and every later signature rides the relay like any bunker — which also means it lands under `unattendedDecryptOk() === false` like Amber-as-bunker always has. The URI is opened ONCE per memoized URI (`amberNcOpened`); the visibility-return retry re-subscribes without re-launching Amber, because Android suspends the page's WebSocket while the user is in Amber and the ack can land on a dead subscription. The `offline` flavor registers only `nostrsigner`, which is why the NIP-55 path stays as a secondary button.
- **Amber on Android, fallback path** (NIP-55, `lib/nostr/amber.ts`). Polyfills `window.nostr` with an `AmberSigner` dispatching via the `nostrsigner:` URL scheme and reading results from the system clipboard: `nostrsigner:<urlEncoded payload>?compressionType=none&returnType=event&type=<…>` (no callbackUrl, per spec) → user approves → first user gesture (`pointerdown`/`touchstart`/`keydown`) reads the clipboard with fresh transient activation. `restoreAmberSigner(pubkey)` is the synchronous page-load fast path.
- **Clave on iOS** (`lib/nostr/clave.ts`). NIP-46 and nothing else — no NIP-55 surface, no URL-scheme signing round trip, no `window.nostr` injection, and NIP-55 is titled "Android Signer Application" with no iOS section, so there is nothing else to build against. It is therefore a **bunker like any other**: `bmb:signer` stays `'bunker'`, the transport is `bunker.ts`, and `unattendedDecryptOk()` already excluded it. What is Clave-specific is three things and only three: the one-tap hand-off `clave://connect?uri=<urlencoded nostrconnect>`, `wss://relay.powr.build/` in the URI, and the queued-approval retry — all three below.
- **NIP-46 bunker** (`lib/nostr/bunker.ts`, wraps nostr-tools `BunkerSigner`). Paste a `bunker://` URI or generate a `nostrconnect://` one. Reconnect on reload is async (`restoreBunkerSigner()` rebuilds from `bmb:bunker:{uri,clientSk}`); signing calls before it resolves throw, but nothing signs unprompted post-load. Works with Clave, nsec.app, Amber-as-bunker, Primal. **A bunker is NOT assumed to answer inside the browser** — see "An out-of-browser signer is two signers" below.
- **Local key** (`lib/nostr/local-signer.ts`). The only path where *we* hold the key; it exists for Google onboarding, where the user starts with no Nostr identity. Signs in-process via `finalizeEvent`, implements nip04 + nip44 directly. `restoreLocalSigner()` is **async** (IndexedDB read + decrypt), so it follows the bunker pattern, not Amber's. It **refuses a key whose pubkey doesn't match `bmb:npub`** — `putKey` swallows IndexedDB failures, so signing in as B on a device still holding A's ciphertext would run the session off the in-memory copy while disk keeps A, and after a reload sign everything as A while the UI says B.

> **`nostr-tools` is pinned to exact `2.19.4` — do NOT bump or relax the caret.** The `2.20.0+` NIP-46 rewrite added `limit: 0` to the `nostrconnect`/bunker subscription filters (`fromURI` + `setupSubscription`), which on our relays silently drops the remote signer's connect-ack, so **Primal's `nostrconnect://` login hangs and times out**. Latest (`2.23.5`) and `master` still carry it; `npm update` or a `^`/`~` range reintroduces the break. `NOSTRCONNECT_RELAYS` is a **5**-relay set for ack redundancy — a single relay loses the ack when iOS Safari suspends the WebSocket during the app-switch. Four are for redundancy (nsec.app/damus/primal/nos.lol); **`wss://relay.powr.build/` is not, and must not be pruned as if it were.** It is Clave's own persistent proxy — the subscription that fires the APNs wake, which is how a closed Clave answers at all — and Clave's `docs/nip46-compatibility.md` states that a client without `switch_relays` (nostr-tools ~2.17, and we pin exactly 2.19.4) *"cannot successfully complete nostrconnect pairing unless the URI already embeds wss://relay.powr.build"*. **Keep its trailing slash**: the other four have none, so a tidy-up is the likely way this breaks, and nothing in CI would notice. **It has a second, iOS-shaped reason that has nothing to do with Clave's docs.** WebKit bug 302561: on affected iOS builds iCloud Private Relay can allow only the **first** WebSocket to a given host and port — recorded by Conduit (github.com/Conduit-BTC) in their mobile-Safari QA baseline, which also insists the exact OS and Private Relay state be written down on every iPhone run. The bunker runs on its **own** `SimplePool`, separate from the app-wide pool by design, and three of these five relays share a host with `DEFAULT_RELAYS` — damus, primal, nos.lol — so on such a device those three sockets are the *second* to their host and may never open. `relay.nsec.app` and `relay.powr.build` are the only two nothing else in this app connects to, which makes them the pair the handshake can actually rely on. **So do not "tidy" this set down to the app's default relays**: the overlap is the hazard, and the non-overlap is the point. It is unconditional rather than Clave-scoped because `startNostrConnect` memoizes ONE `{uri, clientSk, secret}` per session, shared by the iOS Clave button, the Android Amber button and the QR box — a second URI in one session would invalidate a QR the user had already scanned, which is the exact failure that memo exists to prevent. **And this is not the "adding a relay is a latency decision" rule from [`nostr.md`](nostr.md)**: that one is about broad scans, which resolve at *aggregate* EOSE and so pay a silent relay its full ceiling. A NIP-46 exchange resolves on the first matching kind:24133 response, so a slow or silent relay here costs nothing.

### Amber's round trip does not return by itself — measured, not assumed

`amber.ts`'s header describes the flow as: navigate to `nostrsigner:`, the user approves, "Amber writes the result to the clipboard **and returns focus**", the tab fires `visibilitychange`, we read the clipboard. **The last two steps did not happen on a real device.**

Measured 2026-08-21 on a Pixel 6 (Android 17, no Chrome installed at all — 298 packages, zero matching `chrome`; Brave is the default browser and the only Custom Tabs provider). Brave dispatches the `nostrsigner:` intent with `LAUNCH_SINGLE_TASK`, so Amber opens in **its own task**. Approving finishes that task, and Android returns to the **launcher** — not to the page. The tab never sees `visibilitychange`, the request never resolves, the caller retries, and the prompt comes straight back.

**This is not a Trusted Web Activity problem.** The first sighting was in the TWA, which made it look like packaging. Opening the identical site as an *ordinary Brave tab* reproduced it exactly: same prompt, same approval, same launcher. The TWA only removes the last escape hatch, because its task closes and there is no tab left to switch back to.

Read NIP-55 carefully and it never promised otherwise: with no `callbackUrl` the spec says only that the signer "will copy the result to the clipboard". Returning is the **user's** job. That is what the capture-phase `pointerdown`/`touchstart`/`keydown` listeners in `invokeAmber` are for, and they are the load-bearing half of that design — not a fallback.

**`callbackUrl` is not a drop-in replacement, and reaching for it as a quick fix is the trap.** Amber returns a `callbackUrl` by **navigating** to it. That reloads the page, which destroys the promise the caller is awaiting, so it needs the pending request to survive a load and the result to be matched back to a re-issued call. And it makes *every* signature a page reload — tolerable for a load-time decrypt, unacceptable during a boost, where `publishBoostNote` signs **after** the sats have already gone out (invariant 1 in [`../CLAUDE.md`](../CLAUDE.md)). Any design here has to answer that case before it answers the easy one.

**Which is why the first fix was to stop asking.** `hydrateMutes` ran on every page load and decrypted the private half of the kind:10000 mute list, so a signed-in Amber user was sent to another app **before touching anything**. It now passes `decryptPrivate: false` unless `unattendedDecryptOk()`, and the parked ciphertext still round-trips verbatim.

Two consequences to keep in mind, because neither is free:

- **On Amber the private mute list is never decrypted on a cold start** — `hydrateMutes` is its only caller. Private mutes come from this device's cache, so a *fresh* Amber device applies none of them until something decrypts. That was a silent withholding of the kind [`../CLAUDE.md`](../CLAUDE.md) says must be visible, and the "user-initiated load my private mutes" action this file used to list as the missing piece now exists: `<MutesSyncNotice>` renders when a private half is present and shut, and its button runs `hydrateMutes(identity, 'user-initiated')`. **The callbackUrl work did NOT close this**: `nip04_decrypt` is deliberately absent from both `RESUMABLE_TYPES` and `AMBER_PERSISTABLE_TYPES`, the second because a decrypt result is a plaintext and the records now reach disk.
- **The `nostrNewer` branch had a latent bug of its own**, independent of Amber: an undecryptable private section made `privatePubkeys` `[]`, and adopting the relay state wholesale overwrote the cached list — silently un-muting everyone the user had muted privately, with no error. It now keeps the cached private entries and takes only the relay's public tags and its newer ciphertext.

### An out-of-browser signer is two signers, not one


### The lists opt out of it; the mnemonic never does

`listDecryptOnLoadOk(npub)` widens `unattendedDecryptOk()` for **the private half
of favorites and mutes, and nothing else**. It is `unattendedDecryptOk() ||
storage.listUnlock.get(npub)`.

**The argument is that the measurement behind the gate was about a different
secret.** What was measured on the Pixel 6 is the wallet mnemonic: twelve BIP-39
words full-screen at launch, because Amber renders the decrypted plaintext on its
approval sheet. That call site — `components/nostr-auth` — still calls
`unattendedDecryptOk()` directly and must keep doing so. The two lists were swept
into the same predicate because it was one predicate for three call sites, not
because anyone weighed them. Their plaintext is a list of podcast ids and muted
pubkeys.

**And for the common configuration the gate was buying nothing.** A user who
picked "Approve basic actions" when connecting Amber has the decrypt
auto-approved: no sheet, no plaintext on screen. They were paying two notices
that read as errors, on every cold start, plus a tap, for a protection that in
their setup protects nothing. Reported exactly that way: *"if I just click the
button with the error and it goes away, what's the point?"* — and the answer was
that there wasn't one, because **tapping unlock remembered nothing**. It passed
`'user-initiated'` for that one call and the next load started over, so it was
not a one-time consent but a permanent tax.

`storage.listUnlock` is written **only** from a control the user pressed — the
`unlock` on `<FavoritesSyncNotice>` and the `load` on `<MutesSyncNotice>` — and
never inferred. Both write it BEFORE the pass that spends it, because a success
flips the sync status and unmounts the notice mid-await.

**The risk this accepts, so it is not rediscovered as a bug:** a signer set to
approve *each* request manually now prompts on cold start instead of showing a
notice. That is a worse trade for that user. `<ListUnlockSection>` in the account
menu is the way back, and it renders **only when the flag is set** — granting it
removes both notices, so the surface it was granted from is gone, and nothing
else would mention the setting. The failure is visible and one tap from
reversible, which is the direction to fail in; it is the same asymmetry
`storage.sparkOptOut` argues from the other side.

`unattendedDecryptOk()` (`lib/nostr/signer.ts`) is the one predicate for "may we
decrypt on a cycle nobody asked for". It used to exclude Amber alone, on the
reasoning that a NIP-46 bunker "answers inside the browser".

**That is false for a bunker hosted on the user's own phone**, which Clave,
Amber-as-bunker and nsec.app's mobile mode all are: the request leaves for
another app exactly as a NIP-55 intent does. Signing in with Clave on iOS
demanded four decrypts before the user had touched anything — the private mute
list, the Spark seed phrase, the NWC spending credential and settings — and the
first came back `nip04_decrypt failed: Invalid base64`.

Three call sites read it (`mutes-hydrator.ts`, `doLoadProfile`,
`favorites-hydrator.ts`) and the bunker was missing from all three because each
had re-derived the test. It is one function now.

**It reads the PERSISTED signer kind, not `window.nostr`, and is not
interchangeable with `canSignUnattended()`.** Both the bunker and the local
signer install their adapter asynchronously, so at cold start `window.nostr` may
not be there yet — `canSignUnattended()` would answer false for a
local-key/Google user and silently stop their wallet restoring. `bmb:signer` is
written before the adapter and is deterministic.

The cost is real and accepted: a bunker user's Spark/NWC wallet no longer
restores itself on load. `walletBackupWithheld` puts that on screen, and
"Restore from Nostr" is `'user-initiated'`, spends the prompt on purpose, and
already works.

### A bunker that answers with an error is not a bunker that is gone

`trackBunkerCall` (`lib/nostr/bunker.ts`) flipped `bunkerStale` on **any**
rejection, so a signer that answered correctly that it could not read a payload
we had sent in the wrong cipher produced *"Signer disconnected — your iPhone may
have suspended the relay link."* That sent the user to reconnect a connection
that was working, and said nothing about the real fault.

An error RESPONSE is proof the round trip completed. The discriminator comes
from the pinned library: nostr-tools 2.19.4's `lib/esm/nip46.js` decrypts the
NIP-46 response, reads `{ id, result, error }`, and runs `handler.reject(error)`
— passing the signer's error **string** through unwrapped. Every other rejection
on that path is an `Error`: our own `withTimeout`, `sendRequest`'s "this signer
is not open anymore", and the `AggregateError` from
`Promise.any(pool.publish(...))`. So `!(e instanceof Error)` is an exact test for
"the signer answered", and it CLEARS the flag; an `Error` sets it, which fails
toward offering the reconnect.

**No `check:*` can pin this** — `bunker.ts` imports `nostr-tools` and touches
browser globals, so it will not load under `node --experimental-strip-types`. It
rests on the exact `2.19.4` pin above. If that ever moves, re-read `nip46.js` by
hand: a version that wraps `o.error` in an `Error` reverts this silently rather
than breaking loudly.

### A pairing the page loses is one the signer thinks succeeded

Reported from an iPhone on Brave, and it is the failure that matters most
because **nothing on either screen says anything is wrong**: Clave listed
BoostMeBitch as a connected client, permission **Full**, last seen 34 s ago —
while the page sat on "Sign in".

The pairing had completed on Clave's side only. Handing the URI over navigated
the tab, so by the time the user came back the document had been replaced:
module state gone, subscription gone, and the signer's ack delivered to nobody.
kind:24133 is ephemeral, so nothing can replay it.

**And the reason it navigated is the part worth carrying, because the first
diagnosis of it was wrong.** This was measured in **Safari**, not a third-party
browser, so "WKWebView does not route universal links" — the explanation first
written here — cannot be it. The real rule: **a Universal Link opens the app
only for a genuine tap on a real anchor.** iOS does not hand a *programmatic*
navigation to an app, and `openAppLink` fires a synthesised `a.click()`. Apple
documents this; it holds in Safari; and it is why Conduit's identical URL works
while ours did not — **their control is an `<a href>` the user taps, ours was a
scripted click.** Same string, different mechanism.

**Two fixes, because one of them alone leaves the hole open.**

**1. Do not navigate.** `clave://` is the primary launcher again — see the
reversal below. It reaches the app from the scripted click our launcher has to
use, and a tab that survives the app switch keeps the subscription the ack is
addressed to, which is the whole game.

**2. Make the pairing survive a tab that dies anyway.** `storage.ncPending`
persists `{ uri, clientSk, ts }` for ten minutes, and `ensureNostrConnectMemo`
restores it rather than minting a new pairing. It does **not** recover the
missed ack — it recovers the ability to *ask again*: the same client key means
the signer recognises an already-approved client and re-acks without a second
approval. The sign-in modal resumes such a pairing on open, `launch: false`, so
a user who comes back finds a live listener instead of a dead page.

Verified under an iPhone UA: the pairing persists while waiting, survives a
full reload byte-identically, and the modal picks the handshake back up on its
own without re-launching the app.

### The launcher, reversed three times — and the variable that was missing

`clave://` → Universal Link → `clave://` → Universal Link, as an anchor. Worth
writing down, because each change was driven by evidence that was correct about
the case it came from, and the last one is where the cases finally reconcile.

- **`clave://` first**, on the reasoning that a Universal Link ships the pairing
  URI to a third-party origin. That privacy argument was overstated, and it was
  never measured.
- **Universal Link**, after Conduit (github.com/Conduit-BTC) — who verify on a
  **physical iPhone, in Safari**, that it opens the app on the first tap with no
  confirmation sheet. True, and still true.
- **`clave://` again**, after a Safari field report: dispatched through
  `openAppLink`'s scripted click, a Universal Link cannot reach the app at all
  and silently loads clave.casa instead. Also true.
- **Universal Link, from a real `<a href>`.** A user compared the two flows on
  their own phone — "for conduit.market I click clave, it opens clave and I
  switch back and it just works" — which is the case both earlier measurements
  were about, and neither had explained.

**The resolution is not "one of the measurements was wrong".** It is that the
URL is only half the mechanism, and the other half is *how it is dispatched*. A
Universal Link needs a real anchor and a real tap; a custom scheme also works
from a scripted click. Conduit's control **is** an `<a href>`
(`packages/ui/src/components/ClaveConnectButton.tsx`, an `<a>` around
`clave.casa/connect/?uri=`); ours was a scripted click wearing the same URL.
Same string, different mechanism, opposite outcome.

**What had to change to render an anchor is the interesting part, and it is not
cosmetic.** An anchor's `href` must exist at render time, so the pairing cannot
be minted inside the click. That is exactly what our header row was doing, and
why the launcher had to be scripted in the first place: Safari gates an
app-scheme navigation on the click's transient activation, and the modal mounts
in a later task, so the row built the URI and navigated in one handler. The
whole constraint dissolves once the pairing is prepared when the sign-in panel
OPENS — which is what Conduit's `useSignerPairing` hook does on mount, and what
`<SignInModal>`'s prepare-on-open effect does now. The header row no longer
launches anything; it opens the modal on the Remote Signer tab and stops.

**That costs one tap and buys the mechanism.** The old shape saved a tap by
launching from the menu row, and paid for it twice over: a confirmation sheet on
the way out, and a hand-off that left before any subscription existed.

`clave://` stays as the labelled escape, and it earns the place. A Universal
Link can be switched off by the user without their realising it — one tap on the
"clave.casa" breadcrumb in Safari's top-right and iOS opens the web page for
that domain from then on, permanently, with no UI to undo it and **nothing on
the page able to detect it**. The scheme is unaffected, which makes it the only
cure for the one failure the primary cannot report. Between them the two answer
both silences: the app is missing, or this browser will not route the link.

### Coming back from the signer must never re-launch it — measured on a real iPhone

Reported from an iPhone running **Brave**: tap "Sign in with Clave", approve in
Clave, switch back to the page, and the browser throws

> **Cannot Open Page** — Brave cannot open the page because it has an invalid
> address.

over a modal still reading "WAITING FOR CLAVE…". The sign-in did not complete.

**The cause is a race no emulator reaches**, because it needs a connect that
actually succeeds. `startNostrConnect` clears `nostrconnectMemo` the moment
`getPublicKey()` resolves. The visibility listener fires on the way back — before
React has processed that resolution — so the retry found no memo, minted a
**brand-new pairing**, and navigated to it. Two faults at once:

- **The navigation had no user activation behind it.** iOS refuses an app-scheme
  navigation from a `visibilitychange` handler, and Brave reports that refusal as
  an invalid address. The per-URI guards (`amberNcOpened`, and a `claimClaveHandoff`
  record that no longer exists) could not help: the URI was genuinely new, so
  they passed it through.
- **The new pairing was one Clave had never seen.** Even had it opened, it could
  only time out — while the approval the user had just given belonged to the
  pairing we had abandoned.

**And the worse half was silent.** The retry bumps `claveAttempt`, so when the
original attempt resolved with the approved identity, its own `isCurrent()` check
threw it away. "Approve in Clave, switch back" signed in **nowhere at all**, and
the only thing on screen was a browser error about an address.

Two rules came out of it, and both are stated as invariants because neither can
be pinned by a `check:*`:

1. **Only a handler the user tapped may launch an app.** `onAmberConnect` takes
   `{ launch }`, default true, and every caller that is not an `onClick` — the
   visibility retry — passes `launch: false`. That makes it reviewable by
   reading the call sites rather than by reasoning about timing. A retry
   re-subscribes; it never navigates.

   **The Clave half of this is now structural rather than a flag.** Reaching
   Clave is an `<a href>` the user taps, and `prepareClave()` only subscribes —
   so there is no code path on that side that could navigate without a tap, with
   or without a flag to forget. That is a stronger guarantee than the rule, and
   it is why the flag is gone from the iOS branch rather than merely unused.
2. **A success from ANY attempt signs in.** The newest-attempt rule is right for
   reporting an *error* — an older attempt's timeout must not overwrite a live
   session — but applied to success it discards the very thing the user did.
   `claveSettled` / `amberNcSettled` latch the first success instead, which is
   all `isCurrent()` was buying on that path.

A retry that finds the pairing replaced also stops rather than starting another
one silently: it reads `nostrConnectUri()` — which returns the memo **without
subscribing** — and says "that pairing is no longer live" instead of opening a
transport nothing will answer.

**What is and is not proven here.** A CDP run under an iPhone UA confirms that
returning to the page four times never produces a second navigation. It does
*not* reproduce the original race: that needs a connect that succeeds, and this
container cannot reach the public relays. The structural guarantee above is the
argument; the field report is the evidence that it was needed.

### "Subscription closed" never matched, so the reconnect never ran

nostr-tools 2.19.4 throws `new Error("Subscription closed before connection was
established.")` — **capital S**. Five places tested
`.includes('subscription closed')` in lower case, and none of them ever matched.

Two were functional. `connectBunkerFromUri` and `restoreBunkerFromStorage` each
wrap their first `attempt()` in a `catch` that is supposed to retry once at
`BUNKER_RECONNECT_TIMEOUT_MS`; the guard rethrew every time, so **that one-shot
reconnect had never fired since it was written**. The case it exists for is
exactly the one Clave and Amber hit — the OS suspends a backgrounded WebSocket
while the user is approving in the signer app — so the miss was invisible
precisely where it cost the most.

The other three (four counting the Clave box) are the sign-in modal's friendly
copy for a dropped handshake. Every one of them showed the raw library sentence
instead of the line telling the user what to do next. Fixed with one
case-insensitive predicate on each side: `isSubscriptionClosed` in `bunker.ts`,
`connectionDropped` in the modal. Both are `/…/i` tests rather than a second
lower-cased literal, because a literal is how this happened.

### A permission error from Clave is a queue receipt, not a refusal

The section above establishes that an error RESPONSE proves the round trip
completed. This is the second refinement of the same discriminator: **one class
of answer means *not yet*.**

Clave does not hold a request open while its user decides. It answers
immediately with `permission denied`, and delivers the real result on the SAME
request id once the user taps approve. nostr-tools 2.19.4 settles on the first
response, so the caller gets a rejection and the signature is delivered to a
handler that no longer exists — `lib/esm/nip46.js` runs `delete listeners[id]`
on the line after `handler.reject(error)`. Read in `node_modules`, not inferred.

**So this is not a sign-in bug, and that is what makes it expensive.** Pairing
succeeds. It is every SIGNATURE afterwards that fails — the boost note, the
favorites publish, the mute publish — each on the first approval, each looking
like a signer that refused.

`withApprovalWait` (`lib/nostr/bunker.ts`) re-issues on a **new request id**,
because there is nothing left to listen with. The gate is `isApprovalPending`
in the import-free `lib/nostr/nip46-errors.ts`, pinned by `npm run
check:nip46error`, and it **fails closed on anything that is not a bare
string** — the same `!(e instanceof Error)` fact as above, so a timeout or a
dead transport is never approval-pending and the reconnect banner still fires.

**Re-issuing is safe because of a property of THIS repo, not of NIP-46.** Every
publisher stamps `created_at` into the template before calling `signAndPublish`,
so a re-signed template is a byte-identical event rather than a second one. A
caller that ever let the signer pick `created_at` would break that, and the
wrapper would have to come off `signEvent`. There is also never a first
signature to duplicate: we only re-issue after a rejection.

90 s budget, 8 s interval. 90 is `BUNKER_CONNECT_TIMEOUT_MS`' number on purpose
— both answer "how long do we wait for a human in another app", and two numbers
for one question only invites the argument. The honest worst case is 90 + 30 s,
because the last attempt can start just under the deadline and then time out.
**The money path argues for the larger budget, not the smaller**, which is the
opposite of the intuition: `publishBoostNote` signs AFTER the sats have moved,
so a long wait costs a spinner beside a payment already reported as successful,
while giving up early costs the note outright — `<PublishStatus>` renders
"Publish failed" with **no retry control**, and nothing re-attempts a kind:1.

**The two decrypts are deliberately NOT wrapped, and this is the inconsistency
someone will tidy away.** Both already run inside a 10 s cap this module cannot
see — `decryptWithTimeout` / `withDecryptTimeout` in `signer.ts`
(`NIP44_DECRYPT_TIMEOUT_MS`), and `mutes.ts` puts the NIP-04 half through the
same one. That cap is a `Promise.race`, which does not cancel what it outran, so
an approval loop underneath would be **unreachable** (the outer race rejects at
ten seconds with an `Error`) *and* would leave an orphaned loop firing
re-issued requests at the signer for another eighty, each potentially a fresh
prompt, with nobody left to consume the answer. Worse than not retrying. The
cost is on the record: on a signer that queues, a private mute half, a private
favorites half and "Restore from Nostr" still fail at ten seconds. Closing that
means teaching `withDecryptTimeout` about the bunker case **first**, in
`signer.ts`, and only then wrapping those two lines.

**THE RISK THIS ACCEPTS, stated so it is not rediscovered as a bug.** NIP-46
standardises no error strings, so a signer REFUSING outright may phrase it
identically to one that is queueing — `permission denied` is a very plausible
"the user tapped Deny" from nsec.app. That user now waits the full budget
instead of failing fast. The answer is **not** a narrower pattern list, which
would risk missing the string this exists for; it is that the wait is visible
and one tap from over: `subscribeBunkerApproval` drives
`<BunkerApprovalNotice>`, which carries **Stop waiting**
(`cancelBunkerApprovalWait`). Rendered in the boost modal's `publishing` state,
where the wait actually bites, and in `<AccountMenu>` so the control exists
outside that one surface.

**No `check:*` can pin the re-issue itself** — `bunker.ts` imports
`nostr-tools` and touches browser globals. `scripts/e2e-mutes.mjs` scenarios
**5d** and **5e** are the proof instead, against a real NIP-46 stub: 5d denies
one `sign_event` and asserts the call still resolves, over two requests, on two
different ids, with the template unaltered; 5e denies with different words and
asserts one request and a fast failure. Its `signEnabled` flag is off by
default because scenarios 1-5c were written against a stub that answered
`sign_event` with "unsupported", and teaching it to sign underneath them would
be editing the fixture to fit.

### Never make Amber render something the user did not ask to see

**Launching the app on a Pixel 6 put twelve BIP-39 words full-screen and unmasked, before the user had touched anything.** Found 2026-08-21 by opening the installed TWA and reading the Amber sheet that came up on its own; fixed in `778f3c7`.

Amber's approval sheet renders the **decrypted plaintext**, so the user can see what they are approving. That is reasonable of Amber. It is not reasonable of us to trigger it on page load, because of what `doLoadProfile` read on every cold start, unprompted:

| coordinate | what the sheet displays |
|---|---|
| `boostmebitch:wallet` | the Spark **seed phrase** |
| `boostmebitch:wallet:nwc` | an NWC URI — a budgeted **spending credential** |
| `boostmebitch:settings` | harmless in content, still an uninvited trip to another app |

A seed on screen at a moment the user did not choose is a shoulder, a screenshot or a screen recording away from being someone else's. **This is the same shape as the bug the mute-list fix above solved**, and it was left behind then because the cost read as "an extra prompt". It was not.

**The fix is three parts, and each covers a failure the others do not:**

1. **The callers stop asking.** `doLoadProfile` gates all three on `!isAmberActive()`. Not asking beats refusing later, because refusing inside the library would still query the relays and *then* throw — and the throw lands in an outer `.catch(() => {})` where nothing sees it.
2. **`decryptWithTimeout` takes a REQUIRED `purpose` and refuses `'unattended'` on Amber.** Required rather than defaulted, so a new caller has to decide instead of inheriting a permissive default. **Do not "simplify" it into an optional parameter** — that is the whole guarantee. A fourth cold-start decrypt added later by someone who never reads this then fails loudly instead of quietly showing a seed. It cannot be pinned by a `check:*` script (`signer.ts` pulls in `nostr-tools` and browser globals, so it will not load under `node --experimental-strip-types`); the type system is the enforcement.
3. **The withholding is visible.** `walletBackupWithheld` (`lib/store.ts`) drives a line in `<WalletModal>`. Refusing to read the backup is right; leaving an Amber user to wonder why their wallet did not come back on a new device is not — [`../CLAUDE.md`](../CLAUDE.md)'s rule that a guard which silently withholds must say so.

Amber only, and for the same reason as the mute list: an extension and a bunker answer inside the browser and the local signer is in-process, so none of them render anything, and refusing there would cost a fresh device its wallet for nothing.

**What is deliberately NOT changed:** `fetchEncryptedMnemonicDetailed`'s contract that a decrypt failure on an event that *exists* propagates rather than folding into `{ mnemonic: null, trustworthy: true }`. That input is precisely what would feed the backfill a false "no backup here" and overwrite a real one. Gating at the caller means the function is never entered on Amber, so the contract is untouched — and a future gate that lives *inside* it must preserve that, returning `trustworthy: false` rather than a comfortable-looking `true`.

**That half is now closed, and the way it was closed is the lesson.** `#214`: the readers took `purpose` from the CALL rather than hardcoding it, because `fetchEncryptedMnemonic` serves both the cold-start restore and the wallet modal's "Restore from Nostr" button, and a purpose fixed inside the function is necessarily wrong for one of them. It was wrong for the button — the user pressed a control, was expecting the prompt, and got `UnattendedDecryptRefused`. **A required parameter forces a decision only at the layer that has it; the layer above can still hardcode an answer and silently override every caller beneath.**

**The private mute list was the last case, and it is now closed in both halves.** `<MutesSyncNotice>` offers the decrypt on request — see line 34 above; this paragraph used to claim no such path existed, and had been stale since `#250` built one. The second half took longer to see: the button worked and could not *stick*, because nothing recorded which ciphertext it had opened, so the next cold start parked the identical bytes and said the half stayed shut again. `MuteListState.knownPrivateContent` plus `privateHalfAlreadyOpened` closes that; the reasoning is in [`nostr.md`](nostr.md) under "A half we have opened once is not asked again". **The pattern generalizes to any encrypted-to-self coordinate an out-of-browser signer is not asked about unprompted: offering the prompt is only half a fix if the answer is thrown away.**

### The callbackUrl round trip, as built — and what it still does not cover

Everything below was measured on a Pixel 6 (Android 17, Brave default, no Chrome), first against **Amber 6.3.0** and **re-measured unchanged against 6.5.2** on 2026-08-21. Where a claim is reasoned rather than observed it says so. **Re-measure on a version bump rather than assuming** — this section is a description of one app's parser, not of the NIP, and the two disagree in ways that cost this feature two failed attempts.

*Re-measurement procedure, because a wrong reading here is expensive:* `adb shell am force-stop com.greenart7c3.nostrsigner` between every dispatch, then `am start -a android.intent.action.VIEW -d '<uri>' --es com.android.browser.application_id com.brave.browser`, and read `capturedLink=` out of `adb logcat`. The `--es` matters: without it Amber takes its extras branch and the test proves nothing about the URL parser. A **stale queued request renders as "Invalid request. Amber received a malformed nostrsigner request"**, which looked three separate times like a rejection of the request just sent — once producing a wrong conclusion that a version bump had broken the wire format.

**The request is an `intent:` URL with `S.` extras, never a bare `nostrsigner:` URL — since 2026-09-03, because Chromium changed underneath it.** Amber's `getIntentData` (IntentUtils.kt) routes on `Browser.EXTRA_APPLICATION_ID`: present → parse the `nostrsigner:` URL; absent → read `type`, `callbackUrl`, `pubkey`, `returnType` from intent EXTRAS. Chromium had stamped that extra on every intent it fired for a page, and stopped — `ExternalNavigationHandler.prepareExternalIntent` now skips it behind `DontClobberTabsWithChromeAppId`, landed 2026-07-20, `ENABLED_BY_DEFAULT`, in stable by late August, Brave included. So a bare `nostrsigner:` URL from a current browser reaches the extras branch with no `type` extra and Amber answers *"Unknown signer type: null"* — rendered as the same "Invalid request" screen as the `?` bug, on a `get_public_key` that carries no JSON and no `?`. That is the screenshot that found it: sign-in, not a boost.

  `Intent.parseUri` gives a page the extras: `intent:<data>#Intent;scheme=nostrsigner;package=com.greenart7c3.nostrsigner;S.type=…;S.callbackUrl=…;end` becomes `ACTION_VIEW nostrsigner:<data>` with one String extra per `S.` field, and Chromium parses an `intent:` URL with exactly that call and passes the extras through. `buildSignerIntentUrl` (`lib/nostr/amber-callback-url.ts`) writes it, and its two shapes are both deliberate. **`get_public_key` keeps the whole legacy `?…&callbackUrl=…` URL as its data**, so an older Chromium that still stamps the extra parses what it always parsed, a newer one ignores the data, and a data of exactly `nostrsigner:` — which Amber swallows whenever it holds a pending bunker request — never goes out. **A request with a payload sends `nostrsigner:<payload>` and nothing else**, because the extras branch decodes the data whole and a `?type=` tail would be parsed as part of the event; an older Chromium still ends up on the extras branch, since its URL branch finds no `?`, gets an empty parameter list, and falls through to `getIntentDataFromIntent` itself. **That fall-through is why the `\u003f` escape is load-bearing twice**: a `?` in the data is a parameter on the old branch and a rejected request. `check:amber` replays Android's parse over the built URL — the data reconstruction and the extras decode, transcribed from `Intent.java` — and asserts what each branch will read.

  Not yet re-measured on a device; the reasoning is from Amber's and Chromium's shipping sources, read on the day. Re-measure with the procedure above, and note that `--es com.android.browser.application_id` now reproduces the OLD browser, not the current one — leave it off to reproduce a current Chrome.

**A `callbackUrl` is what makes Amber come back at all.** Without one the phone lands on the launcher. With one, Amber fires an `ACTION_VIEW` at the browser every time.

**The callback URL may contain no `?` and no `&`.** Amber URL-decodes the WHOLE `nostrsigner:` URI and then splits it on `?` and on `&`, so either character truncates the callback there. Measured: `…/cb?rid=SPIKE123#result=` came back as `…/cb<result>`. **This is why `9a9330f` could not have worked either** — its fix was to terminate with `&event=`, which is the literal example in the NIP-55 text and which Amber's parser eats the same way. Re-tested on 6.5.2 by dispatching that commit's exact callback shape: `…/amber-callback?id=X&event=` came back as `…/amber-callbackf7922a0a…`, truncated at the `?`, with the result welded onto the path. The first attempt at this feature failed for two reasons and only one was ever written down. `assertCallbackUrlSafe` (`lib/nostr/amber-callback-url.ts`) is that mistake turned into an assertion, pinned by `npm run check:amber`.

**The terminator is a FRAGMENT, and that is forced rather than preferred.** `…/amber-callback#r=<32 hex>;event=` survives byte-for-byte; the result comes back appended and percent-encoded (Amber uses Android's `Uri.encode`, so it can neither terminate the fragment nor forge a separator). The server sees a bare `GET /amber-callback` — no query, no fragment. So correctness and privacy point the same way, which is worth stating because the privacy half is not decorative: a `nip04_decrypt` result is the user's PLAINTEXT, and `Referrer-Policy: strict-origin-when-cross-origin` sends the full URL as `Referer` on same-origin requests, so a query-borne result would reach our own server twice over and sit in Vercel's access log.

**The callback lands in a DIFFERENT TAB.** Brave opens Amber's `ACTION_VIEW` in a new tab rather than reusing the one that dispatched — tab count went 15 to 16. That is why `bmb:amber_pending` and `bmb:amber_result` are **localStorage**: the first version used sessionStorage, which is per-tab, so the pending record was never there and every sign-in fell back to a manual paste. The tab lifetime was what made it safe to park a result at all, so the rule replacing it is enforced in `lib/storage.ts` rather than remembered: **neither key may ever hold a secret**, and `AMBER_PERSISTABLE_TYPES` refuses to write anything but a `get_public_key` result.

**From a home-screen app it lands in a browser tab EVERY time, and the window that asked must be the one that finishes.** Measured 2026-09-03 on boostmebuddy.com installed from Brave (the first sign-in the `intent:` form made possible): Amber approved, a new Brave tab opened on `/amber-callback`, navigated into the site and signed in there, and the installed window stayed on "Approve in Amber…". Android resolves an https `ACTION_VIEW` to the default browser; a Brave-installed PWA is not an app-link target, so nothing on this side can route the callback into the standalone window. Two halves fix it. The dispatcher records `standalone: isStandaloneDisplay()` on the pending record, subscribes to the `storage` event (`storage.amberResult.subscribe`, fired in every OTHER same-origin window when the callback tab writes `bmb:amber_result`) and re-checks the parked result on every return signal it already listens for — the re-check matters because a backgrounded window can be frozen while the event fires. And `/amber-callback`, seeing `standalone`, parks the answer, tries `window.close()`, and stays put with "switch back to the app" and a fallback button, instead of `location.replace`-ing that tab into a second copy of the site. The parked result stays single-use: whichever window takes it first signs in, and the other starts signed out, which is the honest state.

**Only `get_public_key` uses the callback path** (`RESUMABLE_TYPES` in `amber.ts`). A callback costs a page reload, and that request is the only one in this app with no page state attached to it. `sign_event` must never join it: `publishBoostNote` signs AFTER the sats have moved, and a reload destroys the per-leg results that are the user's only record of who was paid — and it is unmatchable on resume anyway, since `created_at` moves and a re-asked request is a different one. The decrypts ARE deterministic and are the obvious next step, but they must clear `AMBER_PERSISTABLE_TYPES` first, which is a separate, security-shaped decision.

**Two clocks, deliberately different.** `AMBER_TIMEOUT_MS` (60 s) is how long the in-memory promise waits; `AMBER_PENDING_TTL_MS` (5 min, in the import-free leaf so both sides share one window) is how long the record stays matchable. A failed callback request KEEPS its record: the promise giving up is not the same event as the request becoming unmatchable, and clearing it would send the user back to Amber for something they already approved.

**Still not covered, and none of it is hypothetical:**

- **Only sign-in uses the callback; everything else still returns by clipboard — and that is fine when the user is WAITING for it.** Measured 2026-08-21 in the installed TWA: "Restore from Nostr" is a `nip44_decrypt`, it came back on the clipboard path, and the wallet restored. So the clipboard path is not broken in a Trusted Web Activity, which an earlier reading of this file implied.

  The distinction that actually matters is **who asked**. NIP-55 without a `callbackUrl` makes returning the user's job, and a user who pressed a button comes back and taps, which is what fires `invokeAmber`'s gesture listener. A request they did not initiate has nobody to come back — which is why the cold-start decrypt landed them on the launcher, and why favorites and mutes, which debounce-publish a `sign_event` nobody asked for, are the ones still at risk. Do not "fix" the clipboard path for user-initiated requests; it works.
- **A rejection sends nothing back.** Measured: rejecting in Amber produced zero `ACTION_VIEW` intents and zero requests, five times over. The user is left in Amber with no signal to the page, which is why the callback page and the pending record both need an expiry state rather than only a promise timeout.
- **The NWC backup hit that same `?` bug STRUCTURALLY, not occasionally, and every attempt from an Android device failed — fixed 2026-08-22 by `lib/nostr/amber-safe-text.ts`.** `publishEncryptedNwc` handed `JSON.stringify({ uri })` to `nip44.encrypt`, and on Amber that plaintext travels inside the `nostrsigner:` URI. NIP-47 writes a connection string as `nostr+walletconnect://<pubkey>?relay=…&secret=…`, so the payload truncated at `?relay=` and Amber answered *"Invalid request. Amber received a malformed nostrsigner request."* — before showing any prompt. From the page it is 60 s of nothing and then "Amber did not respond", which is the same sentence a missing Amber produces.

  **The asymmetry in the report is the diagnostic, and it is worth carrying:** on the same device, in the same session, "Restore from Nostr" worked. A decrypt's payload is a NIP-44 ciphertext and standard base64 has no `?`; a backup's payload is a connection string and always has one. So "restore works, backup doesn't" is not a relay problem or a permissions problem — it is a payload-content problem, every time.

  The fix does not strip the character; it removes the whole class. `encodeAmberSafe` writes `bmb1.<base64url>`, whose every character is one `encodeURIComponent` leaves alone, so the encoded text is a **fixed point of percent-encoding** and no decode pass by anyone — ours, the browser's, Amber's — can produce a delimiter from it. `payloadSurvivesAmber` is the matching predicate, and it is deliberately a predicate rather than an assertion: `publishBoostNote` signs after the sats have moved, so refusing to dispatch would convert an Amber limitation into a boost the user paid for and cannot post. It steers `invokeAmber`'s timeout MESSAGE instead, which is the one place a user can act on it. `fetchEncryptedNwc` reads both formats; dropping the legacy branch orphans every backup written before this. Pinned by `npm run check:ambersafe`.

  **The encrypt step still SUCCEEDED on the truncated text, which is why a checked box proves nothing.** Amber splits the decoded URI on `?` and then on `&`, so `type=nip44_encrypt` and `pubkey=` — both of which sit after an `&` — still parse. Only the payload loses its tail. `sign_event` fails outright at that point because a truncated event is not parseable JSON; `nip44_encrypt` has no JSON to parse, so Amber prompts, encrypts a prefix like `{"uri":"nostr+walletconnect://<pubkey>`, and the publish that follows succeeds. The card then reads "backed up" against a blob no device can use, and the user meets it weeks later on a new phone. `fetchEncryptedNwcDetailed` reports that third state (`unreadable`) rather than folding it into "no backup found", and the card's **↻ Back up again** is the repair — a blind overwrite, because kind:30078 is replaceable and reading first would cost a third Amber approval to reach the same publish.

  **A second, unrelated way the checkbox lies, still open:** `doLoadProfile`'s same-tab fast path restores the NWC URI from `storage.nwcSessionUri` and then sets `bmb:nwc_backup:<npub>`, though that stash is sessionStorage and never went near a relay. Removing the set is NOT the fix — `disconnect` reads the same flag to decide whether a tombstone is owed, so under-setting it leaves a real credential live on relays after an explicit disconnect. The flag conflates "a backup exists" with "we owe a tombstone", and separating them needs a second key.

  Two things this same commit fixed because they were hiding behind it: `publishEncryptedNwc` and `deleteEncryptedNwc` had **no `assertPublished`**, so a publish that reached zero relays still set `bmb:nwc_backup:<npub>` and the card said "backed up"; and a backup on Amber costs **two** round trips (`nip44_encrypt`, then `sign_event`), which the toggle now says out loud — unannounced, the second prompt reads as the first one repeating, which is the failure people give up on rather than report.
- **A literal `?` anywhere in the event JSON breaks `sign_event` outright, on BOTH the clipboard path and the callback path — and it broke EVERY boost note, not the occasional one. Closed 2026-09-03 by `escapeJsonForAmber`.** Same split-on-`?` cause as the callback truncation: `"does this work. yes"` signs, `"does this work? yes"` returns *"Invalid request. Amber received a malformed nostrsigner request."* `&` is fine (`"Mutton & Mead - track 3"` prompts normally). **Confirmed still present on 6.5.2**, against a force-stopped Amber, so it is not a stale-queue artifact.

  This file used to call it an upstream bug that only hit typed text. That reading missed the two URLs `formatContent` writes into every note — `…/?podcast=<guid>` and `…/api/og/boost.png?art=…` — so on Android every self-signed boost note came back "Invalid request" on Amber's own screen, and a report of exactly that screenshot is what found it. **The fix is JSON's own escape, not `encodeAmberSafe`.** Amber's parser is `decoded.split("?").first()` and THEN `AmberEvent.fromJson(localData)` (IntentUtils.kt), so writing every `?` as `\u003f` gives the splitter nothing and the JSON parser the same string; the event Amber signs is byte-identical to the one it would have signed. `encodeAmberSafe` is the wrong tool for anything another app reads: a `bmb1.` prefix inside a kind:1 is a note no client can render. `AmberSigner.signEvent` applies it to every template; `publishMuteList` and `publishSettings` apply it to their JSON plaintexts, and `encodePrivateFavorites` already wrote the same escape by hand. Pinned by `npm run check:ambersafe`'s `escape*` vectors. Amber's `compressionType=gzip` is not an alternative — it compresses the RESPONSE only.

  What remains: a non-JSON plaintext handed to an encrypt (`encodeAmberSafe` is the answer there), and the fact that from the page the failure **still surfaces as "Amber didn't come back"** — indistinguishable from the bug this section describes fixing. Do not read a report of that symptom as evidence about the callback code.
- **The TWA case is measured now, and the old note here had it backwards.** It said the callback would resolve to the app, "a different storage partition, so no pending record matches". Both halves are wrong. Measured 2026-09-03, Pixel 6, `com.boostmebitch` installed with `www.boostmebitch.com` reported `verified` by `pm get-app-links`: an https `ACTION_VIEW` on `/amber-callback` resolved to `CustomTabActivity` — into the app — and that window reported `matchMedia('(display-mode: standalone)').matches === true` with `document.referrer` = `android-app://com.boostmebitch/`. Chrome hands a verified TWA **the same profile as the site**, which is the premise of the assetlinks rule in CLAUDE.md, so the pending record matches perfectly. The real hazard is the opposite one: the callback **replaces the very window that asked**, so a rule keyed on `standalone` alone parks an answer and waits for a second window that does not exist, while telling a user already inside the app to switch to it.

  **So the decision needs two bits, not one, and `storage.amberTab` is the second.** `standalone` (on the pending record, localStorage, readable by every window of the origin) says *the asker was an installed app*. `amberTab` (sessionStorage, so present only in the tab that wrote it, and it survives a same-origin navigation within that tab) says *this document is the asker*. Park and stay put only when `standalone && !replacedTheAsker`; otherwise navigate back, which is what already worked. The three shapes, all confirmed on one device:

  | Window that asked | Where the callback lands | `standalone` | `amberTab` matches | What happens |
  | --- | --- | --- | --- | --- |
  | Ordinary browser tab | a NEW browser tab | false | no | callback tab navigates back; `<NostrAuth>`'s mount read consumes the answer |
  | Installed home-screen app | a separate browser tab | true | no | callback tab parks and says "switch back"; the app window hears the `storage` event |
  | TWA | the SAME window, replacing it | true | **yes** | callback navigates back in place — the pre-existing path, which works |

  The installed-PWA split is not hypothetical either: on the same device, the Boost Me Buddy home-screen window reported `standalone: true` while a `/amber-callback` tab beside it reported `browser: true`.

- **The cross-window handoff is only as good as the write, so `amberResult.set` returns `safeSet`'s answer.** On a full or blocked store `safeSet` falls back to `memoryMirror`, which no other window can read and which fires no `storage` event. Returning a bare `true` there made `/amber-callback` say "Signed in — switch back to the app" while the window that asked waited out its 60 s and reported "Amber did not respond". The callback page already has the honest screen (`if (!parked)`), which keeps the raw value on screen for a manual paste; it just was not reachable.

- **Only a standalone window subscribes to the parked result.** `storage.amberResult.subscribe` used to arm for every callback request. In an ordinary browser tab that races the callback tab's own navigation for a single-use record, and the winner depends on whether Android had frozen the requesting tab — observed going both ways on one device. Nothing user-visible rides on it today, because sign-in state is localStorage and every tab of the origin reads it back, so the losing tab still renders as signed in. It is removed because it is free to remove and stops being harmless the day a second type joins `AMBER_PERSISTABLE_TYPES`.

- **Amber renders the app name from the `nostrconnect://` URI, and `URLSearchParams` writes a space as `+`.** `createNostrConnectURI` builds the query with `URLSearchParams`; Amber percent-decodes and leaves `+` alone. So `BRAND.displayName` reached Amber's approval screen as **"Boost+Me+Bitch"** — seen on a Pixel 6 running Amber 6.5.2, and reproduced against the pinned library (`name=Boost+Me+Bitch` on the wire). That screen is where someone decides whether to trust this app, so `startNostrConnect` passes `BRAND.wireName`, the brand's no-spaces form already used for the boostagram `app_name` and the note `client` tag. Any new field put in that URI inherits the same encoder.

- **The nostrconnect retry listener must yield to a NIP-55 request in flight, and only the newest attempt may report.** The visibility listener stays attached while `amberNcErr` is set, which is wanted — a relay ack can land on a subscription Android suspended. But the documented next move after a failure is the "Amber without a relay" button in the same box, and returning from *that* trip is a `visibilitychange` too: restarting nostrconnect on it disabled the fallback button under the user's own in-flight request. It now bails on `amberBusy`. Separately, `startNostrConnect` memoizes the URI and client key but builds a **fresh `ready`** on every call, so a retry runs alongside the first attempt rather than replacing it — two acks would call `finalizeBunkerLogin` twice, and the older attempt's 120 s timeout would write "Connection dropped" over a session that is still coming up. `amberNcAttempt` is a monotonic ref; a superseded attempt returns without touching state.

### `lib/nostr/signer.ts` — the swap point

One polyfill active at a time. `captureOriginal()` snapshots the underlying NIP-07 extension on first activation so deactivation restores it. `bmb:signer` holds `'amber' | 'bunker' | 'local' | absent` so the page-load fast path knows what to restore. Capability accessors live here: `getNip04()`/`getNip44()` (API or null), `requireNip44()` (throws). Use them instead of inlining `typeof window !== 'undefined' && window.nostr?.nipXX`.

**`signer.ts` publishes `localInstance.nostrApi`, never the `LocalSigner` instance.** `private sk` is a TypeScript annotation with no runtime effect, so assigning the instance exposes the raw secret key as **`window.nostr.sk`** to any script on the origin (Google's GIS script among them — we inject it and never remove it), turning "can use the signer while the tab is open" into permanent theft of the identity *and* its derived Lightning wallet. The bunker signer publishes a separate `nostrApi` for the same reason. Don't add a key-export method to `LocalSigner`; the one that existed had zero call sites and was deleted.

**That rule is about ambient reach, and the distinction is now load-bearing.** What makes `window.nostr.sk` a disaster is that *no one asked* — any script on the origin reads it, silently, forever. A user deliberately looking at their own key is a different act, and the app needs it: an identity the user cannot leave with is not theirs, and a `'local'` sign-out wipes both the ciphertext and the wrap key, so without an export the only copy lives behind a PIN. `<ExportKeySection>` (`components/nostr-auth/export-key.tsx`) reads through `getKey()` — already the sanctioned in-app path, used by `provision-spark.ts:44` — into component state, on an explicit click, cleared on unmount, gated on `storage.signer.get() === 'local'` (Amber and bunker sign remotely; a NIP-07 extension owns its own key, so there is nothing here to export).

So the boundary to hold when editing: **no signer instance on a global, no module-level accessor, no key reachable without a person having asked for it.** One reveal in one component is the whole exception. If you find yourself adding a second caller of `getKey()` that isn't user-initiated, that's the rule reasserting itself.

**`decryptWithTimeout(pubkey, ciphertext)` also lives here, and every background decrypt goes through it.** NIP-44 decrypt calls are handed to the user's signer — extension, Amber, or bunker — and on iOS the extension's background service worker can be killed *between* the relay query and the decrypt call, leaving the promise pending forever. There is no rejection and no timeout of its own: the restore simply never finishes, and a spinner that never resolves is indistinguishable from a slow relay. So every such call is capped (10 s) and rejects instead of hanging.

It sits in `signer.ts` because this module owns `requireNip44` — but it is shared rather than per-caller because it had been copied verbatim, same body and same constant, into `lib/nostr/wallet-backup.ts` and `lib/nostr/settings-backup.ts`. Those are the two encrypted-to-self restore paths, which is precisely where a hang is invisible: both run in the background during `loadProfile`, neither has a screen in front of it. Both already imported from this module, so sharing it added no import edge. **A new encrypted-to-self backup uses this rather than awaiting `requireNip44().decrypt` directly.**

**Its read-side relay set is `backupReadRelays` (`lib/nostr/relays.ts`), also shared, also formerly duplicated** — see [`nostr.md`](nostr.md) for why the union of publish relays and `DEFAULT_RELAYS` is the right set and what a narrowed one silently reports.

### Google onboarding — a key for users who have none

Ported from **Wisp** (github.com/barrydeen/wisp, `v1.1.0`). The central insight, because the obvious version is wrong: **Google is not an identity provider here — it's a zero-knowledge blob store.** The key is generated locally at random (`generateSecretKey()`); nothing derives from the Google account. Wisp shipped deterministic `sub`-derived nsecs once and reverted.

> **NEVER DERIVE THE NSEC FROM `sub` + PIN, AND KNOW THE ARGUMENT THAT WILL BRING IT BACK.** It arrives as a feature request, not as a crypto proposal: *"two deploys have their own Google projects, so let both derive the same key and the same wallet comes up on either site."* It does solve that — `appDataFolder` is per Cloud project, so a derived key is the one construction needing no shared storage at all. **It also destroys the identity outright.** The npub is PUBLIC — it is on every note the user signs — so an attacker enumerates the 10⁶ (or 10⁸) PINs, derives each candidate key, and compares pubkeys. One pass, no blob required, and the Argon2id cost buys nothing here because the attacker has an oracle: the answer is on the relays. The PIN stops being a secret protecting a stolen blob and becomes the ENTIRE key. And `sub` is not a secret either — every app the user signs into with Google receives the same value.
>
> The random key plus an encrypted blob is what makes the PIN merely the second of two layers; `backup-crypto.ts` names both, and app-private Drive storage is the first. Any scheme that removes the blob, or moves it somewhere a stranger can fetch (a relay at a `sub`-derived address, our own server), gives up that first layer and leaves a 6-digit secret alone in front of the identity. **The shared-wallet goal is answered in [`ops.md`](ops.md) — one Cloud project with a brand-neutral app name — and that answer costs a console field instead of the security model.**

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
- **The consent popup is started by `startGoogleSignIn()` inside the click handler, and by nothing else.** `<GoogleAuthPanel>` used to request it from its mount effect, on the premise that the effect still ran under the opening click's transient activation. It does not — React schedules effects in a later task — so on iOS Safari, the home-screen PWA included, the FIRST attempt was blocked every time and the panel opened on *"Your browser blocked the Google sign-in popup."* Retry then worked, which is what made it look like a flake rather than a certainty: Retry is a real click and GIS is loaded by then. The click parks the request in a module slot; `signInWithGoogle()` consumes it (taking it before anything can throw, so a failed attempt leaves no stale promise) and falls back to its own request when the slot is empty. **A new Google entry point calls `startGoogleSignIn()` as the first statement of its handler** — an `await`, a `setState` flush or an effect between the tap and the request is the whole bug.
- **Nothing may await the script and THEN ask for the popup — that await is the network, and the request lands with no activation left.** This is the same fault as the mount effect, one layer down, and it survived the first fix: `tapBegin` called `startGoogleSignIn()` and, when the script wasn't ready, *fell through* to `begin()` → `signInWithGoogle()` → `await loadGis()` → blocked. So a cold start still spent exactly one refused attempt before Retry worked — the original symptom, from a different line. The panel now holds on a **`preparing`** stage until `whenGisReady()` resolves and only then renders the tap, and `tapBegin` re-arms instead of falling through. **The button does not exist until a tap can succeed**, which is the invariant; `signInWithGoogle()`'s own `await loadGis()` path stays as a library fallback and is unreachable from the panel.
- **`preloadGis()` runs one gesture EARLIER than the tap it protects** — when the account menu opens, again when the sign-in modal opens — and `app/layout.tsx` carries a `preconnect` to `accounts.google.com`. The script stays lazy on purpose: a signed-out visitor who never taps Sign in should not pay for a third-party fetch. But that leaves only the menu-reading time to load it, and the TCP+TLS handshake is the slow half on a cold mobile connection, so the preconnect is what makes the fetch land inside that window. It sends no request and carries no cookie.
- **`popup_failed_to_open` covers two faults and the copy must not merge them.** A request with no gesture behind it is OURS, and telling that user to allow popups sends them into Settings after a setting that is not the problem. `gisErrorMessage` takes `clickStarted` so the blocked-after-a-real-tap case says so — which also makes a screenshot diagnostic.
- **`refreshAccessToken()` is silent-first (`prompt: ''`)** — it runs mid-flow after a Drive 401 with no activation left, where a popup would be blocked. On failure it throws `GoogleReauthRequiredError`, pointing at the panel's Retry (a real click).
- **`gisErrorMessage` maps `error_callback` by `type`, and `popup_closed` is THREE faults, not one.** The user closed the window; Google refused the origin (chooser, error page, closed window); or the popup died on a network fault mid-flow. GIS reports all three as `popup_closed`, so the copy may not name any of them — it said "cancelled", which told someone whose sign-in broke on its own that they had backed out of it. It now says what to DO and what an error page MEANS. `popup_failed_to_open` is still a separate type and still must not be merged with it. **The discriminator is not in the type but in the SHAPE: a refused origin fails every time, on every device, so an intermittent failure is the transport.** `logGisError` writes the origin and client id to the console because one repo builds two deploys and nothing on screen says which client a build used.

**`lib/nostr/drive-backup.ts`** — blobs live in Drive **`appDataFolder`** (app-private, invisible in the user's Drive UI) as `bmb_bk_<uuid>.bin`. **"App" there means the Google Cloud PROJECT, so changing a deploy's `NEXT_PUBLIC_GOOGLE_CLIENT_ID` to a client in a different project hands it an EMPTY appdata and orphans every existing backup** — silently, and straight into `setupPin`'s new-account path. The cost and the ordering are in [`ops.md`](ops.md).

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

The backup stays authoritative: the relay read continues and **re-inits only when the stored mnemonic differs from the derived one** (the pasted-own-seed case). Mirrors Wisp, where the derived wallet is the *default*, reachable from the nsec alone with no relay backup.

**And when that read comes back empty, it publishes.** Being derivable from the nsec is what let a missing kind:30078 go unnoticed indefinitely — the wallet works either way, so nothing surfaces it, while the seed stays reachable only through a derivation label no other client implements. The backfill reads via `fetchEncryptedMnemonicDetailed` and requires a **trustworthy** absence plus three more guards before writing to a replaceable coordinate; the reasoning lives in [`wallets.md`](wallets.md) because the fund-loss shape is a wallet concern. What belongs here: it fires for local signers only (`derived` is null otherwise), so Amber, bunker and NIP-07 are untouched.

**A new account gets a Spark wallet for free.** `sparkMnemonicFromKey(skHex)` derives a 12-word BIP-39 phrase from `HMAC-SHA256("bmb-spark-wallet", sk)`. **Treat that label as v1 and never edit it in place — changing it silently moves every user to a different, empty wallet.** Deterministic, so the wallet survives losing the kind:30078 backup; the HMAC domain-separates it so the wallet seed can't be walked back to the signing key. It returns an ordinary mnemonic, so the init/publish/seed-display paths are untouched.

Two guards, both needed: `hasSpark()` before the SDK init, and **`sparkSeedIsActive(mnemonic)` before `publishEncryptedMnemonic`** — provisioning is fire-and-forget across seconds of handshake, and a user pasting their own seed in that window would otherwise have their real backup overwritten by the derived one (replaceable event, permanent loss). `hasSpark()` can't be the second guard: after our own init it's unconditionally true. Runs **only on the new-account branch** (on restore, `loadProfile`'s silent restore owns that path and a derived wallet could stomp the real one), best-effort, and `console.warn`s rather than swallowing — a silent rejection is indistinguishable from "still initializing".

**And it throws when the publish reached no relays** — via `assertPublished` inside `publishEncryptedMnemonic`, which covers all four writers rather than this one. `signAndPublish` resolves once every relay has settled, accepted or not, so a total failure returned an empty `acceptedRelays` and awaited exactly like success. This is the worst place for that: a brand-new npub has no kind:10002 yet, so the publish only ever targets `DEFAULT_RELAYS`, and one bad moment during signup left the account with no backup and nothing anywhere saying so. Throwing routes it into the caller's existing `console.warn` — **the message, never the error object**, because this rejection can come from `SparkWallet.initialize({ mnemonicOrSeed })` and SDKs routinely echo their options back in validation errors, which would put the seed in the console. Recovery is the login backfill above.

**It lives in `lib/v4v/spark-derive.ts`, not `spark.ts`.** `spark.ts` is `'use client'` and statically imports `'../pubsub'` extensionless, so plain Node can't load it — leaving the one function whose silent change costs users their funds with no regression pin. `spark-derive.ts` has no directive and no static imports (crypto stays dynamically imported inside the function, keeping `@noble`/`@scure` out of the initial browser chunk), so `npm run check:spark` runs the *real* function against a frozen vector. It pins `deriveBackupKey` the same way — change the label, the Argon2 params or the salt construction and every user is locked out of their Drive blob. `spark.ts` re-exports, so call sites still import from `@/lib/v4v/spark`.

**`provisionSparkFromKey` doesn't consult `bmb:spark:opted_out`, and writes its `'0'` before its first `await`.** A key generated seconds ago has no opinion recorded, so there's nothing to honor — that's what scoping the flag per-npub bought. The write ordering is the load-bearing half: provisioning runs fire-and-forget while the caller races to `completeSignIn` → `loadProfile` → `deriveSparkFromLocalKey`, which *does* read the flag. Historically `storage.sparkOptOut.get` fell back to the legacy global key when an npub had no scoped value, so on any device where an earlier identity turned Spark off, a brand-new account inherited that opt-out; **that fallback has since been removed** (`lib/storage.ts` reads the scoped key only, and the bare key is dead — see [`storage.md`](storage.md)). Writing `'0'` first therefore now earns its keep on the second half alone: it makes a failed init retryable next login instead of permanent. *(The same stale legacy-fallback claim is repeated in the comment at `components/nostr-auth/provision-spark.ts`.)* The **restore** path does honor the flag (gated on `storage.sparkOptOut.get(identity.npub)`) — there the npub has a history. See [`storage.md`](storage.md) for the tri-state and the dead global key. **Spark is the user's wallet until they connect a different one.**

**A new account also gets a generated kind:0.** `lib/nostr/generated-profile.ts` derives a display name (adjective + noun word lists) and a 5×5 mirrored identicon from the **pubkey** — never from the Google account, which would need the `profile` scope and would publicly link the npub to a real-world identity. The avatar is an inline `data:image/svg+xml;base64` URI, so it depends on no hosting. Published by `provision-profile.ts` to `resolvePublishRelays(identity) ∪ PROFILE_RELAYS` — **the union matters**: purplepag.es is the profile outbox Damus and Amethyst read. **New-account branch only** (kind:0 is replaceable; publishing on restore would overwrite a profile set in another client).

**Two callers write a user's kind:0, and both go through `publishProfile` (`lib/nostr/profile.ts`)** — this one, and `<ProfileEditor>` (`components/profile-editor.tsx`). They share that function so the relay union and the post-publish cache reseed can't drift apart; what they must NOT share is the merge. Onboarding publishes a generated profile outright, which is safe by construction — a key generated seconds ago can't already have a kind:0 to preserve. The editor is the opposite case and carries the two rules below.

### Sign-in UI — `<SignInModal>` (`components/nostr-auth/sign-in-modal.tsx`)

The entry point lives in the combined **`<AuthControl>`** header control, not a standalone button — signed out, `<NostrAuth>` renders **only** the modal (its hydration effects and `completeSignIn` still run). Opening it flips `signInOpen`; the modal is a portal'd two-tab overlay (same pattern as `wallet-modal.tsx`):

- **Browser Extension** — `loginWithExtension` (NIP-07); the button is disabled with a hint when `window.nostr` is absent.
- **Remote Signer** — *Generate QR* (`nostrconnect://` via `loginWithNostrConnect`) and *Paste Bunker URI* (`loginWithBunker`) stacked, plus **"Sign in with Amber"** (`loginWithAmber`) on Android and **"Sign in with Clave"** on iOS. Default tab when no extension is detected, **and whenever the modal was opened with the Clave intent or a pairing is still pending** — see below.

**The iOS box mirrors the Android one and sits in the same slot** — above Option 1, because on the phone displaying the QR the QR is not an option. `isLikelyIOS()` gates it; that helper had been written and exported with zero call sites since the Amber work, and this is the first. Structurally it does NOT mirror it, and that is the point: the Android box's button dispatches, while `<ClaveConnectLink>` is an `<a href>` the user taps and `prepareClave()` only ever subscribes. There is no `launch` flag on the iOS side and nothing left for JavaScript to navigate.

**`prepareClave` is called from three places, none of them a navigation**: the prepare-on-open effect, the anchor's own click (so a dead attempt gets a live subscription in the same gesture that leaves for the app — guarded on `claveBusy`, since re-subscribing over a live attempt just opens a second socket on one pairing), and the visibility retry on the way back. `claveAttempt` still means only the newest attempt may report an error, and `claveSettled` still means a success from ANY attempt signs in.

**`claveBusy` is not "the user is waiting" any more, and `claveSent` is.** The pairing is prepared when the box opens, so busy is true before anyone has touched anything; only `claveSent` may say *"approve in Clave, then come back"*, relabel the control *"Open Clave again"*, or arm the nothing-happened timer. Reading the wrong one puts a *"Clave may not be installed"* hint under a button nobody has pressed.

**`openAppLink` (`lib/app-link.ts`) is now the Amber button and the `clave://` escape** — the header row no longer calls it, and neither does anything else.

**A fourth `visibilitychange` retry effect, and it introduces a collision the Android box never had.** The Clave button and the QR box both call `loginWithNostrConnect`, whose memo returns the SAME URI but builds a **fresh `ready`** — so if both effects fire on one return, two subscriptions resolve on one pairing and `finalizeBunkerLogin` runs twice: two live transports, `onSuccess`/`onClose` on an unmounted modal. `claveAttempt` guards only within its own branch. Reachable in two taps: tap *Sign in with Clave*, watch nothing happen because Clave is not installed, tap *Generate QR Code*. So the guards are mutual — the Clave effect bails on `genBusy || pasteBusy` (the same reason the Amber one bails on `amberBusy`: its documented next moves are in the same tab, and returning from *those* is a `visibilitychange` too), and the generate effect gains `claveBusy`.

**A missing app produces no signal at all**, which is why there is a timer. An unregistered custom scheme on iOS is a silent no-op — no error, no navigation event, nothing observable — so after ~6 s of waiting the box says *"Nothing happened? Clave may not be installed"* with an App Store link. **Do not replace that with install-detection**: the usual `document.hidden` race reports "not installed" for any slow app switch, which is the ordinary case for a signer being cold-launched. The box also carries a one-tap *"Open Clave to copy a `bunker://` URI"* pointing at Option 2, because Clave's own doc recommends the bunker flow for same-device iOS pairing — it keeps this page in the foreground, so Safari never suspends the socket the handshake rides on. We lead with the deep link because it is one tap and the memoized re-subscribe already exists, but the vendor-recommended path has to be one tap away and labelled as such.

**Which of the two links is the primary has been reversed three times; the argument is in "The launcher, reversed three times" above and is not repeated here.** As shipped: the Universal Link is `<ClaveConnectLink>`, a real `<a href>`, and `clave://` is `<ClaveSchemeButton>`, the labelled escape, which may go through `openAppLink` because a custom scheme IS dispatched from a scripted click. Routing the **Universal Link** through `openAppLink` is the one thing that must never happen — a scripted click cannot reach the app, so it navigates the tab to clave.casa and takes the waiting subscription with it.

**Each link has a silence the other covers, and neither is detectable from the page** — see the launcher section above for both. That is why the timed hint offers the scheme escape and an App Store link rather than guessing between two nothings that look identical, and why a timer is the only signal either produces.

**WHICH TAB THE MODAL OPENS ON IS A CORRECTNESS QUESTION, NOT A PREFERENCE.** `tab` was seeded from `hasExt` alone, so "Sign in with Clave" — which launches Clave inside `<AuthControl>`'s own click and opens this modal with `signInIntent === 'clave'` — landed on **Browser Extension** for anyone whose iPhone has a NIP-07 Safari extension. Reported with screenshots: Clave showing *"Approve Connection"*, the modal showing *"Connect with extension"*, and the user having to find the Remote Signer tab before the flow they had already started could report anything. It is not cosmetic, which is why the intent outranks the extension check rather than sitting beside it: **every return-from-the-signer effect bails on `tab !== 'remote'`**, so on the wrong tab the ack arriving on the way back from Clave had nothing listening for it. `hasPendingNostrConnect()` is in the same initializer for the same reason one step removed — a pairing this tab LOST is resumed by the effect below whatever tab is showing, so the tab showing has to be the one that can report it.

Both tabs stay available so a desktop extension user can still pick a remote signer. The modal owns its per-method busy/error state and the **iOS visibility-retry** that re-attempts the nostrconnect handshake when Safari suspends the relay WebSocket on app-switch. On success it calls `index.tsx:completeSignIn(id, kind)`. `login-methods.tsx` now holds only the shared `<AmberCompletion>` clipboard-recovery helper.

**`<GoogleAuthPanel>` is NOT reachable from inside this modal.** There is no "Continue with Google" button above the tab strip — `googleOpen` is seeded once and has no setter, so the panel renders only when the modal was opened with `signInIntent === 'google'`. `<AuthControl>`'s header dropdown is the sole entry point. While the panel is open the tab strip is hidden, and it carries its own **back affordance** on every non-destructive stage: `confirmPin` → `setupPin`, a PIN screen reached from the picker → the picker, otherwise `onCancel()`. The `working` stage is excluded — an upload may be in flight, and abandoning it is how you get a blob in Drive with no local key.

**The modal can open straight onto that panel via `signInIntent`.** `<AuthControl>`'s dropdown lists "Continue with Google" as a peer of the other logins and calls `setSignInOpen(true, 'google')`; the modal seeds `googleOpen` from that intent with a **lazy `useState` initializer — read once, never subscribed**, since a late store write would otherwise yank someone out of a half-entered PIN. The panel's `onCancel` is the modal's own close handler, so **backing out of its first stage closes the whole modal** rather than dropping the user into signer tabs they never asked for. The header entry exists because burying this flow inside "Sign in with Nostr" hid it from exactly the people it was built for.

**Modal open-state lives in the store** (`signInOpen`/`setSignInOpen`), so other surfaces (fullscreen player header, live-chat composer) can open the one modal `<NostrAuth>` owns — don't mount a second `<NostrAuth>`, it would double the profile-load and focus-listener effects. Portal'd at `z-[60]` so it clears the fullscreen player (`z-50`).

### Account-change detector

One `window.focus` listener in `components/nostr-auth/index.tsx`, active only while signed in via NIP-07 (`bmb:signer` absent). Re-calls `getPublicKey()` (throttled 30 s); on a change, drives `loginWithExtension` + `completeSignIn`. Multi-identity Alby/nos2x users are first-class. Extension presence is otherwise read at modal-open time.

### Lifecycle observables

- **`subscribeAmberStage(fn)`** — `'idle' | 'awaiting' | 'returned'`. `<AmberCompletion>` flips its hint copy in lockstep with `invokeAmber`. While in flight it always shows a "◆ Read clipboard manually" button + paste textarea, because `visibilitychange` is unreliable on standalone-PWA returns.
- **`subscribeBunkerHealth(fn)`** — boolean (stale or not); adapter calls run through `trackBunkerCall` with a 30 s timeout. `<BunkerHealthBanner>` in `<AccountMenu>` offers "Signer disconnected — Reconnect". Targets the iOS-PWA-suspended-WebSocket case.
- **`subscribeBunkerApproval(fn)`** — `{ waiting, label, attempt }`, driven by `withApprovalWait`. A **third** observable rather than a second meaning for the health flag, because the two say opposite things: stale means the transport looks dead, this means it demonstrably is not. `<BunkerApprovalNotice>` renders it, carries **Stop waiting** (`cancelBunkerApprovalWait`), and returns null when idle so a surface can mount it unconditionally.



## A bunker transport must be CLOSED, not merely dropped

`BunkerSigner.fromBunker` subscribes the moment it is called — it builds a `SimplePool` and opens a kind:24133 subscription to the bunker relays inside the constructor path, before `connect()` is awaited. Three things followed from that, and all three were live:

- **A failed handshake abandoned a running transport.** Both `attempt` helpers (in `connectBunker` and in the restore path) created the signer and then `await`ed `connect()` and `getPublicKey()` with no teardown on the throw. The "subscription closed" retry made it two per call.
- **`activateBunkerSigner` overwrote `bunkerInstance` without closing it**, and `restoreBunkerSigner` goes through it. The control that reaches that path is **RECONNECT in the account menu** — the button an iOS user presses over and over, because iOS suspends the relay socket. Each press added a subscription and up to four sockets. Relays cap connections per client, so a long enough session ends with the reconnect refused by the relay it needs, which presents as the button simply not working.
- **`activateAmberSigner` and `activateLocalSigner` null the field too.** Those were latent only because the sign-out paths happen to close first.

`closeBunkerTransport()` in `lib/nostr/signer.ts` is the single funnel, and every path that stops pointing at an adapter calls it.

**`inner.close()` alone is not enough, and this is the part that is easy to get wrong.** It sets `isOpen = false` and closes the subscription — which does genuinely stop the signer, since `sendRequest` throws on `!isOpen` and re-subscription only happens from there — but it never touches the sockets, because the pool is a separate object. nostr-tools has no auto-close when a relay's last subscription ends (`abstract-relay.js` tracks `openSubs` and does nothing on empty). And `BunkerSigner.pool` is `private` in the type declarations, so the pool it builds for itself is unreachable.

So **this module passes its own pool in** (`params.pool` is public) and `BunkerAdapter` carries it. `closeBunkerTransport` then does both halves in order: `inner.close()` to end the subscription, `pool.destroy()` to return the sockets. Destroying outright is safe *only* because that pool belongs to one connection — **never hand it the shared pool from `lib/nostr/pool.ts`**, which would take every other query's connections with it.

The `nostrconnect://` path owns its pool for the same reason and needs it more: it waits up to `NOSTRCONNECT_TIMEOUT_MS` for a signer that may never scan the QR at all, so the abandoned-transport case is the expected one there rather than the exception.
