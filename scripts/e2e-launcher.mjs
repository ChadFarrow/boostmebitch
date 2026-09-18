// Drives the REAL <UnofficialAppNotice> in a real browser and asserts when it
// shows and when it must not. See lib/launcher.ts for what the signal is.
//
// WHY THIS IS AN E2E AND NOT A `check:*`. `parseLauncherPackage` is a regex;
// every way the feature goes wrong is wiring — what `document.referrer` says
// at the moment the effect runs, whether the tab remembers it across a
// navigation, and that a shared deep link from a chat app does NOT get a notice
// (the false positive that would make this a nuisance for every Android user).
//
// `document.referrer` IS FAKED, and it has to be: Chrome exposes only http(s)
// referrers to a CDP-driven navigation, so the `android-app://` value a TWA
// really sets cannot be produced from outside. What is faked is only the
// SOURCE, installed before the app's own JS runs; everything downstream is the
// shipping code. Same technique as e2e-keyboard.mjs's visualViewport.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:launcher
//
// The browser comes from scripts/cdp.mjs: CHROME_PATH, else the usual install
// paths; muted, on a free debug port, and closed on any exit.
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);
const { page } = await launchChrome({ name: 'launcher', args: ['--window-size=1200,900'] });
const { send, js } = page;
const exceptions = [];
page.on((d) => { if (d.method === 'Runtime.exceptionThrown') exceptions.push(d.params.exceptionDetails?.exception?.description ?? ''); });
const t = checker();
const check = (l, a, b) => t.equal(l, a, b);
await send('Page.enable'); await send('Runtime.enable');
// CDP cannot make `document.referrer` an `android-app://` value (Chrome exposes
// only http(s) referrers to a CDP-driven navigation), so the SOURCE is faked
// before the page's own scripts run — everything downstream is the shipping
// code. Same technique as scripts/e2e-keyboard.mjs's visualViewport.
let stubId = null;
const setReferrer = async (value) => {
  if (stubId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubId });
  stubId = null;
  if (value === null) return;
  const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(document, 'referrer', { get: () => ${JSON.stringify(value)} });` });
  stubId = r.result.identifier;
};
const nav = async (url, referrer) => { await setReferrer(referrer ?? null); await send('Page.navigate', { url }); };
const notice = () => js(`(() => { const el = [...document.querySelectorAll('[role="status"]')].find(e => /not the official/.test(e.textContent)); return el ? el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 140) : null; })()`);
const fresh = async () => { await js(`sessionStorage.clear(); localStorage.clear(); true`); };

console.log('1. a fork wrapper: android-app://com.someone.fork/ landing on /');
await nav(`${APP}/`, 'android-app://com.someone.fork/'); await wait(4000);
const n1 = await notice();
check('the notice names the package', typeof n1 === 'string' && n1.includes('com.someone.fork'), true);
check('it names whose servers', typeof n1 === 'string' && n1.includes("boostmebitch.com's servers"), true);
check('document.referrer was the android-app one', await js('document.referrer'), 'android-app://com.someone.fork/');
console.log('2. the notice survives a client navigation and a reload in the same tab');
await nav(`${APP}/live`, null); await wait(3000);
check('still shown on another route (remembered for the tab)', (await notice()) !== null, true);
console.log('3. dismiss hides it for the tab');
await js(`[...document.querySelectorAll('[role="status"] button[aria-label="Dismiss"]')][0]?.click(); true`); await wait(300);
check('gone after dismiss', await notice(), null);
await nav(`${APP}/`, 'android-app://com.someone.fork/'); await wait(3000);
check('stays dismissed after a reload in the tab', await notice(), null);

console.log('4. our own package: no notice');
await fresh(); await nav(`${APP}/`, 'android-app://com.boostmebitch/'); await wait(3500);
check('no notice for com.boostmebitch', await notice(), null);
await fresh(); await nav(`${APP}/`, 'android-app://com.boostmebuddy/'); await wait(3500);
check('no notice for com.boostmebuddy', await notice(), null);

console.log('5. a shared deep link opened from a chat app: no notice');
await fresh(); await nav(`${APP}/privacy`, 'android-app://org.telegram.messenger/'); await wait(3500);
check('no notice on a deep link', await notice(), null);
await fresh(); await nav(`${APP}/?podcast=abc`, 'android-app://org.telegram.messenger/'); await wait(3500);
check('no notice on / with a query', await notice(), null);

console.log('6. a plain browser visit: no notice');
await fresh(); await nav(`${APP}/`, null); await wait(3500);
check('no notice without a referrer', await notice(), null);
check('no uncaught exceptions', exceptions.length, 0);
console.log(t.fails ? `\nSMOKE FAILED (${t.fails})` : '\nSMOKE OK');
await exit(t.fails ? 1 : 0);
