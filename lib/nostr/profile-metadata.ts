// ---------------------------------------------------------------------------
// kind:0 profile metadata — the shape, and the coercion every reader goes
// through.
//
// This is a LEAF with no imports, and that is structural rather than
// stylistic. `lib/storage.ts` needs `coerceProfileMetadata` to validate its
// cached profiles, and it used to reach into `lib/nostr/auth.ts` for it — which
// was the single value import that put `lib/storage.ts` inside `lib/nostr/`'s
// import graph and made this loop real:
//
//     storage.ts → nostr/auth.ts → nostr/signer.ts → nostr/amber.ts → storage.ts
//
// Everything else `lib/storage.ts` imports (`./pubsub`, `./nostr/mute-state`,
// `./v4v/stream-ledger`) already has no imports at all, so moving this one
// function down here removes the last edge and the cycle class with it. That is
// the same fix, for the same reason, that `lib/nostr/mute-state.ts` exists:
// when both sides need the same thing, push it DOWN rather than sideways.
//
// CLAUDE.md's rule still stands — `lib/storage.ts` sits UNDER `lib/nostr/`, and
// a value import pointing the other way is a cycle waiting to happen. Keeping
// this file import-free is what lets the rule be obeyed instead of worked
// around. **Do not add an import here**, and in particular do not import
// `./auth` for a type: `auth.ts` re-exports `ProfileMetadata` FROM here, so the
// arrow runs one way only.
// ---------------------------------------------------------------------------

export interface ProfileMetadata {
  name?: string;
  display_name?: string;
  picture?: string;
  nip05?: string;
  about?: string;
  lud16?: string;        // Lightning address (user@domain) — used by NIP-57 zaps
  lud06?: string;        // bech32-encoded LNURL — older spec, fallback when lud16 is absent
}

// Drop fields that aren't strings (some kind:0 events in the wild ship `name`
// as a number, `picture` as null, etc., and the `as ProfileMetadata` cast at
// JSON.parse-time hides that — until a `.trim()` or `.toLowerCase()` blows up
// during render and takes the whole feed surface down with it).
const PROFILE_STRING_FIELDS = [
  'name',
  'display_name',
  'picture',
  'nip05',
  'about',
  'lud16',
  'lud06',
] as const;

export function coerceProfileMetadata(value: unknown): ProfileMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const out: ProfileMetadata = {};
  for (const key of PROFILE_STRING_FIELDS) {
    const raw = v[key];
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

/** Parse a kind:0 event's `content` and return a sanitized ProfileMetadata.
 *  Returns null if the content isn't valid JSON or isn't an object. */
export function parseProfileContent(content: string): ProfileMetadata | null {
  try {
    return coerceProfileMetadata(JSON.parse(content));
  } catch {
    return null;
  }
}

/**
 * Elide an npub for display: `npub1abc…xyz789`.
 *
 * Here rather than in `lib/nostr/auth.ts`, where it used to live, for the same
 * structural reason `coerceProfileMetadata` moved: `lib/format.tsx` renders
 * `nostr:npub…` mentions and needs this, and 18 modules import `lib/format.tsx`
 * — so reaching it through `auth.ts` would drag the whole signer stack (amber,
 * bunker, local key store) into every one of them. Push it DOWN rather than
 * sideways. `auth.ts` re-exports it, so no existing call site changed.
 */
export function shortNpub(npub: string, len = 8) {
  if (npub.length <= len * 2 + 1) return npub;
  return `${npub.slice(0, len)}…${npub.slice(-len)}`;
}
