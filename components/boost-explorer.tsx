'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  fetchBoostsReceivedBy,
  fetchBoostsSentBy,
  fetchProfile,
  noteHasSubstance,
  shortNpub,
  useNostrFeed,
  type DiscoveredNote,
} from '@/lib/nostr';
import type { ProfileMetadata } from '@/lib/nostr/auth';
import { useApp } from '@/lib/store';
import { useNoteMeta, episodeRefOf, type NoteRefs } from '@/lib/use-note-meta';
import { Avatar } from './avatar';
import { CopyLinkButton } from './copy-link-button';
import { FeedSection } from './feed-section';
import { NoteCard } from './nostr-note-card';

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
 *    It is still a list of **boost NOTES**, not of payments. Bare NIP-57 zap
 *    receipts (kind:9735) are deliberately not read: this is a boostagram
 *    surface, and a receipt is a different object with a different sender and a
 *    different provenance. The overlap is smaller than it looks — a
 *    Fountain-style boost posts a kind:1 wrapper that quotes its own receipt,
 *    and that wrapper still appears here with its amount adopted off the quoted
 *    receipt (`buildNote`). What is not shown is a zap that produced no note at
 *    all. `lib/nostr/zap-receipt.ts` therefore stays: `buildNote` reads amounts
 *    through it and `<LiveChat>` still renders receipts.
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

  // One resolver pass over both lists, so a show boosted in each direction is
  // looked up once.
  const metaRefs = useMemo<NoteRefs[] | null>(() => {
    if (!sentVisible && !receivedVisible) return null;
    return [...(sentVisible ?? []), ...(receivedVisible ?? [])];
  }, [sentVisible, receivedVisible]);
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
  const receivedSats = (receivedVisible ?? []).reduce(
    (n, x) => n + Math.floor((x.amountMsat ?? 0) / 1000), 0);

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
                {' '}— {receivedVisible.length} here, {receivedSats.toLocaleString()} sats
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
        renderNote={(note) => <NoteCard note={note} {...metaFor(note)} />}
      />
    </div>
  );
}
