# UI — players, chapters, transcripts, lists, routing, theme

Read before touching `components/player.tsx`, `fullscreen-player.tsx`, `lists.tsx`, `chapter*`, `transcript*`, `home-page.tsx`, `episode-detail-view.tsx`, `auth-control.tsx`, or the theme/PWA files.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

## PWA install

`public/manifest.json` + `public/sw.js` + `<ServiceWorkerRegister>` (`components/sw-register.tsx`, mounted in `app/layout.tsx`). Display mode `standalone`; icons in `public/icons/` + `public/icon.svg`; iPhone splashes in `public/splash/`. Header has `pt-[env(safe-area-inset-top)]` so the bolt + title clear the notch.

**The SW has no precaching.** Next.js emits hashed bundle URLs that change every build, so a stale cache would silently break installed users. The empty `fetch` handler exists only so Chrome/Edge surface the install prompt.

**`statusBarStyle: 'black-translucent'` makes iOS draw the status bar in WHITE, always — and `theme-color` cannot change that.** It is what puts the app edge-to-edge under the notch, and it is fine while the page behind the glyphs is `#0a0a08`. It is not fine in light mode, where `--ink` flips to `253 250 243` and the clock, battery and signal go near-invisible in the installed app. The repair is a real surface rather than a colour hint: a zero-height-off-iOS strip at the very top of `<body>` (`app/layout.tsx`), sized to `env(safe-area-inset-top)` and painted `#0a0a08` in BOTH themes. Three properties are load-bearing — the colour is hard-coded rather than `bg-ink` so one code path covers both themes; it collapses to 0px wherever there is no inset, so it costs nothing off-iOS and needs no display-mode detection; and it is **`z-[70]`, above `<ModalShell>`'s `z-[60]` and `<FullscreenPlayer>`'s `z-50`**, because both of those paint `bg-ink` and go cream in light mode too. A strip underneath them would be covered exactly when a modal is open. **Anything new that outranks `z-[70]` re-opens this bug.**

**`viewport.themeColor` is ONE value and must stay one — do not split it into `prefers-color-scheme` variants.** This app's theme is a manual `bmb:theme` localStorage toggle read by the FOUC-blocker, not the OS preference, so a media-keyed colour is wrong for every user whose OS and app themes disagree — a light OS with the app left dark is the common case — and it is wrong in the direction that matters, painting browser chrome one colour while the page under it is the other.

**A modal overlay needs the safe-area inset too, and `<ModalShell>` did not have it.** `viewportFit: 'cover'` means the overlay box starts at the PHYSICAL top of the screen, so `p-4` alone put a card that reaches `max-h-full` under the notch / Dynamic Island — its header, i.e. the part naming what the modal is about, and the boost modal is the money surface. The block axis is now `max(1rem, env(safe-area-inset-*))`: `max()` rather than a sum, because 1rem is already enough where there is no inset and adding would push the card a further notch's worth down on the phones that have one. Verified as a no-op at 0 inset (16px) and correct at a 59px one.

**iOS matches a launch image on device size and DPR EXACTLY, and shows WHITE when nothing matches** — on an app whose every surface is near-black. So each new iPhone geometry is a new file, and the list silently stopped at the iPhone 15 while the 16, 17 and Air shipped. The PNGs are generated now, not drawn: **`node scripts/make-splash.mjs`**, whose `DEVICES` table is the source for `appleWebApp.startupImage`. Its geometry is *derived from the committed art* — measuring the yellow bounding box across the seven originals gives 0.1473–0.1488 of canvas width, centred — and **`--check` re-derives that from disk**, so a hand-edited or stale PNG fails rather than quietly shipping a mispositioned logo. A generator that cannot reproduce the art already shipped is not trustworthy enough to produce the art that has not; that reproduction is how the one `BOLT_WIDTH_RATIO` constant was pinned, and the regenerated originals differed from the committed ones by 0.03–0.06% of subpixels, all of it the bolt's antialiased edge. Entries are shared wherever a geometry is (the iPhone 16 is 393x852, the same as the 14 Pro), so only three sizes were genuinely new.

**The manifest carries `screenshots`, and the three PNGs for them were already on disk.** They are shot by `scripts/shoot-screenshots.mjs` for the Zapstore listing; naming them in `public/manifest.json` with `form_factor: "narrow"` is what gets Chrome's richer install dialogue for free. **`name`, `scope`, `start_url`, `orientation` and `icons` are read by Bubblewrap for the Android build and must not move** — `short_name` is not among them, which is why it could be shortened to fit an iOS home-screen label (`android/twa-manifest.json` carries its own committed `name` / `launcherName`).

**Document-level `overscroll-behavior-y: none` on `html, body`.** In an installed PWA the overscroll gesture is pull-to-refresh, which reloads the whole app — and this app is a player, so a reload mid-episode drops playback, the position and the queue, with no confirmation. This is the document-level half of a rule the overlays already keep at their own scroll boundaries (`overscroll-contain` in `modal-shell.tsx`, `fullscreen-player.tsx`, `live-chat.tsx`); those stop a gesture reaching the document, this covers the page itself, which they never see. The horizontal rails (`podroll.tsx`, `nostr-live-streams.tsx`) and the two tab-pill rows carry `overscroll-x-contain` for the same reason plus one of their own: a swipe past the end otherwise becomes Safari's back-swipe. It does not create a scroll container and does not affect `position: sticky`, so it is safe beside `overflow-x: clip`.

**Do NOT add `-webkit-tap-highlight-color` or `-webkit-text-size-adjust` to `globals.css`** — Tailwind's preflight already sets both on `html`, and a second copy is a no-op that reads as protection.


## Auth: two independent logins (`<AuthControl>`)

**Lightning and Nostr are two separate logins.** A user can connect a wallet and boost with **no Nostr identity** — the payment rails, boost orchestrator and `:guest` storage never touch `identity`. `components/auth-control.tsx` fronts both: one **"Sign in ▾"** dropdown when neither is connected (⚡ Connect wallet / ◆ Sign in with Nostr), the wallet balance chip inline once a wallet connects, and a direct button for whichever login remains; once both are set it delegates the Nostr side to `<NostrAuth>`'s `<AccountMenu>`. Both modals' open-state lives in the store (`walletOpen`/`signInOpen`); `<AuthControl>` owns the `<WalletModal>` render, `<NostrAuth>` owns `<SignInModal>`. The account menu is **Nostr-only**.

**Mount-gate for wallet state:** `walletConnected = mounted && hasAnyWallet()`. `hasAnyWallet()` reads localStorage, which the server can't see, so gating it behind a mount effect keeps the first client render matching SSR; without it React discards and regenerates the whole header subtree.

**`walletRestoring` (store) makes the header say "connecting…" instead of offering "Connect wallet" for a wallet the user already has.** `hasAnyWallet()` reads false for the whole Spark SDK-import + handshake window on a cold load. Set from `doLoadProfile` and **gated on positive evidence, never speculatively**: `shouldRestoreSpark` alone is true for anyone without a connected Spark wallet, *including people who never had one*, who would then sit on a false "connecting…" and be told to connect anyway. It fires only when the signer is `'local'` (a Google account always derives a wallet) or a cached balance says this npub had one last session. **Three paths must clear it** or the label sticks forever: the `storage.npub.get() !== id.npub` early return (upstream of the `.finally()` that normally clears it), `abandonRestoredSession()`, and `signout()`. The button still opens the wallet modal on tap — a status label, not a lock.

The balance chip renders **no ⚡ of its own**; `<AuthControl>` draws one in the button and that one has to stay, because `<WalletBalanceChip>` returns null whenever the balance is unknown (WebLN exposes none, every rail is null mid-reconnect) and the lone bolt is what still reads as "connected".


## The favorites page (`/favorites`)

Favorites used to be a `max-h-[70vh]` `card` aside inside `<HomePage>`'s browse mode, collapsed by default, twelve rows per medium bucket. That is survivable at a dozen favorites and not at the ~227 a real library holds, and it gave the app's most consequential local state — the maps that decide what gets published to the shared kind:10333 event — the smallest box on the page. It is now `app/favorites/page.tsx` + `components/favorites-page.tsx`, and the home section is **gone**, not duplicated.

**A real route, not another store-driven view swap.** Same reason `/npub/<npub>` is one: those swaps have no URL to give anyone, and this is a page people bookmark. `<Player>` is mounted in `app/layout.tsx`, so navigating here mid-episode does not interrupt playback.

**Medium is a TAB STRIP, and the strip is `groupByMedium`'s own output.** Not a hand-written list of media — running the real grouper and rendering its buckets as tabs is what keeps `MEDIUM_ORDER`'s ordering, the feed-supplied label that is never normalized beyond lowercasing, and, the one that matters, **`~unknown` as its own bucket**. An entry whose medium nobody has declared is not a podcast, and folding it into one makes it findable only by accident. Tabs *replace* the stacked medium headings rather than nesting inside them: a "Music" tab above a "Music —" heading is the same word twice, which is the two-lists-for-one-thing mistake the tracks-vs-chapters section below records.

**On the mixed tab a chip names a MEDIUM and a half at once, so pressing one moves the tab too.** Under a medium tab there are two chips and each sets the half alone (`EVERYTHING · ALBUMS · TRACKS`). Under `ALL` a single word per half can only be a compound, which is the thing being fixed — so the row offers one chip per (medium, half) pair instead: `EVERYTHING · ALBUMS · SHOWS · TRACKS · EPISODES`, and `SHOWS` sets `{tab: 'podcast', split: 'feeds'}` in one update. **The two rows describe one filter and must never disagree about it**, which is also why `split` is DERIVED (`tab === 'all' ? 'all' : view.split`) rather than read straight from storage: reading the stored value on the mixed tab renders five chips with none active over a list silently filtered to half of it, reachable by picking MUSIC + ALBUMS and then pressing ALL. **A tab press also clears the half back to `EVERYTHING`**, because the tab row names the wider of the two axes: pressing `MUSIC` reads as "show me this medium", not "show me this medium, still narrowed to whatever half I was in three clicks ago". Carrying the half over is defensible and was worse in practice — press `SHOWS`, then press `MUSIC`, and you land on albums with no tracks and nothing on screen saying a second filter is still on. The derivation stays anyway: a stored tab can stop existing under the user when the last album of a medium is unfavorited, and that path falls through to `ALL` with no click to reset the half.

The chip list is built from `tabs`, so only media the user actually has appear — no hand-written list of media, same rule as the tab strip. **A pair with no rows gets no chip**, which is why `tabs` carries `feedCount`/`itemCount` and not just a total: `~unknown` routinely holds items and no feeds, and a chip filtering to an empty section is worse than an absent one. Feed chips come before item chips rather than interleaving by medium. **`crossSplitLabel` gives the bare noun only to `music` and `podcast`** — `feedNoun` collapses every other medium to `show` and `itemNoun` to `episode`, which is right for a lone label under a tab that already names the medium and is a *collision* here, where an audiobook and a podcast would render two identical `SHOWS` buttons filtering to different lists. Everything else is qualified by its own bucket label and takes the neutral half-word, and `medium unknown feeds` is deliberately not `medium unknown shows`. The section headings keep the compound under `ALL`, where it is accurate: that section really does hold both.

**The split chips name the tab's own nouns, and the section headings under them use the same two words.** They shipped as a fixed "albums & shows" / "tracks & episodes", which crams two concepts into one box on a library that is overwhelmingly one medium — 258 music of 277 on the reference list, where every chip said "& shows" about seventeen podcasts sitting on a different tab. `splitLabels(tab)` (`components/lists/grouping.tsx`) returns one noun per half whenever the tab names a medium (MUSIC → albums / tracks, PODCAST → shows / episodes) and keeps the compound for the two keys that name none. **`all` and `~unknown` keeping the compound is the point, not a fallback left unfinished**: `all` really is mixed, and `~unknown` is the bucket for entries nobody declared a medium for, so `shows`/`episodes` there would assert exactly what `groupByMedium` keeps that bucket separate to refuse. It is one call returning both words because the chip and the heading are one row apart — a chip reading ALBUMS above a heading reading "albums & shows" reintroduces the confusion one level down. Note it is deliberately NOT `feedNoun`/`itemNoun`: those label a "show N more …" control that already has a heading above it saying which half it belongs to, so they collapse to the generic `favorites` on a mediumless key, while these two chips sit side by side and are the only thing telling the halves apart.

**The filter may hide a row; a guard may not.** Every entry renders with an empty query, resolved or not — the store maps are what gets published, so a row hidden because Podcast Index did not answer makes an outage look like a user removal. Filtering is the user's own action and is therefore allowed to hide things, which is exactly why the two cases must never share a code path. The haystack includes the **guid**: an `<UnresolvedFavoriteRow>` has no title and prints its identifier, so it is the row someone is most likely hunting for, and matching on titles alone would make every placeholder vanish the moment anyone typed. A filter that matches nothing says so in its own words, with the true total still on screen — saying "nothing saved" there would be the same lie a degraded read makes.

**Every control on this page clears 24×24, and one did not.** `<CollapsibleHeading>` was `text-[11px]` with no vertical padding — a 16.5px-tall target, under WCAG 2.5.8. It was survivable as a group heading among many rows inside the old aside; here it is one of two primary controls and the fold is the only way to skip a section outright, so it gained `py-1.5` (16.5 + 12 = 28.5). Measured in real Chrome under CDP `Emulation.setDeviceMetricsOverride` with `mobile: true`, seeded with 51 albums and 226 tracks: zero horizontal overflow at 390, 320 and 1280; the header exactly 71px at all three; the wordmark whole at 390 with **142 of 142px**, i.e. no margin at all, which is why anything added to that cluster has to buy its width back; and after the fix, zero targets under 24px. `--window-size` does not do this — it lays the page out at desktop width and crops the screenshot, which yields a confident wrong answer.

**The scrub bar was the worst target in the app, and it did not look like it.** `input[type='range'].seek` is `appearance: none` with a 2px track and a 12px thumb hanging outside the box on a negative margin — so, measured in Chromium against the shipping rules, the **element was 2px tall**. Tap-to-seek anywhere along the track had a 2px target on a control that is a primary action in a podcast player, and reading the CSS suggests 12px, not 2. It now takes `height: 32px` inside the existing `@media (hover: none) and (pointer: coarse)` block, with the thumb at 16px and `margin-top` re-derived rather than nudged — `(track − thumb) / 2 = (2 − 16) / 2 = −7px`. **32 and not 44 because the element's height IS the row's height**, and that row is in the mini-bar, the most contested vertical space in the app: 44 would add 33px to a ~72px bar, 32 adds ~21px and still clears the 24px floor with margin. Giving it a real height is also the only fix that steals nothing — a negative margin would reclaim the strip holding the transport row and the chapter label, the trade `streaming-settings.tsx` already refuses.

**A `role="button"` needs `tabIndex` and a key handler to be one.** The mini-player bar (`components/player.tsx`) announced itself as a button to a screen reader, was never reachable by Tab, and did nothing when activated. A native `<button>` is not available there: the element wraps the transport controls, the seek input and BOOST, and a button may not contain them. Space is `preventDefault`ed or the browser scrolls the page on keydown.

**A link set inside a sentence is exempt from 24×24; a standalone one is not, and the footer's is on every route.** The `/privacy` link in `app/layout.tsx` was a 98×14 inline `<a>` — and an inline element ignores vertical padding for layout, so `inline-block` is what makes the box real, not the `py-1.5` alone. After that, `/` and `/favorites` measure **zero targets under 24px**; the two that remain on `/privacy` are URLs inside prose, which the exemption covers.

**The 16px input floor for iOS focus-zoom is in [`../docs/streaming.md`](streaming.md), not here** — it was learned on the streaming rate field, and it binds every form control in the app. iOS Safari zooms the viewport whenever an input under 16px takes focus and does not zoom back out on blur; the app sets no `maximumScale` on purpose, because that kills pinch-zoom for everyone. If you are adding a form field, that is the rule you need.

**An `<UnresolvedFavoriteRow>` carries a heart, and shipping it without one made the row's own justification false.** The argument for rendering an entry Podcast Index cannot resolve — rather than hiding it, which would make an outage look like a user removal — has always ended "and a row they can see is one they can clean up". With no control on the row that sentence is not true: the entry cannot be removed from any screen in the app, and it rides through every republish to a list other apps read. `bmbCleanFavorites()` does not reach it either, because that purges malformed `podcast:guid:` nodes and these are well-formed identifiers for something PI has simply never indexed — a real state, reached on the reference library by two tracks whose parent feed guid 404s against both `/podcasts/byguid` and `/episodes/byguid`. Those two are also why the `MEDIUM UNKNOWN` tab exists at all: an item's medium is its parent feed's, and an unresolvable parent supplies none.

Both hearts are the **row-shaped** variants — `<FavEpisodeRowHeart>` and `<FavFeedRowHeart>` (`components/fav-heart.tsx`) — which take the STORED entry and re-add it verbatim rather than rebuilding it from a `Podcast` / `Episode`. On a resolved row that is a nicety; here it is the point. An unresolved entry's `medium` hint is a field `Podcast` has no home for and `declaredMedium` cannot recover, and for a feed PI has never indexed it is the only description of that feed that will ever exist — so a round trip through `<FavHeart>` would let an unfavorite-then-refavorite silently downgrade the entry to a bare guid. Neither restamps `addedAt`, so a misfired toggle leaves the row where it was instead of bubbling it to the top of a recent-sorted list.

**`useRevealed(rows, resetKey)` — and the bug the reset key fixes runs the OPPOSITE way to the obvious one.** Narrowing was always safe: `slice(0, 12)` over three matches shows three. The expensive direction is widening. Reveal sixty rows, type a query, clear it, and `shown` is still sixty, so sixty `<PodcastCover>`s mount in one commit against arbitrary third-party artwork — the 55.6 MB / 84-request page load `FAV_PAGE` exists to prevent, arrived at through the control that was supposed to make the list *smaller*. The reset happens **in the render phase**, not an effect: an effect renders the sixty rows once and trims afterwards, by which point the browser has already issued sixty image requests, so it would fix the appearance and none of the bytes. Sort belongs in the key even though it changes no count — after a re-sort, "revealed sixty" names a different sixty.

**`useAutoReveal` changes the TRIGGER, never the page size.** The next twelve reveal themselves when the "show more" control scrolls into view, so nobody has to press it — but they are still twelve, and still only once the reader has arrived at the end of what is on screen. That is the whole reason it is safe: the bytes are spent in the same units on the same demand. Reading "they wanted infinite scroll" as licence to raise `FAV_PAGE` or drop the cap re-creates the 55.6 MB page load, and this time with no control to not press.

Three things it has to get right. **The observer is rebuilt whenever `remaining` changes**, which looks like a missing dependency array and is the fix for a real stall: an `IntersectionObserver` fires on threshold CROSSINGS only, so a reveal that leaves the sentinel still on screen — a tall viewport, twelve short unresolved rows — gets no further callback and the list stops with rows left and nothing happening. A fresh observer delivers an initial callback for the current state, so it chains until the sentinel is pushed past the margin. It terminates because each pass adds twelve rows and because the hook does nothing once `remaining` is 0. **`<ShowMore>` IS the sentinel**, rather than an invisible `<div>` beside it: that is what makes the degradation honest, since with no `IntersectionObserver` the button is still a button, and there is no second element to keep in sync. **A folded section passes `remaining: 0`** — a hook may not be conditional, and auto-revealing behind a closed heading would spend the entire artwork budget on rows nobody can see.

`rootMargin` is deliberately modest (200px). A generous one prefetches well ahead of the reader, which is the cost being bounded — and on the mixed view the feeds section sits ABOVE the items section, so scrolling *past* the albums to reach the tracks silently pays for every album on the way. Folding a section, or the split chips, is still how you skip one outright.

**Opening a favorite sets the store, THEN navigates to `/`.** The show and episode views are `<HomePage>` state, so this is a handoff rather than a navigation with a payload — and pushing `/?podcast=<guid>` instead is a real bug, not a style choice. `<HomePage>`'s restore effect early-returns on `if (useApp.getState().selectedPodcast) return;`, and the Zustand store is module-level and survives the route change: a user who had opened *any* show earlier in the session would have their param ignored, and the selection-to-URL mirror effect would then rewrite the address bar back to the old show. They land on the wrong show with nothing on screen saying so. Setting the store first is also what keeps this working during a PI outage, where a URL handoff would route back through `resolvePodcastByGuid` and land on a blank page.

**A show opened from another route needs a way BACK to that route, and the back control has to be told.** `<HomePage>`'s was unconditional — "← back to results", clearing the selection in place — which was true while every way into a show was on `/`. It stopped being true the moment a second route could open one: from `/favorites` (and from `/npub/<npub>`, which had it first) the control named a results list the visitor had never seen and offered no way back to the page they came from. A dead end reads as a broken button. `showOrigin` (`lib/store.ts`) carries `{ path, label }` and renders a real `<Link>` instead. **`selectPodcast` CLEARS it**, which is what makes the default safe: an ordinary selection — a search result, a podroll card, a deep link — resets the origin without knowing the field exists, and only the handoffs that genuinely came from elsewhere set it back, immediately after that call. Set-everywhere-clear-at-the-exits is the shape that leaves one exit forgotten and sends someone to a page they were never on. `label` rides along rather than being derived, because `/npub/<npub>` cannot be turned into "boosts" by inspection. The link deliberately does not clear the selection: the store is what makes stepping back into the show cheap, and the wordmark already clears it on that route.

**And the same page must CLEAR the selection on every plain `<Link href="/">` it offers** — `clearShowSelection()` (`lib/store.ts`). The two are one rule, because the handoff works *because* the store outlives the route change and `<HomePage>` never clears it on mount. So the moment a page owns both a handoff and a home link, the link stops going home: open an album from `/favorites`, come back, press the wordmark, and `<HomePage>` re-opens that album while the selection-to-URL mirror writes `?podcast=<old>` behind it. Nothing on screen says why, and the control is labelled "Go to home". `goHome()` clears it in place on `/`, which is why the wordmark is a button there and a link everywhere else; everywhere else has to clear it on the link. It reached `<AppHeader>`'s wordmark, `<EmptyLibrary>`'s "back to search", and both of `/npub`'s home links — the last of which had it from the day that route shipped.

The item path keeps the whole chain from the old panel, comments included: the show goes up **first and unconditionally** (it is what the user sees while the feed loads, it is where they land if the episode can't be found, `selectPodcast` clears `selectedEpisode`, and `<EpisodeList>` mounting on `/` is the only writer of `episodeQueue` that `<TransportControls>` reads), then `loadEpisodeFromFeed`, then a re-check that the selection still matches before `openEpisode`. That guard compares ids, not mount identity, so it holds across the navigation.

**Three empty states, and conflating any two of them reproduces a bug already paid for.** Pre-mount says "loading" and never "no favorites" — `lib/store.ts` hydrates the maps at module scope, so the server sees `{}` and an empty claim there is a lie for every returning user, plus the React 19 hydration mismatch that made `<HomePage>` carry a `mounted` gate. Genuinely empty says nothing is saved yet, and adds "stored on this device" when signed out rather than implying anything was lost. Degraded renders `<FavoritesSyncNotice>` **above the controls** — outside any section, so neither a filter nor a fold can hide the reason the list is short.

Putting the notice there is necessary and is **not** sufficient, which is the part that shipped wrong. `total === 0` is reached two ways and only one of them is an empty library; the other is a degraded read on a device with no cache — a new browser, a private tab, a second device — and `<EmptyLibrary>` printed "Nothing saved yet." in the largest type on the page for both. Two elements on one screen made opposite claims and the louder one was false. That is the silent-guard failure this repo already paid for, one step further along: it no longer withholds silently, it withholds while asserting the opposite. So `<EmptyLibrary>` takes `degraded` and swaps the headline to "Nothing on this device.", the body says the relay read failed and points at the retry, and the word *saved* never appears. The signed-out half is untouched — with no key there is no read to degrade.

**`<FavoritesSyncNotice>` stayed on `/` too.** Its old slot was inside the panel that was deleted, and losing it would have been a silent-withholding regression rather than a cosmetic one: hearts render all over the home page (search results, the podroll, the episode detail view, the layout-mounted fullscreen player), so a user toggling one during a degraded read is being withheld from right there. It now sits unconditionally under `<SearchBar>` and self-hides unless signed in *and* degraded.

**An empty library is a CLAIM, and the page may only make it once it knows.** `<FavoritesPage>` had three render states — pre-mount, `total === 0`, rows — and none of them was "the relay read has not answered yet". A signed-in user whose read was still in flight therefore fell straight through to `<EmptyLibrary>` and was told **"Nothing saved yet."** in the largest type on the page, over a full library the app simply had not read.

That is the failure `<EmptyLibrary>`'s own doc comment describes for a degraded read, one state earlier: it does not withhold silently, it withholds while asserting the opposite. `degraded` was handled; `'loading'` and `'idle'` were not, even though `runHydrate` sets `'loading'` on its first line. Reported from a phone — the header's ♥ showed an empty library on the first press and the real list on the second, because the read landed in between. **It self-corrects, which is what makes it worse**: nobody presses a second time after being told there is nothing there.

Both unsettled states count. `'idle'` is not merely theoretical: hydration no longer starts on the same tick as the mount, because it waits for the account's NIP-65 write set when this device has none cached (see [`nostr.md`](nostr.md)). Signed out is excluded — favorites are local with no key to sync them under, so nothing is in flight and an empty list is known immediately and honestly. A signed-in user with a genuinely empty list still reaches `<EmptyLibrary>`, once the status settles on `'ok'`.

## The search box and its content-type selector (`components/search-bar.tsx`)

`<SearchTypeMenu>` — one button naming the current mode, and a menu of `ALL · ♫ MUSIC · PODCASTS · PLAYLISTS · ⚡ NPUB` with a ✓ on the active one. It sits **above** the input. Below is where the npub suggestion and the `nsec` warning live, hanging off the box with no gap and no top border so the three read as one control, so nothing may be added down there; and inside the box the `×` already owns the right edge of a field that is 288px wide at 320px, so nothing may be added there either. Above costs one line and touches neither.

**It shipped as a row of five chips and that was wrong at 320px** — the row wrapped to two lines, leaving the filter standing taller than the search box it filters. A menu states the mode in one word and costs one line at every width. It is also the shape podcastindex.org uses for the same choice, which is worth something by itself: these users are already on that site, and a control they recognise needs no explaining. Built on `<AccountMenu>`'s idiom — `relative` wrapper, `absolute top-full`, `aria-haspopup`/`aria-expanded`, and **both** dismissals, since Escape alone strands it open under a thumb and click-outside alone strands it open for a keyboard. Items are `role="menuitemradio"` with `aria-checked`, not `menuitem`: one choice out of a fixed set, which is what makes the ✓ mean something rather than being decoration. The ✓ has a fixed-width gutter so labels do not shift row to row.

The lane each option runs, and why the selector is a server concern rather than a filter over the rows already fetched, is in [`feeds.md`](feeds.md). What lives here is the four UI rules, each of which is a way to build a control that looks live and lies.

**A pasted npub is looked up under NPUB and NOWHERE ELSE.** The box used to act on one whichever mode it was in, because an npub is unmistakable and it could tell what the user meant without being told. That was right while there was nothing to tell it with; a mode selector is exactly that, and inferring over the top of an explicit choice is worse than not inferring at all — pick PODCASTS, paste a key, and you get a person lookup you did not ask a podcast search for. `parsedNpub` is the parse, `npubHit` is the NPUB-mode half that drives the suggestion row, the Enter navigation and the kind:0 fetch, and `strayNpub` is the other half, which is parsed and never acted on.

**The stray half still has to SAY something, or this trades one silent failure for another.** Under PODCASTS the search runs, no show is called `npub1vl029mg…`, and `no results yet — try another phrase` is the last word on a lookup the app does perfectly well. So a row offers the mode in one press — the same way out the results panel gives a narrowed empty result. It sits *beside* "no results" rather than instead of it, because the search genuinely did run: PODCASTS searching for what you typed is what PODCASTS says it does. Nothing in that row navigates or resolves a profile, which is what keeps it an offer rather than the inference the selector exists to replace.

**`ALL`'s placeholder no longer offers to take a key**, since it no longer acts on one, and the left icon's ⚡ follows the MODE rather than a parse. A box that invites a paste it will not act on is a worse control than one that never mentioned it. **The `nsec` refusal is untouched and stays unconditional in all five modes** — see [`security.md`](security.md); it is a prefix test, not a parse, and it is a different question from "which mode is this".

**The type is not persisted, and that is the opposite of what `/favorites` does.** The favorites page stores its tab in `bmb:favView` because that is a library you own and come back to. A search filter restored from disk is on before you touched it: you return a week later, search a show, get nothing, and the box reads as broken with the only explanation folded away inside a menu you never opened. Starting at `'all'` also means there is no `localStorage` read during render, which matters because this box **is** server-rendered at `/` — the same hazard the profile-cache seed in that file already documents. `goHome()` resets it along with everything else.

**The type is CONTROLLED from `<HomePage>`, and the menu is not its only writer.** When a narrowed search comes back empty the results panel offers a way back to ALL, and that control has to move the same state the box reads — held privately in the search bar it would move the results and leave the menu naming a lane that is no longer running. So `<HomePage>` owns `searchType`, and both entry points go through one `changeType`, which also calls `handleQueryChange`: **picking a type is an edit of what the query means, so it must leave a drilled-in show exactly as a keystroke does.** Without that, picking one from inside a show refetches and refills `feeds` behind a view whose ternary never reaches the branch that renders them — the show stays open, the menu updates, nothing else moves. That is the bug `onQueryChange` was added for, arriving through a second control.

**What is on screen is described by the lane that PRODUCED it, never by what the menu names.** They are the same thing only between round trips. `<SearchBar>` therefore reports `{ type, total }` **with** the results (`SearchInfo`), `<HomePage>` holds it as `searchInfo`, and both the count line and the empty state read from that rather than from `searchType` — otherwise "12 albums" sits over twelve podcasts for the length of one fetch. The type is read back out of the **response** for the same reason one step further out: the feed-URL branch ignores the selector entirely, so the menu is not the right answer even once the response has landed.

**A narrowed empty result must not claim Podcast Index is empty.** `no results yet — try another phrase` is a statement about the index and is false under a narrowed type: it may hold plenty for the query and none of it music. `<PodcastResults>` takes an `empty` node (defaulting to that same sentence, which is still right unfiltered and in the publisher view) and `<HomePage>` supplies the narrowed form — the lane named, the true cross-type count kept on screen, and a control back to ALL. It is `<FavoritesPage>`'s filter rule and `<EmptyLibrary>`'s `degraded` flag one surface over: withholding while asserting the opposite is worse than withholding. The count is printed only when it was actually learned — a fetch that threw reports `0` and prints nothing, because an invented number there is the same confident wrong answer.

**`showLeftRightLayout` gained `query`, and that fixed a pre-existing hole this feature would otherwise have inherited.** Its terms were `loading || feeds.length > 0 || …`, so the moment a request settled with no rows the whole aside stopped rendering — and the aside is what holds the count line and the empty state. A search matching nothing produced the hero, the live-streams row, and no acknowledgement of the search at all: the "no results yet" sentence flashed during the fetch and vanished at the exact moment it became true. The inner gate one level down had always included `query`; this one had not. A narrowed search is a far easier way to reach zero rows, so the sentence had to be reachable before it was worth writing.

**`<Chip>` is shared now** (`components/chip.tsx`), lifted out of `<FavoritesPage>` where it was module-private; the empty state's way back to ALL is one. Its `px-2.5 py-1 text-[11px]` puts it at 27px, and the menu's own trigger and rows clear the same WCAG 2.5.8 24×24 floor — measure under CDP rather than estimating, per the favorites-page note above.

## The app header (`components/app-header.tsx`)

One header, rendered by `/` and `/favorites`. It was inline JSX in `<HomePage>` while `/npub`, `/live` and `/stream` went bare — fine for those three, since two are player overlays and the third is something you read, but a favorites page is a place people stay and every affordance its empty state points at (sign in, connect a wallet) lives in this cluster. `<NostrAuth>` riding along is load-bearing rather than decorative: it owns identity hydration and is the only caller of `hydrateFavorites` outside the sync notice's retry, so a favorites page without it shows a signed-in visitor stale local state and never backfills it.

**The theme control is NOT in the header cluster — it lives in the menus.** It was there, as the one bare 32px icon in a row of 38px bordered chips, and it read as a control dropped in rather than placed: a rarely-touched preference sitting among the primary actions. `<ThemeMenuLink>` is the compact form in `<AccountMenu>`'s footer beside "sign out"; `<ThemeMenuRow>` is the full-width form in `<AuthControl>`'s signed-out dropdown, matching that menu's `w-4` centred glyph column (◆ / ◉ / ⚡ have different advance widths, so a row that skips it starts its label at a different x than the three above).

**It is in the SIGNED-OUT menu too, not only the account menu.** Search, playback and favorites all work signed out, so hosting a preference only where an identity exists takes it from every visitor who hasn't got one — the same reasoning that keeps `<FavoritesLink>` ungated. And **one state has neither menu**: a wallet connected with no Nostr identity, where `<AuthControl>` renders a direct "Sign in" button rather than the combined dropdown and `<AccountMenu>` does not exist at all. `<AuthControl>` renders the bare `<ThemeToggle>` itself for exactly that case, because it is the component that knows. Moving a control into a menu is an improvement only where the menu is always there.

Two things that bite anyone moving something else in this row. **The component names mislead about what they draw**: `<AuthControl>` is the WALLET half — the balance chip and the connect / sign-in buttons — while `<NostrAuth>` draws `<AccountMenu>` alongside owning identity hydration, so "after `<AuthControl>`" is the middle of the cluster, not the end. And **every form shares `useThemeMode`, which SUBSCRIBES** via `subscribeTheme` rather than only seeding from storage — that pub/sub had no caller until the control gained a second home. More than one form can be mounted at once, and without it the one that wasn't pressed keeps its old icon and offers "light mode" on a page that is already light. `toggle` deliberately does not `setMode`: `applyTheme` fans out to listeners and the hook is one of them, so there is one path in and no way for two instances to disagree.

**`--app-header-h` is a hard-coded 71px derived from this markup** — `py-4` (32) + the tallest control (38, a `.btn-ghost`) + a 1px border — and `<EpisodeList>`'s show header pins against it. That is the real argument for one component over a second hand-rolled header: two headers of different heights break a sticky offset on the *other* route, where nobody is looking. **Nothing added to this cluster may exceed 38px tall.**

The wordmark is a `<button>` on `/` (where "home" means clearing the search and the selection in place, which a `<Link>` would leave standing) and a `<Link>` everywhere else, over byte-identical inner markup.

**`[♥ FAVORITES]` is the way in, and it is never gated on `identity`** — favorites work signed out, local-only, which is also why the account menu is the wrong home for it (that menu is Nostr-only, so a signed-out user with forty saved albums would have no route at all). Its count sits behind the component's own `mounted` flag, containing the module-scope-hydration mismatch in one small component instead of letting it decide a page layout.

**Both the word and the count go below `sm:`, and that is measured, not taste.** The wordmark needs 142px and the header offered it 141.6 before this chip existed, so the chip's width had to come from somewhere — and `truncate` is all-or-nothing, so a sub-pixel shortfall eats three characters rather than a hair. The chip sheds its word and number, takes `px-2` instead of `.btn-compact`'s `px-2.5`, and the row's mobile gap drops from `gap-2` to `gap-1`; together that lands the wordmark back at 141.6 and "Boost Me Bitch" reads whole at 390px. Everything is unchanged from `sm:` up. The filled magenta heart still says *you have some* and the `aria-label` still says how many — the same trade `<FavHeart>`'s `sm` chip makes one row down.

## Episode list pagination + music-feed behaviors (`components/lists/episode-list.tsx`)

**`components/lists.tsx` is a BARREL — the implementations live in `components/lists/`.** It reached 1192 lines holding four exported components, fifteen private helpers and two hooks, and is now a re-export surface over `podcast-results.tsx`, `episode-list.tsx`, plus the rows in `favorites.tsx` and the shared scaffolding in `grouping.tsx` (medium bucketing, the nouns those buckets are labelled with, the collapse state headings persist, the progressive-reveal pager). The two favorites PANELS are gone with the home-page section; `favorites.tsx` keeps only what draws one row, and `components/favorites-page.tsx` imports those directly rather than through the barrel — widening the barrel into a general re-export surface is how it reached 1192 lines the first time.

Two things about the split are worth keeping:

- **The barrel is why the split cost zero call-site edits.** `home-page.tsx` is the only consumer of the four panels, and several surfaces import the fav hearts from here, so re-exporting kept every import path and made the diff a pure move. Re-growing the barrel into an implementation file is how it got to 1192 lines the first time.
- **The hearts still live in `components/fav-heart.tsx`** and are only re-exported. `podroll.tsx` importing them from `lists.tsx` while `lists.tsx` imports `<Podroll>` was the original module cycle; that constraint didn't go away, it just moved behind the barrel. The same shape reappeared during this work when `fullscreen-player.tsx` needed the show-share URL builder from `lists.tsx` — resolved by putting `showShareUrl` in `lib/util.ts` instead, not by adding the component-to-component import.

`/api/feed` returns ~50 episodes at once, so pagination is pure client-side slicing. `EpisodeList` holds `visibleCount` (starts at 10, reset in the `[feedId]` effect) and renders `data.episodes.slice(0, visibleCount)`; a **"Load more episodes (N)"** `.btn-ghost` reveals +10 per tap and disappears when all are shown.

Two load-bearing choices:

1. **A button, not infinite scroll** — the per-podcast Nostr comments feed renders *below* the list, so auto-loading would make the list grow as the user scrolls toward the comments ("footer runs away"), burying them on mobile.
2. **No fixed-height inner scroll box** — a second scroll container would fight mobile momentum scroll, the sticky `top-[var(--app-header-h)]` header, and the `scrollIntoView` fix on `window.innerWidth < 1024`. Slicing keeps the page a single scroll container.

Section-divider labels ("Live & upcoming" / "Episodes") derive `prev` from the **sliced** array so they stay correct.

**Music feeds (`isMusic = isMusicMedium(data.podcast)`) behave like albums:**

- **No pagination** — `visibleEpisodes = isMusic ? data.episodes : …slice(0, visibleCount)`; `remaining` is 0 so "Load more" never renders. Still capped at the ~50 `/api/feed` returns.
- **Row tap plays the track** instead of `openEpisode(e)` — tracks carry little extra metadata, so the detail page isn't worth it. Non-music rows still open the detail view.
**A `musicL` PLAYLIST shares the track behaviour and deliberately not the rest** (`isPlaylistMedium` / `playsAsTracks`, `lib/util.ts`):

- **Row tap plays, and the header cover is a play button** — shared, via `playsAsTracks`, because a playlist row is a track.
- **Paging FETCHES.** A playlist's tracks are resolved one Podcast Index lookup at a time, so "Load more tracks" is a real request (`loadPlaylistPage`) that appends and re-writes `episodeQueue` with the **merged** array — a queue holding only the newest page strands a listener playing a track from an earlier one, with ⏭ doing nothing. Every fetched row renders: a second reveal axis on top of the fetch would make one new track cost two presses.
- **Not `isMusicMedium`, and that is the point.** Widening it would turn on the two things a playlist must not do — render all 1217 rows at once, and sort by `<podcast:season>`/`<podcast:episode>`. Those numbers are each track's position *on its own album*, so sorting by them interleaves hundreds of unrelated records by track number and destroys the one ordering the document asserts, silently.
- **Unresolved rows are rendered, not dropped**, with the play control suppressed rather than disabled (empty `enclosureUrl`). The two counts under the list are separate sentences because they are separate claims — see the three-state table in [`feeds.md`](feeds.md).
- **Episode captions become headings.** A `<podcast:txt purpose="episode">` run gets one heading above it, in the same style as the existing "Live & upcoming" / "Episodes" dividers and derived from the sliced array the same way. The comparison is against the previous ROW, so it keeps working when "load more" appends a page.
- **A `podcastL` row is an EPISODE and opens the detail view** — `playsAsTracks` is false for it. Only `music`/`musicL` rows play on tap.
- **`targetWord` says PLAYLIST, never ALBUM.** A curated list drawn from hundreds of artists is not one artist's record.
- `♫ PLAYLIST` stamps the search-results row, through `isPlaylistMedium` and never a raw `=== 'musicL'` — the RSS parsers lowercase the tag and PI returns its own spelling, so a literal comparison stamps one path and silently not the other.

### Reversing the order (issue #239)

A `<Chip>` above the list: `↓ NEWEST FIRST` / `↑ OLDEST FIRST`. Per show, remembered in `bmb:ep_order:<showKey>` — the reason to read a feed oldest-first belongs to the show (a serialized drama, a course), not the person, so one global flip would be wrong for most of a library the moment it is right for one show. Absent means newest-first and flipping back removes the key, so there is one sentinel for the default.

**Client-side only, and it has to be.** `compareEpisodeOrder`'s two callers are both server-side, and reversing there is not available anyway: `fitEpisodesToBudget` trims **from the end**, so a reversed array would drop the newest episodes and could drop live items. `/api/feed` already serves up to `PI_EPISODE_MAX`, so the client holds the whole feed for almost any show and a local reverse is honest.

**Only the non-live tail reverses.** The server sort is three tiers — live, then pending, then the feed's own order — so a whole-array `.reverse()` would drop a live broadcast to the bottom and put the "Live & upcoming" heading *under* the episodes it introduces, since those dividers are computed from adjacency in the rendered slice. A live show is the most time-sensitive thing this list holds; the toggle is about the archive behind it.

**`episodeQueue` follows the DISPLAY, via one derived effect rather than a write at each of the three places `data.episodes` is set.** The order can change without a load, so a per-load write would let the queue and the screen disagree. Reversing the view *only* is the tempting version and it breaks the primary case outright: reversed, episode 1 is the top row and sits **last** in an untouched newest-first queue, so ⏭ has nowhere to go and the listener cannot advance through the show they just asked to read in order. `firstPlayable` follows for the same reason — the header's ▶ has to start where the list starts.

**The truncation notice MOVES, and that is the correctness core.** `/api/feed` sets `truncated` when PI's ceiling or the 3.5 MB budget cut the tail, and newest-first the list simply ends early, so *"Older episodes exist…"* belongs at the bottom where the reader arrives at it. Reversed it is exactly backwards: the episodes we could not fetch are the ones *before* the first row, so the list opens on "the oldest we could reach" while looking like episode 1. The sentence therefore moves **above** the list, is reworded for that direction, and is **ungated** — the bottom copy waits for every row to be revealed, which is the wrong moment for a claim the very first screen is already making. The two never render together.

**No control where there is no choice** (`<RailPicker>`'s rule): hidden on a `musicL` playlist, whose pages are *fetched* so the array is a prefix of the real list, and hidden when there are fewer than two non-live rows. The memo re-checks the playlist medium rather than trusting the hidden control, so a flag left from the previous show cannot reverse the first playlist opened after it. Flipping resets the reveal to 10, for the reason `<FavoritesPage>`'s reset key includes its sort: after a flip, "revealed 200" names a different 200.

**The state is seeded in an EFFECT, not a `useState` initializer.** This list reaches server-rendered routes, and reading storage during the first render is the mismatch `<FavoritesPage>`'s `mounted` gate exists for. `<EpisodeList>` read no storage at all before this, so the hazard is new to it.

**A related latent bug went with it**: the fullscreen album tracklist numbered rows `i + 1`, which only ever agreed with the track number by coincidence of the sort — it now reads the feed's `<podcast:episode>` with position as the fallback. Reversing would have made it label track 1 as "12".

- **Header album art is a play button** when `isMusic && firstPlayable` — the `<PodcastCover>` wraps in a `<button>` with an always-visible `bg-ink/45` scrim + `▶`/`❚❚`. Plays from `firstPlayable` (first non-pending track), or toggles play/pause if a track from this show is current (`showIsCurrent`, matched by `podcastGuid`/`id`).

## Players (mini + fullscreen)

Two surfaces share one `<audio>` and the store's playback state: the always-mounted mini-player (`components/player.tsx`) and the `<FullscreenPlayer>` it opens. **`<Player>` is mounted in `app/layout.tsx`**, not any page, so playback and the overlay survive route changes (browse ↔ `/stream/<naddr>`).

**Both read the store via per-field selectors, never a bare `useApp()`.** In zustand v5 a selector-less `useApp()` re-renders on *every* store write; `<Player>` is always mounted and owns the fullscreen player, the chapters/transcript fetches and the reverse-portal `<video>`, so a bare subscription re-renders that heavy subtree on every unrelated mutation on top of the 1 Hz position ticks. Actions are stable refs, so selecting them is free.

- **Transport controls are shared.** `<TransportControls size="sm"|"lg">` renders ⏮ / play-pause / ⏭ as a **fragment** (drops into each parent's flex row) and owns the queue math: `idx = episodeQueue.findIndex(...)`, prev disabled at 0, next at the last index. Backed by `playPrev`/`playNext` (mirror images — walk `episodeQueue`, reset `positionSec`) and `togglePlay`. Don't re-inline these buttons.
- **Skip (−15s / +30s) is `onSkip`, opt-in, and lives INSIDE the transport cluster** — both players pass it. It exists because `⏮`/`⏭` are **chapter-stepping** whenever the episode has chapters (`buildChapterNav`), so on a chaptered show there was no control anywhere in the app that moved by a fixed interval; the *lock screen* had `seekbackward`/`seekforward` from the day Media Session was wired, and the screen had nothing. Asymmetric intervals are the podcast convention, not a whim: you skip back because you missed a sentence and forward to clear a segment, so a symmetric pair makes one of the two jobs take repeated taps. `SKIP_BACK_SEC`/`SKIP_FORWARD_SEC` feed both the jump and the number drawn on the icon, so the button can't claim 15 and move 30. Opt-in rather than default because it's meaningless on a live stream (no timeline to jump within — the fullscreen player passes `undefined` when `isLive`, the same condition that replaces the seek bar with the ● LIVE stamp; the mini-bar needs no gate because `playOnly={isLive}` already collapses the cluster to play/pause before skip is reached).
- **On the mini-bar skip returns at `lg:`, not at `sm:` with ⏮/⏭, and that breakpoint is measured.** The pair costs a flat **96px** — two 40px buttons plus two 8px gaps — at every width, and the mini-bar is one flex line whose every button is `flex-shrink-0`, so all 96px comes out of the title and the seek bar. Measured on the same row with the pair hidden vs shown: 1280px seek **641→545**, 1024px **385→289** (both fine); 768px **129→33**; 700px **61→0**. The band just above `sm:` has nothing to give, because 640px is where ⏮/⏭, the AUDIO/VIDEO toggle *and* BOOST expanding 44→104 all reappear at once — **at 640px the seek bar was already 1px wide before skip existed**, which is a pre-existing squeeze this deliberately does not make worse. So the ladder is: `<640` play only, `640–1023` the three original buttons (numbers byte-identical to before), `≥1024` all five. Hiding is honest at every step because the mini-bar is itself a button that opens the fullscreen player, which carries all five at *every* width — verified at 390px. `skipShow` is a separate variable, never `` `${sideShow} lg:flex` ``: both are display utilities at equal specificity, so a string still containing bare `flex` would let Tailwind's emit order decide the layout — the same trap `sideShow` documents.
- **`skipBy` reads `el.currentTime`, never `positionSec` — relative seeking cannot be built out of `onSeek` + the store position.** The store's position is a copy refreshed from `timeupdate` (~4 Hz) and mirrored into React state, so two quick taps on +30 both compute from the same stale base and the second *overwrites* the first: press twice, move thirty seconds. It lives in `<Player>` (which owns the element) as a dependency-free `useCallback` built only from refs, so the `[]`-dep Media Session effect can close over it — and **the lock-screen `seekbackward`/`seekforward` handlers now go through it too**, since they had exactly the same stale-base bug against `getState().positionSec`. `seekto` stays on the absolute path. Clamped to `[0, duration]` with `duration` read off the element, because it is `Infinity` on a live stream and `NaN` before metadata; the upper bound is skipped in both cases rather than becoming a NaN comparison that swallows the seek.
- **The fullscreen control row is `flex-wrap` and BOOST is `basis-full sm:basis-auto sm:flex-1`.** Five transport buttons don't fit beside BOOST on a phone: measured at 390px the pane's `p-4` leaves 358px, and ⏮ + −15 + ▶ + +30 + ⏭ is 248px of button plus 48px of `gap-3`, which would have left BOOST ~50px — the same squeeze the mini-bar answered by shedding ⏮/⏭. BOOST takes its own full-width line instead, which is the better shape for the primary action anyway. Identical to before from `sm:` up.
- **The skip icons are inline SVG (`SkipBackIcon`/`SkipForwardIcon`), not glyphs, and one is the mirror of the other.** There is no character for "jump back fifteen seconds": ⏪/⏩ mean *scan*, a different transport verb, and ↺/↻ beside a separate number reads as two controls. One path is drawn as the **forward** arrow (clockwise, tip at top right) and *back* gets `scaleX(-1)`, with the `<text>` label counter-transformed so the digits stay upright. Getting that mirror backwards is close to invisible in review — both buttons still show a circular arrow with the right number, each just wearing the other's direction — and it shipped that way in the first pass here, caught only by looking at a 4× screenshot.
- **The mini-bar sheds controls below `sm:`, and the numbers are why.** Its row is one flex line — art, text column, controls — and the controls could not shrink: every button is `flex-shrink-0`, so `min-w-0 flex-1` on the text column meant the text absorbed the entire shortfall. Measured in-browser at 390px: the title column got **31px** (it needs 206px) and the seek `<input>` got **0px** — the two time labels printed on top of each other, and the title read `Epi…`. Nothing overflowed, so no scrollbar and no clipping ever hinted at it. Three changes take the title to **202px** and the seek bar to **120px**, with the 1280px layout byte-identical (controls 248px, BOOST 104×38, seek 839px): `px-3 sm:px-4` + `gap-3 sm:gap-4` on the row, BOOST collapsing to a 44px icon square (`btn-compact` + `min-w-[44px] sm:min-w-0`, `aria-label` **required** since `title` is not an accessible name), and `<TransportControls sidesOnDesktopOnly>`, which hides ⏮/⏭ under `sm:`. That last one is a **hide, not a drop** — the whole mini-bar is a `role="button"` that opens the fullscreen player, where the full transport lives one tap away, the same trade the `<VideoToggle className="hidden sm:inline-flex">` beside it already makes. `sidesOnDesktopOnly` swaps the side buttons' base `flex` for `hidden sm:flex` rather than appending a class: both are display utilities at equal specificity, so a string that still says `flex` would be deciding the layout on Tailwind's internal emit order. Verified at 320 / 390 / 639 / 640 / 1280 — no horizontal overflow at any of them.
- **`playNext` auto-advances on `onEnded` only for music**; other media stop.
- **Fullscreen layout** is a two-pane flow in one scroll container (`flex-1 overflow-y-auto overscroll-contain flex flex-col sm:flex-row`): media centered in a sticky left pane, info in the right. While open it holds a lock from `lib/scroll-lock.ts` — see the next bullet, which is the whole reason that module exists.
- **`overflow: hidden` on `<html>`/`<body>` is not a scroll lock on iOS, and the symptom is not the one you expect.** That was the implementation here, locally, with `<ModalShell>` carrying a second and different copy. In the installed home-screen app (standalone PWA) WebKit scrolls the web view anyway — and when a document scroll happens there, `position: fixed` elements travel *with* it. So the overlay itself slid off the top of the screen and the browse page showed in the strip it vacated. That reads as "the fullscreen player is too short", which sends you to `100dvh` and the safe-area padding, where there is nothing wrong. **The tell that it is a moved layer and not a short box:** the player's own header goes missing at the top, and the `fixed bottom-0` mini-player bar goes missing at the bottom, *at the same time*. A short overlay would leave both of those exactly where they are. Reported 2026-08-23 off an iPhone screenshot with the gap staying after the finger lifted, which also rules out a transient rubber-band bounce.

  `lib/scroll-lock.ts` is the one lock for the whole app: `position: fixed` on `<body>` with `top: -scrollY`, which leaves the web view no scroll range to drag. Two things it has to get right and both are recoverable-looking rather than obvious. **The saved offset is read once, on the first lock** — a second lock reads a `scrollY` of 0 (the page is already pinned) and would overwrite it, so closing would drop the user at the top of a browse list they had scrolled a long way down. And **the count is shared across surfaces, not per surface**: a BOOST modal opens from inside the fullscreen player, so the two genuinely stack, and while `<ModalShell>` refcounted its own copy the player locked outside that count entirely — whichever released first unlocked the page under the other one. `overscroll-contain` at each overlay's scroll boundary is the second half: it stops a swipe past the end of a list from chaining out to the document in the first place. Containing at the boundary covers the nested lists (the album list, the transcript box) because chaining walks outward to the nearest scrollable ancestor.
- **The panes are `sm:h-full`, never a calc against the viewport.** They were `sm:h-[calc(100vh-3.5rem)]`, which gets the row's height wrong twice: the overlay is `100dvh` (see its own note), and 3.5rem is a *guess* at the header, which grows with its contents — the signed-out `◆ Sign in` button alone is enough. Both panes then stand taller than the row that holds them, and that row is `overflow-y-auto`, so the shortfall surfaces as **a scrollbar down the entire page** with nothing actually scrollable in it. `h-full` resolves against the row's own definite height and fits whatever the header does. Anything else in that column with no overflow of its own (the video box, below) has to fit inside it for the same reason.
- **Video mode widens the media pane at `lg`+ (60/40), and the video box's width cap is bounded by the available HEIGHT.** `mediaPane`/`infoPane` are computed once and applied to **both** panes: the media column is `flex-shrink-0`, so setting only its width would leave the real split to flex shrinking. The widening starts at `lg` because a 40% info pane between 640 and 1023px is 256–410px, too tight for the title + seek + transport/BOOST row it pins. The box is `aspect-video`, so its height *derives* from its width — a `max-h` would clamp the height while `w-full` held the width and quietly break the 16:9 frame. Hence `lg:max-w-[min(64rem,calc((100dvh-13rem)*16/9))]`: cap the width by what the height can afford and the ratio stays exact. The 13rem is rounded **up** on purpose (header + `lg:p-10` + `gap-4` + the AUDIO/VIDEO pill) — under-budgeting it re-creates the row scrollbar above. Audio mode keeps the 50/50 split and its `aspect-square` caps.
- **Native fullscreen promotes the video's STAGE div, not the `<video>`** (`fullscreenSupported`/`toggleFullscreen`/`exitFullscreen` in `lib/util.ts`, beside the PiP pair), so our own overlay controls — tap-to-play, PiP, the exit button — ride along on top of the picture. iPhone Safari implements element fullscreen for *nothing*, so it falls back to `video.webkitEnterFullscreen()` and hands off to the native iOS player, which owns its own exit; that path fires no `fullscreenchange`, so the button's label stays "Full screen" there. Two rules that aren't optional: **collapsing the player must exit fullscreen** (`useEffect` on `open`) or a top-layer video outlives the overlay it belongs to and covers the whole app with no way back; and the stage's in-page size caps must be **shed in the top layer** via `.video-stage:fullscreen` in `app/globals.css` — author styles still beat the UA's `:fullscreen` rules, so `max-w`/`aspect-video` would otherwise render fullscreen as a capped 16:9 box in the corner of a black screen. That CSS is **two rules, never one comma-joined selector list**: a browser that can't parse `:-webkit-full-screen` discards the entire rule if they're joined.
- **The stage's PiP button is gated on `pipNeedsOwnButton`, not `pipSupported`.** Chrome and Firefox paint their *own* PiP control on hover over any sizeable video, with or without `controls`, so ours lands as a second identical icon in the same corner. `disablepictureinpicture` would suppress theirs but also disables the API ours calls, so not drawing ours is the only lever. The mini-bar keeps `pipSupported` — its 48px thumbnail is below the size at which browsers paint anything. If a browser ever ships the standard API *without* the hover control, this hides the only way in; the fallback is to render ours always and move the cluster to `bottom-2 right-2`.
- **Right pane:** title/seek → control row (`<TransportControls size="lg">` + a `flex-1` `⚡ BOOST`), then a second row of `<FavHeart size="md">` + SHARE + the STREAM button → value-split disclosure → **album tracklist** for music (`Album · N tracks`, `episodeQueue` clickable, current highlighted, `max-h-80` scroll) → `<EpisodeInfoPanel>` → `socialInteract` thread. **For Nostr live streams the right pane is replaced by the live chat.**
- **HLS video lives alongside the `<audio>`** — see Nostr live streams for the reverse-portal `<video>` and the `isHlsUrl` branching.
- **`playerExpanded` is store state, not local**, so surfaces outside `<Player>` (a live-stream card) can open it; `<Player>` still owns the render. The header `← back` and ✕ both call `onClose` (collapse, not stop). Signed out, the header shows `◆ Sign in`.
- **The "About this episode" box wraps long tokens** — `whitespace-pre-wrap break-words`. The fullscreen copy has no inner scroll box (see the `<EpisodeInfoPanel>` note below); the *detail view's* notes do carry `overflow-x-hidden`, and there it is load-bearing next to any `overflow-y-auto`: a computed `overflow-y` of `auto` makes the browser compute `overflow-x` to `auto` too, so one unbreakable token (a bare URL) wider than the box spawns a horizontal scrollbar. Same gotcha as the html/body `overflow-x: clip` note under *Background art, the canvas-bg gotcha, and modal geometry* below.

## Chapters (Podcasting 2.0 `<podcast:chapters>`)

`Episode.chaptersUrl` comes straight from PI's `chaptersUrl` — no RSS enrichment needed. `useChapters(url)` (`lib/chapters.ts`) fetches `{ chapters: [{ startTime, title, img?, url? }] }` and **no-ops on an empty `url`**, so callers can invoke it unconditionally (React hook rules). Per-chapter `img` and `url` are surfaced when present: a chapter row shows the thumbnail and a trailing `↗` link (a **sibling** anchor, so it doesn't nest inside the seek button); rows are tap-to-seek. Chapters render as rows of `<EpisodeContents>`, interleaved with the episode's tracks — see that section.

**The parse is deliberately lenient in exactly one way, and `/api/chapters` owns it — never widen it into a general JSON repairer.** `parseChaptersJson` (`lib/chapters-json.ts`) runs a strict `JSON.parse` first and only then a second pass that drops an orphan run of digits sitting between a `,` and the next `"`. It exists because a real feed serves valid chapters behind invalid bytes: V4V Music Spotlight 005 published 25 correct chapters with a stray `0` at the start of the line before every `"title"` key, so `JSON.parse` stopped at position 80 and the app rendered "no chapters" — the same screen an episode with none renders, which is why nobody could tell the difference from the outside. Three properties keep it safe and each is easy to delete by accident. **The walk is string-aware**: the obvious one-regex version is blind to string literals, and a chapter title ending `Take 1, 0` carries the same bytes the corruption does, so that version eats a character out of the title and the document still parses — a caption the publisher never wrote, with no error anywhere. **The repair is unreachable for valid input**, because `, <digits> <whitespace> "` outside a string is two values with no comma between them and cannot occur in a well-formed document; the strict-parse-first gate is the second, redundant guard on the same property. **An unfixable document rethrows the STRICT error**, so the message keeps naming the fault the host actually served rather than an offset in a string nobody sent. Pinned by `npm run check:chapters` against the complete file as served. The client never re-parses: `/api/chapters` re-serializes what it parsed, so this one fix covers both players and the episode page.

**A chapter with no `img` of its own falls back to the episode's art, then the show's `image`, then its `artwork`, and that's an alignment fix as much as a decorative one.** Feeds typically illustrate a handful of chapters and leave the rest bare — 4 of 16 on a real episode — so rendering the thumbnail only when present gives the list two different left edges and reads as broken layout rather than as "this chapter has a picture". The chapters that *do* ship their own art still stand out, because it's their art rather than the one repeated down the column. `<EpisodeContents>` takes a `fallbackImg` prop for this (the fullscreen player calls it `chapterFallbackImg` on its way down) and hands it to **`<RowThumb>` (`components/chapter-ui.tsx`)**, which is where the chain and the three rules below live. It applies to track rows too — a window whose remote item never resolved has no art of its own either.

Three rules on that prop, each of which shipped wrong first:

- **`||`, never `??`, and `artwork` is not optional.** Podcast Index returns `""` for an absent image rather than omitting the field, and `'' ?? x` is `''` — so the chain silently did nothing on exactly the episodes with no art of their own, the ones it exists for. `lib/pi.ts` now coerces `"" → undefined` in `buildEpisode`/`buildPodcast` (its `link`/`chaptersUrl` neighbours always did), and the call sites use `||`. `podcast.artwork` is the third link because a dead channel `<image>` beside a working `<itunes:image>` is the documented case — Homegrown Hits — that `<PodcastCover>` exists for; omitting it fell back to a 404.
- **`onError` must terminate on an attempt marker, not a string compare.** `HTMLImageElement.src`'s *getter* returns the RESOLVED absolute URL while the fallback is a raw feed string, so an untrimmed, relative or protocol-relative URL never compares equal and the handler re-assigns the same failing URL **forever**. An ad-blocked host makes that a tight loop (failure with no round trip), and `<FullscreenPlayer>` is always mounted — only translated off-screen — so collapsing the player does not stop it. A `data-fell-back` marker plus `key={c.img || fallback}` (so a changed list remounts rather than inheriting another episode's marker) is what terminates it. **This is NOT the same mechanism `<PodcastCover>` uses** — an earlier version of this doc claimed it was. `PodcastCover` terminates *by construction*, via a monotonic index and a `key`-driven remount (`components/podcast-cover.tsx`); the chapter rows terminate only because something explicitly counts the attempt.
- **Hide with `visibility`, not `display`,** so a dead image keeps its box and the one-left-edge this whole thing is for survives the failure it was written for.

`lib/chapters.ts` is the single home, exporting `chapterUrlFor(current)`, `chapterState(chapters, pos, dur)` → `{ index, chapter, end }`, and `buildChapterNav(chapters, idx, pos, seek)` → the `<TransportControls>` `prev`/`next` override (or undefined). Three surfaces render chapters: the detail view (read-only), the fullscreen player, the mini-player.

**One fetch per episode, owned by `<Player>`.** `<Player>` always mounts `<FullscreenPlayer>` (translated off-screen when collapsed), so if both called `useChapters` the JSON would be fetched **twice** per play. `Player` does the single `useChapters(chapterUrlFor(current))` and passes `chapters`/`chaptersLoading` down. `chapterUrlFor` is also the **single gate**: it returns `''` for live streams and music feeds, so chapters are podcasts-only everywhere at once, with no per-component `!isMusic` checks.

**Both players** carry the same affordances: seek-bar **tick marks** (`<ChapterTicks>`), a **current-chapter label** (`<ChapterLabel>`, `start–end · title`) — both in `components/chapter-ui.tsx` — and **chapter-stepping ⏮/⏭** via `buildChapterNav` feeding the `prev`/`next` override (absent → falls back to episode/track nav). Prev restarts the current chapter if >3 s in, else jumps back. The tick wrapper uses a `block` input + `flex items-center` so ticks center on the 2px track (an inline-block input leaves a baseline descender gap that drops them below the line).

**Fullscreen `<EpisodeInfoPanel>`** merges about-text, the episode's contents (tracks + chapters, one list) and transcript under an **About / Tracks|Chapters / Transcript** tab strip. Tabs appear only for sections with content (2+); a lone section renders under a plain label; a loading section shows its own state; neither → null. The strip is `inline-flex max-w-full overflow-x-auto` with `shrink-0` pills, so it's compact on desktop and swipeable on mobile instead of clipping the last tab. Chapters there are seek targets with an active highlight. Receives `chapters`/`loading` as props. The list **flows with the page's single scroll** — no inner `max-h`/`overflow` box, which fought the right pane's own scroll. The non-live right pane splits into a **pinned header** (title, seek, transport/boost, value-split, album) and a **scrollable body** so controls stay put while About/Chapters scroll (desktop `sm+` only; mobile stays one scroll).

## Episode contents — tracks and chapters in one list

`<EpisodeContents>` (`components/episode-contents.tsx`) renders **one** list per episode: the tracks it played (`<podcast:valueTimeSplit>` windows) and its chapters, interleaved by timestamp. Thumbnail, timestamp, title; a track row carries a `<FavTrackHeart>`, a chapter row carries its `↗` link. It is a single tab in the fullscreen `<EpisodeInfoPanel>` and in the episode detail view's mirror strip. It replaced three lists: a `<TrackList>` and two separately-drifted chapter lists.

**The tab's name comes from `episodeContentsLabel` (`lib/util.ts`) and chapters win: `Chapters (N)` whenever the episode has any, `Tracks (N)` only when it published windows and no chapters at all.** The precedence ran the other way first — one window renamed the whole tab — and *Chad and Reeds* 002 is what that costs: a single `<podcast:valueTimeSplit>` against a dozen-plus chapters rendered **`TRACKS (1)`** over a list of chapters, so the noun described none of the rows and the count described one of fourteen. Chapters are what the merged list is mostly made of on a talk show, and a music episode publishing windows and no chapters is the only case where "Tracks" names the whole list. **Neither branch is ever the merged row count** — `Chapters (31)` over 14 songs and 17 talk breaks claims 31 chapters, and a number that names something other than the label is worse than no number. The helper is in `lib/util.ts` rather than either component because both tab strips render the same `<EpisodeContents>` list and each held its own copy of the expression, which is the shape that drifts into naming the same rows two different ways.

**It was two tabs, and that was the bug.** Tracks and Chapters sat side by side with near-identical rows, on a music show largely naming the same songs, asking the listener to hold a distinction that is ours and not theirs. Reported as *"I wanted the favorite button in the chapters list and not a new tracks list made."*

**Merging them is presentational and deliberately nothing more. The heart still rides on the WINDOW, and no chapter is ever mapped to one.** The merge is `mergeEpisodeContents` (`lib/util.ts`), by timestamp alone. A track row is built from a window and carries that window; a chapter row is built from a chapter and carries no identifiers. They are distinct variants of `EpisodeContentRow`, so a chapter row has no `split` to hand `<FavTrackHeart>` even by accident.

**Deriving one list from the other does not work, and the live wire is emphatic.** The two look nearly identical on screen, so it is the obvious implementation. Measured on *Mutton, Mead & Music* 150 (feed 6594523) — 15 windows against 25 chapters, ten of them the host's own talk breaks — two chapters share a `28:20` start, one a talk break and one the song `10. Reefer Gladness`, so "the chapter nearest this window" is a **tie** that resolves to the talk break; and a talk break at `33:49` falls **inside** the 28:21–33:50 window, so "the window covering this chapter" hands that row the wrong song.

Homegrown Hits 146 (feed 6611624) is worse, and it is the vector `check:vts` pins, because **the windows overlap**: `1919 + 285 = 2204`, past the `2192` window's own start. So "the window covering this chapter" gives the *Cloud Burst* chapter the identifiers of *Victim [432Hz]* — **despite Cloud Burst having a window of its own, right there, at its own start.** It does the same to *Eurydice* (given Shanti's window) and *The Wait Is Over* (given January Shock's). Three named songs, one episode, each favoritable as the wrong track with nothing on screen saying so.

The window is also the authoritative one on its own merits. It decides who a boost pays (CLAUDE.md boost invariant 0.5), and it is the only one of the two carrying a `feedGuid`/`itemGuid` pair — which is exactly what naming a track on someone else's device takes, and therefore the whole content of a favorite. A chapter has no identifier at all. And a chapter-derived list would be *absent* on the many Split Kit shows that publish windows and no chapters JSON.

### The merge rules

Five, in descending order of what they cost to break. `check:vts` pins every one against the real 14-window/31-chapter HGH 146 wire arrays, plus a `naive()` pass that fails the run if the chapter-wins, exact-equality or covering-window versions would have survived.

1. **Every window becomes a row, always** — never deduped against each other, never dropped. Dropping one removes a heart invisibly: the row it collided with still looks like the song.
2. **Only a chapter may be dropped.** A chapter within tolerance of a window's start is naming that moment, and the window is the half with the identifiers. Reverse it and every song the host also chaptered loses its heart — on a music show, most of them.
3. **A tolerance (2 s), not exact equality.** Podcast Index hands back **integer** `startTime`s while the chapters JSON is **fractional**: `34` against `33.778`, `351` against `350.981`, `1149` against `1148.691`. On HGH 146 all 14 windows have a chapter within **0.445 s** and exactly **one** pair matches exactly — so exact-equality dedupe leaves thirteen duplicate pairs standing, one row of each carrying a heart and the other not, both naming the same song. Bounded the other way too: the closest two distinct chapters there are 14 s apart, so 2 s cannot over-merge. *(This is why the fixture is real wire data. A hand-built one would have used round numbers and made exact-equality look correct forever.)*
4. **A track sorts ahead of a chapter at the same second**, so the heart-bearing row is the one the eye lands on. Otherwise stable, so feed order survives among equal starts.
5. **An absorbed chapter leaves its title behind, and only its title.** PI has not crawled every album feed, so a window routinely resolves to nothing and renders *"Track not yet indexed"* — while the chapter rule 2 just dropped names the song outright (window `5046` on HGH 146 against the `5045.605` chapter titled *"Shanti"*). Discarding that makes the merged list strictly worse than the chapters list it replaces, so the row keeps it as `absorbedTitle` and `<RowTitle>` prefers `split.title` over it. **Guarded on the pairing being unambiguous** — a chapter is absorbed by its *nearest* window, and a window that absorbed more than one publishes no title at all, which is the *Mutton, Mead & Music* tie. It is decoration and **cannot reach a favorite**: the heart is built from `remoteItem`, which the borrow never touches.

### Exactly one row highlights, and a track row wins

The three lists this replaced each had their own rule — `splitAtPosition` identity, "last start passed", and bounds against the next chapter — and merging them naively lights two rows at once.

`currentSec === undefined` means the episode isn't playing and is checked **before any position lookup**; **0 is a real position and cannot also be a sentinel** (half-open windows make `0` match anything authored at `startTime: 0`, the norm on a Split Kit playlist). Otherwise a window wins, via `splitAtPosition` rather than "last row passed" — a window carries a `duration` and can end before the next row begins, so last-start-passed goes on claiming a song is playing after it stopped; and `splitAtPosition` is the same function the boost modal and `lib/v4v/streaming.ts` consult, so the highlighted track row is by construction the one a boost pressed now would pay. Only when no window covers this second does a chapter row light up.

**Favoriting a track records the artist's release, not the episode that played it.** `<FavTrackHeart>` (`components/fav-heart.tsx`) writes the same `FavoriteEpisode` every other episode heart writes, onto the same kind:10333 list, built from `remoteItem` — so favoriting a song off a DJ set and favoriting it off the artist's own album produce the **same entry**. Nothing about the show doing the playing is recorded. Two rules it inherits from the surrounding code rather than inventing:

- **An unresolved window still gets a heart.** Title and cover come from resolution and are decoration; the identifiers come off the wire and are the record. Withholding the control until PI has crawled the album would hide it on exactly the independent releases this app exists to pay, and the favorites hydrator already renders an unresolved entry as a placeholder and fills it in later.
- **`medium` is `remoteItem.medium` and nothing else** — the host's feed declaring what it pointed at. This app's own inference that a track in a music show must be `music` is a guess, and a guess published to a list other apps read is one no other app will ever correct. Same rule `declaredMedium` applies to the other two hearts.

`ValueTimeSplit.feedTitle` exists for this: `resolveOneSplit` carries the remote item's parent-feed title through so a fresh favorite records its album name instead of waiting for a later PI resolve. Only the PI branch can supply it — the RSS fallback may have reached the item through a publisher chain and `ResolvedRemoteItem` has no channel title, so there it stays undefined rather than being guessed from a URL.

**One fetch, two readers.** `useResolvedSplits(episode)` (`lib/track-art.ts`) is the single request; `splitArtAt(splits, pos)` picks the now-playing cover out of it. `<Player>` owns both for the playing episode and passes `splits` down, for the same reason it owns `chapters` — `<FullscreenPlayer>` is always mounted, so a hook in both doubles every episode's request. The **detail view calls the hook itself**, deliberately: it is showing a *chosen* episode, which is usually not the one playing, so `<Player>`'s copy is for a different episode entirely. The endpoint is CDN-cached for an hour and shared with both boost modals, and an episode with no windows issues nothing at all.

**Row thumbnails go through `<RowThumb>` (`components/chapter-ui.tsx`).** Both chapter lists had their own copy of the two-URL-then-hide fallback and its terminating `onError`, and had already begun to drift; a third copy in the track list would have been the one that got it wrong. Merging the three lists retired the drift at the source — there is now one row renderer — but `<RowThumb>` stays extracted, because `<ChapterTicks>`/`<ChapterLabel>` keep it company and the seek bar still reads chapters directly. The rule it carries is written up under Chapters below.

### The art follows the payment target, not the show

**Whatever is playing at this second is what the hero shows, and the ranking is by how authoritatively a source names the song — which is also the order in which those sources decide who gets paid.** `nowPlayingArt(…)` (`lib/track-art.ts`) is the single composer, called by the mini-bar thumbnail and the always-mounted fullscreen hero:

1. **`liveBlockImage`** — the record a live Split Kit show is playing (`useLiveBlockImage`, from the live-value watcher). Ungated: it changes once per record, so it can't be the thing hammering the audio's own origin.
2. **`splitImage`** — the track the active `<podcast:valueTimeSplit>` redirects to (`splitArtAt` over `useResolvedSplits`, resolved through `/api/value-splits` → `resolveValueTimeSplits`, so the art comes from the artist's own feed via the remote item).
3. **`chapterImage`** — the active chapter's `img`.

Then each surface's own tail (`|| episode.image || podcast.image`), which is why the helper returns `undefined` rather than a fallback: those tails differ, and `||` is deliberate throughout (PI returns `""` for an absent image, and `'' ?? x` is `''` — the same trap as the chapter-row `fallbackImg` above; the fullscreen hero was on `??` and has been moved over).

**The valueTimeSplit entry is not decoration — it's the pre-recorded half of a promise the live path has been keeping since `live-value.ts` shipped.** Press BOOST inside a window and the payment goes to the artist, in two legs, carrying the track's `remote_*` guids ([`../CLAUDE.md`](../CLAUDE.md) boost invariant 0.5). The screen said "the show" the whole time: episode cover, show title, and the only hint that anything had been redirected was inside the modal you hadn't opened yet. Reported as *"this should have the art for the song and not the show"* on **Chad and Reeds 002 · Idea Economy** at 1:37:53 — inside the Copenhagen Time window (`startTime: 5854`, `duration: 281`, the same wire vector `check:vts` pins).

**Why the redirect outranks the chapter, when both are trying to name the song.** A chapter `img` is whatever the host illustrated that stretch of audio with — routinely the show's own cover, and routinely absent (4 of 16 on a real episode). The remote item is the artist's own feed. They also disagree about boundaries: on that same episode the chapter starts at 1:37:45 and the window at 1:37:34, an 11-second stretch where the two sources name different things — and it's the window that decides who gets paid, so it's the window the picture should agree with.

**One fetch per episode, owned by `<Player>`,** for the same reason `chapters` is: `<FullscreenPlayer>` is always mounted, so a hook in both doubles every episode's request. `<Player>` calls `useResolvedSplits` once and passes both `splitArt` (via `splitArtAt`) and the `splits` list itself down — the Tracks tab is the second reader of that one fetch. Two properties keep the request rare: the windows themselves ride on `episode.valueTimeSplits`, so an episode with no redirects issues nothing at all; and the endpoint answers with a one-hour CDN cache shared with both boost modals.

**It follows the position live — unlike `useActiveSplit`, which freezes on purpose.** The boost hook freezes because a boost aimed at a song must not land on the show because the song ended while the user was typing. Artwork has the opposite obligation: a frozen hero would show the last song's cover for the rest of the episode. Both call the same `splitAtPosition`, so the picture and the payee can never disagree about which song is playing at a given second.

Unresolved windows are ordinary, not an error — PI hasn't crawled every album feed — and they simply fall through to the chapter/episode art, i.e. exactly the behavior before this existed.

### Artwork must never outrank the audio

`<Player>` keeps an `artOk` gate, and both art surfaces — the mini-bar thumbnail and the fullscreen hero — compose their image through `nowPlayingArt(…)` (`lib/track-art.ts`, gated) rather than reading `activeChapter.img` directly. A gate applied to one surface only is no gate at all: either fetch alone is enough to starve the enclosure.

**Why it exists.** Chapter art is arbitrary third-party media, it is routinely hosted on the **same origin as the enclosure**, and it is routinely enormous. Homegrown Hits ep. 146: 31 chapters, 15 of them on the audio's own host, `hgh-vinyl.gif` at 33.4 MB, `HGH-Disco-Head.gif` at 36.3 MB, `HGH-TNS-Disco-Seedubs-Edition-ultra-high-res.gif` at 34.2 MB — beside a 175 MB mp3, all on one HTTP/2 connection. Every ⏭ swapped a new one in. Measured A/B over a 2 Mbit link, six chapter skips, identical in every other respect:

| | playback in the next 20 s |
|---|---|
| images blocked | **+13.1 s**, `readyState` 4 |
| images allowed | **+0.0 s**, frozen at `readyState` 1 |

The reported symptom was "I'm skipping chapters and the audio isn't playing now" with the transport still showing ❚❚ — because a starved element keeps `paused === false`, so nothing on screen contradicted it.

**What did and didn't work.** Deduplicating the fetch (the mini-bar and the always-mounted fullscreen hero were pulling the same URL in parallel), `loading="lazy"`, `fetchPriority="low"` and `decoding="async"` all helped and **none of them were sufficient** — one 36 MB GIF is still 36 MB. Keep them anyway; they're why the collapsed player no longer downloads art nobody is looking at (`<PodcastCover lowPriority>`). The fix that works is yielding:

- **`waiting`/`stalled` slam the gate shut**, which drops the src to the episode cover and thereby **cancels the in-flight chapter image**. These events close it rather than the headroom sampler, because `sampleHeadroom` rides on `timeupdate` — *which a wedged element stops firing*. A gate that only closed from there stayed open in exactly the case it exists for. That was a real intermediate failure, not a hypothetical.
- **Reopening needs real headroom, and hysteresis is the design.** Opens at 20 s buffered, closes at 5 s. A single threshold oscillates: drop the art → pipe frees → buffer recovers → art reloads → buffer starves.
- **Every way back in has to be wired, or the gate is one-way.** Closing it is cheap — two events, always available. Reopening it shipped riding on `timeupdate` *alone*, which fires only while audio is advancing, and that made it a trapdoor rather than a gate. Three separate ways to fall through it, all reported as the same thing (chapter art that never appears, next to the buffering line, on a chapter whose art is plainly visible in the chapter list one scroll above):
  - **Paused.** iOS Safari raises `waiting` on an ordinary seek, so the gate shuts on a chapter skip; a listener who then pauses — or who just stopped — emits no `timeupdate` at all, and a paused element that has finished downloading emits no `progress` either. Nothing left to sample with, forever. **`sampleHeadroom` now also runs on `progress` and on `playing`**, and the gate is **bypassed entirely while nothing is playing** (`artUsable = artOk || !isPlaying`): the claim being enforced is that artwork must not outrank the enclosure, and with no enclosure in flight there is nothing to outrank. A paused screen is also exactly when someone is looking at the art.
  - **The tail of the file.** `ahead >= 20` is unreachable in the last 20 s of an episode however complete the download is, so the gate was permanently shut for the whole ending — which on a music show is where the closing song, and its art, live. Both thresholds are now `Math.min(threshold, timeLeft)`; a fully buffered element has nothing left to starve. Non-finite `duration` (Infinity on a live stream, NaN before metadata) means "no end in sight" and keeps the plain thresholds — subtracting anyway puts NaN on both sides of the comparison and shuts the gate for good.
  - **Resuming with a warm buffer.** `playing` is a real all-clear with a real buffer behind it, so sampling there restores the art in the same tick instead of blanking it for another 20 `timeupdate`s.
- **The lock screen follows the chapter too, but only on a SETTLED url.** `navigator.mediaSession.metadata` was episode-only, because an OS artwork fetch is not an `<img>`: the browser issues it on our behalf, it takes no `fetchPriority`, `loading="lazy"` means nothing to it, and it is **not cancelled** when the next chapter supersedes it — replacing the metadata just queues a second fetch behind the first. That measurement stands, so following the chapter is affordable only with two things in place, neither optional:
  - **It reads `nowArt`**, so it is behind the same `artUsable` gate as the on-screen art. A starved buffer hands the OS nothing new and the cover it already has stays put.
  - **It settles** (`LOCK_ART_SETTLE_MS`, 3 s). The timer restarts on every change, so a *run* of ⏭ presses issues nothing at all — only the chapter someone stops on is ever fetched, and it's fetched once the skipping is over and the connection is free. That is the direct answer to "every ⏭ swapped a new one in": six skips cost one fetch instead of six.

  **The settled value carries the episode id it was settled for** (`lockArt.epId === episodeId ? … : undefined`). Without that the 3 s of lag becomes a correctness bug at every episode change: the metadata effect re-runs immediately on the new episode while the state still holds the old one's chapter art, so the lock screen shows the previous show's cover under the new title — and pays for the fetch. Comparing the id makes a stale value read as `undefined` in the same render, so the new episode's own cover goes out first.

  What's left is honest and unavoidable: on a feed with 36 MB chapter art you still fetch one per chapter you genuinely listen to. The gate closing is what protects playback if that turns out to hurt.
- Verified afterwards: unthrottled, chapter art is still used (this must not quietly become "chapter art never loads"); at 1.2 Mbit with 12 rapid skips, playback recovers and then runs in real time with the buffer growing.

**All of the Media Session wiring now lives in `components/player/use-media-session.ts`** — the transport action handlers, the `playbackState` mirror, the `setPositionState` scrub bar, the `lockArt` settle state and the metadata rebuild. It was extracted from `<Player>` as one unit because those four effects and the state between them are entirely about the OS lock screen and touch nothing else in the player except its element refs.

Two things about that boundary:

- **It is called after `nowArt`, not at the top.** The metadata effect consumes the settled artwork, so hook order follows the data. React only requires hook order be *stable across renders*, not that it match any semantic order, so moving the whole cluster down is safe — but moving only part of it back up would not be.
- **The rest of `<Player>` was deliberately left in place.** The source effect, the `artOk` gate above, the HLS path, the iOS foreground resume and the streaming-engine teardown are entangled with each other and with playback correctness — the gate's reopen path especially (`progress`/`playing` sampling, `Math.min(threshold, timeLeft)`) is subtle enough that a mechanical extraction would hide the reasoning rather than isolate it. `stopStreamingEngine` must also keep *not* settling on Fast Refresh, which is a property of where it is called from.

**A stall is also SAYABLE now.** `onWaiting`/`onStalled` set `stalled`, `onPlaying` clears it, and the mini-bar shows a muted "buffering" line — not an error, and nothing on that path calls `pause()`. Pressing play on a stalled element re-sources it through the same `reloadNonce` the live-resume path uses, resuming from `positionSec`; before this, "the play button does nothing until I reload the page" was the honest description. The readout deliberately names no cause: the artwork case is now mitigated, so a stall that still reaches the user is a plain slow network.

**The fetch goes through `/api/chapters?url=<encoded>`, not directly.** Many chapter hosts (notably `feeds.fountain.fm`) serve the JSON with **no `Access-Control-Allow-Origin`**, so a direct browser fetch is CORS-blocked and the hook's `.catch()` silently rendered no chapters. `app/api/chapters/route.ts` is the proxy: `rateLimit` → `safeFetch` with timeout → upstream JSON verbatim, `Cache-Control` on the 200 only. The client parser stays the single source of truth.

## Transcripts (Podcasting 2.0 `<podcast:transcript>`) — a near-clone of Chapters

`Episode.transcriptUrl` + `transcriptType` hold the **best timed** transcript, chosen **JSON > SRT > VTT** (untimed html/plain last). Parsed primarily from RSS `<podcast:transcript url type>` (`parseTranscripts` in `lib/pi.ts`, merged by guid), with PI's `transcriptUrl` as fallback; selection via `pickBestTranscript`/`transcriptRank`.

`lib/transcript.ts` mirrors `lib/chapters.ts`: `TranscriptCue { startTime, endTime?, text, speaker? }`; `parseCueBlocks` (SRT and VTT share a block structure, so one parser serves both) / `parseTranscriptJson` (word-level JSON grouped into readable lines), dispatched by `parseTranscript(text, type)`; `useTranscript(url, type)` (no-ops on empty url); `transcriptSourceFor(current)` gate (skips live/music). **`transcriptIndexAt(cues, pos)` picks the greatest `startTime ≤ pos`, deliberately NOT "last passed"** — auto-captioners emit out-of-order cues (a real SRT had one), and the reduce shortcut lets such a cue hijack the highlight for its whole window.

`<TranscriptPanel>` (`components/transcript-ui.tsx`) is a **bounded `max-h-96` scroll box** highlighting the current line and **auto-scrolling to follow playback** — measured via `getBoundingClientRect` relative to the box, **not `offsetTop`** (which is relative to the nearest *positioned* ancestor and scrolls to the wrong place) — and it scrolls only its own box, never the page. Tap a line to seek when `onSeek` is given. `<Player>` owns the single fetch and passes `cues`/`activeIdx` to the fullscreen tab; the detail view fetches its own and highlights while this episode plays.

**In-transcript search** lives entirely inside `<TranscriptPanel>` — component-internal `query` state, no new props — so the detail view and the fullscreen player both get it with no caller changes. A non-empty query filters timed cues case-insensitively on `text` **or** `speaker`, keeping each cue's **original index** so the `i === activeIdx` highlight still lines up. Match-count badge, `No matches.` empty state, per-line highlighting via a local `highlight(text, query)` helper that is **`indexOf`-based, never regex**, so a query containing `.`/`(`/`*` is literal and can't throw or inject a pattern; hits get a `bg-bolt/30` `<mark>`. Filtered rows stay tap-to-seek. Clearing: the `×` button, `Escape`, or delete. **The follow-the-playing-line effect is guarded on `!query`** — while filtering, the active line may be filtered out, so chasing it would be wrong; it re-runs when the query clears. Search shows only in the timed-list branch.

**`app/api/transcript/route.ts`** clones `/api/chapters` but returns **text**, always served as inert **`Content-Type: text/plain; charset=utf-8` + `X-Content-Type-Options: nosniff`** — deliberately not reflecting the upstream Content-Type. Transcript URLs come from third-party RSS, so a malicious host serving `text/html` with a `<script>`, opened directly as `/api/transcript?url=…`, would execute in **our** origin and read `localStorage` (the NWC spending credential, the bunker `clientSk`). The client parser branches on the `?type=` hint — load-bearing, because hosts serve SRT as `application/octet-stream` — so the real upstream MIME is never needed.

**Tap-to-seek plumbing (chapters + transcripts).** The detail view can't touch the audio element, so a store signal bridges: `store.requestSeek(t)` sets `seekReq: { t, n }` and a `<Player>` effect applies it. `play(episode, podcast, startSec?)` takes an optional start position (applied on `loadedmetadata`) so tapping a line/chapter for a **not-current** episode starts it there; when it IS current, `requestSeek` seeks in place.


## Show-page URL contract (`?podcast=<guid>`)

`selectedPodcast` is mirrored to the URL by two `useEffect`s in `components/home-page.tsx` — no Next.js routing. (`app/page.tsx` is a thin server component: `generateMetadata` for OG tags, rendering `<HomePage />`.) One reads `?podcast=<guid>` on mount and calls `resolvePodcastByGuid`; the other watches `selected?.podcastGuid` and writes/clears the param. Hydration re-checks `useApp.getState()` before `setSelected` so the StrictMode double-mount race can't overwrite a user click that landed during resolution.

**`history.replaceState`, not `pushState`.** Deliberate: the explicit "← back to results" button stays the only in-app exit from detail view. `pushState` would make browser-back a second exit and require a `popstate` listener to keep Zustand and the URL in sync. Bad guids fall back to browse silently via the PI breaker.

**Every page-level view is URL-restorable on refresh** — `?podcast=<guid>` (detail), **`?feed=<id>`** (detail fallback for shows with no `podcastGuid`, resolved via `/api/feed`), `?episode=<guid>`, **`?discussion=1`** (layered on podcast/feed + episode; needs `socialInteract` from `/api/feed`), and **`?publisher=<feedUrl>`** (reconstructs a minimal stub, so the back-button label reads "Publisher" on a cold restore). Live streams use `/stream/<naddr>`. All restores re-check `useApp.getState()` before `set` and gate on the PI breaker. Audio resume is NOT restored — only the view.

The **SHARE button** copies `origin + /?podcast=<guid>` with a 1.8 s "COPIED" flip. Clipboard-only by design — no Web Share API, no pod.link option (that's what the Nostr boost note links to via `podcastLandingUrl`). Header cluster order: `[♡ FAVORITE] [↗ SHARE] [⊙ SUPPORT] [≋ STREAM] [⚡ BOOST]`; STREAM (toggles the per-show `<StreamRate>` panel, via `useStreamPanel`) and BOOST are gated on `showHasValue`, SUPPORT on `podcast.funding`, the rest always visible.

**The URL is built by `showShareUrl` (`lib/util.ts`) and the button is `<CopyLinkButton>` (`components/copy-link-button.tsx`) — one of each, because there used to be two of each and they disagreed.** The episode list and the fullscreen player each had a private `ShareButton`: same 1.8 s flash, same `btn-ghost` + `<ShareIcon/>` chrome, but one built `new URL(origin + pathname)` and set a search param while the other interpolated `` `${origin}/?podcast=` ``. Those agree only on `/`, so the same show handed out two different links depending on which screen you pressed SHARE on — and neither copy cleared its timeout on unmount, which the fullscreen player does on every collapse.

**And the survivor of that merge was the wrong one.** `origin + pathname` was kept because it "survives the app being served from anywhere but the root", which sounds prudent and is answering a question nobody asked: the app is served from the root, and `?podcast=` is restored by exactly ONE thing — `<HomePage>`'s mount effect, which only runs on `/`. So on any other route the pathname half quietly wins and the show is dropped: `/npub/<npub>?podcast=…` opens a boost explorer, `/favorites?podcast=…` opens a favorites list. Nothing on the sharer's screen says so — the copy succeeds and the URL reads plausibly. It was reachable from the day `/npub` shipped, because `<FullscreenPlayer>` is mounted in `app/layout.tsx` and its SHARE button is live on every route; `/favorites` is what made it routine, being a page people sit on while music plays. `showShareUrl` now builds `new URL('/', origin)`.

**A show-level share and an episode-level share are different links, so where both are on screen they are different buttons.** `showShareUrl` takes an optional `episodeGuid` and adds `&episode=<itemGuid>`; the same `<HomePage>` mount effect that resolves `?podcast=` then loads that episode and opens it, so an episode link is a real deep link and not a show link with a suffix. A surface with one subject shares that subject — the show header a show, the episode page an episode. The **fullscreen player** presents both, and its `<ShareTargets>` renders both: `[↗ SHOW] [↗ EPISODE]`, or `[↗ ALBUM] [↗ TRACK]` on a music feed, sitting under the two hearts that already name their targets the same way. One button there has to pick, and either pick is wrong for someone — the show link loses the episode you were listening to, the episode link loses the way to hand somebody the show — and neither failure is visible from the sharing side, because the copy succeeds and the URL reads plausibly. `targetWord` moved from `fav-heart.tsx` to `lib/util.ts` for this: the hearts stopped being the only control that needs the noun, and the alternative was one component importing another for a string. The player's live-stream SHARE is a separate component rather than a branch inside this one — it renders only in the live-chat pane, where `liveStreamId` is the condition of the branch, so the podcast case inside it was unreachable code that read as a fallback.

**A surface showing one episode shares that episode, and there were three copies, not two.** `showShareUrl` takes an optional `episodeGuid` and adds `&episode=<itemGuid>`; the same `<HomePage>` mount effect that resolves `?podcast=` then loads that episode and opens it, so an episode link is a real deep link and not a show link with a suffix. Only the show header shares a bare show. The **fullscreen player** shared the show for whatever was playing, which is worse than coarse: the person receiving it lands on the show with no way to tell which episode was meant, and the sharer sees a URL that reads correctly. The **episode page** had the third private `ShareButton` — the one the merge above never counted — and it carried both faults that merge had already fixed: no `clearTimeout` on unmount, and a URL built from `window.location.pathname`. That last one was latent rather than live, since `<EpisodeDetailView>` renders only under `/`, which is exactly how a fixed bug comes back: the rule was written, the surface it applied to wasn't found. Count the surfaces before believing a widget has one implementation.

**URL building stays at the call site; only the copy interaction is shared.** The fullscreen player's is genuinely different — a Nostr live stream shares as the permanent per-host `/live/<npub>`, never the per-broadcast `/stream/<naddr>` (see the note on its own `buildUrl`) — so `<CopyLinkButton>` takes a finished string and renders nothing for `null`. `showShareUrl` lives in `lib/util.ts` rather than in either component because `fullscreen-player.tsx` importing from `lists.tsx` is the exact component-to-component edge that produced this repo's original module cycle.

**The show header is `relative sm:sticky` — deliberately NOT pinned on phones.** Sticky, it plus the app header held 282px of an 844px viewport and tracks scrolled under the album art, which read as three stacked layers fighting each other. It's worth the space on desktop (~156px of 900+, against a long tracklist) and isn't on a phone. The `top-[var(--app-header-h)]` offset **must stay `sm:`-prefixed**: `top` on a `relative` element offsets it instead of pinning it, so an unprefixed value shoves the header a header's-height down the page instead of doing nothing.

**The cluster is a `basis-full` SIBLING of the header's text column, not a child of it** — the header is `flex flex-wrap` so that row claims the full width at every breakpoint. Nested under the author line (where it lived) it was capped at the text column's width, which on a 390px screen is ~230px against five ~105px controls, so it stacked one-per-line into a ragged five-row column that made the sticky header ~330px tall. DOM nesting can't be responsive, so the alternatives were `flex-col sm:flex-row` (tidier, still ~350px pinned) or rendering the cluster twice behind `hidden sm:flex` (two `<FavHeart>` store subscriptions and two `ShareButton` timers for a visual concern) — hence the hoist. The four ghost buttons carry `btn-compact` (padding/gap only, height untouched, defined in `globals.css` **below** the `.btn*` family since source order is what breaks the specificity tie). Order above is unchanged and all five stay visible; don't collapse any into a menu. The episode detail page and the fullscreen player carry the same STREAM control — it's show-scoped everywhere, so all three edit one setting.


### What a deep link must NOT pay for

`?podcast=<guid>&episode=<guid>` is a cold start with two serial server round
trips in front of it — `/api/by-guid` to resolve the show, then `/api/feed` to
find the episode inside it — and until #241 the whole page was competing with
work it was going to throw away. Measured with Playwright against a stubbed API
(the probe is four lines of `page.route` plus a request log; the point is the
ORDER, which no amount of reading the source makes obvious):

```
before                                          after
  407ms  /api/nostr/index?path=/feed/live         314ms  /api/by-guid?guid=…
  422ms  /api/nostr/index?path=/feed/global       339ms  /api/feed?id=…
  423ms  /api/by-guid?guid=…                      395ms  /api/nostr/index?path=/feed/episode/…
  442ms  /api/feed?id=…
  457ms  /api/feed?id=…
```

Two separate faults, and each one is invisible from the screen.

**The home page's two relay-backed sections loaded first.** They render under
`{!inDetailView && …}`, and `inDetailView` is `!!selectedPodcast` — which a deep
link does not set until `resolvePodcastByGuid` has been to the server and back.
So the first commit mounted `<NostrLiveStreams>` and `<GlobalNostrFeed>`, whose
effects run BEFORE `<HomePage>`'s own, and unmounted them a moment later. Behind
an index that answers 503, or none at all, that is not two requests — it is the
full relay path (a kind:1 scan, a reply-tree BFS, the profile ladder, a PI
metadata batch) plus the bundle's signature verification, competing for sockets
and main-thread time with the page the visitor asked for. `entryResolved`
(`components/home-page.tsx`) gates them: false on the server and on the first
client render, so the markup stays deterministic and there is no hydration
mismatch, and set once the URL question is answered either way — including when
the restore FAILS, or a bad guid would cost the visitor the home page they were
dropped back onto. It is never cleared, so "← back to results" out of a
deep-linked show brings both sections up as it always did.

**And the feed was downloaded twice.** The restore puts the show in the store
before it loads the episode, so `<EpisodeList>` mounts in between and fires its
own `/api/feed?id=N` while `loadEpisodeFromFeed`'s is still in flight — 15 ms
apart, and neither the browser cache nor a CDN collapses two requests already
running. `/api/feed` now serves up to `PI_EPISODE_MAX` episodes with their show
notes, trimmed only at 3.5 MB, so this is megabytes twice on the connection the
visitor is waiting on. Both callers are wanted — `<EpisodeList>`'s handler is
what writes `episodeQueue`, which `<TransportControls>` computes prev/next from,
and it must still run even though the episode view replaces it — so `loadFeed`
(`lib/podcast-meta.ts`) coalesces them instead of one being deleted. It drops
the entry the moment the promise settles: a shared in-flight promise is only an
answer two callers are already waiting for, and keeping it would serve a stale
episode list to the next navigation and make the list's retry button re-deliver
the error it is retrying. It owns the URL too, for the reason `showShareUrl`
does — two call sites spelling one request differently is how a feed comes to be
fetched two ways, and here it would also defeat the coalescing silently.

**What is still on the critical path, and was not changed.** The two server
round trips are serial by data dependency (the feed id comes out of the first),
and `/api/feed`'s body is the whole feed. Trimming show notes from it is not
available without a second request per episode: `<EpisodeDetailView>` renders
whichever episode the list hands it, including the thousandth.

### Episode detail view

**Tabs.** Show notes / Chapters / Transcript / Boosts collapse into one tab strip (`components/episode-detail-view.tsx`), mirroring the fullscreen `EpisodeInfoPanel`. Only sections with content get a tab; the **Boosts** tab lazy-mounts `<EpisodeNostrFeed>` (no relay fetch until opened) inside a `min-h-[70vh]` so its short loading frame can't collapse the page and yank the scroll.

**Floating BOOST FAB.** A `fixed right-4 z-40 rounded-full` `⚡ BOOST`, shown when `hasValue`. **Hidden while the now-playing bar is up** (`hasValue && !playerVisible`) — the mini-player carries its own BOOST and the FAB (`z-40`) would just overlap the bar (`z-30`); boosting the viewed episode stays reachable via the inline `SHARE · SUPPORT · BOOST` cluster. Since it only renders with the bar hidden, its `bottom` is a fixed `calc(1.5rem + env(safe-area-inset-bottom))`.


## Artwork is proxied and resized (`/api/art`)

Podcast covers are authored as posters and rendered here as tiles. Measured
across 53 live feeds on 2026-08-25: **27.68 MB in total, 535 KB average, 230 KB
median, largest 8,090 KB** — for squares the app paints at 64 to 160 pixels.
Extrapolated to a 213-show favorites list that is over **100 MB** of artwork
pulled from nineteen unrelated hosts. Through the proxy the same 53 covers are
**0.62 MB, 12 KB average** — a 97.8% cut, and that list becomes about 2.5 MB.

`loading="lazy"` and `decoding="async"` were already in place and are not the
fix. They control *when* a cover is fetched; this controls *how big it is*.

**The raw third-party URLs stay in `artCandidates`, behind the proxied ones,
and that is what keeps this an accelerator rather than a dependency.**
`<PodcastCover>`'s `onError` ladder therefore falls all the way through to the
URL the app used before the proxy existed: a route that is undeployed,
rate-limited, out of memory, or handed something sharp cannot decode costs the
speed-up and nothing else. Drop that tail and one broken route blanks every
cover on the twelve surfaces this component renders on, several seconds after
they appeared, looking exactly like a CDN fault. Order it the other way round
and the feature is installed and inert. Both shapes are pinned by
`npm run check:art`.

**The width is an allowlist (`160|320|640|1024`), never a free integer.** Each
`(url, width)` pair is a CDN cache key whose miss costs a full decode and
resize of up to 12 MB, so an open parameter turns one cover into an unbounded
family of cold misses — an amplification lever aimed at our own compute that
looks like ordinary traffic the whole time. `artWidth` is the guard, and it is
a **digits-only** test on purpose: `Number('0x140')` is 320 and `Number('3e2')`
is 300, so a `Number()` guard accepts extra spellings of an allowed width and
buys a third cache key for bytes we already hold, while `parseInt('320abc')`
accepts unbounded junk. All three render correctly, which is why none of it
looks wrong.

**Do not add a redirect-to-origin fallback inside the route.** A 302 is a 200
to the browser's `onError`, so it would defeat the ladder above, teach the CDN
to cache a redirect, and hide from us that the proxy is failing at all.

**`Content-Type` is not the security boundary and must not be mistaken for
one** — a hostile feed controls that header as easily as it controls the bytes.
The real defences are `safeFetch` (every redirect hop re-validated, hostname
resolved), the 12 MB byte cap, `limitInputPixels`, and sharp's own magic-byte
validation. `artTypeVerdict` exists to refuse *documents*, above all
`image/svg+xml`, which can carry external references and scripts and has no
business reaching a rasteriser when an `<img>` will sandbox it. The strict
image-type list it replaced looked stricter and was worse: 2 of the 53 live
covers declare `application/octet-stream` or a malformed `image/*` and are
ordinary JPEGs, so it dropped them out of the optimisation silently — one of
them 670 KB — while still accepting `image/svg+xml`, because that string does
begin with `image/`.

The 12 MB cap is deliberately larger than `/api/og/boost.png`'s 2 MB. That
route can afford to skip an oversized cover; this one exists *because* covers
are oversized, and a 2 MB cap would refuse precisely the images with the most
to gain.

**The response needs `max-age` as well as `s-maxage`, and this is the route
where forgetting it costs most.** `s-maxage` binds shared caches only. A browser
handed a response with no `max-age`, no `ETag` and no `Last-Modified` has no
freshness lifetime to work from and nothing cheap to revalidate against, so it
re-downloads in full on every view. That turned the whole optimisation above
into a one-time win: the proxy took 53 covers from 27.68 MB to 0.62 MB, and then
the browser paid that 0.62 MB again on every navigation, because an `<img>`'s
only cache is the HTTP one — there is no client-side store behind this route the
way `/api/by-guid` has one. It shipped `s-maxage`-only for the life of the
feature. The private lifetime is deliberately **shorter** than the shared one
(a day against a week), which is the same argument `/api/feed`'s header makes:
a private cache under the shared one introduces no staleness class the CDN was
not already permitted, so a publisher who replaces a cover still reaches
everyone inside the window the week-long shared cache already allowed.

## Reduced motion

**The reader's OS-level "reduce motion" setting is honoured, and it takes two
mechanisms because one cannot reach everything.**

The CSS half is a `@media (prefers-reduced-motion: reduce)` block at the foot of
`app/globals.css`, written as a universal `!important` override rather than a
list of animated classes. Naming the classes is the version that rots: it covers
today's animations and silently misses the next `transition` somebody adds, and
a reduced-motion rule that covers most of the motion is not an accommodation,
it is a surprise. The durations go to near-zero rather than `animation: none` —
that difference is what keeps the skeletons visible, because running Tailwind's
`animate-pulse` instantly lands it on its final keyframe (opacity 1) while
`none` would drop it back to its pre-animation state. `animation-iteration-count:
1` is the line that actually stops the infinite ones; duration alone just makes
them flicker faster.

**Two motions are invisible to that block and are decided in JS instead**
(`prefersReducedMotion` / `scrollBehavior`, `lib/format.tsx`):

- **The boost confetti is a `<canvas>`,** which no CSS rule reaches. It is
  *skipped*, not shortened — 130 particles thrown across the viewport is the
  largest movement this app makes, it fires when the payment settles rather than
  when the reader tapped, and it cannot be dismissed. Nothing is lost: the
  modal's ✓ and `playBoostSound` already report the same success, and the
  dynamic import never happens.
- **An explicit `behavior: 'smooth'` beats the `scroll-behavior` property by
  spec**, so the two programmatic smooth scrolls have to ask. The transcript
  auto-follow is the one that matters — it re-fires on every line for the length
  of an episode, so under this setting it is not one animation to sit through,
  it is continuous drift for an hour.

`prefersReducedMotion()` is read at call time and never cached: it is a system
toggle, and someone turning it on mid-session is exactly the person it is for.
It answers `false` when the query is unavailable (SSR, an old browser) — the
other default would strip the app's feedback for everyone whose browser simply
cannot answer.

## Fonts and first paint

**Both families are self-hosted by `next/font` in `app/layout.tsx` and reached through `var(--font-display)` / `var(--font-mono)`. Never add an `@import` to `app/globals.css`.**

That is what shipped, on line 1 of the main stylesheet, and it is the worst available way to load a webfont. A CSS `@import` there **serializes** the critical path: the browser cannot discover the font until it has fetched and parsed the stylesheet that names it, so first paint waits on

```
HTML → globals.css → fonts.googleapis.com (CSS) → fonts.gstatic.com (files)
```

— four hops across **three origins**, each paying its own DNS lookup and TLS handshake, with no `<link rel="preconnect">` to soften any of it. Bricolage Grotesque is requested as a variable font across three weights, so the payload is not small either.

`next/font` fetches both families at build time and emits them as same-origin, cache-immutable assets referenced directly from the initial HTML. The two external origins disappear from the critical path entirely.

Three consequences worth knowing:

- **Naming a family literally anywhere bypasses the fallback.** `next/font` generates a size-adjusted local fallback face and that is what stops `display: swap` shifting layout when the real font lands. A literal `font-family: 'Bricolage Grotesque'` in Tailwind config or raw CSS resolves to the webfont without it.
- **Three places hold the wiring and they move together:** the two `next/font` calls in `app/layout.tsx` (whose `.variable` class names go on `<html>`), `fontFamily` in `tailwind.config.ts`, and the two raw `font-family` declarations in `globals.css` (the `html, body` mono default and `.headline`). Element classes like `.stamp`/`.btn`/`.input` go through the Tailwind `font-mono` alias and need no edit.
- **`axes: ['opsz']` on the display face is deliberate.** The old Google URL requested the optical-size axis (`opsz,wght@12..96`), and `next/font` ships only `wght` for a variable font unless the other axes are named. Dropping it would be a smaller download but a visible change to the display face.

**The hero image is the LCP element on every route** — `app/layout.tsx` renders `public/hero.jpg` `fill priority` in the *root* layout — and it sits under a `bg-ink/75` overlay that mutes it to a texture, so it renders at `quality={40}` rather than the default 75. Encoding detail the overlay then discards is the most expensive byte on the page. `next.config.mjs` also enables AVIF, which Next does **not** serve by default (`formats` defaults to webp-only, even when the browser's `Accept` header offers AVIF). Measured on a production server at w=1920: 118,462 bytes before, 24,565 after — a 79% cut, with non-AVIF browsers getting 74,306. If the overlay opacity is ever lowered, revisit the quality; the two are coupled.

**Benchmark image encoding against a real production server, not against sharp directly.** Encoding this image with sharp's own default AVIF options suggested AVIF was 47% *larger* than WebP at q=75 — the opposite of what Next actually ships, because Next drives the encoder with its own effort settings. A local sharp benchmark is not evidence about this pipeline, and acting on one here would have meant leaving a 79% saving on the table while documenting a coupling that does not exist.

## Theme system (light + dark)

**Tokens are role-based, not literal.** `ink` means "page bg", `bone` means "primary fg" — their *values* swap between modes, not their names. Tailwind reads each as `rgb(var(--token) / <alpha-value>)`; the values are CSS variables defined twice in `app/globals.css`:

- `:root` — dark default. `--ink: 10 10 8`, `--bone: 253 250 243`, `--bolt: 250 229 0`, `--nostr: 255 45 146`, `--muted: 138 133 122`, `--line: 31 29 24`, `color-scheme: dark`.
- `:root[data-theme='light']` — values flip: `--ink: 253 250 243`, `--bone: 10 10 8`. Brand colors deepen because the brand yellow/magenta on bone is invisible: `--bolt: 224 168 0` (vibrant amber-gold; the earlier `191 138 0` read as muddy mustard), `--nostr: 197 20 117`, `--muted: 110 105 95`, `--line: 225 220 207`, `color-scheme: light`.

So `bg-ink`, `text-bone`, `border-bone/40`, `bg-ink/75`, `bg-ink/90` all work in both modes with no per-component class changes.

**Single-token tradeoff for `bolt`.** `text-bolt` has ~30 callsites; `bg-bolt` is only `.btn-bolt` plus a couple of `bg-bolt/10` tints. One token serves both roles — light-mode `--bolt` is a vivid mid-amber recognizable as Lightning-yellow on the button AND visible as text on bone. Don't split it unless you're prepared to refactor every callsite.

**FOUC blocker** lives inline in `<head>` in `app/layout.tsx` — reads `bmb:theme` synchronously and sets `data-theme="light"` before paint, with `<html suppressHydrationWarning>`. **Don't move it to a `useEffect`** or light-mode users get a dark flash on every navigation.

**Toggle** is `components/theme-toggle.tsx`, slotted in the header. Only `'light'` is ever written (absent = dark). On toggle it also updates `<meta name="theme-color">` so iOS Safari's status-bar tint follows. `subscribeTheme()` exists (parallel to `subscribeNwc`/`subscribeSpark`) but is currently unused.

Don't introduce a token whose name implies a fixed color (avoid `dark-gray`); follow the role pattern.




## The maskable icon that wasn't

`public/manifest.json` declared `/icons/icon-512.png` twice — once as `purpose: "any"` and once as `purpose: "maskable"` — with the same, unpadded asset.

Those two purposes want different artwork. Android crops a maskable icon to a platform-chosen shape (circle, squircle, teardrop) and only guarantees the **inner 80%** — the "safe zone" — survives; art drawn to the edges gets its edges cut. Declaring an `any` icon as maskable therefore doesn't add support, it opts into having the icon clipped on every Android launcher, which is strictly worse than the fallback (Android shrinks a non-maskable icon inside a white plate instead).

So the declaration was **removed** rather than repaired, and has since been restored the only way it should be: `public/icons/icon-512-maskable.png` is a genuinely padded variant — the same logo at 66% scale on the `#0a0a08` background, its own file — and `purpose: "maskable"` points at *that*. **Don't point it back at the shared asset.**

The arithmetic behind the 66%: the bolt in `public/icon.svg` spans x 128–384 and y 96–416, so its half-diagonal from the centre is **204.9px**, against a safe-zone radius of 0.4 × 512 = **204.8px**. It sat exactly on the boundary, which is why the unpadded asset was unusable rather than merely risky. 66% puts the half-diagonal at 135px.

`scripts/make-maskable-icon.mjs` regenerates the file (it renders the SVG in Playwright's Chromium — Playwright is deliberately not a dependency; the script finds a global install). Run it if the logo changes, and commit the PNG. The same asset is the TWA's `maskableIconUrl`, so it is now what Android draws on the launcher for the Zapstore build too — see [`android.md`](android.md).

## Background art, the canvas-bg gotcha, and modal geometry

`app/layout.tsx` renders `public/hero.jpg` as a fixed full-viewport layer under a
`bg-ink/75` overlay, with `<Image fill priority />`. The overlay's opacity mutes
the image; in light mode `--ink` flips to cream so the same class becomes a 75%
bone wash automatically. The same image doubles as the OG image.

- **The page background is set in CSS (`app/globals.css`, on `html, body`), never
  as a Tailwind class on `<body>`.** A background applied to `<body>` in the JSX
  propagates to the canvas and paints over the fixed image layer regardless of
  z-index — the hero breaks with no errors, just a flat-color page. The CSS rule
  is safe because the hero layer is a *child* of `<body>` and so paints above
  body's own background box.
- **`html, body` use `overflow-x: clip`, NOT `hidden`.** `hidden` computes
  `overflow-y` to `auto`, turning html/body into a scroll container that traps
  `position: sticky` descendants (the page header scrolled away instead of
  pinning). `clip` blocks sideways scroll without creating a scroll container.
  Do not switch it back.

### Modals

Every modal renders through `<ModalShell>` (`components/modal-shell.tsx`) — it
owns the portal, `role="dialog"`/`aria-modal`/`aria-labelledby`, Escape, the focus
trap and focus restore, the shared scroll lock, and the geometry below. Six
hand-rolled copies had already drifted into two z-indexes, two backdrop
opacities, two centring idioms and `pb-28` on four of six, and none of them had
dialog semantics or a focus trap at all. Pass `dismissable={false}` while a
payment is in flight — Escape and backdrop-click must not take the per-leg
results off screen while legs are still settling.

- **Modals must portal to `document.body` — the layout traps `fixed` overlays.**
  `app/layout.tsx` wraps page content in `<div className="relative z-0">` (to sit
  above the fixed hero), and `<Player>` is a body-level **sibling** at `z-30`.
  `relative z-0` creates a **stacking context**, so a `fixed` modal inside page
  content is sealed in it — its `z-40`/`z-[60]` only competes *within* the wrapper
  and can never rise above the mini-player (symptom: the player bar paints over
  the modal footer). Every overlay `createPortal`s to `document.body`, guarded by
  a mounted `portalTarget` state so SSR renders nothing. The `BoostModal` opened
  *from* `<Player>` happened to work pre-portal because it shared the player's
  body-level context. Modals also add `pb-28` so the centered card clears the
  mini-player bar.
- **An overlay is `fixed inset-x-0 top-0 h-[100dvh]`, never `fixed inset-0`, and
  its card caps at `max-h-full`, never `max-h-[92vh]`.** Two bugs stack in the
  obvious version. `inset-0` sizes to iOS Safari's **large** (toolbar-hidden)
  viewport, so the box is taller than what you can see. And `92vh` is measured
  against the viewport while the card lives inside the overlay's `p-4 pb-28`, so
  it is up to 60px taller than the box meant to hold it *before* iOS is involved:
  measured at 390×844 in desktop Chrome, the card ran `-14 → 762` inside a
  `16 → 732` padding box. Centering then splits the overflow and pushes the header
  off the top, which reads as "the modal is cut off" with the body visible and the
  title gone. `max-h-full` resolves against the overlay's content box, so it
  spends exactly what the padding leaves and needs no edit if the padding changes.
  Applies to all six overlays (`boost-modal`, `boost-all-modal`, `wallet-modal`,
  `sign-in-modal`, `profile-editor`, note-card `ZapDialog`).

