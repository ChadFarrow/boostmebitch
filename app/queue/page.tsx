import { permanentRedirect } from 'next/navigation';

// `/queue` was the dock's Up Next tab until 2026-10-01, when it became the
// Listen tab at `/listen` (Up Next and the play history). A shared link, a
// bookmark or the installed app's last route can still say `/queue`, so this
// sends it on rather than to a 404. Here and not in `next.config.mjs`, which
// carries the security headers and is reviewed as such (docs/security.md).
export default function Page() {
  permanentRedirect('/listen');
}
