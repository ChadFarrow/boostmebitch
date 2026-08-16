'use client';
import { useWalletChange } from '@/lib/use-wallet-change';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ModalShell } from './modal-shell';
import type { Episode, Podcast, Boostagram, ValueTimeSplit, StoredBoost } from '@/lib/types';
import { useApp } from '@/lib/store';
import { sendBoost, pickRail, paidAny, type Rail } from '@/lib/v4v/boost';
import { publishBoostNote, publishBoostNoteViaSite, resolvePublishRelays, recordLastRail } from '@/lib/nostr';
import { storage } from '@/lib/storage';
import { useSharePicker } from './boost-modal/use-share-picker';
import { getErrorMessage, hasValueRecipients, payableSplit, resolveSenderName, splitTrackAndHost, storedBoostLegs } from '@/lib/util';
import { fireConfetti, playBoostSound, primeBoostSound } from '@/lib/format';
import { BoltIcon } from './icons';
import { AmountInput, MIN_BOOST_SATS } from './boost-modal/amount-input';
import { MessageInput } from './boost-modal/message-input';
import { SenderName } from './boost-modal/sender-name';
import { PublishStatus, type PublishState } from './boost-modal/publish-status';
import { ShareNostrPicker } from './boost-modal/share-nostr-picker';
import { PodcastCover } from './podcast-cover';
import { RailPicker } from './rail-picker';

interface Props {
  podcast: Podcast;
  episode: Episode;
  onClose: () => void;
}

interface TrackProgress {
  index: number;
  ok: boolean;
  /**
   * No leg confirmed, but at least one went unanswered by the wallet — so this
   * track may in fact have paid. Same rule as BoostResult.indeterminate, one
   * level up: over N tracks a run of false ✗ is exactly what makes someone
   * boost the whole album a second time.
   */
  indeterminate?: boolean;
  error?: string;
}

export function BoostAllModal({ podcast, episode, onClose }: Props) {
  const identity = useApp((s) => s.identity);
  const bumpBoosts = useApp((s) => s.bumpBoosts);
  const [sats, setSats] = useState(100);
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [rail, setRail] = useState<Rail | null>(null);

  const [splits, setSplits] = useState<ValueTimeSplit[]>([]);
  const [totalSplits, setTotalSplits] = useState(0);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [progress, setProgress] = useState<TrackProgress[]>([]);

  // Share picker + the `anonymous` flag derived from it, shared with
  // <BoostModal>. It used to be a second copy of the same state, handlers and
  // expression — see ./boost-modal/use-share-picker for why a single definition
  // of `anonymous` is the point, and note that this modal in particular leaked
  // the sender name a second time through its hand-built summary
  // `contentOverride` after the single-boost path had already been fixed.
  const {
    shareNostr,
    setShareNostr: handleShareNostrChange,
    shareAs,
    setShareAs: handleShareAsChange,
    anonymous,
  } = useSharePicker(identity);
  const [pubState, setPubState] = useState<PublishState>({ kind: 'idle' });
  const relays = useMemo(() => resolvePublishRelays(identity), [identity]);

  // The NAME needs this modal's own "From" state, so it stays here.
  // DEFAULT_SENDER_NAME substitutes rather than omits (same as when "From" is
  // just left empty) so it presents consistently instead of rendering blank in
  // one aggregator and "Unknown" in the next. Applies to every leg — per-track,
  // host share, summary. Component scope because <SenderName> renders off it.
  const senderName = resolveSenderName(name, anonymous);

  // Portal to <body> so the overlay escapes the layout's `relative z-0` content
  // wrapper (app/layout.tsx). Inside that wrapper a `fixed` modal's z-index only
  // competes WITHIN the wrapper's stacking context, so the mini-player (a
  // body-level sibling at z-30) painted on top of it — burying the Cancel /
  // BOOST footer. <ModalShell> owns the portal now.

  // Set on unmount so the in-flight loop bails before firing more sends or
  // calling setState on an unmounted component. The current track's send
  // can't be aborted (Lightning is fire-and-forget), but its storage.boosts
  // log still records — money moved, the user should see it later.
  //
  // Reset on mount so React 18 StrictMode's mount→unmount→mount cycle in dev
  // doesn't leave cancelled=true permanently from the intermediate cleanup.
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);

  // Sync rail if a wallet connects/disconnects while the modal is open. Covers
  // WebLN too — see the same note in boost-modal/index.tsx; both modals were
  // missing that third subscription while rendering a picker that reads it.
  useWalletChange(() => setRail(pickRail()));

  useEffect(() => {
    // pickRail() honors the stored rail pref when that rail is still
    // connected/enabled, else falls back to NWC > Spark > WebLN priority.
    setRail(pickRail());
    setName((cur) => {
      if (cur) return cur;
      const stored = storage.senderName.get(identity?.npub);
      if (stored) return stored;
      return identity?.profile?.display_name || identity?.profile?.name || '';
    });
  // npub is a dep so switching accounts re-resolves the "From" name against
  // the new identity's own per-npub value. The `if (cur) return cur` guard
  // above still wins for a switch that happens with the modal already open —
  // it exists to protect in-progress typing — but the field is visible and
  // editable, and the case that mattered (opening the modal fresh under a new
  // identity and finding the previous one's real name) is what this fixes.
  }, [identity?.npub, identity?.profile?.display_name, identity?.profile?.name]);

  // Fetch resolved value splits for this episode.
  useEffect(() => {
    setLoadState('loading');
    fetch(`/api/value-splits?feedId=${episode.feedId}&episodeId=${episode.id}`)
      .then((r) => r.json())
      .then((data) => {
        const all = (data.splits as ValueTimeSplit[]) ?? [];
        const resolved = all.filter((s) => hasValueRecipients(s.value));
        setSplits(resolved);
        setTotalSplits(all.length);
        setLoadState('ready');
      })
      .catch(() => setLoadState('error'));
  }, [episode.feedId, episode.id]);

  const total = sats * splits.length;

  async function go() {
    if (!rail || !splits.length) return;
    // Unlock the success sound NOW, inside the tap — the actual play() fires
    // after the async per-track payments, past the gesture window on mobile.
    // The muted unlock claims an audio session too, so it takes the same live
    // isPlaying reading as the ping (see primeBoostSound).
    primeBoostSound({ appIsPlaying: useApp.getState().isPlaying });
    // Saved even for an anonymous boost — it's the user's device-local "From"
    // default; anonymity is about what leaves the device, not forgetting it.
    if (name) storage.senderName.set(identity?.npub, name);

    setRunning(true);
    setProgress([]);

    // Local success tracker — `progress` state has stale-closure issues
    // across awaits, and we need the final list immediately for the
    // post-loop Nostr publish.
    const successfulIdx: number[] = [];
    // The host show's value block (preferred per-episode, falls back to feed-level).
    const hostValue = episode.value ?? podcast.value;

    for (let i = 0; i < splits.length; i++) {
      if (cancelled.current) return;
      const split = splits[i];
      // Spec: remotePercentage is the share that goes to the remote (track)
      // recipients; (100 − remotePercentage) goes to the host show. Default 100
      // (all to track) when missing.
      //
      // Shared with <BoostModal>, which applies the same redirect to a single
      // boost pressed mid-song — two copies of this is how the same feed comes
      // to be paid two different ways depending on which button was pressed.
      // `check:vts` pins it.
      const { trackSats, hostSats: showLegSats } = splitTrackAndHost({
        totalSats: sats,
        remotePercentage: split.remotePercentage,
        hostRecipientCount: hostValue?.recipients?.length ?? 0,
      });
      // Boostagram shape for valueTimeSplits: HOST episode in primary fields
      // (the album/playlist the listener is playing), TRACK in remote_*. The
      // recipient artist sees `podcast`/`episode` describing the listener's
      // context and `remote_*` identifying which track triggered the boost.
      const trackBoostagram: Boostagram = {
        app_name: 'BoostMeBitch',
        app_version: '0.1.0',
        podcast: podcast.title,
        feedID: podcast.id,
        url: podcast.url,
        episode: episode.title,
        itemID: episode.id,
        episode_guid: episode.guid,
        remote_feed_guid: split.remoteItem?.feedGuid,
        remote_item_guid: split.remoteItem?.itemGuid,
        ts: 0,
        value_msat_total: trackSats * 1000,
        message: msg || undefined,
        sender_name: senderName,
        sender_id: anonymous ? undefined : identity?.pubkey,
        action: 'boost',
        uuid: crypto.randomUUID(),
      };
      let trackOk = false;
      // Only meaningful when trackOk is false: at least one leg's wallet never
      // answered, so "this track didn't pay" is not a claim we can make.
      let trackUnknown = false;
      try {
        if (trackSats > 0) {
          const results = await sendBoost({
            value: split.value!,
            totalSats: trackSats,
            boostagram: trackBoostagram,
            rail,
          });
          trackOk = paidAny(results);
          trackUnknown = results.some((r) => r?.indeterminate);
          if (trackOk) {
            const stored: StoredBoost = {
              uuid: trackBoostagram.uuid!,
              ts: Date.now(),
              podcastTitle: podcast.title,
              podcastId: podcast.id,
              podcastGuid: podcast.podcastGuid,
              podcastImage: split.image ?? episode.image ?? podcast.image,
              episodeTitle: episode.title,
              episodeGuid: episode.guid,
              sats: trackSats,
              message: msg || undefined,
              senderName,
              legs: storedBoostLegs(results),
            };
            storage.boosts.add(identity?.npub, stored);
            bumpBoosts();
            successfulIdx.push(i);
          }
        }
      } catch (e) {
        if (cancelled.current) return;
        setProgress((prev) => [
          ...prev,
          { index: i, ok: false, error: getErrorMessage(e, 'boost failed') },
        ]);
        continue;
      }

      // Per-track host leg. Each one carries the same remote_* tags as its
      // sibling track leg so the host can see which track triggered it in
      // their boostagram log. Skip if remotePct === 100 (no host share),
      // hostValue is missing, or showLegSats rounded to 0.
      if (showLegSats > 0 && hasValueRecipients(hostValue) && !cancelled.current) {
        const hostBoostagram: Boostagram = {
          app_name: 'BoostMeBitch',
          app_version: '0.1.0',
          podcast: podcast.title,
          feedID: podcast.id,
          url: podcast.url,
          episode: episode.title,
          itemID: episode.id,
          episode_guid: episode.guid,
          remote_feed_guid: split.remoteItem?.feedGuid,
          remote_item_guid: split.remoteItem?.itemGuid,
          ts: 0,
          value_msat_total: showLegSats * 1000,
          message: msg || undefined,
          sender_name: senderName,
          sender_id: anonymous ? undefined : identity?.pubkey,
          action: 'boost',
          uuid: crypto.randomUUID(),
        };
        try {
          const hostResults = await sendBoost({
            // Trimmed to the recipients this share can actually pay. A per-track
            // host share is arbitrarily small — 3 sats across four payees leaves
            // one at zero, and payOne reports a zero-sat leg as ok:true, so the
            // boost log recorded a payment nobody received. Same helper the
            // single boost modal uses. hostValue is non-null here, guaranteed by
            // hasValueRecipients above.
            value: { ...hostValue!, recipients: payableSplit(showLegSats, hostValue!.recipients).recipients },
            totalSats: showLegSats,
            boostagram: hostBoostagram,
            rail,
          });
          if (paidAny(hostResults)) {
            const stored: StoredBoost = {
              uuid: hostBoostagram.uuid!,
              ts: Date.now(),
              podcastTitle: podcast.title,
              podcastId: podcast.id,
              podcastGuid: podcast.podcastGuid,
              podcastImage: episode.image ?? podcast.image,
              episodeTitle: episode.title,
              episodeGuid: episode.guid,
              sats: showLegSats,
              message: msg || undefined,
              senderName,
              legs: storedBoostLegs(hostResults),
            };
            storage.boosts.add(identity?.npub, stored);
            bumpBoosts();
          }
        } catch {
          // Host leg failure is non-fatal — the track leg may have already paid.
        }
      }

      if (cancelled.current) return;
      setProgress((prev) => [
        ...prev,
        { index: i, ok: trackOk, indeterminate: !trackOk && trackUnknown },
      ]);
    }

    setRunning(false);
    setDone(true);

    if (successfulIdx.length > 0) {
      fireConfetti();
      playBoostSound({ appIsPlaying: useApp.getState().isPlaying });
    }
    if (successfulIdx.length > 0 && rail) recordLastRail(rail, identity);

    // Single summary note covering all successful tracks. Gated on the
    // share-on-Nostr toggle and at least one paid leg — matches BoostModal's
    // "don't pollute the network with failed-only boosts" rule.
    if (cancelled.current) return;
    if (!shareNostr || successfulIdx.length === 0) return;

    const totalSats = successfulIdx.length * sats;
    const trackList = successfulIdx
      .map((i) => splits[i].title)
      .filter((t): t is string => !!t);

    const summaryBoostagram: Boostagram = {
      app_name: 'BoostMeBitch',
      app_version: '0.1.0',
      podcast: podcast.title,
      feedID: podcast.id,
      url: podcast.url,
      episode: episode.title,
      itemID: episode.id,
      episode_guid: episode.guid,
      ts: 0,
      value_msat_total: totalSats * 1000,
      message: msg || undefined,
      sender_name: senderName,
      sender_id: anonymous ? undefined : identity?.pubkey,
      action: 'boost',
      uuid: crypto.randomUUID(),
    };

    const lines: string[] = ['⚡ Boost ⚡', ''];
    if (msg.trim()) lines.push(msg.trim(), '');
    // Mirrors formatContent's attribution line, off the same `senderName` the
    // boostagrams carry — so an anonymous summary note reads as
    // DEFAULT_SENDER_NAME rather than attributing itself back to the user.
    lines.push(
      `${senderName} boosted ${successfulIdx.length} track${successfulIdx.length === 1 ? '' : 's'} on ${podcast.title} for ${totalSats} sats`,
    );
    if (trackList.length) {
      lines.push('');
      for (const t of trackList) lines.push(`• ${t}`);
    }
    const contentOverride = lines.join('\n');

    setPubState({ kind: 'publishing' });
    try {
      // User's own key only when signed in AND they picked "Post to my Nostr
      // feed"; otherwise the site's Nostr identity (signed out, or the
      // signed-in "Post via boostmebitch.com" choice).
      const note = identity && shareAs === 'self'
        ? await publishBoostNote({
            podcast, episode, boostagram: summaryBoostagram, results: [], relays, contentOverride,
          })
        : await publishBoostNoteViaSite({
            podcast, episode, boostagram: summaryBoostagram, results: [], contentOverride,
          });
      if (cancelled.current) return;
      setPubState({ kind: 'done', note });
    } catch (e) {
      if (cancelled.current) return;
      setPubState({ kind: 'error', message: getErrorMessage(e, 'publish failed') });
    }
  }

  return (
    // Not dismissable while `running` — same reason as <BoostModal>: this one
    // walks a whole album's tracks sequentially, so losing the per-track rows
    // mid-run hides the most sats of any modal here.
    //
    // Same stable scrollbar gutter as BoostModal: per-track progress rows
    // appear dynamically and would otherwise jitter the width.
    <ModalShell
      onClose={onClose}
      label={`Boost all tracks — ${podcast.title}`}
      className="w-full max-w-xl [scrollbar-gutter:stable]"
      dismissable={!running}
    >
        <button
          onClick={onClose}
          className="absolute top-2 right-3 text-muted hover:text-bone text-lg z-10"
          aria-label="Close"
        >×</button>

        <div className="p-5 border-b border-bone/15">
          <div className="stamp text-bolt border-bolt/60 mb-2">⚡ BOOST ALL TRACKS</div>
          <h3 className="font-display text-2xl leading-tight">{episode.title}</h3>
          <p className="text-xs text-muted mt-1">{podcast.title}</p>
        </div>

        <div className="p-5 space-y-4">

          {!rail && (
            <div className="text-[11px] text-nostr/80">
              No wallet connected — connect one with ⚡ Connect wallet (top right).
            </div>
          )}

          <RailPicker rail={rail} onChange={setRail} />

          <AmountInput sats={sats} onChange={setSats} />

          {loadState === 'loading' && (
            <p className="text-muted text-sm">Loading tracks…</p>
          )}
          {loadState === 'error' && (
            <p className="text-nostr/80 text-sm">Could not load track data. Try again later.</p>
          )}
          {loadState === 'ready' && splits.length === 0 && (
            <p className="text-muted text-sm">
              {totalSplits > 0
                ? `${totalSplits} track${totalSplits === 1 ? '' : 's'} listed in the RSS feed, but Podcast Index couldn't resolve any of their value blocks.`
                : 'No resolvable value blocks found for this episode.'}
            </p>
          )}
          {loadState === 'ready' && splits.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted mb-2">
                Tracks ({splits.length}
                {totalSplits > splits.length && ` of ${totalSplits} — ${totalSplits - splits.length} unresolved`})
              </p>
              <ul className="space-y-2">
                {splits.map((split, i) => {
                  const result = progress.find((p) => p.index === i);
                  return (
                    <li key={i} className="card p-3 flex items-center gap-3">
                      <PodcastCover
                        image={split.image}
                        title={split.title ?? `Track ${i + 1}`}
                        seed={split.remoteItem?.itemGuid ?? String(i)}
                        className="w-10 h-10 flex-shrink-0 text-xs border border-bone/20"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {split.title ?? `Track ${i + 1}`}
                        </div>
                        <div className="text-xs text-muted">
                          {split.value?.recipients?.length ?? 0} recipient
                          {(split.value?.recipients?.length ?? 0) !== 1 ? 's' : ''}
                          {split.duration ? ` · ${Math.round(split.duration / 60)}m` : ''}
                        </div>
                      </div>
                      {result && (
                        <span
                          className={
                            result.ok
                              ? 'text-bolt text-sm'
                              : result.indeterminate
                                ? 'text-muted text-sm'
                                : 'text-nostr/80 text-sm'
                          }
                          title={result.indeterminate ? 'Wallet did not answer — this may still have been sent' : undefined}
                        >
                          {result.ok ? '✓' : result.indeterminate ? '?' : '✗'}
                          {/* Same reason as <SplitsPreview>: colour plus glyph
                              is not a status a reader can hear, and `title` is
                              unreachable on touch. */}
                          <span className="sr-only">
                            {result.ok
                              ? ' sent'
                              : result.indeterminate
                                ? ' wallet did not answer — this may still have been sent'
                                : ' failed'}
                          </span>
                        </span>
                      )}
                      {running && !result && i >= (progress.length) && (
                        <span className="text-muted text-xs animate-pulse">…</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {loadState === 'ready' && splits.length > 0 && (
            <>
              <MessageInput value={msg} onChange={setMsg} />
              <SenderName value={name} onChange={setName} anonymous={anonymous} />
              <ShareNostrPicker
                signedIn={!!identity}
                share={shareNostr}
                shareAs={shareAs}
                onShareChange={handleShareNostrChange}
                onShareAsChange={handleShareAsChange}
                noteNoun="One summary note"
              />
            </>
          )}

          {done && (
            <div className="text-sm text-muted">
              {progress.filter((p) => p.ok).length} of {splits.length} tracks boosted successfully.
              {progress.some((p) => p.indeterminate) && (
                <>
                  {' '}
                  <span className="text-bolt">
                    {progress.filter((p) => p.indeterminate).length} unconfirmed
                  </span>{' '}
                  — your wallet didn&rsquo;t answer in time. Check it before boosting these again.
                </>
              )}
            </div>
          )}

          <PublishStatus state={pubState} />

        </div>

        <div className="flex justify-between items-center gap-3 p-5 border-t border-bone/15 sticky bottom-0 bg-ink">
          <button onClick={onClose} className="btn-ghost">{done ? 'Close' : 'Cancel'}</button>
          <div className="flex items-center gap-3">
            {!done && loadState === 'ready' && splits.length > 0 && (
              <>
                {total > 0 && (
                  <span className="text-bolt text-sm font-mono">
                    {splits.length} × {sats} = {total} sats
                  </span>
                )}
                <button
                  onClick={go}
                  disabled={running || !rail || sats < MIN_BOOST_SATS || splits.length === 0}
                  className="btn-bolt disabled:opacity-40"
                >
                  <BoltIcon />
                  {running
                    ? `${progress.length}/${splits.length}…`
                    : `Boost ${splits.length} tracks`}
                </button>
              </>
            )}
          </div>
        </div>
    </ModalShell>
  );
}
