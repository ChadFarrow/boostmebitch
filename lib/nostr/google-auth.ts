'use client';

// Google Identity Services, used for exactly two things:
//
//   1. an ID token, from which we read ONLY the `sub` claim (the stable Google
//      account id) — it salts the backup key derivation in backup-crypto.ts
//   2. an OAuth access token for one scope, drive.appdata, so drive-backup.ts
//      can read and write the user's encrypted key blob
//
// Google is not an identity provider here. It never sees the Nostr key, and we
// never store the user's email or name. The access token is held in memory for
// its ~1h lifetime and is never persisted; the implicit flow issues no refresh
// token, so an expired token means asking GIS again — silently where the grant
// is still live (see refreshAccessToken), interactively where it isn't.

import { getErrorMessage } from '@/lib/util';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
// `openid` is what makes the userinfo endpoint return `sub`; drive.appdata is
// the only data access we ask for.
const SCOPES = 'openid https://www.googleapis.com/auth/drive.appdata';

export interface GoogleAuthResult {
  /** Stable Google account id. Salt material only — not a secret. */
  sub: string;
  /** OAuth access token for drive.appdata. Memory-only, ~1h. */
  accessToken: string;
}

export function googleClientId(): string | null {
  return process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim() || null;
}

/** True when the deployment is configured for Google sign-in. The UI hides the
 *  entry point entirely when this is false rather than failing on tap. */
export function isGoogleAuthConfigured(): boolean {
  return googleClientId() !== null;
}

// Minimal shape of the GIS globals we touch. The full library types would be a
// dependency for four call sites.
interface GsiTokenResponse {
  access_token?: string;
  error?: string;
}
/** GIS error_callback payload. `type` is the only field worth branching on;
 *  `message` is a developer string, not user copy. */
interface GsiErrorEvent {
  type?: string;
  message?: string;
}
interface GsiGlobal {
  accounts: {
    oauth2: {
      initTokenClient: (cfg: {
        client_id: string;
        scope: string;
        callback: (r: GsiTokenResponse) => void;
        error_callback?: (e: unknown) => void;
      }) => { requestAccessToken: (o?: { prompt?: string }) => void };
    };
  };
}

declare global {
  interface Window {
    google?: GsiGlobal;
  }
}

let scriptPromise: Promise<void> | null = null;

/** Inject the GIS script once per page. Memoized — the sign-in modal can be
 *  opened and closed repeatedly. */
function loadGis(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google sign-in requires a browser'));
  }
  if (window.google?.accounts) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = GIS_SRC;
    el.async = true;
    el.defer = true;
    el.onload = () => resolve();
    el.onerror = () => {
      // Let a later attempt retry rather than caching the failure forever —
      // this is usually a blocked-network / content-blocker situation.
      scriptPromise = null;
      reject(new Error('Could not load Google sign-in. A content blocker may be blocking it.'));
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}

/**
 * The stable Google account id for whoever granted this token.
 *
 * Deliberately NOT read from a One Tap ID token: `google.accounts.id.prompt()`
 * can be silently suppressed (FedCM opt-out, a previously dismissed prompt, no
 * active Google session) and then its callback simply never fires, hanging the
 * caller on a spinner with no error to show. The token client always presents
 * UI, so deriving `sub` from userinfo instead means one consent surface and no
 * silent-failure mode.
 *
 * `sub` is not treated as a secret — it only salts a KDF. A forged one yields
 * a different salt and therefore decrypts nothing.
 */
async function fetchSub(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Could not read your Google account id');
  const json = (await res.json()) as { sub?: unknown };
  if (typeof json.sub !== 'string' || !json.sub) {
    throw new Error('Google did not return an account id');
  }
  return json.sub;
}

// GIS reports "the browser blocked the popup" and "the user closed the popup"
// through the same callback. Collapsing both to "cancelled" tells a user whose
// popup blocker fired that they did something they didn't do, and hides the one
// thing they can actually fix.
function gisErrorMessage(e: unknown): string {
  const type = (e as GsiErrorEvent | null)?.type;
  if (type === 'popup_failed_to_open') {
    return 'Your browser blocked the Google sign-in popup. Allow popups for this site, then try again.';
  }
  if (type === 'popup_closed') return 'Google sign-in was cancelled';
  return getErrorMessage(e, 'Google sign-in failed');
}

// GIS resolves a token request by invoking `callback` or `error_callback` —
// and there are real situations where it does neither: a suppressed
// `prompt: ''` request, a popup the user leaves open forever, a token client
// torn down by a backgrounded tab. The promise then never settles, which is
// how the panel ends up pinned on "Working…" with no error and no way out.
// Bound it so every caller can always reach a terminal state.
const TOKEN_REQUEST_TIMEOUT_MS = 60_000;

function requestAccessToken(clientId: string, silent = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const gis = window.google;
    if (!gis) {
      reject(new Error('Google sign-in unavailable'));
      return;
    }
    // GIS can invoke a callback more than once, and the timeout races both, so
    // every exit goes through these two and the first one wins.
    let settled = false;
    const succeed = (token: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(token);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail("Google didn't respond. Check for a blocked or hidden popup, then try again."),
      TOKEN_REQUEST_TIMEOUT_MS,
    );

    const client = gis.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (r) => {
        if (r.access_token) succeed(r.access_token);
        else fail(r.error || 'Google did not grant Drive access');
      },
      error_callback: (e) => fail(gisErrorMessage(e)),
    });
    // prompt:'' reuses the grant the user already gave without showing consent
    // UI. GIS's default opens a popup — fine inside the click that started
    // sign-in, fatal on the refresh path, which runs after a Drive 401 with no
    // transient activation left and therefore gets blocked outright.
    client.requestAccessToken(silent ? { prompt: '' } : undefined);
  });
}

/**
 * Warm the GIS script before the user commits to anything. Fetching it inside
 * the click path is what burns the click's transient activation on a cold first
 * visit and gets the consent popup blocked. `loadGis()` is memoized, so calling
 * this when the sign-in modal opens makes the later click path effectively
 * synchronous. Failures are swallowed — signInWithGoogle() surfaces them with
 * real copy when it matters.
 */
export function preloadGis(): void {
  void loadGis().catch(() => { /* the real attempt reports this properly */ });
}

/** Full sign-in: one consent popup for both scopes, then read `sub` back. */
export async function signInWithGoogle(): Promise<GoogleAuthResult> {
  const clientId = googleClientId();
  if (!clientId) throw new Error('Google sign-in is not configured for this site');
  // Keep this await: once preloadGis() has run it resolves in a microtask,
  // which does NOT consume transient activation — it was the cold network fetch
  // that did. Removing it would just reintroduce the unloaded-script case.
  await loadGis();
  const accessToken = await requestAccessToken(clientId);
  const sub = await fetchSub(accessToken);
  return { sub, accessToken };
}

/**
 * Thrown when a silent token refresh can't be satisfied (no live Google
 * session, grant revoked). An interactive retry needs a fresh user gesture,
 * which the mid-flow caller doesn't have — so the honest recovery is to send
 * the user back through a click-initiated sign-in, which is what the panel's
 * Retry button already is.
 */
export class GoogleReauthRequiredError extends Error {
  constructor(cause?: unknown) {
    // Keep the underlying reason in the message when there is one. A silent
    // refresh fails for several distinct reasons — popup blocked, scope
    // refused, GIS gone, network — and collapsing them all into "session
    // expired, tap Retry" hands the user one instruction that is wrong for
    // most of them. Retrying a blocked popup just blocks again.
    const detail = cause instanceof Error ? cause.message : '';
    super(
      detail
        ? `Couldn't refresh your Google session: ${detail}`
        : 'Your Google session expired. Tap Retry to sign in with Google again.',
    );
    this.name = 'GoogleReauthRequiredError';
    this.cause = cause;
  }
}

/** Re-request an access token after a 401. Silent-first: the user already
 *  consented, and this runs mid-flow with no transient activation, so a popup
 *  here would simply be blocked. */
export async function refreshAccessToken(): Promise<string> {
  const clientId = googleClientId();
  if (!clientId) throw new Error('Google sign-in is not configured for this site');
  await loadGis();
  try {
    return await requestAccessToken(clientId, true);
  } catch (e) {
    throw new GoogleReauthRequiredError(e);
  }
}
