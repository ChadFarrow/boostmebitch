// One line of the playback diagnostic log — the format, and the test a line
// must pass to be stored, shown, or filed.
//
// An import-free leaf, so `lib/storage.ts` (which may not reach `lib/nostr/`
// through `lib/bug-report.ts`), the recorder (`lib/playback-log.ts`, browser
// only) and the bug report route (server) can all agree on it.
//
// **THE LINE IS FILED INTO A PUBLIC ISSUE**, so the format is an allowlist of
// characters rather than a description of what we happen to write:
//
//   22:31:05.123 m.ended el=a rs=4 ct=5496 paused=1
//
// a UTC time of day, an event code, and up to eight `key=value` fields whose
// values may hold only `[A-Za-z0-9_.-]`, at most 32 characters. No `/`, `?`,
// `:` or `=` can appear in a value, so no URL, query, NWC string or `nostr:`
// URI fits; 32 characters is shorter than any key (an nsec is 63, a hex key
// 64). The route re-runs `isPlaybackLogLine` on every line, because it is an
// unauthenticated POST and anybody can send it any text.

/** How many lines the device keeps, and the most a report may carry. */
export const PLAYBACK_LOG_CAP = 150;

const MAX_FIELDS = 8;
const MAX_VALUE_CHARS = 32;

const LINE = /^\d{2}:\d{2}:\d{2}\.\d{3} [a-z][a-z0-9_.]{0,23}( [a-z][a-z0-9]{0,11}=[A-Za-z0-9_.-]{1,32}){0,8}$/;

export function isPlaybackLogLine(line: string): boolean {
  return LINE.test(line);
}

export type PlaybackLogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Formats one line, or returns `null` when the code or a key is not in the
 * format — a programming error, dropped rather than stored. Values are FORCED
 * into the format (disallowed characters become `_`, then truncated), because
 * a value is often something a browser handed us (an error name) and a line
 * must never be lost to its spelling.
 */
export function formatPlaybackLogLine(at: Date, code: string, fields: PlaybackLogFields = {}): string | null {
  const time = at.toISOString().slice(11, 23);
  const parts = [time, code];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    if (parts.length - 2 >= MAX_FIELDS) break;
    const value = (typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
      .replace(/[^A-Za-z0-9_.-]/g, '_')
      .slice(0, MAX_VALUE_CHARS);
    parts.push(`${k}=${value}`);
  }
  const line = parts.join(' ');
  return isPlaybackLogLine(line) ? line : null;
}
