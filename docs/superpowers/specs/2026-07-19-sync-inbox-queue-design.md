# Sync Inbox seen-state + Listen queue across Nostr

## Context

The Inbox + Listen Queue feature (branch `feature/inbox-listen-queue`, PR #132) stores
two pieces of state **device-locally**:

- **`seenGuids`** — episode keys the user has handled (`bmb:inbox_seen:<npub>`), which
  drive the Inbox "N NEW" badges.
- **`listenQueue`** — the "Up Next" list (`bmb:listen_queue:<npub>`).

A user on more than one device (phone + laptop) has to rebuild both on each device: a show
marked seen on the phone still shows NEW on the laptop, and a queue built on one device
doesn't appear on the other. This makes both features feel broken across devices.

The app already syncs other per-user state to the user's Nostr identity with a proven
pattern — `railPref` via `lib/nostr/settings-backup.ts`, plus the Spark/NWC wallet backups
— all **kind:30078 (NIP-78) NIP-44 encrypted-to-self** replaceable events. This spec
extends that pattern to seen-state and the queue.

**Scope:** seen + queue only. Playback-position resume (persist `positionSec` per episode,
resume on replay, then sync) is a **separate follow-up** — it needs new local persistence
first — and is out of scope here.

## Goals / non-goals

- **Goal:** a signed-in user's Inbox seen-state and listen queue follow their npub across
  devices, automatically, with no new UI.
- **Non-goal:** real-time/live sync (fetch-on-login + debounced-publish is enough, matching
  every other backup). No conflict UI. No sync for signed-out users (both stay local).

## Design

### Mechanism — new module `lib/nostr/inbox-backup.ts`

A near-clone of `lib/nostr/settings-backup.ts`, reusing its helpers (`readRelays`,
`decryptWithTimeout`, `createScheduledPublish`, `fetchLatestEvent`, `signAndPublish`,
`requireNip44`/`getNip44`). Two **separate** kind:30078 replaceable events (different merge
rules + update cadence, so not folded into `settings`):

| d-tag | payload (encrypted-to-self JSON) |
|---|---|
| `boostmebitch:inbox` | `{ seen: string[] }` — episode keys (`epKey`) |
| `boostmebitch:queue` | `{ items: QueueItem[], updatedAt: number }` |

Exports: `fetchInboxSeen(identity) → string[] \| null`, `publishInboxSeen(identity, keys)`,
`fetchListenQueue(identity) → { items, updatedAt } \| null`, `publishListenQueue(identity,
items, updatedAt)`, plus two module-scope debounced schedulers
(`createScheduledPublish('inbox-seen')`, `createScheduledPublish('listen-queue')`).

### Merge rules

- **Seen = union (monotonic).** On login, `remote ∪ local` → `seenGuids`. "Seen" only
  grows (no un-see), so a mark made on any device must never be dropped by an older
  snapshot. **Cap on publish:** newest ~2000 keys (JS `Set` preserves insertion order) —
  the Inbox only looks back 30 days, so 2000 is far more than enough, and it bounds the
  event size. Local set may exceed the cap harmlessly; each publish re-caps.
- **Queue = newest-wins (last-write-wins, no per-item merge).** Compare the remote event's
  `created_at` against a new local timestamp `bmb:listen_queue_ts:<npub>`; adopt whichever
  is newer, wholesale. Chosen by the user over union — a queue is drained/reordered, so
  removals must stick; per-item union would resurrect removed items.

### Triggers

- **Publish (debounced ~1.5s).** Every seen mutation (`markSeen`, `seedSeenKeys`,
  `enqueueEpisode`'s implicit mark) schedules an inbox-seen publish; every queue mutation
  (`enqueueEpisode`, `removeFromQueue`, `moveQueueItem`, `clearQueue`, and the drains inside
  `playNext`/`handlePlaybackEnded`) bumps `bmb:listen_queue_ts` and schedules a queue
  publish. All go through one choke point each (see Implementation notes) so no call site is
  missed — the same discipline as `persistMuted` for mutes. Gated: **no-op unless signed in
  with a NIP-44-capable signer** (`getNip44()`), exactly like `recordLastRail`.
- **Hydrate in `loadProfile`** (`components/nostr-auth/index.tsx`), after the
  favorites/mutes hydration: `fetchInboxSeen` → union into `seenGuids` via `seedSeenKeys`
  (or a dedicated setter); `fetchListenQueue` → if `remote.updatedAt >
  storage.listenQueueTs.get(npub)`, `setListenQueue(remote.items)` + write the ts. Best-
  effort, failures swallowed (mirrors the other `loadProfile` restores).

### Storage

- Reuse `bmb:inbox_seen:<npub>` and `bmb:listen_queue:<npub>` (unchanged).
- **New:** `bmb:listen_queue_ts:<npub>` — unix-ms last-local-modified time of the queue,
  written on every queue mutation, read at login for the newest-wins comparison. Typed
  accessor in `lib/storage.ts`.

### Where the publish is triggered

Mutations live in `lib/store.ts`, which already imports Nostr helpers and calls
`schedulePublishMuteList` from `persistMuted` — so triggering a debounced publish from the
store actions is the established pattern (no new cycle). Each seen/queue action, after
persisting locally, calls a small `scheduleInboxSeenSync(identity, seenGuids)` /
`scheduleQueueSync(identity, items, ts)` helper that no-ops without a NIP-44 signer.

## Edge cases

- **No NIP-44 signer** (e.g. Amber without nip44, or signed out) → local only, silent.
- **Corrupt / undecryptable event** → ignored, keep local (try/catch like `fetchSettings`).
- **Guest-built queue, then sign in** → newest-wins: the local queue's ts (set as you built
  it) is compared to any remote event; your local queue publishes if newer.
- **Fresh device, first login** → no local queue/seen; remote adopted wholesale (union of
  empty local + remote = remote; queue newest-wins picks remote).
- **Sign-out / npub-switch** → seen + queue already reset to the new bucket in
  `signout`/`completeSignIn`; no relay writes on sign-out.

## Files

**Create:** `lib/nostr/inbox-backup.ts` (fetch/publish/schedulers), export from the
`lib/nostr` barrel.
**Modify:**
- `lib/storage.ts` — add `listenQueueTs` accessor (`bmb:listen_queue_ts` prefix).
- `lib/store.ts` — after each seen/queue mutation, schedule the corresponding sync (gated
  on identity + NIP-44); bump the queue ts on queue mutations.
- `components/nostr-auth/index.tsx` — hydrate seen (union) + queue (newest-wins) in
  `loadProfile`, after favorites/mutes.
- `CLAUDE.md` — note the two new d-tags under the Inbox + Listen Queue section and the
  "Nostr identity enrichment" list.

## Verification

1. `npm run typecheck` + `npm run lint` clean; `GET /` renders 200.
2. **Two-device sim** (two browsers / profiles, same npub with a NIP-44 signer): mark a
   show seen + build a queue in browser A; sign in on browser B → after `loadProfile`, B
   shows the same seen badges and the same Up Next.
3. **Seen union:** mark different shows seen on A and B; reload each → both retain the
   union (no marks lost).
4. **Queue newest-wins:** reorder/remove on B (later), reload A → A adopts B's queue.
5. **No NIP-44 signer:** confirm no publish attempts (network tab), everything still works
   locally.
6. **Corrupt event:** hand-publish a garbage kind:30078 `boostmebitch:queue` → login
   ignores it, keeps local.
7. Confirm event size stays bounded: after marking many episodes seen, the published
   `boostmebitch:inbox` event caps at ~2000 keys.
