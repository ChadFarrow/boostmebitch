import { BRAND } from './brand';
import { BUILD_ID } from './build-id';

// "Report a bug" opens a pre-filled GitHub "new issue" page. The reporter files
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
// value; ask the reporter to type what they are willing to publish.
export const BUG_REPORT_REPO = 'https://github.com/ChadFarrow/boostmebitch';

export interface BugReportEnv {
  pathname: string;
  userAgent: string;
  standalone: boolean;
  viewport: string;
}

export function bugReportUrl(env: BugReportEnv): string {
  const body = [
    '### What happened',
    '',
    '',
    '### What you expected',
    '',
    '',
    '### Steps to reproduce',
    '1. ',
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

// Browser only: reads `window` at click time, so nothing renders differently
// on the server.
export function openBugReport(): void {
  const url = bugReportUrl({
    pathname: window.location.pathname,
    userAgent: navigator.userAgent,
    standalone: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
  });
  window.open(url, '_blank', 'noopener,noreferrer');
}
