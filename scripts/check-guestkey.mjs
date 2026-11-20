// Pins lib/community/guest-key.ts — the random key that lets someone with no Nostr
// account make a community playlist and edit it again in the same browser.
//
// Usage:
//   npm run check:guestkey
//
// WHAT BREAKS SILENTLY HERE. The key is a credential for editing and deleting
// other people's-looking public playlists, and it lives in a browser the site does
// not control. The faults that matter leave no error:
//   - the key written as a string anywhere (localStorage, a log, a URL, an
//     error): any bug report, export or script that walks storage then carries it;
//   - a failed READ treated as "no key", so the stored key is overwritten and every
//     playlist it made can never be edited again;
//   - two tabs each making a key, so the playlists split across two owners;
//   - a tampered or truncated record signing with something other than the key.
// Each vector is replayed against `naive()`, the obvious version, and must prove it wrong.
//
// The module is loaded for real under Node. `indexedDB` is a small fake that
// structured-clones nothing but records every write, and `crypto.getRandomValues`
// is wrapped to record every 32-byte draw, so the secret can be found again and
// searched for in everything the module stored: hex, base64, nsec, raw bytes.
// A browser run (real IndexedDB, real network) is scripts/e2e-guest-playlist.mjs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyEvent, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failed = 0;
const fail = (m) => { console.error('  ✗ ' + m); failed++; };
const ok = (m) => console.log('  ok   ' + m);
const check = (name, cond) => (cond ? ok(name) : fail(name));

{
  const p = importFreeProblems('lib/community/guest-key.ts', { allowBare: true });
  if (p.length) { explainImportFree('lib/community/guest-key.ts', p); failed++; } else ok('lib/community/guest-key.ts imports bare npm packages only');
}

// ── the fake IndexedDB ──────────────────────────────────────────────────────
function fakeIdb(opts = {}) {
  const db = { records: new Map(), puts: 0, gets: 0 };
  const clone = (v) => ({ ...v, iv: v.iv && new Uint8Array(v.iv), ct: v.ct && v.ct.slice(0) });
  const later = (fn) => setTimeout(fn, 0);
  return {
    state: db,
    indexedDB: {
      open() {
        const req = {};
        later(() => {
          const handle = {
            objectStoreNames: { contains: () => true },
            createObjectStore() {},
            close() {},
            transaction(_name, mode) {
              const tx = {};
              let pending = 0;
              const settle = () => { if (--pending === 0) later(() => tx.oncomplete?.()); };
              tx.objectStore = () => ({
                get(key) {
                  const r = {};
                  pending++;
                  later(() => {
                    db.gets++;
                    if (opts.failGet) { r.onerror?.(); tx.onerror?.(); return; }
                    r.result = db.records.has(key) ? clone(db.records.get(key)) : undefined;
                    r.onsuccess?.();
                    settle();
                  });
                  return r;
                },
                put(value) {
                  if (mode !== 'readwrite') throw new Error('read-only transaction');
                  db.puts++;
                  db.records.set(value.id, clone(value));
                  return {};
                },
              });
              return tx;
            },
          };
          req.result = handle;
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req;
      },
    },
  };
}

// ── spy on encrypt(), so the secret can be found again ──────────────────────
// nostr-tools draws more than 32 random bytes and reduces them mod n, so the secret
// is not any one draw. The module hands the 32 secret bytes to AES-GCM encrypt():
// copy what it is given, and the scans below search for the REAL secret.
const draws = [];
const realEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
const realGet = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
Object.defineProperty(globalThis.crypto.subtle, 'encrypt', {
  configurable: true,
  value: (alg, key, data) => {
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    if (bytes.byteLength === 32) draws.push(new Uint8Array(bytes));
    return realEncrypt(alg, key, data);
  },
});

const modUrl = pathToFileURL(join(process.cwd(), 'lib/community/guest-key.ts')).href;
let n = 0;
const load = () => import(`${modUrl}?v=${++n}`); // a fresh module instance, as a reload is

const hex = (b) => Buffer.from(b).toString('hex');
/** Every form the secret could be written in. */
const forms = (sk) => [hex(sk), Buffer.from(sk).toString('base64'), Buffer.from(sk).toString('base64url'), nsecEncode(sk)];
const bytesHaving = (hay, sk) => {
  const h = hay instanceof ArrayBuffer ? new Uint8Array(hay) : hay;
  return Buffer.from(h).includes(Buffer.from(sk));
};
/** Does `record` hold the secret in any form, in any field? */
function leaks(record, sk) {
  const text = JSON.stringify(record, (_k, v) => (v instanceof Uint8Array || v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)).join(',') : v));
  const bytes = [record.iv, record.ct].filter(Boolean);
  return forms(sk).some((f) => text.includes(f)) || bytes.some((b) => bytesHaving(b, sk));
}
const secretFor = (pubkey) => draws.find((d) => { try { return getPublicKey(d) === pubkey; } catch { return false; } });

// ── 1. storage unavailable: a memory-only key, and it still signs ───────────
console.log('\nno IndexedDB: a memory-only key');
{
  delete globalThis.indexedDB;
  const g = await load();
  check('no key before ensure', (await g.loadGuestKey()) === null);
  const k = await g.ensureGuestKey();
  check('ensure resolves with persisted:false', k.persisted === false && /^[0-9a-f]{64}$/.test(k.pubkey) && k.npub.startsWith('npub1'));
  check('a second ensure returns the same key', (await g.ensureGuestKey()).pubkey === k.pubkey);
  const e = await g.signAsGuest({ kind: 27235, created_at: 1, tags: [['u', 'https://x/']], content: '' });
  check('the memory key signs a valid event for its pubkey', verifyEvent(e) && e.pubkey === k.pubkey);
  g.forgetMemoryGuestKey();
}

// ── 2. normal: create, keep, reload, sign ───────────────────────────────────
console.log('\ncreate, keep, reload');
{
  const fake = fakeIdb();
  globalThis.indexedDB = fake.indexedDB;
  const g1 = await load();
  check('before ensure there is no key', (await g1.loadGuestKey()) === null && fake.state.puts === 0);
  const k = await g1.ensureGuestKey();
  check('ensure resolves with persisted:true', k.persisted === true && /^[0-9a-f]{64}$/.test(k.pubkey));
  check('exactly one record was written', fake.state.records.size === 1 && fake.state.puts === 1);
  const rec = fake.state.records.get('playlist-v1');
  const sk = secretFor(k.pubkey);
  check('the secret was found again (the encrypt() spy caught it, so the scans below can mean something)', !!sk);
  check('the record holds no secret in any form: hex, base64, nsec, raw bytes', sk && !leaks(rec, sk));
  check('the record has the public key, an iv, a 48-byte ciphertext and a non-extractable AES key',
    rec.pubkey === k.pubkey && rec.iv.byteLength === 12 && rec.ct.byteLength === 48
    && rec.wrap.extractable === false && rec.wrap.algorithm.name === 'AES-GCM');
  check('JSON.stringify of the record shows no key material', !JSON.stringify(rec).includes(hex(sk)));
  let exported = true;
  try { await crypto.subtle.exportKey('raw', rec.wrap); } catch { exported = false; }
  check('the wrapping key cannot be exported', exported === false);

  const g2 = await load(); // a reload: a new module instance, the same storage
  const again = await g2.loadGuestKey();
  check('after a reload loadGuestKey finds the same key', again?.pubkey === k.pubkey && again.persisted === true);
  check('ensure after a reload does not make a second key', (await g2.ensureGuestKey()).pubkey === k.pubkey && fake.state.records.size === 1 && fake.state.puts === 1);
  const e = await g2.signAsGuest({ kind: 27235, created_at: 2, tags: [['method', 'POST']], content: '' });
  check('the stored key signs a valid event for its pubkey', verifyEvent(e) && e.pubkey === k.pubkey);
  check('the signed event carries no secret', !forms(sk).some((f) => JSON.stringify(e).includes(f)));
  check('the signer exposes signEvent and nothing else', Object.keys(g2.guestSigner).join() === 'signEvent');
}

// ── 3. a read that fails or cannot be read never overwrites ─────────────────
console.log('\nnever overwrite a key it could not read');
{
  const failing = fakeIdb({ failGet: true });
  failing.state.records.set('playlist-v1', { id: 'playlist-v1', pubkey: 'a'.repeat(64) });
  globalThis.indexedDB = failing.indexedDB;
  const g = await load();
  const k = await g.ensureGuestKey();
  check('a failed read gives a memory-only key and writes nothing', k.persisted === false && failing.state.puts === 0);
  g.forgetMemoryGuestKey();

  const bad = fakeIdb();
  bad.state.records.set('playlist-v1', { id: 'playlist-v1', pubkey: 'zz', iv: new Uint8Array(3) });
  globalThis.indexedDB = bad.indexedDB;
  const g2 = await load();
  const k2 = await g2.ensureGuestKey();
  check('an unreadable record gives a memory-only key and is left as it was', k2.persisted === false && bad.state.puts === 0 && bad.state.records.get('playlist-v1').pubkey === 'zz');
  check('and loadGuestKey does not call it a key', (await (await load()).loadGuestKey()) === null);
  g2.forgetMemoryGuestKey();
}

// ── 4. two tabs at once: one key ────────────────────────────────────────────
console.log('\ntwo tabs, one key');
{
  const fake = fakeIdb();
  globalThis.indexedDB = fake.indexedDB;
  const [a, b] = await Promise.all([load(), load()]);
  const [ka, kb] = await Promise.all([a.ensureGuestKey(), b.ensureGuestKey()]);
  check('both tabs end up with the same key', ka.pubkey === kb.pubkey);
  check('one record is stored', fake.state.records.size === 1 && fake.state.records.get('playlist-v1').pubkey === ka.pubkey);
  const e = await a.signAsGuest({ kind: 27235, created_at: 3, tags: [], content: '' });
  check('the loser of the race signs with the stored key', e.pubkey === ka.pubkey && verifyEvent(e));
}

// ── 5. a tampered record signs nothing ──────────────────────────────────────
console.log('\ntampering');
{
  const fake = fakeIdb();
  globalThis.indexedDB = fake.indexedDB;
  const g = await load();
  const k = await g.ensureGuestKey();
  const sk = secretFor(k.pubkey);
  const rec = fake.state.records.get('playlist-v1');
  new Uint8Array(rec.ct)[0] ^= 1;
  let msg = null;
  try { await (await load()).signAsGuest({ kind: 1, created_at: 1, tags: [], content: '' }); } catch (e) { msg = String(e?.message); }
  check('a flipped ciphertext bit rejects, with a fixed message', msg === 'guest key unusable');
  check('the message holds no secret', msg !== null && !forms(sk).some((f) => msg.includes(f)));
  // The pubkey is the AES-GCM additional data: a record whose pubkey was swapped fails too.
  new Uint8Array(rec.ct)[0] ^= 1;
  rec.pubkey = getPublicKey(realGet(new Uint8Array(32)));
  let swapped = null;
  try { await (await load()).signAsGuest({ kind: 1, created_at: 1, tags: [], content: '' }); } catch (e) { swapped = String(e?.message); }
  check('a swapped public key rejects (it is bound into the ciphertext)', swapped === 'guest key unusable');
  globalThis.indexedDB = fakeIdb().indexedDB;
  let none = null;
  try { await (await load()).signAsGuest({ kind: 1, created_at: 1, tags: [], content: '' }); } catch (e) { none = String(e?.message); }
  check('with no key at all, signing rejects with a fixed message', none === 'no guest key');
}

// ── 6. the source never gives the key a string form ─────────────────────────
console.log('\nthe source');
{
  const src = readFileSync('lib/community/guest-key.ts', 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const forbidden = ['nsecEncode', 'bytesToHex', 'localStorage', 'sessionStorage', 'document.cookie', 'console.log', 'console.error', 'JSON.stringify', 'fetch(', 'location', 'btoa', 'toString(16)'];
  for (const f of forbidden) check(`guest-key.ts never uses ${f}`, !code.includes(f));
  const warns = [...code.matchAll(/console\.warn\(([^)]*)\)/g)].map((m) => m[1]);
  check('every console.warn is a literal prefix plus a fixed word', warns.length > 0 && warns.every((w) => /^'\[guest-key\]', what$/.test(w.trim())));
  check('and every warn() call passes a string literal', [...code.matchAll(/(?<![.\w])warn\(([^)]*)\)/g)].every((m) => /^'[^']*'$/.test(m[1].trim())));
  check('the secret is generated as bytes (generateSecretKey) and never decoded from a string', code.includes('generateSecretKey()') && !code.includes('hexToBytes'));
  const importLines = src.split('\n').filter((l) => /^import /.test(l));
  check('it imports only nostr-tools', importLines.every((l) => /from 'nostr-tools\//.test(l)));
}

// ── 7. nothing else can reach the key ───────────────────────────────────────
console.log('\nwho may import it');
{
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (['node_modules', '.next', '.git'].includes(f)) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
  const importers = ['lib', 'components', 'app'].flatMap(walk)
    .filter((p) => /from ['"][^'"]*\/guest-key['"]/.test(readFileSync(p, 'utf8')) && !p.endsWith('guest-key.ts'));
  const allowed = new Set([
    'lib/community/use-guest-key.ts', 'components/community/playlist-maker.tsx',
  ]);
  const stray = importers.filter((p) => !allowed.has(p));
  check('only the hook and the maker import guest-key', stray.length === 0 && importers.length > 0);
  if (stray.length) console.error('    stray: ' + stray.join(', '));
  const reachNostr = ['lib/nostr', 'components/nostr-auth'].flatMap(walk).filter((p) => /guest-key|guestSigner|signAsGuest/.test(readFileSync(p, 'utf8')));
  check('nothing under lib/nostr or components/nostr-auth names the guest key (it is never the identity)', reachNostr.length === 0);
  const installed = ['lib', 'components', 'app'].flatMap(walk).filter((p) => /window\.nostr\s*=[^=][^\n]*guest/i.test(readFileSync(p, 'utf8')));
  check('the guest signer is never assigned to window.nostr', installed.length === 0);
}

// ── 8. the checks bite: the obvious version fails them ──────────────────────
console.log('\nnaive() — the version this exists to stop');
{
  // The obvious wrong version: keep the key as hex in a record, or write it to localStorage.
  const sk = realGet(new Uint8Array(32));
  const naiveRecord = { id: 'playlist-v1', pubkey: getPublicKey(sk), sk: hex(sk) };
  check('the leak scan flags a hex secret in a record (can fail)', leaks(naiveRecord, sk));
  check('the leak scan flags an nsec in a record (can fail)', leaks({ id: 'x', key: nsecEncode(sk) }, sk));
  check('the leak scan flags raw bytes in ct (can fail)', leaks({ id: 'x', ct: sk.buffer.slice(0) }, sk));
  const naiveSrc = "import { nsecEncode } from 'nostr-tools/nip19'; localStorage.setItem('k', nsecEncode(sk)); console.log(sk);";
  check('the source scan flags localStorage, nsecEncode and console.log (can fail)', ['localStorage', 'nsecEncode', 'console.log'].every((f) => naiveSrc.includes(f)));
}

if (failed) { console.error(`\n${failed} guest-key check(s) failed`); process.exit(1); }
console.log('\nall ok');
