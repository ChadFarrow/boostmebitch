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

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/**
 * The payment hash a BOLT11 commits to — its `p` field — as 64 lowercase hex
 * characters, or null when the string is not an invoice with one.
 *
 * An unanswered NWC `pay_invoice` is checked with `lookup_invoice
 * { payment_hash }`, and RETRY pays the SAME invoice, so this is the key a leg
 * that may have paid is asked about by. Read the field by its TAG: `s` (the
 * payment secret) and `h` (the description hash) are 52 words long too, and a
 * writer may put either one first. A `p` that is not 52 words long is skipped,
 * as BOLT 11 tells a reader to.
 *
 * The checksum and signature are not verified: the wallet already took this
 * string as an invoice, and a wrong answer here costs a NOT_FOUND ("your
 * wallet cannot tell"), never a second payment. Pinned by `check:nwcerror`.
 */
export function bolt11PaymentHash(invoice: string): string | null {
  const s = invoice.trim().toLowerCase().replace(/^lightning:/, '');
  const sep = s.lastIndexOf('1');
  if (sep < 4 || !/^ln(?:bcrt|tbs|bc|tb|sb)/.test(s.slice(0, sep))) return null;
  const words: number[] = [];
  for (const ch of s.slice(sep + 1)) {
    const w = BECH32.indexOf(ch);
    if (w < 0) return null;
    words.push(w);
  }
  // 7 words of timestamp, then tagged fields, then a 104-word signature and a
  // 6-word checksum.
  const end = words.length - 104 - 6;
  for (let i = 7; i + 3 <= end;) {
    const tag = words[i];
    const len = words[i + 1] * 32 + words[i + 2];
    const start = i + 3;
    if (start + len > end) return null;
    if (tag === 1 /* p */ && len === 52) {
      const bytes: number[] = [];
      let acc = 0;
      let bits = 0;
      for (const w of words.slice(start, start + 52)) {
        acc = ((acc << 5) | w) & 0xfff;
        bits += 5;
        if (bits >= 8) {
          bits -= 8;
          bytes.push((acc >> bits) & 0xff);
        }
      }
      return bytes.slice(0, 32).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    i = start + len;
  }
  return null;
}
