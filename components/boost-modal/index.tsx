'use client';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Episode, Podcast, Boostagram, StoredBoost } from '@/lib/types';
import { useApp } from '@/lib/store';
import { sendBoost, splitSats, pickRail, paidAny, type BoostResult, type Rail } from '@/lib/v4v/boost';
import { subscribeNwc } from '@/lib/v4v/nwc';
import { subscribeSpark } from '@/lib/v4v/spark';
import { publishBoostNote, publishBoostNoteViaSite, resolvePublishRelays, recordLastRail, publishLiveChat, LIVE_STREAM_RELAYS, isLiveStreamId, parseStreamId, streamChatAddr } from '@/lib/nostr';
import { sendZap, lnaddrSupportsZaps } from '@/lib/v4v/zap';
import { storage, type ShareNostrAs } from '@/lib/storage';
import { getErrorMessage, resolveSenderName, storedBoostLegs } from '@/lib/util';
import { fireConfetti, playBoostSound, primeBoostSound } from '@/lib/format';
import { BoltIcon } from '../icons';
import { BoostModalBalance } from '../wallet-balance';
import { RailPicker } from '../rail-picker';
import { AmountInput, MIN_BOOST_SATS } from './amount-input';
import { MessageInput } from './message-input';
import { SenderName } from './sender-name';
import { SplitsPreview, LightningStatus } from './splits-preview';
import { LiveNowPlaying } from '../live-now-playing';
import { liveTargetSnapshot } from '@/lib/v4v/live-value';
import { PublishStatus, type PublishState } from './publish-status';
import { ShareNostrPicker } from './share-nostr-picker';

/**
 * Boostagram fields for a live show whose payment target has been redirected.
 *
 * Returns {} when there is no live redirect, so an ordinary boost's wire bytes
 * are unchanged. The `event*` ids are The Split Kit's own correlation channel,
 * echoed back so the host's tooling can tie the payment to the block that
 * earned it.
 *
 * The remote guids are only included when the block actually names a feed. Two
 * reasons, and both are about not putting a lie on the wire: an invented bucket
 * key must never ship as `remote_feed_guid` (see LiveTarget.bucketKey), and
 * because this object is SPREAD OVER the episode branch, emitting the keys as
 * `undefined` would not "fall through" — it would overwrite the episode's real
 * `remote_item_guid` with nothing.
 */
function liveBoostFields(episodeGuid?: string) {
  const t = liveTargetSnapshot();
  if (!episodeGuid || t?.guid !== episodeGuid || !t.split?.value?.recipients?.length) return {};
  const remote = t.split.remoteItem;
  return {
    ...(remote?.feedGuid ? { remote_feed_guid: remote.feedGuid } : {}),
    ...(remote?.itemGuid ? { remote_item_guid: remote.itemGuid } : {}),
    ...(t.event ?? {}),
  };
}

interface Props {
  podcast: Podcast;
  episode?: Episode;       // omit for show-level boosts
  positionSec?: number;    // only meaningful when episode is present
  onClose: () => void;
}

export function BoostModal({ episode, podcast, positionSec = 0, onClose }: Props) {
  const identity = useApp((s) => s.identity);
  const bumpBoosts = useApp((s) => s.bumpBoosts);
  const [sats, setSats] = useState(0);
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [rail, setRail] = useState<Rail | null>(null);

  // Sparse while a send is in flight — legs settle biggest-share-first, not in
  // array order, so a hole is "this recipient hasn't been paid yet". The
  // `undefined` in the type is load-bearing: this repo doesn't enable
  // `noUncheckedIndexedAccess`, so a bare BoostResult[] would type-check while
  // lying about the holes.
  const [results, setResults] = useState<(BoostResult | undefined)[]>([]);
  const [running, setRunning] = useState(false);
  const [paymentDone, setPaymentDone] = useState(false);

  const [shareNostr, setShareNostr] = useState(() => storage.shareNostr.get());
  const [shareAs, setShareAs] = useState<ShareNostrAs>(() => storage.shareNostrAs.get());
  const [pubState, setPubState] = useState<PublishState>({ kind: 'idle' });

  // Portal to <body> so the overlay escapes the layout's `relative z-0` content
  // wrapper — otherwise, when this modal is opened from the episode list / detail
  // view (inside that wrapper), the mini-player (body-level, z-30) paints over
  // its footer. Opening from the player already worked because the player shares
  // the body-level context; portaling makes every entry point behave the same.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => { setPortalTarget(document.body); }, []);

  // Keep rail in sync if wallet connects/disconnects while the modal is open.
  useEffect(() => {
    const bump = () => setRail(pickRail());
    const unsubNwc = subscribeNwc(bump);
    const unsubSpark = subscribeSpark(bump);
    return () => { unsubNwc(); unsubSpark(); };
  }, []);

  function handleShareNostrChange(v: boolean) {
    setShareNostr(v);
    storage.shareNostr.set(v);
  }

  function handleShareAsChange(v: ShareNostrAs) {
    setShareAs(v);
    storage.shareNostrAs.set(v);
  }

  const relays = useMemo(() => resolvePublishRelays(identity), [identity]);

  // "Anonymous" has to anonymize the PAYMENT too, not just who signs the note:
  //  - sender_id is the user's nostr pubkey, which recipient aggregators
  //    (Helipad/Fountain) resolve to their profile — avatar + name.
  //  - sender_name is the "From" field, which recipients display verbatim AND
  //    which formatContent turns into "<name> boosted N sats" in the note body,
  //    so a site-signed "anonymous" note still named the sender.
  // The pubkey is dropped outright; the name is REPLACED by DEFAULT_SENDER_NAME
  // rather than omitted, so an anonymous boost still presents consistently
  // instead of rendering blank in one aggregator and "Unknown" in the next.
  // Same substitution when a named user just leaves "From" empty.
  // Computed at component scope (not inside go()) because <SenderName> renders
  // off it.
  //
  // Gated on `identity` to match where the picker offers the choice: signed out
  // there's only a checkbox, every note is site-signed, and the typed "From"
  // name is the ONLY attribution it can carry — but `bmb:share_nostr_as` is a
  // single global key, so a user who picked Anonymous while signed in would
  // otherwise have their name silently withheld after signing out, with no
  // control to turn it back on. `sender_id` is unaffected either way (it's
  // `identity?.pubkey`, already undefined when signed out).
  const anonymous = !!identity && shareNostr && shareAs === 'site';
  const senderName = resolveSenderName(name, anonymous);

  useEffect(() => {
    // pickRail() honors the stored rail pref when that rail is still
    // connected/enabled, else falls back to NWC > Spark > WebLN priority.
    setRail(pickRail());
    setName((current) => {
      if (current) return current;                              // preserve typing
      const stored = storage.senderName.get(identity?.npub);
      if (stored) return stored;                                // saved override
      return identity?.profile?.display_name
          || identity?.profile?.name
          || '';
    });
  // npub is a dep so switching accounts re-resolves the "From" name against
  // the new identity's own per-npub value. The `if (cur) return cur` guard
  // above still wins for a switch that happens with the modal already open —
  // it exists to protect in-progress typing — but the field is visible and
  // editable, and the case that mattered (opening the modal fresh under a new
  // identity and finding the previous one's real name) is what this fixes.
  }, [identity?.npub, identity?.profile?.display_name, identity?.profile?.name]);

  const isShowBoost = !episode;
  const value = (episode?.value ?? podcast.value)!;
  const splits = useMemo(() => splitSats(sats, value.recipients), [sats, value.recipients]);

  // Persist the boost to the local sent-boost log (the only thing that differs
  // between the zap and boostagram paths is the `legs`).
  function logStoredBoost(boostagram: Boostagram, legs: StoredBoost['legs']) {
    const stored: StoredBoost = {
      uuid: boostagram.uuid!,
      ts: Date.now(),
      podcastTitle: podcast.title,
      podcastId: podcast.id,
      podcastGuid: podcast.podcastGuid,
      podcastImage: episode?.image ?? podcast.image,
      episodeTitle: episode?.title,
      episodeGuid: episode?.guid,
      sats,
      message: msg || undefined,
      senderName,
      legs,
    };
    storage.boosts.add(identity?.npub, stored);
    bumpBoosts();
  }

  // Publish the kind:1 "I boosted" note when opted in, patching the stored boost
  // with the note id. Signed by the user's own key when they're signed in AND
  // picked "Post to my Nostr feed"; otherwise by the site's Nostr identity
  // server-side (publishBoostNoteViaSite) — the signed-out path and the
  // signed-in "Post via boostmebitch.com" choice. Shared by both payment paths.
  async function maybePublishNote(boostagram: Boostagram, results: BoostResult[]) {
    if (!shareNostr) return;
    setPubState({ kind: 'publishing' });
    try {
      const note = identity && shareAs === 'self'
        ? await publishBoostNote({ podcast, episode, boostagram, results, relays })
        : await publishBoostNoteViaSite({ podcast, episode, boostagram, results });
      setPubState({ kind: 'done', note });
      storage.boosts.update(identity?.npub, boostagram.uuid!, { noteId: note.id });
      bumpBoosts();
    } catch (e) {
      setPubState({ kind: 'error', message: getErrorMessage(e, 'publish failed') });
    }
  }

  async function go() {
    if (!rail) return;
    // Unlock the success sound NOW, inside the tap — the actual play() fires
    // after the async payment, past the gesture's activation window on mobile.
    // The muted unlock claims an audio session too, so it takes the same live
    // isPlaying reading as the ping (see primeBoostSound).
    primeBoostSound({ appIsPlaying: useApp.getState().isPlaying });
    // Saved even for an anonymous boost — it's the user's own device-local
    // "From" default, and withholding it from the wire is what anonymity means
    // here, not forgetting what they typed.
    if (name) storage.senderName.set(identity?.npub, name);

    const boostagram: Boostagram = {
      app_name: 'BoostMeBitch',
      app_version: '0.1.0',
      podcast: podcast.title,
      feedID: podcast.id,
      url: podcast.url,
      ts: episode ? Math.floor(positionSec) : 0,
      value_msat_total: sats * 1000,
      message: msg || undefined,
      sender_name: senderName,
      sender_id: anonymous ? undefined : identity?.pubkey,
      action: 'boost',
      uuid: crypto.randomUUID(),
      remote_feed_guid: podcast.podcastGuid,
      ...(episode && {
        episode: episode.title,
        itemID: episode.id,
        episode_guid: episode.guid,
        remote_item_guid: episode.guid,
      }),
      // A live show redirects payment to whoever is on stage. The primary
      // fields stay the SHOW — the broadcast the listener chose — while the
      // remote guids name the track, so the artist sees real context and the
      // host can correlate. Same shape as a valueTimeSplit leg.
      ...liveBoostFields(episode?.guid),
    };

    setRunning(true);
    // Pre-sized so an out-of-order leg can be written at its own index without
    // leaving a length gap — sendBoost pays biggest share first, so the first
    // leg to settle is rarely recipients[0].
    setResults(new Array(value.recipients.length));

    // ── Live-stream zap path ────────────────────────────────────────────────
    // Boosting a Nostr live stream while signed in, when the host's Lightning
    // address supports NIP-57 zaps, sends a REAL zap: the recipient's LN service
    // publishes a kind:9735 receipt tagged to the stream, so the boost shows up
    // *as a boost* in Fountain / tunestr / zap.stream (and BMB). Pre-check zap
    // support BEFORE paying so we never double-pay; on a real zap we skip the
    // kind:1311 text line (the receipt already renders as a boost).
    const liveStreamId = isLiveStreamId(episode?.guid) ? episode!.guid! : null;
    const hostLnaddr =
      value.recipients.length === 1 && value.recipients[0].type === 'lnaddress'
        ? value.recipients[0].address
        : null;
    const hasSigner = typeof window !== 'undefined' && !!window.nostr;
    if (liveStreamId && identity && hasSigner && hostLnaddr && (await lnaddrSupportsZaps(hostLnaddr))) {
      try {
        await sendZap({
          recipientPubkey: parseStreamId(liveStreamId)!.pubkey,
          recipientLud16: hostLnaddr,
          amountSats: sats,
          comment: msg || undefined,
          aTag: streamChatAddr(liveStreamId),
          relays: LIVE_STREAM_RELAYS,
          rail: rail ?? undefined,
          // So the LUD-21 comment carries the rss::payment descriptor, exactly
          // as an ordinary LNURL leg does. A single-recipient live block, so
          // the whole amount is this leg.
          metadata: {
            boostagram,
            recipient: value.recipients[0],
            legMsat: sats * 1000,
          },
        });
      } catch (e) {
        alert(getErrorMessage(e, 'zap failed'));
        setRunning(false);
        return;
      }
      fireConfetti();
      playBoostSound({ appIsPlaying: useApp.getState().isPlaying });
      setPaymentDone(true);
      setRunning(false);
      if (rail) recordLastRail(rail, identity);
      logStoredBoost(boostagram, [
        { recipient: hostLnaddr, recipientName: value.recipients[0].name, sats, ok: true },
      ]);
      setTimeout(() => onClose(), 1500);
      await maybePublishNote(boostagram, []);
      return;
    }

    let collected: BoostResult[] = [];
    try {
      collected = await sendBoost({
        value,
        totalSats: sats,
        boostagram,
        rail,
        // By index, never appended: legs settle biggest-share-first, so append
        // order is not recipient order and every ✓/✗ would land on the wrong
        // row. `.slice()` preserves the holes and hands React a fresh ref.
        onProgress: (res, index) =>
          setResults((prev) => {
            const next = prev.slice();
            next[index] = res;
            return next;
          }),
      });
      setResults(collected);
      if (paidAny(collected)) {
        fireConfetti();
        playBoostSound({ appIsPlaying: useApp.getState().isPlaying });
      }
    } catch (e) {
      alert(getErrorMessage(e, 'boost failed'));
      setRunning(false);
      return;
    }
    setPaymentDone(true);
    setRunning(false);

    const anyPaid = paidAny(collected);

    // Auto-close after a successful send (brief delay so the confetti + "sent"
    // state register). The Nostr note + chat publishes below continue in the
    // background; their post-close setState is a no-op in React 18. A fully
    // failed boost leaves the modal open so the user sees the error.
    if (anyPaid) setTimeout(() => onClose(), 1500);

    // Fallback (non-zap) path only reaches here. A live-stream boost that
    // didn't go out as a real zap (host doesn't support NIP-57, or signed out)
    // posts into the stream's chat (kind:1311) so other viewers still see it —
    // independent of the Share-on-Nostr toggle. Signed-in only (the message
    // must be signed); non-fatal so a relay hiccup can't fail the boost.
    if (anyPaid && identity && liveStreamId) {
      const chatMsg = `⚡ Boosted ${sats.toLocaleString()} sats${msg ? `: ${msg}` : ''}`;
      publishLiveChat(liveStreamId, chatMsg).catch(() => { /* non-fatal */ });
    }

    // Remember the rail that actually paid as the user's preference (local +
    // synced to Nostr) so it's preselected here and on their other devices.
    if (anyPaid && rail) recordLastRail(rail, identity);

    // Persist the boost locally so the user's "view" surface (the global feed)
    // can render it. Logged regardless of rail; maybePublishNote patches in
    // `noteId` for dedupe against the relay-discovered version. Publish is gated
    // on at least one successful leg — failed-only boosts shouldn't pollute the
    // network.
    if (anyPaid) {
      logStoredBoost(boostagram, storedBoostLegs(collected));
      await maybePublishNote(boostagram, collected);
    }
  }

  if (!portalTarget) return null;

  return createPortal(
    // pb-28 clears the fixed mini-player bar so the sticky footer isn't hidden behind it.
    //
    // Height is the *dynamic* viewport, not inset-0 — the same iOS Safari rule
    // <FullscreenPlayer> already carries: a fixed inset-0 element sizes to the
    // LARGE (toolbar-hidden) viewport, so this box is taller than what you can
    // actually see. Centering a tall card inside it then pushes the card's head
    // off the top of the screen — reported as "the boost modal is cut off", with
    // the amount field visible and the episode title gone. h-[100dvh] tracks the
    // visible area, and max-h-full on the card below spends exactly what's left
    // after this padding.
    <div className="fixed inset-x-0 top-0 h-[100dvh] z-[60] bg-ink/85 backdrop-blur-sm flex items-center justify-center p-4 pb-28">
      {/* scrollbar-gutter reserves the scrollbar's width even while it's not
          shown, so content growing past 92vh (a wrapped desc line, status
          rows appearing) can't jitter the content width when the scrollbar
          pops in. */}
      <div className="card w-full max-w-xl bg-ink relative max-h-full overflow-y-auto [scrollbar-gutter:stable]">
        <button
          onClick={onClose}
          className="absolute top-2 right-3 text-muted hover:text-bone text-lg z-10"
          aria-label="Close"
        >×</button>

        <div className="p-5 border-b border-bone/15">
          <div className="stamp text-bolt border-bolt/60 mb-2">
            {isShowBoost ? '⚡ BOOST SHOW' : '⚡ BOOST'}
          </div>
          <h3 className="font-display text-2xl leading-tight">
            {episode?.title ?? podcast.title}
          </h3>
          {episode && (
            <p className="text-xs text-muted mt-1">{podcast.title} · @ {Math.floor(positionSec)}s</p>
          )}
        </div>

        <div className="p-5 space-y-4">

          {!rail && (
            <div className="text-[11px] text-nostr/80">
              No wallet connected — connect one with ⚡ Connect wallet (top right).
            </div>
          )}
          {/* Above the amount deliberately: which wallet pays is the decision
              the sticky-footer balance is reporting on, so it has to be
              answerable before the user reads that number. */}
          <RailPicker rail={rail} onChange={setRail} />
          <AmountInput sats={sats} onChange={setSats} />
          <MessageInput value={msg} onChange={setMsg} />
          <SenderName value={name} onChange={setName} anonymous={anonymous} />
          <ShareNostrPicker
            signedIn={!!identity}
            share={shareNostr}
            shareAs={shareAs}
            onShareChange={handleShareNostrChange}
            onShareAsChange={handleShareAsChange}
            noteNoun="A public note"
          />
          <LiveNowPlaying episode={episode} />
          <SplitsPreview recipients={value.recipients} splits={splits} results={results} />
          <LightningStatus results={results} totalRecipients={value.recipients.length} />
          <PublishStatus state={pubState} />
        </div>

        <div className="flex justify-between items-center gap-3 p-5 border-t border-bone/15 sticky bottom-0 bg-ink">
          <button onClick={onClose} className="btn-ghost">{paymentDone ? 'Close' : 'Cancel'}</button>
          <div className="flex items-center gap-3">
            {!paymentDone && rail && <BoostModalBalance amountSats={sats} rail={rail} />}
            {!paymentDone && sats < MIN_BOOST_SATS && (
              <span className="text-[11px] text-muted">min {MIN_BOOST_SATS} sats</span>
            )}
            {!paymentDone && (
              <button
                onClick={go}
                disabled={running || !rail || sats < MIN_BOOST_SATS}
                className="btn-bolt disabled:opacity-40"
              >
                <BoltIcon />
                {running ? 'sending…' : `Send ${sats} sat`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
