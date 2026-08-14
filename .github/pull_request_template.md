## What and why

<!-- The problem first, then the change. If the obvious implementation is
     wrong, say why here — that reasoning is the part nobody can reconstruct
     from the diff six weeks later. -->

## Checks

<!-- This repo has no test runner; `npm run check:*` IS the test suite and a
     failure is a stop. Name the ones you ran, or "all ten".

     typecheck / lint / build:
     Stop the dev server before `npm run build` — it rewrites .next and the
     running server then serves a mismatched chunk manifest. -->

## Verified vs. asserted

<!-- Which of this was actually exercised, and which is reasoning that has not
     been run? Say the second part plainly; "not verified live" is useful,
     silence is not.

     Money paths especially (boosts, streaming sats, splits, rails): was a real
     payment sent, on which rail, and did it land where the modal said? The
     failure mode here is that sats move and nothing on screen looks wrong. -->

## Docs

<!-- Reasoning goes in the relevant docs/*.md; CLAUDE.md holds only what must
     be known before opening a file — money/security invariants, boundaries,
     repo-wide conventions, the check table. Which did you touch, or why was
     neither needed? -->
