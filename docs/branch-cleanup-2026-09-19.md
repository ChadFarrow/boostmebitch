# Branch and PR cleanup — 2026-09-19

A one-off working note, not a rule document. Delete it once the commands below
have been run. It exists because branch deletion could not be done from the
session that did the rest of this work — the git proxy answers `403` to a ref
deletion — so the four deletes have to happen on a machine with normal push
rights.

## Run these

```bash
git fetch --prune origin
git push origin --delete \
  fix/keyboard-inset-phantom \
  feature/inbox-listen-queue \
  claude/zap-quote-body-form-test \
  claude/unchecked-shows-meaning-ebd9u6
```

Tips, if one of them ever needs recovering:

| Branch | Tip | Why it is safe to delete |
|---|---|---|
| `fix/keyboard-inset-phantom` | `049b4c4` | PRs #340–#345 merged; three distinctive strings from its top commit verified present in `main` |
| `feature/inbox-listen-queue` | `d046ae7` | PR #132 closed unmerged; `feat/listen-queue` redid the work, and `feat/queue-inbox` now carries it |
| `claude/zap-quote-body-form-test` | `1798583` | PR #406 closed draft; the Fountain question it asked was answered by #408, which merged |
| `claude/unchecked-shows-meaning-ebd9u6` | `ea33ca5` | Its one commit is on `feat/queue-inbox` as `693a98f`, resolved against the persisted-list change |

## Branches to KEEP, and why

| Branch | Keep because |
|---|---|
| `feat/queue-inbox` | The working branch: queue + new episodes + downloads |
| `feat/listen-queue` | The queue's original history and PR #390's review thread |
| `feat/favorites-new` | The new-episodes original history |
| `merge/stack-onto-main` | The base `feat/queue-inbox` was cut from |
| `feat/downloads` | Downloads is **reverted**, not unmerged — see below |
| `docs/kind3-signer-limit` | `92ee801` is genuinely unmerged. PRs #395 and #399 were both closed without merging, and its 35 lines of `docs/signers.md` are not on `main` — verified by string search. It needs a new PR |
| `feat/libre-wallet-embed` | PR #120 closed as stale; the branch is untouched if the rail is ever wanted |

The last three are judgement calls rather than cleanup. Nothing breaks if they
stay.

## Pull requests — all closed

| PR | Head | Why |
|---|---|---|
| #418 | `feat/queue-inbox` | Carried #398's title and body, conflicted with `main`, and would have restored the reverted downloads |
| #398 | `claude/unchecked-shows-meaning-ebd9u6` | Its commit is on `feat/queue-inbox` |
| #397 | `merge/stack-onto-main` | The stack is inside `feat/queue-inbox` |
| #390 | `feat/listen-queue` | The queue is inside `feat/queue-inbox` |
| #120 | `feat/libre-wallet-embed` | Draft, "do not merge yet", last commit 18 July |

Each carries a comment naming where its work went. No branch was touched, so any
of them reopens.

## Two facts worth not rediscovering

**Downloads is a REVERTED feature, not unmerged work.** `main` carries
`32685d6` ("Downloads… (#389)") and then `92576d7`, the revert. So `main` holds
no downloads files at all, while `feat/downloads`, `merge/stack-onto-main` and
`feat/queue-inbox` each hold ten. Merging `feat/queue-inbox` as it stands puts
the reverted feature back. That is a decision to make deliberately, not a
side effect of merging the queue.

`merge/stack-onto-main`'s `0ab0b4c`, "Write down what a merge does not tell you
about a reverted feature", writes this up properly in `docs/ops.md` and
`CLAUDE.md`. It is **not** on `main`. Cherry-picking it conflicts with
`CLAUDE.md` as `main` now stands, so it wants a deliberate pass rather than a
drive-by one:

```bash
git cherry-pick 0ab0b4c   # expect a CLAUDE.md conflict, and mind check:claudemd's budget
```

**A branch "N commits ahead of `main`" proves nothing**, which is why every
verdict above was checked against the merged-PR list and against `main`'s own
tree rather than against a commit count. `CLAUDE.md` states the rule; this is
the pass that applied it.
