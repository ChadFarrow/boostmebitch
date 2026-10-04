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
- **Re-checked on 2026-10-04 against `main` at `6be0b54` (#489)**, 26 PRs past the
  window: `npm run typecheck` and `npm run lint` clean; `npm run check` → all 46
  `check:*` PASS, `check:conformance` 28 pass / 3 fail (the expected three).
  The e2e results are quoted under each item: `e2e:queue` OK; `e2e:downloads`,
  `e2e:resume` and `e2e:seekhover` RED (items 16 and 19). Items that need a
  phone, a real payment or a live show stay open.
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
- [x] **A real `live` podping reaches `/live`.** When a show goes live, it must
  appear in `https://pp.musicsideproject.com/api/live` (with a `piFeedId`) and
  then on the Live tab with no favorite or search.
  - 2026-10-04: `/api/live` listed 5 feeds, each with a `piFeedId` (godcaster.fm
    and blurt.media shows). `https://boostmebitch.com/api/live-shows` answered
    `podping: ok`, `podpingFeeds: 5`, `rosterKept: 0`, and two live rows
    (Wildwood Radio - LIVE, CityLight LA 24/7 - LIVE) — rows that only the
    podping list supplied.
- [ ] **Homegrown Hits ep.154, Thursday 2026-10-08.** A local cron job records
  every Split Kit block of the show into `~/probe-logs/hgh-2026-10-08.log` on the
  laptop. Read the log (item 7), then remove the crontab lines.
  - The 2026-10-02 run recorded no show, for two reasons. 2026-10-02 was a
    Friday, and ep.153 had already aired on Thursday 2026-10-01; at 19:30 the
    feed's live item was ep.154, `status=pending`. Also the lid closed at
    19:55:52 EDT and the laptop slept until 10-03 10:30. The log holds two empty
    `{}` pushes only.
  - New entry: 2026-10-08 18:50 EDT, 360 min, 60 s feed poll. The time comes
    from the feed: `<podcast:liveItem status="pending"
    start="2026-10-08T18:00:59-0500">` (19:00 EDT). Dry run under `env -i`
    passed on 2026-10-04.
  - **Keep the lid open and the laptop on power 18:50–00:50 EDT.** A
    `systemd-inhibit` wrapper cannot help from cron here: polkit gives the
    `sleep` and `handle-lid-switch` inhibitors `implicit any: no`, cron has no
    `pam_systemd` session, and a lid close ignores sleep inhibitors by default.
- [ ] **Viewer `/health` is slow.** It runs `max(block_num)` and no index covers
  `block_num`. 13–15 s on 2026-09-26 during the first prune; 3.1 s on
  2026-10-04. A small msp-podping-service PR adds the index.
- [x] **`pp_database` memory cap.** The Railway limit is set at 500 MB
  (`serviceInstanceLimits.memoryBytes = 500000000`). Over the 6 h before
  2026-10-04 17:25 EDT the Postgres used 0.487–0.498 GB, which is at the cap;
  watch for OOM restarts.
- [x] **`PODCAST_INDEX_SECRET` in the boostmebuddy Vercel project** is flagged
  `readable-secret`; save it again as a sensitive variable (boostmebitch already is).
  - 2026-10-04: saved again as `sensitive` (env id `eQdlO6oFQrwpisxS`), targets
    `production` + `preview` like boostmebitch's, no security issues. The old
    `encrypted` copies are gone. The running deployment keeps the value it was
    built with; the next deployment reads the new variable.
- [x] Delete the merged branch `fix/queued-notes-refetch-loop`. The remote branch
  was already gone; the local copy (`909969f`) was deleted on 2026-10-04.

## The checklist

### A. Payments

- [ ] **1. The zap rail is gone** — #402 `427f926` → #444 `1871dd5`, #447 `6dcfd9d`.
  Signed in, sharing as yourself, boost a show whose payees include an
  `allowsNostr` Lightning address (reed@getalby.com). Helipad must show the app,
  podcast and episode, not "Lightning Invoice". Repeat on NWC and on Spark. Only
  `components/nostr-note-card.tsx` still calls `sendZap` (zapping a note).
  - 2026-10-04 on `6be0b54`: the code half holds — `nostr-note-card.tsx:752` is
    the only `sendZap(` call, and `check:zapreceipt` (which scans for a `zap:`
    passed to `sendBoost`) passes. Helipad already showed the full boostagram on
    keysend and on Spark (LNURL + descriptor) from #444's preview build on
    2026-09-25. **Open: NWC.**
- [x] **2. A stale app copy after a deploy** — #421's `app/sw.js` serves
  `/_next/static/*` cache-first with `skipWaiting` + `clients.claim`, and
  `components/sw-register.tsx` has no update check or reload. An installed app
  resumed from memory can run the previous deploy until it reloads.
  - 2026-10-04, code read: not a regression. The worker is network-first for a
    navigation and falls back to the cached `/` shell only when the network
    throws; `/_next/static/*` is content-hashed, so cache-first cannot serve a
    wrong file. An app resumed from memory runs the old JavaScript until it
    reloads, which is true with no worker too. An update prompt would be a new
    feature, not a fix.
- [x] **3. The note's ⚡ figure is a zap receipt by design** — #408 `9673b57`
  (`lib/nostr/zap-summary-receipt.ts`). It moves no sats, but Fountain and
  Primal draw it as a zap; only Helipad proves the rail.
  - Settled: Fountain renders the ⚡ figure from the site-signed summary
    receipt, and on 2026-09-23 the user chose to keep the card's intended amount
    beside the receipt's settled amount.
- [ ] **4. An LNURL leg paid with no comment** — #404 `eb72903`: when a service
  refuses the comment and the descriptor alone does not fit, `lib/v4v/lnaddr.ts`
  retries with no comment, so the leg carries no `rss::payment` descriptor.
  `check:lnurl`; read the `[lnurl]` console lines of a boost that showed as a bare invoice.
  - 2026-10-04: `check:lnurl` PASS. #453 (`931a9f7`, after the window) changed
    the retry rule to "retry only the legs that provably sent nothing"
    (`retryableLegs`, pinned by `check:lnurl`). **Open: the console lines of a
    real boost.**
- [ ] **5. The keysend lookup lost Next's data cache** — #443 `ea543ee`:
  `safeFetch` forces `cache: 'no-store'`, and `app/api/keysend/route.ts` lost
  `revalidate: 3600` (the CDN `s-maxage` stays). A `.well-known/keysend` slower
  than 3.5 s is recorded as "no keysend" for 15 min, so a keysend-capable address
  pays over LNURL. Read the `[keysend]` console lines on a boost to an Alby address.
  - 2026-10-04, code read: the finding stands, but narrower. A 200 is cached by
    the CDN for 6 h (`s-maxage=21600`) and by the browser for 1 h, so only a cold
    CDN entry reaches the provider. A slow provider on that cold read still
    times out at 3.5 s (route) / 4.5 s (`LOOKUP_TIMEOUT_MS`), and
    `lib/v4v/keysend-lookup.ts` caches the miss for `MISS_TTL_MS` = 15 min in
    the tab. **Open: the `[keysend]` console lines of a real boost.**
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
    empty is not proven. The 2026-10-08 recording (follow-ups) shows the raw
    payloads; the 2026-10-02 run caught no show.
- [x] **8. #443 is 18 commits under a NIP-46 title** — money commits inside: a
  non-finite split weight pays 0, `splitSats` string coercion, streaming reads a
  non-2xx `/api/value-splits` as "could not ask", the playlist fan-out uses
  `mapLimit`, recipient names are entity-decoded, failed legs are explained, and
  `/api/audio` caps the URL at 4096 characters. `check:vts`, `check:musicl`,
  `check:nwcbudget`, `check:downloads`.
  - 2026-10-04 on `6be0b54`: the four checks PASS, and each named change is still
    in the code — `splitSats` keeps `Number(r.split)` and refuses a non-finite
    weight (`lib/util.ts`); `streaming.ts` throws on a non-2xx, non-404
    `/api/value-splits`; `mapLimit` bounds `lib/playlist-collection.ts` and
    `lib/musicl-resolver.ts`; `decodeXmlEntities` is in `lib/feed-xml.ts`;
    `app/api/audio/route.ts` refuses a URL over 4096 characters; `safeFetch`
    still forces `cache: 'no-store'` (item 5).
- [ ] **9. Which value block an episode pays** — #434 `0869ff7` (the feed's block
  outranks Podcast Index's stale copy), #440 `0ce1f4a` (keep PI's when the feed
  has none). `check:musicl`; boost an episode where the two disagree.
  - 2026-10-04: `check:musicl` PASS. **Open: a real boost.**
- [ ] **10. A downloaded episode pays the song** — #421 (`downloadEpisodeId`).
  `check:downloads`; boost inside a VTS window while a downloaded copy plays.
  - 2026-10-04: `check:downloads` PASS. **Open: a real boost.**
- [ ] **11. Bounded payee caches; `lnurlFetch` is https-only** — #420 `a877598`.
  `check:keysend`, `check:cache`; a boost that mixes keysend and LNURL legs.
  - 2026-10-04: `check:keysend` and `check:cache` PASS. **Open: a real boost.**
- [ ] **12. `value_msat_total` per leg group** — #403 `c6aa51d`. `check:vts`; Boost-all on an album.
  - 2026-10-04: `check:vts` PASS. **Open: a real Boost-all.**
- [ ] **13. The boost note names the track it paid** — #433 `03008d1`. The 🎵 line
  appears only when a track leg paid.

### B. Player, queue, live, UI

- [x] **14. The queued-notes refetch loop** — #422, fixed by #450.
- [ ] **15. Wallet reachability** — #422 removed the dock's Wallet tab and the
  fullscreen wallet chips. On `/live/<npub>` and `/stream/<naddr>`, with BOOST
  disabled, no wallet control is on screen. The fullscreen bar also mounts a
  third `useWalletBalance` reader (`fullscreen-player.tsx`), against the note in
  `auth-control.tsx` that keeps it to two.
  - 2026-10-04 on `6be0b54`: both halves stand. `setWalletOpen(true)` is called
    only from `auth-control.tsx` (header form) and the boost modal; the
    fullscreen bar shows `<WalletBalanceBox>`, a readout and not a control, and
    `<AuthControl overlay>` renders nothing once signed in. The box is gated on
    `open` rather than `everOpened` (since #422; #461 only restyled it), so the
    third reader exists only while the player is open — which is exactly when a boost from the player runs, the
    case `auth-control.tsx` describes. (The refresh is debounced 1.2 s.) Not
    fixed here; a fix gets its own branch.
- [ ] **16. Downloads re-land and the now-playing redesign** — #421 `b2ed006`:
  seven actions behind ⋯, the episode row below `lg` is BOOST + ⋯, lazy panes,
  resume fixes, the `/api/audio` fallback. `e2e:downloads` against `npm start`.
  - 2026-10-04 on `6be0b54` (`npm run build && npm start`): **RED, 8 fails, cause
    not found.** Sections 1–12 and 15 pass. Section 13 (a pane that cannot load):
    "a lazy pane chunk really did fail to load" is `false`, so the mini-bar,
    fullscreen and "the dead pane says so" checks fail after it; the `<audio>`
    kept playing and its position advanced. Section 14: the `↺ Resume` control
    is not offered, so its three follow-on checks fail; "the offer clears once
    taken" and "playback is not interrupted" pass. The script was last edited in
    #461; #485 and #486 changed the player after it. Not yet known whether the
    test or the app is wrong.
- [x] **17. Listen queue** — #422 `909beae`: ⏭/⏮ follow the queue, Up Next left
  the now-playing screen. `e2e:queue`.
  - 2026-10-04: `e2e:queue` → `QUEUE E2E OK` on `6be0b54` (section 8, the
    one-feed-read check for #450, included).
- [x] **18. New episodes from favorites** — #424 `718dafd`; the favorites header
  dropped its PLAYLISTS link. `check:favnew`.
  - 2026-10-04: `check:favnew` PASS on `6be0b54` (after #472 changed a show's
    first check to show its latest episode).
- [ ] **19. Resume position and seek-bar chapter hover** — #414 `3bf49c0`, #415 `4dcccca`.
  - 2026-10-04 on `6be0b54`, both **RED, cause not found**:
    - `e2e:resume`, 6 fails. Section 2: the episode page's button reads
      `▶ RESUME`, not `▶ RESUME 5:0x`, while the element did resume at ~5:00.
      `episode-detail-view.tsx:328` drops the time when the episode is the
      player's current one, and #486 now reopens that episode after a reload —
      so this one looks like a stale expectation, not proven. Section 3: the
      outgoing episode was stored at `t: 600.0`, not ~605, when another episode
      replaced it — the last periodic write, as if the flush on replace did not
      run. Section 4 (resume in-session) then fails 4 checks: no button found,
      zero `bmb:resume` writes during the switch, and the element at 636.9 s
      instead of ~605. Sections 1 and 5–8 pass.
    - `e2e:seekhover` stops in section 1: the mini-bar seek input is not found
      (`null`), then `TypeError: Cannot read properties of null (reading
      'ticks')` at `scripts/e2e-seekhover.mjs:99`. The script was last edited in
      #416 (2026-09-18), before #461 restyled the player.
  - Next step: run the three red suites on `59a315b` (#461, which updated two of
    them) and bisect to #485 / #486, before any fix.
- [x] **20. A Podcast Index `0` is no timestamp** — #426 `da21c39`. `check:liveover`, `check:livemerge`.
  - 2026-10-04: both PASS on `6be0b54`.
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

### E. Merged after the window that touch an item (`b810663..6be0b54`)

Read these with the item before a device test, so a changed behavior is not
reported as a regression.

| PR | Commit | Touches | Change |
|---|---|---|---|
| #452 | `ac24df2` | 22 | Warn before the tap when the NWC wallet relay is unreachable |
| #453 | `931a9f7` | 4, 11 | A retry pays only the legs that provably sent nothing |
| #454 | `b211504` | 16 | Downloads always retry through `/api/audio`; the HEAD probe only words the failure |
| #456 | `824f30d` | 16 | The download button fills once an episode is saved |
| #461 | `59a315b` | 15, 16, 21 | "Next UI" restyle of the player bar, tiles and controls |
| #472 | `1685d47` | 18 | A show's first new-episodes check shows its latest episode |
| #485 | `0cc2163` | 19 | AUDIO → VIDEO mid-episode keeps the place |
| #486 | `68e8003` | 17, 19 | A reload reopens the episode that was playing, not the queue's head |
