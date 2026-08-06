// Pins the mapping from a Split Kit live block to a payable value block.
//
// Usage:
//   npm run check:liveblock
//
// Run it after ANY edit to lib/v4v/live-block.ts.
//
// Why this earns a check script: during a live show this function decides who
// gets paid, from a payload we don't control, arriving over a socket, with no
// confirmation step and no screen naming the recipient until the boost modal is
// opened. Every failure here is silent and sends money somewhere. A dropped
// recipient underpays an artist; a type mis-inferred as `node` fires a keysend
// at an email-shaped string; a split read from the wrong field redistributes
// the whole show.
//
// Vectors are real payload shapes read off thesplitkit's own client
// (src/lib/functions/addFeed.js, sendBoost.js, src/routes/(main)/live). If one
// fails, fix the code — never edit the vector to match.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module. That
// is the whole point: a reimplemented copy stays green while the shipping
// mapping drifts, which is the exact failure being guarded. live-block.ts is
// importable by plain Node because its only import is `import type` — keep it
// that way.

import { parseLiveBlock } from '../lib/v4v/live-block.ts';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** The shape The Split Kit pushes on `remoteValue`. */
const BLOCK = {
  title: 'Ring That Bell',
  image: 'https://example.com/art.jpg',
  feedGuid: '73ea9a80-240e-5430-b9ee-142b25f80093',
  itemGuid: 'https://example.com/track/9',
  blockGuid: 'ed6adf33-8887-4d7d-8272-7568065c4a0b',
  eventGuid: '0dfce62a-2a4c-4a48-a559-cb93d2390b20',
  eventAPI: 'https://curiohoster.com/api/sk/event/lookup',
  settings: { split: 90 },
  value: {
    type: 'lightning',
    method: 'keysend',
    destinations: [
      { name: 'Artist Node', type: 'node', address: '03ae9f91a0cb8ff43840e3c322c4c61f019d8c1c3cea15a25cfc425ac605e61a4a', split: 60 },
      { name: 'Artist LN', type: 'node', address: 'artist@fountain.fm', split: 35 },
      { name: 'Split Kit', type: 'node', address: '035ad2c954e264004986da2d9499e1732e5175e1dcef2453c921c6cdcc3536e9d8', split: 5, fee: true },
    ],
  },
};

console.log('parseLiveBlock — a Split Kit block becomes a payable target');
{
  const b = parseLiveBlock(BLOCK);
  check('the track title survives', b.title, 'Ring That Bell');
  check('the remote item names the TRACK\'s feed', b.feedGuid, BLOCK.feedGuid);
  check('…and its item guid', b.itemGuid, BLOCK.itemGuid);
  check('settings.split is the remote percentage', b.remotePercentage, 90);
  check('every recipient is carried', b.value.recipients.length, 3);
  check('splits are carried verbatim, never rescaled',
    b.value.recipients.map((r) => r.split), [60, 35, 5]);
  check('the fee flag survives', b.value.recipients.map((r) => !!r.fee), [false, false, true]);
}

console.log('\nrecipient type — the one that misroutes money');
{
  const b = parseLiveBlock(BLOCK);
  // Split Kit stores type:'node' for lnaddress destinations and re-infers from
  // the '@' in its own sender. Trusting the stored type keysends at an email.
  check('an address containing @ is an lnaddress despite type="node"',
    b.value.recipients[1].type, 'lnaddress');
  check('a bare pubkey stays a node', b.value.recipients[0].type, 'node');
}
{
  const b = parseLiveBlock({
    value: { destinations: [{ type: 'lnaddress', address: 'someone@getalby.com', split: 100 }] },
  });
  check('an explicit lnaddress type is honored', b.value.recipients[0].type, 'lnaddress');
}

console.log('\ncustom records — shared-node sub-account routing');
{
  const b = parseLiveBlock({
    value: { destinations: [
      { type: 'node', address: '03aa', split: 100, customKey: 696969, customValue: 'sub-acct' },
    ] },
  });
  check('customKey is stringified, not dropped for being a number',
    b.value.recipients[0].customKey, '696969');
  check('customValue rides along', b.value.recipients[0].customValue, 'sub-acct');
}

console.log('\nrefusals — anything that would pay nobody must be null');
{
  check('no payload', parseLiveBlock(null), null);
  check('empty object (Split Kit\'s "back to default")', parseLiveBlock({}), null);
  check('a block with no destinations', parseLiveBlock({ value: { destinations: [] } }), null);
  check('destinations that is not an array', parseLiveBlock({ value: { destinations: 'x' } }), null);
  const blank = parseLiveBlock({ value: { destinations: [{ address: '   ', split: 100 }] } });
  check('a blank address is not a recipient', blank, null);
}
{
  // A partially-bad list must keep the good entries rather than failing whole:
  // dropping the batch would pay the artist nothing.
  const b = parseLiveBlock({
    value: { destinations: [
      { address: '', split: 50 },
      { type: 'node', address: '03bb', split: 50 },
    ] },
  });
  check('one junk destination does not discard the rest', b.value.recipients.length, 1);
  check('…and it is the good one', b.value.recipients[0].address, '03bb');
}

console.log('\ndefaults');
{
  const b = parseLiveBlock({ value: { destinations: [{ type: 'node', address: '03cc', split: 100 }] } });
  check('missing model type defaults to lightning', b.value.type, 'lightning');
  check('missing method defaults to keysend', b.value.method, 'keysend');
  check('a block with no settings has no remote percentage', b.remotePercentage, undefined);
  check('a missing split reads as 0, never NaN',
    parseLiveBlock({ value: { destinations: [{ address: '03dd' }] } }).value.recipients[0].split, 0);
}

if (failures) {
  console.error(`\n${failures} live-block check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll live-block checks passed.');
