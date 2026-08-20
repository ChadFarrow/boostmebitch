# Android — the TWA, Digital Asset Links, and Zapstore

Read before touching `app/.well-known/assetlinks.json/route.ts`, `lib/assetlinks.ts`, `android/twa-manifest.json`, `zapstore.yaml`, `.github/workflows/android-release.yml`, or the parts of `public/manifest.json` an Android build consumes.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

## What the Android app is

A **Trusted Web Activity**: a signed Android shell that opens `https://www.boostmebitch.com` full-screen with no browser chrome. There is no second copy of the app. A Vercel deploy updates the Android app at the same moment it updates the site.

**Why not a bundled native shell.** The app cannot be statically exported. `next.config.mjs` has no `output: 'export'`, `app/page.tsx` reads `searchParams` in `generateMetadata` and so renders dynamically, and thirteen `app/api/*` routes hold the Podcast Index credentials plus every payment-critical lookup — `/api/value-splits`, `/api/keysend`, `/api/lightning/boostbox`, `/api/live-value`. Bundling the assets would still leave every one of those calls pointed at the live origin, so it would buy an offline splash screen and a second build system, and cost the guarantee that the credential never leaves the server.

**Why Zapstore.** It is a Nostr-native app store, and its publishing tool `zsp` handles APKs exclusively — there is no web-app listing type, so an Android package is the only shape this can take. The audience fit is the reason it is worth doing: Zapstore users overwhelmingly sign with **Amber**, which this app already supports over NIP-55 and which exists only on Android, and pay over **NWC**.

## The origin must be `www`, and this is not a style preference

Chrome verifies the app's claim on the origin by fetching `https://<host>/.well-known/assetlinks.json`. **Digital Asset Links does not follow redirects**, and [`ops.md`](ops.md) records that the apex 307-redirects to `www`. So:

- `twa-manifest.json`'s `host` is `www.boostmebitch.com` — the same host `app/layout.tsx`'s `metadataBase` and `bmbLandingUrl()` (`lib/nostr/boost-notes.ts`) already use;
- `additionalTrustedOrigins` stays empty. Adding the apex would require a non-redirecting statement file there, which the redirect makes impossible, so it would be a line that looks like coverage and provides none.

## Why the statement is a route handler, and why it fails closed

There is no `public/.well-known/` in this repo; both existing entries (`nostr.json`, `keysend/[name]`) are route handlers, and the keysend route's own comment explains one reason — a `public/` file with no extension serves as `application/octet-stream`. The assetlinks route adds two more:

- **The fingerprint identifies a signing key that must never be committed beside the code.** It lives in `ANDROID_CERT_SHA256`, with `ANDROID_PACKAGE_ID` beside it.
- **A key rotation becomes an environment change**, with no deploy and no review standing between a broken app and its fix. Both fingerprints ride in the variable at once during the overlap, because the build already on people's phones is signed by the outgoing key. That is what the comma-separated list is for; it is not decorative.

**Unset serves `[]`, not a 404 or an error.** An empty statement list is a valid document that truthfully says "no app is delegated". A 404 is indistinguishable to Chrome from a broken deploy, and an error object would leak which environment variables exist. It is also what makes the route shippable before any keystore does.

**`rateLimit(req, …)` is load-bearing beyond rate limiting.** Reading the request is what keeps the route dynamic. Remove the limiter as pointless on a static JSON document and Next may prerender the handler, baking the *build-time* environment into a static asset — after which rotating `ANDROID_CERT_SHA256` in the dashboard changes nothing until the next deploy, silently.

**Validation happens on the way out**, in `lib/assetlinks.ts`, the same fail-closed discipline `app/.well-known/keysend` already follows: a malformed package id or a fingerprint that is not exactly 32 bytes of hex produces **no statement**, never a guess. One bad entry among several is dropped on its own rather than failing the list, because mid-rotation that list is edited by hand and losing verification for the key that *is* valid is the worse outcome.

`normalizeFingerprint` deliberately accepts **bare hex as well as the colon form**. `keytool -list -v` prints uppercase colon-separated; `apksigner verify --print-certs` prints bare lowercase. Both are unambiguous 32-byte values and both are what a human actually has in hand — and the cost of rejecting one is the worst kind of failure this file can produce: the variable is set, the served document is empty, and nothing anywhere says why.

`npm run check:assetlinks` pins all of it. What it cannot pin is whether Chrome accepts the result — only a phone can do that.

## `twa-manifest.json`, field by field where it is not obvious

Bubblewrap regenerates the entire Gradle project from this file on every `update` and overwrites manual edits, which is exactly the property that lets one JSON file be the only thing in git. Everything else under `android/` is ignored.

- **`packageId: com.boostmebitch.app` is permanent.** Zapstore keys an app on package name plus signing certificate; changing it later is a brand-new app with no upgrade path for anyone who installed the old one. `.app` rather than `.twa` so today's packaging choice is not baked into a forever-identifier that should survive a future native rewrite.
- **`fallbackType: customtabs`.** The `webview` fallback runs in a WebView with **its own storage jar**, where the NWC credential and any local nsec held in Chrome would be invisible, and `nostrsigner:` dispatch behaves differently. Custom Tabs keeps the same Chrome profile. Do not switch this.
- **`orientation: default` diverges from the web manifest's `portrait`, on purpose.** `<FullscreenPlayer>` plays HLS live streams in a `<video>`, and a portrait-locked activity would stop that rotating. The web manifest is unchanged — an installed PWA has no video-rotation problem worth changing site-wide behaviour for.
- **`enableNotifications: false`.** `true` adds `POST_NOTIFICATIONS` and the notification-delegation service. The app sends no Web Push, and Zapstore surfaces the permission list prominently. Flip it when Web Push actually ships, not before.
- **`fingerprints: []` stays empty.** That array only feeds Bubblewrap's own `fingerprint generateAssetLinks` command, which this repo does not use. The route handler is the single source of truth for the statement. Filling this in would create a second copy to drift.
- **`shortcuts: []`.** Browse, detail and discussion are state-driven swaps rather than routes (see CLAUDE.md), so there is no URL for a launcher shortcut to land on. Adding shortcuts means adding routes, which is a different change with a different argument.
- **`enableSiteSettingsShortcut: true`** gives the user a way into Chrome's site settings for the origin — useful for the clipboard permission Amber's return path needs.
- **The serialized version key is `appVersion`, not `appVersionName`.** The class field is `appVersionName`; the JSON key is not. Easy to get wrong and silently ignored if you do.
- **`minSdkVersion` is omitted** so Bubblewrap's own default applies. Pinning a number here means owning its compatibility with the TWA support library across upgrades, for no benefit today.

## Versions — there are three, and they are not wired together

1. `package.json`'s `0.1.0` — the npm package.
2. The Android `appVersion` / `appVersionCode`, written by CI from the git tag: `v1.2.3` → `1.2.3` and `10203`. Derived from the tag rather than `github.run_number` so a plain re-run of a release produces the same number.
3. `app_version: '0.1.0'`, hard-coded at six boostagram TLV call sites (`components/boost-modal/index.tsx`, `components/boost-all-modal.tsx` ×3, `lib/v4v/streaming.ts`).

**Unifying them is a separate change.** Six of those call sites are on the money path, and an Android packaging change is the wrong place to touch them. A single `APP_VERSION` in `lib/util.ts` would be the shape — that file is import-free enough to stay pinnable — but it needs its own review.

`zapstore.yaml` deliberately carries **no** `min_allowed_version_code`. That field means "installs below this are out of date", and bumping it every release marks every older install stale for cosmetic changes. Set it only for a genuinely mandatory release — a money-path or credential fix.

## The release path

`.github/workflows/android-release.yml`, on a `v*` tag. `workflow_dispatch` builds, signs and verifies without publishing, so the whole path can be walked before any tag or Zapstore identity exists.

**`bubblewrap update`, not `init`.** `update` regenerates the project from `twa-manifest.json`; `init` is interactive and has no `--yes`. `--skipVersionUpgrade` because CI has already written both version fields, and letting Bubblewrap auto-increment would make the version code depend on how many times the workflow ran.

**`--skipPwaValidation` has a repo-specific reason, not a lazy one.** Bubblewrap's Quality Criteria check evaluates offline support, and `public/sw.js` deliberately precaches nothing (see [`ui.md`](ui.md) and the file's own comment). Validation would fail on a property this app has consciously chosen.

**The step that earns the workflow is `Verify the origin will accept this certificate`.** It reads the SHA-256 out of the APK that was just built and fails the release unless the **live** statement list names that package and that fingerprint. It compares against the deployed route rather than a repo variable because a variable is a second copy that drifts — this one check catches "the Vercel env var was never set", "the key was rotated but the env wasn't" and "Vercel hasn't redeployed yet" identically. All three are otherwise invisible until someone installs the APK on a phone and sees a URL bar. The APK is uploaded as an artifact *before* that check runs, so a failure costs a re-run and not the build, and the message prints the exact string to paste into `ANDROID_CERT_SHA256`. On the very first release it will fail by design, because the fingerprint cannot exist until the keystore does.

## First release — what a human has to do

None of this can live in the repository.

1. **Create the keystore** and store it somewhere it cannot be lost:
   ```bash
   keytool -genkeypair -v -keystore boostmebitch-release.jks \
     -alias boostmebitch -keyalg RSA -keysize 4096 -validity 10000
   ```
   **CAUTION: losing this file means never updating the app again** — not on Zapstore, not anywhere. Zapstore identifies an app by package name *and* signing certificate, so a replacement key is a different app.
2. **Add the repository secrets:** `ANDROID_KEYSTORE_BASE64` (`base64 -w0 boostmebitch-release.jks`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`, and `ZAPSTORE_SIGN_WITH` (an `nsec1…` or a `bunker://…` URL). The key alias is not a secret and lives in `twa-manifest.json`.
   **CAUTION: `ZAPSTORE_SIGN_WITH` becomes the app's publisher identity on Zapstore permanently.** Decide it deliberately; a bunker URL is the safer form.
3. **Print the fingerprint** and set the Vercel production environment:
   ```bash
   keytool -list -v -keystore boostmebitch-release.jks -alias boostmebitch | grep SHA256
   ```
   `ANDROID_PACKAGE_ID=com.boostmebitch.app`, `ANDROID_CERT_SHA256=<that value>`. Redeploy, then confirm the live document with no redirect:
   ```bash
   curl -sI https://www.boostmebitch.com/.well-known/assetlinks.json   # 200, no 30x
   curl -s  https://www.boostmebitch.com/.well-known/assetlinks.json | jq .
   curl -s 'https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://www.boostmebitch.com&relation=delegate_permission/common.handle_all_urls'
   ```
   The last one is Google's own parser and reports a `debugString` on failure.
4. **Capture the screenshots** (`node scripts/shoot-screenshots.mjs`), commit them, and uncomment `images:` in `zapstore.yaml`.
5. **Dry-run zsp** before the first real publish, and read the output as a Zapstore user would:
   ```bash
   zsp publish --check zapstore.yaml
   SIGN_WITH=npub1… zsp publish -y zapstore.yaml    # unsigned events, nothing sent
   zsp apk --extract android/app-release-signed.apk # the permission list zsp will publish
   ```
6. **Tag it:** `git tag v0.1.0 && git push origin v0.1.0`.

Installing the result:

```bash
adb install -r android/app-release-signed.apk
adb logcat | grep -iE 'OriginVerifier|digital asset|CustomTabs'
```

**A URL bar across the top means verification failed. No URL bar means it passed.** That is the whole test. Note that verification is done by **Chrome at runtime**, not by the Android package manager — `adb shell pm get-app-links` is about Android App Links and will mislead you here.

## Risks a TWA has to survive in this app, and none of them are verified yet

Every row below is a real code path that behaves differently inside a TWA than in a browser tab. **None has been exercised on a device.** Fill in the verdicts as they are.

**1. Amber, NIP-55 — the highest-value path for this audience, and the most fragile.** `lib/nostr/amber.ts` navigates same-tab to `nostrsigner:` with **no `callbackUrl`**, so Amber returns the result through the **system clipboard**, read on `visibilitychange`. Two things can break: the custom-scheme navigation may be swallowed without a user gesture, and `navigator.clipboard.readText()` needs a focused document and, on Android 10+, foreground status plus a permission prompt whose behaviour in a TWA is unproven. *Verify:* attach DevTools over `chrome://inspect`, sign in with Amber, then exercise a background signing prompt (toggling a favorite debounce-publishes). Confirm the manual-paste fallback is reachable. *If the clipboard proves unreliable*, NIP-55 also supports `callbackUrl`, which returns into the verified in-scope origin — attractive here specifically. That is a change to `amber.ts` and belongs in [`signers.md`](signers.md) territory, not in a packaging change.

**2. NWC and localStorage.** A verified TWA shares Chrome's storage partition for the origin, which is good (sign in once, in either place) and sharp: Android Settings → Chrome → "Clear storage" wipes the wallet credential and any local nsec with no server copy. Backgrounding also suspends the socket, and CLAUDE.md records that Alby's relay rate-limits connections **opened** — 28 dials in 83 s produced a `429` with `Retry-After: 600` — so a reconnect storm on every foreground is a real hazard. *Verify:* connect, boost, background five minutes, foreground, boost again; watch for a dial storm and for `NwcIndeterminateError` rendering as `?` rather than `✗`. Confirm storage survives a reboot, and that the Nostr/Drive backup path works, since it is the only recovery from a cleared profile.

**3. Google sign-in — most likely of the four to break.** GIS opens a popup and reports back through the opener relationship, which `next.config.mjs`'s `Cross-Origin-Opener-Policy: same-origin-allow-popups` deliberately preserves. In a TWA, `window.open` opens a *new Custom Tab*, and whether the opener relationship survives is not something to assert. Two facts worth not re-deriving: the TWA runs the `https://www.boostmebitch.com` origin, which is already an authorized JavaScript origin, so **no new Google Cloud configuration and no Android OAuth client are needed**; and [`ops.md`](ops.md)'s note that `*.vercel.app` cannot be authorized means preview builds cannot test this. *If it does not report back*, the options are GIS redirect mode or gating the button off in standalone display mode.

**4. Out-of-scope links and non-http schemes.** With `scope: "/"` everything on the origin stays inside the TWA, including the `pay.boostmebitch.com` lnurlp rewrite, which is same-origin. An out-of-scope **https** navigation opens a Custom Tab with a URL bar — acceptable, but visibly different. Non-http schemes (`lightning:`, `nostr:`, `mailto:`) go to Android's intent resolver. Before testing, check which of them `safeUrlAttr`'s allowlist actually renders — a link that never renders cannot be handed to anything. *Verify:* an external https link from a `<NoteCard>`, an npub link, a `lightning:` URI, and a `target="_blank"` link; record which opens what.

**5. Background audio.** Lower risk than it looks — `components/player/use-media-session.ts` already sets `MediaMetadata`, `playbackState` and `setPositionState`, so Android gets lockscreen controls. The open questions are attribution (the app or Chrome), audio focus when backgrounded, and whether streaming sats keeps ticking. The engine's `min(wall-clock delta, playback-position delta)` cap is exactly the guard that stops a suspended tab over-billing. *Verify:* play, lock, 10+ minutes; then check the accrual is plausible and nothing double-charged.

**6. Offline is a blank app.** `sw.js` precaches nothing by design, so with no network the TWA shows Chrome's offline page, and a Vercel outage takes the Android app down entirely. **Do not change `sw.js` in an Android change** — the no-precache decision is documented in the file, in [`ui.md`](ui.md) and in the README, and reopening it here is the wrong forum. *Verify:* airplane mode, cold launch, and write down exactly what the user sees. If it is ever worth fixing, the shape is a navigation-request-only fallback caching **one** static `/offline` document and never a hashed bundle — the hazard that removed precaching was stale *bundles*, not a stale error page.

**7. Cold start.** Every launch is a full network page load; `splashScreenFadeOutDuration` controls the fade, not the wait, so a slow connection looks like a hang on the `#0a0a08` splash.

**8. `X-Frame-Options: DENY` and `frame-ancestors 'none'` do not affect a TWA** — it is a top-level activity, not a frame. Recorded here purely so nobody weakens those headers while debugging a verification failure.
