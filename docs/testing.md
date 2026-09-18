# Testing this app without breaking production

Read this before you test a change that touches favorites, mutes, follows or the
profile, and before you run `npm run build` on a machine that has a dev server up.

CLAUDE.md carries the two rules; the reasoning is here, because none of it is
reconstructible from reading the source.

## The dev server and `.next` collide in BOTH directions

**Stop the dev server before `npm run build`.** The build rewrites `.next` and the
running server then serves a mismatched chunk manifest.

**And `rm -rf .next` before starting `dev` again**, because the collision runs the
other way too. A dev server started on a `.next` that a production build wrote
inherits production manifests — `prerender-manifest.json` sitting beside
`static/development` — and serves a mismatched chunk graph. It surfaces as:

```
undefined is not an object (evaluating 'originalFactory.call')
```

That is a React Refresh error, and it reads as an application bug, which is why
this costs a session every time it happens rather than a minute.

**A phone or a second browser keeps serving those chunks from its own cache**, and
a plain reload does not evict them. Retest in a private tab, or you will debug a
fix that already landed.

## "Testing locally" and "testing against local data" are DIFFERENT THINGS

A dev server on localhost still publishes to damus.io / primal.net / nos.lol under
whatever npub is signed in — including the shared kind:10333 event that another
app reads. A replaceable event keeps no history, so **a bug found that way is found
in production, on someone else's device too.**

A session touching favorites, mutes, follows or the profile uses these rather than
a real account.

| Command | What it is |
| --- | --- |
| `npm run relay` | ~40 lines of NIP-01 on `ws://127.0.0.1:7447`, in-memory, WITH replaceable-event semantics — the behaviour under test. Point the app at it with `localStorage.setItem('bmb:relays', …)`; that key replaces only the PUBLISH set. Feed reads and `PROFILE_RELAYS` still reach the public network, so this is **not** a hermetic offline mode. |
| `npm run seed:relay -- <npub>` | Copies that account's real kind:10333 into it, strictly read-only against the public relays. An empty relay is the EASY state; the ones that have cost this repo data need a list with history in it. |
| `npm run e2e:favorites` | The whole loop with no account involved: a throwaway key reached from the page over a CDP binding, so `window.nostr` is indistinguishable from an extension and the NIP-44 is real. `--headed` to watch it. |
| `npm run e2e:mutes` | The same harness over the kind:10000 private half — which cipher each payload routes to, that a NIP-44 list is republished as NIP-44, and that an unreadable blob is carried and said so on screen. |

### Two things about the harness that look like detail and are not

**`local-relay.mjs` live-pushes new events to open subscriptions, and that is not
decoration.** NIP-01 requires it, and without it the fixture only answers what it
held when the REQ arrived — fatal to anything request/response, because the reply
is published *after* the requester subscribed. NIP-46 is entirely that shape, so a
bunker session could not complete one call, and the symptom was a connect that
never resolved.

**`scripts/e2e-favorites.mjs` imports `createRelay` from `local-relay.mjs` — do not
give it its own.** It had one, and the copy had already drifted into replacing a
NEWER event with an older one, in the file whose job is to prove replacement works.

**`e2e:mutes` scenario 5 stands up a real NIP-46 bunker**, because writing
`bmb:signer = 'bunker'` alone signs the app out inside a second. Seed timestamps
must be in the PAST, or the app's own republish is the older event and the relay
rejects it.

## Every `e2e:*` script drives Chrome through `scripts/cdp.mjs` — never a copy

Eleven scripts each carried their own Chrome-and-CDP boilerplate, and the copies
had drifted in exactly the places that cost something. The harness now owns
those, and a new script imports it rather than pasting a twelfth copy:

- **Always muted.** `e2e-playlist` turned on autoplay without `--mute-audio` and
  played `public/boost.mp3` out loud; an earlier throwaway driver played a live
  stream through the speakers from tabs a previous run had left behind.
- **Port 0, never a fixed port.** `launchChrome` passes
  `--remote-debugging-port=0` and reads the port Chrome bound from
  `<profile>/DevToolsActivePort`. With fixed ports two scripts shared 9224, and a
  leftover Chrome on a fixed port answers `/json/list` for the NEXT run — which
  then drives the wrong browser and kills a process that owns nothing. The
  relays the e2e scripts start are on port 0 for the same reason
  (`createRelay` returns `ready`, a promise of the bound port); `npm run relay`
  keeps 7447 for a human.
- **Always `exit(code)` at the end.** A script holding a relay or a socket open
  does not return on its own, and only a GREEN run hangs, because the failure
  path already exited. `exit` closes every browser first; the `exit`, SIGINT and
  SIGTERM hooks close them on any other way out, and `close()` sweeps `ps` for
  anything still holding the profile before deleting it.

`checker()` keeps both assertion shapes the scripts already used —
`equal(label, actual, expected)` and `ok(label, cond, detail)` — so a migrated
assertion keeps its meaning, and every result line starts `ok` or `FAIL`.

## A branch "N commits ahead of `main`" is NOT unfinished work

A squash merge changes the patch id, so `git log main..`, `git cherry` and
`git branch -d` all call a merged branch unmerged. Ask `gh pr list --state merged`
instead.

A stale `.claude/worktrees/` entry keeps its branch alive and reads the same way —
check `git worktree list`.
