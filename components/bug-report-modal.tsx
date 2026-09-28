'use client';
import { useMemo, useState } from 'react';
import { ModalShell } from './modal-shell';
import {
  MAX_BUG_REPORT_URL,
  bugReportUrlHere,
  secretInReport,
  type BugReportAnswers,
} from '@/lib/bug-report';

// Asks the three questions, then opens a pre-filled GitHub issue. Opened from
// both header menus (<AuthControl> signed out, <AccountMenu> signed in), each
// rendering it OUTSIDE its `open &&` block so it survives the menu closing.
//
// Nothing here is persisted: a half-typed report is lost on close, which is
// the safe direction for text the user is about to publish.

const FIELDS: { key: keyof BugReportAnswers; label: string; placeholder: string }[] = [
  { key: 'happened', label: 'What happened?', placeholder: 'I pressed BOOST and…' },
  { key: 'expected', label: 'What did you expect?', placeholder: 'The boost to send.' },
  { key: 'steps', label: 'Steps to reproduce', placeholder: '1. Open a show\n2. …' },
];

export function BugReportModal({ onClose }: { onClose: () => void }) {
  const [answers, setAnswers] = useState<BugReportAnswers>({ happened: '', expected: '', steps: '' });

  // The refusal is RENDERED, never silent: a user told nothing retypes the key.
  const secret = useMemo(
    () => secretInReport(`${answers.happened}\n${answers.expected}\n${answers.steps}`),
    [answers],
  );
  const tooLong = useMemo(
    () => typeof window !== 'undefined' && bugReportUrlHere(answers).length > MAX_BUG_REPORT_URL,
    [answers],
  );
  const blocked = secret !== null || tooLong;

  function onContinue() {
    if (blocked) return;
    window.open(bugReportUrlHere(answers), '_blank', 'noopener,noreferrer');
    onClose();
  }

  return (
    <ModalShell onClose={onClose} label="Report a bug" closeButton className="w-full max-w-md p-5">
      <h2 className="font-display text-xl mb-2">Report a bug</h2>
      <p className="text-sm text-bone/80 leading-relaxed">
        This opens a <strong>public</strong> GitHub issue, and you need a GitHub account to send it.
        Do not include keys, wallet strings or anything private.
      </p>

      <div className="mt-4 space-y-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="block text-xs font-mono uppercase tracking-wide text-muted mb-1">{f.label}</span>
            <textarea
              className="input resize-y"
              rows={3}
              value={answers[f.key]}
              placeholder={f.placeholder}
              onChange={(e) => setAnswers((a) => ({ ...a, [f.key]: e.target.value }))}
            />
          </label>
        ))}
      </div>

      {secret && (
        <p role="alert" className="mt-3 text-sm text-nostr">
          {secret === 'nsec'
            ? 'That looks like a Nostr secret key. Remove it: this issue is public.'
            : 'That looks like a wallet connection string. Remove it: this issue is public.'}
        </p>
      )}
      {!secret && tooLong && (
        <p role="alert" className="mt-3 text-sm text-nostr">
          Too long for GitHub. Shorten it.
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2 mt-5">
        {/* Cancel first: the focus trap lands on the first focusable. */}
        <button type="button" onClick={onClose} className="btn-ghost">
          Cancel
        </button>
        <button type="button" onClick={onContinue} disabled={blocked} className="btn disabled:opacity-40">
          Continue to GitHub
        </button>
      </div>
    </ModalShell>
  );
}
