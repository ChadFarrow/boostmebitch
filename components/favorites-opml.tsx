'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import type { FavoritesPrivacy } from '@/lib/nostr/favorites-list';
import { BRAND } from '@/lib/brand';
import { useFavoritesMode } from '@/components/favorites-privacy';
import { parseOpml } from '@/lib/feed-xml';
import {
  OPML_FILE_ACCEPT, OPML_LOOKUP_PER_RUN, OPML_MAX_BYTES, OPML_MAX_FEEDS,
  buildOpml, opmlFilename, opmlLinkName, opmlLinkVerdict, planOpmlImport, sortOpmlAnswers,
  type OpmlFeed, type OpmlOutlineIn, type OpmlPlan, type OpmlSkip,
} from '@/lib/opml';
import { lookupFeedUrls, resolvePodcastByGuid, warmPodcastCache } from '@/lib/podcast-meta';
import { favoriteFromPodcast, requestFavoritesSync } from '@/lib/nostr';
import { saveFile } from '@/lib/save-file';
import { getErrorMessage, mapLimit } from '@/lib/util';
import { scrollBehavior } from '@/lib/format';
import type { FavoritePodcast, Podcast } from '@/lib/types';

/**
 * OPML import on the favorites page — and the export, kept OFF the page.
 *
 * IMPORT ONLY ON SCREEN (the owner's call, 2026-11-01): the page offers the
 * import and no export button. The export is `exportFavoritesOpml` below, with
 * its rules in `lib/opml.ts` and pinned by `check:opml`, kept for a later
 * change that puts a button on it. Nothing renders it today.
 *
 * TWO PLACES, ONE IMPORTER. An EMPTY library offers the import in its own card
 * (the page's empty branch) and shows the result ABOVE the library; a library
 * that has shows offers it as one quiet line UNDER the list
 * (`<OpmlLibraryImport>`), and shows the result in that box. `origin` says
 * which, so a result is never drawn twice, and never at the top of the page
 * while the reader is at the bottom.
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
 * A FILE OR A LINK, ONE REVIEW. `pick` reads a file here and `pickLink` asks
 * `/api/opml` to read a link, because most hosts send no CORS header. Both end
 * in `review`, so a list from a link gets the same plan, the same lookup and the
 * same ADD as a list from a file.
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

/**
 * Where the import was started, which is where its result is drawn.
 * `empty` — the empty-library card; the result goes ABOVE the library, because
 * that card unmounts the moment the shows land. `library` — the line under a
 * library that has shows; the result goes in that box, where the reader is.
 */
export type OpmlOrigin = 'empty' | 'library';

export interface OpmlImporter {
  state: ImportState;
  busy: boolean;
  /** Where the current import was started. Meaningless while `idle`. */
  origin: OpmlOrigin;
  pick: (file: File, origin: OpmlOrigin) => void;
  /** `raw` as pasted. `opmlLinkVerdict` decides whether it may leave the device. */
  pickLink: (raw: string, origin: OpmlOrigin) => void;
  lookUpMore: () => void;
  add: () => void;
  dismiss: () => void;
}

/**
 * Ask `/api/opml` to read a link. Every failure is one sentence for the panel.
 *
 * The 404 and the refused address read the same on purpose: the route gives no
 * detail, so the SSRF guard behind it does not become an oracle.
 */
async function readOpmlLink(url: string): Promise<{ outlines: OpmlOutlineIn[] } | { failed: string }> {
  try {
    const res = await fetch('/api/opml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (res.status === 422) {
      return { failed: 'That link does not open an OPML file. Check the link, then try again.' };
    }
    if (res.status === 429) {
      return { failed: 'Too many links in one minute. Wait a minute, then try again.' };
    }
    if (res.ok) {
      const { outlines } = (await res.json()) as { outlines?: OpmlOutlineIn[] };
      if (Array.isArray(outlines)) return { outlines };
    }
    return { failed: 'That link could not be read. Check the link, then try again.' };
  } catch (e) {
    console.warn('[opml] link read failed', e);
    return { failed: 'That link could not be read. Check your connection, then try again.' };
  }
}

export function useOpmlImport(): OpmlImporter {
  const [state, setState] = useState<ImportState>({ step: 'idle' });
  const [origin, setOrigin] = useState<OpmlOrigin>('empty');
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

  async function pick(file: File, from: OpmlOrigin) {
    if (busy) return;
    setOrigin(from);
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
    await review(file.name, outlines);
  }

  async function pickLink(raw: string, from: OpmlOrigin) {
    if (busy) return;
    setOrigin(from);
    const verdict = opmlLinkVerdict(raw);
    if ('refused' in verdict) {
      setState({
        step: 'error',
        text: verdict.refused === 'private'
          ? 'This link looks private, so it was not sent anywhere. Save the file, then import the file.'
          : 'This is not a whole web address. Paste the full link, with the https:// at the start.',
      });
      return;
    }
    setState({ step: 'busy', text: 'reading the link…' });
    const read = await readOpmlLink(verdict.url);
    if ('failed' in read) {
      setState({ step: 'error', text: read.failed });
      return;
    }
    await review(opmlLinkName(verdict.url), read.outlines);
  }

  /** Where a file and a link meet: the list is read, and nothing is added yet. */
  async function review(fileName: string, outlines: readonly OpmlOutlineIn[]) {
    if (!outlines.length) {
      setState({ step: 'error', text: 'This OPML file lists no shows.' });
      return;
    }
    const run: ImportRun = {
      fileName,
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
    origin,
    pick: (file, from) => { void pick(file, from); },
    pickLink: (raw, from) => { void pickLink(raw, from); },
    lookUpMore: () => { if (state.step === 'ready' && !busy) void lookUp(state.run); },
    add,
    dismiss: () => { if (!busy) setState({ step: 'idle' }); },
  };
}

/**
 * The trigger. A real `<button>` that opens a hidden file input, so it is
 * reachable from a keyboard — a `<label>` styled as a button is not.
 *
 * `accept` is `OPML_FILE_ACCEPT`, and what it must not do is grey out the file
 * the user came here to pick: it stays a suggestion to the picker. `parseOpml`
 * says plainly when the file picked is not OPML, which is the better place for
 * that check.
 */
export function OpmlImportButton({
  importer,
  origin = 'empty',
  className = 'btn-mini disabled:opacity-50',
}: {
  importer: OpmlImporter;
  /** Where the result is drawn — see `OpmlOrigin`. */
  origin?: OpmlOrigin;
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
        accept={OPML_FILE_ACCEPT}
        data-opml-input=""
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so picking the SAME file again (after a rate limit, say)
          // still fires `change`.
          e.target.value = '';
          if (file) importer.pick(file, origin);
        }}
      />
    </>
  );
}

/**
 * The other way in: a pasted link to an OPML file, for a list that is on the web
 * rather than in Files.
 *
 * `noValidate`, so a bad address gets `opmlLinkVerdict`'s sentence in the panel
 * instead of the browser's bubble. `.input` is what keeps it from zooming iOS:
 * the 16px floor in globals.css applies to every input on a touch screen. The
 * keyboard closes on submit, because it covers the result on a phone.
 */
export function OpmlLinkForm({ importer, origin = 'empty' }: { importer: OpmlImporter; origin?: OpmlOrigin }) {
  const [link, setLink] = useState('');
  const box = useRef<HTMLInputElement>(null);
  const empty = !link.trim();
  return (
    <form
      noValidate
      data-opml-link=""
      className="flex w-full max-w-prose items-stretch gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (empty || importer.busy) return;
        box.current?.blur();
        importer.pickLink(link, origin);
      }}
    >
      <input
        ref={box}
        type="url"
        inputMode="url"
        enterKeyHint="go"
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-label="Link to an OPML file"
        placeholder="Paste an OPML link"
        className="input min-w-0 flex-1"
        value={link}
        onChange={(e) => setLink(e.target.value)}
      />
      <button type="submit" disabled={empty || importer.busy} className="btn-mini shrink-0 disabled:opacity-50">
        import link
      </button>
    </form>
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
 * The import's progress and result. Renders nothing idle, and nothing for an
 * import started somewhere else (`where` ≠ `importer.origin`), so the page can
 * mount one above the library and one in the library's box without a result
 * ever showing twice. `data-opml-panel` is what `e2e:opml` reads.
 */
export function OpmlImportPanel({ importer, where }: { importer: OpmlImporter; where: OpmlOrigin }) {
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
  if (state.step === 'idle' || importer.origin !== where) return null;

  if (state.step === 'busy') {
    return (
      <div className="card p-4 text-sm text-muted" role="status" aria-live="polite" data-opml-panel="">
        {state.text}
      </div>
    );
  }

  if (state.step === 'error') {
    return (
      <div className="card p-4 flex flex-col items-start gap-2" role="alert" data-opml-panel="">
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
    <div className="card p-4 flex flex-col gap-3" aria-live="polite" data-opml-panel="">
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
 * The import for a library that already HAS shows: one quiet line under the
 * list, and a small box when it is pressed.
 *
 * Rarely pressed, so it is a line of text, not a row of buttons: the controls
 * above the library are judged on how fast they get the reader to a favorite.
 * The empty library's card says the same thing at full size, to a new user.
 *
 * THE RESULT IS DRAWN HERE, not above the library. The reader pressed this at
 * the bottom of the page; a result at the top was out of view on any real
 * library, and the button only went grey. A library does not unmount when
 * shows land, so the box keeps the result through the add.
 *
 * It SCROLLS ITSELF INTO VIEW, twice: when the box opens and when the result
 * changes. A box opened at the very bottom is drawn below the fold, and the
 * dock covers the last 60-odd pixels — `scroll-margin-bottom` keeps both clear
 * of it (`--dock-b`, never a literal).
 */
export function OpmlLibraryImport({ importer }: { importer: OpmlImporter }) {
  const [open, setOpen] = useState(false);
  const boxId = useId();
  const box = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const mine = importer.state.step !== 'idle' && importer.origin === 'library';
  const shown = open || mine;
  const step = mine ? importer.state.step : 'idle';

  useEffect(() => {
    if (open) box.current?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  }, [open]);
  useEffect(() => {
    if (step !== 'idle') result.current?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  }, [step]);

  const clearOfDock = { scrollMarginBottom: 'calc(var(--dock-b) + 1rem)' };

  return (
    <div className="mt-6 border-t border-line pt-3" data-opml-library="">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={shown}
        aria-controls={boxId}
        className="btn-inline min-h-6 py-1 text-left text-xs text-muted hover:text-bone"
      >
        Use another podcast app too? Import your shows from OPML{' '}
        <span aria-hidden="true">{shown ? '▾' : '▸'}</span>
      </button>
      {shown && (
        <div id={boxId} className="mt-2 flex flex-col gap-3">
          <div ref={box} className="border border-line p-3 flex flex-col gap-3" style={clearOfDock}>
            <p className="text-xs text-muted leading-relaxed max-w-prose">
              OPML is the file every podcast app uses for your show list. Export it from your
              other app, then import it here, or paste a link to it. Import adds only the shows
              you do not have yet — it never removes a favorite.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <OpmlImportButton importer={importer} origin="library" />
              <button
                type="button"
                onClick={() => {
                  if (mine) importer.dismiss();
                  setOpen(false);
                }}
                disabled={importer.busy}
                className="btn-mini disabled:opacity-50"
              >
                close
              </button>
            </div>
            <OpmlLinkForm importer={importer} origin="library" />
          </div>
          {mine && (
            <div ref={result} style={clearOfDock}>
              <OpmlImportPanel importer={importer} where="library" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Save the favorite SHOWS as an OPML file, and say what was saved.
 *
 * **NOT ON THE PAGE** (2026-11-01: the page offers the import only). Kept,
 * whole and typed, for the change that puts a button back on it — the button
 * shows the returned sentence. The rules it writes by are `buildOpml` and
 * `opmlFilename` in lib/opml.ts, pinned by `check:opml`.
 *
 * A row this device never resolved has no feed address yet. Warm first, then
 * the per-guid pass — the batch-door pattern, so a cold list costs a few
 * requests, not one per show. A show whose address is still unknown is left
 * out and counted.
 */
export async function exportFavoritesOpml(): Promise<string> {
  try {
    const { favorites, favoriteEpisodes } = useApp.getState();
    const favs = Object.values(favorites);
    if (!favs.length) {
      return 'There is no show to export. An OPML file holds shows only, not episodes or tracks.';
    }
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
      return 'No show could be exported: their feed addresses are not known yet. Try again when you are online.';
    }
    const name = opmlFilename(BRAND.domain, created);
    saveFile(new Blob([xml], { type: 'text/x-opml' }), name);
    const left = favs.length - written;
    return `Saved ${written} ${written === 1 ? 'show' : 'shows'} to ${name}.`
      + (left > 0 ? ` ${left} ${left === 1 ? 'show is' : 'shows are'} not in it, because the feed address is not known yet.` : '')
      + (Object.keys(favoriteEpisodes).length > 0 ? ' Episode and track favorites are not in it — an OPML file holds shows only.' : '');
  } catch (e) {
    return getErrorMessage(e, 'The export failed.');
  }
}
