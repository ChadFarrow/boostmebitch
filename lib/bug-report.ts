import { wordlist as bip39Words } from '@scure/bip39/wordlists/english.js';
import { looksLikeSecretKey } from './nostr/npub-input';
import { isPlaybackLogLine, PLAYBACK_LOG_CAP } from './playback-log-line';

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
//   fragment is a signer result), nor what the person listens to or how
//   their account is set up. The modal shows the user every value it
//   sends before they send it.
//   The page path's npub segment is elided (`reportPath`).
// - Free text is refused if it holds a secret (`secretInReport`: an nsec, an
//   NWC string, a 64-hex key or a BIP-39 seed phrase), in the modal AND in the
//   route.
// - Every caller-supplied string is rendered inside a code fence, so it cannot
//   @mention anyone, cross-reference another repo's issue, or draw markup,
//   under the token owner's name — one unauthenticated POST must not notify
//   strangers.
//
// The PLAYBACK LOG (`lib/playback-log.ts`) rides under the same consent as the
// snapshot and the same three rules, plus a fourth: every line must pass
// `isPlaybackLogLine`, a character allowlist no URL, key or wallet string can
// satisfy. A line that fails is dropped, never repaired.

export interface BugReportAnswers {
  happened: string;
  expected: string;
  steps: string;
}

/**
 * The snapshot's keys, in the order the issue lists them, with their labels.
 *
 * App STATE only, never facts about the PERSON: no npub, key, connection
 * string, balance or URL query, and also nothing that says what they listen
 * to or how they set up their account — no now-playing title, feed or episode
 * guid, position, favorites counts or signer type (all removed 2026-11-04 at
 * the owner's request). `browser` is a coarse family (`coarseBrowser`), never
 * the user-agent string. A key added here reaches a public issue.
 */
export const APP_INFO_KEYS = [
  ['site', 'Site'],
  ['build', 'Build'],
  ['page', 'Page'],
  ['installedApp', 'Installed app'],
  ['online', 'Online'],
  ['viewport', 'Viewport'],
  ['browser', 'Browser'],
  ['signedIn', 'Signed in'],
  ['wallets', 'Wallets connected'],
  ['boostRail', 'Boost rail'],
  ['streaming', 'Streaming sats'],
  ['favoritesSync', 'Favorites sync'],
  ['medium', 'Medium'],
  ['playback', 'Playback'],
  ['live', 'Live status'],
] as const;

export type AppInfoKey = (typeof APP_INFO_KEYS)[number][0];
export type AppInfo = Partial<Record<AppInfoKey, string>>;

export const MAX_ANSWER_CHARS = 4000;
export const MAX_INFO_VALUE_CHARS = 400;

export type ReportSecret = 'nsec' | 'nwc' | 'hex' | 'mnemonic';

// A seed phrase is 12 to 24 words; 12 in a row is the shortest one there is.
const MNEMONIC_RUN = 12;
const BIP39 = new Set<string>(bip39Words);
const HEX_KEY = /^(?:0x)?[0-9a-f]{64}$/i;
// "1." / "2)" / "3:" numbering in a pasted seed list neither counts nor breaks a run.
const NUMBERING = /^\d{1,2}[.):]?$/;

// The issue is public, so a pasted key is burnt the moment it is filed. Every
// whitespace-separated token is tested, because a key pasted into a sentence
// is as public as one pasted alone. `looksLikeSecretKey` is a prefix test that
// never decodes; an NWC string is a spending credential.
//
// `typed` adds the two tests that cannot tell a secret from an ordinary value
// by shape alone, and so run on what the USER TYPED only, never on the
// snapshot: a 64-hex token (a raw private key — and also an event id or a
// pubkey, which is why the refusal names the bech32 forms as the way round
// it; feeds use sha256 hex as an episode guid, so the snapshot would refuse
// every report about one), and a run of 12+ BIP-39 words (the Spark wallet's
// seed, which is the whole wallet). English prose does not produce 12 list
// words in a row: "the", "a", "to", "is" and "it" are not on the list.
export function secretInReport(text: string, typed = true): ReportSecret | null {
  let run = 0;
  for (const raw of text.split(/[\s,;]+/)) {
    // Leading quotes and brackets: `"nsec1…"` and `(nsec1…)` are the same key.
    const token = raw.replace(/^[^a-z0-9]+/i, '');
    if (!token) continue;
    if (looksLikeSecretKey(token)) return 'nsec';
    if (token.toLowerCase().startsWith('nostr+walletconnect:')) return 'nwc';
    if (!typed) continue;
    const bare = token.replace(/[^a-z0-9]+$/i, '');
    if (HEX_KEY.test(bare)) return 'hex';
    if (NUMBERING.test(bare)) continue;
    run = BIP39.has(bare.toLowerCase()) ? run + 1 : 0;
    if (run >= MNEMONIC_RUN) return 'mnemonic';
  }
  return null;
}

const BROWSERS = ['Edge', 'Samsung Internet', 'Opera', 'Firefox', 'Chrome', 'Safari'] as const;
const SYSTEMS = ['Android', 'iOS', 'Windows', 'macOS', 'ChromeOS', 'Linux'] as const;
const COARSE_BROWSER = new RegExp(
  `^(?:${BROWSERS.join('|')}|Other browser)(?: \\d{1,4})?, (?:${SYSTEMS.join('|')}|Other OS)$`,
);

/**
 * A user-agent reduced to browser family, major version and OS family, e.g.
 * `Chrome 131, Android`. The full string carries the device model and minor
 * versions, which narrow a public reporter down. The output is built from two
 * fixed lists, so nothing from the input reaches the issue but one number.
 * Idempotent: the route re-runs it on what the modal sent.
 */
export function coarseBrowser(ua: string): string {
  if (COARSE_BROWSER.test(ua)) return ua;
  const pick: [(typeof BROWSERS)[number], RegExp][] = [
    ['Edge', /\bEdg(?:e|A|iOS)?\/(\d+)/],
    ['Samsung Internet', /\bSamsungBrowser\/(\d+)/],
    ['Opera', /\b(?:OPR|OPiOS)\/(\d+)/],
    ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
    ['Chrome', /\b(?:Chrome|CriOS)\/(\d+)/],
    ['Safari', /\bVersion\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//],
  ];
  let browser = 'Other browser';
  for (const [name, re] of pick) {
    const m = ua.match(re);
    if (m) { browser = `${name} ${m[1].slice(0, 4)}`; break; }
  }
  const os = /\b(?:iPhone|iPad|iPod)\b/.test(ua) ? 'iOS'
    : /\bAndroid\b/.test(ua) ? 'Android'
      : /\bCrOS\b/.test(ua) ? 'ChromeOS'
        : /\bWindows\b/.test(ua) ? 'Windows'
          : /\bMac OS X\b|\bMacintosh\b/.test(ua) ? 'macOS'
            : /\bLinux\b/.test(ua) ? 'Linux'
              : 'Other OS';
  return `${browser}, ${os}`;
}

/**
 * The page path with any Nostr identity segment elided: `/npub/<npub>` and
 * `/live/<npub>` name a person, and on the reporter's own profile that person
 * is the reporter. The route re-runs it, because the POST is unauthenticated.
 */
export function reportPath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => (/^(?:npub1|nprofile1)/i.test(seg) ? '…' : seg))
    .join('/');
}

/**
 * Validates a request body into a report, or returns the reason it is refused.
 * Unknown snapshot keys are DROPPED, never passed through.
 */
export function parseBugReport(
  raw: unknown,
): { ok: true; answers: BugReportAnswers; info: AppInfo; log: string[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid report' };
  const r = raw as { answers?: unknown; info?: unknown; log?: unknown };
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
  if (info.page) info.page = reportPath(info.page);
  if (info.browser) info.browser = coarseBrowser(info.browser);

  // The NEWEST lines are kept: the end of the log is where the bug is.
  const log = (Array.isArray(r.log) ? r.log : [])
    .filter((l): l is string => typeof l === 'string' && isPlaybackLogLine(l))
    .slice(-PLAYBACK_LOG_CAP);

  const typed = [answers.happened, answers.expected, answers.steps].join('\n');
  const app = [...Object.values(info), ...log].join('\n');
  if (secretInReport(typed) || secretInReport(app, false)) {
    return { ok: false, error: 'the report contains a secret key, seed phrase or wallet string' };
  }
  return { ok: true, answers, info, log };
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

export function bugReportBody(answers: BugReportAnswers, info: AppInfo, log: string[] = []): string {
  const infoLines = APP_INFO_KEYS
    .filter(([k]) => info[k])
    .map(([k, label]) => `${label}: ${info[k]}`)
    .join('\n');
  // These four headings are also the field labels of `.github/ISSUE_TEMPLATE/bug.yml`,
  // so a bug filed on GitHub reads like one filed from the app. Rename both together.
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
    infoLines ? fenced(infoLines) : '_The reporter chose not to send app info._',
    '',
    ...(log.length ? ['### Playback log (UTC, oldest first)', fenced(log.join('\n')), ''] : []),
    '_Sent from the in-app bug report._',
  ].join('\n');
}
