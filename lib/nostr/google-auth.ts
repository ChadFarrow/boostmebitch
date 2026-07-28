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
// token, so an expired token means re-prompting.

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

function requestAccessToken(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const gis = window.google;
    if (!gis) {
      reject(new Error('Google sign-in unavailable'));
      return;
    }
    const client = gis.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (r) => {
        if (r.access_token) resolve(r.access_token);
        else reject(new Error(r.error || 'Google did not grant Drive access'));
      },
      error_callback: () => reject(new Error('Google sign-in was cancelled')),
    });
    client.requestAccessToken();
  });
}

/** Full sign-in: one consent popup for both scopes, then read `sub` back. */
export async function signInWithGoogle(): Promise<GoogleAuthResult> {
  const clientId = googleClientId();
  if (!clientId) throw new Error('Google sign-in is not configured for this site');
  await loadGis();
  const accessToken = await requestAccessToken(clientId);
  const sub = await fetchSub(accessToken);
  return { sub, accessToken };
}

/** Re-request an access token after a 401. The user has already consented, so
 *  this is usually silent. */
export async function refreshAccessToken(): Promise<string> {
  const clientId = googleClientId();
  if (!clientId) throw new Error('Google sign-in is not configured for this site');
  await loadGis();
  return requestAccessToken(clientId);
}
