// A structurally valid BOLT11 invoice with a payment hash the caller picks, for
// `check:nwcerror` and `e2e:unconfirmed`. Nothing can pay it: the signature is
// all zeros, so a real node rejects it at once. It exists so a test can name the
// payment hash an LNURL leg will be looked up by, and order the tagged fields to
// put a decoy 52-word field (`s`, `h`) ahead of `p`.
//
// The layout is BOLT 11's: `ln` + network + amount + multiplier, `1`, then 5-bit
// words — a 35-bit timestamp (7 words), tagged fields (type, 10-bit length, data),
// a 65-byte signature (104 words) and the 6-word bech32 checksum. The checksum is
// real, so an independent decoder (light-bolt11-decoder) reads these the same way;
// checked by hand when this file was written (2026-11-18).

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function checksum(hrp, words) {
  const pm = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  return [0, 1, 2, 3, 4, 5].map((i) => (pm >> (5 * (5 - i))) & 31);
}

/** Bytes → 5-bit words, zero-padded at the end (BOLT 11's field encoding). */
export function toWords(bytes) {
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

const hexWords = (hex) => toWords(Buffer.from(hex, 'hex'));

/**
 * @param amountMsat  a multiple of 100 (written with the `n` multiplier)
 * @param fields      in wire order: `{ tag: 'p' | 's' | 'h' | …, hex }` for a
 *                    32-byte field, `{ tag, text }` for a description, or
 *                    `{ tag, words }` to write a field of any length
 */
export function fakeBolt11({ amountMsat = 1_000_000, fields, timestamp = 1_763_400_000 }) {
  if (amountMsat % 100 !== 0) throw new Error('amountMsat must be a multiple of 100');
  const hrp = `lnbc${amountMsat / 100}n`;
  const words = [];
  for (let i = 6; i >= 0; i -= 1) words.push(Math.floor(timestamp / 32 ** i) % 32);
  for (const f of fields) {
    const data = f.words ?? (f.hex !== undefined ? hexWords(f.hex) : toWords(Buffer.from(f.text ?? '', 'utf8')));
    words.push(CHARSET.indexOf(f.tag), data.length >> 5, data.length & 31, ...data);
  }
  words.push(...new Array(104).fill(0));
  return `${hrp}1${[...words, ...checksum(hrp, words)].map((w) => CHARSET[w]).join('')}`;
}
