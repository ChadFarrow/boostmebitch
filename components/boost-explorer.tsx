'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchBoostsReceivedBy,
  fetchBoostsSentBy,
  fetchProfile,
  fetchZapsReceivedBy,
  noteHasSubstance,
  quotedEventIds,
  shortNpub,
  useNostrFeed,
  indexedBoostsSentBy,
  indexedBoostsReceivedBy,
  indexedZapsReceivedBy,
  useViewerReposts,
  zapSats,
  type DiscoveredNote,
  type ReceivedZap,
} from '@/lib/nostr';
import type { ProfileMetadata } from '@/lib/nostr/auth';
import { useApp } from '@/lib/store';
import { useNoteMeta, episodeRefOf, type NoteRefs } from '@/lib/use-note-meta';
import { Avatar } from './avatar';
import { CopyLinkButton } from './copy-link-button';
import { FeedSection } from './feed-section';
import { NoteCard } from './nostr-note-card';
import { ZapReceiptCard } from './zap-receipt-card';

/**
 * Every boost one npub sent and received, read from relays only.
 *
 * The two halves are NOT symmetric and the copy on screen has to say so:
 *
 *  - **Received does not depend on who signed the boost.**
 *    `buildBoostNoteTemplate` writes the recipient's `p` tag whoever signs the
 *    note — deliberately un-gated on the share picker's Anonymous, because an
 *    anonymous boost should still reach the artist. So a site-signed boost
 *    lands here even though its sender is unrecoverable.
 *
 *    It is a list of **boost NOTES**, not of payments, and that is why the
 *    NIP-57 zap receipts sit in their OWN section rather than in this one. A
 *    receipt is a different object with a different author (the recipient's
 *    LNURL server, never the payer) and different evidential weight. They were
 *    merged once and it was reverted (`9699c81`): two kinds of evidence under
 *    one heading made the list look like it answered "what was I paid", which
 *    it does not. The objection was to the MERGE — the coverage gap was real,
 *    so the receipts are read again, under their own heading, never mixed in.
 *  - **A payment that posts both is shown once.** A Fountain-style boost is two
 *    events for one payment: a kind:9735 and a kind:1 wrapper quoting it, both
 *    `p`-tagging the recipient. The wrapper is the richer card (sender profile,
 *    podcast line, reply thread) and its amount is adopted off the quoted
 *    receipt in `buildNote`, so the wrapper wins and `quotedEventIds` drops the
 *    receipt from the zaps section.
 *  - **Sent under-reports, permanently.** A boost is only authored by the
 *    sender when they chose "post to my Nostr feed"; every other boost is
 *    signed by the site key, and an anonymous one drops `sender_id` and
 *    `sender_name` as well. Nothing on the wire points back at the payer.
 *
 * An incomplete list that reads as complete is the same class of error as the
 * degraded-read bugs in docs/nostr.md — the person who cannot tell is the user,
 * looking at a short list and concluding they boosted less than they did. So
 * the caveat renders ALWAYS, not only when the list comes back empty, and every
 * empty message says "on these relays" rather than making a claim about the
 * person.
 *
 * Local state is never read here. `storage.boosts` is this device's log for the
 * SIGNED-IN user, which answers a different question and would silently show
 * the viewer's own boosts on a stranger's page.
 */
export function BoostExplorer({ pubkey, npub }: { pubkey: string; npub: string }) {
  const [profile, setProfile] = useState<ProfileMetadata | null>(null);
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);
  const identity = useApp((s) => s.identity);

  // Profile is chrome, so it loads on its own and never blocks either feed.
  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    fetchProfile(pubkey)
      .then((p) => { if (!cancelled) setProfile(p); })
      .catch(() => { /* the header falls back to shortNpub */ });
    return () => { cancelled = true; };
  }, [pubkey]);

  const sent = useNostrFeed({
    cacheKey: `npub:${pubkey}:sent`,
    fetcher: (opts) => fetchBoostsSentBy(pubkey, opts),
    // fetchBoostsSentBy pays a NIP-65 outbox lookup BEFORE its own scan, so the
    // relay path here stacks two multi-second windows back to back. The index
    // answers both in one request.
    indexFetcher: () => indexedBoostsSentBy(pubkey),
    deps: [pubkey],
  });
  const received = useNostrFeed({
    cacheKey: `npub:${pubkey}:recv`,
    fetcher: (opts) => fetchBoostsReceivedBy(pubkey, opts),
    indexFetcher: () => indexedBoostsReceivedBy(pubkey),
    deps: [pubkey],
  });

  // Zaps get a plain effect rather than useNostrFeed: that hook's payload type
  // is DiscoveredNote[] and it writes the shared bmb:feed cache, whose reader
  // maps a `replies` normalizer over whatever it parses — so bending it to hold
  // receipts would both mistype two other feeds and staple a bogus `replies: []`
  // onto every receipt. The `gen` ref is the same race guard it uses: a slow
  // fetch for one npub must not land over a newer one.
  //
  // This section still has no localStorage warm paint, so on a revisit the two
  // boost sections come back from `bmb:feed:*` within a frame while this one
  // waits. The READ INDEX now covers most of that gap — it answers in one
  // request where the relay pass costs a multi-second scan plus a batched
  // profile lookup — but a sibling cache namespace is still the fix if the
  // remaining delay ever matters, never a generic useNostrFeed.
  const [zaps, setZaps] = useState<ReceivedZap[] | null>(null);
  const zapGen = useRef(0);
  const refreshZaps = useCallback(() => {
    const myGen = ++zapGen.current;
    setZaps(null);
    // The index pass runs ALONGSIDE the relay pass, never in front of it: an
    // index that is merely slow must not delay the query that is authoritative.
    // It only paints if it wins and actually has something, and the relay
    // result still lands over it, because relays hold receipts this index may
    // never have been running to see.
    indexedZapsReceivedBy(pubkey)
      .then((z) => { if (z?.length && myGen === zapGen.current) setZaps(z); })
      .catch(() => { /* the index is never a reason to fail this panel */ });
    fetchZapsReceivedBy(pubkey)
      .then((z) => { if (myGen === zapGen.current) setZaps(z); })
      // Only claim "none" if nothing is on screen. An index hit followed by a
      // relay failure is a working panel; blanking it would report an absence
      // we did not observe.
      .catch(() => {
        if (myGen === zapGen.current) setZaps((prev) => (prev?.length ? prev : []));
      });
  }, [pubkey]);
  useEffect(() => {
    refreshZaps();
    // Bump the counter on cleanup so an in-flight fetch bails, exactly as
    // useNostrFeed does. `zapGen` is a plain counter ref (not a DOM node), so
    // the exhaustive-deps "ref may have changed" heuristic doesn't apply —
    // changing it is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { zapGen.current++; };
  }, [refreshZaps]);

  // EVERY note in the sent list is authored by the page's subject, so muting
  // them empties that panel outright — and the empty message blamed
  // site-signing and anonymity for it, which is the "a guard that silently
  // withholds must say so" rule in CLAUDE.md, broken. The received list is
  // written by other people, so the same filter is ordinary there.
  const subjectMuted = mutedPubkeys.has(pubkey);

  const sentVisible = useMemo(
    () => (sent.notes ? sent.notes.filter((n) => !mutedPubkeys.has(n.pubkey) && noteHasSubstance(n)) : null),
    [sent.notes, mutedPubkeys],
  );

  const receivedVisible = useMemo(
    () => (received.notes
      ? received.notes.filter((n) => !mutedPubkeys.has(n.pubkey) && noteHasSubstance(n))
      : null),
    [received.notes, mutedPubkeys],
  );

  // Held at null until BOTH lists are in hand. `quotedEventIds` needs the boost
  // notes to know which receipts are already on screen above, so painting early
  // would show a duplicated payment for a frame and then pull the row out from
  // under the reader. The two queries run in parallel, so this costs nothing but
  // the slower of the two.
  //
  // Mutes are filtered HERE as well as inside <ZapReceiptCard>. The card returns
  // null for a muted zapper, but <FeedSection> counts `notes.length` and renders
  // one wrapper <div> per item, so an all-muted list would be N empty rows under
  // a header reading (N). The card keeps its own `useApp` selector because it is
  // memoized and a mute arriving only through props would be skipped.
  //
  // Dedupe on the receipt's own id ONLY. A receipt whose `targetEventId` names a
  // note in the list is someone zapping that boost note — a second real payment,
  // not the same one twice.
  const zapsVisible = useMemo<ReceivedZap[] | null>(() => {
    if (zaps === null || received.notes === null) return null;
    const quoted = quotedEventIds(received.notes);
    return zaps.filter((z) => !quoted.has(z.id) && !mutedPubkeys.has(z.zapper));
  }, [zaps, received.notes, mutedPubkeys]);

  // Which of these the VIEWER has already reposted. Not decoration: without it
  // `alreadyReposted` is false on every card, the button reads "🔁 repost"
  // rather than done, and a viewer who already reposted a boost from the global
  // feed publishes a second kind:6 for the same note from this page. Every
  // other feed surface passes this; a new one has to, or it can only be wrong.
  const allNotes = useMemo(
    () => (sent.notes || received.notes ? [...(sent.notes ?? []), ...(received.notes ?? [])] : null),
    [sent.notes, received.notes],
  );
  const repostedIds = useViewerReposts(allNotes, identity);

  // One resolver pass over both lists, so a show boosted in each direction is
  // looked up once.
  // `NoteRefs` is the plain {podcastGuid, episodeGuids} shape, which a zap
  // receipt carries too — read off its embedded kind:9734 — so the receipts feed
  // the same resolver rather than a second one.
  const metaRefs = useMemo<NoteRefs[] | null>(() => {
    if (!sentVisible && !receivedVisible && !zapsVisible) return null;
    return [...(sentVisible ?? []), ...(receivedVisible ?? []), ...(zapsVisible ?? [])];
  }, [sentVisible, receivedVisible, zapsVisible]);
  const { podcasts, episodes } = useNoteMeta(metaRefs);

  function metaFor(refs: NoteRefs) {
    const ref = episodeRefOf(refs);
    return {
      podcast: refs.podcastGuid ? podcasts[refs.podcastGuid] ?? null : null,
      episode: ref ? episodes[ref.key] ?? null : null,
    };
  }

  // `mounted` gate, same reason <AuthControl> and the favorites panel document:
  // reading window.location during render makes the first CLIENT render
  // disagree with the server HTML (a SHARE button against nothing), and React
  // 19 throws the subtree away and rebuilds it. The button paints one tick late.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const displayName =
    profile?.display_name?.trim() || profile?.name?.trim() || shortNpub(npub);
  const shareUrl = mounted ? `${window.location.origin}/npub/${npub}` : null;

  // Sent only. `amountMsat` is the note's `amount` tag, which
  // `buildBoostNoteTemplate` sets to `value_msat_total` — the WHOLE boost,
  // before it is divided over the value block. On the sent side that is the
  // honest number: this npub paid the total.
  //
  // On the RECEIVED side it is not, and there is deliberately no sum there. A
  // boost note `p`-tags every npub the feed declared, so one 1000-sat boost
  // split 90/10 between an artist and their host would print "1000 sats" on
  // BOTH their pages — and the note carries no per-payee breakdown to divide
  // it with, because the splits live in the value block, not on the wire here.
  // A count is a fact; that sum would be a claim about money nobody can check.
  const sentSats = (sentVisible ?? []).reduce((n, x) => n + Math.floor((x.amountMsat ?? 0) / 1000), 0);

  // The zaps section MAY print a sum, and the received-boosts one still may not.
  // The difference is what the number measures. A boost note's `amount` tag is
  // `value_msat_total` — the whole boost, before the value block divides it — so
  // it is the same number on every p-tagged npub's page. A zap receipt's amount
  // is the invoice THIS recipient's own LNURL server issued: a per-payee settled
  // fact. `zapReceiptAmountMsat` falls back to the zap request's amount only
  // after the receipt tag and the bolt11 HRP, and NIP-57 requires those to agree.
  //
  // Scoped in the words twice over, because both limits are real: the scan is
  // limit-bounded, so this is the receipts SHOWN and not a lifetime total, and
  // `zapSats` floors an unreadable msat to 0, so those rows are counted out loud
  // rather than left to sink into the sum. Do not read this as licence to bring
  // the received-boosts sum back.
  const zapSatsTotal = (zapsVisible ?? []).reduce((n, z) => n + zapSats(z), 0);
  const zapsNoAmount = (zapsVisible ?? []).filter((z) => z.msat === null).length;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex items-center gap-4 flex-wrap">
        <Avatar
          pubkey={pubkey}
          picture={profile?.picture}
          name={displayName}
          className="w-16 h-16 rounded-full border border-bone/20 text-xl"
        />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl sm:text-3xl truncate">{displayName}</h1>
          <p className="font-mono text-xs text-muted truncate" title={npub}>{npub}</p>
        </div>
        <CopyLinkButton url={shareUrl} title="Copy link to this boost history" />
      </header>

      <FeedSection<DiscoveredNote>
        heading={
          <h2 className="font-display text-2xl">
            <span className="text-bolt">⚡</span> Boosts sent
          </h2>
        }
        description={
          <p className="text-xs text-muted leading-relaxed mb-3">
            Boosts this npub posted to Nostr under its own key
            {sentVisible && sentVisible.length > 0 && (
              <span className="text-bone/70">
                {' '}— {sentVisible.length} here, {sentSats.toLocaleString()} sats
              </span>
            )}
            . Boosts sent without signing in, and anonymous boosts, are signed by
            boostmebitch.com and carry no sender, so they cannot be listed. Only this
            npub&apos;s most recent notes are scanned, so an account that posts a lot may
            show none. This is not a complete record of what this npub has paid.
          </p>
        }
        notes={sentVisible}
        loading={sent.loading}
        err={sent.err}
        emptyMessage={
          subjectMuted
            ? 'you have muted this npub, so its own boosts are hidden here. Unmute to see them.'
            : 'no boosts from this npub surfaced from these relays — see the note above.'
        }
        onRefresh={sent.refresh}
        itemKey={(n) => n.id}
        collapsibleKey="npub:sent"
        renderNote={(note) => <NoteCard note={note} repostedIds={repostedIds} {...metaFor(note)} />}
      />

      <FeedSection<DiscoveredNote>
        heading={
          <h2 className="font-display text-2xl">
            <span className="text-nostr">#</span> Boosts received
          </h2>
        }
        description={
          <p className="text-xs text-muted leading-relaxed mb-3">
            Boosts that name this npub, through a feed&apos;s{' '}
            <code className="font-mono text-bone/70">&lt;podcast:txt purpose=&quot;nostr&quot;&gt;</code>{' '}
            tag
            {receivedVisible && receivedVisible.length > 0 && (
              <span className="text-bone/70">
                {' '}— {receivedVisible.length} here
              </span>
            )}
            . Unlike the list above, this one does not depend on who signed the boost.
          </p>
        }
        notes={receivedVisible}
        loading={received.loading}
        err={received.err}
        emptyMessage="no boosts to this npub surfaced from these relays."
        onRefresh={received.refresh}
        itemKey={(n) => n.id}
        collapsibleKey="npub:recv"
        renderNote={(note) => <NoteCard note={note} repostedIds={repostedIds} {...metaFor(note)} />}
      />

      <FeedSection<ReceivedZap>
        heading={
          <h2 className="font-display text-2xl">
            <span className="text-bolt">&#9889;</span> Zaps received
          </h2>
        }
        description={
          <p className="text-xs text-muted leading-relaxed mb-3">
            NIP-57 zap receipts (
            <code className="font-mono text-bone/70">kind:9735</code>) addressed to this npub —
            settled payments that posted no boost note of their own
            {zapsVisible && zapsVisible.length > 0 && (
              <span className="text-bone/70">
                {' '}— {zapsVisible.length} here, {zapSatsTotal.toLocaleString()} sats across the
                receipts shown
                {zapsNoAmount > 0 && ` (${zapsNoAmount} with no readable amount)`}
              </span>
            )}
            . A receipt is written by this npub&apos;s own Lightning server, so the sender is read
            from the zap request inside it; one whose request can&apos;t be read names nobody and
            is not listed. A zap that a boost note already quotes appears above, not twice.
          </p>
        }
        notes={zapsVisible}
        loading={zapsVisible === null}
        err={null}
        emptyMessage="no zaps to this npub surfaced from these relays."
        onRefresh={refreshZaps}
        itemKey={(z) => z.id}
        collapsibleKey="npub:zaps"
        renderNote={(zap) => <ZapReceiptCard zap={zap} {...metaFor(zap)} />}
      />
    </div>
  );
}
