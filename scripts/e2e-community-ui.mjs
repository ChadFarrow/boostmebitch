// e2e for the community-playlist screens (maker, home button), in a real browser.
//
// Needs a dev server started with, on the command line (never in .env.local):
//   COMMUNITY_DB_URL=postgres://postgres:test@localhost:54329/postgres
//   ADMIN_NPUBS=<any npub> NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on
//   NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN=http://localhost:3123 npm run dev -- -p 3123
// and the schema applied (`npm run community:schema`). APP_URL overrides the server.
// The signer is a throwaway key behind a fake NIP-07 `window.nostr`, and relays point
// at a LOCAL relay, so nothing reaches a public relay.
import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const APP = (process.env.APP_URL || 'http://localhost:3123').replace(/\/$/, '');
await requireApp(APP, `Nothing is serving ${APP}. Start the dev server (see the top of this file).`);

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const relay = createRelay({ port: 0, log: null });
const PORT = await relay.ready;

const { page } = await launchChrome({
  name: `communityui-${process.env.CLAUDE_CODE_SESSION_ID || 'local'}`,
  args: ['--disable-gpu'],
});
const { send } = page;
const js = page.jsOrThrow;
await send('Page.enable'); await send('Runtime.enable');

// A window.nostr indistinguishable from an extension, reached over a CDP binding.
await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = pk;
    else if (fn === 'signEvent') out = finalizeEvent(args[0], sk);
    else err = `no such method ${fn}`;
  } catch (e) { err = String(e?.message ?? e); }
  await js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`);
});
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    const waiting = new Map(); let n = 0;
    window.__bmbResolve = (rid, r) => { const p = waiting.get(rid); waiting.delete(rid); r.err ? p.reject(new Error(r.err)) : p.resolve(r.out); };
    const call = (fn, ...args) => new Promise((resolve, reject) => {
      const rid = 'r' + (++n); waiting.set(rid, { resolve, reject });
      window.bmbSigner(JSON.stringify({ rid, fn, args }));
    });
    window.nostr = { getPublicKey: () => call('getPublicKey'), signEvent: (e) => call('signEvent', e) };
  })();
` });

const t = checker();
await send('Page.navigate', { url: APP });
await wait(500);
await js(`(() => { localStorage.clear(); return 1; })()`);

// ---- lines are appended below by the tasks that add the screens -----------

console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
