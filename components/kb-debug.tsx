'use client';
import { useEffect, useState } from 'react';

/**
 * A live read-out of everything `lib/keyboard-inset.ts` decides from, rendered
 * over the page when the URL carries `?kbdebug=1`.
 *
 * WHY IT EXISTS. The dock's position on iOS is decided by numbers no desktop
 * browser can produce and no screenshot carries: the layout viewport, the
 * visual viewport's height and offset, what has focus, and whether the document
 * is an installed app or a tab. Two rounds of this bug were diagnosed by
 * measuring a phone screenshot in image pixels and dividing by a guessed device
 * ratio, which is how a 51px toolbar and an 88px stranded layer came to look
 * like the same fault. This turns the next report into figures.
 *
 * IT IS NOT A DEVELOPMENT-ONLY TOOL, deliberately: the bug only appears on a
 * real iPhone, usually the reporter's, and asking them to attach a debugger is
 * not a thing that happens. It costs nothing when the flag is absent — the
 * component renders `null` and mounts no listeners — and it is read-only: no
 * focusable element, `pointer-events: none`, `position: fixed`, so it cannot
 * change what it is measuring.
 *
 * THE FLAG IS READ ONCE, on mount. `<HomePage>` mirrors the selected show into
 * the address bar, so a param this component re-read on every render would
 * disappear the moment the visitor opened anything.
 */

type Frame = {
  mode: string;
  layoutH: number;
  vvH: number;
  vvTop: number;
  scale: number;
  lift: number;
  covered: number;
  published: string;
  focus: string;
  navBottom: number;
  strand: number;
};

const NUM = (n: number) => (Number.isFinite(n) ? Math.round(n) : 0);

export function KbDebug() {
  const [on, setOn] = useState(false);
  const [f, setF] = useState<Frame | null>(null);
  const [peak, setPeak] = useState(0);

  useEffect(() => {
    setOn(new URLSearchParams(window.location.search).get('kbdebug') === '1');
  }, []);

  useEffect(() => {
    if (!on) return;
    const vv = window.visualViewport;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const root = document.documentElement;
      const el = document.activeElement;
      const nav = document.querySelector('nav[aria-label="Main"]');
      const navBottom = nav ? nav.getBoundingClientRect().bottom : 0;
      const layoutH = root.clientHeight;
      const vvH = vv ? vv.height : window.innerHeight;
      const vvTop = vv ? vv.offsetTop : 0;
      // The module's two terms, shown SEPARATELY and never netted off against
      // each other — a single figure here is what let two rounds of this bug be
      // read as one fault. `lift` is how far the visual viewport has been
      // scrolled past the layout one; `covered` is what sits on top of it.
      const lift = Math.max(0, vvTop);
      const covered = Math.max(0, layoutH - vvH);
      const next: Frame = {
        mode: window.matchMedia?.('(display-mode: browser)').matches ? 'tab' : 'installed',
        layoutH: NUM(layoutH),
        vvH: NUM(vvH),
        vvTop: NUM(vvTop),
        scale: vv ? Math.round(vv.scale * 100) / 100 : 1,
        lift: NUM(lift),
        covered: NUM(covered),
        published: getComputedStyle(root).getPropertyValue('--kb-inset').trim() || '—',
        focus: el ? `${el.tagName.toLowerCase()}${el instanceof HTMLInputElement ? `[${el.type}]` : ''}` : 'none',
        navBottom: NUM(navBottom),
        // What the reporter sees: how far the bar sits above where bottom:0 is.
        strand: NUM(layoutH - navBottom),
      };
      setF(next);
      setPeak((p) => Math.max(p, next.strand));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv?.removeEventListener('resize', schedule);
      vv?.removeEventListener('scroll', schedule);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
    };
  }, [on]);

  if (!on || !f) return null;

  return (
    <div
      aria-hidden
      className="fixed left-0 right-0 z-[65] px-2 py-1 font-mono text-[10px] leading-tight text-bone bg-ink/90 border-b border-bolt/40 pointer-events-none"
      style={{ top: 'env(safe-area-inset-top, 0px)' }}
    >
      <div>
        <span className="text-bolt">{f.mode}</span>
        {' · layout '}{f.layoutH}
        {' · vv '}{f.vvH}{'@'}{f.vvTop}
        {f.scale !== 1 ? ` ×${f.scale}` : ''}
      </div>
      <div>
        {'lift '}{f.lift}{' · covered '}{f.covered}
        {' · --kb-inset '}<span className="text-bolt">{f.published}</span>
        {' · focus '}{f.focus}
      </div>
      <div>
        {'dock bottom '}{f.navBottom}
        {' · strand '}<span className={f.strand > 2 ? 'text-nostr' : ''}>{f.strand}</span>
        {' · peak '}{peak}
      </div>
    </div>
  );
}
