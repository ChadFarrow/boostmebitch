# Wallet Connection Flow Redesign

**Date:** 2026-05-06  
**Status:** Approved

## Problem

The wallet modal currently renders all three wallet sections (NWC, Spark, WebLN) unconditionally. Users testing or switching wallets find it cluttered and confusing — connect forms are always visible even when a wallet is already active, and there's no clear sense of which wallet is "yours." The boost modal's "Pay via" rail picker adds another layer of confusion for anyone who ends up with multiple wallets connected simultaneously.

## Design Decisions

- **One active wallet at a time.** Connecting a new wallet auto-disconnects the current one.
- **Guided setup flow.** No wallet connected → clean picker listing all three options.
- **Full wallet card when connected.** Active wallet shown prominently with balance, and wallet-specific actions (Spark: receive invoice; NWC/WebLN: balance/status only).
- **Inline switch.** "Switch wallet" link at the bottom of the connected card replaces the card with the picker inline, with a ← Back link and a note that connecting will disconnect the current wallet.
- **No recommendation label.** All three wallet types shown equally in the picker.
- **Boost modal rail picker removed.** With one wallet active at a time, there's nothing to pick.

## Four Modal States

### State 1 — Nothing connected (initial / after disconnect)
- Header: "Connect a wallet"
- Subtext: "Pick one to send Lightning payments."
- Three rows: NWC · Spark · WebLN (WebLN row hidden if `window.webln` not detected)
- Clicking a row → State 2

### State 2 — Connecting (wallet type selected)
- "← Back" link → State 1
- Wallet type label + description
- Connect form for that wallet type:
  - **NWC:** URI input + Connect button (existing `nwcValidate` probe)
  - **Spark:** "Create new" / "Restore from Nostr" buttons (existing flow)
  - **WebLN:** Single "Enable for this site" button
- On connect success → disconnect all other wallets → State 3

### State 3 — Connected (active wallet card)
- Header: wallet type name (e.g. "NWC", "Spark", "WebLN")
- Subheading: wallet identifier (NWC host domain; Spark owner pubkey truncated; WebLN "enabled")
- Balance (sats) — large, prominent
- Wallet-specific actions:
  - **Spark only:** "Receive" button → opens invoice generator inline (existing ReadyPanel flow)
  - All: "Disconnect" button (muted, destructive)
- Bottom: "Switch wallet →" link → State 4

### State 4 — Switching (picker with context)
- "← Back" link → State 3
- Inline note: "Connecting a new wallet will disconnect [current wallet]."
- Same three-row picker as State 1, with active wallet marked "(active)"
- Clicking any row → State 2 (connect form for that type)
- On success: old wallet disconnected, new wallet connected → State 3

## Component Architecture

### `components/wallet-modal.tsx` (primary change)

Replace the current "render all three sections" approach with a view-state machine:

```typescript
type WalletView =
  | { kind: 'connected' }
  | { kind: 'picker'; switching: boolean }
  | { kind: 'connecting'; rail: 'nwc' | 'spark' | 'webln'; switching: boolean };
```

Initial view:
- If any rail is active → `{ kind: 'connected' }`
- Else → `{ kind: 'picker', switching: false }`

Active rail detection (in priority order — matches `pickRail()`):
```
hasNwc() → 'nwc'
hasSpark() → 'spark'
isWeblnEnabled() → 'webln'
null
```

### Sub-components

**`NwcWallet`**, **`SparkWallet`**, **`WeblnWallet`** — each needs a `mode` prop or equivalent to render either:
- `'form'` — the connect/setup form only (no connected card)
- `'card'` — the connected state card only (no form)

Currently each component toggles between form and card based on its own state. The modal will now control which mode to render. Minimal surgery: add a `mode: 'form' | 'card'` prop and split the `return` accordingly.

`SparkWallet` in `'card'` mode renders the full `ReadyPanel` (balance + receive invoice). The create/restore flow is only shown in `'form'` mode.

### `lib/v4v/webln.ts`

Add `weblnDisable()` — clears the `weblnEnabled` module flag and notifies subscribers. Called when switching away from WebLN.

### Disconnect-all helper

Add `clearAllWallets(npub?: string)` — calls `clearNwcUri()`, `sparkDisconnect()`, `weblnDisable()`, clears wallet balance cache. Called in State 2 on successful connect, before activating the new wallet.

Note: when the user switches **to** Spark (create or restore), `clearAllWallets` runs first, then `storage.sparkOptOut.clear()` before the init call — otherwise the opt-out flag would suppress Spark's own auto-restore on the next login.

### `components/boost-modal/index.tsx`

Remove the "Pay via" rail picker UI (the `availableRails.length > 1` block). The `pickRail()` call remains to select the single active wallet; the UI just doesn't show a choice.

## What Stays Unchanged

- `pickRail()` priority order (NWC > Spark > WebLN)
- Spark `ReadyPanel` receive/invoice flow
- NWC `nwcValidate` probe on connect
- `sparkOptOut` flag (still set on Spark disconnect / WebLN enable / NWC connect)
- `WalletButton` chip in header (shows wallet name + balance)
- Portal-to-body pattern (fixed positioning still needs it)

## Files to Touch

| File | Change |
|---|---|
| `components/wallet-modal.tsx` | Rewrite with view-state machine |
| `components/nwc-wallet.tsx` | Add `mode` prop, split form vs card render |
| `components/spark-wallet.tsx` | Add `mode` prop, split form vs card render |
| `components/webln-wallet.tsx` | Add `mode` prop; split form vs card |
| `lib/v4v/webln.ts` | Add `weblnDisable()` |
| `components/boost-modal/index.tsx` | Remove rail picker UI block |

## Verification

1. **Empty state:** Open modal with no wallet connected → picker shows NWC, Spark, and (if Alby installed) WebLN. No connect forms visible yet.
2. **Connect NWC:** Click NWC row → form appears → paste URI → connect → wallet card shows with balance. Spark disconnected if it was active.
3. **Connect Spark:** Click Spark row → create/restore buttons → connect → Spark card with balance + Receive. NWC disconnected if it was active.
4. **Connect WebLN:** Click WebLN row → Enable button → enable → WebLN card shows.
5. **Switch:** From connected card, tap "Switch wallet" → picker appears with ← Back and "(active)" label. Pick new wallet → old disconnects, new connects.
6. **Boost modal:** With one wallet connected, no "Pay via" picker should appear.
7. **No wallet:** Boost modal still shows "No wallet connected" hint.
