// Pure BOLT11 helpers — no imports, safe from both lib/v4v and lib/nostr.

// Parse the HRP of a bolt11 invoice and return msat. Format:
// `ln<chain><amount?><multiplier?>1<data>`. Multipliers convert to BTC,
// then to msat (1 BTC = 1e11 msat). Returns null if the invoice has no
// embedded amount or doesn't parse — many invoices are amountless.
export function bolt11AmountMsat(invoice: string): number | null {
  const lower = invoice.toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 4) return null;
  const hrp = lower.slice(0, sep);
  // Longest-match chain prefixes first so `bcrt` doesn't get truncated to `bc`.
  const m = /^ln(?:bcrt|tbs|bc|tb|sb)(\d+)([munp]?)$/.exec(hrp);
  if (!m) return null;
  const digits = Number(m[1]);
  if (!Number.isFinite(digits) || digits <= 0) return null;
  const factors: Record<string, number> = {
    '': 1e11, // BTC
    m: 1e8, // milli-BTC
    u: 1e5, // micro-BTC
    n: 1e2, // nano-BTC (1 sat = 1000 msat = 10n)
    p: 0.1, // pico-BTC
  };
  const factor = factors[m[2] ?? ''];
  if (factor === undefined) return null;
  const msat = Math.round(digits * factor);
  return msat > 0 ? msat : null;
}
