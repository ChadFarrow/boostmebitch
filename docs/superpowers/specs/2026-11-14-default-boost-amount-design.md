# A default amount for each boost surface

**Date:** 2026-11-14

## Intent

Chad wants to stop typing the same number into the boost field. His words, with a screenshot of
the single boost modal: *"leave this blank but maybe add a 'set as default' button below it and
add a set default boost in the other sections that have to do with sat amounts"*. Asked whether
one value should serve every surface or each surface should keep its own, he chose **one for
each section**.

## Goals

- A **SET AS DEFAULT** control under the amount field of three surfaces. It saves the number in
  the field as that surface's default, and the surface opens with it from then on:

  | Surface | File | Opens with today | Opens with, once a default is saved |
  |---|---|---|---|
  | Single boost | `components/boost-modal/index.tsx` | blank (`0`) | the saved default |
  | Boost-all, per track | `components/boost-all-modal.tsx` | `100` | the saved default |
  | Zap a note | `ZapDialog` in `components/nostr-note-card.tsx` | `100` | the saved default |

- When the field holds the saved default, the control reads **✓ DEFAULT** with a **CLEAR**
  button beside it. CLEAR removes the default; the surface then opens as it does today.

## Non-goals

- No default for the streaming rate: `bmb:stream_rate` / `bmb:stream_amount` already remember the
  last number typed.
- No default for the wallet's receive amount (NWC top-up, Spark receive): that is money in.
- No sync across devices. The default is a device setting, like the streaming rate. Syncing it
  through the kind:30078 `boostmebitch:settings` event can come later.
- No change to the zap dialog's 100 / 500 / 1000 / 5000 chips.

## Anti-goals

- **One surface's default changes another surface.** Boost-all multiplies its number by the track
  count, so a 5,000-sat single default would become 60,000 sats on a 12-track album. Three keys,
  never one.
- **A surface with no default changes.** The single boost still opens blank; the other two still
  open at 100.
- **The control and the field disagree.** The control reads the field's own text, so it can never
  show ✓ DEFAULT beside a blank field.
- **Anything is sent or published.** The control writes one `localStorage` key and nothing else.

## Constraints

- A `bmb:*` key goes through `safeSet` and stays out of `EVICTABLE_PREFIXES` — it is a setting,
  not a cache (`docs/storage.md`). A write that only reaches the memory mirror says so on screen,
  as the streaming switch does.
- `MIN_BOOST_SATS` (100) lives in `components/boost-modal/amount-input.tsx`. `lib/storage.ts`
  must not import a component, so storage rejects only garbage (not a safe positive integer), and
  the component applies the minimum when it reads and when it saves.
- Two of the three surfaces share `<AmountInput>`. The control goes inside it, behind one optional
  prop, so both modals get one implementation. The zap dialog has its own `<input>` and uses the
  same control component directly.

## Approaches

1. **One default for each surface (chosen by Chad).** Three keys, three controls. Safe against the
   boost-all multiplication; three settings to set.
2. **One shared default.** Set once, used by all three. Rejected: it turns a single-boost default
   into an album spend N times larger.

## Calls made by the designer

- Keys: `bmb:boost_default`, `bmb:boost_all_default`, `bmb:zap_default`. Device-wide, not
  per-npub — the streaming rate is device-wide too.
- A saved value below `MIN_BOOST_SATS` reads as no default. The control is disabled below the
  minimum and while a send runs.
- The control sits right-aligned on the hint line, under the field.

## Left to the builder

- The exact wording and styling of the control, within the sketch Chad approved:

  ```
  minimum 100 sats         [SET AS DEFAULT]
  minimum 100 sats         ✓ DEFAULT  [CLEAR]
  ```
