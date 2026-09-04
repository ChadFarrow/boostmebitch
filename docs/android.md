# Android — the TWA, Digital Asset Links, and Zapstore

Read before touching `app/.well-known/assetlinks.json/route.ts`, `lib/assetlinks.ts`, `android/twa-manifest.json`, `zapstore.yaml`, `.github/workflows/android-release.yml`, or the parts of `public/manifest.json` an Android build consumes.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

## What the Android apps are

A **Trusted Web Activity**: a signed Android shell that opens one origin full-screen with no browser chrome. There is no second copy of the app. A Vercel deploy updates the Android app at the same moment it updates the site.

**There are TWO of them, and they are two apps rather than one app with two names.**

| | Package | Wraps | TWA manifest | Store listing |
|---|---|---|---|---|
| Boost Me Bitch | `com.boostmebitch` | `www.boostmebitch.com` | `android/twa-manifest.json` | **none** — APK on the GitHub release only |
| Boost Me Buddy | `com.boostmebuddy` | `www.boostmebuddy.com` | `android/twa-manifest-buddy.json` | Zapstore |

**A TWA wraps an ORIGIN, so the name is not a label you can swap.** Package id, host and the Digital Asset Links statement move together, and `BRAND` is chosen by the origin the shell opens — so a "Buddy"-named wrapper around `boostmebitch.com` would show the other wordmark in its own header and emit `BoostMeBitch` as `app_name` and `client` on every boost it sent. **Zapstore keys a listing on package id plus signing certificate**, so this is not reversible after a first publish: `com.boostmebitch` cannot later become `com.boostmebuddy`.

**Only the family-friendly brand is listed.** That is a product decision, not a limitation — the other APK is attached to the GitHub release for anyone who wants it. One tag builds both, through a matrix on the release job.

**They share ONE keystore**, which is why `signingKey.alias` reads `boostmebitch` in both manifests. An alias names an entry inside a `.jks` and reaches no user; the differing package ids are what make these separate apps. A shared certificate is normal for one developer's apps, and it means the same `ANDROID_CERT_SHA256` goes into both Vercel projects.

**Why not a bundled native shell.** The app cannot be statically exported. `next.config.mjs` has no `output: 'export'`, `app/page.tsx` reads `searchParams` in `generateMetadata` and so renders dynamically, and thirteen `app/api/*` routes hold the Podcast Index credentials plus every payment-critical lookup — `/api/value-splits`, `/api/keysend`, `/api/lightning/boostbox`, `/api/live-value`. Bundling the assets would still leave every one of those calls pointed at the live origin, so it would buy an offline splash screen and a second build system, and cost the guarantee that the credential never leaves the server.

**Why not Capacitor, given the sibling app uses it.** [`ChadFarrow/stablekraft-app`](https://github.com/ChadFarrow/stablekraft-app) ships to Zapstore as a Capacitor app: `capacitor.config.ts` with `server.url` pointed at the live site, a committed `android/` project, gradle signing from `STABLEKRAFT_KEYSTORE_*` environment variables, and a local `npm run android:release`. It is the working precedent for this repo's `zapstore.yaml` and for the keystore convention below.

The packaging itself is where the two apps diverge, for three reasons specific to this one. A Capacitor app runs an Android **WebView**; a TWA runs **Chrome**.

- **Google blocks OAuth inside embedded WebViews** (`disallowed_useragent`). "Continue with Google" is this app's onboarding for people with no Nostr key, and it would have to be hidden on Android.
- **Amber's NIP-55 round trip already works in Chrome.** `lib/nostr/amber.ts` navigates to `nostrsigner:` and reads the reply off the system clipboard — both are the everyday Android-Chrome path this app is used on today. A WebView needs the bridge to launch the intent and needs its own clipboard permission story.
- **Background audio comes free in Chrome.** StableKraft needed a foreground-service keepalive *and* a native lockscreen MediaSession plugin to get it, which is exactly the work a WebView imposes.

So the TWA costs a Digital Asset Links statement — the whole next section — and saves porting three native subsystems. If this app ever needs a capability Chrome cannot give it, Capacitor is the migration, and StableKraft is the reference for how.

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

**`export const dynamic = 'force-dynamic'` states the property outright, and the rate limit does not.** The route must run per request, or Next may prerender the handler and bake the *build-time* environment into a static asset — after which rotating `ANDROID_CERT_SHA256` in the dashboard changes nothing until the next deploy, silently. That used to be a side effect of the limiter reading `req`, which made a correctness property depend on an unrelated line: tidy the limiter away as pointless on a static JSON document and the route goes static without a word. Declare it instead.

**The rate limit is far looser here than on the two documents beside it, and that is deliberate.** `nostr.json` and `keysend/[name]` run at 120/min; this one runs at 6000. The caller is not a browser — Chrome does not fetch this from the device, verification goes through Google's Digital Asset Links service, so every request arrives from a small shared pool of Google IPs and buckets into **one** `assetlinks:<ip>` key. A 429 there is a third silent way to fail verification, alongside the two this file already guards, and it produces the same URL bar. The limiter stays as abuse damping on an unauthenticated endpoint; it must never be the thing that decides whether the app verifies.

**`Cache-Control` is `no-store`, where the two sibling documents cache for an hour.** They answer a question whose answer is stable. This one is the live statement of which certificate may speak for this origin, so an hour of downstream caching works directly against the rotation the environment-driven design buys — a **removed** fingerprint keeps verifying, and a newly **added** one may not. The release workflow curls this same document to decide whether an APK is safe to publish, so a cached copy can also fail a correct rotation or pass a stale one.

**Validation happens on the way out**, in `lib/assetlinks.ts`, the same fail-closed discipline `app/.well-known/keysend` already follows: a malformed package id or a fingerprint that is not exactly 32 bytes of hex produces **no statement**, never a guess. One bad entry among several is dropped on its own rather than failing the list, because mid-rotation that list is edited by hand and losing verification for the key that *is* valid is the worse outcome.

`normalizeFingerprint` deliberately accepts **bare hex as well as the colon form**. `keytool -list -v` prints uppercase colon-separated; `apksigner verify --print-certs` prints bare lowercase. Both are unambiguous 32-byte values and both are what a human actually has in hand — and the cost of rejecting one is the worst kind of failure this file can produce: the variable is set, the served document is empty, and nothing anywhere says why.

`npm run check:assetlinks` pins all of it. What it cannot pin is whether Chrome accepts the result — only a phone can do that.

## `twa-manifest.json`, field by field where it is not obvious

Bubblewrap regenerates the entire Gradle project from this file on every `update` and overwrites manual edits, which is exactly the property that lets one JSON file be the only thing in git. Everything else under `android/` is ignored.

- **`packageId: com.boostmebitch` is permanent.** Zapstore keys an app on package name plus signing certificate; changing it later is a brand-new app with no upgrade path for anyone who installed the old one, and the listing starts from zero. It is the domain reversed, which is the same rule that gave the sibling app `app.stablekraft` for `stablekraft.app` — no extra segment naming today's packaging choice, since the id has to outlive it.
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
2. The Android `appVersion` / `appVersionCode`, written by CI from the git tag: `v1.2.3` → `1.2.3` and `1002003`. Derived from the tag rather than `github.run_number` so a plain re-run of a release produces the same number.

   **Each component gets a THOUSAND-wide block, and the tag regex refuses a component of 1000 or more.** The first shape was `major*10000 + minor*100 + patch`, which collides as soon as a component reaches 100: `v0.1.100` and `v0.2.0` both produce `200`, and `v1.0.100` collides with `v1.1.0`. Android refuses to install an update whose `versionCode` is not **strictly greater** than the installed one, and Zapstore keys releases on it, so the second of a colliding pair can never ship as an upgrade to the first — with nothing saying why beyond a failed install. The upper bound is real too: `versionCode` is a signed 32-bit value capped at 2100000000, so a component is refused rather than silently wrapped.
3. `app_version: '0.1.0'`, hard-coded at six boostagram TLV call sites (`components/boost-modal/index.tsx`, `components/boost-all-modal.tsx` ×3, `lib/v4v/streaming.ts`).

**Unifying them is a separate change.** Six of those call sites are on the money path, and an Android packaging change is the wrong place to touch them. A single `APP_VERSION` in `lib/util.ts` would be the shape — that file is import-free enough to stay pinnable — but it needs its own review.

`zapstore.yaml` deliberately carries **no** `min_allowed_version_code`. That field means "installs below this are out of date", and bumping it every release marks every older install stale for cosmetic changes. Set it only for a genuinely mandatory release — a money-path or credential fix.

## The release path

`.github/workflows/android-release.yml`, on a `v*` tag. `workflow_dispatch` builds, signs and verifies without publishing, so the whole path can be walked before any tag or Zapstore identity exists.

**Both publishing steps read one output, `steps.version.outputs.publish`, and nothing else.** They used to test `startsWith(github.ref, 'refs/tags/')` on their own, which is also true of a `workflow_dispatch` **launched against a tag ref** — so a run with the `publish` toggle left off, whose own description reads "off = build and verify only", published to Zapstore anyway. The version step compounded it by branching on `github.event_name` instead of the ref, so that same run shipped the version the *committed* manifest carried rather than the tag's. One decision, computed once from the ref and the toggle together, is what stops the two halves disagreeing. `publish` requested on a non-tag ref **fails the run** rather than being skipped: a silent refusal there reads as a broken workflow, since the run goes green and nothing on screen says why nothing shipped.

**`bubblewrap updateConfig` is not the non-interactive step it looks like.** A fresh runner has no `~/.bubblewrap/config.json`, so the CLI enters its first-run setup *before* it considers `--jdkPath` or `--androidSdkPath`, and asks whether it should download its own JDK. With no TTY that exits **130** about twelve seconds in, and the log ends on a half-drawn prompt rather than an error — it reads like somebody cancelled the job. That was the first run this workflow ever had (32486514158). CI therefore **writes the two-field config file itself**, in its own step before the build, which is exactly what `updateConfig` would have written. Every Bubblewrap subcommand also reads stdin from `/dev/null`: a prompt against a TTY-less but still-*open* stdin hangs the job to the six-hour limit, where a closed one fails in seconds with the question visible.

**`bubblewrap update`, not `init`.** `update` regenerates the project from `twa-manifest.json`; `init` is interactive and has no `--yes`. `--skipVersionUpgrade` because CI has already written both version fields, and letting Bubblewrap auto-increment would make the version code depend on how many times the workflow ran.

**`--skipPwaValidation` has a repo-specific reason, not a lazy one.** Bubblewrap's Quality Criteria check evaluates offline support, and `public/sw.js` deliberately precaches nothing (see [`ui.md`](ui.md) and the file's own comment). Validation would fail on a property this app has consciously chosen.

**`zsp` runs on EVERY run, keyless, against the APK that was just built — and that step exists because the publish step shipped with a flag zsp does not have.** `zsp publish -y zapstore.yaml` was the published form, in this file and in the workflow, and zsp v0.4.9 rejects it: `flag provided but not defined: -y`. Nothing before a real tag push would ever have executed it, so the first tag would have built, verified, created the GitHub release, and failed on the last step — with the release half-published. The CI form is `--quiet` (no prompts, no spinners, auto-confirm); `-y` was never a zsp flag. The dry-run step is runbook step 5 moved into CI: `zsp publish --check zapstore.yaml` validates the config and proves `release_source` is a parseable APK, then `SIGN_WITH=<the npub zapstore.yaml declares> zsp publish --quiet --offline zapstore.yaml` builds the three events unsigned to stdout — every image path, the CHANGELOG section for this version, the icon download and zsp's own pubkey-mismatch check, none of which `--check` reaches. An `npub` in `SIGN_WITH` cannot sign, and `--offline` uploads and publishes nothing, so the step needs no secret and sends nothing.

**WHO publishes to Zapstore is DECLARED by the repository variable `ZAPSTORE_PUBLISH_MODE`, and it defaults to `local`.** `local` means CI stops after the GitHub release and prints the zsp commands in the run summary; a human runs them with `SIGN_WITH=browser`, so the publishing key never enters GitHub. `ci` means the workflow publishes and `ZAPSTORE_SIGN_WITH` must hold the key — and a tag in that mode with the secret missing **fails early**, before the keystore is materialized and before `gh release create` runs.

**The reason it is a declared mode and not a test of whether the secret exists** is worth keeping, because the obvious version shipped in this file first. That version failed any tag with no `ZAPSTORE_SIGN_WITH`, arguing from CLAUDE.md's *a guard that silently withholds must say so* — a green run that created the GitHub release and left Zapstore empty. The rule was right and the test was wrong: under `local`, an absent secret is the **normal** state, so the guard fired on every tag this repository ever intends to push. Keying it on the mode keeps the loud failure where it belongs and turns `local` into an announcement rather than a silence.

**`zsp` is pinned at `v0.4.17`, and the bump off `v0.4.9` was forced by one thing: `v0.4.9` cannot read a Java keystore.** `internal/identity/x509.go` returns `ErrJKSFormat` the moment it sees the JKS magic bytes, so `zsp identity --link-key <the release .jks>` — step 7 below, the only way to prove the signing certificate belongs to the publishing npub — could not run at all at the version this workflow pinned. `v0.4.17` loads a JKS directly and adds `--key-alias` for it.

Three things were read out of `v0.4.17`'s source before the bump, because the dry-run step depends on all of them: `--quiet`, `--offline` and `--check` are still defined in `internal/cli/options.go`; `outputOffline` still writes one JSON event per line to stdout; and `internal/config/config.go` is purely additive since `v0.4.9`, so `zapstore.yaml` still parses. Two behaviours changed and neither reaches us — `metadata_sources` now prefers Fastlane metadata on a GitHub repository, which `zapstore.yaml` overrides by naming `github` explicitly, and images are now compressed on upload (icon ≤512px, screenshots ≤1440px wide). Ours are 512×512 and 824×1830, so nothing downscales and `--no-compress` is not needed.

**A further bump is a decision, not housekeeping:** run the workflow by `workflow_dispatch` with the new pin and read the dry-run step's output before a tag depends on it.

**The step that earns the workflow is `Verify the origin will accept this certificate`.** It reads the SHA-256 out of the APK that was just built and fails the release unless the **live** statement list names that package and that fingerprint. It compares against the deployed route rather than a repo variable because a variable is a second copy that drifts — this one check catches "the Vercel env var was never set", "the key was rotated but the env wasn't" and "Vercel hasn't redeployed yet" identically. All three are otherwise invisible until someone installs the APK on a phone and sees a URL bar. The APK is uploaded as an artifact *before* that check runs, so a failure costs a re-run and not the build, and the message prints the exact string to paste into `ANDROID_CERT_SHA256`. On the very first release it will fail by design, because the fingerprint cannot exist until the keystore does.

## First release — what a human has to do

None of this can live in the repository.

1. **Create the keystore** and store it somewhere it cannot be lost:
   ```bash
   keytool -genkeypair -v -keystore boostmebitch-release.jks \
     -alias boostmebitch -keyalg RSA -keysize 4096 -validity 10000
   ```
   **CAUTION: losing this file means never updating the app again** — not on Zapstore, not anywhere. Zapstore identifies an app by package name *and* signing certificate, so a replacement key is a different app.
2. **Add the repository secrets:** `ANDROID_KEYSTORE_BASE64` (`base64 -w0 boostmebitch-release.jks`), `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_PASSWORD`. The key alias is not a secret and lives in `twa-manifest.json`.
   **`ZAPSTORE_SIGN_WITH` is deliberately NOT in that list.** This repository publishes to Zapstore in mode `local` (see below), so the publishing key never enters GitHub at all.
   **CAUTION: whichever key first publishes becomes the app's publisher identity on Zapstore permanently.** It is not a fresh decision — `zapstore.yaml` declares `pubkey: npub177fz…`, the same publisher StableKraft uses, so both apps sit under one identity. Because the pubkey is declared in the file, a mismatched signing key is caught rather than quietly publishing under a second identity.
2.5. **Set the Vercel production environment on BOTH projects — they share nothing.** Each origin vouches for its own package, and `lib/assetlinks.ts` grants exactly one package id per origin. The certificate is the same because the keystore is:

   | Vercel project | `ANDROID_PACKAGE_ID` | `ANDROID_CERT_SHA256` |
   |---|---|---|
   | boostmebitch | `com.boostmebitch` | the fingerprint from step 3 |
   | boostmebuddy | `com.boostmebuddy` | the same fingerprint |

   **An unset value yields `[]`, never a guess** — a well-formed "no app is authorized" answer. That is the correct fail-closed behaviour and it is also exactly what a forgotten variable looks like, so the workflow's origin check is what tells the two apart. A buddy leg that fails at `Verify the origin will accept this certificate` with a live statement list of `[]` means this step was skipped for that project.

3. **Print the fingerprint** and set the Vercel production environment:
   ```bash
   keytool -list -v -keystore boostmebitch-release.jks -alias boostmebitch | grep SHA256
   ```
   `ANDROID_PACKAGE_ID=com.boostmebitch`, `ANDROID_CERT_SHA256=<that value>`. Redeploy, then confirm the live document with no redirect:
   ```bash
   curl -sI https://www.boostmebitch.com/.well-known/assetlinks.json   # 200, no 30x
   curl -s  https://www.boostmebitch.com/.well-known/assetlinks.json | jq .
   curl -s 'https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://www.boostmebitch.com&relation=delegate_permission/common.handle_all_urls'
   ```
   The last one is Google's own parser and reports a `debugString` on failure.
4. **Re-capture the screenshots if the UI has moved** (`node scripts/shoot-screenshots.mjs`) and commit them. `images:` in `zapstore.yaml` already names the three paths, so a renamed or missing file fails the publish rather than dropping an image — re-shoot and re-commit together. Use `--manual` when a shot needs a specific show; the boost modal in particular shows whatever wallet state the test browser is in.
5. **Dry-run zsp** before the first real publish, and read the output as a Zapstore user would. CI now runs the first two on every workflow run (see "The release path"), so a `workflow_dispatch` on `main` is the same check without a local Go toolchain:
   ```bash
   zsp publish --check zapstore.yaml
   SIGN_WITH=npub1… zsp publish --quiet --offline zapstore.yaml   # unsigned events to stdout, nothing sent
   zsp apk --extract android/app-release-signed.apk               # the permission list zsp will publish
   ```
   `--quiet` is the CI mode. **`-y` is not a zsp flag at any version** and zsp rejects it; this runbook and the workflow both carried it until 2026-09-04.
6. **Tag it:** `git tag v0.1.0 && git push origin v0.1.0`. Push the tag from `main` only, and `concurrency` never cancels the run. Under the default mode `local` that run builds, signs, verifies the origin, dry-runs zsp and creates the **GitHub** release — then stops, and prints the commands below in its summary. Nothing reaches Zapstore until a human runs them.
6.5. **Publish BOOST ME BUDDY to Zapstore, from the machine that holds the keystore.** `SIGN_WITH=browser` starts a local NIP-07 signer and opens a browser to sign each event, which is how the sibling app releases and why no key is in GitHub:
   ```bash
   curl -fL -o ~/bin/zsp https://github.com/zapstore/zsp/releases/download/v0.4.17/zsp-0.4.17-linux-amd64
   chmod +x ~/bin/zsp                                    # no Go toolchain needed
   gh release download v0.1.0 -p 'app-release-signed-buddy.apk' \
     -O android/app-release-signed-buddy.apk --clobber
   SIGN_WITH=browser zsp publish zapstore-buddy.yaml
   ```
   Do **not** pass `--quiet` here: it auto-confirms, which is the opposite of what a browser signer is for.

   **CAUTION: download the BUDDY asset, and check the filename.** `zapstore-buddy.yaml` names `./android/app-release-signed-buddy.apk` as its `release_source`, and **nothing in a zsp config declares a package id** — so pointing it at the other APK publishes `com.boostmebitch` under the Boost Me Buddy name, permanently. The two configs name different paths for exactly this reason. `zsp publish --check zapstore-buddy.yaml` prints the package id it found; read it before publishing.

   **`com.boostmebitch` is deliberately not published anywhere.** Its APK is on the GitHub release for people who want it, and that is the whole distribution.
7. **Link the signing certificate to the publisher identity, once, by hand.** zsp checks the relays for a kind 30509 identity proof before publishing and, in `--quiet` mode, treats a missing one as a warning rather than a prompt — so the first CI publish goes out unlinked, and Zapstore cannot show that the key that signed the APK belongs to the npub that published it. The proof needs the keystore, which CI deliberately deletes, so this is a local step:
   ```bash
   SIGN_WITH=browser zsp identity --link-key ~/keystores/boostmebitch-release.jks \
     --key-alias boostmebitch                                 # default expiry 1y
   zsp identity --verify android/app-release-signed.apk
   ```
   Under mode `local` this is no longer an easily-forgotten follow-up: it runs in the same session as step 6.5, on the same machine, with the keystore already in reach.
   **CAUTION: this step needs `v0.4.17` or later, and the workflow pinned `v0.4.9` until 2026-09-04.** At `v0.4.9` a `.jks` is rejected on its magic bytes before anything reads it, so the command above could not run at all — converting the keystore to PKCS12 was the only route. `--key-alias` names the private-key entry (ours is `boostmebitch`, from `twa-manifest.json`); zsp needs it only when a keystore holds more than one, and passing it costs nothing. The proof expires after one year by default, so it recurs.
8. **Confirm it landed** from the relay rather than from the run log — a green publish step proves zsp exited 0, not that `relay.zapstore.dev` holds the events. Query kind `32267` with `#d = ["com.boostmebitch"]` and kind `30063` referencing it (`nak req -k 32267 -d com.boostmebitch wss://relay.zapstore.dev`), or open the listing at zapstore.dev.

## Where the first release stands — 2026-09-04

Recorded so the next session does not re-derive it. Every row is a measured fact, not a reading of the code.

| Done | Evidence |
|---|---|
| The workflow builds and signs the APK | Run 3 (`32547100056`, 2026-08-22, `main`): every step green through `Verify the origin will accept this certificate` |
| The keystore secrets and the Vercel statement are set | Same run: the verify step compared the built certificate against the live statement and passed |
| Google's parser accepts the statement | `digitalassetlinks.googleapis.com/v1/statements:list` returns one statement for `com.boostmebitch` |
| The installed TWA works on a device | Pixel 6, 2026-08-21 and 2026-09-03 — Amber sign-in through the callback, "Restore from Nostr" over the clipboard (see [`signers.md`](signers.md)) |
| **The device is GrapheneOS with NO Chrome, and the TWA verifies anyway** | Pixel 6, Android 17, build `2026081301`, 2026-09-04. Installed browsers are Vanadium, Brave, Firefox and Tor; `com.android.chrome` is absent and no default browser is set. The TWA binds to **`com.brave.browser/…CustomTabActivity`** and renders with **no URL bar**, so Digital Asset Links verification works on a non-Chrome Chromium. Every device verdict in this file was measured on that phone — read them as "GrapheneOS + Brave", not "stock Chrome" |
| **A background favorites publish reaches the relays, and loses nothing** | 2026-09-04, against a list with 449 `i` tags. Add: 0 tags removed, 1 added, all 455 preserved in order. Remove: restored byte-identical to the baseline. Full method in "Risks a TWA has to survive", row 1 |
| The screenshots are current | Re-shot 2026-09-04 against production, 824×1830, matching `public/manifest.json`'s declared `sizes`. The previous set was `ba85d4d`, **2026-08-20** — not 2026-08-29 (#269), which is a playlists PR that never touched them — with 183 commits behind it |
| **zsp reaches the events, at the pinned version** | Run `33904270967` (2026-09-04, the PR branch): `zsp publish --check` printed `{"package_id":"com.boostmebitch"}`, and `--quiet --offline` built **3 unsigned events** for `npub177fz…` at `v0.4.17` — the 32267, 30063 and 3063 — with nothing uploaded. So the config parses, every image path resolves, the CHANGELOG has a `0.1.0` section, the icon downloads and the declared pubkey passes zsp's mismatch check |
| **Both apps build, and each verifies against its OWN origin** | Run `33909534869` (2026-09-04): `www.boostmebitch.com vouches for com.boostmebitch` and `www.boostmebuddy.com vouches for com.boostmebuddy`, both with the shared certificate. Each leg's `zsp publish --check` reported its own package — `{"package_id":"com.boostmebuddy"}` for `zapstore-buddy.yaml` — which is what proves the two configs cannot read each other's APK. 3 unsigned events per leg, nothing uploaded |
| Google's parser accepts the buddy statement too | `digitalassetlinks.googleapis.com/v1/statements:list` returns one statement for `com.boostmebuddy` |
| The buddy Vercel variables are set | The first matrix run (`33908628722`) failed the buddy leg on a live statement list of `[]`; after setting both variables **and redeploying**, the statement went live in about 30 s. Vercel bakes env into a deployment, so setting a variable alone changes nothing |
| **BOOST ME BUDDY IS PUBLISHED ON ZAPSTORE** | 2026-09-04. kind 32267 `63b61a4d688b03c2` on `relay.zapstore.dev`, `d=com.boostmebuddy`, name `Boost Me Buddy`, url `https://www.boostmebuddy.com`, 3 images uploaded, signed by `npub177fz…`. Published locally with `SIGN_WITH=browser` from the v0.1.0 release asset; the 30063 release and 3063 file-metadata events are on the relay beside it. Read back from the relay, not from zsp's exit code |
| `com.boostmebitch` is deliberately NOT on Zapstore | A kind 32267 query for `d=com.boostmebitch` returns **0**. Its APK is on the v0.1.0 GitHub release and that is the whole distribution |
| The v0.1.0 release carries BOTH APKs | `app-release-signed.apk` and `app-release-signed-buddy.apk`, different SHA-256, both 946,350 bytes. Run `33910218812` |
| The guard skips a build-only run | Same run: `Refuse a publish run with no Zapstore identity` is `skipped`, `publish=false`. It must never block a `workflow_dispatch` on a branch, and it does not |

| Not done | Evidence |
|---|---|
| No tag, no GitHub release, no Zapstore listing | `git tag` is empty; the releases list is empty; a kind 32267 query for `com.boostmebitch` on `relay.zapstore.dev` returns nothing |
| The publish step has never executed | Runs 2, 3 and `33904270967` all skipped it (`publish=false`); it carried `-y` until 2026-09-04 and would have failed. Everything up to it is now exercised, so the only unrun code on a tag is `zsp publish --quiet` itself and the `gh release` step above it |
| **The signing certificate is NOT linked to the publisher identity** | Runbook step 7. zsp treats a missing kind 30509 proof as a warning in quiet mode, so the first publish went out unlinked — Zapstore cannot show that the key which signed the APK belongs to the npub that published it. It needs `~/keystores/boostmebitch-release.jks`, which is not on the machine that published. Do it from wherever the keystore lives |
| The buddy TWA has never run on a device | Every device verdict in this file was measured on the `com.boostmebitch` build |
| Shot 02's episode thumbnails are blank | Not the capture — the app. Those covers are 9 MB animated GIFs (`episode-149.gif` is 9,055,375 bytes), `/api/art` **502s** on them at every width in `ART_WIDTHS`, and `<PodcastCover>`'s ladder falls through to the raw URL, which never finishes painting. Belongs to [`ui.md`](ui.md), not to this release |
| Rows 2–7 below have no verdict | No device session has covered NWC after backgrounding, Google sign-in, out-of-scope links, background audio, offline, or cold start |
| The MUTES half is still unmeasured | Favorites are now measured (above). The kind:10000 private half is not: it is deliberately left unread on load under Amber, so its publish path has never been driven on a device |
| Every device verdict rests on ONE phone, and it is not a typical one | GrapheneOS, no Chrome, no Google Play services. Stock Android with Chrome as the TWA provider is untested, and it is what most Zapstore users will install onto |

### Releasing locally instead

CI is the normal path, but the sibling app releases by hand and the same shape works here. The npm scripts are the same commands CI runs, so a local build cannot silently differ from a published one.

Keep the keystore and its passwords outside the repo, the way StableKraft does — `~/keystores/boostmebitch-release.jks` and `~/.boostmebitch-android.env`, neither ever committed:

```bash
# ~/.boostmebitch-android.env
export BUBBLEWRAP_KEYSTORE_PASSWORD=…
export BUBBLEWRAP_KEY_PASSWORD=…
```

```bash
source ~/.boostmebitch-android.env
ln -sf ~/keystores/boostmebitch-release.jks android/android.keystore   # android/* is gitignored
npm run android:config      # points Bubblewrap at your JDK and Android SDK
npm run android:update      # regenerate the project from twa-manifest.json
npm run android:release     # signed APK at android/app-release-signed.apk
```

Bump `appVersion` and `appVersionCode` in `android/twa-manifest.json` by hand first — CI does that from the tag, and nothing does it for you here.

Installing the result:

```bash
adb install -r android/app-release-signed.apk
adb logcat | grep -iE 'OriginVerifier|digital asset|CustomTabs'
```

**A URL bar across the top means verification failed. No URL bar means it passed.** That is the whole test. Note that verification is done by **Chrome at runtime**, not by the Android package manager — `adb shell pm get-app-links` is about Android App Links and will mislead you here.

## Risks a TWA has to survive in this app, and most are still unverified

Every row below is a real code path that behaves differently inside a TWA than in a browser tab. **Row 1 has now been exercised on a device, in a browser; the rest have not, and row 1's TWA half has not either.** Fill in the verdicts as they are, and say which half was tested — "Amber works" would be a false summary of row 1.

**1. Amber, NIP-55 — VERDICT: works in the TWA, for requests the user initiates.** `lib/nostr/amber.ts` used to navigate same-tab to `nostrsigner:` with **no `callbackUrl`** and read the result off the system clipboard on `visibilitychange`. That return path does not exist on this phone: approving in Amber lands the user on the launcher, in an ordinary Brave tab as much as in the TWA. Sign-in now goes out WITH a `callbackUrl` and returns through `/amber-callback`; measured working against a real https origin. The wire facts, the two clocks, and the four things still not covered are in [`signers.md`](signers.md) — read that before touching any of it, because the callback URL's exact bytes are load-bearing and two earlier attempts got them wrong.

*Superseded advice, kept because it is what this row used to say:* "If the clipboard proves unreliable, NIP-55 also supports `callbackUrl`, which returns into the verified in-scope origin — attractive here specifically." That was written before the device test and reads as a small swap. It is not: `signers.md` calls `callbackUrl` a trap **as a blanket switch**, and only `get_public_key` uses it. Every other request still returns by clipboard.

*Exercised in the installed TWA, 2026-08-21:* Amber sign-in completes through the callback, and **"Restore from Nostr" — a `nip44_decrypt` on the clipboard path — completes too, and the wallet restored.** So `navigator.clipboard.readText()` does work in a Trusted Web Activity, which this row previously listed as unproven. `scope: "/"` already covers `/amber-callback`, so no manifest change was needed.

*What that does NOT prove.* The clipboard path works because the user pressed a button and came back to tap — which is the gesture `invokeAmber` listens for. A request nobody initiated has nobody to come back, so **background publishes were the remaining risk**: favorites and mutes debounce-publish a `sign_event` unprompted.

**MEASURED 2026-09-04, and the answer is that a favorites publish is NOT unprompted — it RAISES AMBER.** Driven over CDP against the installed TWA, on a list with real history (57 shows, 230 episodes, 449 `i` tags). Favoriting one show logged `[amber] → sign_event (clipboard)`, brought `com.greenart7c3.nostrsigner/.SignerActivity` to the foreground with *"Wants you to sign a PC 2.0 Favorites"*, and published only after Accept. Un-favoriting did the same, **debounced** — Amber came up about five seconds after the toggle, not on the tap.

So the failure this row feared does not happen, and the reason is worth keeping: nothing here is unattended. `sign_event` is a full app switch every time. That is safe for the data and expensive for the user — a session of favoriting is a session of app switches, and it is the argument for the NIP-46 path rather than a defect in this one.

**What the publish did to the shared event, which is the part that matters.** Read from the relays before and after, not from the app:

| | Event | Tags | Removed | Added |
|---|---|---|---|---|
| Before | `af53b60f570c…` | 455 | — | — |
| After favoriting | `4e7202801617…` | 456 | **0** | 1 — `["i","podcast:guid:78864041-…"]` |
| After un-favoriting | `b8cbff62d182…` | 455 | 1 (the same one) | 0 |

All 455 baseline tags survived the add **in order, as a subsequence**, and the restored event is **byte-identical** to the baseline — same tags, same order, same empty `content`. The merge carries what it did not write, and `visibility`, `alt`, `medium` and `k` all came through untouched.

*Two things observed on the way, neither a defect.* The mute list logged `[mutes] private mute list left unread — not spending a signer prompt here — the local cache still filters`, and said so on screen in a banner: the visible-guard rule working, and the reason `unattendedDecryptOk()` excludes Amber. And **`relay.damus.io` refused every WebSocket from this device**, with `relay.fountain.fm` answering `CLOSED` — the publish still landed on `relay.primal.net` and `nos.lol`. Two of four default relays unreachable is the normal case this design already assumes, not an outage worth chasing.

**2. NWC and localStorage.** A verified TWA shares Chrome's storage partition for the origin, which is good (sign in once, in either place) and sharp: Android Settings → Chrome → "Clear storage" wipes the wallet credential and any local nsec with no server copy. Backgrounding also suspends the socket, and CLAUDE.md records that Alby's relay rate-limits connections **opened** — 28 dials in 83 s produced a `429` with `Retry-After: 600` — so a reconnect storm on every foreground is a real hazard. *Verify:* connect, boost, background five minutes, foreground, boost again; watch for a dial storm and for `NwcIndeterminateError` rendering as `?` rather than `✗`. Confirm storage survives a reboot, and that the Nostr/Drive backup path works, since it is the only recovery from a cleared profile.

**3. Google sign-in — most likely of the four to break.** GIS opens a popup and reports back through the opener relationship, which `next.config.mjs`'s `Cross-Origin-Opener-Policy: same-origin-allow-popups` deliberately preserves. In a TWA, `window.open` opens a *new Custom Tab*, and whether the opener relationship survives is not something to assert. Two facts worth not re-deriving: the TWA runs the `https://www.boostmebitch.com` origin, which is already an authorized JavaScript origin, so **no new Google Cloud configuration and no Android OAuth client are needed**; and [`ops.md`](ops.md)'s note that `*.vercel.app` cannot be authorized means preview builds cannot test this. *If it does not report back*, the options are GIS redirect mode or gating the button off in standalone display mode.

**4. Out-of-scope links and non-http schemes.** With `scope: "/"` everything on the origin stays inside the TWA, including the `pay.boostmebitch.com` lnurlp rewrite, which is same-origin. An out-of-scope **https** navigation opens a Custom Tab with a URL bar — acceptable, but visibly different. Non-http schemes (`lightning:`, `nostr:`, `mailto:`) go to Android's intent resolver. Before testing, check which of them `safeUrlAttr`'s allowlist actually renders — a link that never renders cannot be handed to anything. *Verify:* an external https link from a `<NoteCard>`, an npub link, a `lightning:` URI, and a `target="_blank"` link; record which opens what.

**5. Background audio.** Lower risk than it looks — `components/player/use-media-session.ts` already sets `MediaMetadata`, `playbackState` and `setPositionState`, so Android gets lockscreen controls. The open questions are attribution (the app or Chrome), audio focus when backgrounded, and whether streaming sats keeps ticking. The engine's `min(wall-clock delta, playback-position delta)` cap is exactly the guard that stops a suspended tab over-billing. *Verify:* play, lock, 10+ minutes; then check the accrual is plausible and nothing double-charged.

**6. Offline is a blank app.** `sw.js` precaches nothing by design, so with no network the TWA shows Chrome's offline page, and a Vercel outage takes the Android app down entirely. **Do not change `sw.js` in an Android change** — the no-precache decision is documented in the file, in [`ui.md`](ui.md) and in the README, and reopening it here is the wrong forum. *Verify:* airplane mode, cold launch, and write down exactly what the user sees. If it is ever worth fixing, the shape is a navigation-request-only fallback caching **one** static `/offline` document and never a hashed bundle — the hazard that removed precaching was stale *bundles*, not a stale error page.

**7. Cold start.** Every launch is a full network page load; `splashScreenFadeOutDuration` controls the fade, not the wait, so a slow connection looks like a hang on the `#0a0a08` splash.

**8. `X-Frame-Options: DENY` and `frame-ancestors 'none'` do not affect a TWA** — it is a top-level activity, not a frame. Recorded here purely so nobody weakens those headers while debugging a verification failure.
