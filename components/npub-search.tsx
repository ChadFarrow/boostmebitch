'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseNpubInput } from '@/lib/nostr/npub-input';
import { useApp } from '@/lib/store';

/**
 * Look up any npub's boost history.
 *
 * Deliberately NOT a mode on <SearchBar>. That one debounces 280 ms and carries
 * a generation counter because it races an HTTP request per keystroke; here
 * validation is `nip19.decode` and completes synchronously, so a debounce would
 * buy nothing and the race guard would guard nothing. Sharing would mean one
 * component branching on a flag through every line that matters.
 *
 * A <form> rather than an input plus a click handler, so Enter submits and a
 * screen reader gets a real submit button.
 *
 * An invalid entry stops HERE rather than navigating to a route that then says
 * "not valid" — the user is looking at the box they just typed in, and that is
 * where the answer belongs.
 */
export function NpubSearch() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const identity = useApp((s) => s.identity);

  // `identity` hydrates from localStorage at MODULE scope in lib/store.ts, so
  // it is already set on the client before React hydrates but empty on the
  // server. Gating the shortcut on `mounted` keeps the first client render
  // matching the SSR markup — the same failure the favorites panel documents.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseNpubInput(value);
    if (!parsed) {
      setErr('Not an npub. Paste an npub, an nprofile, a hex pubkey, or a profile link.');
      return;
    }
    setErr(null);
    router.push(`/npub/${parsed.npub}`);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      {/* Wraps rather than hiding a button on narrow screens: a phone is where
          someone is most likely to want their own boost history, and
          `hidden sm:inline-flex` on MY BOOSTS took it away from exactly them.
          `min-w-[11rem]` keeps the input usable on the wrapped line. */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[11rem]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-xs">⚡</span>
          <input
            className="input pl-8"
            value={value}
            onChange={(e) => { setValue(e.target.value); setErr(null); }}
            aria-label="Nostr npub"
            placeholder="npub, nprofile, hex pubkey or profile link…"
          />
        </div>
        <button type="submit" className="btn-ghost shrink-0">LOOK UP</button>
        {mounted && identity && (
          <button
            type="button"
            onClick={() => router.push(`/npub/${identity.npub}`)}
            className="btn-ghost shrink-0"
          >
            MY BOOSTS
          </button>
        )}
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
    </form>
  );
}
