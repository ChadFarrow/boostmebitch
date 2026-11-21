# IRC Live Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ZeroNode IRC chat panel, styled like `<LiveChat>`, beside the `<podcast:liveItem>` stream of 12 opted-in shows, reached through a WebSocket gateway on Chad's box.

**Architecture:** A pure, import-free IRC leaf (`lib/irc/protocol.ts`: line codec + session reducer) and show list (`lib/irc/shows.ts`), pinned by `check:irc`. A thin browser WebSocket wrapper (`lib/irc/client.ts`) feeds the reducer. `<IrcChat>` renders it in the fullscreen player's RSS-live pane under CHAT · PLAYED · ABOUT tabs. The gateway (thelounge-candr) is NOT built here; `NEXT_PUBLIC_IRC_GATEWAY_URL` unset keeps every site exactly as today.

**Tech Stack:** Next.js App Router, React, TypeScript strict, Tailwind tokens in `tailwind.config.ts`, `node --experimental-strip-types` check scripts, CDP e2e (`scripts/cdp.mjs`), `ws` (already a dependency) for the fake IRC server.

**Spec:** `docs/superpowers/specs/2026-11-21-irc-live-chat-design.md` (approved by Chad 2026-11-21). Read it before Task 1.

## Global Constraints

- Work in `~/Vibe/.worktrees/boostmebitch/irc-chat` on `feat/irc-chat`. Never touch `~/Vibe/boostmebitch` (it is on `ios-capacitor-shell`) and never change `~/Vibe/thelounge-candr`.
- Read before editing, per `CLAUDE.md`'s table: `docs/ui.md` (player, tabs), `docs/storage.md` (new `bmb:*` key), `docs/security.md` (`looksLikeSecretKey`), `docs/nostr.md` (only to mirror `live-chat.tsx`).
- The show list, exactly (lowercase guid → channel): `ac746d09-7c3b-5bcd-b28a-f12d6456ca8f` `#HomegrownHits`; `917393e3-1b1e-5cef-ace4-edaa54e1f810` `#Podcasting20`; `e0ac9365-689c-5043-8804-15b9dfcc545a` `#greenroom`; `31740861-81e8-5dda-8801-a2abb2634271` `#MMO`; `7c6f7875-2b73-491e-b32c-e2c8d6e91d53` `#candr`; `d5e73072-64a2-56a3-9dcd-4a00bfe561d5` `#SirLibre`; `c1959795-28f1-502d-ad3e-70abf5a034a9` `#v4vmusicShow`; `45b899bb-cbef-57b5-ab14-04aaf49e3ac3` `#VoidZero`; `c42a0900-c20e-59a2-a13b-c23b5c04e11f` `#HyperSpaceOut`; `2d418249-453a-5714-8abc-5b657570b641` `#BowlAfterBowl`; `41aace28-8679-5ef1-9958-75cf76c2b5f0` `#DoerfelVerse`; `89bf141a-f4cf-575c-b09a-75dbce16332c` `#OffTopic`.
- Env: `NEXT_PUBLIC_IRC_GATEWAY_URL`. Unset/invalid → no chat anywhere. Valid = `wss://…`, or `ws://` only to `127.0.0.1`/`localhost` (the e2e).
- Outgoing text: every CR, LF and NUL becomes a space before a line is built; each `PRIVMSG` text chunk ≤ 400 UTF-8 bytes, split on a code-point boundary (prefer the last space).
- Incoming: drop any line over 8191 bytes; render IRC text as text (React), links only through `<LinkedText>` (`httpUrl`); strip mIRC formatting.
- Panel: at most 200 lines in memory; composer max 500 characters; commands `/me` and `/nick` only; join/part/quit lines not shown; no automatic reconnect; no REPORT, HIDE or word filter; no chat line in storage.
- The nick box and the composer refuse an `nsec`: any whitespace-separated token for which `looksLikeSecretKey(token)` is true; a rendered refusal, nothing sent.
- Copy (exact): privacy line `IRC is public: the channel can keep a log of what you write, and ZeroNode sees your IP address.`; after join with no lines `You joined <channel>. IRC keeps no history, so messages show from here on.`; nsec refusal `That looks like a Nostr secret key (nsec). It was not sent.`; unknown command `Only /me and /nick work here.`
- Nick storage: `bmb:irc_nick:<npub>` (`:guest` signed out), per-npub like `bmb:sender_name:*` and for the same reason.
- No brand word in new UI copy (`CLAUDE.md` "Names"); both brands show the chat.
- Tests never reach `irc.zeronode.net`: a local fake server only.
- `CLAUDE.md` has 112 words of budget (`npm run check:claudemd`); new rows must fit.
- Before shipping: `npm run typecheck && npm run lint && npm run check && npm run build` (stop `dev` first; `rm -rf .next` before `dev` again).

## Review Focus

1. A multi-line paste into the composer → only `PRIVMSG` lines leave, never a raw command (Task 2 vector; Task 5 e2e paste).
2. A `javascript:` link in a channel message → rendered as text, only `https:` becomes an `<a>` (Task 5).
3. A flood of 250 lines → 200 rows in the DOM, the newest kept (Task 5).
4. The gateway drops the socket mid-show → one close, a JOIN button, no new socket on its own (Task 4 Node test; Task 5).
5. Nick in use at join → the listener picks another on the SAME socket (Task 2 vector; Task 4 Node test).

---

### Task 0: Worktree ready

- [ ] **Step 1:** `df -h /` — stop and tell Chad if under 10 GB free (`global.md`, "Stop what you start").
- [ ] **Step 2:** `cd ~/Vibe/.worktrees/boostmebitch/irc-chat && git fetch && git rebase origin/main` (spec commit only, so no conflict), then `npm ci` and `ln -s ~/Vibe/boostmebitch/.env.local .env.local`.
- [ ] **Step 3:** `npm run typecheck && npm run check:claudemd` → both pass before any change.

### Task 1: IRC line codec + `check:irc`

**Files:**
- Create: `lib/irc/protocol.ts`, `scripts/check-irc.mjs`, `docs/irc.md`
- Modify: `package.json` (`"check:irc": "node --experimental-strip-types scripts/check-irc.mjs"`), `CLAUDE.md` (a `docs/irc.md` row in "Read before you edit" for `lib/irc/`, `components/irc-chat.tsx`; a `check:irc` row: pins `lib/irc/protocol.ts`, `lib/irc/shows.ts` — cost: "typed text becomes a second IRC command")

**Interfaces — Produces (all in `lib/irc/protocol.ts`, no imports):**
- `interface IrcLine { tags: Record<string, string>; prefix: string | null; nick: string | null; command: string; params: string[] }`
- `parseLine(raw: string): IrcLine | null` — `null` for empty or over 8191 bytes; command upper-cased; trailing `:` param kept whole.
- `stripFormatting(text: string): string`
- `ctcpAction(text: string): string | null` — inner text of `\x01ACTION …\x01`, else `null`.
- `cleanOutgoing(text: string): string`
- `splitText(text: string, maxBytes = 400): string[]`
- `buildPrivmsg(target: string, text: string): string[]`, `buildAction(target: string, text: string): string[]` (no CRLF on the returned lines)
- `isValidNick(nick: string): boolean` — 1–30 chars, first `[A-Za-z\[\]\\`_^{|}]`, rest also `0-9` and `-`.

- [ ] **Step 1: Write `scripts/check-irc.mjs`** in the shape of `scripts/check-demu.mjs` (header comment: the failure, the `naive()`, fixtures from the wire; `replayVectors`; `importFreeProblems('lib/irc/protocol.ts')`). `naive` = `raw.split(' ')` parsing and `` `PRIVMSG ${t} :${text}` `` building. Vectors (`{ label, kind, args, expect, alsoNaive? }`, invoke returns `JSON.stringify`):
  - `build`: `buildPrivmsg('#candr', 'hi\r\nJOIN #evil')` → `['PRIVMSG #candr :hi  JOIN #evil']`
  - `build`: `buildPrivmsg('#candr', 'hello')` → `['PRIVMSG #candr :hello']`, `alsoNaive`
  - `build`: a 900-byte ASCII text with spaces → 3 lines, each text ≤ 400 bytes, rejoined equals input
  - `build`: 150 × `'é🎸'` → every chunk valid UTF-8 (`Buffer.from(s).toString() === s`), ≤ 400 bytes
  - `parse`: `':dude!u@h PRIVMSG #candr :hi there'` → `{ nick:'dude', command:'PRIVMSG', params:['#candr','hi there'] }`
  - `parse`: `'@time=2026-11-21T20:00:00.000Z :sparrow.zeronode.net 001 bmb :Welcome'` → tags.time set, nick `null` (server prefix, no `!`)
  - `parse`: `'PING :sparrow.zeronode.net'` → `{ prefix:null, command:'PING', params:['sparrow.zeronode.net'] }`
  - `strip`: `'\x0304,01red\x03 \x02bold\x02 \x1Dit\x1D'` → `'red bold it'`
  - `action`: `'\x01ACTION waves\x01'` → `'waves'`; `'\x01VERSION\x01'` → `null`
  - nick rule, with `ok/fail` (no naive): `candr_fan` true; `9lives`, `has space`, `""` and a 31-character nick false
- [ ] **Step 2:** `npm run check:irc` → FAIL (module missing).
- [ ] **Step 3:** Implement `lib/irc/protocol.ts` (signatures above). Write `docs/irc.md` with a first section "Why a gateway, and what it may never do" from the spec (WEBIRC, origin allowlist, ZeroNode only, CR/LF).
- [ ] **Step 4:** `npm run check:irc && npm run check:claudemd && npm run typecheck` → all pass; every non-`alsoNaive` vector "proved".
- [ ] **Step 5:** Commit `feat(irc): IRC line codec, pinned by check:irc`.

### Task 2: Session reducer

**Files:** Modify `lib/irc/protocol.ts`, `scripts/check-irc.mjs`.

**Interfaces — Produces:**
- `type IrcPhase = 'registering' | 'joined' | 'parted' | 'closed'`
- `interface IrcState { phase: IrcPhase; nick: string; channel: string }`
- `type IrcEvent = { type: 'joined'; channel: string; nick: string } | { type: 'message'; from: string; text: string; action: boolean; self: boolean; time: number } | { type: 'nickInUse'; nick: string } | { type: 'nickChanged'; to: string } | { type: 'kicked'; by: string; reason: string } | { type: 'error'; text: string }`
- `interface IrcStepResult { state: IrcState; out: string[]; events: IrcEvent[] }`
- `ircStart(nick: string, channel: string): IrcStepResult` — out `['NICK <nick>', 'USER webchat 0 * :webchat']`
- `ircStep(state: IrcState, raw: string, nowSec: number): IrcStepResult`
- `ircSend(state: IrcState, text: string, nowSec: number): IrcStepResult` — plain text → `buildPrivmsg` + a `self: true` message event per chunk; `/me x` → `buildAction`; `/nick x` → `NICK x` if `isValidNick`, else error event; any other `/…` → error `Only /me and /nick work here.`
- `ircNick(state: IrcState, nick: string): IrcStepResult` — `NICK <nick>` (for a retry after `433`)
- `ircRejoin(state: IrcState): IrcStepResult` — `JOIN <channel>` (after a kick)

- [ ] **Step 1: Add session vectors** (`kind: 'session'`, args = a list of server lines fed after `ircStart('bmbfan','#candr')`; expect = concatenated `out` and `events`). `naiveStep` compares channels case-sensitively, ignores `PING`, treats any `KICK` as self and shows every `PRIVMSG`. Vectors:
  - `PING :x` → out `PONG :x`
  - `:s 001 bmbfan :Welcome` → out `JOIN #candr`; then `:bmbfan!u@h JOIN #candr` → event joined
  - `:dude!u@h PRIVMSG #CandR :yo` → message `{ from:'dude', text:'yo', action:false, self:false }`
  - `:dude!u@h PRIVMSG bmbfan :psst` → no event (private messages are a non-goal)
  - `:s 433 * bmbfan :Nickname is already in use` → event nickInUse; then `ircNick(state,'bmbfan2')` → out `NICK bmbfan2`; then `001` → `JOIN #candr` (same session, no reconnect)
  - `:op!u@h KICK #candr dude :bye` → no event; `:op!u@h KICK #candr bmbfan :spam` → kicked, phase `parted`; `ircRejoin` → `JOIN #candr`
  - `:s 474 bmbfan #candr :Cannot join channel (+b)` → error `Cannot join channel (+b)`
  - `ERROR :Closing link` → error, phase `closed`
  - `@time=2026-11-21T20:00:00.000Z :dude!u@h PRIVMSG #candr :t` → `time: 1795291200`
  - `ircSend` of `'a\nb'` → exactly one line `PRIVMSG #candr :a b` (Review Focus 1); `'/join #evil'` → no out, the error copy
- [ ] **Step 2:** `npm run check:irc` → the new vectors FAIL.
- [ ] **Step 3:** Implement the reducer (pure; no timers, no I/O).
- [ ] **Step 4:** `npm run check:irc && npm run typecheck` → pass.
- [ ] **Step 5:** Commit `feat(irc): the IRC session as a pure reducer`.

### Task 3: Show list, gateway switch, nick storage

**Files:** Create `lib/irc/shows.ts`. Modify `scripts/check-irc.mjs`, `lib/storage.ts`, `docs/storage.md`.

**Interfaces — Produces:**
- `IRC_CHAT_SHOWS: Readonly<Record<string, { title: string; channel: string }>>` (the Global Constraints table)
- `ircChannelFor(podcastGuid: string | null | undefined): string | null` (case-insensitive)
- `ircGatewayOk(url: string | null | undefined): boolean` (the Global Constraints rule)
- `storage.ircNick.get(npub: string | null | undefined): string | null`, `storage.ircNick.set(npub, v: string): boolean` via `identityKey(KEYS.ircNickPrefix, npub)`, `KEYS.ircNickPrefix = 'bmb:irc_nick'`

- [ ] **Step 1: Add to `check-irc.mjs`:** each of the 12 guids → its exact channel; an upper-cased guid works; Nick the Rat Radio `23cd2e78-6042-5834-9ca8-34feca4d02b9` → `null`; `undefined` → `null`; every channel matches `/^#[^\s,\x07]{1,49}$/`; `ircGatewayOk`: `'wss://irc-ws.candr.space/webirc/websocket/'` true, `''` false, `undefined` false, `'ws://irc-ws.candr.space/'` false, `'ws://127.0.0.1:6790/'` true, `'https://x'` false; `importFreeProblems('lib/irc/shows.ts')` empty.
- [ ] **Step 2:** `npm run check:irc` → FAIL.
- [ ] **Step 3:** Implement `shows.ts`, the storage accessor (doc comment: per-npub for the `sender_name` reason), and a `docs/storage.md` row for `bmb:irc_nick:*`.
- [ ] **Step 4:** `npm run check:irc && npm run typecheck && npm run lint` → pass.
- [ ] **Step 5:** Commit `feat(irc): the opt-in show list and the gateway switch`.

### Task 4: Browser client + fake IRC server

**Files:** Create `lib/irc/client.ts`, `scripts/irc-fake-server.mjs`, `scripts/e2e-irc.mjs` (Node half). Modify `package.json` (`"e2e:irc": "node --experimental-strip-types scripts/e2e-irc.mjs"`).

**Interfaces:**
- Consumes: Task 2's `ircStart/ircStep/ircSend/ircNick/ircRejoin`, Task 3's `ircGatewayOk`.
- Produces (`lib/irc/client.ts`, browser-only):
  - `IRC_GATEWAY_URL: string` = `process.env.NEXT_PUBLIC_IRC_GATEWAY_URL ?? ''` (literal access, so Next inlines it)
  - `interface IrcSession { send(text: string): void; nick(n: string): void; rejoin(): void; quit(): void }`
  - `openIrcSession(o: { url: string; nick: string; channel: string; onEvent(e: IrcEvent): void; onClose(reason: string): void }): IrcSession` — one `WebSocket`; split frames on `\r?\n`; each `out` line sent as one frame; `quit()` sends `QUIT :bye` then `close(1000)`; `onClose` fires once; never opens a second socket.
- Produces (`scripts/irc-fake-server.mjs`): `createIrcFake({ port }): Promise<{ url, port, received: string[], origins: string[], connections: number, say(from, channel, text), sayRaw(line), kick(nick, reason), dropAll(), close() }>` — `ws` server; answers `NICK`/`USER` with `001` (or `433` when the nick is in `taken`), echoes `JOIN`, relays `PRIVMSG` to the other clients, answers `PING`.

- [ ] **Step 1: Write the Node half of `e2e-irc.mjs`** (`register('./e2e-resolve-hook.mjs', import.meta.url)`; `checker()` from `cdp.mjs`): against `createIrcFake`, assert in order — join registers `NICK`, `USER`, `JOIN #candr`; `say` arrives as a message event; `send('hi\nJOIN #x')` reaches the fake as exactly `PRIVMSG #candr :hi JOIN #x`; a taken nick gives `nickInUse`, `nick('other')` joins with `connections === 1`; `kick` → `kicked`, `rejoin()` → `JOIN #candr`; `dropAll()` → `onClose` once and `connections` unchanged 3 s later (Review Focus 4, 5); `quit()` → fake received `QUIT :bye`.
- [ ] **Step 2:** `npm run e2e:irc` → FAIL (client missing).
- [ ] **Step 3:** Implement `client.ts` and `irc-fake-server.mjs`.
- [ ] **Step 4:** `npm run e2e:irc && npm run typecheck && npm run lint` → pass.
- [ ] **Step 5:** Commit `feat(irc): a WebSocket IRC client and a local fake server`.

### Task 5: `<IrcChat>` in the player

**Files:** Create `components/irc-chat.tsx`. Modify `components/fullscreen-player.tsx` (around `liveStreamId` ~806, the scroll row ~1072, the cover ~1213, the RSS pane's BOOST row and its scroll body ~1620), `scripts/e2e-irc.mjs` (browser half), `docs/irc.md`, `docs/ui.md` (one paragraph: the tabs, the phone cover cap).

**Interfaces:**
- Consumes: Task 4's `openIrcSession`, `IRC_GATEWAY_URL`; Task 3's `ircChannelFor`, `ircGatewayOk`, `storage.ircNick`; `looksLikeSecretKey` (`lib/nostr/npub-input.ts`); `LinkedText`, `UnderlineTabs`, `tabPanelProps`, `fmtClock`.
- Produces: `IrcChat({ channel, onJoined }: { channel: string; onJoined?: () => void })`, marked `data-irc-chat`; its message list `data-irc-list`; nick box `data-irc-nick`; composer `data-irc-input`.

- [ ] **Step 1: Write the browser half of `e2e-irc.mjs`** (pattern: `scripts/e2e-lockscreen-buttons.mjs` — `Fetch` fixtures for `/api/*` and `/api/e2e-audio.wav`; usage line: `NEXT_PUBLIC_IRC_GATEWAY_URL=ws://127.0.0.1:6790/ npm run dev`, then `npm run e2e:irc`). Fixture `/api/live-shows`: one live item of Chad and Reeds (`podcastGuid` `7c6f7875-…`) and one of an unlisted guid. Assert:
  - unlisted show's player has no `data-irc-chat`; listed show's has tabs CHAT · PLAYED · ABOUT with CHAT active, the privacy line, and the nick box
  - nick `nsec1…` → refusal copy, fake `connections === 0`
  - JOIN → fake got `JOIN #candr`, `origins[0]` is the app origin, the history copy shows; `say` → a row with nick and text
  - composer paste of `'a\nb'` (`Input.insertText`) → fake got `PRIVMSG #candr :a b` only (Review Focus 1); a message containing an `nsec1…` token → refusal, nothing sent
  - `say` of `javascript:alert(1) https://example.com` → one `<a>`, `href` `https://example.com/` (Review Focus 2)
  - 250 `say` lines → 200 rows, the last text present (Review Focus 3)
  - PLAYED then CHAT → no `QUIT`, rows kept; `/api/live-status` answers ended → panel stays
  - `dropAll()` → a JOIN button, no new connection in 3 s (Review Focus 4)
  - playing the other episode → fake got `QUIT :bye`
  - CDP `Emulation.setDeviceMetricsOverride` 390×844 `mobile: true`: `data-irc-list` height ≥ 240 px, `scrollWidth === clientWidth`, JOIN, Send and each tab ≥ 24×24
- [ ] **Step 2:** start `dev` as above; `npm run e2e:irc` → browser half FAILS.
- [ ] **Step 3: Implement `components/irc-chat.tsx`** — `<LiveChat>`'s layout and classes (label row, `overscroll-contain` list with the 80 px stick-to-bottom rule, composer row with `btn-bolt` Send); rows = nick (`text-xs font-display text-bolt`), `fmtClock(time)`, `<LinkedText>`; an action row reads `* nick text`; states idle → connecting → joined → closed (server text + JOIN); quit on unmount and on `pagehide` that is not `persisted`; `storage.ircNick.set` on JOIN.
- [ ] **Step 4: Wire the player** — `const ircChannel = ircGatewayOk(IRC_GATEWAY_URL) && !liveStreamId ? ircChannelFor(podcast.podcastGuid) : null`; `showIrc = !!ircChannel && (isLive || joinedKey === epKey(episode))` where `onJoined` sets `joinedKey`. When `showIrc`: scroll row takes the Nostr branch's `overflow-hidden sm:overflow-y-auto`; the pane is `flex-1 min-h-0` below `sm:`; the scroll body becomes `<UnderlineTabs>` over a `flex-1 min-h-0` body; CHAT keeps `<IrcChat>` mounted (hidden via `hidden`), PLAYED = `<LivePlayedTracks>`, ABOUT = `<EpisodeInfoPanel>`, an empty tab left out; below `sm:` only, the cover caps at `max-w-[12.5rem]` (the Nostr video's height at 390 px) and BOOST drops `basis-full` to share the transport row. Nothing changes when `showIrc` is false.
- [ ] **Step 5:** `npm run e2e:irc` → both halves pass; `npm run typecheck && npm run lint` → pass. Stop `dev` by port (`lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill`).
- [ ] **Step 6:** Commit `feat(irc): IRC chat beside an opted-in RSS live stream`.

### Task 6: Ship

**Files:** Modify `docs/testing.md` (an `e2e:irc` row), `docs/irc.md` (final: the tab mount rule, the latch, no reconnect, the 3-per-address note).

- [ ] **Step 1:** `npm run typecheck && npm run lint && npm run check && npm run build` → all pass (`check:conformance` is reported only). `rm -rf .next` after.
- [ ] **Step 2:** Push; `gh pr create` with the spec link, what the browser test verified, and the gaps: "the real gateway (not built yet, thelounge-candr)", "real ZeroNode (tests never connect)", "phone keyboard (needs Chad's iPhone 11 and Pixel 6)", "the iOS app's Origin (needs the gateway)".
- [ ] **Step 3:** `gh pr checks <n> --watch`; then merge per rule 7: `gh pr merge <n> --squash --match-head-commit <headRefOid>`. Safe: with the env var unset nothing renders.
- [ ] **Step 4:** Roadmap Done line (full PR URL) in `~/Vibe/project-notes/roadmaps/boostmebitch.md`; To do lines in `~/Vibe/project-notes/notes/todo/boostmebitch.md` per `notes/TODO.md` (group word, place word): set `NEXT_PUBLIC_IRC_GATEWAY_URL` on both Vercel projects once the gateway answers; a `#candr` test with an agent on boostmebitch.com; the phone keyboard in the chat on the iPhone 11 and the Pixel 6; tell the 11 other shows' hosts. Pull, commit, push `main`.
- [ ] **Step 5:** Give the dispatcher the thelounge-candr task: the spec section "The design — thelounge-candr", verbatim, plus the merged PR URL.
- [ ] **Step 6:** Clean up: `git worktree remove`, `git branch -D feat/irc-chat` after `gh pr view <n> --json state,headRefOid` shows `MERGED` at the local tip; run the leftover `ps` check; `node ~/Vibe/vibe-kit/vibe.mjs`.
