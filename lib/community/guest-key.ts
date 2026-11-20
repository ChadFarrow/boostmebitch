// BROWSER-ONLY. The random key that lets someone with no Nostr account make a
// community playlist and edit it again later, in the same browser (Chad,
// 2026-11-19: "if we do a random key for the user and save it, I'm fine with that").
//
// WHAT THE KEY IS FOR, AND WHAT IT IS NOT. It signs the NIP-98 request that
// publishes, saves or deletes a playlist, and the Blossom upload of its cover.
// That is all. It is NEVER the app's identity: nothing signs a note, a favorite or
// a boost with it, nothing reads relays under it, and it is not in `window.nostr`.
// So a leak costs one thing: someone else can edit or delete these playlists.
//
// THE KEY HAS NO STRING FORM. It is made, encrypted and used as bytes (`Uint8Array`).
// It is never hex-encoded, never `nsec`-encoded, never put in a URL, a log line, an
// error, a Nostr event, `localStorage`, `sessionStorage` or a request body. That is
// the whole defence against our own code leaking it, and `scripts/check-guestkey.mjs`
// pins it (this file is loaded under Node there, with a fake IndexedDB).
//
// HOW IT IS KEPT (docs/feeds.md, "Making a playlist without a Nostr account"):
// - IndexedDB, not `localStorage`: no `bmb:*` helper, bug report or export that walks
//   localStorage can reach it.
// - Encrypted with AES-GCM under a NON-EXTRACTABLE CryptoKey stored beside it. The
//   secp256k1 key itself cannot be a non-extractable CryptoKey (Web Crypto signs with
//   P-256, P-384, P-521 and a few others, not secp256k1), so it is wrapped instead.
//   `extractable: false` only stops `exportKey()`/`wrapKey()` (MDN): a script on this
//   origin can still read the record and call `decrypt()` with the handle, and the
//   browsers do not document how that key material is stored on disk. So the wrap
//   keeps the key out of a dump of the record and out of `JSON.stringify`; it does
//   NOT protect against a script on the site, an extension, or someone with the device.
// - Used by decrypting, signing and zeroing the bytes: nothing holds the secret
//   between two signatures. The one exception is the memory-only fallback below.
//
// WHEN THE BROWSER CANNOT KEEP IT (no IndexedDB, no `crypto.subtle` as over
// `http://<LAN-IP>`, a private window that throws), `ensureGuestKey` returns a key
// held in this tab's memory only, with `persisted: false`, so the first publish
// works and the maker says plainly that the playlist cannot be edited later. A READ
// error never overwrites a stored key: only a read that proved "no key" creates one.
//
// Bare nostr-tools imports only: scripts/check-guestkey.mjs loads this file directly.
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';

export interface GuestKeyInfo {
  /** The public key, hex. */
  pubkey: string;
  npub: string;
  /** false: held in this tab's memory only, gone when it closes. */
  persisted: boolean;
}

const DB_NAME = 'bmb-guest';
const STORE = 'keys';
const RECORD_ID = 'playlist-v1';
const IV_BYTES = 12;
/** 32 key bytes + the 16-byte AES-GCM tag. */
const CT_BYTES = 48;

interface KeyRecord {
  id: string;
  pubkey: string;
  iv: Uint8Array;
  ct: ArrayBuffer;
  wrap: CryptoKey;
}

/** The memory-only key, when storage could not keep one. */
let memory: { sk: Uint8Array; info: GuestKeyInfo } | null = null;

const enc = new TextEncoder();
const aad = (pubkey: string) => enc.encode(`bmb-guest-playlist-key:v1:${pubkey}`);
const infoOf = (pubkey: string, persisted: boolean): GuestKeyInfo => ({ pubkey, npub: npubEncode(pubkey), persisted });

/** A log line carries a fixed word, never an error object, never anything about the key. */
const warn = (what: string) => console.warn('[guest-key]', what);

function isRecord(v: unknown): v is KeyRecord {
  const r = v as Partial<KeyRecord> | null;
  return !!r && r.id === RECORD_ID && typeof r.pubkey === 'string' && /^[0-9a-f]{64}$/.test(r.pubkey)
    && r.iv instanceof Uint8Array && r.iv.byteLength === IV_BYTES
    && r.ct instanceof ArrayBuffer && r.ct.byteLength === CT_BYTES
    && typeof CryptoKey !== 'undefined' && r.wrap instanceof CryptoKey;
}

function canPersist(): boolean {
  return typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('open'));
    req.onblocked = () => reject(new Error('blocked'));
  });
}

type Read = { kind: 'record'; record: KeyRecord } | { kind: 'absent' } | { kind: 'unusable' } | { kind: 'error' };

/** `absent` is a PROOF that no key is stored. `unusable` is a record we cannot read; `error` is a read that failed. */
async function readRecord(): Promise<Read> {
  if (!canPersist()) return { kind: 'error' };
  try {
    const db = await openDb();
    try {
      const v = await new Promise<unknown>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD_ID);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error('get'));
      });
      if (v === undefined) return { kind: 'absent' };
      return isRecord(v) ? { kind: 'record', record: v } : { kind: 'unusable' };
    } finally {
      db.close();
    }
  } catch {
    return { kind: 'error' };
  }
}

/**
 * Put `rec` unless a record is already there (another tab won the race): the
 * stored one is returned either way. One read-write transaction, so the check and
 * the put cannot interleave with another tab's.
 */
async function putIfAbsent(rec: KeyRecord): Promise<KeyRecord | null> {
  try {
    const db = await openDb();
    try {
      return await new Promise<KeyRecord | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        let winner: KeyRecord | null = null;
        const get = store.get(RECORD_ID);
        get.onsuccess = () => {
          if (isRecord(get.result)) winner = get.result;
          else store.put(rec);
        };
        tx.oncomplete = () => resolve(winner ?? rec);
        tx.onerror = () => reject(new Error('put'));
        tx.onabort = () => reject(new Error('put'));
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** The key's public half, or null when this browser holds none. Never creates a key. */
export async function loadGuestKey(): Promise<GuestKeyInfo | null> {
  if (memory) return memory.info;
  const r = await readRecord();
  return r.kind === 'record' ? infoOf(r.record.pubkey, true) : null;
}

async function makeRecord(sk: Uint8Array, pubkey: string): Promise<KeyRecord> {
  const wrap = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(pubkey) }, wrap, sk as Uint8Array<ArrayBuffer>);
  return { id: RECORD_ID, pubkey, iv, ct, wrap };
}

/**
 * The guest key, made on first use. Resolves with the public half only. When the
 * browser cannot keep a key, resolves with a memory-only one (`persisted: false`).
 */
export async function ensureGuestKey(): Promise<GuestKeyInfo> {
  if (memory) return memory.info;
  const before = await readRecord();
  if (before.kind === 'record') return infoOf(before.record.pubkey, true);

  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  // Only a read that PROVED "no key" may write one. A read error or an unreadable
  // record may hide a key we could still use, and a write would destroy it.
  if (before.kind === 'absent') {
    try {
      const stored = await putIfAbsent(await makeRecord(sk, pubkey));
      if (stored) {
        sk.fill(0);
        return infoOf(stored.pubkey, true);
      }
    } catch {
      /* falls through to the memory-only key */
    }
  }
  warn('storage unavailable: this tab holds the key in memory only');
  memory = { sk, info: infoOf(pubkey, false) };
  return memory.info;
}

/**
 * Sign one event template with the guest key. The secret is decrypted, used and
 * zeroed inside this call. Rejects (with a fixed message) when there is no key.
 */
export async function signAsGuest(template: EventTemplate): Promise<Event> {
  if (memory) return finalizeEvent(template, memory.sk);
  const r = await readRecord();
  if (r.kind !== 'record') throw new Error('no guest key');
  let sk: Uint8Array | null = null;
  try {
    sk = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(r.record.iv), additionalData: aad(r.record.pubkey) }, r.record.wrap, r.record.ct,
    ));
    if (getPublicKey(sk) !== r.record.pubkey) throw new Error('mismatch');
    return finalizeEvent(template, sk);
  } catch {
    throw new Error('guest key unusable');
  } finally {
    sk?.fill(0);
  }
}

/**
 * The signer the community client takes: `signEvent` only. It is NOT `window.nostr`
 * and is never installed there, so nothing else in the app can sign with this key.
 */
export const guestSigner = {
  signEvent: (template: EventTemplate): Promise<Event> => signAsGuest(template),
};

/** For tests only: forget the memory-only key. */
export function forgetMemoryGuestKey(): void {
  memory?.sk.fill(0);
  memory = null;
}
