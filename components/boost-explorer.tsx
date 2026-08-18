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
 * One row of the received list. `ts` is unix ms across both kinds so they sort
 * together — the same discriminated-union shape <GlobalNostrFeed> uses to
 * intermix stored boosts with relay notes.
 */
type ReceivedItem =
  | { kind: 'note'; ts: number; key: string; note: DiscoveredNote }
  | { kind: 'zap'; ts: number; key: string; zap: ReceivedZap };

/**
 * Every boost one npub sent and received, read from relays only.
 *
 * The two halves are NOT symmetric and the copy on screen has to say so:
 *
 *  - **Received is complete.** `buildBoostNoteTemplate` writes the recipient's
 *    `p` tag whoever signs the note — deliberately un-gated on the share
 *    picker's Anonymous, because an anonymous boost should still reach the
 *    artist. So a site-signed boost lands here even though its sender is gone.
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
    deps: [pubkey],
  });
  const received = useNostrFeed({
    cacheKey: `npub:${pubkey}:recv`,
    fetcher: (opts) => fetchBoostsReceivedBy(pubkey, opts),
    deps: [pubkey],
  });

  // Zaps get a plain effect rather than useNostrFeed: that hook's payload type
  // is DiscoveredNote[] and it writes the shared bmb:feed cache, so bending it
  // to hold receipts would change a type two other feeds depend on. The `gen`
  // ref is the same race guard it uses — a slow fetch for one npub must not
  // land over a newer one.
  const [zaps, setZaps] = useState<ReceivedZap[] | null>(null);
  const zapGen = useRef(0);
  const refreshZaps = useCallback(() => {
    const myGen = ++zapGen.current;
    setZaps(null);
    fetchZapsReceivedBy(pubkey)
      .then((z) => { if (myGen === zapGen.current) setZaps(z); })
      .catch(() => { if (myGen === zapGen.current) setZaps([]); });
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

  // The received section's refresh button must re-query BOTH sources. Wiring it
  // to the notes half alone would leave the zap list frozen behind a control
  // that says it reloaded the list.
  const refreshReceived = useCallback(() => {
    refreshZaps();
    void received.refresh();
    // `received.refresh` is redefined on every render of useNostrFeed, so it is
    // deliberately not a dependency — depending on it would rebuild this
    // callback each render and defeat the point of having one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshZaps]);

  const sentVisible = useMemo(
    () => (sent.notes ? sent.notes.filter((n) => !mutedPubkeys.has(n.pubkey) && noteHasSubstance(n)) : null),
    [sent.notes, mutedPubkeys],
  );

  const receivedItems = useMemo<ReceivedItem[] | null>(() => {
    if (received.notes === null && zaps === null) return null;
    const notes = (received.notes ?? []).filter(
      (n) => !mutedPubkeys.has(n.pubkey) && noteHasSubstance(n),
    );
    // A Fountain-style boost is TWO events for ONE payment — a kind:9735 and a
    // kind:1 wrapper quoting it — and both can `p`-tag the recipient. Dropping
    // the receipt (not the note) keeps the richer card, which carries the
    // sender's profile, the podcast line and the reply thread.
    const quoted = quotedEventIds(received.notes ?? []);
    const items: ReceivedItem[] = notes.map((note) => ({
      kind: 'note' as const,
      ts: note.createdAt * 1000,
      key: `note:${note.id}`,
      note,
    }));
    for (const zap of zaps ?? []) {
      if (quoted.has(zap.id)) continue;
      items.push({ kind: 'zap' as const, ts: zap.createdAt * 1000, key: `zap:${zap.id}`, zap });
    }
    items.sort((a, b) => b.ts - a.ts);
    return items;
  }, [received.notes, zaps, mutedPubkeys]);

  // One resolver pass over both lists, so a show boosted in each direction is
  // looked up once. `NoteRefs` is the plain {podcastGuid, episodeGuids} shape,
  // which a zap receipt carries too (read off its embedded kind:9734).
  const metaRefs = useMemo<NoteRefs[] | null>(() => {
    if (!sentVisible && !receivedItems) return null;
    const refs: NoteRefs[] = (sentVisible ?? []).map((n) => n);
    for (const item of receivedItems ?? []) {
      refs.push(item.kind === 'note' ? item.note : item.zap);
    }
    return refs;
  }, [sentVisible, receivedItems]);
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

  const sentSats = (sentVisible ?? []).reduce((n, x) => n + Math.floor((x.amountMsat ?? 0) / 1000), 0);
  const receivedSats = (receivedItems ?? []).reduce(
    (n, i) => n + Math.floor(((i.kind === 'note' ? i.note.amountMsat : i.zap.msat) ?? 0) / 1000),
    0,
  );

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
            boostmebitch.com and carry no sender, so they cannot be listed. This is not a
            complete record of what this npub has paid.
          </p>
        }
        notes={sentVisible}
        loading={sent.loading}
        err={sent.err}
        emptyMessage="no boosts from this npub surfaced from these relays — see the note above."
        onRefresh={sent.refresh}
        itemKey={(n) => n.id}
        collapsibleKey="npub:sent"
        renderNote={(note) => <NoteCard note={note} {...metaFor(note)} />}
      />

      <FeedSection<ReceivedItem>
        heading={
          <h2 className="font-display text-2xl">
            <span className="text-nostr">#</span> Boosts received
          </h2>
        }
        description={
          <p className="text-xs text-muted leading-relaxed mb-3">
            Boosts and zaps that name this npub — through a feed&apos;s{' '}
            <code className="font-mono text-bone/70">&lt;podcast:txt purpose=&quot;nostr&quot;&gt;</code>{' '}
            tag, or a Nostr zap receipt
            {receivedItems && receivedItems.length > 0 && (
              <span className="text-bone/70">
                {' '}— {receivedItems.length} here, {receivedSats.toLocaleString()} sats
              </span>
            )}
            . Unlike the list above, this one does not depend on who signed the boost.
          </p>
        }
        notes={receivedItems}
        loading={received.loading || zaps === null}
        err={received.err}
        emptyMessage="no boosts to this npub surfaced from these relays."
        onRefresh={refreshReceived}
        itemKey={(item) => item.key}
        collapsibleKey="npub:recv"
        renderNote={(item) =>
          item.kind === 'note' ? (
            <NoteCard note={item.note} {...metaFor(item.note)} />
          ) : (
            <ZapReceiptCard zap={item.zap} {...metaFor(item.zap)} />
          )
        }
      />
    </div>
  );
}
