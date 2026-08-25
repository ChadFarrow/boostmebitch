/**
 * Parse a Podcasting 2.0 chapters JSON document, tolerating ONE measured
 * real-world corruption: an orphan run of digits sitting between a `,` and the
 * next `"`.
 *
 * **This is not a general JSON repairer and must never become one.** The input
 * is attacker-chosen bytes named by a podcast feed, so every rule that widens
 * what we accept is a rule that lets a feed steer the parser. The whole design
 * rests on one property, which is why the shape below is worth keeping:
 *
 *   Outside a string, a `,` in valid JSON is followed by a key (`"…"`) or by a
 *   value. `, <digits> <whitespace> "` is neither — two values with no comma
 *   between them. So the pattern this repairs CANNOT occur in a well-formed
 *   document, and `parseChaptersJson` additionally runs a STRICT parse first
 *   and only reaches the repair when that has already thrown. A valid file is
 *   therefore never rewritten, twice over.
 *
 * **The scan is string-aware, and that is the whole safety argument.** The
 * obvious version is one regex over the whole text —
 * `text.replace(/,(\s*)\d+(\s*")/g, ',$1$2')` — and it is wrong in a way that
 * is invisible in review and silent in production: a chapter TITLE reading
 * `Set 1, 0 "live"` contains that pattern inside a string literal, so the regex
 * eats a digit out of the user-visible text and the file still parses. A
 * corrupted title looks exactly like a title the publisher wrote. So the walk
 * below tracks `inString` (honouring `\` escapes) and repairs only outside one.
 *
 * **Why the repair exists at all.** V4V Music Spotlight episode 005 shipped a
 * chapters file with a stray `0` at the start of the line before every one of
 * its 25 `"title"` keys — `"startTime": 0.000000,\r\n0      "title": …`.
 * `JSON.parse` stops at position 80, `/api/chapters` answered 500, and the app
 * rendered "no chapters", which is indistinguishable from an episode that never
 * published any. The 25 chapters themselves are intact and correct.
 *
 * Import-free on purpose: `npm run check:chapters` loads THIS module under
 * plain Node via `--experimental-strip-types`, so a reimplemented copy in the
 * script cannot drift away from what ships. See `scripts/import-free.mjs`.
 */

/** JSON's own whitespace set (RFC 8259) — not `\s`, which is far wider. */
function isJsonSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/**
 * Drop every orphan digit run that sits between a `,` and the next `"`,
 * outside of any string literal. Whitespace is preserved exactly, so byte
 * offsets in a later parse error still point somewhere meaningful.
 *
 * Returns the input unchanged when there is nothing to repair — callers use
 * that identity to tell "nothing to try" from "tried and still broken".
 */
export function repairOrphanDigits(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const c = text[i];

    if (inString) {
      // A backslash escapes the next character, `"` included. Consuming both
      // is what stops `\"` from being read as the end of the string.
      if (c === '\\') {
        out += c + (text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      out += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }

    if (c === ',') {
      let j = i + 1;
      while (j < text.length && isJsonSpace(text[j])) j += 1;
      const digitsAt = j;
      while (j < text.length && isDigit(text[j])) j += 1;
      const digitsEnd = j;
      if (digitsEnd > digitsAt) {
        while (j < text.length && isJsonSpace(text[j])) j += 1;
        if (text[j] === '"') {
          // Keep the comma and the whitespace that led up to the orphan; skip
          // the digits themselves. Nothing else on the line is touched.
          out += ',' + text.slice(i + 1, digitsAt);
          i = digitsEnd;
          continue;
        }
      }
      out += c;
      i += 1;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/**
 * `JSON.parse`, then — only if that threw — the same parse over a repaired
 * copy. Throws the ORIGINAL `SyntaxError` when the repair does not help, so
 * the message keeps naming the real fault rather than a position in a string
 * the publisher never served.
 */
export function parseChaptersJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (strictError) {
    const repaired = repairOrphanDigits(text);
    if (repaired === text) throw strictError;
    try {
      return JSON.parse(repaired);
    } catch {
      throw strictError;
    }
  }
}
