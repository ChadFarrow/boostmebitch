'use client';

// Crypto for the Google-hosted key backup. Ported from Wisp's
// auth/BackupCrypto.kt so the construction is one a second implementation has
// already reviewed:
//
//   salt = HMAC-SHA256(key = BACKUP_LABEL, msg = google `sub`)
//   key  = PBKDF2-HMAC-SHA256(pin, salt, 600_000 iters) -> 32 bytes
//   blob = NIP-44 v2 over the hex nsec, with that key substituted for the
//          usual ECDH conversation key
//
// Why the Google `sub` is only a salt: it isn't a secret. Anyone who can read
// the backup blob already had to get past Google's access control on the
// appdata folder, and the sub is visible to Google anyway. It exists to make
// the salt per-account without us storing one. The PIN is the only secret.
//
// The PIN is 4-8 digits — around 26 bits, which is weak on its own. The
// 600k-iteration KDF is what makes an offline attack expensive (weeks of
// compute per blob). Do not lower the iteration count to speed up the UI.

import { nip44 } from 'nostr-tools';

const BACKUP_LABEL = 'bmb-google-backup';
const PBKDF2_ITERATIONS = 600_000;

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

/** Per-account salt derived from the Google account id. Deterministic, so the
 *  same account + PIN always reproduces the same key without us persisting a
 *  salt anywhere. */
async function deriveSalt(sub: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(BACKUP_LABEL),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sub));
  return new Uint8Array(mac);
}

/** 32-byte symmetric key from the Google account id + the user's PIN. */
export async function deriveBackupKey(sub: string, pin: string): Promise<Uint8Array> {
  const salt = await deriveSalt(sub);
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/** Encrypt a hex secret key for storage in the user's Drive appdata folder. */
export function encryptNsec(skHex: string, key: Uint8Array): string {
  return nip44.v2.encrypt(skHex, key);
}

/**
 * Decrypt a backup blob. Throws on a wrong PIN — NIP-44's MAC check fails, it
 * does not return garbage. Callers treat a throw as "this blob isn't ours (or
 * the PIN is wrong)", which is exactly how the account picker separates one
 * user's backups from another's on a shared Google account.
 */
export function decryptNsec(payload: string, key: Uint8Array): string {
  const out = nip44.v2.decrypt(payload, key);
  if (!/^[0-9a-fA-F]{64}$/.test(out)) {
    throw new Error('Decrypted payload is not a secret key');
  }
  return out;
}
