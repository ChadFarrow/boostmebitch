# Sync Inbox seen-state + Listen queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user's Inbox seen-state and listen queue follow their npub across devices, automatically, with no new UI.

**Architecture:** Mirror `lib/nostr/settings-backup.ts` — two kind:30078 (NIP-78) NIP-44 **encrypted-to-self** replaceable events (`boostmebitch:inbox` = seen keys, `boostmebitch:queue` = queue snapshot). Seen merges as a **union**; the queue is **newest-wins** by timestamp. Publishes are debounced and triggered from the store's seen/queue mutations via choke-point helpers (like `persistMuted`); hydration happens in `loadProfile` after favorites/mutes.

**Tech Stack:** Next.js 15 / React 19, Zustand v5, `nostr-tools` 2.19.4 (pinned), TypeScript strict.

## Global Constraints

- **No test runner.** Verification per task = `npm run typecheck` (`tsc --noEmit`, strict) + `npm run lint` (ESLint 9 flat) + the concrete runtime/logic check named in the task. A dev server is already running on `http://localhost:3000`; do **not** run `npm run build` (it clobbers the running server's `.next`).
- **`nostr-tools` stays pinned to exact `2.19.4`** — do not bump.
- **Zustand v5:** every store mutation of a Set/array must produce a **new** reference or per-field selectors won't fire. Components use per-field selectors, never bare `useApp()`.
- **All `bmb:*` keys go through typed accessors in `lib/storage.ts`** — never call `localStorage` directly elsewhere. Per-identity keys use `<npub>` or `:guest`.
- **Encrypted-to-self, auto-sync, gated on a NIP-44 signer.** Signed-out or NIP-44-incapable → local only, silently (no publish attempt, no error). Mirror `recordLastRail`'s `getNip44()` gate.
- **`epKey(e) = e.guid ?? \`${e.feedId}:${e.id}\`\`** is the episode identity (exported from `lib/store.ts`).

---

### Task 1: `lib/nostr/inbox-backup.ts` — fetch/publish/schedulers

**Files:**
- Create: `lib/nostr/inbox-backup.ts`
- Modify: `lib/nostr/index.ts` (barrel export)

**Interfaces:**
- Consumes: `fetchLatestEvent` (`lib/nostr/event-queries.ts`), `signAndPublish` (`lib/nostr/publish.ts`), `resolvePublishRelays` + `DEFAULT_RELAYS` (`lib/nostr/relays.ts`), `requireNip44` (`lib/nostr/signer.ts`), `createScheduledPublish` (`lib/nostr/debounced-publish.ts`), `FEED_QUERY_MAX_WAIT_MS` (`lib/nostr/pool.ts`), `NostrIdentity` (`lib/nostr/auth.ts`), `Episode`/`Podcast` (`lib/types.ts`).
- Produces:
  - `fetchInboxSeen(identity: NostrIdentity): Promise<string[] | null>`
  - `publishInboxSeen(identity: NostrIdentity, keys: string[]): Promise<void>`
  - `scheduleInboxSeenSync(identity: NostrIdentity, seen: Set<string>): void`
  - `fetchListenQueue(identity: NostrIdentity): Promise<{ items: QueueItem[]; updatedAt: number } | null>`
  - `publishListenQueue(identity: NostrIdentity, items: QueueItem[], updatedAt: number): Promise<void>`
  - `scheduleListenQueueSync(identity: NostrIdentity, items: QueueItem[], updatedAt: number): void`
  - `INBOX_SEEN_D_TAG`, `LISTEN_QUEUE_D_TAG` constants
  - `QueueItem` is imported from `../store` (`{ episode: Episode; podcast: Podcast }`).

- [ ] **Step 1: Create the module**

Create `lib/nostr/inbox-backup.ts`:

```ts
'use client';

// Nostr-backed cross-device sync for the Inbox seen-state + listen queue. Same
// NIP-78 + NIP-44 encrypted-to-self pattern as settings-backup.ts, two separate
// replaceable events:
//   - kind:30078, d:'boostmebitch:inbox' → { seen: string[] }        (union merge)
//   - kind:30078, d:'boostmebitch:queue' → { items, updatedAt }       (newest-wins)
// Encrypted-to-self even though not secret — one uniform pattern with the
// settings/wallet backups. Gated on a NIP-44 signer; the schedule* helpers no-op
// without one so callers don't have to check.

import { FEED_QUERY_MAX_WAIT_MS } from './pool';
import { signAndPublish } from './publish';
import { fetchLatestEvent } from './event-queries';
import { DEFAULT_RELAYS, resolvePublishRelays } from './relays';
import { requireNip44, getNip44 } from './signer';
import { createScheduledPublish } from './debounced-publish';
import type { NostrIdentity } from './auth';
import type { QueueItem } from '../store';

const NIP44_DECRYPT_TIMEOUT_MS = 10_000;
function decryptWithTimeout(pubkey: string, ciphertext: string): Promise<string> {
  return Promise.race([
    requireNip44().decrypt(pubkey, ciphertext),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('nip44 decrypt timed out')), NIP44_DECRYPT_TIMEOUT_MS),
    ),
  ]);
}

export const INBOX_KIND = 30078;
export const INBOX_SEEN_D_TAG = 'boostmebitch:inbox';
export const LISTEN_QUEUE_D_TAG = 'boostmebitch:queue';
// The Inbox only ever looks back 30 days, so the synced seen set is capped to
// bound event size. JS Set→array preserves insertion order, so slice(-CAP)
// keeps the most-recently-marked keys.
const SEEN_CAP = 2000;

// Union of intended publish relays + DEFAULT_RELAYS (deduped, capped) so a fresh
// sign-in that hasn't hydrated NIP-65 yet still finds a backup. Mirrors
// settings-backup.ts:readRelays.
function readRelays(identity: NostrIdentity): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of resolvePublishRelays(identity)) {
    if (!seen.has(r)) { seen.add(r); out.push(r); }
  }
  for (const r of DEFAULT_RELAYS) {
    if (!seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out.slice(0, 20);
}

/** Decrypt the user's synced seen keys, or null if none / unreadable. */
export async function fetchInboxSeen(identity: NostrIdentity): Promise<string[] | null> {
  const event = await fetchLatestEvent(
    readRelays(identity),
    { kinds: [INBOX_KIND], authors: [identity.pubkey], '#d': [INBOX_SEEN_D_TAG], limit: 1 },
    FEED_QUERY_MAX_WAIT_MS,
  );
  if (!event || !event.content) return null;
  try {
    const parsed = JSON.parse(await decryptWithTimeout(identity.pubkey, event.content));
    return Array.isArray(parsed?.seen)
      ? parsed.seen.filter((x: unknown): x is string => typeof x === 'string')
      : null;
  } catch {
    return null;
  }
}

/** Encrypt-to-self and publish the seen set (replaceable), capped to newest N. */
export async function publishInboxSeen(identity: NostrIdentity, keys: string[]): Promise<void> {
  const capped = keys.slice(-SEEN_CAP);
  const ciphertext = await requireNip44().encrypt(identity.pubkey, JSON.stringify({ seen: capped }));
  await signAndPublish(
    { kind: INBOX_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['d', INBOX_SEEN_D_TAG]], content: ciphertext },
    resolvePublishRelays(identity),
  );
}

/** Decrypt the user's synced queue, or null if none / unreadable. */
export async function fetchListenQueue(
  identity: NostrIdentity,
): Promise<{ items: QueueItem[]; updatedAt: number } | null> {
  const event = await fetchLatestEvent(
    readRelays(identity),
    { kinds: [INBOX_KIND], authors: [identity.pubkey], '#d': [LISTEN_QUEUE_D_TAG], limit: 1 },
    FEED_QUERY_MAX_WAIT_MS,
  );
  if (!event || !event.content) return null;
  try {
    const parsed = JSON.parse(await decryptWithTimeout(identity.pubkey, event.content));
    const items: QueueItem[] = Array.isArray(parsed?.items)
      ? parsed.items.filter((i: { episode?: unknown; podcast?: unknown }) => i?.episode && i?.podcast)
      : [];
    const updatedAt = typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : event.created_at * 1000;
    return { items, updatedAt };
  } catch {
    return null;
  }
}

/** Encrypt-to-self and publish the queue snapshot (replaceable). */
export async function publishListenQueue(
  identity: NostrIdentity,
  items: QueueItem[],
  updatedAt: number,
): Promise<void> {
  const ciphertext = await requireNip44().encrypt(identity.pubkey, JSON.stringify({ items, updatedAt }));
  await signAndPublish(
    { kind: INBOX_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['d', LISTEN_QUEUE_D_TAG]], content: ciphertext },
    resolvePublishRelays(identity),
  );
}

const scheduleSeen = createScheduledPublish('inbox-seen');
const scheduleQueue = createScheduledPublish('listen-queue');

/** Debounced seen publish — no-op without a NIP-44 signer. */
export function scheduleInboxSeenSync(identity: NostrIdentity, seen: Set<string>): void {
  if (!getNip44()) return;
  const keys = [...seen];
  scheduleSeen(() => publishInboxSeen(identity, keys));
}

/** Debounced queue publish — no-op without a NIP-44 signer. */
export function scheduleListenQueueSync(identity: NostrIdentity, items: QueueItem[], updatedAt: number): void {
  if (!getNip44()) return;
  const snapshot = items.slice();
  scheduleQueue(() => publishListenQueue(identity, snapshot, updatedAt));
}
```

- [ ] **Step 2: Barrel export**

In `lib/nostr/index.ts`, add (next to the other backup exports):

```ts
export * from './inbox-backup';
```

Verify the exact re-export style already used in that file first (`grep -n "settings-backup\|wallet-backup" lib/nostr/index.ts`) and match it (named vs `export *`).

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0. (If `QueueItem` isn't yet exported from `lib/store.ts`, it is — it was added with the queue feature; confirm with `grep -n "export interface QueueItem" lib/store.ts`.)

- [ ] **Step 4: Commit**

```bash
git add lib/nostr/inbox-backup.ts lib/nostr/index.ts
git commit -m "feat(sync): inbox-backup module (kind:30078 seen + queue)"
```

---

### Task 2: Storage — `listenQueueTs` accessor + store sync triggers

**Files:**
- Modify: `lib/storage.ts` (add `KEYS.listenQueueTsPrefix` + `listenQueueTs` accessor)
- Modify: `lib/store.ts` (choke-point helpers `persistSeen`/`persistQueue`; route mutations through them)

**Interfaces:**
- Consumes: `scheduleInboxSeenSync`, `scheduleListenQueueSync` (Task 1).
- Produces: `storage.listenQueueTs.get(npub): number` / `.set(npub, ts: number)`; store behavior unchanged externally (same action names/signatures) — only now they persist a queue timestamp and schedule Nostr sync.

- [ ] **Step 1: Add the storage key + accessor**

In `lib/storage.ts`, add to `KEYS` (next to `listenQueuePrefix`):

```ts
  listenQueueTsPrefix: 'bmb:listen_queue_ts', // unix-ms last local queue edit, for newest-wins sync
```

Add the accessor next to `listenQueue` (before the closing `};` of the `storage` object):

```ts
  /** Per-npub unix-ms timestamp of the last local listen-queue edit. Read at
   *  login to decide newest-wins against a remote synced queue. */
  listenQueueTs: {
    get: (npub: string | null | undefined): number => {
      const raw = safeGet(identityKey(KEYS.listenQueueTsPrefix, npub));
      const n = raw ? Number(raw) : 0;
      return Number.isFinite(n) ? n : 0;
    },
    set: (npub: string | null | undefined, ts: number) => {
      safeSet(identityKey(KEYS.listenQueueTsPrefix, npub), String(ts));
    },
  },
```

- [ ] **Step 2: Add choke-point persist helpers in `lib/store.ts`**

Import the schedulers at the top of `lib/store.ts` (next to the existing `./nostr/relays` / `./nostr/mutes` imports):

```ts
import { scheduleInboxSeenSync, scheduleListenQueueSync } from './nostr/inbox-backup';
```

Add two module-scope helpers next to `persistMuted` (near the bottom of the file):

```ts
// Persist the seen set locally AND (when signed in with a NIP-44 signer)
// schedule a debounced encrypted publish. One choke point so no seen mutation
// site is missed — mirrors persistMuted for the mute list.
function persistSeen(identity: NostrIdentity | null, seen: Set<string>) {
  storage.inboxSeen.set(identity?.npub ?? null, seen);
  if (identity) scheduleInboxSeenSync(identity, seen);
}

// Persist the queue + its edit timestamp locally, and schedule a debounced
// encrypted publish. The timestamp drives newest-wins reconciliation on login.
function persistQueue(identity: NostrIdentity | null, items: QueueItem[]) {
  const ts = Date.now();
  storage.listenQueue.set(identity?.npub ?? null, items);
  storage.listenQueueTs.set(identity?.npub ?? null, ts);
  if (identity) scheduleListenQueueSync(identity, items, ts);
}
```

- [ ] **Step 3: Route every seen write through `persistSeen`**

Replace `storage.inboxSeen.set(s.identity?.npub, next)` in **`markSeenInternal`** and in **`seedSeenKeys`** with `persistSeen(s.identity, next)`. (These are the only two `storage.inboxSeen.set` call sites — confirm with `grep -n "storage.inboxSeen.set" lib/store.ts`; expect exactly 2.)

Example — `markSeenInternal`:

```ts
function markSeenInternal(s: AppState, episode: Episode): Partial<AppState> {
  const key = epKey(episode);
  if (s.seenGuids.has(key)) return {};
  const next = new Set(s.seenGuids);
  next.add(key);
  persistSeen(s.identity, next);
  return { seenGuids: next };
}
```

- [ ] **Step 4: Route every queue write through `persistQueue`**

Replace each `storage.listenQueue.set(s.identity?.npub, <next>)` with `persistQueue(s.identity, <next>)` in **`enqueueEpisode`, `removeFromQueue`, `moveQueueItem`, `clearQueue`, `playNext` (queue-drain branch), and `handlePlaybackEnded` (queue-drain branch)**. Confirm all sites with `grep -n "storage.listenQueue.set" lib/store.ts` (expect ~6) and replace every one. `playFromQueue` does **not** write the queue (tap = jump, no drain) — leave it.

Example — `clearQueue`:

```ts
  clearQueue: () => set((s) => {
    persistQueue(s.identity, []);
    return { listenQueue: [] };
  }),
```

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 6: Runtime smoke check**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/`
Expected: `200` (the app still renders; no publish fires while signed out — `persistSeen`/`persistQueue` skip the schedule when `identity` is null).

- [ ] **Step 7: Commit**

```bash
git add lib/storage.ts lib/store.ts
git commit -m "feat(sync): trigger debounced seen/queue publish from store mutations"
```

---

### Task 3: Hydrate seen (union) + queue (newest-wins) on login

**Files:**
- Modify: `components/nostr-auth/index.tsx` (inside `loadProfile`, after favorites/mutes hydration)

**Interfaces:**
- Consumes: `fetchInboxSeen`, `fetchListenQueue` (Task 1); store `seedSeenKeys`, `setListenQueue`; `storage.listenQueue`, `storage.listenQueueTs`.
- Produces: no new exports — on login the store's `seenGuids` becomes `local ∪ remote`, and `listenQueue` adopts the remote snapshot when it is newer.

- [ ] **Step 1: Locate the hydration point**

Run: `grep -n "storage.favorites.get\|storage.muted.get\|doLoadProfile\|async function loadProfile\|setSeenGuids\|setListenQueue" components/nostr-auth/index.tsx`
Identify `loadProfile`/`doLoadProfile` (the async background enrichment) and the spot after favorites/mutes are merged. The store setters `seedSeenKeys`, `setListenQueue`, `setSeenGuids` are already imported for the fast-path — reuse them (add `seedSeenKeys` to the `useApp` selectors near the top if not present: `const seedSeenKeys = useApp((s) => s.seedSeenKeys);`).

- [ ] **Step 2: Add the sync-hydration block**

Inside `loadProfile(id)`, after the existing favorites/mutes relay hydration, add (best-effort, swallow failures like the other restores):

```ts
    // Cross-device sync (best-effort): union the seen set, adopt a newer queue.
    try {
      const remoteSeen = await fetchInboxSeen(id);
      if (remoteSeen?.length) seedSeenKeys(remoteSeen); // union → persists + republishes merged
    } catch { /* keep local seen */ }
    try {
      const remoteQ = await fetchListenQueue(id);
      if (remoteQ && remoteQ.updatedAt > storage.listenQueueTs.get(id.npub)) {
        setListenQueue(remoteQ.items);
        storage.listenQueue.set(id.npub, remoteQ.items);
        storage.listenQueueTs.set(id.npub, remoteQ.updatedAt);
      }
    } catch { /* keep local queue */ }
```

Add the imports at the top of the file:

```ts
import { fetchInboxSeen, fetchListenQueue } from '@/lib/nostr';
```

(`storage` is already imported in this file.)

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 4: Logic review (no test runner)**

Confirm by reading:
- `seedSeenKeys(remoteSeen)` unions (adds keys to the existing set) and — via Task 2's `persistSeen` — schedules a publish of the merged set (converges both devices). ✅ union, no marks lost.
- The queue block adopts remote **only when strictly newer** than the local `listenQueueTs`, writes both the in-memory store (`setListenQueue`) and localStorage (so a reload keeps it), and does **not** re-publish (no `persistQueue` call) — adopting remote must not immediately overwrite it. ✅ newest-wins.

- [ ] **Step 5: Commit**

```bash
git add components/nostr-auth/index.tsx
git commit -m "feat(sync): hydrate seen (union) + queue (newest-wins) on login"
```

---

### Task 4: Docs + end-to-end verification

**Files:**
- Modify: `CLAUDE.md` (Inbox + Listen Queue section; Nostr identity enrichment list)

- [ ] **Step 1: Document the two new events**

In `CLAUDE.md`, in the **Inbox + Listen Queue** section, append a paragraph:

```markdown
**Cross-device sync (kind:30078 NIP-44 encrypted-to-self, `lib/nostr/inbox-backup.ts`).** Seen-state and the queue sync to the user's npub, mirroring `settings-backup.ts`: `d:boostmebitch:inbox` = `{ seen: string[] }` (**union** merge — a mark on any device sticks; capped at newest ~2000 keys), `d:boostmebitch:queue` = `{ items, updatedAt }` (**newest-wins** vs local `bmb:listen_queue_ts`). Publishes are debounced from the store's `persistSeen`/`persistQueue` choke points (gated on a NIP-44 signer — signed-out/no-nip44 stays local); hydrated in `loadProfile` after favorites/mutes. Playback-position resume is a separate follow-up.
```

Add to the **Nostr identity enrichment** bullet list (near the Spark/settings backups):

```markdown
- **Inbox seen + listen queue (kind:30078, `d:boostmebitch:inbox` / `d:boostmebitch:queue`):** NIP-44 encrypted-to-self; seen unions, queue newest-wins. `lib/nostr/inbox-backup.ts`.
```

Add the new key to the storage-keys table:

```markdown
| `bmb:listen_queue_ts:*` | Per-npub unix-ms of the last local queue edit; drives newest-wins vs the synced `d:boostmebitch:queue` event. |
```

- [ ] **Step 2: Typecheck + lint (docs-only, but confirm nothing broke)**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 3: End-to-end two-device verification (manual)**

With the dev server running and a **NIP-44-capable** signer (Alby/nos2x/nostash) on the same npub in two browser profiles:
1. Browser A: favorite a show, mark an episode ✓ seen, add 2 episodes to the queue.
2. Browser B (fresh, same npub): sign in → after `loadProfile`, B shows the same seen badge state and the same Up Next. ✅ sync works.
3. Mark a *different* show seen on B; reload A → A retains **both** marks. ✅ union.
4. Reorder/remove in B (a few seconds later); reload A → A adopts B's queue. ✅ newest-wins.
5. Sign in with a **non-NIP-44** signer → confirm no `kind:30078` publish in the Network tab; app works locally. ✅ gated.
6. In devtools, inspect the published `d:boostmebitch:inbox` content is encrypted (not plaintext), and after marking many episodes seen the decrypted `seen` array is ≤ 2000. ✅ encrypted + capped.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): cross-device sync for inbox seen + listen queue"
```

---

## Self-Review

**Spec coverage:**
- Mechanism (two kind:30078 events, settings-backup mold) → Task 1. ✅
- Seen union + 2000 cap → Task 1 (`SEEN_CAP`) + Task 3 (`seedSeenKeys` union). ✅
- Queue newest-wins + `bmb:listen_queue_ts` → Task 2 (accessor + `persistQueue` ts) + Task 3 (comparison). ✅
- Debounced publish triggers on all seen/queue mutations → Task 2 (choke-point helpers + routing all sites). ✅
- NIP-44 gate → Task 1 (`scheduleInboxSeenSync`/`scheduleListenQueueSync` `getNip44()` guard). ✅
- Hydrate in `loadProfile` → Task 3. ✅
- Edge cases (no signer, corrupt event, guest→login, fresh device, sign-out) → covered by the gate (Task 1), try/catch (Tasks 1 & 3), newest-wins (Tasks 2–3), and existing reset in `signout`/`completeSignIn` (unchanged). ✅
- Docs → Task 4. ✅

**Placeholder scan:** none — every code step has complete code.

**Type consistency:** `QueueItem` imported from `../store` in Task 1 matches the store's exported `interface QueueItem { episode: Episode; podcast: Podcast }`. `scheduleInboxSeenSync(identity, Set<string>)` / `scheduleListenQueueSync(identity, QueueItem[], number)` signatures match their calls in `persistSeen`/`persistQueue` (Task 2). `fetchListenQueue` return `{ items, updatedAt }` matches the Task 3 consumer (`remoteQ.updatedAt`, `remoteQ.items`). `storage.listenQueueTs.get/set` types (`number`) consistent across Tasks 2–3.
