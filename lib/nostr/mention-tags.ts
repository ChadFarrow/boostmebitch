// Which people a boost note tags, merged from the two sources that can name
// one — and which of them are allowed to actually NOTIFY.
//
// IMPORT-FREE ON PURPOSE. scripts/check-mention-tags.mjs loads this exact
// module under `node --experimental-strip-types`; a reimplemented copy in the
// script would stay green while this drifted. See scripts/import-free.mjs —
// a type-only relative import counts as an import here.

/** A person a note can name. `pubkey` is 64 lowercase hex; `npub` is bech32. */
export interface MentionNpub {
  npub: string;
  pubkey: string;
}

/** Cap on feed-declared npubs in one note. Mirrors MAX_FEED_NPUBS per level. */
export const MAX_FEED_NOTE_NPUBS = 4;

/**
 * Cap on sender-chosen @mentions in one note.
 *
 * Four plus the four above is exactly the site-sign route's MAX_P_TAGS, which
 * is deliberate headroom rather than a coincidence: even if the selfSigned gate
 * below were ever removed by mistake, the template still could not exceed the
 * bound that route enforces. Do NOT raise MAX_P_TAGS to make room for more.
 */
export const MAX_MENTION_NPUBS = 4;

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * A person this module is willing to put in a signed event.
 *
 * The feed side was already validated by nip19.decode in lib/feed-xml.ts, but
 * the sender side is new input reaching the same place, and the cost of one bad
 * entry is a `p` tag pointing at whoever the bytes happen to decode to, on an
 * immutable kind:1, with no way to unsend. So both sides are re-checked here:
 * this is the last function before the tag array.
 */
function usable(n: MentionNpub | null | undefined): n is MentionNpub {
  return (
    !!n &&
    typeof n.pubkey === 'string' &&
    typeof n.npub === 'string' &&
    HEX64.test(n.pubkey) &&
    n.npub.startsWith('npub1')
  );
}

/** Deduped, validated, capped — in the order given. */
function take(
  list: readonly MentionNpub[] | null | undefined,
  seen: Set<string>,
  cap: number,
): MentionNpub[] {
  const out: MentionNpub[] = [];
  for (const n of list ?? []) {
    if (!usable(n)) continue;
    if (seen.has(n.pubkey)) continue;
    seen.add(n.pubkey);
    out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * The people a boost note names, split into the ones it TAGS and the ones it
 * merely writes into the body.
 *
 * `selfSigned` is the whole point of this function, and it is a security gate
 * rather than a preference. A boost note is signed one of two ways: by the
 * user's own key, or — signed out, or with the share picker set to Anonymous —
 * by the site's key through `/api/nostr/site-sign`, which is an
 * UNAUTHENTICATED endpoint publishing under a NIP-05-verified identity. That
 * route's own comments name `p` tags as "the amplifier" and MAX_P_TAGS as what
 * stops one unauthed POST becoming a mention-spam blast at strangers. A
 * sender-chosen `p` tag there is exactly that blast, so it is dropped before
 * the template is ever built.
 *
 * Feed-declared npubs are NOT dropped, on either path, and are deliberately not
 * gated on Anonymous either: they name the artist the money went to, and an
 * anonymous boost should still reach them. A sender-chosen mention names a
 * third party the sender picked — it is not a recipient, so it does not inherit
 * that exemption.
 *
 * Feed npubs come FIRST because the caps truncate, and the artist being paid
 * outranks a person the sender named.
 *
 * `inBody` carries BOTH lists in every case. A mention that cannot notify is
 * still worth rendering — the sender typed it, and a name silently vanishing
 * from the note they just published reads as the feature being broken. What it
 * does not get is the tag that rings a stranger's phone.
 */
export function noteMentionTags(
  feed: readonly MentionNpub[] | null | undefined,
  chosen: readonly MentionNpub[] | null | undefined,
  selfSigned: boolean,
): { tagged: MentionNpub[]; inBody: MentionNpub[] } {
  const seen = new Set<string>();
  const feedNpubs = take(feed, seen, MAX_FEED_NOTE_NPUBS);
  // Shares `seen`, so a sender who @mentions the artist the feed already names
  // gets one tag and one body entry, not two.
  const chosenNpubs = take(chosen, seen, MAX_MENTION_NPUBS);
  return {
    tagged: selfSigned ? [...feedNpubs, ...chosenNpubs] : feedNpubs,
    inBody: [...feedNpubs, ...chosenNpubs],
  };
}
