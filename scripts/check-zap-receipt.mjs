// Pins `zapReceiptAccepts` (lib/nostr/zap-receipt-match.ts) — which kind:9735 a
// boost note is allowed to quote as the receipt for the zap it just paid.
//
// WHAT BREAKS IF THIS IS WRONG. A boost note quotes the receipt this function
// picks, in a kind:1 signed by the user, which no client can edit afterwards.
// Quote the wrong 9735 and the note publishes a stranger's payment as if it
// were this boost — permanently, under the user's own key, with the amount that
// stranger paid rendered by every client that reads the quote. The whole reason
// this app quotes a provider's receipt instead of minting its own is that the
// claim then belongs to the provider; a loose match gives that back.
//
// THE OBVIOUS VERSION IS WRONG, AND IT LOOKS RIGHT. A zap receipt names its
// recipient with a `p` tag, so "the kind:9735 that p-tags the payee" reads like
// the answer. It is `naive()` below. It matches every receipt that provider
// issued to that person — a zap from somebody else a second earlier included —
// and a busy artist on Fountain has many. It also accepts a receipt ANYONE
// published, because a `p` tag is not a signature over anything.
//
// The plausible half-fix is `zapperOnly()`: add the Appendix F pubkey test and
// stop. That closes the forgery and leaves the collision wide open, which is the
// worse of the two — the receipt is real, correctly signed, and about the wrong
// payment, so nothing downstream can tell.
//
// FIXTURE PROVENANCE, STATED PLAINLY, BECAUSE IT IS PART REAL AND PART NOT.
//
// REAL, off a Fountain boost note captured 2026-09-15 (kind:1
// f0416267299d021c78ca35b0ea15cabf9925016d3fe008d162dbf81a0c7850e0, whose body
// carries one `nostr:nevent1…`):
//
//   ZAPPER     b866ce76…67a5  Fountain's zapper key — the pubkey Appendix F
//                             makes a client test a receipt's author against,
//                             and the single most important constant here.
//   RECEIPT_ID 044da649…c59d  that note's quoted kind:9735.
//
// CONSTRUCTED: the receipt's own tag list, the invoice, the payee, and the
// embedded kind:9734. The receipt EVENT could not be fetched — this sandbox has
// no relay or nostr-API egress — so only its identity is real. Do not upgrade
// this paragraph to "captured" without capturing the event itself.
//
// The constructed half is not invented freely. The wire shape is NIP-57
// Appendix E (`p`, `bolt11`, `description`, and the optional `e`, `P`,
// `preimage`, `amount`), cross-checked against the tags this repo already reads
// off real receipts in production — `lib/nostr/zap-receipt.ts` resolves
// `description` → kind:9734 → `pubkey`/`content`/`i`, and
// `zapReceiptAmountMsat` reads `amount` then `bolt11` then the request, with a
// comment recording that Fountain ships no explicit `amount` tag. Vector 9
// exists because of that observation. When the receipt itself can be fetched,
// replace these rather than adding to them.
//
// The vectors are adversarial by construction: each false case is a receipt that
// differs from the true one in exactly one field, which is what gives them teeth
// a round-trip fixture would not have.
import { zapReceiptAccepts, requestIdInDescription } from '../lib/nostr/zap-receipt-match.ts';
import { importFreeProblems } from './import-free.mjs';
import { readFileSync } from 'node:fs';

let failures = 0;
const fail = (m) => { console.error('  ✗ ' + m); failures++; };
const ok = (m) => console.log('  ok    ' + m);

// ── Wrong version 1: a kind:9735 that p-tags the payee ────────────────────
function naive(receipt, expect) {
  return (
    receipt.kind === 9735 &&
    (Array.isArray(receipt.tags) ? receipt.tags : []).some(
      (t) => Array.isArray(t) && t[0] === 'p' && t[1] === expect.recipientPubkey,
    )
  );
}

// ── Wrong version 2: Appendix F's pubkey test, and nothing correlating ─────
function zapperOnly(receipt, expect) {
  return receipt.pubkey === expect.zapperPubkey && naive(receipt, expect);
}

const WRONG = [
  { fn: naive, mark: 'alsoNaive', label: 'naive()' },
  { fn: zapperOnly, mark: 'alsoZapperOnly', label: 'zapperOnly()' },
];

// ── The zap this app sent ─────────────────────────────────────────────────
// REAL: Fountain's zapper key, and the id of a receipt it actually published.
const ZAPPER = 'b866ce76be5b826695980248322b8df4c381608ffa5a5b47c4f3abe0d8f767a5';
const RECEIPT_ID = '044da6499d5db5ee1fe6eac312b6bcf00d5e038c5effa45be1bd50555e7fc59d';
const PAYEE = '3f770d65d3a764a9c5cb503ae123e62ec7598ad035d836e2a810f3877a745b24';
const STRANGER = 'e88a691e98d9987c964521dff60025f60700378a4879180dcbbb4a5027850411';
const REQ_ID = '1b7e5f2c0a9d4e6b8c3f1a5d7e9b2c4a6f8d0e2b4c6a8e0f2d4b6a8c0e2f4d6b';
const OTHER_REQ_ID = '9c4d2e0f8a6b4c2d0e8f6a4b2c0d8e6f4a2b0c8d6e4f2a0b8c6d4e2f0a8b6c4d';
const BOLT11 =
  'lnbc2u1p5n8s9jpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5' +
  'w3jhxapqd9h8vmmfvdjscqzzsxqyz5vqsp5usyc4lk9chsfp53kvcnvq456ganh60d89reyk' +
  'tc5cy3rxjfnlvq9qyyssq';
const OTHER_BOLT11 = BOLT11.replace('lnbc2u1', 'lnbc5u1');
const AMOUNT_MSAT = 200_000;

const EXPECT = {
  zapperPubkey: ZAPPER,
  recipientPubkey: PAYEE,
  requestId: REQ_ID,
  bolt11: BOLT11,
  amountMsat: AMOUNT_MSAT,
};

/** The kind:9734 as a provider echoes it back inside `description`. */
const request = (id, over = {}) =>
  JSON.stringify({
    id,
    pubkey: STRANGER,
    created_at: 1_757_900_000,
    kind: 9734,
    tags: [
      ['relays', 'wss://relay.damus.io', 'wss://nos.lol'],
      ['amount', String(AMOUNT_MSAT)],
      ['lnurl', 'lnurl1dp68gurn8ghj7ampd3kx2ar0veekzar0wd5xjtnrdakj7tnhv4kxctttdehhwm30d3h82unvwqhkzurf9amrztmhv4kxxmmc'],
      ['p', PAYEE],
    ],
    content: 'IRC++',
    sig: 'f'.repeat(128),
    ...over,
  });

/** A receipt with the correct everything, then one field spoiled per vector. */
const receipt = ({ extraTags = [], ...over } = {}) => ({
  kind: 9735,
  // `id` is never read by zapReceiptAccepts — the matcher works on the author and
  // the two correlators. It is carried anyway so the fixture is a whole event
  // rather than the subset one function happens to touch, which is what lets the
  // next person compare it against a real one.
  id: RECEIPT_ID,
  pubkey: ZAPPER,
  created_at: 1_757_900_003,
  content: '',
  tags: [
    ['p', PAYEE],
    ['bolt11', BOLT11],
    ['description', request(REQ_ID)],
    ...extraTags,
  ],
  // `extraTags` is destructured out above, so it can never land on the event as
  // a stray property — which is exactly how three vectors here first tested a
  // tag that was not in `tags` at all, and passed.
  ...over,
});

/** Rebuild the tag list with one tag replaced or removed. */
const withTag = (name, value) => {
  const base = receipt().tags.filter((t) => t[0] !== name);
  return value === null ? base : [...base, [name, value]];
};

const VECTORS = [
  {
    name: 'the receipt for OUR zap: right zapper, right payee, our request, our invoice',
    args: [receipt(), EXPECT],
    expect: true,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'THE COLLISION: same provider, same payee, a DIFFERENT zap one second earlier',
    // The failure both wrong versions ship. Everything about this receipt is
    // real and correctly signed; it is simply about somebody else's payment.
    args: [
      { ...receipt(), tags: [['p', PAYEE], ['bolt11', OTHER_BOLT11], ['description', request(OTHER_REQ_ID)]] },
      EXPECT,
    ],
    expect: false,
  },
  {
    name: 'our request id, but the invoice is not the one we paid',
    args: [{ ...receipt(), tags: withTag('bolt11', OTHER_BOLT11) }, EXPECT],
    expect: false,
  },
  {
    name: 'our invoice, but the description echoes a different request',
    args: [{ ...receipt(), tags: withTag('description', request(OTHER_REQ_ID)) }, EXPECT],
    expect: false,
  },
  {
    name: 'THE FORGERY: anybody may publish a kind:9735 — this one is not the provider’s',
    args: [{ ...receipt(), pubkey: STRANGER }, EXPECT],
    expect: false,
    alsoZapperOnly: true,
  },
  {
    name: 'a receipt that p-tags somebody other than the payee',
    args: [{ ...receipt(), tags: withTag('p', STRANGER) }, EXPECT],
    expect: false,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'NOTHING CORRELATES IT: no description and no bolt11',
    // Appendix E makes both mandatory, so this is malformed — but it is also
    // exactly what an attacker publishes, because those two fields are the only
    // ones they cannot fake past the pubkey test.
    args: [{ ...receipt(), tags: [['p', PAYEE]] }, EXPECT],
    expect: false,
  },
  {
    name: 'a description that is not JSON is a contradiction, not a missing field',
    args: [{ ...receipt(), tags: withTag('description', 'not json at all') }, EXPECT],
    expect: false,
  },
  {
    name: 'a description holding a kind:1 rather than the zap request',
    args: [
      { ...receipt(), tags: withTag('description', request(REQ_ID, { kind: 1 })) },
      EXPECT,
    ],
    expect: false,
  },
  {
    name: 'a description whose id is not a 64-hex event id',
    args: [
      { ...receipt(), tags: withTag('description', request('abc')) },
      EXPECT,
    ],
    expect: false,
  },
  {
    name: 'a description that is a JSON array, not an object',
    args: [{ ...receipt(), tags: withTag('description', '[1,2,3]') }, EXPECT],
    expect: false,
  },
  {
    name: 'an `amount` tag that disagrees with what this leg asked for',
    args: [receipt({ extraTags: [['amount', String(AMOUNT_MSAT * 2)]] }), EXPECT],
    expect: false,
  },
  {
    name: 'MUST STILL WORK: Fountain ships no `amount` tag at all',
    args: [receipt(), EXPECT],
    expect: true,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'MUST STILL WORK: an `amount` tag that agrees',
    args: [receipt({ extraTags: [['amount', String(AMOUNT_MSAT)]] }), EXPECT],
    expect: true,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'MUST STILL WORK: BOLT11 is bech32, so an UPPERCASE invoice is the same invoice',
    args: [{ ...receipt(), tags: withTag('bolt11', BOLT11.toUpperCase()) }, EXPECT],
    expect: true,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'MUST STILL WORK: description correlates it, bolt11 absent',
    args: [{ ...receipt(), tags: withTag('bolt11', null) }, EXPECT],
    expect: true,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'MUST STILL WORK: bolt11 correlates it, description absent',
    args: [{ ...receipt(), tags: withTag('description', null) }, EXPECT],
    expect: true,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'MUST STILL WORK: the optional Appendix E tags ride along',
    args: [
      receipt({
        extraTags: [
          ['P', STRANGER],
          ['e', '2c2f6a1d7b3e9c5a0d8f4b6e2a0c8d4f6b2e0a8c4d6f2b0e8a6c4d2f0b8e6a4c'],
          ['preimage', 'd7e1'.repeat(16)],
        ],
      }),
      EXPECT,
    ],
    expect: true,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'MUST STILL WORK: a provider that re-serializes the request keeps its id',
    args: [
      {
        ...receipt(),
        tags: withTag('description', JSON.stringify(JSON.parse(request(REQ_ID)), Object.keys(JSON.parse(request(REQ_ID))).sort())),
      },
      EXPECT,
    ],
    expect: true,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'a kind that is not 9735 is not a receipt',
    args: [{ ...receipt(), kind: 1 }, EXPECT],
    expect: false,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'HOSTILE SHAPE: tags is not an array',
    args: [{ ...receipt(), tags: 'nope' }, EXPECT],
    expect: false,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'HOSTILE SHAPE: a tag that is not an array sits beside the real ones',
    args: [{ ...receipt(), tags: [null, 42, ['p', PAYEE], ['description', request(REQ_ID)]] }, EXPECT],
    expect: true,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'HOSTILE SHAPE: pubkey is absent',
    args: [{ ...receipt(), pubkey: undefined }, EXPECT],
    expect: false,
    alsoZapperOnly: true,
  },
];

for (const v of VECTORS) {
  let got;
  try {
    got = zapReceiptAccepts(...v.args);
  } catch (e) {
    fail(`${v.name} — THREW (${e?.message ?? e}). Every input here reaches us off a relay.`);
    continue;
  }
  if (got !== v.expect) { fail(`${v.name} — expected ${v.expect}, got ${got}`); continue; }
  const beaten = [];
  let marksOk = true;
  for (const w of WRONG) {
    let agrees;
    try { agrees = w.fn(...v.args) === v.expect; } catch { agrees = false; }
    if (agrees && !v[w.mark]) {
      fail(`${v.name} — ${w.label} passes it too, so this vector proves nothing\n`
        + `          against it. Mark it { ${w.mark}: true } or change the vector.`);
      marksOk = false;
    } else if (!agrees && v[w.mark]) {
      fail(`${v.name} — marked ${w.mark} but ${w.label} FAILS it. The mark is wrong.`);
      marksOk = false;
    } else if (!agrees) {
      beaten.push(w.label);
    }
  }
  if (marksOk) {
    ok(v.name + (beaten.length ? `  (beats ${beaten.join(', ')})` : '  (must-still-work)'));
  }
}

// `requestIdInDescription` has THREE answers and the middle one is the whole
// point: an unreadable description is a contradiction, not a missing field. A
// refactor that collapses null into undefined turns every vector above that
// spoils the description into an accept, and does it silently.
const DESC_STATES = [
  { name: 'no description tag at all is `undefined` (the correlator does not apply)', tags: [['p', PAYEE]], expect: undefined },
  { name: 'an unreadable description is `null` (a contradiction)', tags: [['description', '{[']], expect: null },
  { name: 'a readable request yields its id', tags: [['description', request(REQ_ID)]], expect: REQ_ID },
];
for (const d of DESC_STATES) {
  const got = requestIdInDescription(d.tags);
  if (got === d.expect) ok(d.name);
  else fail(`${d.name} — expected ${String(d.expect)}, got ${String(got)}`);
}

// The module must stay loadable by this script under plain Node, or the next
// person to touch it copies the function in here and the check guards nothing.
const problems = importFreeProblems('lib/nostr/zap-receipt-match.ts');
if (problems.length) {
  fail('lib/nostr/zap-receipt-match.ts is no longer import-free:\n          ' + problems.join('\n          '));
} else {
  ok('lib/nostr/zap-receipt-match.ts is import-free');
}

// ── The wiring no vector can see ──────────────────────────────────────────
// A pure-function pin sees this function and nothing around it. Three call
// sites have to keep holding for it to mean anything, and each fails silently.

// 1. The provider's nostrPubkey is the Appendix F test. lib/v4v/zap.ts read it
//    and threw it away for the life of the live-stream zap path; without it
//    every receipt this function judges is judged on attacker-written data.
const zapSrc = readFileSync('lib/v4v/zap.ts', 'utf8');
if (!/zapperPubkey\s*[:=]\s*meta\.nostrPubkey/.test(zapSrc) || !/zapperPubkey,/.test(zapSrc)) {
  fail('lib/v4v/zap.ts no longer reports the provider’s `nostrPubkey` as `zapperPubkey`.\n'
    + '          The receipt matcher then has nothing to test authorship against and\n'
    + '          any forged kind:9735 that p-tags the payee is quotable.');
} else {
  ok('lib/v4v/zap.ts carries the provider’s nostrPubkey through to the matcher');
}

// 2. The waiter is the only caller. A subscription that stops asking this
//    question quotes the first 9735 it sees.
const waitSrc = readFileSync('lib/nostr/zap-receipt-wait.ts', 'utf8');
if (!/zapReceiptAccepts\(/.test(waitSrc)) {
  fail('lib/nostr/zap-receipt-wait.ts no longer calls zapReceiptAccepts.');
} else {
  ok('the receipt waiter still runs every candidate through the matcher');
}

// 3. The note is why any of this exists. A `q` tag that stops being emitted is
//    invisible from the app — the boost still pays and the note still posts.
const noteSrc = readFileSync('lib/nostr/boost-notes.ts', 'utf8');
if (!/'q',/.test(noteSrc) || !/nostr:\$\{/.test(noteSrc)) {
  fail('lib/nostr/boost-notes.ts no longer writes a `q` tag AND a `nostr:` body\n'
    + '          reference. Fountain reads the body reference; both halves are needed.');
} else {
  ok('the boost note still quotes its receipts in the tags and the body');
}

console.log(failures
  ? `\n${failures} zap-receipt check(s) FAILED.\n`
  : '\nAll zap-receipt checks passed.\n');
process.exit(failures ? 1 : 0);
