'use client';
import { useWalletChange } from '@/lib/use-wallet-change';
import { useEffect, useMemo, useState } from 'react';
import { ModalShell } from '../modal-shell';
import type { Episode, Podcast, Boostagram, StoredBoost, ValueTimeSplit } from '@/lib/types';
import { useApp } from '@/lib/store';
import { sendBoost, pickRail, paidAny, type BoostResult, type Rail } from '@/lib/v4v/boost';
import { publishBoostNote, publishBoostNoteViaSite, resolvePublishRelays, recordLastRail, publishLiveChat, isLiveStreamId, noteNpubs, mintSummaryReceipt, type QuotedZapReceipt } from '@/lib/nostr';
import { storage } from '@/lib/storage';
import { useSharePicker } from './use-share-picker';
import { getErrorMessage, payableLeg, payableValue, redirectLegs, showShareUrl, storedBoostLegs, randomId } from '@/lib/util';
import { BRAND, resolveSenderName } from '@/lib/brand';
import { fireConfetti, playBoostSound, primeBoostSound } from '@/lib/format';
import { BoltIcon } from '../icons';
import { BoostModalBalance } from '../wallet-balance';
import { RailPicker } from '../rail-picker';
import { AmountInput, MIN_BOOST_SATS } from './amount-input';
import { MessageInput } from '../message-input';
import type { MentionNpub } from '@/lib/nostr/mention-tags';
import type { Nip73Refs } from '@/lib/nostr';
import { SenderName } from './sender-name';
import { useReplyAddress } from './use-reply-address';
import { SplitsPreview, LightningStatus } from './splits-preview';
import { DroppedPayees } from './dropped-payees';
import { LiveNowPlaying, NowPayingRow, splitTargetLabel } from '../live-now-playing';
import { useActiveSplit } from './use-active-split';
import { liveTargetSnapshot, type LiveTarget } from '@/lib/v4v/live-value';
import { fetchRemoteItemParent, isNotPlayed, livePlayedKey, livePlayedSnapshot } from '@/lib/live-played';
import { PublishStatus, type PublishState } from './publish-status';
import { ShareNostrPicker } from './share-nostr-picker';
import { activeNostr } from '@/lib/nostr/signer';

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
function liveBoostFields(t: LiveTarget | null, episodeGuid?: string) {
  if (!episodeGuid || t?.guid !== episodeGuid || !t.split?.value?.recipients?.length) return {};
  const remote = t.split.remoteItem;
  return {
    ...(remote?.feedGuid ? { remote_feed_guid: remote.feedGuid } : {}),
    ...(remote?.itemGuid ? { remote_item_guid: remote.itemGuid } : {}),
    ...(t.event ?? {}),
  };
}

/**
 * The live block the boost note may name as the track it paid, from the SAME
 * snapshot `liveBoostFields` put on the boostagram — so the note and the
 * boostagram cannot name two different songs. Null for the show's own block and
 * for a host segment: a block the played-tracks list would not keep
 * (`isNotPlayed`) is not a track.
 */
function liveNoteSplit(
  t: LiveTarget | null,
  episodeGuid: string | undefined,
  showFeedGuid: string | undefined,
): ValueTimeSplit | null {
  if (!episodeGuid || t?.guid !== episodeGuid || !t.split?.value?.recipients?.length) return null;
  if (isNotPlayed({ ...t, showFeedGuid }, t.split)) return null;
  return t.split;
}

/**
 * Who made the track, for the note's `🎵` line — display only. Podcast Index
 * carries `author` on the FEED record, so neither a resolved window nor a live
 * block has it; the played list may already have asked, and otherwise this
 * asks `/api/remote-item`. Started when the boost is sent, so it runs while the
 * wallet pays; undefined on any miss.
 */
async function noteTrackArtist(split: ValueTimeSplit, t: LiveTarget | null): Promise<string | undefined> {
  if (split.artist) return split.artist;
  if (t?.split === split) {
    const key = livePlayedKey(t);
    const row = livePlayedSnapshot(t.guid).find((p) => p.key === key);
    if (row?.split.artist) return row.split.artist;
  }
  const feedGuid = split.remoteItem?.feedGuid;
  const itemGuid = split.remoteItem?.itemGuid;
  if (!feedGuid || !itemGuid) return undefined;
  return (await fetchRemoteItemParent(feedGuid, itemGuid))?.artist;
}

/**
 * The longest the note waits for the artist. The sats have already moved when
 * it publishes, and a missing artist costs only the "— artist" half of one line.
 */
const NOTE_ARTIST_WAIT_MS = 2000;

interface Props {
  podcast: Podcast;
  episode?: Episode;       // omit for show-level boosts
  positionSec?: number;    // only meaningful when episode is present
  onClose: () => void;
}

export function BoostModal({ episode, podcast, positionSec = 0, onClose }: Props) {
  // The exact set the published note will `p`-tag, from the one function that
  // decides it. MEMOIZED, and that is load-bearing rather than tidiness: this
  // is a prop on <MessageInput>, whose warm effect keys on it, and this
  // component re-renders on every keystroke in the boostagram box. An inline
  // `?? []` is a fresh array identity each render — `parseFeedNpubs` returns
  // `undefined` rather than `[]` when a feed declares no npubs, which is the
  // common case — so the effect re-ran per keystroke and fired a follow-wide
  // kind:0 fan-out that `fetchProfilesFor` does not coalesce.
  const feedNpubs = useMemo(() => noteNpubs(podcast, episode), [podcast, episode]);

  const identity = useApp((s) => s.identity);
  const bumpBoosts = useApp((s) => s.bumpBoosts);
  const [sats, setSats] = useState(0);
  const [msg, setMsg] = useState('');
  // People the sender @mentioned. Kept beside `msg` rather than inside it: the
  // text carries a readable "@alice" and this carries the identity, because the
  // same string becomes the boostagram TLV message and the LNURL comment, where
  // a 63-character npub would be truncated mid-bech32 with nothing reporting it.
  const [mentions, setMentions] = useState<MentionNpub[]>([]);
  const [name, setName] = useState('');
  const setWalletOpen = useApp((s) => s.setWalletOpen);
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
  // Inline error surface. This replaced two alert()s — the only ones in the
  // codebase, both on the payment path. A blocking native dialog over a modal
  // that is mid-teardown can't be styled, isn't read in context by a screen
  // reader, and on iOS Safari can be suppressed outright; meanwhile this modal
  // already owns three structured status surfaces. `hostErr` is separate
  // because the host leg is non-fatal and its message has to sit beside a
  // partly-successful send rather than replacing it.
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [hostErr, setHostErr] = useState<string | null>(null);
  const [paymentDone, setPaymentDone] = useState(false);

  // Share picker + the `anonymous` flag derived from it. Shared with
  // <BoostAllModal> via the hook rather than restated here — see
  // ./use-share-picker for why one definition of `anonymous` matters.
  const {
    shareNostr,
    setShareNostr: handleShareNostrChange,
    shareAs,
    setShareAs: handleShareAsChange,
    anonymous,
  } = useSharePicker(identity);
  const [pubState, setPubState] = useState<PublishState>({ kind: 'idle' });

  // Portal to <body> so the overlay escapes the layout's `relative z-0` content
  // wrapper — otherwise, when this modal is opened from the episode list / detail
  // view (inside that wrapper), the mini-player (body-level, z-30) paints over
  // its footer. Opening from the player already worked because the player shares
  // the body-level context; portaling makes every entry point behave the same.

  // Keep rail in sync if a wallet connects/disconnects while the modal is open.
  // This covers WebLN as well as NWC and Spark — it used to watch only the
  // first two, so enabling a WebLN extension mid-modal never re-rendered
  // <RailPicker> and the rail the user had just enabled stayed unofferable.
  useWalletChange(() => setRail(pickRail()));

  const relays = useMemo(() => resolvePublishRelays(identity), [identity]);

  // `anonymous` comes from useSharePicker above. The NAME stays here because it
  // needs this modal's own "From" input state; DEFAULT_SENDER_NAME substitutes
  // rather than omits, so an anonymous boost presents consistently instead of
  // rendering blank in one aggregator and "Unknown" in the next. Same
  // substitution when a named user just leaves "From" empty. Computed at
  // component scope (not inside go()) because <SenderName> renders off it.
  const senderName = resolveSenderName(name, anonymous);

  // Where a recipient can boost this user back, resolved from their profile's
  // lightning address. Empty until it resolves, and never gated on — see the
  // hook. The anonymity check is applied at the wire site below, beside
  // `sender_id`, rather than in here: keeping every identity decision on
  // adjacent lines is what stops the fourth one being forgotten.
  const replyFields = useReplyAddress(identity);

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
  // The SHOW's block — `payableValue`, not `episode?.value ?? podcast.value`.
  // A playlist row's parent is not the container, so the container's block must
  // never stand in for it; see lib/util.ts. Every surface that opens this modal
  // gates on the same call, so the non-null assertion holds exactly as before.
  const hostValue = payableValue(episode, podcast)!;

  // A <podcast:valueTimeSplit> covering the position this modal opened at
  // redirects the boost to the track playing, exactly as a live show's block
  // does. Frozen at open and gated on the episode actually playing — see
  // useActiveSplit. Null on every other path, so an ordinary boost's wire bytes
  // and UI are unchanged.
  const active = useActiveSplit(episode, positionSec);
  const redirect = active.state === 'ready' ? active.split : null;

  // The block the primary preview and the primary leg use: the artist's when
  // redirected, the show's otherwise.
  const primaryValue = redirect?.value ?? hostValue;

  // Both legs, resolved once: the sats, the payees each one reaches, and who it
  // does not. `redirectLegs` (lib/util.ts) is `splitTrackAndHost` composed with
  // `payableLeg`. It lives there rather than here for two reasons — it is the
  // same composition <BoostAllModal> runs, and two copies of it is how the same
  // feed comes to be paid two different ways depending on which button was
  // pressed; and `lib/util.ts` loads under --experimental-strip-types, so
  // `check:vts` pins the shipping composition instead of a copy.
  //
  // `payableLeg`, never a bare `splitSats`, on BOTH legs. A redirect makes the
  // track leg floor(sats × remotePercentage / 100), and `remotePercentage` is
  // authored by the host's FEED — so the 100-sat minimum on what the user TYPES
  // says nothing about whether this leg reaches every payee. A 2% window turns a
  // gated 100-sat boost into 2 sats over a four-payee artist block; `splitSats`
  // honestly leaves two of them at 0 and `payOne` short-circuits `sats <= 0` to
  // ok:true WITHOUT contacting anyone — a ✓ and a StoredBoost for a payment
  // nobody received, on the LARGER of the two legs.
  //
  // Unredirected it still applies, and it is NOT a no-op there: a block that
  // lists a `split="0"` recipient has a payee no amount ever reaches, and the
  // 0-sat leg it would be paid reports as ✓ the same way.
  const { primaryLeg, hostLeg } = useMemo(() => {
    if (!redirect) {
      return { primaryLeg: payableLeg(sats, primaryValue.recipients), hostLeg: null };
    }
    const { track, host } = redirectLegs({
      totalSats: sats,
      remotePercentage: redirect.remotePercentage,
      trackRecipients: primaryValue.recipients,
      hostRecipients: hostValue.recipients,
    });
    return { primaryLeg: track, hostLeg: host };
  }, [redirect, sats, primaryValue.recipients, hostValue.recipients]);

  const primarySats = primaryLeg.sats;
  const hostSats = hostLeg?.sats ?? 0;
  // `payable`, never `hostSats > 0`. They differ on a block whose every payee
  // is listed at zero weight, where there are sats and nobody to receive them.
  const showsHostLeg = !!hostLeg?.payable;

  // ONE object drives the preview and the send — re-deriving the trimmed set at
  // send time would let the rows the user approved differ from the legs that go
  // out. `recipients` is EMPTY when the leg is unpayable, so a caller that
  // forgets the `payable` gate sends nothing rather than a group of false ✓.
  const value = useMemo(
    () => ({ ...primaryValue, recipients: primaryLeg.recipients }),
    [primaryValue, primaryLeg.recipients],
  );
  const splits = primaryLeg.splits;
  // Nothing to pay on either leg. The button has to say so: `sats` is at or
  // above the minimum, so every other gate reads as ready.
  const nothingPayable = !primaryLeg.payable && !showsHostLeg;

  // MAY this boost publish something signed by the USER's key outside the
  // note — today, a live stream's kind:1311 chat line? Two separate questions,
  // and testing only the first is the privacy inversion `streamingMayPublish()`
  // exists to name. "Anonymous" (shareAs === 'site') must not. Neither may
  // "Don't post": that writes `shareNostr = false` and leaves `shareAs` alone,
  // so a gate written as `!anonymous` would publish a signed, timestamped record
  // naming the user who had just chosen to publish less.
  const maySignAsSelf = !!identity && shareNostr && shareAs === 'self';


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
  async function maybePublishNote(
    boostagram: Boostagram,
    results: BoostResult[],
    // The one receipt the note quotes — see PublishArgs.summaryReceipt. Both
    // paths carry it: a self-signed note's request was signed by the user, a
    // site-published note's by the site, so neither names anyone it shouldn't.
    summaryReceipt?: QuotedZapReceipt,
    // The track the boost paid, with the legs that paid it — see
    // PublishArgs.track. The note names it only if one of those legs settled.
    track?: { split: ValueTimeSplit; results: BoostResult[] },
  ) {
    if (!shareNostr) return;
    setPubState({ kind: 'publishing' });
    try {
      const note = identity && shareAs === 'self'
        ? await publishBoostNote({ podcast, episode, boostagram, results, relays, mentions, summaryReceipt, track })
        // Mentions are passed on BOTH paths on purpose. noteMentionTags decides
        // what each may do with them — the body always, the `p` tags only when
        // the user's own key signs — and that decision belongs there, not in a
        // caller that would have to remember it at every site.
        : await publishBoostNoteViaSite({ podcast, episode, boostagram, results, mentions, summaryReceipt, track });
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
    // Clear last attempt's errors — a stale message beside a fresh send reads
    // as this send having failed.
    setSendErr(null);
    setHostErr(null);
    // Saved even for an anonymous boost — it's the user's own device-local
    // "From" default, and withholding it from the wire is what anonymity means
    // here, not forgetting what they typed.
    if (name) storage.senderName.set(identity?.npub, name);

    // The live target, read ONCE: the boostagram's remote guids and the note's
    // track line both come from this snapshot, so they name the same song.
    const liveTarget = liveTargetSnapshot();
    // The track the note may name: the frozen window on a recorded episode,
    // the on-air block on a live one. Its artist is looked up now, while the
    // wallet pays, and only when there will be a note to put it in.
    const noteSplit = redirect ?? liveNoteSplit(liveTarget, episode?.guid, podcast.podcastGuid);
    const noteArtist = shareNostr && noteSplit
      ? noteTrackArtist(noteSplit, liveTarget).catch(() => undefined)
      : Promise.resolve(undefined);

    const boostagram: Boostagram = {
      app_name: BRAND.wireName,
      app_version: '0.1.0',
      podcast: podcast.title,
      feedID: podcast.id,
      url: podcast.url,
      ts: episode ? Math.floor(positionSec) : 0,
      value_msat_total: sats * 1000,
      message: msg || undefined,
      sender_name: senderName,
      sender_id: anonymous ? undefined : identity?.pubkey,
      // Same gate, and it is not optional: a lightning address resolves to the
      // person who owns it just as surely as a pubkey does, so an "anonymous"
      // boost that carried a reply address would break the promise on screen
      // by a third route. Spread rather than assigned so an unresolved lookup
      // adds no keys at all.
      ...(anonymous ? {} : replyFields),
      action: 'boost',
      uuid: randomId(),
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
      ...liveBoostFields(liveTarget, episode?.guid),
      // The pre-recorded equivalent, and the same shape for the same reason:
      // primary fields describe the episode the listener is playing, remote_*
      // names the track that earned the payment. Spread last so it wins over
      // the episode branch's `remote_item_guid` — a boost inside a split window
      // is a payment for the TRACK, and the artist's aggregator reads these two
      // fields to say which one. Both legs carry them, so the host's Helipad
      // can tie their 3% back to the song that triggered it.
      // A `<podcast:medium>musicL` PLAYLIST is the third shape of the same
      // thing, and it needs no window or socket to reach it: the item simply
      // lives in a different feed from the container. `remote_feed_guid` above
      // took `podcast.podcastGuid`, which on a playlist names the curated list
      // rather than the album that earned the payment — so the artist's
      // aggregator is handed a feed their track is not in, and the host cannot
      // correlate. The episode's own guid is the album's; on every ordinary
      // feed the two are equal, so this spread changes nothing there.
      ...(episode?.podcastGuid && episode.podcastGuid !== podcast.podcastGuid
        ? { remote_feed_guid: episode.podcastGuid, remote_item_guid: episode.guid }
        : {}),
      ...(redirect?.remoteItem?.feedGuid ? { remote_feed_guid: redirect.remoteItem.feedGuid } : {}),
      ...(redirect?.remoteItem?.itemGuid ? { remote_item_guid: redirect.remoteItem.itemGuid } : {}),
    };

    setRunning(true);
    // Pre-sized so an out-of-order leg can be written at its own index without
    // leaving a length gap — sendBoost pays biggest share first, so the first
    // leg to settle is rarely recipients[0].
    setResults(new Array(primaryLeg.recipients.length));
    setHostResults(showsHostLeg ? new Array(hostLeg!.recipients.length) : []);

    // A Nostr live stream pays like every other boost: sendBoost below, by
    // keysend (TLV 7629169) or LNURL (BoostBox descriptor). It was a NIP-57 zap
    // to the host whenever the host's address supported one; payments do not
    // zap any more (docs/money-boosts.md, "The zap rail").
    const liveStreamId = isLiveStreamId(episode?.guid) ? episode!.guid! : null;
    const hasSigner = !!activeNostr();

    // The show and item the summary receipt names, as NIP-73 `k`/`i` pairs —
    // see lib/nostr/zap-request.ts. A live stream's `episode.guid` is a Nostr stream id, not an item guid, so it
    // names only the show there. The URL hints are this site's restorable deep
    // links.
    const showGuid = episode?.podcastGuid ?? podcast.podcastGuid;
    const itemGuid = liveStreamId ? undefined : episode?.guid;
    const hostRefs: Nip73Refs = {
      podcastGuid: showGuid,
      episodeGuid: itemGuid,
      podcastUrl: showShareUrl(showGuid) ?? undefined,
      episodeUrl: showShareUrl(showGuid, itemGuid) ?? undefined,
    };
    let collected: BoostResult[] = [];
    // `payable`, not `primarySats > 0`. A redirect with remotePercentage="0"
    // leaves this leg 0 sats, and `payableSplit`'s no-one-can-be-paid arm hands
    // back EVERY artist with an all-zero split — so sending it would put a ✓ and
    // a StoredBoost leg against each of them for a payment nobody attempted,
    // while the show's leg below takes the whole 100. The feed authors that
    // percentage; the user never sees it.
    if (primaryLeg.payable) {
      try {
        collected = await sendBoost({
          value,
          // The artist's share when a valueTimeSplit is in force, the whole boost
          // otherwise. `value` is the track's block in the first case, so this
          // pairing is the one thing that must stay together.
          totalSats: primaryLeg.sats,
          // Per LEG GROUP, not per boost. `boostagram` carries the whole typed
          // amount, because that is what the NOTE must say (invariant 7: note
          // amount is intent, not actual) — but a redirect pays this leg only
          // `primarySats`, and the show's leg below already overrides its own
          // total to `hostSats`. Passing the base object here left the two groups
          // advertising `sats + hostSats` for a boost of `sats`, so anything
          // reading TLV 7629169 saw a total larger than what arrived. <BoostAllModal>
          // has always done this per group; this is the modal that did not.
          boostagram: redirect
            ? { ...boostagram, value_msat_total: primaryLeg.sats * 1000 }
            : boostagram,
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
        setSendErr(getErrorMessage(e, 'boost failed'));
        setRunning(false);
        return;
      }
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
          value: { ...hostValue, recipients: hostLeg!.recipients },
          totalSats: hostLeg!.sats,
          // Its own uuid — it's a distinct payment and a recipient aggregator
          // dedupes on that field — but the same remote_* guids as the track
          // leg, which is what lets the host see which song earned their share.
          boostagram: { ...boostagram, uuid: randomId(), value_msat_total: hostLeg!.sats * 1000 },
          rail,
          onProgress: (res, index) =>
            setHostResults((prev) => {
              const next = prev.slice();
              next[index] = res;
              return next;
            }),
        });
        setHostResults(hostCollected);
      } catch (e) {
        // Non-fatal, per the note above — but NOT silent. CLAUDE.md: "A guard
        // that silently withholds must say so." With the artist's leg already
        // paid and this one thrown, hostResults stays all holes, <LightningStatus>
        // simply counts fewer settled legs, and nothing on screen said the
        // show's share never went out. The modal already gets this right for the
        // adjacent case (<DroppedPayees>); this is the same sentence for the
        // thrown one.
        setHostErr(getErrorMessage(e, "the show's share could not be sent"));
      }
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

    // A live-stream boost posts into the stream's chat (kind:1311) so other
    // viewers see it. Non-fatal so a relay hiccup can't fail the boost.
    //
    // Gated on `maySignAsSelf` (`shareNostr && shareAs === 'self'`) — NOT
    // merely on being signed in, which is what this said before. A kind:1311 is signed by the user's key and carries their prose,
    // so an Anonymous or "Don't post" boost that fell through here published
    // a signed, timestamped attribution on LIVE_STREAM_RELAYS: the zap gate had
    // relocated the leak rather than closed it. Same inversion
    // `streamingMayPublish()` names — a user who chose to publish LESS must
    // not end up publishing under their own key by a different door.
    if (anyPaid && maySignAsSelf && liveStreamId) {
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
      // Wait briefly for the kind:9735 each zap leg earned, THEN publish. The
      // receipts do not exist when the invoices settle, and the note quotes
      // them — that quote is what makes Fountain render the sat amount. The
      // user is already past the confetti and the modal is already closing, so
      // this wait is invisible; a receipt that never lands costs the quote and
      // nothing else.
      // The site-signed summary receipt for the sats that actually settled —
      // both groups, ok legs only — is the one thing the note quotes. For EVERY
      // boost that posts ("Don't post" is the only thing that skips it): the
      // user signs its request when their key publishes the note, the site
      // does when the note is site-published, so an Anonymous boost's receipt
      // names the site and not the user. Never throws; null quotes nothing.
      // The per-leg receipts are not waited for: they are not quoted, and they
      // reach the artist's feed on their own.
      const allLegs = [...collected, ...hostCollected];
      const paidSats = allLegs.filter((r) => r?.ok).reduce((sum, r) => sum + r.sats, 0);
      const summaryReceipt = shareNostr
        ? await mintSummaryReceipt({
            paidSats, refs: hostRefs, relays,
            as: identity && shareAs === 'self' && hasSigner ? 'self' : 'site',
          })
        : null;
      // `collected` is the TRACK's legs whenever there is a track to name: a
      // redirect sends the primary leg to the window's block, and a live show
      // pays the on-air block as its only leg. `boostNoteTrack` names nothing
      // unless one of them settled.
      const artist = noteSplit
        ? await Promise.race([
            noteArtist,
            new Promise<undefined>((r) => setTimeout(() => r(undefined), NOTE_ARTIST_WAIT_MS)),
          ])
        : undefined;
      const track = noteSplit
        ? { split: artist ? { ...noteSplit, artist } : noteSplit, results: collected }
        : undefined;
      await maybePublishNote(boostagram, allLegs, summaryReceipt ?? undefined, track);
    }
  }

  return (
    // NOT dismissable while `running`: Escape or a stray backdrop click in the
    // middle of a multi-leg send would take the per-leg results off screen
    // while sats are still moving, and the legs settle sequentially so there is
    // no single moment it's safe to lose sight of. The Cancel and × controls
    // stay in charge either way.
    //
    // scrollbar-gutter reserves the scrollbar's width even while it's not
    // shown, so content growing (a wrapped desc line, status rows appearing)
    // can't jitter the content width when the scrollbar pops in.
    <ModalShell
      onClose={onClose}
      label={episode?.title ?? podcast.title}
      className="w-full max-w-xl [scrollbar-gutter:stable]"
      dismissable={!running}
      closeButton
    >

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

          {/* A CONTROL, not an instruction, and the instruction was WRONG.
              It read "connect one with ⚡ Connect wallet (top right)", which
              names a control in <AppHeader> — and <AppHeader> renders on `/`,
              /live, /favorites, /playlists and /queue ONLY. On /stream/<naddr>,
              /npub/<npub> and /live/<npub> there is nothing in the top right,
              and those are exactly the routes somebody arrives on from a shared
              link and presses BOOST. The message pointed at empty space.

              Opening the wallet from here also stacks correctly: `lockScroll`
              is refcounted app-wide, <WalletModalHost> lives in the layout, and
              this modal already re-picks its rail through `useWalletChange`, so
              connecting a wallet updates the picker underneath without losing
              the amount or the message the user has typed. */}
          {/* RENDERED IN BOTH STATES, and the `!rail` gate it used to carry was
              the bug. Once the Wallet tab left the dock this became a route
              to the wallet from <FullscreenPlayer> — which is `fixed
              h-[100dvh] z-50` and covers <AppHeader> on every route; its
              `overlay` <AuthControl> (#413) is the other — and from
              /stream/<naddr>, /npub/<npub> and /live/<npub>, which render no
              header at all. Gated on `!rail`, somebody who HAS a wallet and
              wants to change or top up the one about to pay had nowhere to go
              from the screen they were listening on. Only the wording moves. */}
          <button
            type="button"
            onClick={() => setWalletOpen(true)}
            className={`btn-mini w-full justify-center ${
              rail
                ? 'border-bone/25 text-muted hover:border-bone/50 hover:text-bone'
                : 'border-nostr/60 text-nostr hover:border-nostr hover:text-nostr'
            }`}
          >
            {rail ? '⚡ WALLET' : '⚡ NO WALLET — CONNECT ONE'}
          </button>
          {/* Above the amount deliberately: which wallet pays is the decision
              the sticky-footer balance is reporting on, so it has to be
              answerable before the user reads that number. */}
          <RailPicker rail={rail} onChange={setRail} />
          {/* Locked while a send is in flight: `value`, `splits` and both legs
              are derived from `sats` at render time, while go() pays from the
              closure it captured at the tap — so an edit mid-send repaints the
              rows with figures that differ from the sats going out. */}
          <AmountInput sats={sats} onChange={setSats} disabled={running} />
          <MessageInput
            value={msg}
            onChange={setMsg}
            mentions={mentions}
            onMentionsChange={setMentions}
            feedNpubs={feedNpubs}
            // Same condition maybePublishNote signs by: anything else and the
            // site signs, so a sender-chosen `p` tag would be dropped.
            willNotify={!!identity && shareAs === 'self'}
          />
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
                  ? `${primarySats} sat · ${hostSats} sat to ${podcast.title}`
                  : `${primarySats} sat`
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
          {/* Gated on the trimmed list, not on `payable`: an unpayable leg has
              no rows, and an empty card reads as a load that never finished.
              <DroppedPayees> below says what happened instead.
              `listed` is the FEED's list — the percentages are the authored
              shares, so their denominator must be the authored weight total
              even when the rows are trimmed. */}
          {primaryLeg.recipients.length > 0 && (
            <SplitsPreview
              recipients={value.recipients}
              splits={splits}
              results={results}
              listed={primaryValue.recipients}
              title={redirect ? splitTargetLabel(redirect) : 'Recipients'}
            />
          )}
          {/* The same component as the show's share below. It earned a sentence
              the moment a redirect made this a DERIVED amount: the 100-sat
              minimum gates what the user typed, not what
              floor(sats × remotePercentage / 100) leaves for the artists. */}
          <DroppedPayees
            leg={primaryLeg}
            label={redirect ? splitTargetLabel(redirect) : podcast.title}
            className={primaryLeg.recipients.length > 0
              ? 'text-[11px] text-muted -mt-2'
              : 'text-[11px] text-muted'}
          />
          {showsHostLeg && (
            <>
              <SplitsPreview
                recipients={hostLeg!.recipients}
                splits={hostLeg!.splits}
                results={hostResults}
                listed={hostValue.recipients}
                title={podcast.title}
              />
              {/* Say who the show's share was too small to reach. Without this
                  the recipient is simply absent from a list the user is reading
                  to check where their money went, and a silent omission on a
                  payment screen is indistinguishable from a bug. */}
              <DroppedPayees leg={hostLeg!} label={podcast.title} />
              {/* The thrown-host-leg case. The artist's legs above may show ✓
                  while this one never went out at all, so it has to say so
                  rather than just be missing from the count. */}
              {hostErr && (
                <p className="text-[11px] text-nostr/80 -mt-2" role="status">
                  {podcast.title}&rsquo;s share didn&rsquo;t send: {hostErr}. The track&rsquo;s
                  legs above are unaffected.
                </p>
              )}
            </>
          )}
          {/* Whole-send failure. role="alert" because it means nothing was paid
              and the user is about to decide whether to try again. */}
          {sendErr && (
            <p className="text-xs text-nostr/80" role="alert">{sendErr}</p>
          )}
          <LightningStatus
            results={[...results, ...hostResults]}
            totalRecipients={value.recipients.length + (hostLeg?.recipients.length ?? 0)}
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
                // `nothingPayable` is its own gate: the amount clears the
                // minimum and a rail is connected, so every other condition
                // here reads as ready while there is nobody the block can pay.
                disabled={running || !rail || sats < MIN_BOOST_SATS || resolvingSplit || nothingPayable}
                className="btn-bolt disabled:opacity-40"
              >
                <BoltIcon />
                {running ? 'sending…' : `Send ${sats} sat`}
              </button>
            )}
          </div>
        </div>
    </ModalShell>
  );
}
