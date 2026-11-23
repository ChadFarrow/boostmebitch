# Spark SDK Swap: Breez → Spark Labs

> **Correction (2026-11-22): the account number is 1 on mainnet, not 0.** The plan
> below says `accountNumber: 0`. That was the first-cut bug: Primal and BlitzWallet
> use the SDK's per-network default, which is **1 on mainnet and 0 on regtest**, and
> a seed opened at account 0 on mainnet is a different, empty wallet. The code has
> passed 1 since then (`sparkAccountNumber` in `lib/v4v/spark-derive.ts`,
> docs/wallets.md "Spark rail" item 2), and the SDK's own changelog says the same
> (0.12.0: "the account number defaults to 0 on REGTEST and 1 elsewhere"). Read the
> plan as history; read **"SDK updates"** at the end before you bump the SDK.

## Why

boostmebitch currently uses `@breeztech/breez-sdk-spark`, which derives wallet keys at
`m/8797555'/1'/…` (account 1 on mainnet). BlitzWallet, Primal, and every other Spark
app use `@buildonspark/spark-sdk`, which defaults to `m/8797555'/0'/…` (account 0).
Different account number → different wallet → same seed phrase produces different funds
in each app.

The goal: user sets up BlitzWallet on their phone, pastes that same seed phrase into
boostmebitch, and both apps share the same Spark balance. boostmebitch will no longer
generate wallets for users.

---

## What Changes

### 1. `package.json`

```diff
- "@breeztech/breez-sdk-spark": "^0.13.6",
+ "@buildonspark/spark-sdk": "^0.8.0",
```

Run `npm install` after.

### 2. `.env.example` (and `.env.local`)

Remove the Breez API key — the Spark Labs SDK doesn't need one:

```diff
- NEXT_PUBLIC_BREEZ_API_KEY=your_breez_api_key_here
```

Also delete the `NEXT_PUBLIC_BREEZ_API_KEY` check inside `sparkInitFromMnemonic` in
`lib/v4v/spark.ts`.

### 3. `lib/v4v/spark.ts` — full rewrite

The file stays `'use client'` and exports the same public surface so nothing else needs
to change. Internals are completely different.

**Import:**
```ts
import { SparkWallet, SparkWalletBrowser, SparkWalletEvent } from '@buildonspark/spark-sdk';
```

Use `SparkWalletBrowser` (not `SparkWallet`) — it wires the browser-compatible
gRPC-web connection manager. The package's conditional exports resolve the right entry
point automatically in Next.js client bundles.

**Initialization:**
```ts
const { wallet: w } = await SparkWalletBrowser.initialize({
  mnemonicOrSeed: args.mnemonic,
  accountNumber: 0,               // must be 0 — matches BlitzWallet / Primal default
  options: {
    network: args.network === 'regtest' ? 'REGTEST' : 'MAINNET',
  },
});
sdk = w;
activePubkey = args.ownerPubkey;
```

`accountNumber: 0` is the critical line. Omitting it or passing `undefined` still
defaults to 0 in the Spark Labs SDK, but be explicit so future readers don't wonder.

**`walletStorageDir` — drop it.** The Spark Labs SDK manages its own IndexedDB storage
keyed internally. No `storageDir` parameter exists on `initialize`.

**`sparkGenerateMnemonic` — delete it.** Users bring their own seed from BlitzWallet.
Nothing else in the codebase calls this function.

**Pay invoice (simpler — single step):**
```ts
export async function sparkPayInvoice(invoice: string): Promise<string> {
  if (!sdk) throw new Error('Spark wallet not initialized');
  const result = await sdk.payLightningInvoice({
    invoice,
    maxFeeSats: 100,
  });
  // Preimage is async in this SDK (call getLightningSendRequest(result.id) to retrieve).
  // The UI never reads BoostResult.preimage, so returning '' is fine.
  return '';
}
```

`maxFeeSats: 100` is a reasonable hard cap for podcast boosts. Revisit if users report
payment failures on small amounts — you could compute `Math.max(10, Math.ceil(amountSats * 0.05))`
if you decode the invoice first, but that adds complexity for little gain.

**Receive invoice:**
```ts
export async function sparkReceiveInvoice(args: {
  amountSats?: number;
  description?: string;
}): Promise<{ invoice: string; feeSats: number }> {
  if (!sdk) throw new Error('Spark wallet not initialized');
  const result = await sdk.createLightningInvoice({
    amountSats: args.amountSats ?? 0,
    memo: args.description ?? 'BoostMeBitch Spark deposit',
  });
  return {
    invoice: result.invoice.encodedInvoice,
    feeSats: 0,   // Spark Labs SDK doesn't surface the settle fee here
  };
}
```

The `ReadyPanel` in `spark-wallet.tsx` currently shows "Spark settle fee: N sats" when
`feeSats > 0`. Since `feeSats` will always be 0 now, that line simply never renders —
no UI change needed there.

**Balance:**
```ts
export async function sparkGetInfo(): Promise<{ balanceSats: number; identityPubkey?: string } | null> {
  if (!sdk) return null;
  try {
    const balance = await sdk.getBalance();
    return { balanceSats: Number(balance.balance) };
    // identityPubkey is not directly exposed; omitting is fine — nothing reads it.
  } catch {
    return null;
  }
}
```

`balance.balance` is a `bigint`. `Number()` is safe for any realistic sat balance.

**Events — EventEmitter pattern replaces async addEventListener:**

The Breez SDK used `addEventListener({ onEvent })` returning a Promise<id>, then
`removeEventListener(id)`. The Spark Labs SDK is a standard EventEmitter (EventEmitter3).

Map the events callers actually check:

| Breez event | Spark Labs event | Meaning |
|---|---|---|
| `paymentSucceeded` | `SparkWalletEvent.BalanceUpdate` | Balance changed after payment |
| `claimedDeposits` | `SparkWalletEvent.DepositConfirmed` | Deposit settled |
| `newDeposits` | `SparkWalletEvent.TransferClaimed` | Incoming transfer |
| `synced` | `SparkWalletEvent.StreamConnected` | Stream ready after init |

```ts
export async function subscribeSparkEvents(
  onEvent: (e: SparkSdkEvent) => void,
): Promise<() => void> {
  if (!sdk) return () => {};

  const onBalance  = () => onEvent({ type: 'paymentSucceeded', payment: null });
  const onDeposit  = () => onEvent({ type: 'claimedDeposits', claimedDeposits: [] });
  const onTransfer = () => onEvent({ type: 'newDeposits', newDeposits: [] });
  const onStream   = () => onEvent({ type: 'synced' });

  sdk.on(SparkWalletEvent.BalanceUpdate,   onBalance);
  sdk.on(SparkWalletEvent.DepositConfirmed, onDeposit);
  sdk.on(SparkWalletEvent.TransferClaimed,  onTransfer);
  sdk.on(SparkWalletEvent.StreamConnected,  onStream);

  return () => {
    sdk?.off(SparkWalletEvent.BalanceUpdate,    onBalance);
    sdk?.off(SparkWalletEvent.DepositConfirmed, onDeposit);
    sdk?.off(SparkWalletEvent.TransferClaimed,  onTransfer);
    sdk?.off(SparkWalletEvent.StreamConnected,  onStream);
  };
}
```

This keeps the `SparkSdkEvent` type union and all component event-handler logic
identical — `spark-wallet.tsx` and `wallet-balance.tsx` don't need to change.

**Disconnect:**
```ts
export async function sparkDisconnect(): Promise<void> {
  if (sdk) {
    try { await (sdk as any).cleanup(); } catch { /* best effort */ }
  }
  sdk = null;
  activePubkey = null;
  notify();
}
```

The Spark Labs SDK uses `cleanup()` (confirmed in the singleton pattern in wallet.ts).
Cast to `any` if TypeScript complains — it's a real method.

**Remove from `SparkSdkEvent` union** (types that were never handled):
- `optimization`
- `lightningAddressChanged`

Removing them is safe — no component matches on either.

---

### 4. `components/spark-wallet.tsx` — new form, same card

**Delete entirely:**
- `startCreate` / `confirmCreate` / `cancelCreate` — wallet creation flow
- `draftMnemonic`, `confirmed` state
- The "Write this down" seed display block
- The "Create new" button
- The "Restore from Nostr" button
- Import of `sparkGenerateMnemonic`

**Replace the form with:**

A single textarea where the user pastes their BlitzWallet seed phrase, a Connect button,
and (after successful init) the existing `ReadyPanel`. After connecting, still call
`publishEncryptedMnemonic` so the seed is saved encrypted to Nostr — this powers the
silent auto-restore on next login without requiring the user to paste again.

Rough shape:

```tsx
const [seedInput, setSeedInput] = useState('');
const [busy, setBusy] = useState(false);
const [err, setErr] = useState<string | null>(null);

async function connect() {
  if (!identity) { setErr('Sign in with Nostr first.'); return; }
  const mnemonic = seedInput.trim();
  if (!mnemonic) return;
  setBusy(true); setErr(null);
  try {
    storage.sparkOptOut.clear();
    await sparkInitFromMnemonic({ mnemonic, ownerPubkey: identity.pubkey });
    // Save encrypted so next login auto-restores without re-pasting.
    await publishEncryptedMnemonic(identity, mnemonic).catch(() => {});
    setSeedInput('');
    onConnected?.();
  } catch (e) {
    setErr(getErrorMessage(e, 'failed to connect wallet'));
  } finally { setBusy(false); }
}

// render:
<div className="space-y-2">
  <div className="text-[11px] text-muted">
    Works with BlitzWallet, Primal, and any Spark wallet.
  </div>
  <div className="text-[11px] text-muted">
    Paste your seed phrase to connect. Saved once to your Nostr relays — auto-restores on future logins.
  </div>
  <textarea
    className="input w-full text-xs font-mono"
    rows={3}
    placeholder="word1 word2 word3 … (12 or 24 words)"
    value={seedInput}
    onChange={(e) => setSeedInput(e.target.value)}
  />
  <button
    onClick={connect}
    disabled={busy || !seedInput.trim() || !identity}
    className="btn-ghost disabled:opacity-30"
  >
    {busy ? 'Connecting…' : 'Connect'}
  </button>
  {!identity && <div className="text-[11px] text-muted">Sign in with Nostr first.</div>}
  {err && <div className="text-[11px] text-nostr/80">{err}</div>}
</div>
```

Optionally add basic client-side validation: split by whitespace, check word count is
12 or 24, show an error before even hitting the SDK. The `@scure/bip39` package
(already a transitive dep) has `validateMnemonic` if you want full wordlist checking.

---

## What Stays the Same

- `lib/nostr/wallet-backup.ts` — unchanged. `fetchEncryptedMnemonic` powers auto-restore
  on login; `publishEncryptedMnemonic` is now called after the user pastes their seed.
- `components/nostr-auth.tsx` — unchanged. The silent auto-restore block at line 114
  (`sparkPromise = fetchEncryptedMnemonic(id).then(...)`) still works exactly as before.
- `lib/v4v/wallets.ts` — unchanged.
- `lib/storage.ts` — unchanged. `sparkOptOut` sentinel still works.
- `components/wallet-balance.tsx` — unchanged. It calls `subscribeSparkEvents` which
  still emits the same Breez-named event types (the mapping is internal to spark.ts).
- `components/wallet-modal.tsx` — unchanged.
- `lib/v4v/boost.ts` — unchanged. Calls `sparkPayInvoice(invoice)` which still exists.

---

## Things to Watch

**Browser compatibility.** The Spark Labs SDK ships a `dist/index.browser.js` entry and
uses conditional exports, so Next.js client bundles should pick it up automatically. If
you see Node.js-only imports (like `net` or `tls`) leaking into the browser bundle, add
to `next.config.mjs`:
```js
webpack: (config, { isServer }) => {
  if (!isServer) {
    config.resolve.alias['@buildonspark/spark-sdk'] =
      require.resolve('@buildonspark/spark-sdk/dist/index.browser.js');
  }
  return config;
},
```

**Keysend splits will fail — this is expected.** Spark (both Breez and the Labs SDK)
is BOLT11-only; it cannot keysend. `lib/v4v/boost.ts` already handles this: any
value-block recipient with `type: 'node'` is rejected per-leg with a clear error, and
the boost continues to the remaining LNURL/lnaddress recipients. This is unchanged by
the swap, but worth surfacing to users — a boost to a show where one or more recipients
are node-pubkey-only will show partial failures. Consider adding a note in the boost
modal (or the wallet description) along the lines of "Keysend recipients are skipped
— use NWC if your podcasts require it."

**`maxFeeSats` on zero-amount invoices.** `payLightningInvoice` requires `maxFeeSats`.
If someone pays a zero-amount BOLT11 (the `amountSatsToSend` param handles that), the
`maxFeeSats` cap still applies. 100 sats is fine.

**Existing users with a Breez-derived wallet.** Anyone who created a Spark wallet
through the old flow has funds at `m/8797555'/1'/…` (Breez's account 1 path). After
the swap, pasting that same seed will open account 0 — a different, empty wallet. Their
Breez-path funds aren't lost (the seed still controls them) but they'd need to move
funds out of the Breez wallet first, or use a different app to access it. Worth a brief
note in release comms if you have users with existing boostmebitch Spark wallets.

**`@scure/bip39` stays.** It's still used by `lib/nostr/` internals as a transitive dep
of nostr-tools, so removing Breez won't orphan it. You can still use it for mnemonic
validation in the paste form if you want.

---

## SDK updates

**Before any bump of `@buildonspark/spark-sdk`:** run `npm run check:spark` (it runs
the installed SDK's signer at `sparkAccountNumber('mainnet')` against identity keys
0.8.1 derived) and `npm run e2e:spark` (the browser bundle, against the real
operators: new wallet, balance 0, an invoice, and the pinned identity key sent for
a pasted seed). Then read the changelog for the four things below, and get one
real-wallet test from the owner before the merge. **A caret on `0.x` pins the
minor** (`^0.16.0` is `<0.17.0`), so a minor bump never arrives on its own.

### 0.8.1 → 0.16.0 (2026-11-22)

**The seed opens the same wallet.** `DefaultSparkKeysGenerator.deriveKeysFromSeed`
derives at `m/8797555'/<account>'/0'…4'` in both, and `resolveSeedAndMnemonic` (the
account default, the mnemonic → seed step with no passphrase) is byte-identical.
Both versions were run on four seeds (the three `check:spark` mnemonics and the
BIP-39 test vector) at mainnet account 1, regtest account 0 and mainnet account 0:
identity, deposit, static-deposit and leaf keys and the Spark address were the
same in all twelve. Only FROST signing gained an optional `adaptorV2` argument.

**The calls this app makes did not change shape:** `SparkWallet.initialize`,
`payLightningInvoice({ invoice, maxFeeSats })`, `createLightningInvoice({ amountSats,
memo })`, `getBalance().satsBalance.available`, `cleanup`, and the four events. The
breaking changes in the range touch nothing here: `idempotencyKey` left
`payLightningInvoice` (0.10; never passed — each call gets a fresh `transferId`),
`ReceiveQuoteAmountBasis` (0.15), token v2 (0.13–0.14), and the fee-quote paths.

**What the update brings:**

- **0.12.1 — `getBalance` could read 0 sats with no error.** When the
  non-coordinator operators' session tokens expired, every leaf looked
  inconsistent across operators and was excluded. A connected wallet stuck at 0
  had a second cause besides the account number; this removes it.
- **0.12.0 — deadlines on operator authentication and balance queries**, so a
  missing answer fails rather than hangs (`SPARK_INIT_TIMEOUT_MS` still caps our
  wait for init).
- **0.15.0** — incoming transfers from another network are ignored, and an invoice
  for another network is refused before anything moves.
- **0.16.0 — `SparkSendOutcomeUnknownError`** for a Spark-transfer send whose start
  failed. It reaches only a `preferSpark: true` payment (the invoice's Spark
  fallback). `sparkPayInvoice` never sets it, so a leg pays over Lightning (the
  preimage swap) under a fresh `transferId`, as before. **If `preferSpark` is ever
  added, that error is the `?` arm of boost invariant 11** — never ✗, never a
  retry on another rail — and the SDK's `resolveSendOutcome(transferId)` is how
  it settles.
- Dependencies: `ts-proto` and `ua-parser-js` dropped, `@bufbuild/protobuf` 2.12 →
  2.17. The SDK chunk is 612 KB (153 KB gzip) and loads only on a wallet open.

**Not changed: the operator set** (Lightspark as coordinator, Breez, flashnet), and
`Authorization` still goes to all three, so #304 (flashnet's
`access-control-allow-headers: *`) is not fixed by the update.

**The balance read stays `getBalance()`, not the tolerant `getLeaves(true)`** (#304
option 3). In 0.16 the balance-check path asks only the coordinator and tolerates
a non-coordinator that fails, but:

1. **It does not fix #304.** Init (`createClients`, one authentication per
   operator under `Promise.all`) and every payment still need all three operators,
   so a browser that blocks flashnet still cannot connect or pay; it would save a
   balance figure only for a wallet that somehow connected.
2. **It shows sats a payment can refuse.** It skips the cross-operator consistency
   check `getBalance` makes, and it does not subtract leaves held by a send whose
   outcome is unknown (0.16), which `refreshSpendableLeaves` does. Advertising
   sats the wallet will refuse is the failure `check:nwcbudget` pins on the NWC
   rail.
3. **It is not a read.** `getLeaves` in both modes recovers and renews leaves
   (`recoverLeaves`, `decrementRefundTxn`, `checkRenewLeaves` sign and send to the
   operators); on the balance-check path it does so for leaves only the
   coordinator confirmed. A UI poll should not drive that.
4. **It bypasses the SDK's leaf cache**, which `getBalance` refreshes and the next
   payment's leaf selection reads.

