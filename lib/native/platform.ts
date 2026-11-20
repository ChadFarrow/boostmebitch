/**
 * Is this page running inside the iOS app — the Capacitor shell around the
 * live site (`www.boostmebuddy.com`, loaded through `server.url`)?
 *
 * Capacitor's native bridge installs `window.Capacitor` before any page script
 * runs, and its `getPlatform()` answers `'ios'` there and nowhere else: Safari,
 * the home-screen PWA and every desktop browser have no `window.Capacitor`, so
 * they answer false. Read from the global rather than importing
 * `@capacitor/core`, so the web bundle carries nothing for a platform most of
 * its visitors are not on.
 *
 * False on the server and on the first client render alike, so a caller that
 * renders differently in the app reads it in an effect or an event, or in
 * client-only UI such as a modal that opens on a click.
 *
 * It answers WHERE the page runs, and nothing it gates may be a security
 * boundary: any script on the origin can define `window.Capacitor`.
 */
export function isNativeIos(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const cap = (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    return cap?.getPlatform?.() === 'ios';
  } catch {
    return false;
  }
}
