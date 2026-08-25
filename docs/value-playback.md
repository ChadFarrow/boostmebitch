# Value Playback Events on Nostr

This spec lives at its own canonical, app-neutral home — not inside either
participating app's repo, so there's one copy to link to instead of several
that can silently drift apart:

**→ [github.com/ChadFarrow/PC20-Nostr/nip-value-playback-events.md](https://github.com/ChadFarrow/PC20-Nostr/blob/main/nip-value-playback-events.md)**

Three kinds — **3369** (a receipt for one interval, regular), **23369** (a live
ticker, ephemeral) and **33369** (running totals, addressable). All three
reference content with NIP-73 `i`/`k` tags, so one `#i` filter finds every event
for a feed, an episode or a track regardless of which kind produced it.

**This app emits `3369` only.** The other two are specified and not implemented;
nothing here publishes or reads them. `npm run probe:kinds` covers all three, so
the relay answer is already on hand if they are added later.

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

Implemented in `lib/nostr/value-playback.ts` (template + publish) and
`lib/v4v/streaming.ts` (`maybePublishReceipt`, and `paymentIds`, which is the
single source of the identifiers both the boostagram and the receipt carry).
Opt-in is `bmb:stream_receipts`, default **off**; the control is
`<StreamReceipts>` in `components/streaming-settings.tsx`.

## Relay acceptance

`3369`, `23369` and `33369` sit in valid NIP-01 ranges (`1000 <= n < 10000`
regular, `20000 <= n < 30000` ephemeral, `30000 <= n < 40000` addressable) and
none of the three appears in the NIPs event-kind table, so there is no
collision. **Neither fact says a relay will take one.** Most general-purpose
relays store any regular kind, but this app's defaults are not all
general-purpose — `relay.nostr.band` is an index and `relay.fountain.fm` is an
app's own relay — and a kind allowlist or a rate limit is invisible until you
write to one.

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
| relay.nostr.band | | | |
| relay.fountain.fm | | | |

## Volume

Receipts are per settle, not per minute. `STREAM_SETTLE_INTERVAL_MS` is ten
minutes, so a continuous listen produces about six an hour — but that is the
floor, not the shape to plan for. A music show accrues into a bucket per
`<podcast:valueTimeSplit>` track and each settles against its own value block,
and a **live Split Kit show force-settles at every block change**, which is once
per song. The per-track case is what will meet a rate limit first, not the
timer.

Read the linked doc, not this stub, for the tag vocabulary and the rules.
