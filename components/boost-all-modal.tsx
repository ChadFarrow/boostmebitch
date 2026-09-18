'use client';
import { useWalletChange } from '@/lib/use-wallet-change';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ModalShell } from './modal-shell';
import type { Episode, Podcast, Boostagram, ValueTimeSplit, StoredBoost } from '@/lib/types';
import { useApp } from '@/lib/store';
import { sendBoost, pickRail, paidAny, type Rail } from '@/lib/v4v/boost';
import { publishBoostNote, publishBoostNoteViaSite, resolvePublishRelays, recordLastRail, noteNpubs, mintSummaryReceipt } from '@/lib/nostr';
import { storage } from '@/lib/storage';
import { activeNostr } from '@/lib/nostr/signer';
import { useSharePicker } from './boost-modal/use-share-picker';
import { useZapRouting } from './boost-modal/use-zap-routing';
import { loadValueSplits } from '@/lib/podcast-meta';
import { getErrorMessage, hasValueRecipients, payableValue, redirectLegs, showShareUrl, storedBoostLegs, randomId, targetWord } from '@/lib/util';
import { BRAND, resolveSenderName } from '@/lib/brand';
import { fireConfetti, playBoostSound, primeBoostSound } from '@/lib/format';
import { BoltIcon } from './icons';
import { AmountInput, MIN_BOOST_SATS } from './boost-modal/amount-input';
import { MessageInput } from './message-input';
import type { MentionNpub } from '@/lib/nostr/mention-tags';
import type { Nip73Refs } from '@/lib/nostr';
import { SenderName } from './boost-modal/sender-name';
import { PublishStatus, type PublishState } from './boost-modal/publish-status';
import { ShareNostrPicker } from './boost-modal/share-nostr-picker';
import { PodcastCover } from './podcast-cover';
import { RailPicker } from './rail-picker';
import { DroppedPayees } from './boost-modal/dropped-payees';
import { BoostModalBalance } from './wallet-balance';
import { LegStatusGlyph } from './leg-status-glyph';

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
  const [sats, setSats] = useState(100);
  const [msg, setMsg] = useState('');
  // Identity beside the prose, not inside it — see <BoostModal> for why the
  // npub must never enter `msg`.
  const [mentions, setMentions] = useState<MentionNpub[]>([]);
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

  // Both halves of the share picker, not `!anonymous` — see <BoostModal> for
  // why "Don't post" has to be tested separately. A zap request is signed by
  // the user's key and the receipt republishes it as the payer.
  const mayZap = !!identity && shareNostr && shareAs === 'self';

  // Which legs across the whole album could be paid as real NIP-57 zaps. Every
  // track's block plus the show's, deduped and capped inside the hook.
  //
  // The summary note does NOT quote these receipts, on purpose. It states the
  // ALBUM total — "boosted 20 tracks for 2000 sats" — and a quoted receipt is
  // one leg of one track, so Fountain would render a ~44-sat figure beside
  // prose claiming 2000, which reads worse than no figure at all. The zap is
  // still worth sending: the receipt lands in the artist's own zap feed, and
  // its NIP-73 refs name the track it was for.
  const zapCandidates = useMemo(
    () => [
      ...splits.flatMap((s) => s.value?.recipients ?? []),
      ...(payableValue(episode, podcast)?.recipients ?? []),
    ],
    [splits, episode, podcast],
  );
  const zapRouting = useZapRouting(zapCandidates, relays, mayZap);


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
    // `cancelled`, like the two sibling readers of this endpoint: closing the
    // modal mid-flight, or switching episodes with it open, otherwise writes a
    // stale answer into whatever is mounted now.
    let cancelled = false;
    setLoadState('loading');
    loadValueSplits(episode.feedId, episode.id)
      .then((list) => {
        if (cancelled) return;
        const all: ValueTimeSplit[] = list ?? [];
        const resolved = all.filter((s) => hasValueRecipients(s.value));
        setSplits(resolved);
        setTotalSplits(all.length);
        setLoadState('ready');
      })
      .catch(() => { if (!cancelled) setLoadState('error'); });
    return () => { cancelled = true; };
  }, [episode.feedId, episode.id]);

  // One lookup per row rather than a `find` inside the map: `progress` grows
  // by one entry per settled leg during a boost-all, and the list re-renders on
  // each, so the scan was O(tracks²) at exactly the moment the UI is busiest.
  const progressByIndex = useMemo(() => new Map(progress.map((p) => [p.index, p])), [progress]);

  const total = sats * splits.length;

  // The host show's value block: the episode's own, else the feed's — but
  // never a CONTAINER's when the container is not this item's parent feed.
  // See `payableValue` in lib/util.ts. At component scope rather than inside
  // go(), because the per-track allocation below needs it at RENDER time.
  const hostValue = useMemo(() => payableValue(episode, podcast), [episode, podcast]);

  // BOTH legs of every track, resolved once for the rows AND the loop. ONE
  // object feeds what the screen claims and what goes out — the same rule
  // <BoostModal> follows — because a row that says "4 recipients" while the leg
  // pays three is the silent omission `payableLeg` exists to stop. The HOST half
  // is carried here too, not recomputed inside go(): the row renders
  // `host.sats` from this memo, so a second independent computation down there
  // is free to disagree with it the moment either side gains a rule.
  //
  // `redirectLegs` is `splitTrackAndHost` composed with `payableLeg`, and it
  // lives in lib/util.ts because <BoostModal> runs the same composition — two
  // copies is how the same feed comes to be paid two different ways depending
  // on which button was pressed — and because that file loads under
  // --experimental-strip-types, so `check:vts` pins the shipping composition
  // rather than a copy. Spec: `remotePercentage` is the share going to the
  // remote (track) recipients, (100 − remotePercentage) to the host show,
  // default 100.
  const trackLegs = useMemo(() => splits.map((split) => redirectLegs({
    totalSats: sats,
    remotePercentage: split.remotePercentage,
    trackRecipients: split.value?.recipients ?? [],
    hostRecipients: hostValue?.recipients ?? [],
  })), [splits, sats, hostValue]);

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
    // Sats that actually settled, both legs of every track, ok legs only —
    // what the summary receipt attests. Never `sats × tracks`, which is intent.
    let paidSats = 0;
    // Resolved here rather than at render: `activeNostr()` is not reactive, and
    // an album walk is long enough that the share picker can move under it.
    // `undefined`, never an empty table, so payOne grows no zap arm at all.
    const zapLegs = mayZap && activeNostr() && zapRouting ? zapRouting : undefined;
    // The show's identity for its per-track remainder legs; each track leg
    // names its own feed and item below. See lib/nostr/zap-request.ts.
    const hostRefs: Nip73Refs = {
      podcastGuid: podcast.podcastGuid,
      episodeGuid: episode.guid,
      podcastUrl: showShareUrl(podcast.podcastGuid) ?? undefined,
      episodeUrl: showShareUrl(podcast.podcastGuid, episode.guid) ?? undefined,
    };

    for (let i = 0; i < splits.length; i++) {
      if (cancelled.current) return;
      const split = splits[i];
      // Read from the memo the rows rendered, never recomputed here — BOTH
      // halves: the allocation the user looked at and the legs that go out are
      // one object. See the memo for why the composition lives in lib/util.ts.
      const { track, host } = trackLegs[i];
      // The TRACK's own feed and item — the same guids the boostagram carries
      // as remote_* — so the receipt says which song was paid, not the album.
      const trackRefs: Nip73Refs = {
        podcastGuid: split.remoteItem?.feedGuid,
        episodeGuid: split.remoteItem?.itemGuid,
        podcastUrl: showShareUrl(split.remoteItem?.feedGuid) ?? undefined,
        episodeUrl: showShareUrl(split.remoteItem?.feedGuid, split.remoteItem?.itemGuid) ?? undefined,
      };
      // Boostagram shape for valueTimeSplits: HOST episode in primary fields
      // (the album/playlist the listener is playing), TRACK in remote_*. The
      // recipient artist sees `podcast`/`episode` describing the listener's
      // context and `remote_*` identifying which track triggered the boost.
      const trackBoostagram: Boostagram = {
        app_name: BRAND.wireName,
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
        value_msat_total: track.sats * 1000,
        message: msg || undefined,
        sender_name: senderName,
        sender_id: anonymous ? undefined : identity?.pubkey,
        action: 'boost',
        uuid: randomId(),
      };
      let trackOk = false;
      // Only meaningful when trackOk is false: at least one leg's wallet never
      // answered, so "this track didn't pay" is not a claim we can make.
      let trackUnknown = false;
      try {
        // `payable`, not `trackSats > 0`. A window with remotePercentage="0"
        // makes this leg 0 sats, and payableSplit's no-one-can-be-paid arm
        // hands back EVERY artist with an all-zero split — sending that group
        // puts a ✓ and a StoredBoost leg against each of them for a payment
        // nobody attempted, while the show takes the whole amount.
        if (track.payable) {
          const results = await sendBoost({
            // Trimmed to the payees this share can actually reach, exactly like
            // the host leg below. Handing over `split.value!` whole would
            // re-split inside sendBoost across payees it cannot pay, and a
            // 0-sat leg reports as ✓. Same object the row rendered.
            value: { ...split.value!, recipients: track.recipients },
            totalSats: track.sats,
            boostagram: trackBoostagram,
            rail,
            zap: zapLegs,
            zapRefs: trackRefs,
          });
          trackOk = paidAny(results);
          trackUnknown = results.some((r) => r?.indeterminate);
          paidSats += results.filter((r) => r?.ok).reduce((sum, r) => sum + r.sats, 0);
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
              sats: track.sats,
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
      // their boostagram log. `host.payable` covers every skip this used to
      // list separately — remotePct === 100 (no host share), a share that
      // rounded to 0, and a block with nobody who can receive it — and it is
      // the SAME object the row rendered, so the two cannot disagree.
      if (host.payable && hasValueRecipients(hostValue) && !cancelled.current) {
        const hostBoostagram: Boostagram = {
          app_name: BRAND.wireName,
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
          value_msat_total: host.sats * 1000,
          message: msg || undefined,
          sender_name: senderName,
          sender_id: anonymous ? undefined : identity?.pubkey,
          action: 'boost',
          uuid: randomId(),
        };
        try {
          const hostResults = await sendBoost({
            // The trimmed set from the memo, NOT a second payableSplit call. A
            // per-track host share is arbitrarily small — 3 sats across four
            // payees leaves one at zero, and payOne reports a zero-sat leg as
            // ok:true, so the boost log recorded a payment nobody received. The
            // row above renders `host.sats`; computing the payees again here
            // would let what the screen claims drift from what goes out.
            // hostValue is non-null, guaranteed by hasValueRecipients above.
            value: { ...hostValue!, recipients: host.recipients },
            totalSats: host.sats,
            boostagram: hostBoostagram,
            rail,
            zap: zapLegs,
            zapRefs: hostRefs,
          });
          paidSats += hostResults.filter((r) => r?.ok).reduce((sum, r) => sum + r.sats, 0);
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
              sats: host.sats,
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
      app_name: BRAND.wireName,
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
      uuid: randomId(),
    };

    const lines: string[] = ['⚡ Boost ⚡', ''];
    if (msg.trim()) lines.push(msg.trim(), '');
    // Mirrors formatContent's attribution line, off the same `senderName` the
    // boostagrams carry — so an anonymous summary note reads as
    // DEFAULT_SENDER_NAME rather than attributing itself back to the user.
    // The reconcilable half, and the reason this line changed. This note is the
    // ONLY artifact carrying the album total; every wire record carries one
    // track's share, and nothing in a boostagram says it is 1 of N. So a reader
    // holding both saw `totalSats` here and one leg's amount there and read the
    // difference as sats that never left — reported as a boost that "only sent
    // 10%" of a ten-track album.
    //
    // It names the ARTIST's share, never `sats`. A feed taking a host share
    // pays each artist floor(sats × remotePercentage / 100), and THAT is the
    // number their boostagram carries: `(1000 each)` against a 900-sat wire
    // record leaves the reader in front of the same 10% gap this line exists to
    // close. The show's half is named too, so the two account for the whole.
    //
    // Omitted when the paid tracks divide differently from one another — a
    // per-track `remotePercentage` makes that ordinary, and one number cannot
    // describe them. Singular tracks skip it: "for 100 sats (100 each)" reads
    // as a fault.
    const paidLegs = successfulIdx.map((i) => trackLegs[i]);
    const uniform = paidLegs.length > 1 && paidLegs.every(
      (l) => l.track.sats === paidLegs[0].track.sats && l.host.sats === paidLegs[0].host.sats,
    ) ? paidLegs[0] : null;
    const each = !uniform
      ? ''
      : uniform.host.sats > 0
        ? ` (${uniform.track.sats} to the artist + ${uniform.host.sats} to the show, each)`
        : ` (${uniform.track.sats} each)`;
    lines.push(
      `${senderName} boosted ${successfulIdx.length} track${successfulIdx.length === 1 ? '' : 's'} on ${podcast.title} for ${totalSats} sats${each}`,
    );
    if (trackList.length) {
      lines.push('');
      for (const t of trackList) lines.push(`• ${t}`);
    }
    const contentOverride = lines.join('\n');

    setPubState({ kind: 'publishing' });
    // `results: []` on purpose: the summary's `amount` comes from
    // `value_msat_total`. The ONE receipt it quotes is the site-signed summary
    // for `paidSats` — the album's settled total, so what Fountain renders is
    // the figure the note states, not one track's leg. Per-leg receipts are
    // never waited for or quoted (a 4-second wait here once dropped the note
    // when × was pressed during it). Null quotes nothing; nothing throws.
    // Every posting boost, self or site — see <BoostModal> for the rule.
    const summaryReceipt = await mintSummaryReceipt({
      paidSats, refs: hostRefs, relays,
      as: identity && shareAs === 'self' && activeNostr() ? 'self' : 'site',
    });
    try {
      // User's own key only when signed in AND they picked "Post to my Nostr
      // feed"; otherwise the site's Nostr identity (signed out, or the
      // signed-in "Post via boostmebitch.com" choice).
      const note = identity && shareAs === 'self'
        ? await publishBoostNote({
            podcast, episode, boostagram: summaryBoostagram, results: [], relays, contentOverride,
            mentions, summaryReceipt: summaryReceipt ?? undefined,
          })
        : await publishBoostNoteViaSite({
            podcast, episode, boostagram: summaryBoostagram, results: [], contentOverride,
            mentions, summaryReceipt: summaryReceipt ?? undefined,
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
      closeButton
    >

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

          {/* "per track", not the single modal's "Amount to send". This is the
              one surface that MULTIPLIES the typed number by the track count,
              and the only other disclosure — the `n × sats = total` footer line
              — is gated behind `loadState === 'ready' && splits.length > 0`, so
              it says nothing while the tracks resolve. Reported as a boost that
              "only sent 10%": the album note carries `n × sats` while each
              track's boostagram carries one track's share, and nothing on
              screen connected the two numbers. */}
          <AmountInput
            sats={sats}
            onChange={setSats}
            label="Amount per track (sats)"
            // Locked while the loop runs: every row's figures are derived from
            // `sats` at render time, while go() pays from the closure it
            // captured at the tap. An edit mid-run repainted all N rows with
            // numbers that differ from the sats going out — and the ✓ glyphs
            // land beside those rows as each track settles.
            disabled={running}
          />

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
                  const result = progressByIndex.get(i);
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
                          {trackLegs[i].track.listed} recipient
                          {trackLegs[i].track.listed !== 1 ? 's' : ''}
                          {split.duration ? ` · ${Math.round(split.duration / 60)}m` : ''}
                        </div>
                        {/* The count above is what the FEED lists. Say when this
                            track's share cannot reach all of them, rather than
                            leaving a payee silently absent from a number
                            somebody is reading to check where their money went.
                            The SAME component <BoostModal> uses: three
                            hand-written copies of this sentence had drifted into
                            three wordings for one fact. A count and a reason —
                            naming each artist across N tracks would be a wall of
                            text. */}
                        <DroppedPayees
                          leg={trackLegs[i].track}
                          label={split.title ?? `track ${i + 1}`}
                          className="text-[11px] text-muted"
                        />
                        {/* How this track's amount divides. <BoostModal> shows
                            the same fact as two <SplitsPreview> cards; this
                            modal showed it nowhere, so a listener could not
                            learn that a show taking 10% of a track boost would
                            take 10% of theirs until a boost bot read out a
                            number they did not expect. That is what the "it
                            only sent 10%" report turned out to be, and the sats
                            were never missing.
                            Gated on the host leg's `payable`, never on
                            `remotePercentage`: splitTrackAndHost returns 0 when
                            the show has no block to pay, and a row promising a
                            share that will not be sent is the same silent
                            omission pointed the other way. The show is NAMED,
                            because the listener is reading this to decide
                            whether the division is what they want.
                            The track half names the MEDIUM's word, not "artist":
                            the row above may say "4 recipients", so naming one
                            artist put three recipient counts on one row. */}
                        {trackLegs[i].host.payable && (
                          <div className="text-[11px] text-muted truncate">
                            {trackLegs[i].track.sats} → {targetWord('item', podcast).toLowerCase()}
                            {' '}· {trackLegs[i].host.sats} → {podcast.title}
                          </div>
                        )}
                        {/* The show's own dropped payees. Its share is the
                            arbitrarily small one, so it is the leg most likely
                            to have some — and it was the half with no sentence
                            on this screen at all. Gated on `payable` like the
                            line above: a 100%-to-track window leaves the show
                            nothing BY DESIGN, and saying so on every row of an
                            ordinary album is noise, not disclosure. */}
                        {trackLegs[i].host.payable && (
                          <DroppedPayees
                            leg={trackLegs[i].host}
                            label={podcast.title}
                            className="text-[11px] text-muted"
                          />
                        )}
                      </div>
                      {result && (
                        <LegStatusGlyph ok={result.ok} indeterminate={result.indeterminate} className="text-sm" />
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
              {/* The mention run is appended by withMentions AFTER
                  contentOverride, which is the one place this path and the
                  single-boost path converge — a mention added inside
                  formatContent would be silently missing from every summary. */}
              <MessageInput
                value={msg}
                onChange={setMsg}
                mentions={mentions}
                onMentionsChange={setMentions}
                feedNpubs={feedNpubs}
                willNotify={!!identity && shareAs === 'self'}
              />
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
          {/* `flex-wrap`, unlike the single modal's otherwise identical footer:
              this one carries a fourth item, the `n × sats = total` line, and
              the balance chip is `whitespace-nowrap` so nothing here can shrink.
              At 390px the four would overflow a modal that cannot scroll
              sideways, putting the BOOST button off-screen. */}
          <div className="flex flex-wrap justify-end items-center gap-3">
            {!done && loadState === 'ready' && splits.length > 0 && (
              <>
                {total > 0 && (
                  <span className="text-bolt text-sm font-mono">
                    {splits.length} × {sats} = {total} sats
                  </span>
                )}
                {/* `total`, never `sats`. The single modal's chip tests the
                    number the user typed because that IS its spend; here the
                    spend is that number times the track count, so a chip on
                    `sats` would clear a boost the wallet goes on to refuse
                    part-way through — after some artists are already paid. */}
                {rail && <BoostModalBalance amountSats={total} rail={rail} />}
                {sats < MIN_BOOST_SATS && (
                  <span className="text-[11px] text-muted">min {MIN_BOOST_SATS} sats</span>
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
