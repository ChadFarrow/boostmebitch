import { NextResponse } from 'next/server';
import { withErrorHandling, readCappedRequestJson, requireJsonBody, NO_STORE } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { readCappedJson } from '@/lib/capped-body';
import { BRAND } from '@/lib/brand';
import { bugReportBody, bugReportTitle, parseBugReport } from '@/lib/bug-report';

// Files an in-app bug report as a GitHub issue, so the reporter needs no GitHub
// account. `GITHUB_BUG_TOKEN` is server-only (never NEXT_PUBLIC): a
// fine-grained token with Issues: write on the one repo. Absent => 503, and
// the modal says reports are not set up.
//
// Unauthenticated, and every issue appears under the token owner's name, so:
// a tight per-IP limit, a capped body, and `parseBugReport` re-running every
// check the modal ran (allowlisted snapshot keys, secret refusal) — and
// `bugReportBody` fencing all caller text so it cannot @mention anyone.
// GitHub's error body is never reflected; see lib/bug-report.ts.

const MAX_REQUEST_BYTES = 32 * 1024;
const DEFAULT_REPO = 'ChadFarrow/boostmebitch';

export async function POST(req: Request) {
  const limited = rateLimit(req, 'bug-report', 3);
  if (limited) return limited;
  const notJson = requireJsonBody(req);
  if (notJson) return notJson;
  const read = await readCappedRequestJson(req, MAX_REQUEST_BYTES);
  if (!read.ok) return read.response;

  const report = parseBugReport(read.body);
  if (!report.ok) return NextResponse.json({ error: report.error }, { status: 400, headers: NO_STORE });

  const token = process.env.GITHUB_BUG_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'bug reports are not set up on this site' }, { status: 503, headers: NO_STORE });
  }
  const repo = process.env.GITHUB_BUG_REPO || DEFAULT_REPO;

  return withErrorHandling(async () => {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': BRAND.userAgent,
      },
      body: JSON.stringify({
        title: bugReportTitle(report.answers),
        body: bugReportBody(report.answers, report.info),
        // `user-report` is how the owner tells a listener's report from the
        // owner's own issues: both show the OWNER as the author, because the
        // token is the owner's. `bug` sorts it with the other bugs. Fixed
        // labels, never ones from the caller: the POST is unauthenticated.
        // GitHub keeps a label only when the token's owner can push to the
        // repo, and drops it SILENTLY otherwise — the issue is still filed,
        // just untagged.
        labels: ['bug', 'user-report'],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const issue = (await readCappedJson(res, 256 * 1024)) as { number?: unknown };
    const number = typeof issue.number === 'number' ? issue.number : null;
    return NextResponse.json({ number }, { headers: NO_STORE });
  }, 'could not send the report');
}
