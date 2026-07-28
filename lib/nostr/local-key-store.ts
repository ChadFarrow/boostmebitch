'use client';

// Key at rest for the local signer.
//
// Wisp (the Android client this flow is ported from) leans on Android Keystore
// via EncryptedSharedPreferences. The browser has no Keystore, and plaintext
// localStorage is the weakest option available — anything that can read storage
// walks away with the identity forever.
//
// The strongest primitive the web offers without prompting the user on every
// load is a non-extractable CryptoKey: `crypto.subtle.generateKey` with
// `extractable: false` returns a handle whose raw bytes are never exposed to
// JS. IndexedDB persists that handle via structured clone (localStorage can't —
// it's strings only, which is the other reason the key can't live there). The
// nsec is AES-GCM encrypted under it; ciphertext and IV sit in the same store.
//
// What this buys: an attacker who reads storage — a dumped profile directory, a
// stolen device backup, a localStorage scrape — gets ciphertext plus a key
// handle that cannot be exported, so the identity can't be exfiltrated for
// offline reuse. What it does NOT buy: protection from script executing on this
// origin, which can simply call the signer while it runs. That residual risk is
// what a CSP is for.

const DB_NAME = 'bmb-keys';
const DB_VERSION = 1;
const STORE = 'keys';
const WRAP_KEY_ID = 'wrap';
const PAYLOAD_ID = 'nsec';

// Fallback for private-mode / storage-partitioned browsers where IndexedDB
// throws or is absent. Session-only and deliberately so — silently downgrading
// to a persistent plaintext copy would defeat the entire point of this module.
let memoryOnlyKey: string | null = null;

/** True when the key is only held in memory — the user will have to sign in
 *  again after a reload. Surfaced as a soft warning, mirroring
 *  storage.nwcUri.isEphemeral(). */
export function isKeyEphemeral(): boolean {
  return memoryOnlyKey !== null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Load the existing wrap key, or mint one. `extractable: false` is the whole
 *  point — do not relax it for "debuggability". */
async function getOrCreateWrapKey(db: IDBDatabase): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>(db, WRAP_KEY_ID);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  await idbPut(db, WRAP_KEY_ID, key);
  return key;
}

/**
 * Persist the hex secret key, encrypted under the origin's non-extractable
 * wrap key. Falls back to memory-only when IndexedDB isn't usable; callers can
 * check `isKeyEphemeral()` to warn the user.
 */
export async function putKey(skHex: string): Promise<void> {
  memoryOnlyKey = skHex;
  try {
    const db = await openDb();
    const key = await getOrCreateWrapKey(db);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(skHex),
    );
    await idbPut(db, PAYLOAD_ID, { iv, ct });
    db.close();
    // Persisted successfully — drop the memory copy's "ephemeral" meaning so
    // the UI doesn't warn. The signer holds its own copy of the key.
    memoryOnlyKey = null;
  } catch {
    // Keep memoryOnlyKey set: this session still works, the next one won't.
  }
}

/** Decrypt and return the hex secret key, or null when none is stored. */
export async function getKey(): Promise<string | null> {
  if (memoryOnlyKey) return memoryOnlyKey;
  try {
    const db = await openDb();
    const [key, payload] = await Promise.all([
      idbGet<CryptoKey>(db, WRAP_KEY_ID),
      idbGet<{ iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer }>(db, PAYLOAD_ID),
    ]);
    db.close();
    if (!key || !payload) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: payload.iv },
      key,
      payload.ct,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Drop both the ciphertext and the wrap key. Called on sign-out — leaving the
 *  wrap key behind would let a later ciphertext be decrypted by it. */
export async function clearKey(): Promise<void> {
  memoryOnlyKey = null;
  try {
    const db = await openDb();
    await idbDelete(db, PAYLOAD_ID);
    await idbDelete(db, WRAP_KEY_ID);
    db.close();
  } catch {
    /* nothing persisted, or storage is gone — either way there's nothing to clear */
  }
}
