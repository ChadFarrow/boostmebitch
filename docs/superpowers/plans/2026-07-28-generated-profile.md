# Generated Profile for Google Sign-Ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Google-onboarded account a display name and avatar derived from its own pubkey, published as a kind:0 so the user is recognizable in every Nostr client, not just this one.

**Architecture:** Two pure functions map a pubkey to a name and an inline SVG identicon. A best-effort provisioning module publishes that as a kind:0 on the **new-account branch only**, mirroring `provision-spark.ts`. Nothing is derived from the Google account, so the npub stays unlinked to a real-world identity.

**Tech Stack:** TypeScript (strict), Next.js App Router, `nostr-tools` (pinned exactly `2.19.4`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-28-generated-profile-design.md`

## Global Constraints

- **No new dependencies.** Everything needed is already present.
- **No test runner exists in this repo.** Verification is `npm run typecheck`, `npm run lint`, `next build`, plus throwaway Node scripts in the scratchpad directory. Where this plan says "write the failing test", it means a Node verification script — the red/green cycle still applies.
- **Never run `npm run build` while `next dev` is running.** The build writes production artifacts into `.next` and the running dev server then serves a chunk manifest that doesn't match, producing chunk-load timeouts. Stop the dev server first.
- **`lib/nostr/*` is browser-only.** Files carry `'use client'`. `btoa` is available; `Buffer` is not.
- **Publish only on the new-account branch.** kind:0 is replaceable — publishing on restore would overwrite a profile the user set in another client.
- Comment density matches the surrounding code: explain *why*, not *what*.

---

### Task 1: Deterministic name + avatar generation

**Files:**
- Create: `lib/nostr/profile-words.ts`
- Create: `lib/nostr/generated-profile.ts`
- Verify: `<scratchpad>/generated-profile-check.mjs` (throwaway, not committed)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `generatedName(pubkey: string): string` — e.g. `"Amber Otter"`
  - `generatedAvatarDataUri(pubkey: string): string` — `data:image/svg+xml;base64,…`
  - `buildGeneratedProfile(pubkey: string): { name: string; display_name: string; picture: string }`
  - `ADJECTIVES: readonly string[]`, `NOUNS: readonly string[]` (128 each)

- [ ] **Step 1: Write the verification script**

Create `<scratchpad>/generated-profile-check.mjs`. It imports the built module via `tsx`-free plain JS by duplicating nothing — instead run it against the TypeScript through `npx tsx`. If `tsx` is unavailable, transpile mentally is NOT acceptable; instead temporarily copy the two files' logic into the script. Prefer: `npx --yes tsx <scratchpad>/generated-profile-check.mjs`.

```js
import { generatedName, generatedAvatarDataUri, buildGeneratedProfile } from '/Users/chad-mini/Vibe/boostmebitch/lib/nostr/generated-profile.ts';
import { ADJECTIVES, NOUNS } from '/Users/chad-mini/Vibe/boostmebitch/lib/nostr/profile-words.ts';

const randPk = () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
let fail = 0;
const check = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`); if (!cond) fail++; };

check('128 adjectives', ADJECTIVES.length === 128);
check('128 nouns', NOUNS.length === 128);
check('no duplicate adjectives', new Set(ADJECTIVES).size === 128);
check('no duplicate nouns', new Set(NOUNS).size === 128);

const pk = 'a'.repeat(64);
check('name is deterministic', generatedName(pk) === generatedName(pk));
check('avatar is deterministic', generatedAvatarDataUri(pk) === generatedAvatarDataUri(pk));
check('name is two capitalised words', /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(generatedName(pk)));
check('no undefined in name', !generatedName(pk).includes('undefined'));

// Every pubkey must produce a valid, non-degenerate avatar under budget.
let maxLen = 0, minCells = 99, maxCells = 0, distinctNames = new Set();
for (let i = 0; i < 1000; i++) {
  const p = randPk();
  distinctNames.add(generatedName(p));
  const uri = generatedAvatarDataUri(p);
  if (!uri.startsWith('data:image/svg+xml;base64,')) { check('uri prefix', false); break; }
  const svg = Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
  if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) { check('valid svg', false); break; }
  const cells = (svg.match(/<rect/g) || []).length - 1; // minus the background rect
  minCells = Math.min(minCells, cells); maxCells = Math.max(maxCells, cells);
  maxLen = Math.max(maxLen, uri.length);
}
check(`avatar under 1.5KB (max ${maxLen})`, maxLen < 1536);
check(`never blank (min cells ${minCells})`, minCells >= 3);
check(`never solid (max cells ${maxCells})`, maxCells <= 24);
check(`names spread out (${distinctNames.size} distinct of 1000)`, distinctNames.size > 700);

const prof = buildGeneratedProfile(pk);
check('profile has all three fields', !!prof.name && prof.display_name === prof.name && !!prof.picture);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx --yes tsx <scratchpad>/generated-profile-check.mjs`
Expected: FAIL — cannot resolve `lib/nostr/generated-profile.ts` (module does not exist yet).

- [ ] **Step 3: Create the word lists**

Create `lib/nostr/profile-words.ts`. Exactly 128 entries each, all lowercase, all neutral in isolation *and* in combination — the pairing is uncontrolled, so anything that could read badly next to an arbitrary noun is out.

```ts
// Word lists for the generated display names on Google-onboarded accounts
// (see generated-profile.ts). 128 x 128 = 16,384 pairs.
//
// The name carries no discriminator suffix, so collisions are visible when two
// users land on the same pair. 128-entry lists are the mitigation: 64 x 64
// would collide roughly 16x more often for the same cosmetic benefit.
//
// Screen additions for how they read NEXT TO an arbitrary noun, not just on
// their own — the pairing is uncontrolled.

export const ADJECTIVES: readonly string[] = [
  'amber', 'azure', 'bold', 'brave', 'bright', 'breezy', 'calm', 'candid',
  'cheerful', 'clever', 'coral', 'cosmic', 'cozy', 'crimson', 'crystal', 'curious',
  'daring', 'dapper', 'dawn', 'deep', 'dusky', 'eager', 'early', 'electric',
  'emerald', 'ember', 'fabled', 'fair', 'fearless', 'fleet', 'floating', 'frosty',
  'genial', 'gentle', 'gilded', 'glad', 'gleaming', 'golden', 'grand', 'happy',
  'hidden', 'honest', 'humble', 'ivory', 'jade', 'jolly', 'keen', 'kind',
  'lively', 'lucid', 'lunar', 'marble', 'mellow', 'merry', 'midnight', 'mighty',
  'misty', 'modest', 'noble', 'northern', 'olive', 'opal', 'patient', 'pearl',
  'plucky', 'polar', 'proud', 'purple', 'quick', 'quiet', 'radiant', 'rapid',
  'ready', 'restless', 'rising', 'roaming', 'rosy', 'royal', 'ruby', 'rustic',
  'sage', 'sapphire', 'scarlet', 'serene', 'sharp', 'shining', 'silent', 'silver',
  'simple', 'sleepy', 'smooth', 'snowy', 'solar', 'southern', 'sparkling', 'spirited',
  'spry', 'steady', 'stellar', 'stormy', 'sturdy', 'sunny', 'sunlit', 'swift',
  'tawny', 'tender', 'thoughtful', 'tidal', 'tiny', 'tranquil', 'true', 'twilight',
  'valiant', 'velvet', 'verdant', 'vivid', 'wandering', 'warm', 'watchful', 'wild',
  'willing', 'windy', 'winter', 'wise', 'witty', 'woven', 'zealous', 'zesty',
];

export const NOUNS: readonly string[] = [
  'otter', 'falcon', 'heron', 'badger', 'marten', 'lynx', 'ibex', 'osprey',
  'raven', 'wren', 'finch', 'sparrow', 'kestrel', 'harrier', 'curlew', 'plover',
  'puffin', 'gannet', 'tern', 'egret', 'bittern', 'crane', 'stork', 'ibis',
  'teal', 'pintail', 'eider', 'merlin', 'goshawk', 'buzzard', 'kite', 'owl',
  'robin', 'thrush', 'dipper', 'warbler', 'pipit', 'lark', 'martin', 'swallow',
  'starling', 'jackdaw', 'rook', 'chough', 'magpie', 'jay', 'nutcracker', 'crossbill',
  'siskin', 'redpoll', 'linnet', 'bunting', 'hare', 'stoat', 'weasel', 'polecat',
  'fox', 'deer', 'elk', 'bison', 'tapir', 'okapi', 'gazelle', 'oryx',
  'kudu', 'eland', 'addax', 'saiga', 'markhor', 'tahr', 'chamois', 'vicuna',
  'guanaco', 'llama', 'alpaca', 'seal', 'walrus', 'narwhal', 'beluga', 'orca',
  'dolphin', 'porpoise', 'manatee', 'dugong', 'turtle', 'terrapin', 'gecko', 'skink',
  'iguana', 'chameleon', 'salamander', 'newt', 'axolotl', 'frog', 'perch', 'tench',
  'rudd', 'chub', 'dace', 'barbel', 'gudgeon', 'loach', 'minnow', 'salmon',
  'trout', 'char', 'grayling', 'pike', 'bream', 'carp', 'ray', 'comet',
  'nebula', 'quasar', 'meteor', 'aurora', 'zephyr', 'monsoon', 'cyclone', 'current',
  'harbor', 'lantern', 'beacon', 'compass', 'anchor', 'summit', 'canyon', 'meadow',
];
```

- [ ] **Step 4: Create the generator**

Create `lib/nostr/generated-profile.ts`:

```ts
'use client';

// Name and avatar for accounts this app created itself (the Google onboarding
// path). Both are derived ONLY from the pubkey — deliberately not from the
// Google account.
//
// Copying the user's Google name and photo would need the `profile` OAuth
// scope and would publish a permanent, public link between their real-world
// identity and their npub. That is precisely the linkage the appDataFolder
// design was chosen to avoid: Google is a blob store here, not an identity
// provider. Deriving from the pubkey keeps that true.
//
// Pure and deterministic: same pubkey, same output, forever. No I/O.

import { ADJECTIVES, NOUNS } from './profile-words';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Amber Otter" — stable for a given pubkey. */
export function generatedName(pubkey: string): string {
  const adj = ADJECTIVES[parseInt(pubkey.slice(0, 4), 16) % ADJECTIVES.length];
  const noun = NOUNS[parseInt(pubkey.slice(4, 8), 16) % NOUNS.length];
  return `${cap(adj)} ${cap(noun)}`;
}

// A 5x5 identicon mirrored on the vertical axis: 15 independent cells (5 rows
// x 3 columns), columns 3-4 mirroring columns 1-0.
const CELL_COUNT = 15;
// Bits come from a window disjoint from the hue's slice(0,6). If both read the
// same bytes, pattern and colour would correlate and similar-hued accounts
// would tend to look alike — the opposite of what an identicon is for.
const BIT_WINDOW: [number, number] = [8, 24];
// A pubkey whose bits land nearly all-zero or all-one yields a blank or solid
// tile: valid, but a useless avatar and a bad first impression on an account
// the user didn't choose the look of. Fall back to a fixed pleasant pattern.
const MIN_CELLS = 3;
const MAX_CELLS = 12;
const FALLBACK_BITS = 0b010110101101010;

function popcount(n: number): number {
  let c = 0;
  for (let v = n; v; v >>= 1) c += v & 1;
  return c;
}

/** Deterministic identicon as a self-contained data: URI. */
export function generatedAvatarDataUri(pubkey: string): string {
  const hue = parseInt(pubkey.slice(0, 6), 16) % 360;
  const window = BigInt(`0x${pubkey.slice(BIT_WINDOW[0], BIT_WINDOW[1])}`);
  let bits = Number(window & 0x7fffn);
  if (popcount(bits) < MIN_CELLS || popcount(bits) > MAX_CELLS) bits = FALLBACK_BITS;

  const cells: string[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    if (!(bits & (1 << i))) continue;
    const row = Math.floor(i / 3);
    const col = i % 3;
    cells.push(`<rect x="${col}" y="${row}" width="1" height="1"/>`);
    // Column 2 is the centre line — mirroring it would double-draw.
    if (col < 2) cells.push(`<rect x="${4 - col}" y="${row}" width="1" height="1"/>`);
  }

  // Same hue derivation as <DefaultAvatar>, so the published avatar and this
  // app's own fallback tile never read as two different people.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" shape-rendering="crispEdges">` +
    `<rect width="5" height="5" fill="hsl(${hue},45%,28%)"/>` +
    `<g fill="hsl(${hue},55%,72%)">${cells.join('')}</g>` +
    `</svg>`;
  // ASCII-only by construction, so btoa needs no unicode handling.
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** The kind:0 content for a freshly generated account. */
export function buildGeneratedProfile(pubkey: string) {
  const name = generatedName(pubkey);
  return { name, display_name: name, picture: generatedAvatarDataUri(pubkey) };
}
```

- [ ] **Step 5: Run the verification script to verify it passes**

Run: `npx --yes tsx <scratchpad>/generated-profile-check.mjs`
Expected: every line `PASS`, final line `ALL PASS`, exit 0.

If `names spread out` fails, the modulo indexing is collapsing — check that `slice(0,4)` and `slice(4,8)` are distinct windows.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean, no output beyond the npm banner.

- [ ] **Step 7: Commit**

```bash
git add lib/nostr/profile-words.ts lib/nostr/generated-profile.ts
git commit -m "feat(profile): derive a display name and identicon from a pubkey"
```

---

### Task 2: Publish the profile on new-account signup

**Files:**
- Create: `components/nostr-auth/provision-profile.ts`
- Modify: `components/nostr-auth/google-auth-panel.tsx` (the `finish()` function)
- Modify: `CLAUDE.md` (Google onboarding section)
- Modify: `README.md` (Google onboarding section)

**Interfaces:**
- Consumes: `buildGeneratedProfile(pubkey)` from Task 1.
- Produces: `provisionProfileFromKey(identity: NostrIdentity): Promise<void>`

Confirmed signatures this task relies on (do not re-derive):
- `signAndPublish(template: EventTemplate, relays: string[]): Promise<PublishedNote>` — `lib/nostr/publish.ts`. Already generic over the template, so kind:0 needs **no change** to that file.
- `resolvePublishRelays(identity: NostrIdentity | null): string[]` and `sanitizeRelays(urls: string[]): string[]` and `PROFILE_RELAYS: string[]` — all `lib/nostr/relays.ts`.
- `storage.profile.set(pubkey: string, v: ProfileMetadata): void` — `lib/storage.ts`.
- `ProfileMetadata` — `lib/nostr/auth.ts`, re-exported from `lib/nostr`.

- [ ] **Step 1: Create the provisioning module**

Create `components/nostr-auth/provision-profile.ts`:

```ts
'use client';

import { signAndPublish } from '@/lib/nostr/publish';
import { PROFILE_RELAYS, resolvePublishRelays, sanitizeRelays } from '@/lib/nostr/relays';
import { buildGeneratedProfile } from '@/lib/nostr/generated-profile';
import { storage } from '@/lib/storage';
import type { NostrIdentity } from '@/lib/nostr';

/**
 * Give a brand-new account a kind:0 so it isn't a nameless npub everywhere
 * outside this app — including on its own boost notes, which is the whole
 * point of the onboarding flow.
 *
 * Only ever called on the **new-account** branch. kind:0 is replaceable, so
 * running this on restore would silently overwrite a profile the user set in
 * another client. A freshly generated random key cannot already have a kind:0,
 * which makes the restriction safe by construction rather than by luck — the
 * same argument that governs provision-spark.ts.
 *
 * Best-effort: a missing profile is cosmetic, a blocked sign-in is not. The
 * caller swallows failures.
 */
export async function provisionProfileFromKey(identity: NostrIdentity): Promise<void> {
  const profile = buildGeneratedProfile(identity.pubkey);

  // Seed the cache BEFORE publishing. loadProfile's relay fetch races this
  // publish and will usually lose, so without this the header shows "Anon"
  // until some later refresh happens to catch the event.
  storage.profile.set(identity.pubkey, profile);

  // PROFILE_RELAYS is load-bearing, not belt-and-braces: purplepag.es is the
  // de facto profile outbox that Damus and Amethyst read. Publishing only to
  // the user's write relays means most clients never find this profile.
  const relays = sanitizeRelays([
    ...resolvePublishRelays(identity),
    ...PROFILE_RELAYS,
  ]).slice(0, 20);

  await signAndPublish(
    {
      kind: 0,
      content: JSON.stringify(profile),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    relays,
  );
}
```

- [ ] **Step 2: Wire it into the new-account branch**

In `components/nostr-auth/google-auth-panel.tsx`, add the import alongside the existing `provisionSparkFromKey` import:

```ts
import { provisionProfileFromKey } from './provision-profile';
```

Then inside `finish()`, in the existing `if (isNewAccount) { … }` block, immediately after the `provisionSparkFromKey(...)` call:

```ts
      // Same contract as the wallet: new-account only, best-effort, and the
      // failure is logged as a message rather than an object.
      provisionProfileFromKey(id).catch((e) => {
        console.warn('[profile] generated profile publish failed:', getErrorMessage(e, 'unknown error'));
      });
```

`getErrorMessage` is already imported in this file. Do **not** add this to the restore path.

- [ ] **Step 3: Typecheck, lint, build**

Stop the dev server first if it is running (`pkill -f "next dev"`), then:

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all three clean.

- [ ] **Step 4: Manual browser verification**

Restart the dev server (`npm run dev`) and hard-reload. Then:

1. Sign out, **Continue with Google**, **Create another account**, set a 6+ digit PIN.
2. Header shows a two-word name and a coloured identicon — not `◆`, not `Anon`.
3. Reload → the name persists immediately with no flash of `Anon` (proves the `storage.profile` seeding).
4. Boost something small, or open the global feed → the same avatar renders on the note card (proves the published `picture` is what other surfaces read).
5. **Regression check:** sign out, sign back in with Google + PIN on the *same* account. No second kind:0 should be published — verify the existing event's `created_at` is unchanged.

- [ ] **Step 5: Update the docs**

In `CLAUDE.md`, in the Google onboarding section, after the Spark-wallet paragraph, add:

```markdown
**A new account also gets a generated kind:0.** `lib/nostr/generated-profile.ts` derives a display name (adjective + noun, 128×128 word lists) and a 5×5 mirrored identicon from the **pubkey** — never from the Google account, which would need the `profile` scope and would publicly link the npub to a real-world identity. The avatar is an inline `data:image/svg+xml;base64` URI, so it depends on no hosting and reveals nothing about where the account was made. Published by `components/nostr-auth/provision-profile.ts` to `resolvePublishRelays(identity) ∪ PROFILE_RELAYS` — **the union matters**: purplepag.es is the profile outbox Damus and Amethyst read. **New-account branch only** (kind:0 is replaceable; publishing on restore would overwrite a profile set in another client). This is the only place the app writes a user's kind:0 — everywhere else it only reads them.
```

In `README.md`, in the "Google onboarding" section, after the sentence about the Spark wallet, add:

```markdown
New accounts also get a **generated kind:0** — a two-word display name and an identicon, both derived from the pubkey (not from the Google account), so the user is recognizable in every Nostr client rather than a nameless npub.
```

- [ ] **Step 6: Commit**

```bash
git add components/nostr-auth/provision-profile.ts components/nostr-auth/google-auth-panel.tsx CLAUDE.md README.md
git commit -m "feat(profile): publish a generated kind:0 for new Google accounts"
```

---

## Self-review notes

- **Spec coverage:** name generation (Task 1), avatar data URI (Task 1), degenerate-grid guard (Task 1, `MIN_CELLS`/`MAX_CELLS`), publish path + relay union (Task 2), new-account-only restriction (Task 2, enforced at the call site *and* documented in the module), local cache seeding (Task 2), best-effort failure handling (Task 2), out-of-scope items (no editing UI, no `nip05`, no `about`) — none are implemented, as intended.
- **Type consistency:** `buildGeneratedProfile` returns `{ name, display_name, picture }`, structurally assignable to `ProfileMetadata` (all optional string fields), which is what `storage.profile.set` requires. Verified against `lib/nostr/auth.ts:60`.
- **Known gap:** the identicon is not verified to *look* good, only to be non-degenerate and under budget. Step 4.2 is the human check.
