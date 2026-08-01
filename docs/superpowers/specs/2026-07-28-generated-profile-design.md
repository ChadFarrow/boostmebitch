# Generated profile for Google-onboarded accounts

**Date:** 2026-07-28
**Status:** Implemented on `feature/generated-profile` (PR #142); not yet on `main`
**Branch context:** builds on `claude/wisp-google-auth-nostr-9h5bzy` (PR #141)

## Problem

The Google onboarding path generates a Nostr key for users who have none. It never publishes a **kind:0**, so those accounts have no profile metadata anywhere. In BMB they fall back to `DefaultAvatar` (a hue-from-pubkey tile showing `◆`); in every other Nostr client — and on their own boost notes, which are the whole point — they are a nameless npub.

A user who signed up precisely because they didn't want to deal with Nostr plumbing ends up looking like nobody.

## Decisions

Settled during design; each closes off an alternative deliberately.

| Decision | Rationale |
|---|---|
| Name and avatar are **derived from the pubkey**, never from the Google account | Using Google's name/photo would need the `profile` scope, widen the consent screen, and publicly link the npub to a real-world Google identity — the exact linkage `appDataFolder` was chosen to prevent. "Google is a blob store, not an identity provider" has to stay true. |
| Avatar ships as an **inline `data:` URI**, not a hosted URL | A hosted `/api/avatar/<pubkey>.svg` would make every generated profile depend on boostmebitch.com existing forever, and would fingerprint its users: anyone seeing that URL knows where the account was made. |
| Name is **adjective + noun**, no hex discriminator | Chosen for legibility. Mitigated with 128×128 word lists (16,384 pairs) instead of 64×64, which recovers most of the collision headroom a discriminator would have bought. Nostr does not require unique names; collisions are cosmetic. |
| Published **only on the new-account branch** | kind:0 is replaceable. Publishing on the restore path would silently overwrite a profile the user set in another client. A freshly generated random key cannot already have a kind:0, so this restriction is safe by construction — the same argument that governs `provision-spark.ts`. |
| **Best-effort**; never blocks sign-in | A missing profile is cosmetic. A blocked sign-in is not. |

Two things accepted with open eyes: this is **the first time the app writes a user's kind:0** (it has only ever read them), and a generated name is an invented identity — chosen over a blank one.

## Design

### `lib/nostr/generated-profile.ts` (new, pure, no I/O)

```ts
generatedName(pubkey: string): string           // "Amber Otter"
generatedAvatarDataUri(pubkey: string): string  // "data:image/svg+xml;base64,…"
buildGeneratedProfile(pubkey: string): { name: string; display_name: string; picture: string }
```

- **Name.** Two curated 128-entry word lists. `adjIdx = parseInt(pubkey.slice(0,4),16) % 128`, `nounIdx = parseInt(pubkey.slice(4,8),16) % 128`. Words must be neutral and unambiguously inoffensive in isolation *and* in combination — the pairing is uncontrolled, so screen for unfortunate adjacencies.
- **Avatar.** A 5×5 GitHub-style identicon mirrored on the vertical axis: columns 0–2 are independent (15 cells), columns 3–4 mirror columns 1–0. Cell *i* (0-indexed, row-major over the 15) is filled when bit *i* of `BigInt('0x' + pubkey.slice(8, 24))` is set — an explicit 64-bit window distinct from the hue's `slice(0,6)`, so the two aren't correlated.
  Colors: background `hsl(h, 45%, 28%)` using the **same hue derivation `DefaultAvatar` already uses** (`parseInt(pubkey.slice(0,6),16) % 360`), so the published avatar and BMB's own fallback never look like two different people; filled cells `hsl(h, 55%, 72%)`.
  Emit a `viewBox="0 0 5 5"` SVG of plain `<rect>`s, base64 via `btoa` (ASCII-only, so no unicode handling needed). Budget: **under 1.5 KB encoded**.
  Guard against the degenerate cases: an all-empty or all-filled grid is a valid but useless avatar. If fewer than 3 or more than 12 of the 15 cells are set, fall back to a fixed pleasant pattern rather than shipping a blank tile.
- Both functions are deterministic and side-effect free, so they are directly testable without mocking.

### Publishing

No change to `lib/nostr/publish.ts` — `signAndPublish(template, relays)` is already generic over `EventTemplate`. The caller builds:

```ts
{ kind: 0, content: JSON.stringify(profile), tags: [], created_at: <now> }
```

**Relays: `resolvePublishRelays(identity) ∪ PROFILE_RELAYS`.** The union is load-bearing — `purplepag.es` is the de facto profile outbox that Damus and Amethyst read; publishing only to the user's write relays means most clients never find the profile.

### `components/nostr-auth/provision-profile.ts` (new)

A sibling of `provision-spark.ts`, same shape and same guarantees:

```ts
export async function provisionProfileFromKey(identity: NostrIdentity): Promise<void>
```

1. Build the profile from `identity.pubkey`.
2. Seed `storage.profile` for that pubkey **before** publishing, so the header renders the name immediately rather than waiting on a relay round trip that may not yet carry the event.
3. `signAndPublish` the kind:0 to the relay union.

Called from `google-auth-panel.tsx`'s `finish()` on the `isNewAccount` branch, alongside `provisionSparkFromKey`, unawaited. Failures are caught at the call site and logged as a **message, not the error object** — matching the existing `[spark]` convention, which exists because SDK errors can echo their arguments.

### Out of scope

No editing UI. No `nip05` (requires hosting). No `about`. No regeneration or re-roll. Only `name`, `display_name`, `picture`.

## Verification

**Deterministic units** (no test runner in this repo, so a throwaway node script under the scratchpad, as used for the Argon2 change):
- Same pubkey → identical name and avatar across calls.
- Different pubkeys → different output; spot-check distribution across ~1000 random pubkeys for obvious clumping.
- Avatar decodes to valid SVG and stays under the size budget.
- Name uses only word-list entries — no index overflow, no `undefined` in the output.

**Static:** `npm run typecheck`, `npm run lint`, and `npm run build` (dev server stopped — building into `.next` while `next dev` serves from it breaks the running server).

**Manual, in the browser:**
1. Fresh Google signup → header shows a two-word name and an identicon, not `◆`.
2. The same avatar appears on a boost note card, confirming the published `picture` is what renders.
3. Reload → name persists from `storage.profile` with no flash of `Anon`.
4. Look the npub up in another client (or a relay explorer) → the kind:0 is present and the `data:` URI renders.
5. **Restore an existing account** → no new kind:0 is published. This is the regression that matters: verify by checking `created_at` on the event is unchanged after a restore.
