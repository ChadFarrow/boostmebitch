import { BRAND } from './brand';
import { BUILD_ID } from './build-id';
import { looksLikeSecretKey } from './nostr/npub-input';

// "Report a bug" asks three questions in <BugReportModal>, then opens a
// pre-filled GitHub "new issue" page. The reporter files
// it from their own GitHub account, so there is no server route, no token and
// nothing to rate-limit here.
//
// The repo is NOT a field on `BRANDS`. Both deploys report to the one repo, and
// `check:brand` fails any buddy field that carries the other brand's word — the
// repo name does. The visible name on both deploys is "BMB".
//
// **THE ISSUE IS PUBLIC.** Everything in the body is published under the
// reporter's GitHub account the moment they submit it. So the page is the
// PATHNAME only — never `search` or `hash`: `/amber-callback` carries the
// signer's result in its fragment, and `?podcast=`/`?episode=` say what the
// person listens to. Never add the npub, the rail, a wallet, or any `storage`
// value; ask the reporter to type what they are willing to publish — and refuse
// what they type if it holds a secret (`secretInReport`).
export const BUG_REPORT_REPO = 'https://github.com/ChadFarrow/boostmebitch';

// GitHub refuses a new-issue URL much past 8 KB. Measured on the BUILT URL,
// never on the field lengths: non-ASCII text grows up to 9× when encoded.
export const MAX_BUG_REPORT_URL = 8000;

export interface BugReportAnswers {
  happened: string;
  expected: string;
  steps: string;
}

export interface BugReportEnv {
  answers: BugReportAnswers;
  pathname: string;
  userAgent: string;
  standalone: boolean;
  viewport: string;
}

export function bugReportUrl(env: BugReportEnv): string {
  const body = [
    '### What happened',
    env.answers.happened.trim(),
    '',
    '### What you expected',
    env.answers.expected.trim(),
    '',
    '### Steps to reproduce',
    env.answers.steps.trim(),
    '',
    '---',
    `- Site: ${BRAND.domain}`,
    `- Build: ${BUILD_ID}`,
    `- Page: ${env.pathname}`,
    `- Installed app: ${env.standalone ? 'yes' : 'no'}`,
    `- Viewport: ${env.viewport}`,
    `- Browser: ${env.userAgent}`,
  ].join('\n');
  const q = new URLSearchParams({ title: '[BMB] ', body });
  return `${BUG_REPORT_REPO}/issues/new?${q.toString()}`;
}

// The issue is public, so a pasted key is burnt the moment it is submitted.
// Every whitespace-separated token is tested, because a key pasted into a
// sentence is as public as one pasted alone. `looksLikeSecretKey` is a prefix
// test that never decodes; an NWC string is a spending credential.
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

// Browser only: reads `window` at call time, so nothing renders differently
// on the server.
export function bugReportUrlHere(answers: BugReportAnswers): string {
  return bugReportUrl({
    answers,
    pathname: window.location.pathname,
    userAgent: navigator.userAgent,
    standalone: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
  });
}
