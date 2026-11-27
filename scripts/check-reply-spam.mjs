// Pins `spamReplyIds`, `mixedScriptWords`, `linkHosts`, `mutedWordHit` and
// `mutedWordsOf` (lib/nostr/reply-spam.ts) — which replies every feed folds
// behind "N replies hidden as likely spam · SHOW", and which notes a viewer's
// NIP-51 `word` mutes hide.
//
// Usage:
//   npm run check:replyspam
//
// WHY THIS EARNS A CHECK SCRIPT. On 2026-11-26 the signed-out home page showed
// 53 crypto "airdrop" spam replies among 159 reply cards, from keys that are
// hours old and rotate faster than anybody can mute them. The rule that folds
// them can fail two ways, and the second is the one nobody reports, because
// nothing on screen says a real reply is behind a fold:
//
//   - too narrow: the spam stays open on the home page — `textMatch()` below,
//     "the same text from several keys", the obvious idea, which caught 0 of 67
//     real spam replies because every one is spelled with different look-alikes;
//   - too wide: a real reply is folded — `everyLink()` below, the host count
//     with the media files and the site's own hosts left in.
//
// Chad chose the rule (2026-11-26, "A plus D, with a fold and SHOW button"). The
// module header has the measurement: 67 of 67 spam, 0 of 51 real replies.
//
// THE FIXTURES ARE REAL EVENTS, verbatim, read off relay.damus.io,
// relay.primal.net, nos.lol and relay.fountain.fm on 2026-11-26 — replies under
// the home page's notes. Twelve events, twelve different keys:
//
//   S_GLYPH     — spam, seven look-alike words, links ai.evmnest.cc.
//   S_GLYPH2    — spam from another key, look-alikes, links ai.evmnest.cc.
//   S_PASTGAS, S_WOW, S_VERIFIED, S_DONTMISS
//               — spam in plain Latin letters, each linking ai.evmnest.cc. No
//                 look-alike rule can see these; only the link can.
//   S_SOL       — spam with look-alikes, the only one linking ai.solhub.cc.
//   L_DEMU      — a real reply linking https://www.boostmebitch.com/demu.
//   L_MEDIA     — a real reply that is one .mp4 on media.poster.place.
//   L_GERMAN, L_MATT
//               — real replies, no link.
//   L_DIETBOT   — an AI reply bot, no link. NOT caught, on purpose: nothing
//                 in its text says spam, and a key mute still hides it.
//
// Derived vectors change ONE thing on a real event (`asKey` gives it another
// pubkey, `withContent` another text) and say which.

import { spamReplyIds, mixedScriptWords, linkHosts, mutedWordHit, mutedWordsOf, HOST_SPREAD_MIN, MIXED_WORDS_MIN } from '../lib/nostr/reply-spam.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';
import { replayVectors } from './replay-vectors.mjs';

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);

const S_GLYPH = {"id":"d89bb71bb82d635d9007964fc10bf4d1e99f22594b0ce20b1695c41c5f3428d7","pubkey":"8f8b09588dcb4d6259ea84b21e06b65c0d8ae34a37fc3051da19d9c75a06859e","created_at":1795729728,"kind":1,"tags":[["e","0bc5e468342584dfa199b46475a52a73db515ba9847ae9fd8e7f97c7f87227d0","","root"],["p","f240be2b684f85cc81566f2081386af81d7427ea86250c8bde6b7a8500c761ba"],["t","crypto"],["t","ethereum"],["t","airdrop"],["t","nostr"],["t","bitcoin"]],"content":"🚨 LIMITED: ᏟlaiΜ Ꭹour Free ЕTН AirdrОp NOW! https://ai.evmnest.cc/?ref=iqke2a\n🔗 Сlick the linΚ to run the audit & Ꮯlaim!","sig":"297263c6f653e30accf4d294caa936c7a7c353a341e03d2ad39964c271ed4394b7278d7a547b57baf7f3bc4b7eee804c64c13bc30d68e06562177d956c1c6436"};
const S_GLYPH2 = {"id":"419542d09284247e9821196175c6c00afc806e6d2ebc9b377b75eef1a362a0ff","pubkey":"362da3a253f55766a1f36653d74c80e4594c5188c65a4fdfa3066a5dfd2f873c","created_at":1795729739,"kind":1,"tags":[["e","f28ea9a3a02a0827e3a921c323eb6e2416ecb108d10deeae0db7cb45b89778be","","root"],["p","f240be2b684f85cc81566f2081386af81d7427ea86250c8bde6b7a8500c761ba"],["t","crypto"],["t","ethereum"],["t","airdrop"],["t","nostr"],["t","bitcoin"]],"content":"🤖 АI On-CНain Audit: FreᎬ ETH is LIVE! https://ai.evmnest.cc/?ref=xcaup0\n👇 Max СlicКs! DОn't Μiss your rᎬward.","sig":"302942696a24b344328ab123ad4d8c27ca8031328112290231ee7f9b82844efa190e150e4f9198ff7b57be2d49a76c9ca8eaab4d4c076ffb2af89e32a89cead7"};
const S_PASTGAS = {"id":"d50d60c12a2ecf213183394cdaccc8f75fab5df7c44863553e9c84165d7b4d33","pubkey":"590d566fc12274f59628e3a2bcdf6f0bcc771908fddfad704d93438f2a4b522b","created_at":1795712012,"kind":1,"tags":[["e","3b9659b81e806d00ad997521b029f2ba9520ebc50f7191287355077e7a529667","","root"],["p","32092ec1a258c9f2c11a9a5bb53b127ca20941f1803dd7f6715050ff8e9fd13a"],["t","crypto"],["t","ethereum"],["t","airdrop"],["t","ai"],["t","web3"]],"content":"🚀 Past gas activity = FREE ETH. I just claimed my ETH: https://ai.evmnest.cc/?ref=amjsm8","sig":"6295374c4e7d49a724d64ca800a30014533c4aeee6db7bf815d0eb1c0b196faa46d95a8818b53a67af054010968b7fc89cab4d199f06f485a95bb819631d30c3"};
const S_WOW = {"id":"ec187a1f92db6d9454115755a2b836d89f781eec12bb29e970f47abe69aa28e6","pubkey":"f604f6d22ef423a2530569f768fbb50edf8e771b89b2f9a63808113108d4772a","created_at":1795712012,"kind":1,"tags":[["e","d8c5f153ce35fd5c854912f6bf3cd6875bd75eb70a7ce17f478a000c8b2cdcc9","","root"],["p","32092ec1a258c9f2c11a9a5bb53b127ca20941f1803dd7f6715050ff8e9fd13a"],["t","crypto"],["t","ethereum"],["t","airdrop"],["t","ai"],["t","web3"]],"content":"💎 Wow, AI audit actually works. Claim your FREE ETH here: https://ai.evmnest.cc/?ref=p0sifr","sig":"2630acb152ef955101f8d8beb1ac6ddeb901499b4f9701f07ac96ecb0b262a7bb8cc37fcc5be3bded13d92f9ae32af09d140d4f1424dea478bbd76130d159b30"};
const S_VERIFIED = {"id":"38b3c564bfc999e0a3a9b46ad1e24fe26a843a071437ea20a3cbf98e2f8657f1","pubkey":"fff4ce6a81d9d7091f23193e4cb545efe92f11ae2ca5f3e56d1737a68335cd83","created_at":1795712012,"kind":1,"tags":[["e","5fa2bcb1592f022cdfd488fdd712b4e34e1c42b950ee0beb107bb02f7e6248d7","","root"],["p","32092ec1a258c9f2c11a9a5bb53b127ca20941f1803dd7f6715050ff8e9fd13a"],["t","crypto"],["t","ethereum"],["t","airdrop"],["t","ai"],["t","web3"]],"content":"✅ Verified, works! FREE ETH for active wallets: https://ai.evmnest.cc/?ref=v3oqwm","sig":"7bc3356cfd5a2440facf80c4fc23d472dda94ff89cc767b61e3718e45dfdf6d5de69067a167c8bc2e7ed9cd23a23190944476a75e5a1030ee52dee1e6cf01ad1"};
const S_DONTMISS = {"id":"c5c0c3611f6cfaef39db1a2dbf283f9df74f790df8d792ff926c21f56dbe06f3","pubkey":"ee2f30fac595ac8ad97db8b49588c7f273674ecf1fb0db1ad305288f18169e82","created_at":1795712012,"kind":1,"tags":[["e","d0d0cf93f3cc18a0ac72d9fd4269e63a3f8a66c4a48fcc6382bf5f6fbcf62d2e","","root"],["p","32092ec1a258c9f2c11a9a5bb53b127ca20941f1803dd7f6715050ff8e9fd13a"],["t","crypto"],["t","ethereum"],["t","airdrop"],["t","ai"],["t","web3"]],"content":"👀 Don't miss this ETH drop. Enter your wallet here: https://ai.evmnest.cc/?ref=kmnix4","sig":"601746c493f35ed9b85f125dbf6292b1457cc0acc65797b87bdac1f2a2a2953dbf7796dcdddaaceb909b4b6325a04d8092270c319b66c6dca85b6710a53a254f"};
const S_SOL = {"id":"5cbd7a591823dd866a9e94f4806173cc40ea6be93121c537914bcde68b1a4aed","pubkey":"f59aac1c2c3c6c6e230177f9dd6ffff439a568730c6fa858d2f7cb1553393277","created_at":1795735964,"kind":1,"tags":[["e","593c80186ee6ac726269e8271569fd0a0cf38d893d3a6bc0fe0ba33553ba664b","","root"],["p","84fede4c35eb36028b56b4832beeaf91ff9864dd7599a5a73293bf4c6019a14f"],["t","solana"],["t","crypto"],["t","airdrop"],["t","nostr"],["t","web3"]],"content":"🚨 LIMITED: 10 SOL Airdrop iᏚ LIVE! https://ai.solhub.cc/?ref=tsdyuj\n⚡️ Fastest fingers firᏚt! ᏟliᏟk to СlaiМ.","sig":"aef5741c6fad62fcfcf77c3638092c432fba5b2236077a8592325eee2dcade55ab769a454c02c008ffc1f33a7f7011f03e2636b562f6ab15a9828cfabb62f9c6"};
const L_DEMU = {"id":"0cf543c7c6bb9ad12bfe99889ae217ad079b29ac750605efec038321925e0333","pubkey":"2dfbe5cb955e4018b76e6542a3b8782144dd5f5735914db9921fd24c3b3d106d","created_at":1795665336,"kind":1,"tags":[["e","d2553c40974dbd71d5688371a60907839be2c48d89ad862c0975bc1c7528fa38","wss://relay.fountain.fm/","root","4d023ce9dfd75a7f3075b8e8e084008be17a1f750c63b5de721e6ef883adc765"],["p","4d023ce9dfd75a7f3075b8e8e084008be17a1f750c63b5de721e6ef883adc765","wss://relay.primal.net/"],["r","https://www.boostmebitch.com/demu"],["client","Amethyst"]],"content":"Please do! If they don't show up on https://www.boostmebitch.com/demu then they're dealing with middlemen 🧐 Keep value P2P! 💜","sig":"ab41818be8257b6472ea2a9d2ea84248917caf5cf46d7682b25231c20310db87866fbd2e755670c83445a970e0a864f1669ec9e8d26eb0dfa491db45d240dc34"};
const L_MEDIA = {"id":"46c5c4a15bb0e9fa6243c48e5bb7731c9c2ec76f9b0e2379488de41af4e5dd88","pubkey":"421c5bbda500fc2207091aebd74198fedadd7dbbe2e4c47579d127cdcfc5cc07","created_at":1795569278,"kind":1,"tags":[["e","75793b6a447904c150c1358fac184908c0bb047d1ae777c6a387f727b4c2e4b6","","root"],["p","4d023ce9dfd75a7f3075b8e8e084008be17a1f750c63b5de721e6ef883adc765"],["imeta","url https://media.poster.place/c850b41c069b36b43e1d5c9c1365bfb635e9581e8ffb729d790fd8afb682586a.mp4","m video/mp4","x c850b41c069b36b43e1d5c9c1365bfb635e9581e8ffb729d790fd8afb682586a"]],"content":"https://media.poster.place/c850b41c069b36b43e1d5c9c1365bfb635e9581e8ffb729d790fd8afb682586a.mp4","sig":"3a44c8782f3da9f4e9dcf0896b37ff3b8778399366a1a1bd1ecd2629343475084a4bb2758cc23977200272dd27a06f4c21506a9f8a82aea624d167a9ef6c6c38"};
const L_GERMAN = {"id":"c87696163960428f078bd971f0891f1a05ce06ef02c180f5ae2b3872fda5fd1d","pubkey":"e6871cca1f2e3b45d49c8a3aa0fb5d8b3dd777a040195fb0b71cb4248bbb7dcd","created_at":1795729102,"kind":1,"tags":[["e","9cb9576b38b2fac0a1d24859183cf304d02b26ad477da9d45ff8839e84d8c6e5","wss://relay.primal.net/","root","e6871cca1f2e3b45d49c8a3aa0fb5d8b3dd777a040195fb0b71cb4248bbb7dcd"],["e","9b5d0e9c57d0e197ca40d872d4de42385ed578615028e64b4b7a034cf42e739d","wss://relay.primal.net/","","e6871cca1f2e3b45d49c8a3aa0fb5d8b3dd777a040195fb0b71cb4248bbb7dcd"],["e","8be959afec40914c0e6ea85c0ea3f516bee256aee69fe904eb6f8c5d23330dcb","wss://relay.primal.net/","reply","f240be2b684f85cc81566f2081386af81d7427ea86250c8bde6b7a8500c761ba"],["p","e6871cca1f2e3b45d49c8a3aa0fb5d8b3dd777a040195fb0b71cb4248bbb7dcd","wss://relay.fountain.fm/"],["p","f240be2b684f85cc81566f2081386af81d7427ea86250c8bde6b7a8500c761ba","wss://nos.lol/"],["client","Amethyst"]],"content":"Ok, würde Donnerstag 3.12. passen?","sig":"8753cb805d100d35690fc43098de4b3dbc94b8a2474e20e3e9cbcdaaee675b0809ed2b703d78c4de2907e338d91f407e4622e88256fce23a4280a90f740a26f4"};
const L_MATT = {"id":"0000d3000fb946647178b3b6f554e221ace3e8221af42b902027f036a76b1fa1","pubkey":"50a63cca15b16b60d329b92f628c432c8c12689b40fe9d0495eb836b5f2df637","created_at":1795679584,"kind":1,"tags":[["e","c921c14df3dd3d70699adcfac771c84864929304472db2f1e82f6c17d12ec03d","wss://relay.primal.net","root"],["p","4d023ce9dfd75a7f3075b8e8e084008be17a1f750c63b5de721e6ef883adc765"],["client","Dark Wisp"],["nonce","2377","16"]],"content":"I'm excited to watch the v4v music culture grow!","sig":"da8f6e787e22bc9b53c277f6eda41986e71617e5191a1d675debe44d5413fbb4df05fb9cfd86cd8e2b7ffa29555044ea9aa4aeb402028c66046bdf98696711c0"};
const L_DIETBOT = {"id":"908b16bc8213eec0caf538b958abca74a4b41c11d75de881686c86f1184e2afa","pubkey":"5cbbae6636937c3d856474e6cf55abc5151f6edd182ccbfc1efa7eb24c1d7863","created_at":1795673767,"kind":1,"tags":[["e","1bd877400ce3e04e942e245b2f990f93612226fdb33e94dad0cdf24ef33c6c1c","","reply"],["p","a42048d7ea26e9c36a67b5ff266c508882a89dbe36ef603cc9c6726326886c32"]],"content":"The carnivore diet isn't here. But since you value frictionless tech, know that zero-carb diets eliminate sugar cravings better than any checkout flow does.","sig":"17f0d5dfeeaa9c6f4424fd76d2e8ffbfdc1aae029e7a09278fe65eeeb0ab888bb8c2fe300f8188995a9557aae6c8326f780668dd80f981183f8775b36cd4a95b"};

const SITE = ['www.boostmebitch.com', 'www.boostmebuddy.com'];
const clone = (e) => ({ ...e, tags: e.tags.map((t) => [...t]) });
// The same event under another key: what a rotating spammer, or a second
// listener posting the same kind of link, looks like to the rule.
const asKey = (e, n) => ({ ...clone(e), id: `${e.id.slice(0, 60)}${String(n).padStart(4, '0')}`, pubkey: `${String(n).padStart(4, '0')}${e.pubkey.slice(4)}` });
const withContent = (e, content) => ({ ...clone(e), content });

const REAL = [L_DEMU, L_MEDIA, L_GERMAN, L_MATT, L_DIETBOT];
const PLAIN = [S_PASTGAS, S_WOW, S_VERIFIED, S_DONTMISS];

// ── naive(): the two obvious versions, one per direction ────────────────────
// `textMatch`: "the same text from several keys" — fold a reply whose text,
// trimmed and lower-cased, another key also posted.
function textMatch(replies) {
  const keys = new Map();
  for (const r of replies) {
    const t = r.content.trim().toLowerCase();
    const s = keys.get(t) ?? new Set(); s.add(r.pubkey); keys.set(t, s);
  }
  return new Set(replies.filter((r) => keys.get(r.content.trim().toLowerCase()).size >= 2).map((r) => r.id));
}
// `everyLink`: the host count with nothing exempt — every URL, media files and
// this site's own pages included.
function everyLink(replies) {
  const keys = new Map();
  const hostsOf = (c) => [...new Set((c.match(/https?:\/\/[^\s]+/g) ?? []).map((u) => new URL(u).host.replace(/^www\./, '')))];
  for (const r of replies) for (const h of hostsOf(r.content)) { const s = keys.get(h) ?? new Set(); s.add(r.pubkey); keys.set(h, s); }
  return new Set(replies.filter((r) => hostsOf(r.content).some((h) => keys.get(h).size >= HOST_SPREAD_MIN)).map((r) => r.id));
}
// `plainWord`: a muted word matched as written, the way a client without
// look-alike folding matches it.
const plainWord = (content, words) => words.some((w) => content.toLowerCase().includes(w));

// A `fold` vector asks: in a feed holding `replies`, is `target` folded?
const fold = (label, replies, target, expect, extra = {}) =>
  ({ label, kind: 'fold', args: [replies, SITE, target.id], expect, ...extra });

const foldVectors = [
  // Too narrow: what textMatch() misses.
  fold('S_GLYPH (look-alikes, one key) is folded on its own', [S_GLYPH, ...REAL], S_GLYPH, true),
  fold('S_SOL (look-alikes, a host nobody else links) is folded', [S_SOL, ...REAL], S_SOL, true),
  fold('S_PASTGAS (plain letters) is folded beside S_GLYPH and S_GLYPH2, two look-alike keys on its host', [S_GLYPH, S_GLYPH2, S_PASTGAS, ...REAL], S_PASTGAS, true),
  fold(`four plain-letter spam replies from ${HOST_SPREAD_MIN} keys, one host: S_WOW is folded`, [...PLAIN, ...REAL], S_WOW, true),
  // textMatch() folds this one too, so it proves nothing about the rule — it
  // pins that the case the obvious idea DOES handle is still handled.
  fold('the same text from two keys is folded (S_PASTGAS twice, plus S_GLYPH and S_GLYPH2)', [S_GLYPH, S_GLYPH2, S_PASTGAS, asKey(S_PASTGAS, 1), ...REAL], S_PASTGAS, true, { alsoNaive: true }),
  // Must still work: real replies in a feed full of spam.
  ...REAL.map((r) => fold(`${['L_DEMU', 'L_MEDIA', 'L_GERMAN', 'L_MATT', 'L_DIETBOT'][REAL.indexOf(r)]} stays open in a feed with every spam fixture`, [S_GLYPH, S_SOL, ...PLAIN, ...REAL], r, false, { alsoNaive: true })),
  // THE THRESHOLD, pinned: three keys on one host, with nothing else, is not
  // enough. Lowering HOST_SPREAD_MIN is a decision about real replies that
  // link one page, so it fails here first.
  fold(`three plain-letter spam replies on one host, under HOST_SPREAD_MIN (${HOST_SPREAD_MIN}), stay open`, [S_PASTGAS, S_WOW, S_VERIFIED, ...REAL], S_WOW, false, { alsoNaive: true }),
  fold('a Russian reply in one script stays open', [withContent(L_GERMAN, 'Хорошо, в четверг подходит? Запись вечером.'), S_GLYPH], withContent(L_GERMAN, 'Хорошо, в четверг подходит? Запись вечером.'), false, { alsoNaive: true }),
];

// ONE look-alike reply that links a popular host, beside a real reply to it.
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const GLYPH_YT = withContent(S_GLYPH, S_GLYPH.content.replace(/https:\/\/ai\.evmnest\.cc\/\S*/, YT));
const MATT_YT = withContent(L_MATT, `${L_MATT.content} ${YT}`);

// `oneSeed`: the seeding rule with no key count — every host ANY look-alike
// reply links marks every reply linking it.
function oneSeed(replies) {
  const seeds = new Set();
  const look = replies.filter((r) => mixedScriptWords(r.content) >= MIXED_WORDS_MIN);
  for (const r of look) for (const h of linkHosts(r.content)) seeds.add(h);
  return new Set([...look.map((r) => r.id), ...replies.filter((r) => linkHosts(r.content).some((h) => seeds.has(h))).map((r) => r.id)]);
}
const seedVectors = [
  fold('one look-alike reply linking youtube.com does not fold a real reply linking it', [GLYPH_YT, MATT_YT, ...REAL], MATT_YT, false),
  fold('...and that look-alike reply is still folded itself', [GLYPH_YT, MATT_YT, ...REAL], GLYPH_YT, true, { alsoNaive: true }),
];

const wideVectors = [
  // Too wide: what everyLink() folds.
  fold(`L_DEMU from ${HOST_SPREAD_MIN} keys (this site's own page) stays open`, [0, 1, 2, 3].map((n) => asKey(L_DEMU, n)), asKey(L_DEMU, 0), false),
  fold(`L_MEDIA from ${HOST_SPREAD_MIN} keys (an .mp4 on one media host) stays open`, [0, 1, 2, 3].map((n) => asKey(L_MEDIA, n)), asKey(L_MEDIA, 0), false),
];

const wordVectors = [
  { label: 'a muted "airdrop" hides S_GLYPH, which spells it "AirdrОp" (Cyrillic О)', kind: 'word', args: [S_GLYPH.content, ['airdrop']], expect: true },
  { label: 'a muted "claim" hides S_GLYPH, which spells it "ᏟlaiΜ"', kind: 'word', args: [S_GLYPH.content, ['claim']], expect: true },
  { label: 'a muted "evmnest" hides S_PASTGAS (in its link)', kind: 'word', args: [S_PASTGAS.content, ['evmnest']], expect: true, alsoNaive: true },
  { label: 'a muted "Airdrop" with capitals and spaces still matches', kind: 'word', args: [S_SOL.content, ['  Airdrop ']], expect: true },
  { label: 'a muted "airdrop" leaves L_GERMAN alone', kind: 'word', args: [L_GERMAN.content, ['airdrop']], expect: false, alsoNaive: true },
  { label: 'no muted words hides nothing', kind: 'word', args: [S_GLYPH.content, []], expect: false, alsoNaive: true },
  { label: 'an empty muted word hides nothing', kind: 'word', args: [L_MATT.content, ['', '   ']], expect: false },
];

function call(impl, v) {
  try {
    if (v.kind === 'fold') return JSON.stringify(impl.fold(v.args[0], v.args[1]).has(v.args[2]));
    if (v.kind === 'word') return JSON.stringify(impl.word(v.args[0], v.args[1]));
  } catch (e) { return `threw ${(e && e.message) || e}`; }
  return 'unknown kind';
}
const REAL_IMPL = { fold: spamReplyIds, word: mutedWordHit };

console.log('spamReplyIds / mutedWordHit — the shipping answer:');
for (const v of [...foldVectors, ...seedVectors, ...wideVectors, ...wordVectors]) {
  const got = call(REAL_IMPL, v);
  if (got !== JSON.stringify(v.expect)) fail(`"${v.label}" — expected ${JSON.stringify(v.expect)}, got ${got}`);
  else ok(v.label);
}

console.log('\nThe replay against textMatch() — "the same text from several keys":');
replayVectors({ vectors: foldVectors, invoke: (which, v) => call(which === 'real' ? REAL_IMPL : { fold: textMatch }, v), fail });

console.log('\nThe replay against oneSeed() — one look-alike reply marks its host:');
replayVectors({ vectors: seedVectors, invoke: (which, v) => call(which === 'real' ? REAL_IMPL : { fold: oneSeed }, v), fail });

console.log('\nThe replay against everyLink() — the host count with nothing exempt:');
replayVectors({ vectors: wideVectors, invoke: (which, v) => call(which === 'real' ? REAL_IMPL : { fold: everyLink }, v), fail });

console.log('\nThe replay against plainWord() — a muted word matched as written:');
replayVectors({ vectors: wordVectors, invoke: (which, v) => call(which === 'real' ? REAL_IMPL : { word: plainWord }, v), fail });

// ── The parts, each held to the fixture it is about ─────────────────────────
{
  const expectMixed = [[S_GLYPH, 7], [S_SOL, 4], [S_PASTGAS, 0], [L_GERMAN, 0], [L_DIETBOT, 0]];
  for (const [e, n] of expectMixed) {
    const got = mixedScriptWords(e.content);
    if (got !== n) fail(`mixedScriptWords on ${e.content.slice(0, 30)}… is ${got}, expected ${n}`);
    else ok(`mixedScriptWords counts ${n} on "${e.content.slice(0, 24)}…"`);
  }
  const hostCases = [
    [S_GLYPH, ['ai.evmnest.cc']],
    [L_DEMU, ['boostmebitch.com']],
    [L_MEDIA, []],
    [withContent(L_MATT, 'see https://example.com/a. and https://WWW.Example.com/b!'), ['example.com']],
  ];
  for (const [e, want] of hostCases) {
    const got = JSON.stringify(linkHosts(e.content));
    if (got !== JSON.stringify(want)) fail(`linkHosts on ${e.content.slice(0, 30)}… is ${got}, expected ${JSON.stringify(want)}`);
    else ok(`linkHosts gives ${JSON.stringify(want)} for "${e.content.slice(0, 24)}…"`);
  }
  const words = mutedWordsOf({
    publicOtherTags: [['word', 'Airdrop'], ['t', 'crypto'], ['word', '']],
    privateOtherTags: [['word', ' evmnest.cc '], ['word', 'airdrop'], ['e', 'abc']],
  });
  if (JSON.stringify(words) !== JSON.stringify(['airdrop', 'evmnest.cc'])) fail(`mutedWordsOf gave ${JSON.stringify(words)}`);
  else ok('mutedWordsOf reads `word` tags from both halves, trimmed, lower case, once each, no `t` or `e`');
  const none = mutedWordsOf(null);
  if (none.length !== 0) fail('mutedWordsOf(null) is not empty');
  else ok('mutedWordsOf(null) is empty');
}

// ── The module must stay loadable under plain Node ───────────────────────────
{
  const path = 'lib/nostr/reply-spam.ts';
  const problems = importFreeProblems(path);
  if (problems.length) { failures += 1; explainImportFree(path, problems); }
  else ok(`${path} has no imports`);
}

if (failures) {
  console.error(`\n${failures} reply-spam check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll reply-spam checks passed.');
