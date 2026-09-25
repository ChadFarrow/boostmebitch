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
// FIXTURE PROVENANCE. BOTH RECEIPTS ARE REAL, CAPTURED WHOLE.
//
// Two kind:9735 events published by Fountain's zapper, fetched verbatim off
// public relays on 2026-09-16 and embedded below as `RECEIPT_1` / `RECEIPT_2`:
//
//   RECEIPT_1  aeacff06…477b  from relay.damus.io — quoted by the Fountain boost
//              note 4d97826b…22a9 ("IRC++ 2", 100 sats, on Chad and Reeds
//              Podcast, feed guid 7c6f7875-…, the check:vts fixture feed).
//   RECEIPT_2  881b07bc…4567  from relay.fountain.fm — quoted by the Fountain
//              boost note 57b63ba5…d942 ("Tangerine Dream", 123 sats), from a
//              DIFFERENT sender, and signed by the SAME zapper.
//
// That second one is the collision this file exists for, and it is no longer
// constructed: a real receipt, correctly signed by the real provider, about
// somebody else's payment. Both carry `P` (the sender), `preimage`, and the
// NIP-73 `i`/`k` pairs mirrored off the request; neither carries an `amount`
// tag — asserted at load, so the "Fountain ships no amount tag" vector stays
// an observation and not a memory. The embedded kind:9734 of each is the real
// zap request, and `zapRequestTags` is checked by rebuilding those two tag
// lists from the identifiers they carry.
//
// Three keys are still constructed, and only ever as NEGATIVES: `STRANGER`
// (an unrelated pubkey), and the `withTag` spoilers that replace one real
// field at a time. Nothing positive here is invented.
//
// An earlier version of this file carried a CONSTRUCTED receipt around a real
// zapper key and receipt id (044da649…c59d, off note f0416267…50e0), because
// the sandbox it was written in had no relay egress. Its own header said to
// replace it the moment the event could be fetched. This is that replacement.
//
// The vectors are adversarial by construction: each false case is a receipt that
// differs from the true one in exactly one field, which is what gives them teeth
// a round-trip fixture would not have.
import { zapReceiptAccepts, requestIdInDescription, receiptRelayHints } from '../lib/nostr/zap-receipt-match.ts';
import {
  zapRequestTags, nip73Tags, validateSummaryRequest, summaryReceiptTemplate,
  summaryRequestTemplateFromSpec, SUMMARY_MAX_MSAT,
} from '../lib/nostr/zap-request.ts';
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

// ── The two real receipts ─────────────────────────────────────────────────
// Verbatim. Do not edit a field here to make a vector pass — if one fails, the
// code is wrong, not the wire.
const RECEIPT_1 = {
  "content": "",
  "created_at": 1789340695,
  "id": "aeacff064116be8628a88a1d801e5e072a16c2a4c29ee1177cf673890d31477b",
  "kind": 9735,
  "pubkey": "b866ce76be5b826695980248322b8df4c381608ffa5a5b47c4f3abe0d8f767a5",
  "sig": "522fe9391c6c27a2c12cfced67d9dfbfb100a1aa8f1979b3889cc567753bf3ff48d9658ecdf9409e49d0f4b9707aea43a3f485e7005e9efb9a9fab072f627120",
  "tags": [
    [
      "p",
      "b866ce76be5b826695980248322b8df4c381608ffa5a5b47c4f3abe0d8f767a5"
    ],
    [
      "P",
      "f7922a0adb3fa4dda5eecaa62f6f7ee6159f7f55e08036686c68e08382c34788"
    ],
    [
      "description",
      "{\"id\":\"29e8d034cc81d02af1aa8edd11125586cf875026fef19605ea8950f05f32cee9\",\"pubkey\":\"f7922a0adb3fa4dda5eecaa62f6f7ee6159f7f55e08036686c68e08382c34788\",\"created_at\":1789340694,\"kind\":9734,\"content\":\"\",\"tags\":[[\"relays\",\"wss://relay.fountain.fm\",\"wss://relay.primal.net\"],[\"amount\",\"100000\"],[\"p\",\"b866ce76be5b826695980248322b8df4c381608ffa5a5b47c4f3abe0d8f767a5\"],[\"k\",\"podcast:item:guid\"],[\"i\",\"podcast:item:guid:4a8c16bf-2662-4263-9cb7-14d910f2e3e2\",\"https://fountain.fm/episode/G8YZMq5ImH5H98L3BMuy\"],[\"k\",\"podcast:guid\"],[\"i\",\"podcast:guid:7c6f7875-2b73-491e-b32c-e2c8d6e91d53\",\"https://fountain.fm/show/IFLdE3GAAG8B4knvF48F\"]],\"sig\":\"4e9e448ca47d90b7c56af1c72441f6e08f882d6e730e813d41a2c284bdc80a6bb34b275bd7a03a1b8983bfaf525f9f8d8cbe40833dcac0b1441f49d664a4a76e\"}"
    ],
    [
      "bolt11",
      "lnbc1u1p42wtqkpp5u0zttgcmxhq0qgtzn5lgpu8czwpj8nlh723uj26cdjg8p5f403lqdql2p85gs6p2d297kjp2p05jnjkfay5x3gcqzysxqzpusp5zrtq0ck5kefy3kzlqz22c3sun894sdcn5dhmh3f02gvwmjvea3zq9qxpqysgq4wqcgmxut60c20ejrf3ghycj8cjjuqq50xd66j7a4gun2zrvn48re8su2v4t38ym54dqjye8je9trr20ss3g8ncck9kkzw68t36qufcp088xrq"
    ],
    [
      "preimage",
      "cb78cd7ba97900385abd9d17768140e53290c562d8e534addcf5a59157d1f014"
    ],
    [
      "i",
      "podcast:item:guid:4a8c16bf-2662-4263-9cb7-14d910f2e3e2",
      "https://fountain.fm/episode/G8YZMq5ImH5H98L3BMuy"
    ],
    [
      "i",
      "podcast:guid:7c6f7875-2b73-491e-b32c-e2c8d6e91d53",
      "https://fountain.fm/show/IFLdE3GAAG8B4knvF48F"
    ],
    [
      "k",
      "podcast:item:guid"
    ],
    [
      "k",
      "podcast:guid"
    ]
  ]
};

const RECEIPT_2 = {
  "id": "881b07bc7ca11abb0fbd52099cef79fdff77ce779a5af0c752982ebe93ef4567",
  "pubkey": "b866ce76be5b826695980248322b8df4c381608ffa5a5b47c4f3abe0d8f767a5",
  "created_at": 1789368708,
  "kind": 9735,
  "content": "",
  "tags": [
    [
      "p",
      "b866ce76be5b826695980248322b8df4c381608ffa5a5b47c4f3abe0d8f767a5"
    ],
    [
      "P",
      "50a63cca15b16b60d329b92f628c432c8c12689b40fe9d0495eb836b5f2df637"
    ],
    [
      "description",
      "{\"id\":\"ca6c7813aa0a93a16bf443187752f34bd1d8e6fb8e5265b5d6f3d1893aed91ed\",\"pubkey\":\"50a63cca15b16b60d329b92f628c432c8c12689b40fe9d0495eb836b5f2df637\",\"created_at\":1789368705,\"kind\":9734,\"content\":\"\",\"tags\":[[\"relays\",\"wss://relay.fountain.fm\",\"wss://relay.primal.net\"],[\"amount\",\"123000\"],[\"p\",\"b866ce76be5b826695980248322b8df4c381608ffa5a5b47c4f3abe0d8f767a5\"],[\"k\",\"podcast:item:guid\"],[\"i\",\"podcast:item:guid:fcfc450b-6ad0-4c5e-8105-cfce888c1ef4\",\"https://fountain.fm/episode/G1FnV9nGkEofRph05FOA\"],[\"k\",\"podcast:guid\"],[\"i\",\"podcast:guid:ac746d09-7c3b-5bcd-b28a-f12d6456ca8f\",\"https://fountain.fm/show/aqJxt5Pt6jLIvQX7OI7P\"]],\"sig\":\"033a1c59b7add88115d71f7c8fd2f782b5a9ab0d625bfd403e29a351cd7ceffdcf4170f2c79f50898e0759d3e9eb8990e82ca9e8c5936bfb07f2edc4f0a125b7\"}"
    ],
    [
      "bolt11",
      "lnbc1230n1p420xvrpp5att6s7hkhzga9cyp2jclxjnmagu2nh688an7axq82d6fujtv3kgsdql2p85gs6p2d297kjp2p05jnjkfay5x3gcqzysxqzpusp5yjgx6lufesfyef2zv94pjnr8agjau36y6fqy6qjcsfxyx5ggjc6s9qxpqysgqsgpe498mjrcu8hafgqm9mxs52958th3kq8e4fl2ds5yxajrtpqxk0w4n0j5y5fwszaw5gem07grpu6cx0gz3nx7epd0gnwsj0wp4kjsq6j7h0c"
    ],
    [
      "preimage",
      "db1f9abf7b8a6f045ced4bd893ccb4e5c34707dad3628bfec816a7a8a37ff799"
    ],
    [
      "i",
      "podcast:item:guid:fcfc450b-6ad0-4c5e-8105-cfce888c1ef4",
      "https://fountain.fm/episode/G1FnV9nGkEofRph05FOA"
    ],
    [
      "i",
      "podcast:guid:ac746d09-7c3b-5bcd-b28a-f12d6456ca8f",
      "https://fountain.fm/show/aqJxt5Pt6jLIvQX7OI7P"
    ],
    [
      "k",
      "podcast:item:guid"
    ],
    [
      "k",
      "podcast:guid"
    ]
  ],
  "sig": "6aff92c3f279294668a6897b76eb27857942aed5f7f5db8dc24651b23740504f4e3efc1a5076d24ed70cdf27abe8c48d85147694703d2cf1d3c1f2d1899c6f7e"
};

const tagOf = (ev, name) => ev.tags.find((t) => t[0] === name);
const requestOf = (ev) => JSON.parse(tagOf(ev, 'description')[1]);

// Everything below is READ off the receipts, never typed in.
const ZAPPER = RECEIPT_1.pubkey;                       // b866ce76… Fountain's zapper key
const RECEIPT_ID = RECEIPT_1.id;
// Fountain writes its OWN zapper key as the zap request's `p` — the payee and
// the signer are the same pubkey on both receipts, from two senders. That is
// the shape a zap takes when NIP-05 names nobody and the provider's
// nostrPubkey stands in, and this is what pins that the matcher accepts it.
const PAYEE = tagOf(RECEIPT_1, 'p')[1];
const REAL_REQUEST = requestOf(RECEIPT_1);
const REQ_ID = REAL_REQUEST.id;                        // 29e8d034…
const SENDER = REAL_REQUEST.pubkey;                    // f7922a0a… the note author
const BOLT11 = tagOf(RECEIPT_1, 'bolt11')[1];          // lnbc1u1… = 100 sats
const AMOUNT_MSAT = Number(tagOf(REAL_REQUEST, 'amount')[1]);
const OTHER_REQUEST = requestOf(RECEIPT_2);
const OTHER_REQ_ID = OTHER_REQUEST.id;                 // ca6c7813…
const OTHER_BOLT11 = tagOf(RECEIPT_2, 'bolt11')[1];    // lnbc1230n1… = 123 sats
const OTHER_AMOUNT_MSAT = Number(tagOf(OTHER_REQUEST, 'amount')[1]);
// The one constructed key. Unrelated to everything above; only ever a negative.
const STRANGER = 'e88a691e98d9987c964521dff60025f60700378a4879180dcbbb4a5027850411';

// Provenance ties, checked rather than remembered. The note 4d97826b…22a9
// quotes exactly this receipt (its body nevent decodes to this id), and
// Appendix E's `P` tag names the sender — which is the note's author.
const QUOTED_BY_NOTE = 'aeacff064116be8628a88a1d801e5e072a16c2a4c29ee1177cf673890d31477b';
if (RECEIPT_ID !== QUOTED_BY_NOTE) {
  fail(`RECEIPT_1 is ${RECEIPT_ID}, not the receipt the Fountain note quotes (${QUOTED_BY_NOTE})`);
} else {
  ok('RECEIPT_1 is the receipt the captured Fountain note quotes');
}
if (tagOf(RECEIPT_1, 'P')?.[1] !== SENDER) {
  fail('RECEIPT_1’s `P` tag does not name the zap request’s author (Appendix E: P is the sender)');
} else {
  ok('RECEIPT_1’s `P` tag names the sender, per Appendix E');
}
if (PAYEE !== ZAPPER || RECEIPT_2.pubkey !== ZAPPER || tagOf(RECEIPT_2, 'p')[1] !== ZAPPER) {
  fail('the two captured receipts no longer share one zapper/payee key — re-read the header');
}
if (tagOf(RECEIPT_1, 'amount') || tagOf(RECEIPT_2, 'amount')) {
  fail('a captured Fountain receipt carries an `amount` tag; the "ships no amount tag" vector is stale');
}
if (AMOUNT_MSAT !== 100_000 || OTHER_AMOUNT_MSAT !== 123_000) {
  fail(`captured amounts read ${AMOUNT_MSAT} / ${OTHER_AMOUNT_MSAT} msat; expected 100000 / 123000`);
}

const EXPECT = {
  zapperPubkey: ZAPPER,
  recipientPubkey: PAYEE,
  requestId: REQ_ID,
  bolt11: BOLT11,
  amountMsat: AMOUNT_MSAT,
};
const EXPECT_2 = {
  zapperPubkey: ZAPPER,
  recipientPubkey: PAYEE,
  requestId: OTHER_REQ_ID,
  bolt11: OTHER_BOLT11,
  amountMsat: OTHER_AMOUNT_MSAT,
};

/** The real kind:9734, re-serialized with one field overridden. */
const request = (id, over = {}) => JSON.stringify({ ...REAL_REQUEST, id, ...over });

/** The real receipt, with optional extra tags and one-field overrides. */
const receipt = ({ extraTags = [], ...over } = {}) => ({
  ...RECEIPT_1,
  tags: [...RECEIPT_1.tags, ...extraTags],
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
    name: 'THE COLLISION: a REAL second receipt — same provider, same payee, somebody else’s zap',
    // The failure both wrong versions ship, and it is no longer constructed:
    // RECEIPT_2 is a real event, correctly signed by the real provider, about a
    // different sender's payment eight hours later.
    args: [RECEIPT_2, EXPECT],
    expect: false,
  },
  {
    name: 'THE COLLISION, mirrored: the first receipt against the second zap’s expectation',
    args: [RECEIPT_1, EXPECT_2],
    expect: false,
  },
  {
    name: 'MUST STILL WORK: the second real receipt is accepted for its own zap',
    args: [RECEIPT_2, EXPECT_2],
    expect: true,
    alsoNaive: true,
    alsoZapperOnly: true,
  },
  {
    name: 'MUST STILL WORK: the payee IS the zapper (Fountain writes its own key as `p`)',
    // The shape a zap takes when NIP-05 names nobody and the provider's
    // nostrPubkey stands in. Real on both receipts.
    args: [receipt(), { ...EXPECT, recipientPubkey: ZAPPER }],
    expect: true,
    alsoNaive: true,
    alsoZapperOnly: true,
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
    name: 'MUST STILL WORK: Fountain ships no `amount` tag at all (asserted on both captures above)',
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
    name: 'MUST STILL WORK: an `e` tag rides along (the real receipt already carries P, preimage, i, k)',
    args: [
      receipt({
        extraTags: [
          ['e', '2c2f6a1d7b3e9c5a0d8f4b6e2a0c8d4f6b2e0a8c4d6f2b0e8a6c4d2f0b8e6a4c'],
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

// ── zapRequestTags: the kind:9734 tag list, against both real requests ───────
// The recipient's server mirrors these tags onto the receipt the note quotes,
// so the builder is checked by REBUILDING Fountain's own tag lists from the
// identifiers they carry — byte for byte, both requests. Fountain sends no
// `lnurl` tag; the builder emits one only when handed one, so the comparison
// is made without it.
console.log('\nzapRequestTags — rebuilds both captured Fountain requests');

/** Read a request's NIP-73 identifiers back out, the way lib/nostr/zap-receipt.ts does. */
function refsOf(req) {
  const i = (prefix) => req.tags.find((t) => t[0] === 'i' && t[1].startsWith(prefix));
  const item = i('podcast:item:guid:');
  const show = i('podcast:guid:');
  return {
    episodeGuid: item?.[1].slice('podcast:item:guid:'.length),
    episodeUrl: item?.[2],
    podcastGuid: show?.[1].slice('podcast:guid:'.length),
    podcastUrl: show?.[2],
  };
}
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(name);
  else fail(`${name}\n          expected ${e}\n          actual   ${a}`);
};

for (const [label, req] of [['RECEIPT_1', REAL_REQUEST], ['RECEIPT_2', OTHER_REQUEST]]) {
  eq(`${label}: the real request's tag list is rebuilt exactly from its own identifiers`,
    zapRequestTags({
      relays: tagOf(req, 'relays').slice(1),
      amountMsat: Number(tagOf(req, 'amount')[1]),
      recipientPubkey: tagOf(req, 'p')[1],
      refs: refsOf(req),
    }),
    req.tags);
}

const REFS = refsOf(REAL_REQUEST);
const BASE = { relays: ['wss://relay.damus.io'], amountMsat: 21_000, recipientPubkey: ZAPPER };
eq('no refs → relays, amount, p and nothing else',
  zapRequestTags(BASE), [['relays', 'wss://relay.damus.io'], ['amount', '21000'], ['p', ZAPPER]]);
eq('`lnurl` sits between amount and p when given (NIP-57 Appendix A order)',
  zapRequestTags({ ...BASE, lnurl: 'lnurl1abc' }).map((t) => t[0]), ['relays', 'amount', 'lnurl', 'p']);
eq('`e` and `a` follow p and precede the NIP-73 pairs',
  zapRequestTags({ ...BASE, eventId: 'f'.repeat(64), aTag: '30311:x:y', refs: REFS }).map((t) => t[0]),
  ['relays', 'amount', 'p', 'e', 'a', 'k', 'i', 'k', 'i']);
eq('item first, then show; `k` before its `i` — Fountain’s order',
  nip73Tags(REFS).map((t) => t[0] + ':' + t[1].replace(/^(podcast:(?:item:)?guid).*$/, '$1')),
  ['k:podcast:item:guid', 'i:podcast:item:guid', 'k:podcast:guid', 'i:podcast:guid']);
eq('a show with no item emits only the show pair',
  nip73Tags({ podcastGuid: REFS.podcastGuid }), [['k', 'podcast:guid'], ['i', `podcast:guid:${REFS.podcastGuid}`]]);
eq('an item with no show emits only the item pair',
  nip73Tags({ episodeGuid: 'abc' }), [['k', 'podcast:item:guid'], ['i', 'podcast:item:guid:abc']]);
eq('no URL → no third element, not an empty string',
  nip73Tags({ podcastGuid: 'g' }), [['k', 'podcast:guid'], ['i', 'podcast:guid:g']]);
eq('a hint that is not http(s) is dropped, never written',
  nip73Tags({ podcastGuid: 'g', podcastUrl: 'javascript:alert(1)' }), [['k', 'podcast:guid'], ['i', 'podcast:guid:g']]);
eq('a guid is trimmed; an all-whitespace guid emits nothing',
  nip73Tags({ podcastGuid: ' g ', episodeGuid: '   ' }), [['k', 'podcast:guid'], ['i', 'podcast:guid:g']]);
eq('undefined refs emit nothing', nip73Tags(undefined), []);
if (zapRequestTags({ ...BASE, refs: REFS }).some((t) => t[0] === 'client')) {
  fail('zapRequestTags writes a `client` tag — the recipient’s LNURL server reads this event');
} else {
  ok('no `client` tag on the zap request');
}

// The obvious wrong builders. Each is what shipped, or was proposed, once.
const noRefs = (a) => zapRequestTags({ ...a, refs: undefined });                 // the PR as first written
const iWithoutK = (r) => nip73Tags(r).filter((t) => t[0] !== 'k');               // "k is redundant"
const hintOnK = (r) => nip73Tags(r).map((t) => (t[0] === 'k' ? [...t, r.podcastUrl] : t.slice(0, 2)));
const naiveTagsCaught = [
  ['omitting the NIP-73 pairs cannot rebuild Fountain’s request',
    JSON.stringify(noRefs({ relays: tagOf(REAL_REQUEST, 'relays').slice(1), amountMsat: AMOUNT_MSAT, recipientPubkey: PAYEE, refs: REFS })) !== JSON.stringify(REAL_REQUEST.tags)],
  ['`i` without `k` is not the wire shape',
    JSON.stringify(iWithoutK(REFS)) !== JSON.stringify(nip73Tags(REFS))],
  ['a hint on `k` instead of `i` is not the wire shape',
    JSON.stringify(hintOnK(REFS)) !== JSON.stringify(nip73Tags(REFS))],
];
for (const [name, caught] of naiveTagsCaught) {
  if (caught) ok('rejected: ' + name);
  else fail('a wrong builder survives: ' + name);
}

// ── receiptRelayHints: the hint names a relay that HOLDS the receipt ───────
// The first production boost (note 0be1c9a5…, 2026-09-16) asked its provider
// for seven relays, the user's own write relay first; Alby's receipt landed on
// four of them and not the first, and the `q` tag's hint named the first. These
// are those seven, and the four measured to hold the receipt.
console.log('\nreceiptRelayHints — deliver before request, three at most');
const ASKED = ['wss://podtards.com', 'wss://chadf.nostr1.com', 'wss://relay.damus.io', 'wss://hist.nostr.land', 'wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.fountain.fm'];
const HELD = ['wss://relay.fountain.fm', 'wss://relay.primal.net', 'wss://nos.lol', 'wss://chadf.nostr1.com'];
eq('the production case: the delivering relays lead, the asked-for tail follows',
  receiptRelayHints(HELD.slice(0, 1), ASKED), ['wss://relay.fountain.fm', 'wss://podtards.com', 'wss://chadf.nostr1.com']);
eq('every delivering relay outranks every merely-asked one',
  receiptRelayHints(HELD, ASKED), HELD.slice(0, 3));
eq('nothing delivered yet → the request’s own order, so a hint still exists',
  receiptRelayHints([], ASKED), ASKED.slice(0, 3));
eq('a relay seen in both lists is written once', receiptRelayHints(['wss://nos.lol'], ['wss://nos.lol', 'wss://a.example']), ['wss://nos.lol', 'wss://a.example']);
eq('non-wss and non-string entries are dropped',
  receiptRelayHints([null, 'ws://plain.example', 42], ['https://not-a-relay.example', 'wss://ok.example']), ['wss://ok.example']);
eq('empty in, empty out', receiptRelayHints([], []), []);
// The dedupe bug the first test note showed (b88137ca…): nostr-tools spells the
// delivering relay with a trailing slash, the request without, and a string
// compare wrote the same relay twice with podtards.com back in slot two.
eq('a delivering relay spelled with a trailing slash is the SAME relay as the request’s',
  receiptRelayHints(['wss://chadf.nostr1.com/'], ASKED),
  ['wss://chadf.nostr1.com', 'wss://podtards.com', 'wss://relay.damus.io']);
eq('hints are written without the trailing slash, however they arrived',
  receiptRelayHints(['wss://relay.primal.net/'], []), ['wss://relay.primal.net']);
eq('case and surrounding whitespace do not make a second relay',
  receiptRelayHints([' wss://NOS.lol/ '], ['wss://nos.lol']), ['wss://nos.lol']);
eq('a bare scheme is not a relay', receiptRelayHints(['wss://', 'wss:///'], []), []);
if (receiptRelayHints(['wss://chadf.nostr1.com/'], ASKED).filter((r) => r.includes('chadf')).length !== 1) {
  fail('receiptRelayHints still writes a relay twice when the two lists spell it differently');
} else {
  ok('rejected: exact-string dedupe (the same relay twice, from note b88137ca…)');
}
if (JSON.stringify(ASKED.slice(0, 3)) === JSON.stringify(receiptRelayHints(HELD.slice(0, 1), ASKED))) {
  fail('receiptRelayHints is `requested.slice(0, 3)` — the hint points at a relay without the receipt');
} else {
  ok('rejected: `request.relays.slice(0, 3)` (the hint that pointed at podtards.com)');
}

// ── The summary receipt: validateSummaryRequest / summaryReceiptTemplate ──
// The site signs ONE kind:9735 for the sats a boost paid, derived from a
// kind:9734 the sender (or the site) signed, and the boost note quotes it —
// because Fountain renders the FIRST quoted receipt's amount and a client-side
// split never yields a provider receipt for the whole (lib/nostr/zap-request.ts).
// The rules below are what stands between an unauthenticated POST and a
// receipt under the site's key. Fountain's own real request is the must-accept
// vector, with Fountain's key standing in as the site.
console.log('\nsummary receipt — what the site will and will not sign');

const SITE = ZAPPER;                       // Fountain's key stands in as "the site"
const T = REAL_REQUEST.created_at;
const valid = validateSummaryRequest(REAL_REQUEST, SITE, T);
eq('MUST STILL WORK: Fountain’s own real request passes the rules, its key as the site', valid.ok, true);
if (valid.ok) {
  eq('the request comes back rebuilt from exactly its seven fields',
    Object.keys(valid.request).sort(), ['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags']);
  eq('a stray field a caller appended never reaches the description',
    Object.keys(validateSummaryRequest({ ...REAL_REQUEST, evil: 'x' }, SITE, T).request ?? {}).includes('evil'), false);
  const tpl = summaryReceiptTemplate(valid.request, SITE, T + 3);
  eq('the receipt is a kind:9735 with empty content', [tpl.kind, tpl.content], [9735, '']);
  eq('`p` is the site and `P` is the sender — Fountain’s shape', [tagOf(tpl, 'p')[1], tagOf(tpl, 'P')[1]], [SITE, REAL_REQUEST.pubkey]);
  eq('`p` and `P` match the REAL receipt Fountain published for this request',
    [tagOf(tpl, 'p')[1], tagOf(tpl, 'P')[1]], [tagOf(RECEIPT_1, 'p')[1], tagOf(RECEIPT_1, 'P')[1]]);
  // Key order differs between our serializer and Fountain's, and the id is a
  // hash over a canonical form that ignores it — so compare with sorted keys.
  const canon = (o) => JSON.stringify(o, Object.keys(o).sort());
  eq('`description` is the request, field-for-field equal to the real receipt’s',
    canon(JSON.parse(tagOf(tpl, 'description')[1])), canon(JSON.parse(tagOf(RECEIPT_1, 'description')[1])));
  eq('the NIP-73 pairs are mirrored onto the receipt, as Fountain’s server mirrors them',
    tpl.tags.filter((t) => t[0] === 'i' || t[0] === 'k').map((t) => t.join('|')).sort(),
    RECEIPT_1.tags.filter((t) => t[0] === 'i' || t[0] === 'k').map((t) => t.join('|')).sort());
  eq('`amount` rides on the receipt (Appendix E’s optional tag; our reader takes it first)',
    tagOf(tpl, 'amount')[1], String(AMOUNT_MSAT));
  eq('no bolt11 and no preimage — there is no invoice for the whole, and none is minted',
    [tagOf(tpl, 'bolt11'), tagOf(tpl, 'preimage')], [undefined, undefined]);
  eq('no `e`, no `client`, no prose can reach the receipt', tpl.tags.some((t) => ['e', 'client'].includes(t[0])), false);
}

const withTags = (tags) => ({ ...REAL_REQUEST, tags });
const reject = (name, input, reason) => {
  const r = validateSummaryRequest(input, SITE, T);
  if (r.ok) fail(`${name} — ACCEPTED, must refuse`);
  else if (reason && !r.reason.includes(reason)) fail(`${name} — refused for "${r.reason}", expected "${reason}"`);
  else ok(`refused: ${name} (${r.reason})`);
};
reject('`p` that is not the site', withTags(REAL_REQUEST.tags.map((t) => (t[0] === 'p' ? ['p', STRANGER] : t))), 'site key');
reject('two `p` tags', withTags([...REAL_REQUEST.tags, ['p', STRANGER]]), 'site key');
reject('an `e` tag — the receipt would look like a zap on somebody’s note', withTags([...REAL_REQUEST.tags, ['e', 'f'.repeat(64)]]), 'unsupported');
reject('a `client` tag', withTags([...REAL_REQUEST.tags, ['client', 'x']]), 'unsupported');
reject('an amount that is not whole sats', withTags(REAL_REQUEST.tags.map((t) => (t[0] === 'amount' ? ['amount', '100500'] : t))), 'range');
reject('an amount over the ceiling', withTags(REAL_REQUEST.tags.map((t) => (t[0] === 'amount' ? ['amount', String(SUMMARY_MAX_MSAT + 1000)] : t))), 'range');
reject('no amount at all', withTags(REAL_REQUEST.tags.filter((t) => t[0] !== 'amount')), 'amount');
reject('prose in content — that is the other oracle’s risk, not this one’s', { ...REAL_REQUEST, content: 'hello' }, 'content');
reject('a request from the future', { ...REAL_REQUEST, created_at: T + 3600 }, 'range');
reject('a request from the past', { ...REAL_REQUEST, created_at: T - 3600 }, 'range');
reject('no relays tag', withTags(REAL_REQUEST.tags.filter((t) => t[0] !== 'relays')), 'relays');
reject('a non-wss relay', withTags(REAL_REQUEST.tags.map((t) => (t[0] === 'relays' ? ['relays', 'http://evil.example'] : t))), 'relays');
reject('an `i` with no matching `k`', withTags(REAL_REQUEST.tags.filter((t) => t[0] !== 'k')), 'i without k');
reject('an `i` hint that is not http(s)', withTags(REAL_REQUEST.tags.map((t) => (t[0] === 'i' ? [t[0], t[1], 'javascript:alert(1)'] : t))), 'hint');
reject('an `i` outside the podcast namespace', withTags(REAL_REQUEST.tags.map((t) => (t[0] === 'i' && t[1].startsWith('podcast:guid:') ? ['i', 'isbn:123'] : t))), 'i tag');
reject('a kind:1', { ...REAL_REQUEST, kind: 1 }, 'zap request');
reject('a malformed sig', { ...REAL_REQUEST, sig: 'zz' }, 'sig');
reject('not an object', 'nope', 'event');
reject('too many tags', withTags(Array.from({ length: 17 }, () => ['k', 'podcast:guid'])), 'tags');

// The site-authored request, from a spec (signed out / Anonymous). Built by the
// leaf so nothing a caller sends reaches the tags except three facts.
const spec = summaryRequestTemplateFromSpec(
  { amountMsat: 100_000, relays: ['wss://nos.lol', 'wss://nos.lol', 'http://evil', 'wss://relay.damus.io'], refs: refsOf(REAL_REQUEST) },
  SITE, T,
);
eq('a spec builds a kind:9734 with empty content', [spec?.kind, spec?.content], [9734, '']);
eq('relays are deduped and non-wss ones dropped', tagOf(spec, 'relays').slice(1), ['wss://nos.lol', 'wss://relay.damus.io']);
eq('the spec’s `p` is the site', tagOf(spec, 'p')[1], SITE);
eq('the spec’s refs come out as the same pairs Fountain’s request carries',
  spec.tags.filter((t) => t[0] === 'i' || t[0] === 'k'), REAL_REQUEST.tags.filter((t) => t[0] === 'i' || t[0] === 'k'));
eq('a spec-built request passes the same rules a sender-signed one does',
  validateSummaryRequest({ ...spec, id: 'a'.repeat(64), pubkey: SITE, sig: 'b'.repeat(128) }, SITE, T).ok, true);
eq('a spec with a fractional-sat amount is refused', summaryRequestTemplateFromSpec({ amountMsat: 100_500, relays: ['wss://x.example'] }, SITE, T), null);
eq('a spec over the ceiling is refused', summaryRequestTemplateFromSpec({ amountMsat: SUMMARY_MAX_MSAT + 1000, relays: ['wss://x.example'] }, SITE, T), null);
eq('a spec with no usable relay is refused', summaryRequestTemplateFromSpec({ amountMsat: 1000, relays: ['http://x.example'] }, SITE, T), null);
eq('a spec cannot smuggle tags', summaryRequestTemplateFromSpec({ amountMsat: 1000, relays: ['wss://x.example'], tags: [['e', 'f'.repeat(64)]] }, SITE, T).tags.some((t) => t[0] === 'e'), false);
eq('garbage is null', summaryRequestTemplateFromSpec('x', SITE, T), null);

// The obvious wrong oracle: sign whatever receipt tags the caller sends.
const naiveOracle = (tags) => ({ kind: 9735, tags });
if (naiveOracle([['p', STRANGER], ['P', STRANGER], ['amount', '999999999999']]).tags.some((t) => t[0] === 'P' && t[1] === STRANGER)) {
  ok('rejected: a template oracle would sign a receipt naming any sender for any amount');
} else {
  fail('the naive comparison is broken');
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
for (const leaf of ['lib/nostr/zap-receipt-match.ts', 'lib/nostr/zap-request.ts']) {
  const problems = importFreeProblems(leaf);
  if (problems.length) {
    fail(`${leaf} is no longer import-free:\n          ` + problems.join('\n          '));
  } else {
    ok(`${leaf} is import-free`);
  }
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

// 2b. The waiter names the DELIVERING relay. Without `trackRelays` the pool
//     records nothing in `seenOn`, and the helper silently degrades to the
//     request's order — the shipped bug, with a green build.
if (!/trackRelays\s*=\s*true/.test(waitSrc) || !/receiptRelayHints\(/.test(waitSrc) || !/seenOn\.get\(/.test(waitSrc)) {
  fail('lib/nostr/zap-receipt-wait.ts no longer tracks which relay delivered the receipt (trackRelays + seenOn → receiptRelayHints).');
} else {
  ok('the receipt waiter records the delivering relay and hints with it');
}

// 3. The tag list `sendZap` signs is the pinned builder, with the refs the
//    caller handed in — not a hand-written array beside it. And no `client`
//    tag reaches the 9734 by any other route.
if (!/zapRequestTags\(/.test(zapSrc) || !/refs:\s*args\.refs/.test(zapSrc)) {
  fail('lib/v4v/zap.ts no longer builds the kind:9734 tags through zapRequestTags with args.refs.');
} else if (/clientTag\(/.test(zapSrc)) {
  fail('lib/v4v/zap.ts calls clientTag — the recipient’s LNURL server reads the 9734 before any relay.');
} else {
  ok('lib/v4v/zap.ts signs the pinned tag list and carries the caller’s refs');
}
// 4. A value-block leg is NEVER a zap. It is a Podcasting 2.0 payment and
//    carries PC 2.0 metadata: the boostagram in TLV 7629169 on a keysend, the
//    BoostBox descriptor in the LUD-21 comment on LNURL. #402 paid qualifying
//    legs as NIP-57 zaps — a BOLT11 with neither — and a recipient's Helipad
//    showed "33 sats from Lightning Invoice" and nothing else (2026-09-25). The
//    note's ⚡ figure is the site-signed summary receipt, which needs no zap
//    leg. So no `sendBoost` caller may hand in a zap table, and the payment
//    engine must not reach the zap module at all.
for (const f of ['components/boost-modal/index.tsx', 'components/boost-all-modal.tsx', 'lib/v4v/streaming.ts']) {
  const src = readFileSync(f, 'utf8');
  if (/^\s*zap(Refs)?\s*:/m.test(src)) {
    fail(`${f}: a sendBoost call passes \`zap:\`/\`zapRefs:\` — value-block legs must pay by keysend or LNURL.`);
  } else {
    ok(`${f}: no sendBoost call routes a leg as a zap`);
  }
}
{
  const engine = readFileSync('lib/v4v/boost.ts', 'utf8');
  if (/import\(\s*['"]\.\/zap['"]\s*\)|from\s+['"]\.\/zap['"]|sendZap\s*\(/.test(engine)) {
    fail('lib/v4v/boost.ts reaches the zap module — payOne must not pay a value-block leg as a zap.');
  } else {
    ok('lib/v4v/boost.ts never reaches the zap module');
  }
}

// 4b. The oracle derives the receipt; it never signs caller-supplied tags. And
//     site-sign lets a site-published note quote ONE event, only if the site
//     authored it — the `q` rule that keeps that oracle from becoming an `e`.
const oracleSrc = readFileSync('app/api/nostr/zap-receipt-sign/route.ts', 'utf8');
for (const must of ['verifyEvent(', 'validateSummaryRequest(', 'summaryReceiptTemplate(', 'summaryRequestTemplateFromSpec(']) {
  if (!oracleSrc.includes(must)) fail(`app/api/nostr/zap-receipt-sign/route.ts no longer calls ${must}`);
}
if (/finalizeEvent\(\s*(body|input|checked\.request)\b/.test(oracleSrc)) {
  fail('zap-receipt-sign signs something the caller sent — it must only sign templates the leaf built');
} else {
  ok('zap-receipt-sign derives every receipt from a validated request');
}
const siteSignSrc = readFileSync('app/api/nostr/site-sign/route.ts', 'utf8');
if (!/'q'/.test(siteSignSrc) || !/author !== site/.test(siteSignSrc) || !/MAX_Q_TAGS = 1/.test(siteSignSrc)) {
  fail('site-sign no longer bounds `q` to ONE tag authored by the site’s own key.');
} else {
  ok('site-sign allows one `q`, and only one authored by the site');
}
const mintSrc = readFileSync('lib/nostr/zap-summary-receipt.ts', 'utf8');
if (!/acceptedRelays\.length === 0\) return null/.test(mintSrc)) {
  fail('mintSummaryReceipt quotes a receipt no relay accepted.');
} else {
  ok('mintSummaryReceipt quotes nothing when no relay took the receipt');
}
for (const f of ['components/boost-modal/index.tsx', 'components/boost-all-modal.tsx']) {
  const src = readFileSync(f, 'utf8');
  if (!/mintSummaryReceipt\(/.test(src)) fail(`${f} no longer mints the summary receipt.`);
  else if (/mintSummaryReceipt\(\{[^}]*\}\)/s.test(src) && !/as: identity && shareAs === 'self'/.test(src)) {
    fail(`${f} does not choose the request's author by the note's signer.`);
  } else ok(`${f} mints the summary receipt, self or site, by the note's signer`);
}

// 5. The note is why any of this exists, and the quote is BOTH forms of ONE receipt.
//    A `q` tag that stops being emitted is invisible from the app — the boost
//    still pays and the note still posts. And a `nostr:nevent…` line that
//    comes BACK is the regression the first production boost showed: every
//    general client unfurls a body reference into an embedded zap card under
//    the note, one per leg. Fountain reads the tag; nobody needs the body.
//    Fountain lists a note off the `q` tag and draws its ⚡ figure off the BODY
//    reference (measured: notes 918e7cd0… and b88137ca…, 2026-09-16), so both
//    are written — for the summary receipt only. The body line is the one card
//    a general client renders, and there is exactly one of it.
const noteSrc = readFileSync('lib/nostr/boost-notes.ts', 'utf8');
if (!/'q',/.test(noteSrc) || !/nostr:\$\{/.test(noteSrc)) {
  fail('lib/nostr/boost-notes.ts must write BOTH a `q` tag and a `nostr:nevent…` body reference for the summary receipt.');
} else if (!/args\.summaryReceipt \? \[args\.summaryReceipt\] : \[\]/.test(noteSrc)) {
  fail('lib/nostr/boost-notes.ts quotes something other than the ONE summary receipt.');
} else {
  ok('the boost note quotes exactly one receipt, in the tag and in the body');
}

console.log(failures
  ? `\n${failures} zap-receipt check(s) FAILED.\n`
  : '\nAll zap-receipt checks passed.\n');
process.exit(failures ? 1 : 0);
