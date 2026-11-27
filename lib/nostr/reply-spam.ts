// Which replies a feed folds away as likely spam, and which notes a viewer's
// own NIP-51 `word` mutes hide.
//
// IMPORT-FREE on purpose: `check:replyspam` loads this file under plain Node
// (`--experimental-strip-types`), and a relative import would stop it loading.
//
// WHAT HAPPENED. On 2026-11-26 the signed-out home page showed 159 reply cards
// and 53 of them were crypto "airdrop" spam. The relay forest under the home
// page's notes held 67 spam replies out of 118, from dozens of keys: 20 of 32
// keys measured had posted their first note less than a day earlier, and the
// keys follow each other (4 to 24 followers each), so neither a key list nor a
// follower count can keep up. A mute only ever helped the person who pressed
// it, and a signed-out visitor has no mute list at all. Chad chose this rule
// (2026-11-26, "A plus D, with a fold and SHOW button").
//
// WHAT THE SPAM HAS IN COMMON IS NOT ITS TEXT. It rotates about ten templates
// and swaps letters for Cyrillic, Greek, Cherokee and Armenian look-alikes
// ("ᏟlaiΜ Ꭹour Free ЕTН"), so an exact text match caught 0 of 67 and a match
// on the text with the look-alikes folded back caught 20. Two things it cannot
// rotate without costing itself the click:
//
//   - THE LINK. Every one links to the same few hosts (`ai.evmnest.cc` on most).
//     A host that `HOST_SPREAD_MIN` different keys link in one feed's replies,
//     or that look-alike replies from `SEED_KEYS_MIN` different keys link,
//     marks every reply linking it. Measured alone: 66 of 67.
//   - THE LOOK-ALIKES. `MIXED_WORDS_MIN` words that mix Latin letters with
//     letters from those scripts. A real writer of Russian or Greek writes a
//     word in one script. Measured alone: 47 of 67.
//
// Together: 67 of 67, and 0 of the 51 real replies in the same forest.
//
// A FALSE HIT COSTS ONE TAP, NOT A REPLY. The caller FOLDS what this returns
// behind "N replies hidden as likely spam · SHOW" (`<NoteCard>`); it never
// drops it. The known ways to fold a real reply, all untested on real data
// because none occurred in it: `HOST_SPREAD_MIN` or more people linking one
// page host in one feed's replies (media files are not counted, and the site's
// own hosts are exempt); look-alike spam from `SEED_KEYS_MIN` keys that links a
// popular host, which then folds every reply to that host; and a writer who
// mixes scripts inside two words.
//
// WHAT IT DOES NOT CATCH. AI "reply guy" bots on old keys that post no link
// (the diet and stoic accounts seen the same day) — a key mute still hides those.

/** The parts of a reply the rules read. A `DiscoveredNote` or a raw event fits. */
export interface ReplyText {
  id: string;
  pubkey: string;
  content: string;
}

/** Different keys that must link one host, in one feed's replies, to mark it. */
export const HOST_SPREAD_MIN = 4;

/** Mixed-script words a reply needs to count as look-alike spam on its own. */
export const MIXED_WORDS_MIN = 2;

/**
 * Different keys whose LOOK-ALIKE replies must link a host before every reply
 * linking it is marked. Two, not one: a single look-alike reply that links a
 * popular host (a video site) would otherwise fold every real reply to it.
 */
export const SEED_KEYS_MIN = 2;

/**
 * Letters outside Latin that pass for Latin ones: Greek, Cyrillic, Armenian,
 * Cherokee (capital and small), Latin small capitals and full-width Latin.
 * Every look-alike the 2026-11-26 spam used is in one of these blocks.
 */
const LOOKALIKE = /[Ͱ-ϿЀ-ӿԱ-ևᎠ-Ᏽꭰ-ꮿᴀ-ᴫＡ-Ｚａ-ｚ]/u;
const ASCII_LETTER = /[A-Za-z]/;

/** Links to these are a picture or a sound in the reply, not a destination. */
const MEDIA_PATH = /\.(?:jpe?g|png|gif|webp|avif|svg|bmp|heic|mp4|m4v|mov|webm|mp3|m4a|aac|ogg|opus|wav|flac)$/i;

const URL_RE = /https?:\/\/[^\s<>"'()[\]]+/gi;

function urlsIn(content: string): URL[] {
  const out: URL[] = [];
  for (const raw of content.match(URL_RE) ?? []) {
    try {
      out.push(new URL(raw.replace(/[.,;:!?]+$/, '')));
    } catch {
      // Not a URL after all. Nothing to count.
    }
  }
  return out;
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * The hosts a reply LINKS TO, lower case, `www.` dropped, one entry per host.
 * A link to a media file is left out: three people posting pictures from one
 * image host is ordinary.
 */
export function linkHosts(content: string): string[] {
  const hosts = new Set<string>();
  for (const u of urlsIn(typeof content === 'string' ? content : '')) {
    if (MEDIA_PATH.test(u.pathname)) continue;
    hosts.add(bareHost(u.host));
  }
  return [...hosts];
}

/**
 * How many words mix ASCII letters with a look-alike letter ("ᏟlaiΜ", "ЕTН").
 * Links are removed first, so a URL is never a word. A word is a run of
 * letters and digits; punctuation, emoji and spaces split words.
 */
export function mixedScriptWords(content: string): number {
  if (typeof content !== 'string') return 0;
  let n = 0;
  for (const word of content.replace(URL_RE, ' ').split(/[^\p{L}\p{N}]+/u)) {
    if (word && ASCII_LETTER.test(word) && LOOKALIKE.test(word)) n += 1;
  }
  return n;
}

/**
 * The ids of the replies to fold as likely spam.
 *
 * `replies` must be EVERY reply the feed holds, at every depth: the host count
 * is across the whole feed, because the spam spreads one or two replies over
 * many threads. A per-thread count misses most of it.
 *
 * `exemptHosts` are never counted — the deploys' own hosts, so three listeners
 * pointing each other at a page on this site do not fold each other.
 */
export function spamReplyIds(
  replies: readonly ReplyText[],
  exemptHosts: readonly string[] = [],
): Set<string> {
  const exempt = new Set(exemptHosts.map(bareHost));
  const keysByHost = new Map<string, Set<string>>();
  const lookalikeKeysByHost = new Map<string, Set<string>>();
  const spamHosts = new Set<string>();
  const lookalike = new Set<string>();
  const hostsOf = new Map<string, string[]>();

  for (const r of replies) {
    if (!r || typeof r.id !== 'string') continue;
    const hosts = linkHosts(r.content).filter((h) => !exempt.has(h));
    hostsOf.set(r.id, hosts);
    for (const h of hosts) {
      const keys = keysByHost.get(h) ?? new Set<string>();
      keys.add(r.pubkey);
      keysByHost.set(h, keys);
    }
    if (mixedScriptWords(r.content) >= MIXED_WORDS_MIN) {
      lookalike.add(r.id);
      for (const h of hosts) {
        const keys = lookalikeKeysByHost.get(h) ?? new Set<string>();
        keys.add(r.pubkey);
        lookalikeKeysByHost.set(h, keys);
      }
    }
  }
  for (const [h, keys] of keysByHost) {
    if (keys.size >= HOST_SPREAD_MIN) spamHosts.add(h);
  }
  for (const [h, keys] of lookalikeKeysByHost) {
    if (keys.size >= SEED_KEYS_MIN) spamHosts.add(h);
  }

  const out = new Set<string>(lookalike);
  for (const [id, hosts] of hostsOf) {
    if (hosts.some((h) => spamHosts.has(h))) out.add(id);
  }
  return out;
}

// ── NIP-51 `word` mutes ──────────────────────────────────────────────────────

/**
 * Look-alike letters folded to the Latin letter they imitate. Capital and small
 * forms both, so `fold` can lower-case afterwards. Cherokee small letters
 * (U+AB70–U+ABBF) are moved to their capitals before the lookup.
 */
const FOLD: Record<string, string> = {
  // Greek
  'Α': 'a', 'Β': 'b', 'Ε': 'e', 'Ζ': 'z', 'Η': 'h', 'Ι': 'i', 'Κ': 'k', 'Μ': 'm',
  'Ν': 'n', 'Ο': 'o', 'Ρ': 'p', 'Τ': 't', 'Υ': 'y', 'Χ': 'x',
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p',
  'τ': 't', 'υ': 'u', 'χ': 'x',
  // Cyrillic
  'А': 'a', 'В': 'b', 'С': 'c', 'Е': 'e', 'Н': 'h', 'І': 'i', 'Ј': 'j', 'К': 'k',
  'М': 'm', 'О': 'o', 'Р': 'p', 'Ѕ': 's', 'Т': 't', 'Х': 'x', 'У': 'y',
  'а': 'a', 'в': 'b', 'с': 'c', 'е': 'e', 'н': 'h', 'і': 'i', 'ј': 'j', 'к': 'k',
  'м': 'm', 'о': 'o', 'р': 'p', 'ѕ': 's', 'т': 't', 'х': 'x', 'у': 'y',
  // Armenian
  'Օ': 'o', 'օ': 'o', 'Տ': 's', 'ս': 'u', 'Ս': 'u',
  // Cherokee (capitals; small letters are moved here first)
  'Ꭺ': 'a', 'Ᏼ': 'b', 'Ꮯ': 'c', 'Ꭰ': 'd', 'Ꭼ': 'e', 'Ꮐ': 'g', 'Ꮋ': 'h', 'Ꭻ': 'j',
  'Ꮶ': 'k', 'Ꮮ': 'l', 'Ꮇ': 'm', 'Ꮲ': 'p', 'Ꭱ': 'r', 'Ꮪ': 's', 'Ꭲ': 't', 'Ꮩ': 'v',
  'Ꮃ': 'w', 'Ꭹ': 'y', 'Ꮓ': 'z',
};

/**
 * Lower-case text with every look-alike letter replaced by its Latin letter.
 * Full-width Latin and other compatibility forms are flattened by NFKC first.
 */
export function foldLookalikes(text: string): string {
  if (typeof text !== 'string') return '';
  let out = '';
  for (const ch of text.normalize('NFKC')) {
    const cp = ch.codePointAt(0) ?? 0;
    const capital = cp >= 0xab70 && cp <= 0xabbf ? String.fromCodePoint(cp - 0xab70 + 0x13a0) : ch;
    out += FOLD[capital] ?? ch;
  }
  return out.toLowerCase();
}

/**
 * The viewer's muted words: every `word` tag in either half of their kind:10000,
 * trimmed, lower case, deduplicated, empties dropped. The halves are read as
 * `MuteListState` keeps them (`publicOtherTags`, `privateOtherTags`), so a
 * private half that was never opened contributes nothing.
 */
export function mutedWordsOf(state: {
  publicOtherTags?: readonly (readonly string[])[];
  privateOtherTags?: readonly (readonly string[])[];
} | null | undefined): string[] {
  const words = new Set<string>();
  for (const tags of [state?.publicOtherTags, state?.privateOtherTags]) {
    if (!Array.isArray(tags)) continue;
    for (const t of tags) {
      if (!Array.isArray(t) || t[0] !== 'word' || typeof t[1] !== 'string') continue;
      const w = t[1].trim().toLowerCase();
      if (w) words.add(w);
    }
  }
  return [...words];
}

/**
 * Does this text contain a muted word? Case-insensitive and anywhere in the
 * text, as Damus and most clients match — so a muted "eth" also hides
 * "method"; the viewer chose the word. It is matched against the text as
 * written AND with look-alikes folded, so a muted "airdrop" also hides
 * "АirdrОp".
 */
export function mutedWordHit(content: string, words: readonly string[]): boolean {
  if (typeof content !== 'string' || !words.length) return false;
  const plain = content.toLowerCase();
  const folded = foldLookalikes(content);
  return words.some((raw) => {
    const w = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return !!w && (plain.includes(w) || folded.includes(w));
  });
}
