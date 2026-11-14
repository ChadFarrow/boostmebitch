// End-to-end for the GIF picker's playing grid and its two sources
// (docs/money-boosts.md, "A GIF on a boost"; design:
// docs/superpowers/specs/2026-11-14-gif-video-grid-design.md).
//
// Usage:
//   npm run e2e:gifgrid -- --pure                 # section 0 only: no server, no browser
//   npm run dev                                   # in another terminal, then:
//   npm run e2e:gifgrid
//   APP_URL=http://127.0.0.1:3047 npm run e2e:gifgrid -- --headed --keep
//
// WHAT IT PINS. boostmebitch.com searches gifs.nostr.build from the browser;
// boostmebuddy.com searches GIPHY through /api/gifs. Both draw the same grid:
// every GIF near the screen holds a <video> from one page-wide pool and plays
// while it is on screen (nostr.build's grid rules — an animated <img> per tile
// freezes iPhone Safari at 512 threads). Every URL the page renders is rebuilt
// from a validated key, never copied from an API answer.
//
// Section 0 runs the pure modules under plain Node. It is here and not in a
// `check:*` script only because CLAUDE.md, which indexes every check script,
// has no words to spare.
//
// The fixture (scripts/fixtures/gifs-nostr-build.json) is two real answers
// recorded on 2026-11-14 from a page on 127.0.0.1 (the API's development
// client), `tags` removed, plus a synthetic `bad` list.

import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { checker, exit } from './cdp.mjs';

register('./e2e-resolve-hook.mjs', import.meta.url);

const PURE_ONLY = process.argv.includes('--pure');
const FIX = JSON.parse(readFileSync(new URL('./fixtures/gifs-nostr-build.json', import.meta.url), 'utf8'));
const t = checker();
const section = (s) => console.log(`\n${s}`);

// --- 0. Pure --------------------------------------------------------------------
section('0. Pure: keys, URLs, parsers, tiles');
const nb = await import('../lib/gifs/nostr-build.ts');
const pk = await import('../lib/gifs/pick.ts');
const gp = await import('../lib/giphy.ts');

const B = 'https://gifs.nostr.build';
{
  const kept = nb.parseNbResults(FIX.applause);
  t.ok('a real answer keeps 39 of 40 or more', kept.length >= 39, `kept ${kept.length}`);
  t.ok('every kept key passes isNbKey', kept.every((r) => nb.isNbKey(r.key)));
  const odd = FIX.applause.items.find((g) => g.url !== `${B}/${g.id}`);
  const oddKept = kept.find((r) => r.title === (odd?.title ?? '').trim().slice(0, 120));
  t.equal('a result whose id differs from its file keeps the FILE key',
    oddKept?.key, odd?.url.split('/').at(-1));
  const tile = pk.nbTile(kept[0]);
  t.equal('nbTile builds every URL from the key', [tile.mp4, tile.animated, tile.still], [
    `${B}/mp4/orig/${kept[0].key}`, `${B}/anim/w240/${kept[0].key}`, `${B}/still/w240/${kept[0].key}`,
  ]);
}
{
  const kept = nb.parseNbResults(FIX.bad);
  const titles = kept.map((r) => r.title);
  t.ok('a foreign-host url is dropped', !titles.includes('foreign host url'), JSON.stringify(titles));
  t.ok('an mp4 with # is dropped', !titles.includes('hash in mp4'));
  t.ok('a url/mp4 key mismatch is dropped', !titles.includes('url mp4 mismatch'));
  t.equal('a javascript: lqip becomes null', kept.find((r) => r.title === 'javascript lqip')?.lqip, null);
  const tr = kept.find((r) => r.title === 'transparent');
  t.equal('a transparent item keeps webm and hevc', [tr?.webm, tr?.hevc, tr?.transparent], [
    `${B}/webm/orig/${'8'.repeat(64)}.gif`, `${B}/hevc/orig/${'8'.repeat(64)}.gif`, true,
  ]);
  t.equal('a foreign webm becomes null, the item stays', kept.find((r) => r.title === 'foreign webm')?.webm, null);
  t.equal('extreme sizes are kept as given', ['very wide', 'very tall'].map((n) => {
    const r = kept.find((x) => x.title === n);
    return r && [r.width, r.height];
  }), [[1000, 50], [50, 1000]]);
  t.equal('a non-array answer parses to nothing', nb.parseNbResults({ items: 'x' }), []);
}
{
  t.equal('normalizeNbQuery trims, collapses and lowercases', nb.normalizeNbQuery('  Cat   Videos '), 'cat videos');
  t.equal('one Latin letter is not a search', nb.normalizeNbQuery('a'), null);
  t.equal('an emoji alone is a search', nb.normalizeNbQuery('😂'), '😂');
  t.equal('an empty box is not a search', nb.normalizeNbQuery('   '), null);
  t.equal('600 characters are cut to 500 code points', [...nb.normalizeNbQuery('x'.repeat(600))].length, 500);
  t.equal('the cut never splits an emoji', nb.normalizeNbQuery('😂'.repeat(600)), '😂'.repeat(500));
  const u = new URL(nb.nbSearchUrl('cat videos'));
  t.equal('nbSearchUrl asks /api/v1/search with q and limit=200 only',
    [u.origin + u.pathname, u.searchParams.get('q'), u.searchParams.get('limit'), [...u.searchParams.keys()].length],
    [`${B}/api/v1/search`, 'cat videos', '200', 2]);
  t.equal('NB_BROWSE_URL is the daily reaction list', nb.NB_BROWSE_URL, `${B}/api/v1/gifs?kind=reaction&limit=200`);
}
{
  const key = `${'a'.repeat(64)}.gif`;
  t.equal('the nostr.build wire URL', pk.gifWireUrl({ src: 'nostrbuild', key }), `${B}/${key}`);
  t.equal('the GIPHY wire URL', pk.gifWireUrl({ src: 'giphy', id: '1VQr7rkEjsLXG' }),
    'https://media.giphy.com/media/1VQr7rkEjsLXG/giphy.gif');
  t.equal('a nostr.build wire line reads back', pk.gifPickFromWireLine(`${B}/${key}`), { src: 'nostrbuild', key });
  t.equal('a GIPHY wire line reads back', pk.gifPickFromWireLine('https://media.giphy.com/media/1VQr7rkEjsLXG/giphy.gif'),
    { src: 'giphy', id: '1VQr7rkEjsLXG' });
  t.equal('a preview URL is not a wire line', pk.gifPickFromWireLine(`${B}/still/w240/${key}`), null);
  t.equal('another host is not a wire line', pk.gifPickFromWireLine(`https://evil.example/${key}`), null);
  t.equal('trailing text is not a wire line', pk.gifPickFromWireLine(`${B}/${key} hi`), null);
  t.equal('gifPreviewUrl is the animated rendition', [
    pk.gifPreviewUrl({ src: 'nostrbuild', key }), pk.gifPreviewUrl({ src: 'giphy', id: '1VQr7rkEjsLXG' }),
  ], [`${B}/anim/w240/${key}`, 'https://media.giphy.com/media/1VQr7rkEjsLXG/200w.webp']);
  t.equal('gifPickKey names the source and the key', [
    pk.gifPickKey({ src: 'nostrbuild', key }), pk.gifPickKey({ src: 'giphy', id: 'abcd' }),
  ], [`nostrbuild:${key}`, 'giphy:abcd']);
}
{
  const rows = gp.parseGiphyResults({ data: [
    { id: '1VQr7rkEjsLXG', title: 'a', images: { fixed_width: { width: '200', height: '146' } } },
    { id: 'HXPTVAGwSfuHuDFGtQ', title: 'b', images: { original: { width: '480', height: '270' } } },
    { id: 'K5Jydr81T7DVwRyaIj', title: 'c' },
    { id: 'KJjVPma0lFzl03HErv', title: 'd', images: { fixed_width: { width: '-3', height: 'x' } } },
  ] });
  t.equal('GIPHY sizes: fixed_width, else original, else null', rows.map((r) => [r.id, r.width, r.height]), [
    ['1VQr7rkEjsLXG', 200, 146], ['HXPTVAGwSfuHuDFGtQ', 480, 270], ['K5Jydr81T7DVwRyaIj', null, null],
    ['KJjVPma0lFzl03HErv', null, null],
  ]);
  const tile = pk.giphyTile(rows[2]);
  t.equal('a GIPHY tile with no size is a 200×200 square', [tile.width, tile.height], [200, 200]);
  t.equal('a GIPHY tile plays 200w.mp4 and falls back to 200w.webp, 200w_s.gif',
    [tile.mp4, tile.animated, tile.still, tile.alpha, tile.lqip], [
      `https://media.giphy.com/media/${rows[2].id}/200w.mp4`, `https://media.giphy.com/media/${rows[2].id}/200w.webp`,
      `https://media.giphy.com/media/${rows[2].id}/200w_s.gif`, null, null,
    ]);
}

if (PURE_ONLY) {
  console.log(`\n${t.count - t.fails}/${t.count} checks passed`);
  await exit(t.fails ? 1 : 0);
}

console.log(`\n${t.count - t.fails}/${t.count} checks passed`);
await exit(t.fails ? 1 : 0);
