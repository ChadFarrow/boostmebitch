# Week review: `main` from 2026-09-17 to 2026-09-26, checked one item at a time

## Why this exists

On 2026-09-25 features that worked a week earlier looked broken: a live show's
value-time split was not paid, and boosts went out as NIP-57 zaps instead of
Podcasting 2.0 payments (keysend with TLV 7629169, or LNURL with the BoostBox
`rss::payment` descriptor). This is the list of the week's merged changes, each
with the check that proves it still does what it claims. Tick an item when its
check passes; a failed item gets its own branch off `origin/main` and its own PR,
and no fix is written before the cause is found.

- Baseline: `4dcccca` (2026-09-17 23:43 EDT, #415). Reviewed up to `b810663` (#448).
- The zap change landed on 2026-09-16 (#402), a day before the baseline, so the
  payment items start there.
- A blame scan of every commit's deleted lines in the window found no revert or
  stacked merge that silently removed another PR's code. #421's re-land of the
  reverted #389 kept every change other PRs made to the 13 files they shared.

## What is already settled

| # | Status | What | Evidence |
|---|---|---|---|
| F1 | Fixed, #450 (`f62e0ac`) | #422's queued-notes effect re-fetched `/api/feed` in a loop | 984 reads in 15 s on a paused queue head, now ≤ 2; `e2e:queue` section 8 |
| F2 | Fixed, #444 + #447 | Boost legs paid as zaps since #402 (2026-09-16) | Seen in Helipad before 16:26 EDT on 09-25, i.e. before #444 deployed |
| F3 | Fixed, #449 (`a220b37`) | A live boost from the episode page or a list row paid the show's block | Only `<Player>` handed the modal the swapped block, before the window too |
| F4 | Wanted behavior, #449 | A live block now pays its `remotePercentage` and the show the rest | Confirmed as the expected split (e.g. 90/10); matches streaming's `allocationAt` |
| F5 | Deliberate, #422 | The dock's Wallet tab became Queue; the fullscreen bar lost its wallet chips | `tab-bar.tsx`, `auth-control.tsx` — see item 15 |
| F6 | Done, #448 + msp-podping-service #3 | `/live` reads the podping viewer's `GET /api/live` | `PODPING_VIEWER_URL` set in both Vercel projects on 2026-09-26; both sites answer `podping: ok` |

## Open follow-ups

- [ ] **Phone test for #450.** Force-close the installed app, reopen it, play a
  queued episode: taps stay responsive. It is the likely cause of the slow taps
  reported on 2026-09-25.
- [ ] **A real `live` podping reaches `/live`.** When a show goes live, it must
  appear in `https://pp.musicsideproject.com/api/live` (with a `piFeedId`) and
  then on the Live tab with no favorite or search. The query is tested against a
  real Postgres; only live data is missing.
- [ ] **Homegrown Hits, Thursday 2026-10-02.** A local cron job records every
  Split Kit block of the show (`probe:live`, 19:30 EDT for 330 min, into
  `~/probe-logs/hgh-2026-10-02.log` on the laptop). Read the log (item 7), then
  remove the crontab lines.
- [ ] **Viewer `/health` takes 13–15 s.** It runs `max(block_num)` and no index
  covers `block_num`. A small msp-podping-service PR adds one.
- [ ] **`pp_database` memory cap.** The viewer writes the podping firehose again;
  the Postgres used 3.8 GB in July. The viewer README asks for a 512 MB–1 GB limit.
- [ ] **`PODCAST_INDEX_SECRET` in the boostmebuddy Vercel project** is flagged
  `readable-secret`; save it again as a sensitive variable (boostmebitch already is).
- [ ] Delete the merged branch `fix/queued-notes-refetch-loop`.

## The checklist

### A. Payments

- [ ] **1. The zap rail is gone** — #402 `427f926` → #444 `1871dd5`, #447 `6dcfd9d`.
  Signed in, sharing as yourself, boost a show whose payees include an
  `allowsNostr` Lightning address (reed@getalby.com). Helipad must show the app,
  podcast and episode, not "Lightning Invoice". Repeat on NWC and on Spark. Only
  `components/nostr-note-card.tsx` still calls `sendZap` (zapping a note).
- [ ] **2. A stale app copy after a deploy** — #421's `app/sw.js` serves
  `/_next/static/*` cache-first with `skipWaiting` + `clients.claim`, and
  `components/sw-register.tsx` has no update check or reload. An installed app
  resumed from memory can run the previous deploy until it reloads.
- [ ] **3. The note's ⚡ figure is a zap receipt by design** — #408 `9673b57`
  (`lib/nostr/zap-summary-receipt.ts`). It moves no sats, but Fountain and
  Primal draw it as a zap; only Helipad proves the rail.
- [ ] **4. An LNURL leg paid with no comment** — #404 `eb72903`: when a service
  refuses the comment and the descriptor alone does not fit, `lib/v4v/lnaddr.ts`
  retries with no comment, so the leg carries no `rss::payment` descriptor.
  `check:lnurl`; read the `[lnurl]` console lines of a boost that showed as a bare invoice.
- [ ] **5. The keysend lookup lost Next's data cache** — #443 `ea543ee`:
  `safeFetch` forces `cache: 'no-store'`, and `app/api/keysend/route.ts` lost
  `revalidate: 3600` (the CDN `s-maxage` stays). A `.well-known/keysend` slower
  than 3.5 s is recorded as "no keysend" for 15 min, so a keysend-capable address
  pays over LNURL. Read the `[keysend]` console lines on a boost to an Alby address.
- [ ] **6. Nostr live-stream (kind:30311) boost: zap → keysend/LNURL** — #444,
  never driven end to end. Boost a zap.stream show: the payee is the host's
  kind:0 `lud16`, the leg carries TLV 7629169 or the descriptor, and the chat
  line posts only when sharing as yourself.
- [ ] **7. A live Podcasting 2.0 item pays the on-air track** — F3, F4. Boost from
  the player, the episode page and a list row; the rows and the legs must name
  the on-air track, and streaming must pay the same block.
  - 2026-09-25, Homegrown Hits ep.152: **every** track block paid only the
    show's four payees (MaryKateUltra 50, DuhLaurien 49, BoostAfterBoost 1,
    Podcastindex.org fee 1), under each track's title and art. The app paid
    exactly the payload: `onLiveBlock` takes the title and the payees from one
    Split Kit block, and `targetSig` compares both. `lib/v4v/live-*.ts` did not
    change in the window, and Split Kit's source has not changed since 2026-03-13.
  - Split Kit's `processBlock` (github.com/thebells1111/thesplitkit,
    `src/lib/functions/dashboard/processBlock.js`) merges the show's payees ×
    (100 − split) with the track's × split, with `splitDeduct = 0` when the track
    block has no destinations — which produces exactly the show's payees under
    the track's title. It also deletes `settings`, so `remotePercentage` is always
    undefined for Split Kit (the split is pre-merged; ep.145 sent 99% to the track).
  - The artist has a wallet: "Home Massage" (The Physics Of Sound, feed 8042933)
    pays `user30579190@fountain.fm` 90 / `boostbot@fountain.fm` 10, and Split
    Kit's own Podcast Index proxy returned it on 2026-09-25. Why the blocks were
    empty is not proven. The Thursday recording shows the raw payloads.
- [ ] **8. #443 is 18 commits under a NIP-46 title** — money commits inside: a
  non-finite split weight pays 0, `splitSats` string coercion, streaming reads a
  non-2xx `/api/value-splits` as "could not ask", the playlist fan-out uses
  `mapLimit`, recipient names are entity-decoded, failed legs are explained, and
  `/api/audio` caps the URL at 4096 characters. `check:vts`, `check:musicl`,
  `check:nwcbudget`, `check:downloads`.
- [ ] **9. Which value block an episode pays** — #434 `0869ff7` (the feed's block
  outranks Podcast Index's stale copy), #440 `0ce1f4a` (keep PI's when the feed
  has none). `check:musicl`; boost an episode where the two disagree.
- [ ] **10. A downloaded episode pays the song** — #421 (`downloadEpisodeId`).
  `check:downloads`; boost inside a VTS window while a downloaded copy plays.
- [ ] **11. Bounded payee caches; `lnurlFetch` is https-only** — #420 `a877598`.
  `check:keysend`, `check:cache`; a boost that mixes keysend and LNURL legs.
- [ ] **12. `value_msat_total` per leg group** — #403 `c6aa51d`. `check:vts`; Boost-all on an album.
- [ ] **13. The boost note names the track it paid** — #433 `03008d1`. The 🎵 line
  appears only when a track leg paid.

### B. Player, queue, live, UI

- [x] **14. The queued-notes refetch loop** — #422, fixed by #450.
- [ ] **15. Wallet reachability** — #422 removed the dock's Wallet tab and the
  fullscreen wallet chips. On `/live/<npub>` and `/stream/<naddr>`, with BOOST
  disabled, no wallet control is on screen. The fullscreen bar also mounts a
  third `useWalletBalance` reader (`fullscreen-player.tsx`), against the note in
  `auth-control.tsx` that keeps it to two.
- [ ] **16. Downloads re-land and the now-playing redesign** — #421 `b2ed006`:
  seven actions behind ⋯, the episode row below `lg` is BOOST + ⋯, lazy panes,
  resume fixes, the `/api/audio` fallback. `e2e:downloads` against `npm start`.
- [ ] **17. Listen queue** — #422 `909beae`: ⏭/⏮ follow the queue, Up Next left
  the now-playing screen. `e2e:queue`.
- [ ] **18. New episodes from favorites** — #424 `718dafd`; the favorites header
  dropped its PLAYLISTS link. `check:favnew`.
- [ ] **19. Resume position and seek-bar chapter hover** — #414 `3bf49c0`, #415 `4dcccca`.
- [ ] **20. A Podcast Index `0` is no timestamp** — #426 `da21c39`. `check:liveover`, `check:livemerge`.
- [ ] **21. Controls look like controls** — #427; **one BOOST gate** — #416 `02bbfdb`.

### C. Wallets, signers, feeds, index

- [ ] **22. Signers and NWC backup** — NIP-46 reconnect without asking (#428);
  the dead relay.nsec.app replaced in the nostrconnect link (#446); the NWC
  backup card, its unanswered read and the untick + Disconnect path (#436, #439, #445).
- [ ] **23. Feeds and favorites** — episodes Podcast Index has not crawled yet
  (#435); the favorites degraded read retries itself (#430).
- [ ] **24. Read index and brand** — the index's tracked-set loop and REQ limits
  (#423, Railway — deploys separately); the boostmebuddy boost sound (#429).

### D. Added during the review

- [x] **25. #448** — a live favorite stays in every `/live` poll, and the podping
  roster. Its podping half needed the viewer's `GET /api/live`, which lived on
  an unmerged branch of msp-podping-service, and the viewer itself had been
  down since 2026-08-11 (its Postgres stopped on 2026-08-10). msp-podping-service
  #3 (`7758531`) added the route, stamped podpings with their block time instead
  of the clock, and skipped a backlog longer than a day (`MAX_CATCHUP_BLOCKS`);
  the restart skipped 1,626,561 blocks. A merge there redeploys the viewer AND
  restarts the podping pusher — neither Railway service has watch paths.
