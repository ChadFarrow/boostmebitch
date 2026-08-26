# Value Playback Events on Nostr

This spec lives at its own canonical, app-neutral home — not inside either
participating app's repo, so there's one copy to link to instead of several
that can silently drift apart:

**→ [github.com/ChadFarrow/PC20-Nostr/nip-value-playback-events.md](https://github.com/ChadFarrow/PC20-Nostr/blob/main/nip-value-playback-events.md)**

Three kinds — **3369** (a receipt for one interval, regular), **23369** (a live
ticker, ephemeral) and **33369** (running totals, addressable). All three
reference content with NIP-73 `i`/`k` tags, so one `#i` filter finds every event
for a feed, an episode or a track regardless of which kind produced it.

**This app emits `3369` and `33369`.** The ephemeral ticker `23369` is
specified and not implemented; nothing here publishes or reads it.
`npm run probe:kinds` covers all three, so the relay answer is on hand if it is
added later.

## What this app publishes, and what it deliberately doesn't

`3369` is emitted for **streaming settles only** — the unattended `action:
'auto'` payments in `lib/v4v/streaming.ts`. A boost the user pressed keeps its
kind:1 note (`lib/nostr/boost-notes.ts`) or, on a live stream, its NIP-57 zap
receipt, and gets no 3369.

That split is the whole reason this feature is allowed to exist. `CLAUDE.md`
states that streaming publishes nothing to Nostr, because the only vehicle
available was a kind:1 and a note per ten-minute settle would bury the user's
own feed under machine output. A 3369 is queryable by any client and rendered by
none, so the prohibition on kind:1 is unchanged and this sits beside it rather
than replacing it. **Do not "improve" the receipt into a note.**

Implemented in `lib/nostr/value-playback.ts` (templates + publish + the summary
debounce), `lib/nostr/value-playback-summary.ts` (the arithmetic and the publish
predicate, import-free so `check:vpsummary` pins the real thing) and
`lib/v4v/streaming.ts` (`maybePublishReceipt`, `maybeQueueSummaries`, and
`paymentIds`, which is the single source of the identifiers both the boostagram
and the receipt carry). Opt-ins are `bmb:stream_receipts` and
`bmb:stream_summaries`, both default **off**; the control is `<StreamReceipts>`
in `components/streaming-settings.tsx`.

## Why a summary is derived and not accumulated

**This is the rule the whole 33369 implementation hangs off, and the obvious
design is the broken one.** A 33369 is ADDRESSABLE: one event per
`(pubkey, kind, d)`. Two people never collide — different pubkey, different
address — but a person signed into two apps on one key has **two writers at one
address**. An app that keeps a running total and adds to it has built a number
nobody else can reproduce, which is exactly why the other app's next publish
destroys it, silently, on someone else's device.

Deriving fixes it structurally rather than by coordination: both apps read the
same receipts, compute the same `amount` and `count`, and the second finds
nothing to say. The collision stops existing.

Kind `10333` solves its version with a read-merge-union, which works because
favorites are set members. Totals are not — merging two numbers whose overlap is
unknown double-counts — so the answer here is not to merge two results but to
make both writers compute the same one.

Three rules ride on that, and **not one of them can fail on a single device**:

- **Monotonic.** `amount` and `count` never decrease at an address. A writer
  deriving less has an incomplete relay view, not a smaller truth — relays lose
  events, a query hits a narrower set, a page truncates — and payments do not
  un-happen. The guard is `>=` on **both** fields rather than `!==` on either:
  an amount that grew while the count shrank is a partial read that happened to
  include one large receipt, and publishing it would lower `count`, which is the
  field a consumer uses to tell that a summary is behind.
- **Changed by VALUE, never by bytes.** `alt` is free text that two
  implementations will not word identically, and `first`/`last` are optional so
  one writer emits them and another does not. Under a byte comparison each app
  sees a "changed" event, rewrites it, and hands the other the same trigger —
  two devices rewriting one address forever, every publish locally reasonable,
  the only symptom being that it never stops.
- **Never publish on a read you cannot trust — and for a SUM that is a stricter
  question than the usual one.** `readIsTrustworthy` short-circuits on
  `eventInHand`, which is right for *may I believe this absence* and wrong here:
  one receipt arriving out of eighty-four is an event in hand and a badly
  incomplete total. `collectEventsDetailed` therefore calls the same pinned
  predicate with `eventInHand: false` forced, reducing it to "did every relay I
  reached actually answer". Reuse the function, decline the shortcut.

The stored summary is read too, and a degraded read of *that* also refuses:
without it there is nothing to enforce monotonicity against, so publishing would
be a blind write over a number that may be larger.

`receiptMatchesId` re-checks every event even though the `#i` filter already
narrowed it at the relay. A filter is how you ask, not proof of what you got,
and an over-answering relay here does not produce a visibly wrong event — it
produces a total that is quietly too big.

## Relay acceptance

`3369`, `23369` and `33369` sit in valid NIP-01 ranges (`1000 <= n < 10000`
regular, `20000 <= n < 30000` ephemeral, `30000 <= n < 40000` addressable) and
none of the three appears in the NIPs event-kind table, so there is no
collision. **Neither fact says a relay will take one.** Most general-purpose
relays store any regular kind, but this app's defaults are not all
general-purpose — `relay.fountain.fm` is an app's own relay — and a kind
allowlist or a rate limit is invisible until you write to one.

`npm run probe:kinds` is the measurement. It signs with a key it generates,
writes each kind to each relay individually, and **reads each back**, which is
the half that matters: a relay can answer `OK true` and store nothing, and a
publisher trusting the OK then believes it has a durable record it does not
have. That verdict is reported as `accepted-not-stored` and is the dangerous
one.

For `23369` an empty read is the **correct** result — ephemeral events are
forwarded and not stored — so the probe reports that as `usable (ephemeral)`
rather than as a failure. Collapsing the two would mark every properly behaving
relay as broken in a table someone later trusts.

### Measured results

> Not yet measured. Run `npm run probe:kinds` on a machine with outbound
> WebSocket access and paste the summary block here. The container this was
> developed in blocks the relay hosts at its proxy, so the table below is empty
> on purpose rather than guessed at — a plausible invented row is worse than no
> row.

| Relay | 3369 | 23369 | 33369 |
| --- | --- | --- | --- |
| relay.damus.io | | | |
| relay.primal.net | | | |
| nos.lol | | | |
| relay.fountain.fm | | | |

`npm run probe:kinds -- --read <npub>` also cross-checks a published summary
against the receipts it claims to sum, which is the check worth running after a
real listen. A summary **ahead** of what that read can see is expected and fine
— totals are monotonic and the writer may have seen more receipts than the probe
does. A summary **behind** the receipts means the writer under-derived, and
monotonicity has now pinned it there.

## Volume

Receipts are per settle, not per minute. `STREAM_SETTLE_INTERVAL_MS` is ten
minutes, so a continuous listen produces about six an hour — but that is the
floor, not the shape to plan for. A music show accrues into a bucket per
`<podcast:valueTimeSplit>` track and each settles against its own value block,
and a **live Split Kit show force-settles at every block change**, which is once
per song. The per-track case is what will meet a rate limit first, not the
timer.

Read the linked doc, not this stub, for the tag vocabulary and the rules.
