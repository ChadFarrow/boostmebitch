// Drives the beta marker in a real browser at phone size, in both modes.
//
//   NEXT_PUBLIC_BETA=1 npm run build && npm start     # in another terminal
//   BETA_EXPECT=on npm run e2e:beta
//
//   npm run build && npm start                        # in another terminal
//   BETA_EXPECT=off npm run e2e:beta
//
//   APP_URL=https://beta.boostmebitch.com BETA_EXPECT=on npm run e2e:beta
//
// `BETA_EXPECT` has no default on purpose: a script that guessed the mode would
// pass against the wrong build and prove nothing.
//
// THIS MUST NEVER FILE A REPORT. `/api/bug-report` files a PUBLIC issue under
// the owner's name, and this script also runs against deployed sites that hold
// `GITHUB_BUG_TOKEN`. So `window.fetch` answers that route itself, before the
// app's scripts run, and the Network domain confirms that no request left.
//
// THE PHONE IS A CDP OVERRIDE, never `--window-size`: docs/testing.md and the
// global notes record how a window size alone produces a false overflow.
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
const EXPECT = process.env.BETA_EXPECT;
if (EXPECT !== 'on' && EXPECT !== 'off') {
  console.error('Set BETA_EXPECT=on or BETA_EXPECT=off, to match the build under test.');
  process.exit(2);
}
await requireApp(`${APP}/privacy`, `Nothing is serving ${APP}. Start it in another terminal, as the header says.`);

const DOMAIN = 'boostmebitch.com';
const TAG = '[data-beta-tag]';
const DIALOG = `[...document.querySelectorAll('[role="dialog"]')].find((d) => /Report a bug/.test(d.querySelector('h2')?.textContent ?? ''))`;
const PAGES = ['/', '/privacy', '/?podcast=abc'];

const { page } = await launchChrome({ name: 'beta', args: ['--disable-gpu'] });
const { send } = page;
const js = page.jsOrThrow;
const t = checker();

const reportRequests = [];
page.on((d) => {
  if (d.method === 'Network.requestWillBeSent' && d.params.request?.url?.includes('/api/bug-report')) {
    reportRequests.push(d.params.request.url);
  }
});

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__reports = [];
    const real = window.fetch;
    window.fetch = (input, init) => {
      if (String(input?.url ?? input).includes('/api/bug-report')) {
        window.__reports.push(JSON.parse(init.body));
        return Promise.resolve(new Response('{"number":1}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return real(input, init);
    };
  })();`,
});

const go = async (path) => { await send('Page.navigate', { url: `${APP}${path}` }); await wait(4000); };
const robots = () => js(`document.querySelector('meta[name="robots"]')?.content ?? null`);
const tagState = () => js(`(() => {
  const el = document.querySelector(${JSON.stringify(TAG)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const h = document.querySelector('header')?.getBoundingClientRect();
  const s = getComputedStyle(el);
  return {
    text: el.textContent.trim(),
    pointerEvents: s.pointerEvents,
    zIndex: Number(s.zIndex),
    inViewport: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    overHeader: !!h && r.left < h.right && r.right > h.left && r.top < h.bottom && r.bottom > h.top,
    hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el,
  };
})()`);

async function sendReport() {
  const opened = await js(`(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 400));
    const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find((b) => /Sign in/.test(b.textContent));
    if (!trigger) return 'no menu button';
    trigger.click(); await tick();
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((b) => /Report a bug/.test(b.textContent));
    if (!item) return 'no menu item';
    item.click(); await tick();
    return !!(${DIALOG});
  })()`);
  t.equal('the report modal opens', opened, true);
  if (opened !== true) return null;
  if (EXPECT === 'on') {
    const open = await tagState();
    t.ok('the tag still shows with the modal open', open?.inViewport && open.zIndex > 60, JSON.stringify(open));
  }
  return js(`(async () => {
    const dlg = ${DIALOG};
    const ta = dlg.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'e2e: beta marker'); ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    [...dlg.querySelectorAll('button')].find((b) => /Send report/.test(b.textContent)).click();
    for (let i = 0; i < 25 && !window.__reports.length; i++) await new Promise((r) => setTimeout(r, 200));
    return window.__reports.at(-1) ?? null;
  })()`);
}

console.log(`Mode ${EXPECT}, at ${APP}, 390x844 mobile`);
await go('/');
const tag = await tagState();
const overflow = await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
t.ok('no sideways scroll', overflow <= 0, `scrollWidth is ${overflow}px over clientWidth`);

if (EXPECT === 'on') {
  t.equal('the tag says BETA', tag?.text, 'BETA');
  t.equal('it blocks no touch: pointer-events', tag?.pointerEvents, 'none');
  t.equal('it blocks no touch: a hit test goes through it', tag?.hit, false);
  t.ok('it stays below the iOS status strip', tag?.zIndex < 70, `z-index ${tag?.zIndex}`);
  t.equal('it is inside the viewport', tag?.inViewport, true);
  t.equal('it does not cover the header', tag?.overHeader, false);
} else {
  t.equal('there is no tag', tag, null);
}

for (const path of PAGES) {
  await go(path);
  const content = await robots();
  if (EXPECT === 'on') t.ok(`${path} has noindex`, /noindex/.test(content ?? ''), `robots: ${content}`);
  else t.ok(`${path} has no noindex`, !/noindex/.test(content ?? ''), `robots: ${content}`);
}

await go('/');
const report = await sendReport();
t.equal('the report names this site', report?.info?.site, EXPECT === 'on' ? `beta.${DOMAIN}` : DOMAIN);
t.equal('no request reached /api/bug-report', reportRequests, []);

console.log(t.fails ? `\nSMOKE FAILED (${t.fails} of ${t.count})` : `\nSMOKE OK (${t.count})`);
await exit(t.fails ? 1 : 0);
