# iOS — the Capacitor app (Boost Me Buddy)

Read before touching `capacitor.config.json`, `ios/`, `ios-web/` or `lib/native/`.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the plan and the reasoning. **Status: test build only.** Nothing here ships to the App Store yet.

## Why an iOS app at all

The PWA is the app on desktop, and the TWA is the app on Android ([`android.md`](android.md)). On iOS the installed PWA has two playback faults that no web code can fix:

1. **A paused episode drops off the lock screen after a while.** iOS suspends the web app's process, releases its audio session, and removes the Now Playing entry.
2. **Tapping the Dynamic Island opens the wrong web app.** Every home-screen PWA runs inside WebKit's web-app container, so iOS cannot connect the audio to *this* PWA and opens whichever one it finds first.

A native app has its own bundle id (`com.boostmebuddy.app`) and its own audio session, which is what both faults need.

## Why Capacitor, and why it loads the live origin

**One codebase is the requirement.** The web app keeps being developed exactly as it is; iOS is a shell around it, like the TWA is on Android. Expo/React Native and SwiftUI were both rejected because they mean writing the UI a second time.

**The shell loads `https://www.boostmebuddy.com` (`server.url`), not a bundled export.** `android.md` ("Why not a bundled native shell") already records why: the app cannot be statically exported, and thirteen `app/api/*` routes — the Podcast Index credentials and every payment-critical lookup — have to stay on the server. So the iOS app updates when Vercel deploys, the same as the TWA. `ios-web/index.html` is only the placeholder `webDir` the Capacitor CLI requires; nothing loads it.

**`www`, because the apex 307-redirects** ([`ops.md`](ops.md)). Pointing the shell at the apex costs a redirect on every cold start.

**Buddy only.** App Store review rejects profanity in an app name, so the iOS app is the family-friendly brand, the same decision Zapstore already made.

**What the WebView costs, from `android.md`'s Capacitor list:**
- **Google sign-in will not work inside WKWebView** (`disallowed_useragent`). Hide "Continue with Google" in the native app, or open it in `ASWebAuthenticationSession`.
- **Amber does not exist on iOS.** The native app signs with NIP-46 bunkers and the local key only. Hide the Amber and NIP-07 paths behind `isNativeIos()`.
- **Payments are NWC only.** No Spark, no WebLN. NWC needs no change: it is a WebSocket from the page.

## Stage 1 — the shell (on this branch, ready to run)

What it is: `@capacitor/ios` 8, `capacitor.config.json`, the generated Xcode project in `ios/` (Swift Package Manager, no CocoaPods), and two native edits:

- `ios/App/App/Info.plist` — `UIBackgroundModes: [audio]`.
- `ios/App/App/AppDelegate.swift` — `AVAudioSession` category `.playback`, policy `.longFormAudio`, at launch.

The web player is unchanged: its `<audio>` element and `navigator.mediaSession` (`components/player/use-media-session.ts`) run inside WKWebView.

**What Stage 1 is expected to fix:** fault 2 (the Dynamic Island), because the audio now belongs to a real bundle id. **What it might fix:** fault 1. WebKit owns the Now Playing entry for an `<audio>` element, and whether it keeps that entry on pause once the app is suspended is the question this stage exists to answer by measurement.

### Run it on a phone (Mac Mini)

1. Install Xcode from the App Store and open it once.
2. `git checkout ios-capacitor-shell && npm install`
3. `npm run ios:sync && npm run ios:open`
4. Xcode → target **App** → **Signing & Capabilities** → **Team**: your Apple ID (Personal Team). Leave the bundle id as `com.boostmebuddy.app`; if Xcode says it is taken, change it to something unique for testing only.
5. iPhone: **Settings → Privacy & Security → Developer Mode** on (the phone restarts).
6. Connect by cable, select the phone, **Run**.
7. First launch: **Settings → General → VPN & Device Management** → trust the certificate.
8. Xcode's console (or Console.app, filter `audio-session`) must show `[audio-session] category set: playback / longFormAudio`. A `setCategory failed` line means background audio cannot work, so the test below measures nothing.

A free Personal Team build expires after 7 days; run it again from Xcode. TestFlight needs the paid program.

### The test

1. Play a podcast episode. Lock the phone. Confirm it keeps playing for 5 minutes.
2. Pause from the lock screen. Leave the phone locked for **30 minutes**.
3. Wake it. **Pass:** the entry is still there and ▶ resumes playback.
4. With another PWA installed and opened earlier, tap the Dynamic Island. **Pass:** it opens Boost Me Buddy.
5. Turn on streaming sats with a small budget. Play 30 minutes locked. **Pass:** settlements kept arriving (`bmb:streamed:<npub>`, or the wallet's history). The streaming timer is JS; iOS may throttle a WKWebView in the background even while audio plays.

If 1–5 pass, Stage 2 is not needed.

## Stage 2 — the native audio plugin (scaffold on this branch, NOT wired)

If step 3 or step 5 fails, the `<audio>` element moves to native `AVPlayer`.

- `ios/App/App/NativeAudioPlugin.swift` — `AVPlayer`, `MPNowPlayingInfoCenter`, `MPRemoteCommandCenter`. Registered by `MainViewController` (same file), which `SceneDelegate` uses instead of a bare `CAPBridgeViewController`. **It is compiled into the Stage 1 build but nothing calls it.**
- `lib/native/native-audio.ts` — the typed JS side. Nothing imports it.

**The two rules that fix fault 1**, both in the Swift file: pausing never calls `AVAudioSession.setActive(false)`, and never clears `nowPlayingInfo` — it sets the rate to 0 and writes the elapsed time. Only `stop()` (the player closed) removes the entry.

**Remote commands act natively first, then tell JS.** iOS can wake a suspended app for ▶, but the WebView's JS may not run in time, so play/pause/seek/skip must not wait for it. Next/previous go to JS only, because the queue lives there.

**Wiring it is a player change, so read [`ui.md`](ui.md) first** ("Players", "The lock screen is the third surface", "The lock-screen buttons", "An element that lost its buffer is put back"). The shape: on `isNativeIos()`, `<Player>` sends `loadTrack`/`play`/`pause`/`seek`/`setRate` to the plugin instead of the element, and drives `setPosition`/`setDuration`/`onEnded` from the plugin's `timeupdate`/`loaded`/`ended` events. **The streaming ledger's elapsed time must then read the native position**, or `min(wall, position)` ([`streaming.md`](streaming.md)) bills nothing. Art for the lock screen is the `/api/art` URL, as on the web.

## Before the App Store (not started)

- Paid Apple Developer Program. An individual account is enough **because the app holds no funds**: NWC connects a wallet the user already has. Guideline 3.1.5's organization requirement is for apps that store currency. Castamatic, Fountain, Podverse, Podcast Guru and Pod Monster all ship V4V boosts today.
- Boosts must never unlock content (guideline 3.1.1). They do not today; keep it that way.
- Guideline 4.2 ("minimum functionality") is the review risk for a shell around a live site. Native background audio, lock-screen controls and Keychain storage are the answer; point at them in the review notes, and give the reviewer a funded NWC test connection.
- Move the nsec and the NWC connection string into the Keychain (`@aparajita/capacitor-secure-storage`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`), behind `isNativeIos()`. Read [`signers.md`](signers.md) and [`storage.md`](storage.md) first: both are `bmb:*` keys today.
- Deep links: `lightning:`, `nostr+walletconnect:`, `nostr:` URL schemes and universal links for `www.boostmebuddy.com`, through `@capacitor/app`'s `appUrlOpen`.
- App icon and launch screen from `BRAND.iconDir` ([`../brand/README.md`](../brand/README.md)).
