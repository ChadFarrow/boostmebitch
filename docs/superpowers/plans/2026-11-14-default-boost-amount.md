# Default Boost Amount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A SET AS DEFAULT control under the amount field of the single boost, boost-all and zap surfaces, each saving its own device default.

**Architecture:** Three device-setting keys behind one `storage.amountDefault` accessor in `lib/storage.ts`. The control, and the read that applies `MIN_BOOST_SATS`, live in `components/boost-modal/amount-input.tsx` beside the constant, so no import cycle forms. `<AmountInput>` renders the control behind one optional prop; the zap dialog renders it directly.

**Tech Stack:** Next.js / React 18, TypeScript strict, `localStorage` through `safeGet`/`safeSet`, headless Chrome over `scripts/cdp.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-14-default-boost-amount-design.md`

## Global Constraints

- Keys: `bmb:boost_default`, `bmb:boost_all_default`, `bmb:zap_default`. Device-wide. Not in `EVICTABLE_PREFIXES`.
- A default is a whole number `>= MIN_BOOST_SATS` (100). Anything else reads as no default.
- No default: single boost opens blank (`0`); boost-all and zap open at `100`.
- The control's two states: `set as default` and `✓ default` + `clear`. Disabled below 100 and while a send runs.
- The control writes one key. Nothing is sent or published. The e2e never presses Send.
- Repo has no test runner: the test is an `e2e:*` script on `scripts/cdp.mjs`; the gates are `npm run typecheck`, `npm run lint`, `npm run check`, `npm run build`.

## Review Focus

- **The field is cleared after a default fills it.** Today a blank field leaves `sats` at its last value, so "Send 1000 sat" stays enabled beside a blank field. With pre-filled fields this becomes common. Expect: a blank field means `sats === 0` and Send disabled. Pinned in Task 1.
- **A stored value is garbage or below 100** (`'abc'`, `'50'`, `'1e3'`, `'-5'`). Expect: the surface opens as if no default exists. Pinned in Task 1.
- **One surface's default leaks into another.** Expect: each surface reads only its own key. Pinned in Task 2 and Task 3.
- **Storage is full or blocked.** Expect: the default holds for the visit, and the control says `this visit only`. Covered by the existing `safeSet` mirror; the hint is in Task 1. Not driven by the e2e (no way to fill Safari's quota from CDP reliably).
- **Phone width.** Expect: no horizontal overflow at 390 and 320; the control is at least 24×24 CSS px. Pinned in Task 3.

---

### Task 1: The accessor, the control, and the single boost

**Files:**
- Modify: `lib/storage.ts` (KEYS table; new accessor beside `deleteAfterPlay`)
- Modify: `components/boost-modal/amount-input.tsx`
- Modify: `components/boost-modal/index.tsx:159` (initial `sats`) and `:951` (pass `defaultKind`)
- Create: `scripts/e2e-boost-default.mjs`; Modify: `package.json` (`"e2e:boostdefault"`)
- Modify: `docs/storage.md` (three key rows), `docs/money-boosts.md` (short section)

**Interfaces:**
- Produces, `lib/storage.ts`:
  - `export type AmountDefaultKind = 'boost' | 'boostAll' | 'zap'`
  - `storage.amountDefault.get(kind: AmountDefaultKind): number | null` — a safe positive integer or null
  - `storage.amountDefault.set(kind, sats: number): boolean` — whether it reached disk
  - `storage.amountDefault.clear(kind): void`
  - `storage.amountDefault.isEphemeral(kind): boolean`
- Produces, `components/boost-modal/amount-input.tsx`:
  - `export function readAmountDefault(kind: AmountDefaultKind): number | null` — `get`, then `null` below `MIN_BOOST_SATS`
  - `export function DefaultAmountControl({ kind, typed, disabled }: { kind: AmountDefaultKind; typed: number; disabled?: boolean })`
  - `<AmountInput defaultKind?: AmountDefaultKind>` — renders the control on the hint line; `typed` is the field's own text, never the `sats` prop

- [ ] **Step 1: Write the failing e2e, section 1 (single boost).** Open the Two For Tunestr episode, press BOOST. Assert, in order: field `''`; `set as default` present and disabled; type `1000` → enabled; press → `localStorage['bmb:boost_default'] === '1000'` and the control reads `✓ default` with `clear`; close and reopen → field `'1000'`, `✓ default`; select all + Backspace → Send disabled; `clear` → key absent; reopen → field `''`; type `50` → control disabled; seed `'abc'`, `'50'`, `'-5'`, `'1e3'` in turn → each opens `''`.
- [ ] **Step 2: Run it.** `npm run e2e:boostdefault` against `npm run build && npm start`. Expected: FAIL at "set as default present".
- [ ] **Step 3: Implement the accessor, the control, `defaultKind`, and the blank-field fix** (`onChange(0)` when the field has no digits). Single modal: `useState(() => readAmountDefault('boost') ?? 0)`.
- [ ] **Step 4: Run it.** Expected: section 1 all `ok`.
- [ ] **Step 5: Docs.** `docs/storage.md`: one row per key. `docs/money-boosts.md`: "Default amounts" — three keys on purpose (boost-all multiplies), the blank-field fix and why.
- [ ] **Step 6: Commit.** `feat(boost): save a default amount for the single boost`

### Task 2: Boost-all

**Files:**
- Modify: `components/boost-all-modal.tsx:64` and `:550`
- Modify: `scripts/e2e-boost-default.mjs` (section 2)

**Interfaces:** Consumes `readAmountDefault`, `defaultKind` from Task 1.

- [ ] **Step 1: Write section 2.** With `bmb:boost_default = '1000'`, open "Boost all N tracks" from the episode's ⋯ menu. Assert field `'100'` (not 1000); set `250` → `bmb:boost_all_default === '250'`, `bmb:boost_default` still `'1000'`; reopen → `'250'`.
- [ ] **Step 2: Run it.** Expected: FAIL at the control lookup.
- [ ] **Step 3: Implement.** `useState(() => readAmountDefault('boostAll') ?? 100)`; `defaultKind="boostAll"`.
- [ ] **Step 4: Run it.** Expected: sections 1–2 `ok`.
- [ ] **Step 5: Commit.** `feat(boost): save a default per-track amount for boost-all`

### Task 3: The zap dialog, and the phone layout

**Files:**
- Modify: `components/nostr-note-card.tsx:751` and the amount block at `:811`
- Modify: `scripts/e2e-boost-default.mjs` (sections 3 and 4)
- Modify: `docs/nostr.md` (one line under the note card)

**Interfaces:** Consumes `readAmountDefault`, `DefaultAmountControl` from Task 1.

- [ ] **Step 1: Write section 3.** Signed in through the NIP-07 shim (`e2e-favorites.mjs`), `bmb:relays` pointed at a dead local port, one note seeded in `bmb:feed:global` with `author.lud16` set. Press `⚡ zap`. Assert field `100`; set `2100` → `bmb:zap_default === '2100'`, the other two keys unchanged; reopen → `2100`.
- [ ] **Step 2: Write section 4.** At 390×844 and 320×640 (`mobile: true`), in each of the three surfaces: `scrollWidth <= clientWidth` and the control's box `>= 24×24`. No page exceptions over the run.
- [ ] **Step 3: Run it.** Expected: FAIL in section 3.
- [ ] **Step 4: Implement.** `useState(() => readAmountDefault('zap') ?? 100)`; `<DefaultAmountControl kind="zap" typed={amount} disabled={state === 'busy'} />` right-aligned under the input.
- [ ] **Step 5: Run it.** Expected: all sections `ok`.
- [ ] **Step 6: Gates.** `npm run typecheck && npm run lint && npm run check && npm run build`. Expected: zero errors; `check` all `ok`.
- [ ] **Step 7: Commit.** `feat(zap): save a default zap amount`
