# Beta site: beta.boostmebitch.com

## Intent

One stable address where Chad tests several unmerged PRs together, on real
phones, before any of them reaches `www.boostmebitch.com`. A bad feature breaks
the beta site and leaves the main site as it was.

## Goals

- `beta.boostmebitch.com` serves the `beta` branch.
- `beta` is `main` plus a list of PR branches.
- One command adds or drops a PR and rebuilds `beta`, from either machine.
- The site says it is beta, including on a phone with no address bar.

## Non-goals

- No beta for `boostmebuddy.com`.
- No outside testers, so no password.
- No beta Android app. The TWA stays verified for `www` only.
- No automatic rebuild when a PR changes.
- Libre stays out of the list.

## Anti-goals

- `beta` never merges into `main`. Each feature still lands through its own PR.
- A push to `beta` never changes the production deployment.

## Constraints

- **Beta protects the code, not the data.** It uses the same relays, the same
  `SITE_NOSTR_SK` and real sats. Favorites (kind:10333) and the kind:30078
  wallet and settings backups have one copy per user across all deploys, so a
  beta bug can damage them. Boost notes keep `BRAND.origin`, so their links open
  `www`. Which account to sign in with is Chad's choice at each test.
- **Browser storage is per origin.** On beta, Chad signs in again and connects
  the wallet again.
- **Every push asks Chad first** (`workspace.md` rule 7), so the script never
  pushes. It prints the push command.
- **A squash merge changes the patch id.** Merging an already squash-merged
  branch again can conflict for no real reason, so a merged PR must leave the
  list before the merge step.

## Approaches

| Approach | Trade-off | Result |
|---|---|---|
| **A. Rebuild `beta` from a list** | Force push on each rebuild. `beta` stays current with `main`, and a dropped PR leaves no trace. | **Chad picked this.** |
| B. Keep one `beta` branch and merge into it | No script and no force push. Dropping a PR needs a revert, `docs/ops.md` records how a re-merge after a revert drops code with no error, and the branch moves away from `main`. | Not picked. |
| C. GitHub Action rebuilds from a PR label | Automatic, but it pushes without the push check, and nobody is there to fix a conflict. | Dropped. |

## Decided by Chad

- Approach A.
- The address is `beta.boostmebitch.com`.
- The first list is #512, #507 and #505.
- The Libre site goes offline and its code stays. This is separate work and is
  not part of this build.

## Calls made by the designer

Chad can overrule any of these.

**Hosting.** Same Vercel project (`boostmebitch`), with the domain bound to the
branch `beta`. This is the same model Libre used. It builds with the Preview
environment.

**The list lives on `beta`, in a file `.beta-branches`.** A change to the list
needs no PR into `main`, and both machines read the same list from `origin/beta`.

**The script is `scripts/beta.mjs`, run as `npm run beta -- <command>`.**

- `list` prints the current list.
- `add <pr-or-branch>` and `drop <pr-or-branch>` edit the list and rebuild. A PR
  number resolves to its head branch through `gh`.
- `rebuild` rebuilds from the current list.
- A rebuild runs in a temporary worktree, so the checkout does not change.
- It starts at `origin/main` and removes each entry whose PR is merged, with a
  printed note.
- It merges each `origin/<branch>` in list order.
- On a conflict, it stops, names the branch and the files, and leaves the local
  `beta` as it was.
- On success, it commits `.beta-branches`, moves the local `beta`, and prints
  `git push --force-with-lease=beta:<sha> origin beta`, with the `origin/beta` sha
  the list was read from.

**Conflicts get fixed on the PR branch**, so each rebuild stays clean. #505
conflicts with `main` in `package.json` and `CLAUDE.md`, at list lines only, so
`main` gets merged into `playback-log`. A trial merge with that fix showed #512,
#507 and #505 merge together with no conflict.

**Beta marker.** A variable `NEXT_PUBLIC_BETA=1`, scoped to the branch `beta`,
does three things and is inert everywhere else:

- It shows a small `BETA` tag. `<AppHeader>` has a 38px height limit and no spare
  width at 390px (`CLAUDE.md`), so the tag must not take space from the header.
- It sets `robots: noindex`. A preview on a custom domain gets no `X-Robots-Tag`
  from Vercel: `libre.boostmebitch.com` served none.
- It makes the bug report's `site` field say `beta.boostmebitch.com`. The field
  is `BRAND.domain` today, so a report from beta reads as a report from the main
  site.

**Variables, all scoped to the branch `beta`, so PR previews do not get them.**

| Variable | Source | Reason |
|---|---|---|
| `NEXT_PUBLIC_BETA` | new | the marker |
| `GITHUB_BUG_TOKEN` | Chad pastes it; the value is sensitive and is not in `.env.local` | #505 changes bug reports |
| `NOSTR_INDEX_URL`, `NOSTR_INDEX_KEY` | `.env.local`, never printed | beta reads like production; the app sends no write to the index |
| `PLAYLIST_DB_URL`, `PLAYLIST_DB_CA` | `.env.local`, never printed | same; `lib/playlist-db*.ts` has no write statement |

**The buddy project also builds `beta` as a preview.** It already builds every
branch. The preview has no domain and no marker, and this is harmless.

## Left to the builder

- The look and place of the `BETA` tag, measured at 390px under CDP device
  emulation, with `z-[70]` and `--dock-b` respected.
- Whether the script's pure parts get a `check:*` script.
- The section in `docs/ops.md`, and the `CLAUDE.md` pointer to it.

## Order of work

1. A PR into `main` with the script, the marker and the docs. Test it in a
   browser first.
2. Merge `main` into `playback-log`. The push asks Chad.
3. Build `beta` from the list and push it. The push asks Chad.
4. Add the domain to the Vercel project, bound to `beta`, and set the variables.
5. Redeploy `beta` and test it in a browser on the real address.

## Steps only Chad can do

- Add a DNS record for `beta` at Namecheap: type A, value `76.76.21.21`, the same
  as the Libre record.
- Paste `GITHUB_BUG_TOKEN` for the branch `beta`.
- Optional: add `https://beta.boostmebitch.com` to the authorized JavaScript
  origins in the Google console, if Google sign-in must work on beta.
