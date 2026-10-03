// A bot's announcement of a boost, shown beside the note the sender signed.
//
// Some accounts re-announce boosts they see — MSP 2.0's bot announces every
// boost its artists receive, Boostr_Bot every boost its podcasts receive — and
// each announcement is a NEW signed kind:1 by the bot. The sender's own app
// (Fountain, this one) usually posts its own note about the same payment
// seconds apart. Both carry the same NIP-73 tags, so every feed here showed the
// one boost as two cards. Deduping on the event id cannot see it: they are two
// events, by two keys, and both are genuine. Nothing here drops either from the
// read index; this decides which ONE a feed renders.
//
// THE NOTE THE SENDER SIGNED STAYS. It holds their words as they wrote them,
// their replies, and it is the one a zap or repost should reach.
//
// What ties the two together is the bot's `sender` tag, which names the payer as
// an npub. That is the only machine-readable link on the wire: the bot quotes
// nothing, and the sender's note quotes a kind:9735 that carries no payment id
// the bot also carries. So a note without a `sender` tag is never an echo here,
// however alike the text — a guess on text alone would hide a second boost.
//
// Measured on the relays 2026-10-02 over six days of podcast-tagged kind:1:
// two authors write `sender` (MSP 2.0's bot and Boostr_Bot), always as an npub,
// always with an `amount` tag and a `podcast:item:guid` `i` tag; their partner
// notes landed 2–80 s away. `scripts/check-boost-echo.mjs` replays the pairs.
//
// Bare npm imports only — `scripts/check-boost-echo.mjs` loads this file under
// `node --experimental-strip-types`, which cannot resolve a relative import.
import { nip19 } from 'nostr-tools';

/**
 * How far apart in `created_at` an announcement and the sender's note may be.
 * Measured partners sat 2–80 s apart; the slack is for a bot that polls. A
 * wider window is safe only because of the other three tests below.
 */
export const ECHO_WINDOW_SEC = 600;

/** The fields of a `DiscoveredNote` the decision reads. */
export interface EchoNote {
  id: string;
  pubkey: string;
  createdAt: number;
  amountMsat: number | null;
  episodeGuids: string[];
  rawEvent: { tags: string[][] };
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

/**
 * The payer a note names in its `sender` tag, as hex — or null when it names
 * nobody, names something that is not a pubkey, or names its own author (a
 * note naming itself is the sender's own note, not an echo of it).
 */
export function echoSender(note: EchoNote): string | null {
  const value = note.rawEvent?.tags?.find((t) => t[0] === 'sender')?.[1];
  if (typeof value !== 'string') return null;
  let hex: string | null = null;
  if (HEX_PUBKEY.test(value)) {
    hex = value;
  } else {
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === 'npub') hex = decoded.data;
      else if (decoded.type === 'nprofile') hex = decoded.data.pubkey;
    } catch {
      return null;
    }
  }
  return hex && hex !== note.pubkey ? hex : null;
}

/**
 * The ids of the announcements a feed should NOT render, because the note the
 * sender signed about the same boost is in the same list.
 *
 * An announcement E and a note O are the same boost when ALL of these hold:
 *  - E's `sender` names O's author, and O names no other sender itself;
 *  - they share a `podcast:item:guid` — the bot tags the item it was paid on;
 *  - they are within `ECHO_WINDOW_SEC` of each other, in either order (MSP 2.0's
 *    bot posted 3 s BEFORE the sender's note it echoed);
 *  - their amounts do not DISAGREE. A Fountain note has no `amount` tag and
 *    adopts one from its quoted kind:9735 only after a later stage, so "not
 *    known yet" must not block the match; two known, different amounts are two
 *    boosts.
 *
 * And the pairing is ONE TO ONE per bot: one sender note absorbs at most one
 * announcement from each bot, the nearest in time. Somebody who boosts one
 * track twice in ten minutes from an app that posts no note for the second
 * gets two announcements and one note; hiding both would lose a payment from
 * the feed. Two different bots announcing the one boost are both absorbed.
 *
 * Order-independent and pure: the same list in any order gives the same set.
 */
export function boostEchoIds(notes: readonly EchoNote[]): Set<string> {
  const ownByAuthor = new Map<string, EchoNote[]>();
  const echoes: { note: EchoNote; sender: string }[] = [];
  for (const n of notes) {
    const sender = echoSender(n);
    if (sender) {
      echoes.push({ note: n, sender });
      continue;
    }
    const list = ownByAuthor.get(n.pubkey);
    if (list) list.push(n);
    else ownByAuthor.set(n.pubkey, [n]);
  }

  const pairs: { echo: EchoNote; own: EchoNote; gap: number }[] = [];
  for (const { note: echo, sender } of echoes) {
    if (!echo.episodeGuids.length) continue;
    for (const own of ownByAuthor.get(sender) ?? []) {
      const gap = Math.abs(echo.createdAt - own.createdAt);
      if (gap > ECHO_WINDOW_SEC) continue;
      if (!own.episodeGuids.some((g) => echo.episodeGuids.includes(g))) continue;
      if (echo.amountMsat !== null && own.amountMsat !== null && echo.amountMsat !== own.amountMsat) continue;
      pairs.push({ echo, own, gap });
    }
  }

  // Nearest first, then by id, so the answer never depends on list order.
  pairs.sort((a, b) => a.gap - b.gap
    || cmp(a.echo.id, b.echo.id)
    || cmp(a.own.id, b.own.id));

  const hidden = new Set<string>();
  const absorbed = new Set<string>();
  for (const { echo, own } of pairs) {
    const slot = `${own.id}|${echo.pubkey}`;
    if (hidden.has(echo.id) || absorbed.has(slot)) continue;
    hidden.add(echo.id);
    absorbed.add(slot);
  }
  return hidden;
}

/** `notes` without the announcements `boostEchoIds` names, order kept. */
export function dropBoostEchoes<T extends EchoNote>(notes: readonly T[]): T[] {
  const hidden = boostEchoIds(notes);
  return hidden.size ? notes.filter((n) => !hidden.has(n.id)) : [...notes];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
