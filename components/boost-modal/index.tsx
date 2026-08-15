'use client';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Episode, Podcast, Boostagram, StoredBoost } from '@/lib/types';
import { useApp } from '@/lib/store';
import { sendBoost, pickRail, paidAny, type BoostResult, type Rail } from '@/lib/v4v/boost';
import { subscribeNwc } from '@/lib/v4v/nwc';
import { subscribeSpark } from '@/lib/v4v/spark';
import { publishBoostNote, publishBoostNoteViaSite, resolvePublishRelays, recordLastRail, publishLiveChat, LIVE_STREAM_RELAYS, isLiveStreamId, parseStreamId, streamChatAddr } from '@/lib/nostr';
import { sendZap, lnaddrSupportsZaps } from '@/lib/v4v/zap';
import { storage, type ShareNostrAs } from '@/lib/storage';
import { getErrorMessage, payableSplit, resolveSenderName, splitSats, splitTrackAndHost, storedBoostLegs } from '@/lib/util';
import { fireConfetti, playBoostSound, primeBoostSound } from '@/lib/format';
import { BoltIcon } from '../icons';
import { BoostModalBalance } from '../wallet-balance';
import { RailPicker } from '../rail-picker';
import { AmountInput, MIN_BOOST_SATS } from './amount-input';
import { MessageInput } from './message-input';
import { SenderName } from './sender-name';
import { SplitsPreview, LightningStatus } from './splits-preview';
import { LiveNowPlaying, NowPayingRow, splitTargetLabel } from '../live-now-playing';
import { useActiveSplit } from './use-active-split';
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
  // The show's own leg, only when a valueTimeSplit redirect left it a share.
  // A separate array rather than a concatenation because the two legs are two
  // different value blocks with two different weight denominators — merging
  // them would make <SplitsPreview> print each recipient's percentage against
  // the wrong total.
  const [hostResults, setHostResults] = useState<(BoostResult | undefined)[]>([]);
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
  const hostValue = (episode?.value ?? podcast.value)!;

  // A <podcast:valueTimeSplit> covering the position this modal opened at
  // redirects the boost to the track playing, exactly as a live show's block
  // does. Frozen at open and gated on the episode actually playing — see
  // useActiveSplit. Null on every other path, so an ordinary boost's wire bytes
  // and UI are unchanged.
  const active = useActiveSplit(episode, positionSec);
  const redirect = active.state === 'ready' ? active.split : null;

  // How the amount divides between the artist and the show: remotePercentage to
  // the track, the remainder to the show, however small that remainder is. 100
  // sats at 97% is 97 and 3.
  const { trackSats, hostSats } = useMemo(
    () => redirect
      ? splitTrackAndHost({
        totalSats: sats,
        remotePercentage: redirect.remotePercentage,
        hostRecipientCount: hostValue.recipients.length,
      })
      : { trackSats: 0, hostSats: sats },
    [redirect, sats, hostValue.recipients.length],
  );

  // The block the primary preview and the primary leg use: the artist's when
  // redirected, the show's otherwise.
  const value = redirect?.value ?? hostValue;
  const primarySats = redirect ? trackSats : sats;
  const splits = useMemo(
    () => splitSats(primarySats, value.recipients),
    [primarySats, value.recipients],
  );
  // The show's leg. `payableSplit`, not `splitSats`: a small remainder can't
  // give every show recipient a whole sat, and a zero-sat leg is reported as
  // PAID (payOne short-circuits `sats <= 0` to ok:true), so it would render a ✓
  // and enter the boost log for someone who received nothing. Dropping them
  // from the leg spends the remainder on payees who can actually receive it.
  //
  // ONE object drives both the preview and the send — re-deriving the trimmed
  // set at send time would let the rows the user approved differ from the legs
  // that go out.
  const showsHostLeg = !!redirect && hostSats > 0;
  const hostLeg = useMemo(
    () => showsHostLeg
      ? payableSplit(hostSats, hostValue.recipients)
      : { recipients: [], splits: [] },
    [showsHostLeg, hostSats, hostValue.recipients],
  );
  // Recipients the feed lists but this leg is too small to pay — named on
  // screen rather than silently absent.
  const hostDropped = showsHostLeg
    ? hostValue.recipients.length - hostLeg.recipients.length
    : 0;

  // A window covers this second but we don't yet know whose block it points at.
  // Blocking the button is the point: the window is known synchronously and the
  // target is not, so a tap landing here would pay the show while the modal was
  // a moment away from promising the artist.
  const resolvingSplit = active.state === 'loading';

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
      // The pre-recorded equivalent, and the same shape for the same reason:
      // primary fields describe the episode the listener is playing, remote_*
      // names the track that earned the payment. Spread last so it wins over
      // the episode branch's `remote_item_guid` — a boost inside a split window
      // is a payment for the TRACK, and the artist's aggregator reads these two
      // fields to say which one. Both legs carry them, so the host's Helipad
      // can tie their 3% back to the song that triggered it.
      ...(redirect?.remoteItem?.feedGuid ? { remote_feed_guid: redirect.remoteItem.feedGuid } : {}),
      ...(redirect?.remoteItem?.itemGuid ? { remote_item_guid: redirect.remoteItem.itemGuid } : {}),
    };

    setRunning(true);
    // Pre-sized so an out-of-order leg can be written at its own index without
    // leaving a length gap — sendBoost pays biggest share first, so the first
    // leg to settle is rarely recipients[0].
    setResults(new Array(value.recipients.length));
    setHostResults(showsHostLeg ? new Array(hostLeg.recipients.length) : []);

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
        // The artist's share when a valueTimeSplit is in force, the whole boost
        // otherwise. `value` is the track's block in the first case, so this
        // pairing is the one thing that must stay together.
        totalSats: primarySats,
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
    } catch (e) {
      alert(getErrorMessage(e, 'boost failed'));
      setRunning(false);
      return;
    }

    // ── The show's share of a redirected boost ──────────────────────────────
    // A separate send because it's a different value block: a valueTimeSplit
    // redirects `remotePercentage` of the show's value to the track and leaves
    // the rest with the show, so the two can't be merged into one block without
    // rescaling both sets of weights and breaking splitSats' one-sat floor.
    // Sequential, like every other leg — NWC is a single relay connection.
    //
    // Non-fatal, and it must stay that way: the artist's leg has already been
    // paid by the time this runs, so throwing here would report a boost that
    // partly succeeded as a total failure and talk the user into paying twice.
    let hostCollected: BoostResult[] = [];
    if (showsHostLeg) {
      try {
        hostCollected = await sendBoost({
          // The trimmed block the preview rendered, NOT hostValue — sending the
          // full one would re-split inside sendBoost and could pay a recipient
          // zero, which reports as a ✓. Same object, so the rows the user
          // approved are exactly the legs that go out.
          value: { ...hostValue, recipients: hostLeg.recipients },
          totalSats: hostSats,
          // Its own uuid — it's a distinct payment and a recipient aggregator
          // dedupes on that field — but the same remote_* guids as the track
          // leg, which is what lets the host see which song earned their share.
          boostagram: { ...boostagram, uuid: crypto.randomUUID(), value_msat_total: hostSats * 1000 },
          rail,
          onProgress: (res, index) =>
            setHostResults((prev) => {
              const next = prev.slice();
              next[index] = res;
              return next;
            }),
        });
        setHostResults(hostCollected);
      } catch { /* non-fatal — see above */ }
    }

    setPaymentDone(true);
    setRunning(false);

    const anyPaid = paidAny(collected) || paidAny(hostCollected);

    // Celebrate ONCE, after every leg of every block has settled — not inside
    // the first sendBoost. A redirected boost sends the track's block and then
    // the show's, so firing on the track's completion popped the confetti and
    // played the ping while the show's legs were still going out and the button
    // still read "sending…". A success chime mid-payment is worse than a late
    // one: it says "done" over money that is still moving, which is the same
    // wrong claim a ✗ on an unanswered wallet makes, pointed the other way.
    if (anyPaid) {
      fireConfetti();
      playBoostSound({ appIsPlaying: useApp.getState().isPlaying });
    }

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
      // Each group ordered biggest-share-first WITHIN itself, track group
      // first — not one merged sort. The two blocks have different weight
      // denominators, so a merged sort would compare a host payee's raw weight
      // against an artist's and could list a 3-sat leg above the 97-sat one.
      // This also keeps the history card in the same order as the modal that
      // sent it, which is the whole reason storedBoostLegs sorts at all.
      logStoredBoost(boostagram, [
        ...storedBoostLegs(collected),
        ...storedBoostLegs(hostCollected),
      ]);
      // `boostagram.value_msat_total` is the full amount the user chose, so the
      // note reads "Boosted 100 sats" rather than naming one leg's share —
      // invariant 7, note amount is intent, not actual.
      await maybePublishNote(boostagram, [...collected, ...hostCollected]);
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
          {/* The redirect, said out loud. A boost that silently pays someone
              other than the act the user is listening to is the failure this
              feature exists to prevent, and the modal is the last place to
              catch it — so the target is named on the screen with the button
              on it, in the same words the live path uses. */}
          {redirect && (
            <NowPayingRow
              badge="♪ TRACK"
              image={redirect.image}
              label={splitTargetLabel(redirect)}
              detail={
                showsHostLeg
                  ? `${trackSats} sat · ${hostSats} sat to ${podcast.title}`
                  : `${trackSats} sat`
              }
            />
          )}
          {resolvingSplit && (
            <div className="text-[11px] text-muted">
              ♪ A track is playing — finding who to pay…
            </div>
          )}
          {/* An unresolvable remote item is ordinary, not an error: Podcast
              Index hasn't crawled every album feed. Say that the show is being
              paid rather than leaving the user to assume the artist was. */}
          {active.state === 'unresolved' && (
            <div className="text-[11px] text-muted">
              ♪ Couldn&rsquo;t look up the track playing here — boosting {podcast.title} instead.
            </div>
          )}
          <SplitsPreview
            recipients={value.recipients}
            splits={splits}
            results={results}
            title={redirect ? splitTargetLabel(redirect) : 'Recipients'}
          />
          {showsHostLeg && (
            <>
              <SplitsPreview
                recipients={hostLeg.recipients}
                splits={hostLeg.splits}
                results={hostResults}
                title={podcast.title}
              />
              {/* Say who the show's share was too small to reach. Without this
                  the recipient is simply absent from a list the user is reading
                  to check where their money went, and a silent omission on a
                  payment screen is indistinguishable from a bug. */}
              {hostDropped > 0 && (
                <div className="text-[11px] text-muted -mt-2">
                  {hostDropped} more {hostDropped === 1 ? 'recipient' : 'recipients'} in {podcast.title}
                  &rsquo;s split — {hostSats} sat {hostSats === 1 ? 'doesn' : 'don'}&rsquo;t reach
                  {' '}{hostValue.recipients.length} ways. Boost more to include everyone.
                </div>
              )}
            </>
          )}
          <LightningStatus
            results={[...results, ...hostResults]}
            totalRecipients={value.recipients.length + hostLeg.recipients.length}
          />
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
                // `resolvingSplit` is a money gate, not a spinner: a window is
                // known to cover this second but its target isn't resolved yet,
                // so a tap landing here would pay the show a moment before the
                // modal promised the artist.
                disabled={running || !rail || sats < MIN_BOOST_SATS || resolvingSplit}
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
