// URL-attribute safety for sanitized third-party HTML (RSS show notes).
//
// Pure, and deliberately free of static imports so `node --experimental-strip-types`
// can load it directly — see scripts/check-sanitizer.mjs, which pins the vectors
// below against this exact code rather than a copy of it.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, AND WHY A DENYLIST WAS THE WRONG SHAPE
//
// Show notes come from arbitrary podcast feeds and are rendered with
// dangerouslySetInnerHTML. Our origin holds `bmb:nwc_uri` (a budgeted Lightning
// spending credential) and the NIP-46 bunker `clientSk` in localStorage, so
// script execution here is not a defacement — it's theft.
//
// The original check tested the RAW attribute value against
// /^\s*(javascript|data|vbscript):/i and then re-emitted that raw value. Both
// halves of that are wrong, because a browser does two things to an href before
// it becomes a URL, and neither is visible to a regex over the source text:
//
//   1. HTML entities decode during parsing.  java&#115;cript:  ->  javascript:
//   2. URL parsing then DISCARDS tab, LF and CR anywhere in the string,
//      including inside the scheme.          java<TAB>script:  ->  javascript:
//
// Six vectors got through: decimal, hex and semicolon-less numeric entities,
// literal TAB, literal LF, and `&Tab;`. All merely needed the user to click a
// link in the notes.
//
// The fix is not a longer denylist — that's an arms race against every entity
// form and every browser quirk. It's to resolve what the browser will actually
// see, then require the result to be a scheme we want. An allowlist FAILS
// CLOSED: any obfuscation this decoder doesn't understand leaves a string that
// simply isn't `https://…`, so it's rejected. A denylist fails OPEN — anything
// it fails to recognize sails through.
//
// (The industrial answer is DOMPurify, but this runs server-side inside
// lib/pi.ts, so it would mean jsdom — a very large dependency tree for a repo
// that deliberately ships 13. The tag pass is already allowlist-based and
// strips every attribute except the two handled here, so hardening those two
// closes the gap proportionately.)
// ---------------------------------------------------------------------------

// Named entities that can smuggle a scheme past a naive check. `colon` is the
// dangerous one people forget: `javascript&colon;alert(1)`. Anything NOT in
// here is left encoded on purpose — an unknown entity then can't match the
// allowlist, which is the fail-closed behaviour we want.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  colon: ':',
  tab: '\t',
  newline: '\n',
  sol: '/',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Approximate what the browser will resolve this attribute to: decode entities
 * in a SINGLE pass (browsers don't re-scan their own output, so neither do we —
 * `&amp;#115;` must stay `&#115;`, not become `s`), then drop the characters
 * URL parsing ignores.
 */
function resolveAsBrowserWould(raw: string): string {
  return raw
    .replace(
      /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]*));?/g,
      (match, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
        if (hex !== undefined || dec !== undefined) {
          const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
          // Out-of-range escapes aren't characters; leaving the text as-is keeps
          // it non-matching against the allowlist rather than throwing.
          if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
          try {
            return String.fromCodePoint(code);
          } catch {
            return match;
          }
        }
        return NAMED_ENTITIES[String(name).toLowerCase()] ?? match;
      },
    )
    // Tab/CR/LF are stripped by URL parsing wherever they appear; NUL likewise
    // can't survive into a scheme. Leading/trailing whitespace is trimmed.
    .replace(/[\t\n\r\0]/g, '')
    .trim();
}

/** Escape for interpolation into a double-quoted HTML attribute. `&` matters:
 *  we emit the DECODED value, so without it a legitimate `?a=1&amp;b=2` would
 *  be double-decoded by the browser. */
export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Validate an `href`/`src` from untrusted HTML and return the value to emit,
 * or null to drop it.
 *
 * Returns the RESOLVED form, so the string we validated is exactly the string
 * the browser will use — no second decode pass can reintroduce a scheme. Callers
 * must run it through `escapeHtmlAttr` when writing it back into markup.
 *
 * `kind: 'link'` also permits `mailto:`, which is meaningful in show notes.
 * Protocol-relative `//host/path` is allowed for both: it inherits https here.
 * Everything else — relative paths, fragments, and every exotic scheme — is
 * dropped; show notes are third-party content where a same-origin-relative URL
 * is meaningless anyway.
 */
export function safeUrlAttr(raw: string | undefined, kind: 'link' | 'image'): string | null {
  if (!raw) return null;
  const resolved = resolveAsBrowserWould(raw);
  if (!resolved) return null;
  const allowed =
    kind === 'link'
      ? /^(?:https?:\/\/|mailto:[^\s@]+@|\/\/[^/\s])/i
      : /^(?:https?:\/\/|\/\/[^/\s])/i;
  return allowed.test(resolved) ? resolved : null;
}
