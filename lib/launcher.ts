// Which Android app opened this site — and whether it is ours.
//
// The Android build is a Trusted Web Activity: a signed shell that opens
// `www.boostmebitch.com` in Chrome. There is no second copy of the app, so a
// FORK of the APK that keeps the host (change the package id, sign with your
// own key, publish on Zapstore) runs entirely on this deployment — every
// `/api/*` call, the Podcast Index quota, the BoostBox proxy, the site signer —
// while showing this brand and stamping `BoostMeBitch` on every boost it sends.
// StableKraft had exactly this happen. Nothing at the HTTP level stops a
// browser from opening a website, so this cannot be a lock; it is a SIGNAL.
//
// The signal: when an Android app opens a URL in Chrome (a TWA, or a Custom
// Tab), the first navigation carries the referrer `android-app://<package>/`.
// `document.referrer` holds it for the life of that document. A verified TWA
// of ours reports our own package id; a fork reports its own.
//
// **Every other Android app that opens a link reports its package the same
// way** — Telegram, Signal, Fountain, a mail client. So "unknown package" alone
// is a Telegram user tapping a shared link, and REFUSING on it would break
// every Android visitor who arrived from a chat. Two things narrow it to a
// wrapper, and both are heuristics: a wrapper launches at its `startUrl`, which
// is `/` with no query — a shared link is nearly always a deep link — and the
// answer is only ever a dismissable notice that names the official app. Never
// gate an API or a payment on this.
//
// Remembered in sessionStorage for the tab (`storage.launcher`): the referrer
// belongs to the first document, and a reload inside the wrapper may lose it.
import { BRANDS } from './brand';
import { storage } from './storage';

const ANDROID_APP_REFERRER = /^android-app:\/\/([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\/?/;

/** The package id in an `android-app://<package>/` referrer, or null. */
export function parseLauncherPackage(referrer: string): string | null {
  const m = ANDROID_APP_REFERRER.exec(referrer.trim());
  return m ? m[1]! : null;
}

/** The package ids this repo builds. Mirrors `android/twa-manifest*.json`; `check:brand` asserts they agree. */
export const OFFICIAL_ANDROID_PACKAGES: ReadonlySet<string> = new Set(
  Object.values(BRANDS).map((b) => b.androidPackageId),
);

export function isOfficialPackage(pkg: string): boolean {
  return OFFICIAL_ANDROID_PACKAGES.has(pkg);
}

/**
 * The package of an Android wrapper that is not ours, or null.
 *
 * Reads the tab's remembered answer first, then the document's referrer — and
 * records the referrer's package only when this looks like a wrapper's launch
 * (landed on `/`, no query), so a deep link opened from a chat app is not
 * remembered as a launcher for the rest of the tab.
 */
export function detectUnofficialLauncher(): string | null {
  if (typeof document === 'undefined') return null;
  let pkg = storage.launcher.get();
  if (!pkg) {
    const fromReferrer = parseLauncherPackage(document.referrer);
    const atStartUrl = window.location.pathname === '/' && !window.location.search;
    if (fromReferrer && atStartUrl) {
      storage.launcher.set(fromReferrer);
      pkg = fromReferrer;
    }
  }
  return pkg && !isOfficialPackage(pkg) ? pkg : null;
}
