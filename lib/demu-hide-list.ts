// Feeds that never appear on /demu, by podcast:guid — and the show whose
// playlist always does.
//
// IMPORT-FREE, not even `import type`: `npm run check:demu` loads this file
// under plain Node (`scripts/import-free.mjs`).
//
// **How to hide a feed:** add one line — its podcast:guid in LOWER CASE, its
// title, and why. `check:demu` refuses a malformed or repeated guid. The guid is
// on the feed's Podcast Index page, or in `/api/demu`'s answer.
//
// **An older COPY of an album needs no line:** the copy rule hides a feed whose
// tracks are exactly a newer feed's (`demuCopiesToHide` in lib/demu.ts, Chad,
// 2026-11-17). Add a line for a copy only when its audio URLs differ.
//
// **What the hide list cannot do (Chad, 2026-11-16):** remove a feed that
// Homegrown Hits plays. Those are always shown — "items that match the remote
// items in the Homegrown Hits feed [are] what we are looking to show here" —
// and `keepForDemu` lets PLAYED win over HIDDEN. A line here DOES beat "any
// feed made by MSP gets shown". Everything else must also carry
// <podcast:value> to be shown.
//
// Design: docs/superpowers/specs/2026-11-15-demu-page-design.md; the rule order
// is in docs/feeds.md, "The DeMu roster".

/** Homegrown Hits plays only DeMu; every feed its `<podcast:remoteItem>`s name is shown on /demu. */
export const HOMEGROWN_HITS_FEED_URL = 'https://feed.homegrownhits.xyz/feed.xml';

export interface DemuHidden {
  /** podcast:guid, lower case. */
  guid: string;
  title: string;
  reason: string;
}

// Chad's picks, 2026-11-16. None is a feed Homegrown Hits plays (checked
// against all 631 feeds its feed names that day).
export const DEMU_HIDE_LIST: readonly DemuHidden[] = [
  { guid: 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f', title: 'Homegrown Hits', reason: 'the show itself, not a release (its songs are shown)' },
  { guid: 'aa9471ed-f45b-5a15-9e72-9b4ea6f6af3b', title: 'The Board Game Design Lab', reason: 'a talk show filed as music' },
  { guid: '2ad45cc1-f1ff-57f5-bb84-c2c0a9b21fbe', title: 'Radio 1 Timemachine (RSS)', reason: 'a radio station archive' },
  { guid: '72683632-91f2-54cc-b977-2c9445ff49d4', title: 'Novinky na alternativní scéně — Radio 1', reason: 'a radio show' },
  { guid: '27293ad7-c199-5047-8135-a864fb546491', title: '100% Retro - Live 24/7 (MegaCRON!)', reason: 'a 24/7 radio stream' },
  { guid: '27293ad7-c199-5047-8135-a864fb546492', title: '100% Retro - Live 24/7', reason: 'a 24/7 radio stream' },
  { guid: 'b0cc4eea-1774-5be7-aa1b-4adb1a568cb1', title: 'Friday Night Death', reason: 'a weekly live show' },
  { guid: '35efa869-9a59-5882-8967-d365b883ec6d', title: 'GLOBAL FEDPILLED INDUSTRIAL COMPLEX', reason: 'a label catalog stream' },
  { guid: '0d9786b8-1753-58a2-9e94-55c3aad0ebc9', title: "Bustin' Out with CERO D", reason: 'a DJ show' },
  { guid: 'be51bf9f-4350-4f79-896a-e9328b3c332b', title: 'DJ Criket Summer Mixes. 100% Vinyl', reason: 'DJ mixes' },
  { guid: '15dcedb8-68fe-45b8-a84e-f0b6368fbd37', title: "Fletcher and Blaney's No Agenda End-of-Show Mixes Volume 1", reason: 'show mixes' },
  // LNBeats' allowFeed() (thebells1111/lnbeats, src/old_routes/+layout.svelte), added at
  // Chad's request, 2026-11-16. Its feed ids 5718023 (100% Retro, above) and 424986 map
  // to these guids; 4222574 is no longer in Podcast Index. Its two authors are below.
  { guid: 'c64fab29-66bf-56da-a7f3-c2a11f37f526', title: 'CGRadio - The Mix Series', reason: 'a radio mix series (LNBeats id 424986)' },
  { guid: 'c9c7bad3-4712-514e-9ebd-d1e208fa1b76', title: 'Board Game Design Lab (13 archive feeds)', reason: 'a talk show filed as music (LNBeats: author Gabe Barrett)' },
  { guid: '3e7c4f6a-9f9e-5b13-8d8a-eb053b35d377', title: '小杉毅誉大officialサイト', reason: 'not a music release (LNBeats: author 小杉毅誉大)' },
  // cremroad.com ignores `?a=`, so these two PI feeds are byte for byte the
  // catalog at cremroad.com/rss/ (4fd41d97-…, kept). Chad, 2026-11-16.
  { guid: 'c5075dbf-7937-57d9-8023-6d974d2b26de', title: 'Crem Road (cremroad.com/rss/?a=Still Living Creature)', reason: 'the same document as cremroad.com/rss/' },
  { guid: 'e65712c3-c07c-51c2-8c61-1d81caa9552f', title: 'Crem Road (cremroad.com/rss/?a=Me In The Bath)', reason: 'the same document as cremroad.com/rss/' },
  // Sovereign Frequency published the single "Drop BTC" three times through
  // Sovereign Feeds on 2026-10-23, as three catbox feeds with three guids. The
  // three documents differ only in their dates and podcast:guid: one track (item
  // guid d082c003-…), one MP3, one payee. The newest (PI 8084510,
  // files.catbox.moe/qo1es3.xml, baf5c0c0-…) is kept: "as they make changes,
  // the newest one should be correct" (Chad, 2026-11-17). The copy rule
  // (`demuCopiesToHide`) hides them too; these lines stay so a failed track
  // read on Podcast Index cannot bring them back.
  { guid: 'c2eb2af5-5258-5d8a-acea-f84663a156f2', title: 'Drop BTC (PI 8084427, files.catbox.moe/82qjqm.xml)', reason: 'an older copy of Drop BTC (PI 8084510)' },
  { guid: '8a9954fe-980d-5b76-b501-c83adc9a84e9', title: 'Drop BTC (PI 8084476, files.catbox.moe/h8zz4c.xml)', reason: 'an older copy of Drop BTC (PI 8084510)' },
];

/**
 * Authors whose every feed is hidden — LNBeats' allowFeed() hid these two by name, so a
 * NEW feed of theirs stays off without a new line above. Matched exactly, after a trim:
 * "Gabe Barrett Jr" is somebody else. Homegrown Hits still wins over this, as over a guid.
 */
export const DEMU_HIDE_AUTHORS: readonly string[] = ['Gabe Barrett', '小杉毅誉大'];
