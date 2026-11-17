// Pins `isTestBoostNote` and `testNoteMark` (lib/nostr/test-boost-notes.ts) —
// which notes every feed here leaves out because one of this repo's own test
// scripts published them to a public relay.
//
// Usage:
//   npm run check:testnotes
//
// WHY THIS EARNS A CHECK SCRIPT. On 2026-11-17 nine runs of e2e:mentions put 117
// test boost notes on relay.primal.net and relay.fountain.fm, each from its own
// one-time key, so no mute and no NIP-09 deletion can ever reach them (the
// module header has the whole story). The filter that hides them can fail two
// ways, and the second is the one nobody reports, because nothing on screen
// says a card is missing:
//
//   - too narrow: a leaked note stays on the home page — `before()` below, the
//     shipping code until this, which hid nothing;
//   - too wide: a REAL boost leaves every feed — `overreach()` below, the same
//     marks without the client half, which is the obvious version.
//
// Chad chose the rule (2026-11-17, "strict filter"): hide a note only when it
// says `client` BoostMeBitch AND carries a test mark. Never on a feed guid: the
// test notes tag the Wavlake album "Birdfeeder" (`fce40d63-…`) and Matt Finlay's
// "Kulture Collection" (`e88a4a67-…`), and NAME Homegrown Hits in the body, and
// real people boost all three.
//
// THE FIXTURES ARE REAL EVENTS, verbatim, read off relay.damus.io,
// relay.primal.net, nos.lol and relay.fountain.fm on 2026-11-17:
//
//   T_XTRACK        — one of the 117: "Tester boosted 1000 sats to A Track by
//                     HGH…", an example.com item guid and `r` link.
//   T_BIG           — one of the 117: the site-sign size fixture, amount
//                     9999999999000 msat, `g…` item guids, a `f…` feed guid.
//   R_BMB_HGH       — ChadF's real 333-sat boost of Homegrown Hits 158, written
//                     by this app (`client` BoostMeBitch), on the real show guid.
//   R_SITE_HGH      — a real site-signed note ("PUTIN!!!!") on Homegrown Hits 158.
//   R_BUDDY_HGH     — Reed's real 111-sat boost of Homegrown Hits from the
//                     family-friendly deploy (`client` BoostMeBuddy).
//   R_BAB_HGH       — BoostAfterBoost's real announcement of a Homegrown Hits boost.
//   R_BMB_TESTWORD  — a real boost whose MESSAGE is "test a boost for a track on
//                     a playlist": the word "test" is not a mark.
//   R_BMB_TESTICLES — a real boost reading "TESTICLES 123": nor is "TEST…".
//   R_MSP_KULTURE   — MSP 2.0's real 77-sat boost of "Copenhagen Time" on Kulture
//                     Collection: the very feed AND item guid the leak tagged.
//
// Each mark is also proved ON ITS OWN, added to a real note that carries no
// other: a mark that only ever travels with a stronger one is a mark nobody
// has shown to work.

import { isTestBoostNote, testNoteMark } from '../lib/nostr/test-boost-notes.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';
import { replayVectors } from './replay-vectors.mjs';

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);

const T_XTRACK = {"content":"⚡ Boost ⚡\n\nx\n\nTester boosted 1000 sats to A Track by HGH from Homegrown Hits via BoostMeBitch\n\nhttps://example.com/ep?id=42\nhttps://www.boostmebitch.com/?podcast=fce40d63-ef30-5c85-af07-d99b3c759807&episode=https%3A%2F%2Fexample.com%2Fep%3Fid%3D42\n\nhttps://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fexample.com%2Fart.png&title=Homegrown+Hits&ep=A+Track&sats=1000\n\nnostr:npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m","created_at":1794934313,"id":"2a41f7049ddc33b03546e85f961839867ca8f8dcb559002723a61c7bca0ac4b9","kind":1,"pubkey":"f3e0b237e674ff14cd56d12c7cc81218b2167899a83d4b8edcbc2af152401fde","sig":"983be8e9ebfe4bb69b64a88ffe7a4deb419fbe60f72f03cc95eeeabc0796f197100cb6c92aaf591a5cbd581c4821f8f32cfb7a8e56a545dd628954bd079c92fa","tags":[["i","podcast:guid:fce40d63-ef30-5c85-af07-d99b3c759807","https://www.boostmebitch.com/?podcast=fce40d63-ef30-5c85-af07-d99b3c759807"],["k","podcast:guid"],["i","podcast:item:guid:https://example.com/ep?id=42","https://www.boostmebitch.com/?podcast=fce40d63-ef30-5c85-af07-d99b3c759807&episode=https%3A%2F%2Fexample.com%2Fep%3Fid%3D42"],["k","podcast:item:guid"],["r","https://example.com/ep?id=42"],["r","https://www.boostmebitch.com/?podcast=fce40d63-ef30-5c85-af07-d99b3c759807&episode=https%3A%2F%2Fexample.com%2Fep%3Fid%3D42"],["p","82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2"],["imeta","url https://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fexample.com%2Fart.png&title=Homegrown+Hits&ep=A+Track&sats=1000","m image/png","dim 1200x300"],["amount","1000000"],["client","BoostMeBitch"],["t","boostagram"],["t","value4value"]]};
const T_BIG = {"content":"⚡ Boost ⚡\n\nnostr:npub1xjfa6m0vy8zfvq7lmn9jvz2gmvm68q40vk5tllf0497z2h2pq49qzapw9g nostr:npub1ycndldgnk4h4lfcx4ztauq3vevts522qulqqn7zxsrjnmcthtddszrsejw nostr:npub1vg7qv9pueads3t7dwxg0ng2qv27mjyhqhev7az668t8g5pqrlqnsdc60m0 nostr:npub16dta7kq8k27q9pwhxkd7ttstxlujl7e5tsfmmpj0w4m237jhxyuqfc40yq xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n\nSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS… boosted 9999999999 sats to TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT… from PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP… via BoostMeBitch\n\nhttps://example.com/link/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\nhttps://www.boostmebitch.com/?podcast=fce40d63-ef30-5c85-af07-d99b3c759807&episode=ggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg\n\nnostr:npub1h9vmr7fngcj6258zse2zeayr4y4nuwn8ncvqesq3fpfkrrc9v0rs0tjxkt\nnostr:npub1v2xa27u0wmnaur52ukl6mlkdsxhzz2vh8vt42eeh5v09j7ermfksxd30pn\nnostr:npub160smsv6c4uggsdkzlmguv0vc0ejm0aw8rfvxcrwx7prjte2xz8hq667acg\nnostr:npub1q9gwqm8dr5g8yt3uduupyrayfvqux26vv0fxjplrwcap89x5q3lqrelcz4","created_at":1794934309,"id":"07029a318e98c3cf055c857789c89b00a8f2af317d8dc4ad61558fed9f548cfd","kind":1,"pubkey":"84a458902b5636aac7c15433d595a543d7f7f35d63446f8a77b36c37d24ad891","sig":"6bfaba68c5fd7b5caf21da32ccacf36365fc5c4adf8c7443f32db63365cc3f837a707beb4764397632322c8c027ed0031d73b70fce989f11bcdce734c31bd36e","tags":[["i","podcast:guid:fce40d63-ef30-5c85-af07-d99b3c759807","https://www.boostmebitch.com/?podcast=fce40d63-ef30-5c85-af07-d99b3c759807"],["k","podcast:guid"],["i","podcast:item:guid:ggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg","https://www.boostmebitch.com/?podcast=fce40d63-ef30-5c85-af07-d99b3c759807&episode=ggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg"],["k","podcast:item:guid"],["i","podcast:guid:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],["i","podcast:item:guid:gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg"],["r","https://example.com/link/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],["r","https://www.boostmebitch.com/?podcast=fce40d63-ef30-5c85-af07-d99b3c759807&episode=ggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg"],["p","b959b1f9334625a550e286542cf483a92b3e3a679e180cc0114853618f0563c7"],["p","628dd57b8f76e7de0e8ae5bfadfecd81ae2129973b17556737a31e597b23da6d"],["p","d3e1b83358af108836c2fed1c63d987e65b7f5c71a586c0dc6f04725e54611ee"],["p","0150e06ced1d10722e3c6f38120fa44b01c32b4c63d26907e3763a1394d4047e"],["amount","9999999999000"],["q","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","wss://example.com/r0/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],["client","BoostMeBitch"],["t","boostagram"],["t","value4value"]]};
const R_BMB_HGH = {"content":"⚡ Boost ⚡\n\nChadF and 33 others boosted 333 sats → Homegrown Hits\n📻 Homegrown Hits Episode 158\n🎵 Death of a Harmony — The Fifty Four Plates\n\nhttps://podcastindex.org/podcast/6611624\nhttps://www.boostmebitch.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f&episode=homegrownhits-158\n\nhttps://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fbehindthesch3m3s.com%2Fwp-content%2Fuploads%2F2023%2F09%2Fhomegrown-hits-smoke-dance-pink.gif&art2=https%3A%2F%2Ffeed.homegrownhits.xyz%2Fassets%2Fimages%2Fepisode-54.JPG&title=Homegrown+Hits&ep=Homegrown+Hits+Episode+158&sats=333\n\nnostr:nevent1qvzqqqpxqupzqwpq7nlctpm5w5cv0l40u37pukfw8ns062ffknus0eq8zj7jdaqgqy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsz9nhwden5te0wfjkccte9ec8y6tdv9kzumn9wsq3wamnwvaz7tmjv4kxz7fwvehh2mn5v95kutnxd5qzqfg3ly943gjffzwe79d89pjf564mlzm2apt233rhagrz7nkjp40tkfcttw","created_at":1794538723,"id":"1bdb7f54be6461767855c6141d649bb561d6fb7e3508054eda970e69d75718ca","kind":1,"pubkey":"f7922a0adb3fa4dda5eecaa62f6f7ee6159f7f55e08036686c68e08382c34788","sig":"9e0de7e77b1dd1d40ea2acca464a24f60416c3b1c4630623dbda39ec7b24318c15816b12232237cae782c8ec5a884daf0babf933f625d14fc8fcb90335519de1","tags":[["i","podcast:guid:ac746d09-7c3b-5bcd-b28a-f12d6456ca8f","https://www.boostmebitch.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f"],["k","podcast:guid"],["i","podcast:item:guid:homegrownhits-158","https://www.boostmebitch.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f&episode=homegrownhits-158"],["k","podcast:item:guid"],["i","podcast:guid:6c3c38e1-34f6-4fe1-a0f8-edbefe4ec5dc","https://www.boostmebitch.com/?podcast=6c3c38e1-34f6-4fe1-a0f8-edbefe4ec5dc"],["i","podcast:item:guid:fe227c33-91f2-485f-938e-930bd613fad3","https://www.boostmebitch.com/?podcast=6c3c38e1-34f6-4fe1-a0f8-edbefe4ec5dc&episode=fe227c33-91f2-485f-938e-930bd613fad3"],["r","https://podcastindex.org/podcast/6611624"],["r","https://www.boostmebitch.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f&episode=homegrownhits-158"],["imeta","url https://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fbehindthesch3m3s.com%2Fwp-content%2Fuploads%2F2023%2F09%2Fhomegrown-hits-smoke-dance-pink.gif&art2=https%3A%2F%2Ffeed.homegrownhits.xyz%2Fassets%2Fimages%2Fepisode-54.JPG&title=Homegrown+Hits&ep=Homegrown+Hits+Episode+158&sats=333","m image/png","dim 1200x300"],["amount","333000"],["q","2511f90b58a249489d9f15a728649a6abbf8b6ae856a8c477ea062f4ed20d5eb","wss://relay.damus.io","3820f4ff8587747530c7feafe47c1e592e3ce0fd2929b4f907e40714bd26f408"],["client","BoostMeBitch"],["t","boostagram"],["t","value4value"]]};
const R_SITE_HGH = {"content":"⚡ Boost ⚡\n\nPUTIN!!!!\n\nboostmebitch.com user boosted 333 sats → Homegrown Hits\n📻 Homegrown Hits Episode 158\n\nhttps://podcastindex.org/podcast/6611624\nhttps://www.boostmebitch.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f&episode=homegrownhits-158\n\nhttps://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fbehindthesch3m3s.com%2Fwp-content%2Fuploads%2F2023%2F09%2Fhomegrown-hits-smoke-dance-pink.gif&art2=https%3A%2F%2Ffeed.homegrownhits.xyz%2Fassets%2Fimages%2Fepisode-54.JPG&title=Homegrown+Hits&ep=Homegrown+Hits+Episode+158&sats=333\n\nnostr:nevent1qvzqqqpxqupzqwpq7nlctpm5w5cv0l40u37pukfw8ns062ffknus0eq8zj7jdaqgqyt8wumn8ghj7un9d3shjtnswf5k6ctv9ehx2aqpz3mhxue69uhhyetvv9ujuerpd46hxtnfduq3wamnwvaz7tmjv4kxz7fwvehh2mn5v95kutnxd5qzqtmzzgqxn4plhfauys5v6f5naexyqs36selg225j56gsqnsyegxe2ljslk","created_at":1794533458,"id":"6a2ec41f42780a90affc8799ec7659c5925aada9ecf43f1f9e2ddc9f18c5b616","kind":1,"pubkey":"3820f4ff8587747530c7feafe47c1e592e3ce0fd2929b4f907e40714bd26f408","sig":"67aed8cdb2eb67e2070afb950a0d8108c92836498ddf3453c656a64747a22c97b641ed9bff5811da66ce597d30cf6e686985cbf7c3a1adeecffb08eca5ae9058","tags":[["i","podcast:guid:ac746d09-7c3b-5bcd-b28a-f12d6456ca8f","https://www.boostmebitch.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f"],["k","podcast:guid"],["i","podcast:item:guid:homegrownhits-158","https://www.boostmebitch.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f&episode=homegrownhits-158"],["k","podcast:item:guid"],["r","https://podcastindex.org/podcast/6611624"],["r","https://www.boostmebitch.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f&episode=homegrownhits-158"],["imeta","url https://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fbehindthesch3m3s.com%2Fwp-content%2Fuploads%2F2023%2F09%2Fhomegrown-hits-smoke-dance-pink.gif&art2=https%3A%2F%2Ffeed.homegrownhits.xyz%2Fassets%2Fimages%2Fepisode-54.JPG&title=Homegrown+Hits&ep=Homegrown+Hits+Episode+158&sats=333","m image/png","dim 1200x300"],["amount","333000"],["q","2f62120069d43fba7bc2428cd2693ee4c40423a867e852a92a691004e04ca0d9","wss://relay.primal.net","3820f4ff8587747530c7feafe47c1e592e3ce0fd2929b4f907e40714bd26f408"],["client","BoostMeBitch"],["t","boostagram"],["t","value4value"]]};
const R_BUDDY_HGH = {"content":"⚡ Boost ⚡\n\nReed boosted 111 sats → Homegrown Hits\n📻 Homegrown Hits - Episode 158\n🎵 Let Go (What's holding you back) — Middle Season\n\nhttps://podcastindex.org/podcast/6611624\nhttps://www.boostmebuddy.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f&episode=808d3620-84b0-4fcc-aeea-15c74873ee32\n\nhttps://www.boostmebuddy.com/api/og/boost.png?art=https%3A%2F%2Ffeed.homegrownhits.xyz%2Fassets%2Fimages%2Fepisode-158.GIF&art2=https%3A%2F%2Ffeed.homegrownhits.xyz%2Fassets%2Fimages%2Fepisode-54.JPG&title=Homegrown+Hits&ep=Homegrown+Hits+-+Episode+158&sats=111\n\nnostr:nevent1qvzqqqpxqupzqr6fdqf83w28d9z6k7rq7trsp960s7xwnwq4ttvfx33nx6q3ww0gqyf8wumn8ghj7am0wsh82arcduhx7mn9qyt8wumn8ghj7un9d3shjtnswf5k6ctv9ehx2aqpz4mhxue69uhhyetvv9ujuamfwdczuarpd34sqgx5tfv4h4glz9ls3vel36alxsq9svdvv3zu0357xzrn0cp6hqdc3ytcx2ty","created_at":1794932656,"id":"65fe4be4409a985f58f2cb67a5fd3ca96650f1b88d03c42a2cc799d736fb0009","kind":1,"pubkey":"32092ec1a258c9f2c11a9a5bb53b127ca20941f1803dd7f6715050ff8e9fd13a","sig":"b524c6731cbe19ad4af5237218bb5f21af90952d8f173b6d89ba9dc29ffccd5c115027da372589390ffe3bf2bc0012c327b5dfaed77cb6ac88bb196df8e30ed0","tags":[["i","podcast:guid:ac746d09-7c3b-5bcd-b28a-f12d6456ca8f","https://www.boostmebuddy.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f"],["k","podcast:guid"],["i","podcast:item:guid:808d3620-84b0-4fcc-aeea-15c74873ee32","https://www.boostmebuddy.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f&episode=808d3620-84b0-4fcc-aeea-15c74873ee32"],["k","podcast:item:guid"],["i","podcast:guid:3074902b-b2dc-5877-bfc3-30f5df0fbe6a","https://www.boostmebuddy.com/?podcast=3074902b-b2dc-5877-bfc3-30f5df0fbe6a"],["i","podcast:item:guid:c59c7ffe-3847-4d55-ac27-5a1c1fbe6140","https://www.boostmebuddy.com/?podcast=3074902b-b2dc-5877-bfc3-30f5df0fbe6a&episode=c59c7ffe-3847-4d55-ac27-5a1c1fbe6140"],["r","https://podcastindex.org/podcast/6611624"],["r","https://www.boostmebuddy.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f&episode=808d3620-84b0-4fcc-aeea-15c74873ee32"],["imeta","url https://www.boostmebuddy.com/api/og/boost.png?art=https%3A%2F%2Ffeed.homegrownhits.xyz%2Fassets%2Fimages%2Fepisode-158.GIF&art2=https%3A%2F%2Ffeed.homegrownhits.xyz%2Fassets%2Fimages%2Fepisode-54.JPG&title=Homegrown+Hits&ep=Homegrown+Hits+-+Episode+158&sats=111","m image/png","dim 1200x300"],["amount","111000"],["q","d45a595bd51f117f08b33f8ebbf34005831ac6445c7c69e308737e03ab81b889","wss://wot.utxo.one","0f49681278b9476945ab7860f2c700974f878ce9b8155ad893463336811739e8"],["client","BoostMeBuddy"],["t","boostagram"],["t","value4value"]]};
const R_BAB_HGH = {"content":"[Homegrown Hits] [Homegrown Hits - Episode 158] revhodl@fountain.fm boosted ​127 sats saying \"I'm bummed but I have been dropping my boost amount down to 121 from 420. Haven't been earning as much recently and I'm dedicated to boosting all the pods I listen to so I'm spreading the sats a little thing. I'm gonna try another tiddication, no sweat if it doesn't qualify. Zaza - WebFive goes out to all the Archipelago homies!https://onlyboosts.social/show/12bef951-7018-5d12-a602-7479862541f6\" via Fountain\n\n#bowlafterbowl #boostafterboost #bowloftrust\n\nnostr:nevent1qvzqqqpxqupzqj9e525ky40kkffl9lkll0h24sdaeeg9rk49g6ce37qqed2nt6qwqythwumn8ghj7un9d3shjtnxda6kuarpd9hzuendqy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsz9nhwden5te0wfjkccte9ec8y6tdv9kzumn9wsqzq7j23gw84upx557tq9tw6zus9xrccc78ww9p9jd4nhx6xcrqpzenuv5mlh","created_at":1794593449,"id":"225966037d59fefcb5717d60fe40af4e54621bc932aeb3e4171fa8320a8bb000","kind":1,"pubkey":"48b9a2a96255f6b253f2fedffbeeaac1bdce5051daa546b198f800cb5535e80e","sig":"42b4c05854dfb2014baf6234ce6866d6dd02145ef934f6def118ca80e28dd01e0fae997ade264c17d2a01bc0fdda7b56eecb0d18368d45856f1cac6e5caea2bb","tags":[["client","BoostAfterBoost"],["t","bowlafterbowl"],["t","boostafterboost"],["t","bowloftrust"],["i","podcast:guid:ac746d09-7c3b-5bcd-b28a-f12d6456ca8f"],["k","podcast:guid"],["i","podcast:item:guid:808d3620-84b0-4fcc-aeea-15c74873ee32"],["k","podcast:item:guid"],["amount","127000"],["t","boost"],["t","boostagram"],["t","value4value"],["app","Fountain"],["sender","npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z"],["q","7a4a8a1c7af026a53cb0156ed0b9029878c63c7738a12c9b59dcda3606008b33","wss://relay.fountain.fm","48b9a2a96255f6b253f2fedffbeeaac1bdce5051daa546b198f800cb5535e80e"]]};
const R_BMB_TESTWORD = {"content":"⚡ Boost ⚡\n\ntest a boost for a track on a playlist\n\nChadF and 33 others boosted 100 sats → ITDV music playlist\n📻 Sing For You\n\nhttps://podcastindex.org/podcast/7443423\nhttps://www.boostmebitch.com/?podcast=88b0640a-489f-4920-be4f-00f85af5b2d4&episode=12711f57-2d41-4794-8cb9-154ecebb7cf7\n\nhttps://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fwww.doerfelverse.com%2Fart%2Fsing-for-you.png&art2=https%3A%2F%2Fwww.doerfelverse.com%2Fart%2Fdiscoswag-thealbum.gif&art3=https%3A%2F%2Fraw.githubusercontent.com%2FChadFarrow%2Fchadf-musicl-playlists%2Fmain%2Fdocs%2FITDV-music-playlist.webp&title=ITDV+music+playlist&ep=Sing+For+You&sats=100\n\nnostr:nevent1qvzqqqpxqupzqwpq7nlctpm5w5cv0l40u37pukfw8ns062ffknus0eq8zj7jdaqgqyt8wumn8ghj7un9d3shjtnswf5k6ctv9ehx2aqpp4mhxue69uhkummn9ekx7mqpz3mhxue69uhhyetvv9ujuerpd46hxtnfduqzq9pzz2ay8lf5yqwltdpfkwg0k7q96454m4pm5g9jmznt9cumfr67cr8lc7","created_at":1794880967,"id":"17df5c5e189f019a00e82ef63684677a325356d42d2b58b050197bbc48a47fa9","kind":1,"pubkey":"f7922a0adb3fa4dda5eecaa62f6f7ee6159f7f55e08036686c68e08382c34788","sig":"544140c98dd105df3125718ba7446e406ffe6a0df831d295119940538d2606ee953b29bf23a4e8f3815099c7c7f9654981fac643cae9672cbdafe5eaf12f03b4","tags":[["i","podcast:guid:88b0640a-489f-4920-be4f-00f85af5b2d4","https://www.boostmebitch.com/?podcast=88b0640a-489f-4920-be4f-00f85af5b2d4"],["k","podcast:guid"],["i","podcast:item:guid:12711f57-2d41-4794-8cb9-154ecebb7cf7","https://www.boostmebitch.com/?podcast=88b0640a-489f-4920-be4f-00f85af5b2d4&episode=12711f57-2d41-4794-8cb9-154ecebb7cf7"],["k","podcast:item:guid"],["r","https://podcastindex.org/podcast/7443423"],["r","https://www.boostmebitch.com/?podcast=88b0640a-489f-4920-be4f-00f85af5b2d4&episode=12711f57-2d41-4794-8cb9-154ecebb7cf7"],["imeta","url https://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fwww.doerfelverse.com%2Fart%2Fsing-for-you.png&art2=https%3A%2F%2Fwww.doerfelverse.com%2Fart%2Fdiscoswag-thealbum.gif&art3=https%3A%2F%2Fraw.githubusercontent.com%2FChadFarrow%2Fchadf-musicl-playlists%2Fmain%2Fdocs%2FITDV-music-playlist.webp&title=ITDV+music+playlist&ep=Sing+For+You&sats=100","m image/png","dim 1200x300"],["amount","100000"],["q","142212ba43fd34201df5b429b390fb7805d5695dd43ba20b2d8a6b2e39b48f5e","wss://relay.primal.net","3820f4ff8587747530c7feafe47c1e592e3ce0fd2929b4f907e40714bd26f408"],["client","BoostMeBitch"],["t","boostagram"],["t","value4value"]]};
const R_BMB_TESTICLES = {"content":"⚡ Boost ⚡\n\nTESTICLES 123\nhttps://media.giphy.com/media/6glYLqOQ3dlok/giphy.gif\n\nNostr Gang boosted 100 sats → Bowl After Bowl\n📻 Episode 467 ★ Hearty Party\n\nhttps://bowlafterbowl.com/episodes/episode-467/\nhttps://www.boostmebitch.com/?podcast=2d418249-453a-5714-8abc-5b657570b641&episode=https%3A%2F%2Fbowlafterbowl.com%2Fepisodes%2Fepisode-467%2F\n\nhttps://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fmedia.bowlafterbowl.com%2Fepisodes%2Fimages%2Fepisode-467.jpg&art2=https%3A%2F%2Fpbcdn1.podbean.com%2Fimglogo%2Fimage-logo%2F8891795%2FBowl-After-BOWL-smol.jpg&title=Bowl+After+Bowl&ep=Episode+467+%E2%98%85+Hearty+Party&sats=100\n\nnostr:nevent1qvzqqqpxqupzqwpq7nlctpm5w5cv0l40u37pukfw8ns062ffknus0eq8zj7jdaqgqyt8wumn8ghj7un9d3shjtnswf5k6ctv9ehx2aqpzamhxue69uhhyetvv9ujuen0w4h8gctfdchxvmgqyzsn567zwus0sw58mm88qvrngfgx7f9kjyqvqvu7nxyu7m4ml60lsz83wex","created_at":1794480388,"id":"d357c9fe45edf063e5ffb18b45774987712b0edc16e6f6917b5b56e2282145da","kind":1,"pubkey":"91aeab23b5664edaa57dbe00b041ccb50544f89d7d956345bbd78b7dbaa48660","sig":"336965dce3b31d8ced5ef6fa25d9d91059bd32cc0de89920f590149c18514535503129dd2e2df425a8a96b860dd04138c5f54572bffdbf71b0a60f20f70dbdda","tags":[["i","podcast:guid:2d418249-453a-5714-8abc-5b657570b641","https://www.boostmebitch.com/?podcast=2d418249-453a-5714-8abc-5b657570b641"],["k","podcast:guid"],["i","podcast:item:guid:https://bowlafterbowl.com/episodes/episode-467/","https://www.boostmebitch.com/?podcast=2d418249-453a-5714-8abc-5b657570b641&episode=https%3A%2F%2Fbowlafterbowl.com%2Fepisodes%2Fepisode-467%2F"],["k","podcast:item:guid"],["r","https://bowlafterbowl.com/episodes/episode-467/"],["r","https://www.boostmebitch.com/?podcast=2d418249-453a-5714-8abc-5b657570b641&episode=https%3A%2F%2Fbowlafterbowl.com%2Fepisodes%2Fepisode-467%2F"],["imeta","url https://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fmedia.bowlafterbowl.com%2Fepisodes%2Fimages%2Fepisode-467.jpg&art2=https%3A%2F%2Fpbcdn1.podbean.com%2Fimglogo%2Fimage-logo%2F8891795%2FBowl-After-BOWL-smol.jpg&title=Bowl+After+Bowl&ep=Episode+467+%E2%98%85+Hearty+Party&sats=100","m image/png","dim 1200x300"],["amount","100000"],["q","a13a6bc27720f83a87dece70307342506f24b69100c0339e9989cf6ebbfe9ff8","wss://relay.primal.net","3820f4ff8587747530c7feafe47c1e592e3ce0fd2929b4f907e40714bd26f408"],["client","BoostMeBitch"],["t","boostagram"],["t","value4value"]]};
const R_MSP_KULTURE = {"content":"⚡ Boost ⚡\n\nAuto boost from Sir TJ The Wrathful for \"Copenhagen Time\" by Matt Finlay sent from v4vmusic.com\n\nSir TJ The Wrathful boosted 77 sats → Kulture Collection\n📻 Copenhagen Time\n\nhttps://tardbox.com/og/boost.png?art=https%3A%2F%2Fphafe.com%2Fwp-content%2Fuploads%2Frssfeed%2Fmusic%2Fmatt_finlay%2Fkulture_collection%2F06_Copenhagen_Time.png&title=Kulture+Collection&ep=Copenhagen+Time&sats=77&by=MSP+2.0","created_at":1791054496,"id":"f77629b94d117183092b454542fff42d1cf4f33b93ee1f6c6c97e9ba829840ce","kind":1,"pubkey":"ffff6a7af32ea2239cb71548f476eec0dd9ae56673abda536bef5c241276fc3e","sig":"483fe63ffcaa9ebbfea2cec31c5b368dd3c9789565ce5133a6bdc5d6da0a195d7455eab57a34c162b3de63ca255418c78930ba9753b42dbce5bded082f4d63dc","tags":[["i","podcast:guid:e88a4a67-877c-5e03-b8fd-a70cebc821af"],["k","podcast:guid"],["i","podcast:item:guid:9f515f93-eda1-4146-8637-7def160879b5"],["k","podcast:item:guid"],["i","podcast:publisher:guid:1a197bac-95ae-53bd-bf6d-40ba8b551088"],["k","podcast:publisher:guid"],["r","https://tardbox.com/boost/01M41JNK5WE2BT637VTD2Z8H85"],["p","50a63cca15b16b60d329b92f628c432c8c12689b40fe9d0495eb836b5f2df637"],["imeta","url https://tardbox.com/og/boost.png?art=https%3A%2F%2Fphafe.com%2Fwp-content%2Fuploads%2Frssfeed%2Fmusic%2Fmatt_finlay%2Fkulture_collection%2F06_Copenhagen_Time.png&title=Kulture+Collection&ep=Copenhagen+Time&sats=77&by=MSP+2.0","m image/png","dim 1200x300"],["amount","77000"],["client","MSP 2.0"],["app","v4vmusic-com","0.17.11"],["recipient","MSP 2.0"],["t","boostagram"],["t","value4value"]]};

// ── Derived vectors: ONE change to a real note ──────────────────────────────
// A copy with its tags copied too, so no vector can alter a fixture another
// vector reads.
const clone = (e) => ({ ...e, tags: e.tags.map((t) => [...t]) });
const withTag = (e, tag) => { const c = clone(e); c.tags.push(tag); return c; };
const withAmount = (e, msat) => {
  const c = clone(e);
  c.tags = c.tags.map((t) => (t[0] === 'amount' ? ['amount', msat] : t));
  return c;
};
const withSender = (e, from, to) => {
  if (!e.content.includes(from)) throw new Error(`fixture ${e.id.slice(0, 8)} does not say "${from}"`);
  return { ...clone(e), content: e.content.replace(from, to) };
};
const withoutClient = (e) => { const c = clone(e); c.tags = c.tags.filter((t) => t[0] !== 'client'); return c; };

// The marks, each as the change that adds it to a real note.
const MARKS = [
  ['an amount of 9999999999000 msat', (e) => withAmount(e, '9999999999000')],
  ['"Tester boosted" in the body', (e) => withSender(e, e === R_BMB_HGH ? 'ChadF and 33 others boosted' : 'Reed boosted', 'Tester boosted')],
  ['an `r` tag linking https://example.com/', (e) => withTag(e, ['r', 'https://example.com/ep?id=42'])],
  ['an item guid that is an https://example.com/ link', (e) => withTag(e, ['i', 'podcast:item:guid:https://example.com/ep?id=42'])],
  ['an item guid of 200 `g`s', (e) => withTag(e, ['i', `podcast:item:guid:${'g'.repeat(200)}`])],
  ['a feed guid of 200 `f`s', (e) => withTag(e, ['i', `podcast:guid:${'f'.repeat(200)}`])],
];

// ── naive(): the two obvious versions, one per direction ────────────────────
// `before`: what shipped until this — every note shows.
const before = () => false;
// `overreach`: the marks alone, whoever wrote the note.
const overreach = (e) => testNoteMark(e) !== null;

const vectors = [
  // The leaked notes themselves.
  { label: 'T_XTRACK, a leaked note verbatim, is hidden', kind: 'note', args: [T_XTRACK], expect: true },
  { label: 'T_BIG, a leaked 9,999,999,999-sat note verbatim, is hidden', kind: 'note', args: [T_BIG], expect: true },
  // Each mark, alone, on a real note this app wrote.
  ...MARKS.map(([what, add]) => ({
    label: `${what}, alone, on a real BoostMeBitch boost, hides it`,
    kind: 'note', args: [add(R_BMB_HGH)], expect: true,
  })),
  // Real boosts, untouched — the must-still-work half.
  { label: 'a real BoostMeBitch boost of Homegrown Hits shows', kind: 'note', args: [R_BMB_HGH], expect: false, alsoNaive: true },
  { label: 'a real site-signed note on Homegrown Hits shows', kind: 'note', args: [R_SITE_HGH], expect: false, alsoNaive: true },
  { label: 'a real BoostMeBuddy boost of Homegrown Hits shows', kind: 'note', args: [R_BUDDY_HGH], expect: false, alsoNaive: true },
  { label: 'a real BoostAfterBoost note on Homegrown Hits shows', kind: 'note', args: [R_BAB_HGH], expect: false, alsoNaive: true },
  { label: 'a real boost whose message says "test a boost" shows', kind: 'note', args: [R_BMB_TESTWORD], expect: false, alsoNaive: true },
  { label: 'a real boost reading "TESTICLES 123" shows', kind: 'note', args: [R_BMB_TESTICLES], expect: false, alsoNaive: true },
  { label: 'a real boost of the track the leak tagged (Copenhagen Time) shows', kind: 'note', args: [R_MSP_KULTURE], expect: false, alsoNaive: true },
  // Near misses on a real BoostMeBitch boost: none is a mark.
  { label: 'an amount one digit short of the fixture shows', kind: 'note', args: [withAmount(R_BMB_HGH, '999999999000')], expect: false, alsoNaive: true },
  { label: '"Tester" without "boosted" shows', kind: 'note', args: [withSender(R_BMB_HGH, 'ChadF and 33 others boosted', 'Tester, who boosted')], expect: false, alsoNaive: true },
  { label: 'https://example.community/ is not example.com', kind: 'note', args: [withTag(R_BMB_HGH, ['r', 'https://example.community/ep'])], expect: false, alsoNaive: true },
  { label: 'example.com only in an `i` tag HINT is not a mark', kind: 'note', args: [withTag(R_BMB_HGH, ['i', 'podcast:item:guid:abc', 'https://example.com/ep'])], expect: false, alsoNaive: true },
  { label: 'an item guid of 15 `g`s shows', kind: 'note', args: [withTag(R_BMB_HGH, ['i', `podcast:item:guid:${'g'.repeat(15)}`])], expect: false, alsoNaive: true },
  { label: 'an all-`f` UUID keeps its dashes and shows', kind: 'note', args: [withTag(R_BMB_HGH, ['i', 'podcast:guid:ffffffff-ffff-ffff-ffff-ffffffffffff'])], expect: false, alsoNaive: true },
  // Not a note: nothing to read is nothing to hide, and nothing throws.
  { label: 'a missing event shows', kind: 'note', args: [undefined], expect: false, alsoNaive: true },
  { label: 'an event whose tags are not a list shows', kind: 'note', args: [{ tags: 'client', content: 'Tester boosted' }], expect: false, alsoNaive: true },
];

// The client half: every mark on a note another app wrote. `overreach` hides
// each of these, which is the regression this list exists to catch.
const clientVectors = [
  { label: 'T_XTRACK with its `client` tag removed shows', kind: 'note', args: [withoutClient(T_XTRACK)], expect: false },
  { label: 'T_BIG with its `client` tag removed shows', kind: 'note', args: [withoutClient(T_BIG)], expect: false },
  ...MARKS.map(([what, add]) => ({
    label: `${what} on a BoostMeBuddy boost shows`,
    kind: 'note', args: [add(R_BUDDY_HGH)], expect: false,
  })),
];

const call = (impl, v) => {
  try { return JSON.stringify(impl(...v.args)); } catch (e) { return `threw ${(e && e.message) || e}`; }
};

console.log('isTestBoostNote — the shipping answer:');
for (const v of [...vectors, ...clientVectors]) {
  const got = call(isTestBoostNote, v);
  if (got !== JSON.stringify(v.expect)) fail(`"${v.label}" — expected ${JSON.stringify(v.expect)}, got ${got}`);
  else ok(v.label);
}

console.log('\nThe replay against before() — the feed that hid nothing:');
replayVectors({ vectors, invoke: (which, v) => call(which === 'real' ? isTestBoostNote : before, v), fail });

console.log('\nThe replay against overreach() — the marks without the client half:');
replayVectors({ vectors: clientVectors, invoke: (which, v) => call(which === 'real' ? isTestBoostNote : overreach, v), fail });

// ── testNoteMark names the mark each derived vector added ──────────────────
// The derived vectors claim to prove one mark each; this holds them to it. A
// vector whose change landed under a different mark proves that other mark.
{
  const expected = ['amount', 'tester', 'example-link', 'example-link', 'g-item-guid', 'f-feed-guid'];
  MARKS.forEach(([what, add], i) => {
    const got = testNoteMark(add(R_BMB_HGH));
    if (got !== expected[i]) fail(`${what}: testNoteMark said ${got}, expected ${expected[i]}`);
    else ok(`${what} is read as the "${got}" mark`);
  });
  const clean = testNoteMark(R_BMB_HGH);
  if (clean !== null) fail(`R_BMB_HGH itself carries the "${clean}" mark, so no derived vector proves a mark alone`);
  else ok('R_BMB_HGH itself carries no mark');
}

// ── The module must stay loadable under plain Node ───────────────────────────
{
  const path = 'lib/nostr/test-boost-notes.ts';
  const problems = importFreeProblems(path);
  if (problems.length) { failures += 1; explainImportFree(path, problems); }
  else ok(`${path} has no imports`);
}

if (failures) {
  console.error(`\n${failures} test-note check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll test-note checks passed.');
