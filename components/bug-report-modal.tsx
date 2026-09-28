'use client';
import { useMemo, useState } from 'react';
import { ModalShell } from './modal-shell';
import { availableRails } from './rail-picker';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { pickRail } from '@/lib/v4v/boost';
import { BRAND } from '@/lib/brand';
import { BUILD_ID } from '@/lib/build-id';
import { fmt } from '@/lib/format';
import { getErrorMessage } from '@/lib/util';
import {
  APP_INFO_KEYS,
  MAX_ANSWER_CHARS,
  secretInReport,
  type AppInfo,
  type BugReportAnswers,
} from '@/lib/bug-report';

// Asks three questions, shows the app snapshot that goes with them, and POSTs
// both to /api/bug-report, which files the GitHub issue. Opened from both
// header menus (<AuthControl> signed out, <AccountMenu> signed in), each
// rendering it OUTSIDE its `open &&` block so it survives the menu closing.
//
// Nothing here is persisted: a half-typed report is lost on close.

const FIELDS: { key: keyof BugReportAnswers; label: string; placeholder: string }[] = [
  { key: 'happened', label: 'What happened?', placeholder: 'I pressed BOOST and…' },
  { key: 'expected', label: 'What did you expect?', placeholder: 'The boost to send.' },
  { key: 'steps', label: 'Steps to reproduce', placeholder: '1. Open a show\n2. …' },
];

// The snapshot is taken ONCE, when the modal opens — the state the user saw
// the bug in, not the state after they typed for a minute. Every value is on
// the allowlist in lib/bug-report.ts; no npub, key, connection string, balance
// or URL query/fragment.
function takeSnapshot(): AppInfo {
  const s = useApp.getState();
  const rails = availableRails();
  const rail = pickRail();
  const cur = s.current;
  const favShows = Object.keys(s.favorites).length;
  const favEps = Object.keys(s.favoriteEpisodes).length;
  return {
    site: BRAND.domain,
    build: BUILD_ID,
    page: window.location.pathname,
    installedApp: window.matchMedia?.('(display-mode: standalone)').matches ? 'yes' : 'no',
    online: navigator.onLine ? 'yes' : 'no',
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    browser: navigator.userAgent,
    signedIn: s.identity ? 'yes' : 'no',
    signer: s.identity ? (storage.signer.get() ?? 'nip07') : undefined,
    wallets: rails.length ? rails.join(', ') : 'none',
    boostRail: rail ? `${rail}${storage.railPref.get() ? ' (chosen)' : ''}` : undefined,
    streaming: storage.streaming.isOn() ? 'on' : 'off',
    favoritesSync: s.favoritesSync,
    favorites: `${favShows} shows, ${favEps} episodes`,
    nowPlaying: cur ? `${cur.podcast.title} — ${cur.episode.title}` : 'nothing',
    medium: cur?.podcast.medium,
    feedGuid: cur?.podcast.podcastGuid,
    episodeGuid: cur?.episode.guid,
    position: cur ? fmt(s.positionSec) : undefined,
    playback: cur ? (s.isPlaying ? 'playing' : 'paused') : undefined,
    live: cur?.episode.liveStatus,
  };
}

type Status =
  | { kind: 'editing' }
  | { kind: 'sending' }
  | { kind: 'sent'; number: number | null }
  | { kind: 'failed'; message: string };

export function BugReportModal({ onClose }: { onClose: () => void }) {
  const [answers, setAnswers] = useState<BugReportAnswers>({ happened: '', expected: '', steps: '' });
  const [info] = useState<AppInfo>(takeSnapshot);
  // On by default, because it is what makes most reports fixable; the user
  // can still send the text alone. Off sends NO snapshot at all.
  const [includeInfo, setIncludeInfo] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: 'editing' });

  // The refusal is RENDERED, never silent: a user told nothing retypes the key.
  const secret = useMemo(
    () => secretInReport(`${answers.happened}\n${answers.expected}\n${answers.steps}`),
    [answers],
  );
  const empty = !answers.happened.trim();
  const sending = status.kind === 'sending';
  const blocked = secret !== null || empty || sending;

  async function onSend() {
    if (blocked) return;
    setStatus({ kind: 'sending' });
    try {
      const res = await fetch('/api/bug-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, info: includeInfo ? info : {} }),
      });
      const data = (await res.json().catch(() => ({}))) as { number?: number | null; error?: string };
      if (!res.ok) {
        // A 400 names what is wrong with the report; anything else is ours,
        // and the typed text is still in the form for a retry.
        const message = res.status === 429
          ? 'Too many reports from this network. Try again in a minute.'
          : res.status === 400 && data.error
            ? `The report was refused: ${data.error}.`
            : res.status === 503
              ? 'Bug reports are not set up on this site yet.'
              : 'The report did not send. Try again later.';
        setStatus({ kind: 'failed', message });
        return;
      }
      setStatus({ kind: 'sent', number: data.number ?? null });
    } catch (e) {
      setStatus({ kind: 'failed', message: getErrorMessage(e, 'The report did not send.') });
    }
  }

  if (status.kind === 'sent') {
    return (
      <ModalShell onClose={onClose} label="Report sent" closeButton className="w-full max-w-md p-5">
        <h2 className="font-display text-xl mb-2">Thank you</h2>
        <p className="text-sm text-bone/80 leading-relaxed">
          Your report is sent{status.number ? ` (#${status.number})` : ''}. We read every one.
        </p>
        <div className="flex justify-end mt-5">
          <button type="button" onClick={onClose} className="btn">Done</button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      onClose={onClose}
      label="Report a bug"
      closeButton
      dismissable={!sending}
      className="w-full max-w-md p-5"
    >
      <h2 className="font-display text-xl mb-2">Report a bug</h2>
      <p className="text-sm text-bone/80 leading-relaxed">
        Reports are <strong>public</strong>. Do not include keys, wallet strings or anything private.
      </p>

      <div className="mt-4 space-y-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="block text-xs font-mono uppercase tracking-wide text-muted mb-1">{f.label}</span>
            <textarea
              className="input resize-y"
              rows={f.key === 'happened' ? 3 : 2}
              maxLength={MAX_ANSWER_CHARS}
              value={answers[f.key]}
              placeholder={f.placeholder}
              disabled={sending}
              onChange={(e) => setAnswers((a) => ({ ...a, [f.key]: e.target.value }))}
            />
          </label>
        ))}
      </div>

      <label className="mt-4 flex items-start gap-2 text-sm cursor-pointer min-h-6">
        <input
          type="checkbox"
          className="mt-1 accent-bolt"
          checked={includeInfo}
          disabled={sending}
          onChange={(e) => setIncludeInfo(e.target.checked)}
        />
        <span>
          Include app info
          <span className="block text-[11px] text-muted">
            Super helpful: it shows us your device, sign-in and wallet type, and what was playing.
            No keys, wallet strings or balances.
          </span>
        </span>
      </label>

      <details className={`mt-2 text-xs ${includeInfo ? '' : 'opacity-40'}`}>
        <summary className="btn-inline text-muted cursor-pointer">
          {includeInfo ? 'See the app info we send' : 'App info (not sent)'}
        </summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          {APP_INFO_KEYS.filter(([k]) => info[k]).map(([k, label]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="text-bone/80 break-all">{info[k]}</dd>
            </div>
          ))}
        </dl>
      </details>

      {secret && (
        <p role="alert" className="mt-3 text-sm text-nostr">
          {secret === 'nsec'
            ? 'That looks like a Nostr secret key. Remove it: reports are public.'
            : 'That looks like a wallet connection string. Remove it: reports are public.'}
        </p>
      )}
      {status.kind === 'failed' && (
        <p role="alert" className="mt-3 text-sm text-nostr">{status.message}</p>
      )}

      <div className="flex flex-wrap justify-end gap-2 mt-5">
        {/* Cancel first: the focus trap lands on the first focusable. */}
        <button type="button" onClick={onClose} disabled={sending} className="btn-ghost">
          Cancel
        </button>
        <button type="button" onClick={onSend} disabled={blocked} className="btn disabled:opacity-40">
          {sending ? 'Sending…' : 'Send report'}
        </button>
      </div>
    </ModalShell>
  );
}
