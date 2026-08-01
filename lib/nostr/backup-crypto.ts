'use client';

// Crypto for the Google-hosted key backup. Ported from Wisp's
// auth/BackupCrypto.kt so the construction is one a second implementation has
// already reviewed:
//
//   salt = HMAC-SHA256(key = BACKUP_LABEL, msg = google `sub`)
//   key  = Argon2id(pin, salt, m=32MiB, t=3, p=1) -> 32 bytes
//   blob = NIP-44 v2 over the hex nsec, with that key substituted for the
//          usual ECDH conversation key
//
// Why the Google `sub` is only a salt: it isn't a secret. Anyone who can read
// the backup blob already had to get past Google's access control on the
// appdata folder, and the sub is visible to Google anyway. It exists to make
// the salt per-account without us storing one. The PIN is the only secret.
//
// ---------------------------------------------------------------------------
// BE HONEST ABOUT THE MARGIN. A numeric PIN is a weak secret and no KDF fixes
// that; the KDF only sets the price per guess. Do the arithmetic before
// changing anything here:
//
//   6 digits = 10^6 candidates. 8 digits = 10^8. That is the whole keyspace —
//   an attacker with the blob enumerates it, they don't "crack" anything.
//
// This previously used PBKDF2-HMAC-SHA256 at 600k iterations with a 4-digit
// floor, and claimed "weeks of compute per blob". That was wrong by orders of
// magnitude: PBKDF2-SHA256 is trivially GPU-parallel (~10^4 guesses/sec on one
// consumer card), so 10^4 candidates fell in UNDER A SECOND. The construction
// was fine; the conclusion was fantasy.
//
// Argon2id is memory-hard, which is the part that hurts GPUs: 32 MiB of state
// per guess collapses the parallelism a GPU's thousands of cores would
// otherwise give for free. Rough current numbers, and they are ROUGH:
//
//   6-digit PIN + these params ~ days of dedicated GPU time for one blob
//   8-digit PIN + these params ~ years
//
// So: still not "unbreakable", and a determined attacker who obtains a blob
// and targets a 6-digit PIN will eventually win. The mitigations that actually
// matter are (a) the blob lives in app-private Drive storage, so getting one
// is itself a compromise, and (b) the PIN floor. If you want a real margin,
// raise PIN_MIN_LENGTH — that buys 10x per digit, far more than any parameter
// here. Do not lower m/t to speed up the UI.
// ---------------------------------------------------------------------------

import { nip44 } from 'nostr-tools';
import { argon2idAsync } from '@noble/hashes/argon2.js';

const BACKUP_LABEL = 'bmb-google-backup';

// OWASP-class Argon2id parameters, picked against measured cost rather than
// taste: 32 MiB / t=3 is ~0.6s on a laptop and a few seconds on a phone. 64 MiB
// doubled that and risks the allocation on mobile Safari for one extra bit of
// margin; 19 MiB (the OWASP floor) was cheap enough to be worth trading up
// from. p=1 because there is no thread pool to exploit here anyway.
const ARGON2_MEMORY_KIB = 32 * 1024;
const ARGON2_TIME_COST = 3;
const ARGON2_PARALLELISM = 1;

// 6, not 4. Four digits is 10,000 candidates — small enough that no KDF saves
// it. Raising the floor is the single highest-leverage knob in this file.
export const PIN_MIN_LENGTH = 6;
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

/**
 * 32-byte symmetric key from the Google account id + the user's PIN.
 *
 * The **async** Argon2 variant is deliberate: this is a memory-hard KDF taking
 * hundreds of milliseconds to seconds, and the sync one would block the main
 * thread for that whole time — a visibly frozen tab on mobile. `asyncTick`
 * yields to the event loop periodically so the panel's "Working…" spinner
 * keeps animating.
 *
 * There is no back-compat path to the old PBKDF2 blobs. The feature was never
 * shipped, so none exist outside development.
 */
export async function deriveBackupKey(sub: string, pin: string): Promise<Uint8Array> {
  const salt = await deriveSalt(sub);
  return argon2idAsync(new TextEncoder().encode(pin), salt, {
    m: ARGON2_MEMORY_KIB,
    t: ARGON2_TIME_COST,
    p: ARGON2_PARALLELISM,
    dkLen: 32,
    asyncTick: 16,
  });
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
