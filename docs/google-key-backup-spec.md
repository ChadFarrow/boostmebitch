# Google-hosted Nostr key backup — v1

A format for letting a user create a Nostr identity with no prior key, back it up
to their own Google Drive, and restore it in **any participating app** using the
same Google account and PIN.

**Status: not a NIP.** This is an inter-app convention, published so that a second
implementation has something to build against instead of reverse-engineering a
codebase. It originates in [Wisp](https://github.com/barrydeen/wisp)
(`auth/BackupCrypto.kt`, `auth/DriveBackupService.kt`); this document describes
the boostmebitch variant, which is **not** wire-compatible with Wisp's — the salt
labels differ, so the same Google account and PIN derive a different key in each.

Reference implementation: `lib/nostr/backup-crypto.ts`, `lib/nostr/drive-backup.ts`,
`lib/nostr/google-auth.ts`, `lib/v4v/spark-derive.ts` in this repository.

The key words MUST, MUST NOT, SHOULD and MAY are used in the RFC 2119 sense.

---

## 0. Prerequisite: all participating apps must share one OAuth client

Nothing else in this document has any effect without this.

Google's `appDataFolder` is created **per third-party app**. Only the app that
created the data can access it, the folder is invisible in the Drive UI, and its
contents **cannot be shared** — there is no permission, scope, or console setting
that grants one app access to another's app-data space.

Therefore two apps interoperate under this spec **only if they authenticate with
OAuth clients in the same Google Cloud project**, with each app's origin listed
under that client's *Authorized JavaScript origins*. Separate projects produce
separate, permanently invisible folders no matter how identical their crypto is.

Consequences worth understanding before opting in:

- Every participating app can list, read, and **delete** every blob in the shared
  folder. It cannot *decrypt* one without that blob's PIN, but it can destroy it
  and it can harvest ciphertext for an offline PIN search. The participant set is
  a mutual-trust set, not a federation.
- Google's consent screen shows **one** brand for all of them. A user signing in
  on app B sees app A's verified name unless the project is deliberately branded
  neutrally.
- Authorized JavaScript origins accept `https://` origins and `http://localhost`
  (with or without a port). A private TLD such as `something.local` **cannot** be
  registered; local development MUST use `http://localhost:<port>`.

## 1. What the design does and does not claim

**Google is a zero-knowledge blob store here, not an identity provider.** The
secret key is generated locally at random. Nothing about it derives from the
Google account, and an implementation MUST NOT derive key material from `sub`,
the email address, or any other Google-supplied identifier. (Wisp shipped
`sub`-derived keys once and reverted.)

Requesting only `openid` and `https://www.googleapis.com/auth/drive.appdata`
means Google is never told the user's npub and the app is never told the user's
name or email. Both scopes are non-sensitive, so the only Google review required
is brand verification. An implementation MUST NOT request the `profile` or
`email` scopes for this flow; doing so would publicly link a Nostr identity to a
real-world one for no gain, since neither is used.

**The PIN is the only secret.** `sub` is salt, not a credential — it is visible
to Google, and anyone able to read a blob has already defeated Drive's access
control. Be honest about the resulting margin:

- 6 digits is 10⁶ candidates and 8 digits is 10⁸. That is the entire keyspace; an
  attacker holding a blob enumerates it rather than "cracking" anything.
- The KDF only sets the price per guess. Argon2id is memory-hard, which is what
  denies a GPU its parallelism, but a determined attacker who obtains a blob and
  targets a 6-digit PIN eventually wins.
- The two mitigations that actually matter are that obtaining a blob is itself a
  compromise (app-private storage), and the PIN length floor. Raising the floor
  buys 10× per digit — far more than any KDF parameter change.

Losing the PIN loses the identity. There is no reset path, and an implementation
MUST say so on the screen where the PIN is chosen.

## 2. Normative constants

| Constant | Value |
|---|---|
| Salt label | `bmb-google-backup` (UTF-8, no trailing newline) |
| Argon2 variant | Argon2**id**, version `0x13` (1.3) |
| Argon2 memory | `32768` KiB (32 MiB) |
| Argon2 iterations (`t`) | `3` |
| Argon2 parallelism (`p`) | `1` |
| Derived key length | `32` bytes |
| PIN | `^\d{6,8}$` — ASCII digits only |
| Secret-key encoding | lowercase, 64 hex characters |
| Payload | NIP-44 v2, base64 |
| Filename | `bmb_bk_<uuidv4>.bin` |
| Wallet label | `bmb-spark-wallet` (UTF-8) — see §7 |

> **The `bmb` in these names is historical, and normalizing it is a breaking
> change.** They read like app-local identifiers and they are not — they are wire
> constants baked into every key ever derived. Renaming `bmb-google-backup` to
> something neutral silently locks every existing user out of their backup;
> renaming `bmb-spark-wallet` silently moves every derived wallet. A new
> implementation MUST use these strings verbatim. See §8 for how to change them
> safely if it ever becomes necessary.

**Both PIN bounds are normative.** An app that validates a shorter maximum than 8
will refuse to accept a PIN another app legitimately allowed, locking that user
out of their own backup with an input-validation error. Enforce exactly 6–8.

## 3. Key derivation

```
salt = HMAC-SHA256(key = UTF8("bmb-google-backup"), msg = UTF8(google_sub))
key  = Argon2id(password = UTF8(pin), salt = salt, m = 32768, t = 3, p = 1,
                dkLen = 32, version = 0x13)
```

`google_sub` is the `sub` claim for the authenticated Google account, as a
string, exactly as Google returns it. Any endpoint that yields the authoritative
`sub` is acceptable; the reference implementation reads it from
`https://www.googleapis.com/oauth2/v3/userinfo` with the access token, because
Google One Tap can be silently suppressed and then never invokes its callback at
all, hanging the flow with no error to show.

Deriving the salt from `sub` rather than storing one keeps the derivation
reproducible from the Google account alone, with no salt to lose or synchronize.

Implementations SHOULD use an **asynchronous / incremental** Argon2, or run it in
a worker. The synchronous form blocks the main thread for the full ~0.6 s (much
longer on phones) and presents as a frozen tab.

## 4. Payload format

The blob is a **NIP-44 v2** payload whose plaintext is the secret key as a
lowercase 64-character hex string — not a raw 32-byte buffer, and not an `nsec`
bech32 string.

This is a **deliberate off-label use of NIP-44.** NIP-44 defines the conversation
key as HKDF-extract over an ECDH shared secret between two Nostr keypairs; here
the 32-byte Argon2id output of §3 is substituted for it directly. Everything
downstream of that substitution — random 32-byte nonce, HKDF-expand into the
ChaCha20 key/nonce and HMAC key, the padding scheme, `0x02 || nonce ||
ciphertext || mac`, base64 — is unmodified NIP-44 v2, so a stock NIP-44
implementation encrypts and decrypts these blobs correctly when handed the key.
What no stock tooling can do is *derive* that key. Do not expect an unmodified
NIP-44 client to open a blob on its own.

The file content is the base64 payload as UTF-8 text, with no wrapper, envelope,
header, or trailing newline.

Two properties this buys, both relied on by §6:

- A wrong PIN fails the MAC check and **throws**. It never returns plausible
  garbage, so "decryption failed" is a reliable signal.
- After decrypting, an implementation MUST still verify the plaintext matches
  `^[0-9a-fA-F]{64}$` before treating it as a key, so a MAC collision or a
  mis-stored file cannot produce a bogus identity.

## 5. Storage

Blobs live in the Google Drive **`appDataFolder`** space.

- **Filename** `bmb_bk_<uuidv4>.bin`, `application/octet-stream`.
- **No identifying metadata.** The only fields set on create are `name` and
  `parents: ["appDataFolder"]`. The npub exists solely inside the ciphertext, so
  Google holds a blob it cannot link to a Nostr identity. Implementations MUST
  NOT write the npub, a profile name, a timestamp, or app-specific properties
  into Drive metadata.
- **Every upload is a create with a fresh UUID; never an overwrite.** A create
  cannot lose a race with a concurrent create the way a read-modify-write can,
  and §6 tries every file regardless.
- **No delete path.** Decryption fails identically for "this blob belongs to a
  different PIN on a shared Google account" and "this blob belongs to a PIN the
  user has forgotten", so any prune is a chance to permanently destroy a
  recoverable identity. Implementations MUST NOT delete blobs they cannot
  currently decrypt, and SHOULD NOT offer a prune at all. The only safe deletion
  is of a blob just successfully decrypted and re-uploaded, which is a migration
  feature rather than cleanup.
- **Other files may be present.** Under §0 the folder is shared with other apps,
  which may store unrelated data in it. Listing MUST filter to names beginning
  `bmb_bk_` (§6); an unfiltered listing makes another app's settings file look
  like an undecryptable backup, which §6.1 then treats as a reason to block
  account creation.

## 6. Discovery and restore

### 6.1 Listing

List `spaces=appDataFolder`, filtered to the prefix. In Drive query syntax
`name contains 'bmb_bk_'` performs **prefix** matching on `name`, which is the
wanted semantic; implementations SHOULD additionally filter the returned names
client-side rather than rely on that subtlety alone.

Listing MUST paginate. Drive caps a page at 100 files regardless of the requested
`pageSize`, and `nextPageToken` **must be named explicitly in the `fields` mask**
or every response looks like the last page — at which point a user with more
identities than fit one page cannot see their backup, and a user who cannot see
their backup is exactly the user who creates a duplicate. Order by
`createdTime desc` and cap the walk at a fixed number of pages, so a truncated
listing drops the least-recently-created blobs rather than an arbitrary slice.

### 6.2 Trying the PIN

Download every listed blob, derive the key once per §3, and attempt decryption
against each blob independently.

**A decryption failure is not an error.** On a shared Google account (a family,
a couple) the folder legitimately holds blobs belonging to other people's PINs.
Failures are skipped silently; successes are deduplicated by npub and presented
as a picker when more than one matches.

### 6.3 The orphan rule (normative)

Track how many listed blobs **failed to download**, separately from how many
failed to decrypt. Then, with `listed` = files listed and `read` = blobs actually
downloaded:

| State | Required behavior |
|---|---|
| `listed == 0` | New to this Google account. Account creation MAY be offered. |
| `listed > 0`, `read == 0` | **Hard error.** Account creation MUST NOT be offered. |
| `listed > 0`, `read < listed` | Partial. Offer a retry; creation only on explicit confirmation. |

The middle row is the whole point of this section. A token that expired between
listing and downloading, or a Drive 5xx, produces a state that is *indistinguishable
from "new user"* if the download failures are discarded — and falling through
there walks a returning user into minting a second identity while their real one
sits unreachable in the same folder. This is the rule most likely to be dropped
by a reimplementation and the most expensive one to drop.

Two corollaries:

- While any download failed, a PIN that matches nothing MUST NOT be reported as
  "incorrect PIN". The matching blob may be one that failed to download, so that
  message is a claim the implementation cannot support.
- Creation reached from a partial state SHOULD be gated behind a retry affordance
  that names how many blobs are unaccounted for.

### 6.4 Token expiry

A Drive `401` MUST be surfaced as an authorization failure distinct from "no
backups found" — conflating them is the §6.3 orphan path by another route.
Refresh SHOULD be attempted silently (no consent popup), because a refresh
triggered mid-flow has no transient user activation left and a popup would simply
be blocked. Refreshes MUST be single-flight: parallel downloads that all `401` at
once would otherwise each request a token and open N popups, N−1 of them blocked.

## 7. Derived wallet (normative for apps with a built-in Spark wallet)

A key created through this flow belongs to a user who by construction had no
Nostr identity and has no wallet either. Participating apps derive a default
Spark wallet deterministically from the secret key, so the wallet is recoverable
from the key alone:

```
entropy  = HMAC-SHA256(key = UTF8("bmb-spark-wallet"), msg = sk_bytes)
mnemonic = BIP39-encode(entropy[0..16])      // 16 bytes -> 12 English words
```

`sk_bytes` is the 32 raw bytes of the secret key (not the hex string). The HMAC
domain-separates the wallet seed from the signing key, so the seed cannot be
walked back to the identity.

**An app that implements §§3–6 but derives its wallet differently produces the
worst failure mode in this document.** The user restores successfully, sees the
right npub and the right profile, and finds a wallet with a zero balance —
because it is a *different, valid, empty* wallet. Nothing errors and nothing
looks broken. If an app does not intend to honor this section, it MUST NOT
present a derived wallet to a restored identity at all.

Any restore path that provisions a wallet MUST treat an existing backup as
authoritative over the derived seed, so that a user who imported their own seed
phrase does not have it overwritten by the derived one.

## 8. Versioning

Every label in §2 is a derivation contract. **Never edit one in place.** A
changed label does not fail — it silently produces different keys, locking users
out of backups (or moving them to empty wallets) with no error anywhere.

To change a derivation: introduce a **new** label (`bmb-google-backup-v2`),
attempt v1 first on restore, re-encrypt under v2 only after a successful v1
decrypt, and keep the v1 path indefinitely. The same applies to the Argon2
parameters and to the payload format — anything that alters the bytes.

Implementations SHOULD pin the constants and derivations of §§2, 3 and 7 with
frozen test vectors executed against the shipping code (not a copy of it), so
that an accidental rename fails a check rather than a user.

## 9. Conformance vectors

Generated by the reference implementation. An implementation that reproduces
these is wire-compatible.

### 9.1 `deriveBackupKey(sub, pin)` → 32-byte key (hex)

| `sub` | PIN | Derived key |
|---|---|---|
| `110000000000000000000` | `123456` | `47adc18b00a85a0112d6cf8180fb822c23dae56d7c1b2c0eef5dbd2074707011` |
| `test-google-sub` | `87654321` | `bb3aae52328a2f96eb12d2bfef55f31b22fecd2669d5c086e72bbab90ba6277b` |

### 9.2 Payload round-trip

NIP-44 uses a random nonce, so a ciphertext is not pinnable — only the round-trip
is. Encrypting the plaintext `abab…ab` (32 bytes of `0xab` as 64 hex characters)
under the first key above and decrypting it with that same key MUST return the
input; decrypting it with the second key MUST **throw**, not return garbage.

### 9.3 `sparkMnemonicFromKey(skHex)` → 12 BIP-39 words

| Secret key (hex) | Mnemonic |
|---|---|
| `00`×31 + `01` | `million pioneer clever scan region alert gasp excite ask unknown chapter spatial` |
| `11`×32 | `rather jeans custom always leopard fly vintage naive apology section during dinner` |
| `deadbeef`×8 | `crane lumber rubber hold lion boring culture hunt story corn audit fan` |

A malformed key (non-hex, or not exactly 64 characters) MUST throw rather than
derive a wallet from garbage.

## 10. Explicitly out of scope

Per-app concerns, deliberately unspecified so implementations stay free:

- How the key is stored locally between sessions. The reference implementation
  wraps it with a non-extractable AES-GCM `CryptoKey` in IndexedDB and never puts
  plaintext in `localStorage`; a native app would use the platform keystore.
- Whether a generated `kind:0` profile is published for a new account, and what
  it contains. If one is published it MUST NOT derive from Google account data.
- Relay selection, UI, settings storage, and every application-level key.
- Key export. Nothing here provides one; an app wanting portability outside this
  participant set SHOULD offer a NIP-49 (`ncryptsec`) export, which is the actual
  Nostr standard for a password-encrypted secret key.
