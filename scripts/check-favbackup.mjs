// Pins `lib/favorites-export.ts` — the favorites BACKUP file: the refusal that
// decides whether one may be written at all, the bytes that go in it, its name,
// the sentence shown after it is written, and the parse that decides whether a
// chosen file may be republished under the user's key.
//
// WHY THIS EARNS A SCRIPT. A restore replaces the WHOLE kind:10333 event for
// every app that reads the account's favorites, and there is no undo and no
// history on a replaceable event. Both directions cost:
//
//  - Too permissive. A parse missing any one of `verifyEvent`, the pubkey test
//    or the kind test republishes somebody else's list, or an edited one, under
//    the user's key. An `i` tag appended in a text editor is the whole attack.
//  - Too strict. A refused backup is a user with no insurance, and a refused
//    restore is a user who cannot get their list back after the exact event the
//    backup existed for. Over-refusal is a regression here, which is what the
//    `{ alsoNaive: true }` vectors are for.
//
// THE TRAP THAT MAKES A NAIVE VECTOR LIST GREEN AND WORTHLESS. nostr-tools
// MEMOIZES verification on a `Symbol(verified)` own-property, and OBJECT SPREAD
// COPIES IT. Measured on 2026-09-03 against the pinned 2.19.4:
//
//     const ev = finalizeEvent(...);
//     Object.getOwnPropertySymbols(ev)          -> [ Symbol(verified) ]
//     Object.getOwnPropertySymbols({ ...ev })   -> [ Symbol(verified) ]   ← carried
//     verifyEvent({ ...ev, sig: 'zz'.repeat(64) })              -> TRUE
//     verifyEvent({ ...ev, tags: [['i','podcast:guid:EVIL']] }) -> TRUE
//
// So every tamper vector built by spreading a signed struct passes against an
// implementation that does not verify at all. That is CLAUDE.md's "build the
// fixture from the WIRE, not the struct you parse it into" made concrete, and
// it is enforced mechanically below: every fixture is a frozen JSON STRING and
// every variant is produced by `edit()`, which goes through JSON.parse. A JSON
// round trip drops the symbol, so the tamper is real.
//
// THE CHECK ORDER INSIDE `parseFavoritesBackup` IS LOAD-BEARING, not tidiness.
// `verifyEvent` THROWS rather than returning false on a `created_at` that is a
// string, a non-string tag value, or a pubkey outside /^[a-f0-9]{64}$/ — all
// measured. The structural gate, the kind test and the pubkey equality must
// stay ABOVE it or those inputs become an uncaught exception, which
// `<RestoreBackup>` reports as a file it could not read rather than as a file
// that was tampered with. Vectors below pin each of those three.
//
// FIXTURE PROVENANCE. The tag topology is lifted verbatim from
// `scripts/check-favsync.mjs`, which took it from a live kind:10333 — the
// unknown-medium head group, the `medium` block, the `k` trailer, and
// `thenogs-donkey-01-porky-piggin-it`, a real item guid that is not a UUID.
// Only the KEY is ours, because a stranger's signature cannot be made to match
// a pubkey this script can also hand to `parseFavoritesBackup` as
// `expectPubkey`. Signed once with two fixed throwaway secret keys
// (0x11..11 and 0x22..22) and pasted as literals: `finalizeEvent` uses random
// BIP-340 aux entropy, so a signature generated at run time is not
// reproducible and could not be committed.
//
// The fixtures are MINIFIED because that is also a real wire form — it is what
// a relay sends and what another tool's export looks like. `BACKUP_A_PRETTY` is
// the one exception: it is the shipping serializer's own output over
// `BACKUP_A`'s exact bytes, captured once, so the byte-exact assertion is
// against a frozen literal rather than against something rebuilt at run time.
//
// ONE naive() PER KIND, and the replay is TOTAL — every vector is a recorded
// `{ kind, args }` call and the runner walks the list, so a vector cannot be
// added without being proved. Must-still-work inputs are exempted ONE AT A TIME
// with `{ alsoNaive: true }`, never by default.
//
// Imports the REAL module under `node --experimental-strip-types`. That is what
// `lib/favorites-export.ts` carrying no aliased import buys, and the scan below
// is what keeps it — see the note on `BackupReadState.mode`.

// Set BEFORE the dynamic import, because `favoritesBackupFilename` reads the
// date with LOCAL-time getters. Without this the filename vectors pass in one
// timezone and fail in another, which is a check script that fails for the
// person who did not touch it.
process.env.TZ = 'UTC';

import { readFileSync } from 'node:fs';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ok    ' + msg);

// A future Node that resolved the zone before this body ran would make every
// filename vector machine-dependent, and the diff would look like a code bug.
// Fail here instead, with the reason.
{
  const t = new Date(1788305400 * 1000);
  if (t.getUTCDate() !== t.getDate() || t.getUTCHours() !== t.getHours()) {
    console.error('\n  ✗ TZ=UTC did not take effect — filename vectors would be machine-dependent.\n');
    process.exit(1);
  }
}

// ── the module must stay loadable under plain Node ─────────────────────────
// Run BEFORE the import, so a module that acquired an aliased dependency is
// reported as that rather than as an unreadable ERR_MODULE_NOT_FOUND stack.
// `allowBare: true`: `nostr-tools` resolves from node_modules, the same
// allowance `lib/v4v/nwc-errors.ts` has.
{
  const problems = importFreeProblems('lib/favorites-export.ts', { allowBare: true });
  if (problems.length) {
    explainImportFree('lib/favorites-export.ts', problems);
    console.error('\n  favorites-export.ts must load under plain Node or this script cannot pin it.\n');
    process.exit(1);
  }
}

const {
  backupRefusal, backupSummary, favoritesBackupFilename, parseFavoritesBackup,
  serializeFavoritesBackup, FAVORITES_BACKUP_KIND,
} = await import('../lib/favorites-export.ts');

// ---------------------------------------------------------------------------
// Fixtures — frozen wire, never a struct
// ---------------------------------------------------------------------------

const PK_A = '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa';
const PK_B = '466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27';

// 6 `i` tags, 5 favorites. The unknown-medium group, the music group and the
// podcast group are ITEMLESS and so are feed favorites; the fourth group holds
// two items and is a PLACEMENT group, which is not a favorite. That gap is the
// whole of `backupSummary`'s vector below.
const BACKUP_A = '{"id":"77d66b530b04e8a0c74f20bc50f31ef8c3796f65cd0ac73f31a2727bcbf0cb5c","pubkey":"4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa","created_at":1788264000,"kind":10333,"tags":[["alt","PC 2.0 Favorites"],["i","podcast:guid:791338e2-77bc-579e-8c7c-4c996cf73305"],["medium","music"],["i","podcast:guid:fce40d63-ef30-5c85-af07-d99b3c759807"],["i","podcast:guid:3ae5f2ba-1e0d-5b7f-9f6d-0f2c8e4a11bb"],["i","podcast:item:guid:fb279ed1-10ec-4060-967d-9af45c19505f"],["i","podcast:item:guid:thenogs-donkey-01-porky-piggin-it"],["i","podcast:guid:fafd2bfc-98ac-5010-9fcb-7403abfd420a"],["k","podcast:guid"],["k","podcast:item:guid"]],"content":"","sig":"707fd73d301a6c9d89ee5747e6d1b225d5341f1381f57b30c34dcd3a40d7c8fea7941c229fa4b7a1823743341ed6b36a8cfa468a5bee9d0b09daed2d485133ce"}';

// The same list with a private half beside the public one. Both at once is a
// real state; nothing in the format forbids it.
const BACKUP_A_BOTH = '{"id":"f687933e4040709e17c33c4231972ab0d4784b4a51fec43f524cf1160d2107c1","pubkey":"4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa","created_at":1788264000,"kind":10333,"tags":[["alt","PC 2.0 Favorites"],["i","podcast:guid:791338e2-77bc-579e-8c7c-4c996cf73305"],["medium","music"],["i","podcast:guid:fce40d63-ef30-5c85-af07-d99b3c759807"],["i","podcast:guid:3ae5f2ba-1e0d-5b7f-9f6d-0f2c8e4a11bb"],["i","podcast:item:guid:fb279ed1-10ec-4060-967d-9af45c19505f"],["i","podcast:item:guid:thenogs-donkey-01-porky-piggin-it"],["i","podcast:guid:fafd2bfc-98ac-5010-9fcb-7403abfd420a"],["k","podcast:guid"],["k","podcast:item:guid"]],"content":"AqFhZ8mKt3vXnR7bPwLdY2sQ9jH4cE6uT1gZ0aB5nM8kW3xV7yD2fJ4pS6rN9tC1==","sig":"e1325430d1c2cbd87d728d1496070f6f1b5801c486a4b69006d156f16c5faa313744ac6aae25d7e56ca178a8f5f5bed46a606797297ac2ee50fe92c98d4bd828"}';

// A FULLY private list: no `i` tags at all, everything in the ciphertext. This
// is the case `backupSummary`'s second sentence exists for — in a raw event
// this list looks empty.
const BACKUP_A_PRIVATE = '{"id":"c1713325b5465acbac12a206c747ec13a9b9ac7dc9a7d949f7b6e38377cd4b34","pubkey":"4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa","created_at":1788264000,"kind":10333,"tags":[["alt","PC 2.0 Favorites"],["visibility","private"],["k","podcast:guid"]],"content":"AqFhZ8mKt3vXnR7bPwLdY2sQ9jH4cE6uT1gZ0aB5nM8kW3xV7yD2fJ4pS6rN9tC1==","sig":"ac1c76be719db8df63d58d9bae7e40745555de20dcc4bcf04ce33395211bcc933332c81ff70955865840834f90e5b618ffb30af889ee4f1237f9b4a49f42e8f1"}';

const BACKUP_A_ONE = '{"id":"145396dadc788e2292713e68599289da80a382f42f05e0f5be1291b40c18a1c5","pubkey":"4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa","created_at":1788264000,"kind":10333,"tags":[["i","podcast:guid:fce40d63-ef30-5c85-af07-d99b3c759807"]],"content":"","sig":"a1c125db7f9f1b42d40e75b692bb6cab0ed06cd2868de24b65973740e13ff1e686d21dd5992cb277bdadfaf3d2570cd9693cc693c3dc06a3f65e4334acf5684a"}';

const BACKUP_A_NONE = '{"id":"a9510daaa56f589144a019f5e6ec091979d40319fad33078cd3f649d5ae026f8","pubkey":"4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa","created_at":1788264000,"kind":10333,"tags":[["alt","PC 2.0 Favorites"],["medium","music"]],"content":"","sig":"16b65384b47aeb47f976ec238d8acf3f250250bd611314bd333978a7e8c083fc6ddd7178f5f94f3f59c8894ae491146d7c9cf7866d70966c8b67cf950a370b1f"}';

// Genuinely signed, and valid — by SOMEBODY ELSE. Only the pubkey test refuses
// it, which is why it has to be a real signature rather than an edited file.
const BACKUP_B = '{"id":"5fb54e9f6d0586b37ef855b7c26872ff08f9f32f22202a4e7f344b7655aa2682","pubkey":"466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27","created_at":1788264000,"kind":10333,"tags":[["alt","PC 2.0 Favorites"],["i","podcast:guid:791338e2-77bc-579e-8c7c-4c996cf73305"],["medium","music"],["i","podcast:guid:fce40d63-ef30-5c85-af07-d99b3c759807"],["i","podcast:guid:3ae5f2ba-1e0d-5b7f-9f6d-0f2c8e4a11bb"],["i","podcast:item:guid:fb279ed1-10ec-4060-967d-9af45c19505f"],["i","podcast:item:guid:thenogs-donkey-01-porky-piggin-it"],["i","podcast:guid:fafd2bfc-98ac-5010-9fcb-7403abfd420a"],["k","podcast:guid"],["k","podcast:item:guid"]],"content":"","sig":"7c91a0ef2cb90c30958996a09942857bd125b17e6218b2ada109eb918b074f775cd8ce039148163f2e690541a41e5f691e74364d321f098d185a7c0fc18a9f9b"}';

// The other two replaceable events this app writes at the SAME pubkey. Right
// key, real signature: only the kind test stands between them and a publish
// that destroys both the settings and the favorites.
const SETTINGS_A = '{"id":"69d7710da079296407aca5afe61b75a6cbe87ba2270ccbc9af080628401194fe","pubkey":"4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa","created_at":1788264000,"kind":30078,"tags":[["d","boostmebitch:settings"]],"content":"","sig":"2cd09ce7d7263edc7b770dba0c0dab2a50b45580f719d2548c6bf43299fceebf5cb4fe4672bc3dd3614a88740e256ccfec8daa957ba6a2183d7c7013270ecff4"}';

const MUTES_A = '{"id":"149b83405ef6b0c3fca05972eed22638e150ad66ecb40855fc83b025f89257ee","pubkey":"4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa","created_at":1788264000,"kind":10000,"tags":[["p","466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"]],"content":"","sig":"6f0dae49740f742f2c69b1dcbadbca638304e36d7486c99d0c29c82694f15eb18f54fd46a7ae8a830c535909e06281c595165b7f833a676f2d77a918debf94db"}';

// 2026-09-01T23:30:00Z — late enough that a UTC+something reader rolls it to
// the next day. That is what the TZ probe above is protecting.
const EV_LATE = '{"id":"bfd922148f37868e09c0fd62cb2865af1cabd9e1b6d74512eb55af2f0790a1fa","pubkey":"4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa","created_at":1788305400,"kind":10333,"tags":[["alt","PC 2.0 Favorites"],["i","podcast:guid:791338e2-77bc-579e-8c7c-4c996cf73305"],["medium","music"],["i","podcast:guid:fce40d63-ef30-5c85-af07-d99b3c759807"],["i","podcast:guid:3ae5f2ba-1e0d-5b7f-9f6d-0f2c8e4a11bb"],["i","podcast:item:guid:fb279ed1-10ec-4060-967d-9af45c19505f"],["i","podcast:item:guid:thenogs-donkey-01-porky-piggin-it"],["i","podcast:guid:fafd2bfc-98ac-5010-9fcb-7403abfd420a"],["k","podcast:guid"],["k","podcast:item:guid"]],"content":"","sig":"8ccf42f13333f20429c3da2bf4310d42b6788b74b8cc413bc0cf4a27ca36202b45a187c7b681f527031d35a7f63137d5592fb65db7cc8b0d0e9fd888f86c696c"}';

// 2026-01-05 — a single-digit month AND day, so both pads are exercised.
const EV_JAN5 = '{"id":"2da26bb42416699456c16fea1dec8ce5ba53eefa313a4c14ad32e7bdbc21bff0","pubkey":"4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa","created_at":1767614400,"kind":10333,"tags":[["alt","PC 2.0 Favorites"],["i","podcast:guid:791338e2-77bc-579e-8c7c-4c996cf73305"],["medium","music"],["i","podcast:guid:fce40d63-ef30-5c85-af07-d99b3c759807"],["i","podcast:guid:3ae5f2ba-1e0d-5b7f-9f6d-0f2c8e4a11bb"],["i","podcast:item:guid:fb279ed1-10ec-4060-967d-9af45c19505f"],["i","podcast:item:guid:thenogs-donkey-01-porky-piggin-it"],["i","podcast:guid:fafd2bfc-98ac-5010-9fcb-7403abfd420a"],["k","podcast:guid"],["k","podcast:item:guid"]],"content":"","sig":"da7cfe5ed40cbc1335267da182193522baf9ffe8bd458803fd90ec64804530a3c18d639757d447066bd2d79e54401d419d9b06c643b4f70c0e9be895e5f31596"}';

// 2025-12-31 — the year rollover, which a `getMonth() + 1` slip turns into 13.
const EV_DEC31 = '{"id":"58f622986a138959c6edee22119bbcaeac381386e5de51023b7ed198693711fd","pubkey":"4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa","created_at":1767182400,"kind":10333,"tags":[["alt","PC 2.0 Favorites"],["i","podcast:guid:791338e2-77bc-579e-8c7c-4c996cf73305"],["medium","music"],["i","podcast:guid:fce40d63-ef30-5c85-af07-d99b3c759807"],["i","podcast:guid:3ae5f2ba-1e0d-5b7f-9f6d-0f2c8e4a11bb"],["i","podcast:item:guid:fb279ed1-10ec-4060-967d-9af45c19505f"],["i","podcast:item:guid:thenogs-donkey-01-porky-piggin-it"],["i","podcast:guid:fafd2bfc-98ac-5010-9fcb-7403abfd420a"],["k","podcast:guid"],["k","podcast:item:guid"]],"content":"","sig":"3f4bbbe57ef886aef90d0cf62abb5cb53ea6328aaf9908a74202a6a1747b74ebfb76011f5af2c693288ee526a861aa554401333232746808134bda03cdc97c14"}';

// The same calendar day as BACKUP_A, different bytes — so a different id, which
// is the only thing that keeps the two files apart on disk.
const EV_SAMEDAY_2 = '{"id":"9e4813c8f40d83e0d433456834448485f371417228a4a39d7c9f19324f88bc04","pubkey":"4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa","created_at":1788264060,"kind":10333,"tags":[["i","podcast:guid:fafd2bfc-98ac-5010-9fcb-7403abfd420a"]],"content":"","sig":"be50bdfa3eef0e9e45f639d6f9980e3dc14c80462955a3fe9a977fa28f2aacb7bcc184c9dcd056ebb5b3ef2aeab84243b53f92c58dc49cddd2fd08413f227a65"}';

// The shipping serializer's own output over BACKUP_A's exact bytes, captured
// once on 2026-09-03 and frozen here. Not a round trip built at run time — that
// is the assertion CLAUDE.md names as unable to fail. If the field set, the
// field ORDER, the indent or the trailing newline changes, this is what says so.
const BACKUP_A_PRETTY = `{
  "id": "77d66b530b04e8a0c74f20bc50f31ef8c3796f65cd0ac73f31a2727bcbf0cb5c",
  "pubkey": "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
  "created_at": 1788264000,
  "kind": 10333,
  "tags": [
    [
      "alt",
      "PC 2.0 Favorites"
    ],
    [
      "i",
      "podcast:guid:791338e2-77bc-579e-8c7c-4c996cf73305"
    ],
    [
      "medium",
      "music"
    ],
    [
      "i",
      "podcast:guid:fce40d63-ef30-5c85-af07-d99b3c759807"
    ],
    [
      "i",
      "podcast:guid:3ae5f2ba-1e0d-5b7f-9f6d-0f2c8e4a11bb"
    ],
    [
      "i",
      "podcast:item:guid:fb279ed1-10ec-4060-967d-9af45c19505f"
    ],
    [
      "i",
      "podcast:item:guid:thenogs-donkey-01-porky-piggin-it"
    ],
    [
      "i",
      "podcast:guid:fafd2bfc-98ac-5010-9fcb-7403abfd420a"
    ],
    [
      "k",
      "podcast:guid"
    ],
    [
      "k",
      "podcast:item:guid"
    ]
  ],
  "content": "",
  "sig": "707fd73d301a6c9d89ee5747e6d1b225d5341f1381f57b30c34dcd3a40d7c8fea7941c229fa4b7a1823743341ed6b36a8cfa468a5bee9d0b09daed2d485133ce"
}
`;

// Every tamper goes through JSON, never a spread — see the header.
const edit = (text, f) => { const e = JSON.parse(text); f(e); return JSON.stringify(e); };

const A_TAG_EDITED = edit(BACKUP_A, (e) => { e.tags[1][1] = 'podcast:guid:00000000-0000-4000-8000-000000000000'; });
const A_TAG_APPENDED = edit(BACKUP_A, (e) => { e.tags.push(['i', 'podcast:guid:11111111-1111-4111-8111-111111111111']); });
const A_TAG_REMOVED = edit(BACKUP_A, (e) => { e.tags.splice(1, 1); });
const A_CONTENT_EDITED = edit(BACKUP_A_PRIVATE, (e) => { e.content = `${e.content.slice(0, -4)}AAAA`; });
const A_TIME_BUMPED = edit(BACKUP_A, (e) => { e.created_at += 86_400; });
const A_ID_REHASHED = edit(BACKUP_A, (e) => {
  // The half-clever edit: change a tag AND recompute the id so the two agree.
  // Only the signature still disagrees, which is the point of having one.
  e.tags[1][1] = 'podcast:guid:00000000-0000-4000-8000-000000000000';
  e.id = 'b'.repeat(64);
});
const A_NO_SIG = edit(BACKUP_A, (e) => { delete e.sig; });
const A_TIME_STRING = edit(BACKUP_A, (e) => { e.created_at = String(e.created_at); });
const A_KIND_STRING = edit(BACKUP_A, (e) => { e.kind = String(e.kind); });
const A_CONTENT_NULL = edit(BACKUP_A, (e) => { e.content = null; });
const A_TAGS_STRING = edit(BACKUP_A, (e) => { e.tags = 'i'; });
const A_TAG_NUMBER = edit(BACKUP_A, (e) => { e.tags = [['i', 42]]; });
const A_TAG_NESTED = edit(BACKUP_A, (e) => { e.tags = [['i', ['x']]]; });
const A_PK_UPCASED = edit(BACKUP_A, (e) => { e.pubkey = e.pubkey.toUpperCase(); });
// An extra enumerable key, which is what nostr-tools hangs on a received event
// on some paths. It STILL verifies — the id is a hash over the six canonical
// fields only — so refusing it would be over-refusal on a real relay export.
const A_EXTRA_KEY = edit(BACKUP_A, (e) => { e.seenOn = ['wss://relay.damus.io']; });
const A_TRUNCATED = BACKUP_A.slice(0, 120);

// ---------------------------------------------------------------------------
// The messages, written out so a reword is a deliberate edit
// ---------------------------------------------------------------------------

const R_DEGRADED = 'the relays could not be read just now, so this would risk saving an older list than the one stored — try again in a moment';
const R_OFF = 'favorites are set to stay on this device, so nothing is stored on the relays to back up';
const R_NONE = 'no favorites list is stored on the relays for this account yet';
const E_NOT_JSON = 'that file is not JSON';
const E_NOT_EVENT = 'that file does not hold a Nostr event';
const E_MISSING = 'that file is missing fields a Nostr event must have';
const E_ACCOUNT = 'that backup belongs to a different Nostr account';
const E_TAGS = "that file's tags are malformed";
const E_SIG = "that backup's signature does not verify — it was edited, or it is not a real event";
const kindErr = (k) => `that is a kind:${k} event, not a favorites list`;

// ---------------------------------------------------------------------------
// The wrong versions — one per kind
// ---------------------------------------------------------------------------

const naive = {
  // "If there is an event, save it." What you write when the control looks like
  // a null check. It drops `trustworthy` entirely, so it writes a file from a
  // degraded read — an OLDER event than the relays now hold, indistinguishable
  // from a good one, which replaces the newer list the moment it is restored.
  // That is the exact loss the whole feature insures against. It also folds the
  // two absences together, so a user who chose "not on Nostr" is told their
  // list is missing rather than that they turned it off.
  refusal: (read) => (read.exists ? null : R_NONE),

  // "It parsed, so it is an event." Skips verifyEvent, the pubkey test and the
  // kind test at once — which is right, because each of the three has its own
  // vectors below and any one of them kills this. It also has no structural
  // gate, so where the real parser answers, this THROWS.
  parse: (text) => {
    try { return { ok: true, event: JSON.parse(text) }; }
    catch { return { ok: false, error: E_NOT_JSON }; }
  },

  // "Stringify the event." No field allowlist and no field order, so it writes
  // whatever key the relay library hung on the object, in whatever order the
  // object carries. The file is supposed to BE the event.
  serialize: (event) => `${JSON.stringify(event, null, 2)}\n`,

  // "Name it after today." Three mistakes the docstring exists to prevent:
  // today's date rather than the event's `created_at` (so an unchanged list
  // yields a new file every day), the whole 64-character id rather than 8, and
  // a hard-coded brand word that puts the other deploy's name on the
  // family-friendly site's file.
  filename: (event) => `boostmebitch-favorites-${new Date().toISOString().slice(0, 10)}-${event.id}.json`,

  // "Count the tags." Gets the singular right, which is what makes it tempting.
  // Every real kind:10333 carries `alt`, `medium` and `k` tags plus its
  // placement groups, so it over-counts on every live event; and it never
  // mentions the private half, so a fully private list reads as empty.
  summary: (event) => {
    const n = event.tags.length;
    return `saved ${n} public ${n === 1 ? 'entry' : 'entries'}`;
  },
};

// ---------------------------------------------------------------------------
// Vectors — recorded as CALLS, replayed totally
// ---------------------------------------------------------------------------

const vectors = [];
const vec = (kind, label, args, expect, o = {}) => vectors.push({ kind, label, args, expect, ...o });

// ── backupRefusal: all 2 x 2 x 4 combinations ──────────────────────────────
// `mode` has FOUR values, not three: `storage.favPrivacy.get` returns null for
// an account that has never been asked, and CLAUDE.md is explicit that "never
// chosen" must not be flattened to a default.
const MODES = [null, 'public', 'private', 'off'];

// Rows 1-8: an untrustworthy read refuses whatever else is true. Rows 5-8 are
// the expensive half — HAVING AN EVENT IN HAND IS NOT A LICENCE. The file that
// comes out of a degraded read looks perfect and destroys the list on restore.
for (const mode of MODES) {
  vec('refusal', `a degraded read refuses with no event (mode ${mode})`,
    [{ trustworthy: false, exists: false, mode }], R_DEGRADED);
  vec('refusal', `a degraded read refuses even WITH an event (mode ${mode})`,
    [{ trustworthy: false, exists: true, mode }], R_DEGRADED);
}

// Rows 9-12: a good read with an event always writes a file. `mode: 'off'` is
// the over-refusal guard — a user with an old public list who later chose "not
// on Nostr" has bytes on the relays and every reason to want a copy of them.
for (const mode of MODES) {
  vec('refusal', `a good read with an event writes a file (mode ${mode})`,
    [{ trustworthy: true, exists: true, mode }], null, { alsoNaive: true });
}

// Rows 13-16: a good read with no event. Only 'off' names a cause the user can
// act on; the rest say the list simply is not there.
for (const mode of [null, 'public', 'private']) {
  vec('refusal', `a good read with no event says none is stored (mode ${mode})`,
    [{ trustworthy: true, exists: false, mode }], R_NONE, { alsoNaive: true });
}
vec('refusal', "a good read with no event and mode 'off' names the reason",
  [{ trustworthy: true, exists: false, mode: 'off' }], R_OFF);

// ── parseFavoritesBackup ───────────────────────────────────────────────────
// Must still work. Over-refusal here is a user who cannot restore their list.
vec('parse', 'a genuine backup of this account parses',
  [BACKUP_A, PK_A], 'ok', { alsoNaive: true });
vec('parse', 'a fully private list parses — the ciphertext is the list',
  [BACKUP_A_PRIVATE, PK_A], 'ok', { alsoNaive: true });
vec('parse', 'an extra key from a relay export is not a reason to refuse',
  [A_EXTRA_KEY, PK_A], 'ok', { alsoNaive: true });
vec('parse', 'a truncated download is refused as not JSON',
  [A_TRUNCATED, PK_A], E_NOT_JSON, { alsoNaive: true });
vec('parse', 'an empty file is refused as not JSON',
  ['', PK_A], E_NOT_JSON, { alsoNaive: true });
vec('parse', 'a saved error page is refused as not JSON',
  ['<!doctype html><title>502</title>', PK_A], E_NOT_JSON, { alsoNaive: true });

// The signature. Each of these is a file somebody could plausibly produce.
vec('parse', 'an entry rewritten in a text editor fails the signature',
  [A_TAG_EDITED, PK_A], E_SIG);
vec('parse', 'an entry INJECTED into the list fails the signature',
  [A_TAG_APPENDED, PK_A], E_SIG);
vec('parse', 'an entry deleted from the list fails the signature',
  [A_TAG_REMOVED, PK_A], E_SIG);
vec('parse', 'an edited private half fails the signature — the half nobody eyeballs',
  [A_CONTENT_EDITED, PK_A], E_SIG);
vec('parse', 'a bumped created_at fails the signature',
  [A_TIME_BUMPED, PK_A], E_SIG);
vec('parse', 'recomputing the id does not rescue an edited list',
  [A_ID_REHASHED, PK_A], E_SIG);

// The pubkey. Both fixtures are genuinely signed, so ONLY this test refuses them.
vec('parse', "somebody else's genuine backup is refused",
  [BACKUP_B, PK_A], E_ACCOUNT);
vec('parse', 'the right file under the wrong signed-in account is refused',
  [BACKUP_A, PK_B], E_ACCOUNT);

// The kind. Right key, real signature: only this test stands in the way.
vec('parse', 'a kind:30078 settings backup is refused',
  [SETTINGS_A, PK_A], kindErr(30078));
vec('parse', 'a kind:10000 mute list is refused',
  [MUTES_A, PK_A], kindErr(10000));

// Shapes that are JSON but not an event.
vec('parse', 'a relay line saved as an array is refused', ['[]', PK_A], E_NOT_EVENT);
vec('parse', 'the literal null is refused', ['null', PK_A], E_NOT_EVENT);
vec('parse', 'a bare string is refused', ['"a string"', PK_A], E_NOT_EVENT);
vec('parse', 'a bare number is refused', ['42', PK_A], E_NOT_EVENT);
vec('parse', 'an empty object is refused', ['{}', PK_A], E_MISSING);

// The three inputs verifyEvent THROWS on. They reach a MESSAGE only because
// the structural gate, the kind test and the pubkey test all run above it.
vec('parse', 'a deleted sig is a missing field, not a crash',
  [A_NO_SIG, PK_A], E_MISSING);
vec('parse', 'a created_at written as a string is a missing field, not a crash',
  [A_TIME_STRING, PK_A], E_MISSING);
vec('parse', 'a kind written as a string is a missing field, not a crash',
  [A_KIND_STRING, PK_A], E_MISSING);
vec('parse', 'a null content is a missing field, not a crash',
  [A_CONTENT_NULL, PK_A], E_MISSING);
vec('parse', 'tags written as a string is a missing field, not a crash',
  [A_TAGS_STRING, PK_A], E_MISSING);
vec('parse', 'a numeric tag value is malformed tags, not a crash',
  [A_TAG_NUMBER, PK_A], E_TAGS);
vec('parse', 'a nested tag value is malformed tags, not a crash',
  [A_TAG_NESTED, PK_A], E_TAGS);
vec('parse', 'an upcased pubkey is a different account, not a crash',
  [A_PK_UPCASED, PK_A], E_ACCOUNT);

// ── serializeFavoritesBackup ───────────────────────────────────────────────
vec('serialize', 'the file is byte-identical to the frozen fixture',
  [JSON.parse(BACKUP_A)], BACKUP_A_PRETTY, { alsoNaive: true });
vec('serialize', 'an extra relay-library key is DROPPED — the file must BE the event',
  [JSON.parse(A_EXTRA_KEY)], BACKUP_A_PRETTY);
vec('serialize', 'a private half rides through as ciphertext, never decrypted',
  [JSON.parse(BACKUP_A_PRIVATE)],
  `${JSON.stringify(JSON.parse(BACKUP_A_PRIVATE), null, 2)}\n`, { alsoNaive: true });

// ── favoritesBackupFilename ────────────────────────────────────────────────
const ID_A8 = '77d66b53';
vec('filename', 'the bmb deploy names its own file',
  [JSON.parse(BACKUP_A), 'boostmebitch.com'], `boostmebitch-favorites-2026-09-01-${ID_A8}.json`);
vec('filename', 'the buddy deploy names ITS own file, from the same event',
  [JSON.parse(BACKUP_A), 'boostmebuddy.com'], `boostmebuddy-favorites-2026-09-01-${ID_A8}.json`);
vec('filename', 'a single-digit month and day are both padded',
  [JSON.parse(EV_JAN5), 'boostmebitch.com'], 'boostmebitch-favorites-2026-01-05-2da26bb4.json');
vec('filename', 'the year rolls over correctly',
  [JSON.parse(EV_DEC31), 'boostmebitch.com'], 'boostmebitch-favorites-2025-12-31-58f62298.json');
vec('filename', 'two lists written on one day differ by id',
  [JSON.parse(EV_SAMEDAY_2), 'boostmebitch.com'], 'boostmebitch-favorites-2026-09-01-9e4813c8.json');
vec('filename', 'a late-evening event keeps the event\'s own date under TZ=UTC',
  [JSON.parse(EV_LATE), 'boostmebitch.com'], `boostmebitch-favorites-2026-09-01-bfd92214.json`);
vec('filename', 'a dotless host still yields a first label',
  [JSON.parse(BACKUP_A), 'localhost'], `localhost-favorites-2026-09-01-${ID_A8}.json`);

// ── backupSummary ──────────────────────────────────────────────────────────
// THE defect this script was written against. BACKUP_A carries SIX `i` tags and
// FIVE favorites: one of its four groups holds items and is a placement group,
// not something the user chose. Counting tags told them they had saved more
// than they have — measured at 217 against a true 56 on the reference account.
vec('summary', 'a placement group is NOT counted as a favorite',
  [JSON.parse(BACKUP_A), 5], 'saved 5 public entries');
vec('summary', 'one favorite is an entry, not entries',
  [JSON.parse(BACKUP_A_ONE), 1], 'saved 1 public entry', { alsoNaive: true });
vec('summary', 'zero favorites is plural',
  [JSON.parse(BACKUP_A_NONE), 0], 'saved 0 public entries');
vec('summary', 'a fully private list is not reported as empty',
  [JSON.parse(BACKUP_A_PRIVATE), 0],
  'saved 0 public entries, plus a private half that stays encrypted in the file');
vec('summary', 'both halves at once are both reported',
  [JSON.parse(BACKUP_A_BOTH), 5],
  'saved 5 public entries, plus a private half that stays encrypted in the file');

// ---------------------------------------------------------------------------
// The replay — total, and it refuses a kind with no naive()
// ---------------------------------------------------------------------------

const real = {
  refusal: backupRefusal,
  parse: parseFavoritesBackup,
  serialize: serializeFavoritesBackup,
  filename: favoritesBackupFilename,
  summary: backupSummary,
};

// `parse` is compared on its VERDICT, not on the event object: a vector that
// asserted the parsed struct would be asserting JSON.parse, and the whole
// question here is which files are accepted and why the others are not.
function normalize(kind, out) {
  if (kind !== 'parse') return out;
  return out.ok ? 'ok' : out.error;
}

function callOne(impls, v) {
  const fn = impls[v.kind];
  if (!fn) return `NO IMPLEMENTATION for kind "${v.kind}"`;
  try { return JSON.stringify(normalize(v.kind, fn(...v.args))); }
  catch (e) { return `THREW: ${e instanceof Error ? e.message : String(e)}`; }
}

console.log('\n  favorites backup file — refusal, bytes, name, summary, parse\n');
let section = '';
for (const v of vectors) {
  if (v.kind !== section) { section = v.kind; console.log(`  — ${section} —`); }
  const got = callOne(real, v);
  const want = JSON.stringify(v.expect);
  if (got !== want) {
    fail(`${v.label}\n          got  ${got}\n          want ${want}`);
    continue;
  }
  if (v.alsoNaive) { ok(`${v.label} (must-still-work — naive() may agree)`); continue; }
  if (callOne(naive, v) === got) {
    fail(`"${v.label}" passes against naive() too — the vector proves nothing.\n`
      + '          Either it is a must-still-work input (mark it { alsoNaive: true })\n'
      + `          or it does not exercise what ${v.kind} is here to get right.`);
    continue;
  }
  ok(`${v.label} — and naive() gets it wrong`);
}
console.log(`\n  ${vectors.length} vector(s) replayed, `
  + `${vectors.filter((v) => v.alsoNaive).length} exempt as must-still-work\n`);

// ---------------------------------------------------------------------------
// Properties a vector table cannot state
// ---------------------------------------------------------------------------

console.log('  properties\n');
const eq = (label, got, want) => (JSON.stringify(got) === JSON.stringify(want)
  ? ok(label)
  : fail(`${label}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`));
const yes = (label, cond) => (cond ? ok(label) : fail(label));

// The file must BE the event: seven fields, in NIP-01 order, and nothing else.
eq('exactly the seven NIP-01 fields, in order',
  Object.keys(JSON.parse(serializeFavoritesBackup(JSON.parse(A_EXTRA_KEY)))),
  ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig']);

const OUT_A = serializeFavoritesBackup(JSON.parse(BACKUP_A));
yes('the file ends with exactly one newline', OUT_A.endsWith('\n') && !OUT_A.endsWith('\n\n'));
yes('the file is indented two spaces', OUT_A.includes('\n  "pubkey"'));

// An EXTERNAL oracle — verifyEvent inside the real parser, not our own field
// list. Re-serializing must not disturb the signature, or a backup is a file
// that cannot be restored.
yes('serializing does not break the signature',
  parseFavoritesBackup(serializeFavoritesBackup(JSON.parse(BACKUP_A)), PK_A).ok === true);

// The refusals are rendered as `no backup written — ${text}`, and the parse
// errors as `Not restored — ${error}.`, so each must read as a fragment.
const MESSAGES = [R_DEGRADED, R_OFF, R_NONE, E_NOT_JSON, E_NOT_EVENT, E_MISSING, E_ACCOUNT, E_TAGS, E_SIG];
yes('every refusal is a lowercase fragment with no trailing period',
  MESSAGES.every((m) => m[0] === m[0].toLowerCase() && !m.endsWith('.') && m.length > 15));

// The filename lands in `a.download`. A slash or a newline there is a path escape.
const NAMES = [
  favoritesBackupFilename(JSON.parse(BACKUP_A), 'boostmebitch.com'),
  favoritesBackupFilename(JSON.parse(BACKUP_A), 'boostmebuddy.com'),
  favoritesBackupFilename(JSON.parse(EV_LATE), 'boostmebitch.com'),
];
yes('every filename is a safe single path segment',
  NAMES.every((n) => /^[a-z0-9][a-z0-9.-]*\.json$/.test(n)));
yes('the date is the EVENT\'s, never today\'s',
  !NAMES[0].includes(new Date().toISOString().slice(0, 10)));
yes('two downloads of an unchanged list produce the same name',
  favoritesBackupFilename(JSON.parse(BACKUP_A), 'boostmebitch.com')
  === favoritesBackupFilename(JSON.parse(BACKUP_A), 'boostmebitch.com'));
yes('two lists written the same day produce different names',
  favoritesBackupFilename(JSON.parse(BACKUP_A), 'boostmebitch.com')
  !== favoritesBackupFilename(JSON.parse(EV_SAMEDAY_2), 'boostmebitch.com'));
yes('the two deploys never write the same filename for one event',
  NAMES[0] !== NAMES[1]);

// The kind is a named constant so the parser cannot drift from it. Asserted,
// not asserted ABOUT: if the parser stopped reading it, one of these would let
// a neighbouring kind through.
eq('the backup kind is 10333', FAVORITES_BACKUP_KIND, 10333);
yes('the parser is actually gated on that constant',
  !parseFavoritesBackup(edit(BACKUP_A, (e) => { e.kind = FAVORITES_BACKUP_KIND + 1; }), PK_A).ok
  && !parseFavoritesBackup(edit(BACKUP_A, (e) => { e.kind = FAVORITES_BACKUP_KIND - 1; }), PK_A).ok);

// `BackupReadState.mode` spells the union out rather than importing
// `FavoritesPrivacy`, because an aliased import — even a type-only one — is
// what stops this module loading under plain Node. A fourth mode would fail
// `tsc` at the call site; this makes the coupling visible from the check that
// pins the refusal table, so a new mode cannot arrive without a vector.
yes('FavoritesPrivacy is still the three modes BackupReadState mirrors',
  readFileSync('lib/nostr/favorites-list.ts', 'utf8')
    .includes("export type FavoritesPrivacy = 'public' | 'private' | 'off';"));

// The spread trap, asserted rather than only described — so a nostr-tools bump
// that changed the memoization cannot quietly make the header's warning stale
// while the tamper vectors above go on passing for the wrong reason.
yes('a JSON round trip really does drop the memoized verification symbol',
  Object.getOwnPropertySymbols(JSON.parse(BACKUP_A)).length === 0);

console.log(failures
  ? `\n${failures} favorites-backup check(s) FAILED.\n`
  : '\nAll favorites-backup checks passed.\n');
process.exit(failures ? 1 : 0);
