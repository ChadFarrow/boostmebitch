import { looksLikeSecretKey } from './nostr/npub-input';

// "Report a bug": <BugReportModal> asks three questions, takes a snapshot of
// the app, and POSTs both to /api/bug-report, which files a GitHub issue with a
// server-only token. The reporter needs no GitHub account and never leaves the
// app.
//
// Isomorphic on purpose. The browser uses it to preview and pre-check, and the
// route RE-RUNS every check here, because the route is an unauthenticated
// POST and a request that never came from the modal skips the modal's checks.
//
// **THE ISSUE IS PUBLIC** (the repo is), and it is filed under the token
// owner's account. Three rules follow:
// - The snapshot is a fixed ALLOWLIST of keys (`APP_INFO_KEYS`); the route
//   drops anything else. It never carries the npub, a key, a connection
//   string, a wallet balance or a URL query/fragment (`/amber-callback`'s
//   fragment is a signer result). The modal shows the user every value it
//   sends before they send it.
// - Free text is refused if it holds a secret (`secretInReport`), in the modal
//   AND in the route.
// - Every caller-supplied string is rendered inside a code fence, so it cannot
//   @mention anyone, cross-reference another repo's issue, or draw markup,
//   under the token owner's name — one unauthenticated POST must not notify
//   strangers.

export interface BugReportAnswers {
  happened: string;
  expected: string;
  steps: string;
}

/** The snapshot's keys, in the order the issue lists them, with their labels. */
export const APP_INFO_KEYS = [
  ['site', 'Site'],
  ['build', 'Build'],
  ['page', 'Page'],
  ['installedApp', 'Installed app'],
  ['online', 'Online'],
  ['viewport', 'Viewport'],
  ['browser', 'Browser'],
  ['signedIn', 'Signed in'],
  ['signer', 'Signer'],
  ['wallets', 'Wallets connected'],
  ['boostRail', 'Boost rail'],
  ['streaming', 'Streaming sats'],
  ['favoritesSync', 'Favorites sync'],
  ['favorites', 'Favorites'],
  ['nowPlaying', 'Now playing'],
  ['medium', 'Medium'],
  ['feedGuid', 'Feed guid'],
  ['episodeGuid', 'Episode guid'],
  ['position', 'Position'],
  ['playback', 'Playback'],
  ['live', 'Live status'],
] as const;

export type AppInfoKey = (typeof APP_INFO_KEYS)[number][0];
export type AppInfo = Partial<Record<AppInfoKey, string>>;

export const MAX_ANSWER_CHARS = 4000;
export const MAX_INFO_VALUE_CHARS = 400;

// The issue is public, so a pasted key is burnt the moment it is filed. Every
// whitespace-separated token is tested, because a key pasted into a sentence
// is as public as one pasted alone. `looksLikeSecretKey` is a prefix test that
// never decodes; an NWC string is a spending credential.
export function secretInReport(text: string): 'nsec' | 'nwc' | null {
  for (const raw of text.split(/\s+/)) {
    // Leading quotes and brackets: `"nsec1…"` and `(nsec1…)` are the same key.
    const token = raw.replace(/^[^a-z0-9]+/i, '');
    if (!token) continue;
    if (looksLikeSecretKey(token)) return 'nsec';
    if (token.toLowerCase().startsWith('nostr+walletconnect:')) return 'nwc';
  }
  return null;
}

/**
 * Validates a request body into a report, or returns the reason it is refused.
 * Unknown snapshot keys are DROPPED, never passed through.
 */
export function parseBugReport(
  raw: unknown,
): { ok: true; answers: BugReportAnswers; info: AppInfo } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid report' };
  const r = raw as { answers?: unknown; info?: unknown };
  const a = (r.answers && typeof r.answers === 'object' ? r.answers : {}) as Record<string, unknown>;
  const answers: BugReportAnswers = { happened: '', expected: '', steps: '' };
  for (const k of ['happened', 'expected', 'steps'] as const) {
    const v = a[k];
    if (v === undefined) continue;
    if (typeof v !== 'string') return { ok: false, error: `invalid ${k}` };
    if (v.length > MAX_ANSWER_CHARS) return { ok: false, error: 'report too long' };
    answers[k] = v.trim();
  }
  if (!answers.happened) return { ok: false, error: 'describe what happened' };

  const info: AppInfo = {};
  const i = (r.info && typeof r.info === 'object' ? r.info : {}) as Record<string, unknown>;
  for (const [k] of APP_INFO_KEYS) {
    const v = i[k];
    if (typeof v === 'string' && v) info[k] = v.slice(0, MAX_INFO_VALUE_CHARS);
  }

  const all = [answers.happened, answers.expected, answers.steps, ...Object.values(info)].join('\n');
  if (secretInReport(all)) return { ok: false, error: 'the report contains a secret key or wallet string' };
  return { ok: true, answers, info };
}

export function bugReportTitle(answers: BugReportAnswers): string {
  // The title is not fenced, so its `@` and `#` become their full-width forms:
  // no mention, no cross-reference, same reading.
  const first = answers.happened.split('\n')[0].trim().replace(/\s+/g, ' ')
    .replace(/@/g, '＠').replace(/#/g, '＃');
  const short = first.length > 80 ? `${first.slice(0, 77)}…` : first;
  return `[BMB] ${short || 'Bug report'}`;
}

// A fence longer than any backtick run in the text, so the text cannot close
// it (CommonMark). Inside a fence nothing is a mention, link or reference.
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text || '(not given)'}\n${fence}`;
}

export function bugReportBody(answers: BugReportAnswers, info: AppInfo): string {
  const infoLines = APP_INFO_KEYS
    .filter(([k]) => info[k])
    .map(([k, label]) => `${label}: ${info[k]}`)
    .join('\n');
  return [
    '### What happened',
    fenced(answers.happened),
    '',
    '### What they expected',
    fenced(answers.expected),
    '',
    '### Steps to reproduce',
    fenced(answers.steps),
    '',
    '### App snapshot',
    fenced(infoLines),
    '',
    '_Sent from the in-app bug report._',
  ].join('\n');
}
