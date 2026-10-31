'use client';
import { useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import type { FavoritesPrivacy } from '@/lib/nostr/favorites-list';
import { BRAND } from '@/lib/brand';
import { useFavoritesMode } from '@/components/favorites-privacy';
import { parseOpml } from '@/lib/feed-xml';
import {
  OPML_LOOKUP_PER_RUN, OPML_MAX_BYTES, OPML_MAX_FEEDS,
  buildOpml, opmlFilename, planOpmlImport, sortOpmlAnswers,
  type OpmlFeed, type OpmlPlan, type OpmlSkip,
} from '@/lib/opml';
import { lookupFeedUrls, resolvePodcastByGuid, warmPodcastCache } from '@/lib/podcast-meta';
import { favoriteFromPodcast, requestFavoritesSync } from '@/lib/nostr';
import { saveFile } from '@/lib/save-file';
import { getErrorMessage, mapLimit } from '@/lib/util';
import type { FavoritePodcast, Podcast } from '@/lib/types';

/**
 * OPML import and export on the favorites page.
 *
 * WHO IT IS FOR: a new user arriving from another podcast app, who exports an
 * OPML file there and imports it here so they do not have to find every show
 * again. A "subscription" in this app is a favorite SHOW, so the import adds
 * feed favorites through the same store action and the same
 * `requestFavoritesSync` a ♡ press uses — the privacy question, the
 * read-merge-publish and every refusal in it apply unchanged. The rules (what
 * may be looked up, what an answer means, the bytes an export writes) are in
 * `lib/opml.ts`; this file is only the screen.
 *
 * TWO STEPS, NOT ONE. The file is read and every show looked up first, and
 * nothing is added until the user presses ADD under a count of what will be.
 * A ♡ adds one show the user is looking at; this adds hundreds the user is
 * not, to a list that is public by default, and the wrong file is an easy
 * mistake to make from a Downloads folder.
 *
 * THE STATE LIVES IN THE PAGE (`useOpmlImport`), not in a trigger. The import
 * starts from the empty-library card and the card unmounts the moment the
 * shows land, so a panel inside it would take the "not added" list with it —
 * the one part of the result the user cannot reconstruct.
 */

interface ImportRun {
  fileName: string;
  plan: OpmlPlan;
  /** Keyed by `OpmlFeed.url`. ABSENT = not answered — see `sortOpmlAnswers`. */
  answers: Record<string, Podcast | null>;
  /** The last lookup stopped before it finished (rate limit, outage, offline). */
  stopped: boolean;
  /** Shows the last press of ADD added, or null before one. */
  added: number | null;
  /** That add did not reach localStorage. */
  unsaved: boolean;
}

type ImportState =
  | { step: 'idle' }
  | { step: 'busy'; text: string }
  | { step: 'ready'; run: ImportRun }
  | { step: 'error'; text: string };

export interface OpmlImporter {
  state: ImportState;
  busy: boolean;
  pick: (file: File) => void;
  lookUpMore: () => void;
  add: () => void;
  dismiss: () => void;
}

export function useOpmlImport(): OpmlImporter {
  const [state, setState] = useState<ImportState>({ step: 'idle' });
  const addFavorites = useApp((s) => s.addFavorites);
  const identity = useApp((s) => s.identity);
  const busy = state.step === 'busy';

  const isFavorite = (guid: string) => !!useApp.getState().favorites[guid];

  async function lookUp(run: ImportRun) {
    // The NEXT slice of what has no answer yet — the first run, a "check the
    // next 500", and a retry after a rate limit are all this one call.
    const todo = sortOpmlAnswers(run.plan.feeds, run.answers, isFavorite)
      .unasked.slice(0, OPML_LOOKUP_PER_RUN);
    const total = todo.length;
    setState({ step: 'busy', text: `looking up ${total} ${total === 1 ? 'show' : 'shows'} in Podcast Index…` });
    try {
      const res = await lookupFeedUrls(todo.map((f) => f.url), (asked) =>
        setState({ step: 'busy', text: `looking up shows in Podcast Index… ${Math.min(asked, total)} of ${total}` }),
      );
      setState({
        step: 'ready',
        run: { ...run, answers: { ...run.answers, ...res.answers }, stopped: res.stopped, added: null },
      });
    } catch (e) {
      // Nothing above throws on purpose; this keeps a bug from leaving the
      // panel spinning forever with the file's work lost.
      setState({ step: 'ready', run: { ...run, stopped: true } });
      console.warn('[opml] lookup failed', e);
    }
  }

  async function pick(file: File) {
    if (busy) return;
    if (file.size > OPML_MAX_BYTES) {
      setState({
        step: 'error',
        text: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. An OPML export is much smaller — check that this is the right file.`,
      });
      return;
    }
    setState({ step: 'busy', text: 'reading the file…' });
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      setState({ step: 'error', text: getErrorMessage(e, 'The file could not be read.') });
      return;
    }
    const outlines = parseOpml(text);
    if (!outlines) {
      setState({
        step: 'error',
        text: 'This is not an OPML file. In your other podcast app, look for “Export OPML” or “Export subscriptions” in its settings.',
      });
      return;
    }
    if (!outlines.length) {
      setState({ step: 'error', text: 'This OPML file lists no shows.' });
      return;
    }
    const run: ImportRun = {
      fileName: file.name,
      plan: planOpmlImport(outlines),
      answers: {},
      stopped: false,
      added: null,
      unsaved: false,
    };
    if (!run.plan.feeds.length) {
      setState({ step: 'ready', run });
      return;
    }
    await lookUp(run);
  }

  function add() {
    if (state.step !== 'ready') return;
    const { run } = state;
    const { add: found } = sortOpmlAnswers(run.plan.feeds, run.answers, isFavorite);
    // File order, newest first: the first show in the file gets the latest
    // stamp, so the "recent" sort shows the import in the order it was written.
    const now = Date.now();
    const favs = found
      .map(({ podcast }, i) => {
        const fav = favoriteFromPodcast(podcast);
        return fav ? { ...fav, addedAt: now - i } : null;
      })
      .filter((f): f is FavoritePodcast => f !== null);
    if (!favs.length) return;
    const landed = addFavorites(favs);
    // ONE sync for the whole import, through the funnel every heart uses: it
    // asks the never-chosen privacy question, does nothing on 'off', and is
    // debounced, so 500 shows cost one signing prompt.
    requestFavoritesSync(identity);
    setState({ step: 'ready', run: { ...run, added: favs.length, unsaved: !landed } });
  }

  return {
    state,
    busy,
    pick: (file) => { void pick(file); },
    lookUpMore: () => { if (state.step === 'ready' && !busy) void lookUp(state.run); },
    add,
    dismiss: () => { if (!busy) setState({ step: 'idle' }); },
  };
}

/**
 * The trigger. A real `<button>` that opens a hidden file input, so it is
 * reachable from a keyboard — a `<label>` styled as a button is not.
 *
 * NO `accept` ATTRIBUTE, on purpose. iOS greys out every file whose type it
 * does not recognise when `accept` is set, and an `.opml` saved from another
 * app to Files is exactly such a file: the picker would open with the user's
 * export visible and unselectable. `parseOpml` says plainly when the file
 * picked is not OPML, which is the better place for that check.
 */
export function OpmlImportButton({
  importer,
  className = 'btn-mini disabled:opacity-50',
}: {
  importer: OpmlImporter;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={importer.busy}
        className={className}
        title="Add the shows from another podcast app's OPML export to your favorites."
      >
        ⇧ import opml
      </button>
      {/* `data-opml-input` is what `e2e:opml` hands the file to. Signed in,
          `⇧ RESTORE FROM BACKUP` renders a hidden file input EARLIER in the
          page, and "the first file input" is that one. */}
      <input
        ref={input}
        type="file"
        data-opml-input=""
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so picking the SAME file again (after a rate limit, say)
          // still fires `change`.
          e.target.value = '';
          if (file) importer.pick(file);
        }}
      />
    </>
  );
}

/**
 * Where the new favorites go — the four cases the privacy control describes,
 * one sentence each.
 *
 * SAID BEFORE THE ADD, not only after it. A fresh account is usually already
 * Public by the time it gets here: `seedFavoritesMode` seeds an EMPTY relay
 * list as public (PC20-Nostr#47), so the never-chosen prompt does not appear
 * and ADD publishes. That is right for a ♡ — one show, on screen — and is the
 * reason this sentence sits next to the button: a few hundred shows going onto
 * a public list is the thing to know before pressing it.
 */
function destination(signedIn: boolean, mode: FavoritesPrivacy | null, done: boolean): string {
  if (!signedIn) {
    return `${done ? 'They are' : 'They will be'} saved on this device. Sign in with Nostr to sync them across apps.`;
  }
  if (mode === 'off') {
    return `${done ? 'They are' : 'They will be'} saved on this device only, because your favorites are set to stay on this device.`;
  }
  if (mode === 'private') return 'They will be added to your private, encrypted favorites list on Nostr.';
  if (mode === 'public') return 'They will be added to your public favorites list on Nostr, which other apps can read.';
  return 'Nothing is published until you choose where your favorites go.';
}

/**
 * The import's progress and result, ABOVE the library. Renders nothing idle.
 */
export function OpmlImportPanel({ importer }: { importer: OpmlImporter }) {
  const favorites = useApp((s) => s.favorites);
  const identity = useApp((s) => s.identity);
  // Same window the page calls `checking`: signed in, the relay read not back.
  // Adding is SAFE then (the hydrator reads the store after its read lands),
  // but the "already in your favorites" count is not yet true, so the button
  // waits and says why rather than offering a number it will revise.
  const waiting = useApp(
    (s) => !!s.identity && (s.favoritesSync === 'idle' || s.favoritesSync === 'loading'),
  );
  // Subscribed, so the destination sentence follows a mode the hydrator seeds
  // while the panel is open.
  const { mode } = useFavoritesMode();
  const { state } = importer;
  if (state.step === 'idle') return null;

  if (state.step === 'busy') {
    return (
      <div className="card p-4 text-sm text-muted" role="status" aria-live="polite">
        {state.text}
      </div>
    );
  }

  if (state.step === 'error') {
    return (
      <div className="card p-4 flex flex-col items-start gap-2" role="alert">
        <p className="text-sm text-bone">{state.text}</p>
        <button type="button" onClick={importer.dismiss} className="btn-mini">close</button>
      </div>
    );
  }

  const { run } = state;
  const sorted = sortOpmlAnswers(run.plan.feeds, run.answers, (g) => !!favorites[g]);
  const skipped = (reason: OpmlSkip['reason']) => run.plan.skipped.filter((s) => s.reason === reason);
  const priv = skipped('private');
  const notWeb = skipped('not-web');
  const repeats = skipped('repeat').length;
  const nextRun = Math.min(sorted.unasked.length, OPML_LOOKUP_PER_RUN);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="card p-4 flex flex-col gap-3" aria-live="polite">
      <div className="flex flex-col gap-1">
        <p className="text-[11px] uppercase tracking-widest text-muted">
          import from <span className="normal-case tracking-normal text-bone">{run.fileName}</span>
        </p>
        {run.added !== null ? (
          <p className="text-sm">
            Added {plural(run.added, 'show', 'shows')} to your favorites. {destination(!!identity, mode, true)}
            {run.unsaved && ' This browser did not save the list to its storage, so the new favorites are gone after a reload.'}
          </p>
        ) : (
          <p className="text-sm">
            {sorted.add.length
              ? `${plural(sorted.add.length, 'show is', 'shows are')} ready to add.`
              : 'There is no new show to add.'}
            {sorted.already.length > 0 && ` ${plural(sorted.already.length, 'show is', 'shows are')} in your favorites already.`}
            {sorted.add.length > 0 && ` ${destination(!!identity, mode, false)}`}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {sorted.add.length > 0 && (
          <button
            type="button"
            onClick={importer.add}
            disabled={waiting}
            className="btn-bolt text-xs disabled:opacity-50"
          >
            {waiting ? 'waiting for your favorites to load…' : `add ${plural(sorted.add.length, 'show', 'shows')}`}
          </button>
        )}
        {nextRun > 0 && (
          <button type="button" onClick={importer.lookUpMore} className="btn-ghost text-xs">
            look up {nextRun} more
          </button>
        )}
        <button type="button" onClick={importer.dismiss} className="btn-ghost text-xs">
          {run.added !== null || !sorted.add.length ? 'done' : 'cancel'}
        </button>
      </div>

      {sorted.unasked.length > 0 && (
        <p className="text-[11px] text-muted">
          {plural(sorted.unasked.length, 'show is', 'shows are')} not looked up yet.
          {run.stopped
            ? ' Podcast Index stopped answering — wait a minute, then look up the rest.'
            : ` One press looks up ${OPML_LOOKUP_PER_RUN} at most.`}
        </p>
      )}

      <NotAdded label="Not in Podcast Index" feeds={sorted.notFound}
        note="Search for the show by name — it may be listed under a different feed address." />
      <NotAdded label="In Podcast Index with no podcast:guid" feeds={sorted.noGuid}
        note="A favorite is saved by the show's podcast:guid, and this feed does not have one." />
      <NotAdded label="Look like private feeds — not looked up" feeds={priv} hostOnly
        note="A paid or members-only feed address contains your key, so it does not leave this device." />
      <NotAdded label="Not a web address" feeds={notWeb} />
      {(repeats > 0 || run.plan.overCap > 0) && (
        <p className="text-[11px] text-muted">
          {repeats > 0 && `${plural(repeats, 'address is', 'addresses are')} in the file twice. `}
          {run.plan.overCap > 0 && `${run.plan.overCap} more past the first ${OPML_MAX_FEEDS} were not read.`}
        </p>
      )}
    </div>
  );
}

/** One "not added" reason, folded, with each show's name. */
function NotAdded({
  label, feeds, note, hostOnly = false,
}: {
  label: string;
  feeds: (OpmlFeed | OpmlSkip)[];
  note?: string;
  hostOnly?: boolean;
}) {
  if (!feeds.length) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer py-1 text-muted hover:text-bone">
        {label} — {feeds.length}
      </summary>
      {note && <p className="mt-1 text-[11px] text-muted">{note}</p>}
      <ul className="mt-1 flex flex-col gap-0.5">
        {feeds.map((f, i) => (
          <li key={`${f.url}-${i}`} className="break-words">
            {f.title || <span className="text-muted">untitled</span>}
            {/* A private address is shown as its HOST only: the rest of it is
                the user's key, and the screen is not a safe place for it. */}
            <span className="text-muted"> — {hostOnly ? hostOf(f.url) : f.url}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
}

/**
 * The page-bottom row for a library that has something in it: import more,
 * or take the shows to another app. Rarely pressed, so it sits under the
 * library rather than adding a row of chrome above it.
 */
export function OpmlTools({ importer }: { importer: OpmlImporter }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function exportOpml() {
    setBusy(true);
    setMsg(null);
    try {
      const { favorites, favoriteEpisodes } = useApp.getState();
      const favs = Object.values(favorites);
      if (!favs.length) {
        setMsg('There is no show to export. An OPML file holds shows only, not episodes or tracks.');
        return;
      }
      // A row this device never resolved has no feed address yet. Warm first,
      // then the per-guid pass — the batch-door pattern, so a cold list costs
      // a few requests, not one per show.
      const missing = favs.filter((f) => !f.url).map((f) => f.podcastGuid);
      const resolved = new Map<string, Podcast>();
      if (missing.length) {
        await warmPodcastCache(missing);
        const found = await mapLimit(missing, 6, (g) => resolvePodcastByGuid(g));
        found.forEach((p, i) => { if (p) resolved.set(missing[i]!, p); });
      }
      const shows = favs
        .map((f) => {
          const p = resolved.get(f.podcastGuid);
          return { url: f.url ?? p?.url, title: f.title ?? p?.title };
        })
        .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
      const created = new Date();
      const { xml, written } = buildOpml(shows, { title: `${BRAND.displayName} favorites`, created });
      if (!written) {
        setMsg('No show could be exported: their feed addresses are not known yet. Try again when you are online.');
        return;
      }
      const name = opmlFilename(BRAND.domain, created);
      saveFile(new Blob([xml], { type: 'text/x-opml' }), name);
      const left = favs.length - written;
      setMsg(
        `Saved ${written} ${written === 1 ? 'show' : 'shows'} to ${name}.`
        + (left > 0 ? ` ${left} ${left === 1 ? 'show is' : 'shows are'} not in it, because the feed address is not known yet.` : '')
        + (Object.keys(favoriteEpisodes).length > 0 ? ' Episode and track favorites are not in it — an OPML file holds shows only.' : ''),
      );
    } catch (e) {
      setMsg(getErrorMessage(e, 'The export failed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-1 border-t border-line pt-4">
      <p className="text-[11px] uppercase tracking-widest text-muted">other podcast apps</p>
      <div className="flex flex-wrap items-center gap-2">
        <OpmlImportButton importer={importer} />
        <button
          type="button"
          onClick={exportOpml}
          disabled={busy}
          className="btn-mini disabled:opacity-50"
          title="Save your favorite shows as an OPML file that other podcast apps can import."
        >
          {busy ? 'reading feed addresses…' : '⇩ export opml'}
        </button>
      </div>
      {msg && <p className="text-[11px] text-muted">{msg}</p>}
    </div>
  );
}
