'use client';
import { fmtDate, fmtDuration } from '@/lib/format';
import type { Episode, Podcast } from '@/lib/types';
import { PodcastCover } from './podcast-cover';
import { FavEpisodeHeart } from './fav-heart';

/**
 * The episode a note is *about*, unfurled under the note's own words.
 *
 * A note that links an episode used to render as a 16px thumbnail beside one
 * truncating line of 11px grey text, with the raw URL repeated underneath in
 * magenta. Every fact was already on screen and none of it read as an episode
 * you could do anything with. This is that same data, drawn as the thing it is.
 *
 * **It is deliberately not shown for every podcast-tagged note.** 171 of 243
 * cards on the live global feed carry NIP-73 podcast tags, so unfurling all of
 * them turns the feed into a wall of artwork and pushes each author's actual
 * sentence below the fold. The discriminator is `episodeLinkInNote`
 * (`lib/util.ts`): the note put a link to this episode in its own text, which is
 * the author saying "this is what I am pointing at". Everything else keeps the
 * one-line label.
 *
 * ── It POINTS at the episode. It does not play or pay for one ───────────────
 *
 * One control: the favorite heart. The card BODY is the tap target, the show
 * name is a second target inside it, and the outbound link is an 11px footnote
 * on the meta line.
 *
 * It shipped with PLAY, OPEN, ♡ and BOOST, which at 390px wrapped into a ragged
 * 2 / 2 / 1 block with the host link stranded on a line of its own. PLAY and
 * BOOST went first: OPEN reached an episode page that already carries a
 * full-size copy of both, so the card was offering a second, smaller pair one
 * tap earlier. OPEN then went too, because the headline beside it is a button
 * with the same handler — one destination does not need two controls.
 *
 * **A spending or playing control put back here CANNOT use the `episode`
 * prop.** That is Podcast Index's *indexed* record, resolved from the note's
 * guids by `useNoteMeta`: good enough for a title, a date and a cover, and not
 * good enough to play or to boost. Only `/api/feed` applies the
 * `e.value ?? podcast.value` channel fallback, so the PI record routinely
 * carries no value block at all, and a boost modal opened with it lists no
 * recipients — a payment surface that cannot pay, which reads as our bug and is
 * really a missing fetch. The removed version fetched the real episode through
 * `loadEpisodeFromFeed` first and kept both controls DISABLED until it
 * answered, because a control that spends money must not be pressable while the
 * thing it would spend on is still resolving. Any replacement inherits that.
 *
 * The heart is exempt and always was: a favorite is the two guids plus a label,
 * all of which the indexed record already carries.
 *
 * ── The outbound link is DEMOTED, never deleted ──────────────────────────────
 *
 * `host ↗` points at somebody else's app on our card, so it earns a footnote
 * rather than a button. It cannot be removed, and that is not a taste question:
 * `<NoteCard>` calls `removeUrl` and takes the author's raw URL OUT of the
 * note's text whenever this card unfurls, because the card restates it. Delete
 * the link here and the author's own link is gone from their note with nothing
 * on screen recording that they wrote one. **That is why the meta line is not
 * gated on `item`** — the link lives in it, and the show-only variant below is
 * the card that needs it most.
 *
 * Both destinations are handed down rather than re-implemented: `<NoteCard>`
 * owns the open sequence (select the show first, then load the real episode,
 * then open it) and its ordering constraints are written up there.
 *
 * ── `episode` is OPTIONAL, and that is the whole reason this card gets drawn ──
 *
 * The card used to require Podcast Index to have resolved the item as well as
 * the show, so a note that plainly pointed at a Fountain episode kept the raw
 * magenta URL whenever PI had the feed and not the item — which is ordinary, not
 * exotic: PI answers "not found" for a `<podcast:liveItem>`, for an item it has
 * not crawled yet, and for every note that tags more than one item guid (a
 * boost-all across an album), where `episodeRefOf` never asks in the first
 * place. The reported symptom was three lines of magenta URL under a note whose
 * show had resolved fine, one card below another note that unfurled correctly.
 *
 * **What the card claims is what it was handed.** With no item record it names
 * the SHOW — show art, the show's author over the show's title, no date, no
 * duration, no heart, and therefore no action row at all — and keeps the
 * `host ↗` footnote, which is the exact page the author linked. That is the same pair of facts the one-line label states, minus
 * the wall of magenta, which is what this component exists to remove. It does
 * NOT invent an episode: an unresolved item has no title, so nothing here
 * renders one.
 *
 * The gate that stays is `podcast`: with neither half resolved there is no art
 * and no title, so there is no card to draw and the note keeps its plain link.
 */
export function NoteEpisodeCard({
  podcast,
  episode,
  href,
  onOpenShow,
  onOpenEpisode,
}: {
  podcast: Podcast;
  /** PI's indexed item record, or null when PI could not name one. */
  episode?: Episode | null;
  /**
   * The URL the note itself used to point at this episode, when that URL goes
   * somewhere this app is not.
   *
   * **Absent for a boost note THIS APP published**, whose only links are a
   * listen link and a deep link back here. A footnote reading
   * `boostmebitch.com ↗` under a card on boostmebitch.com points at the page
   * the reader is already on, and the argument for keeping it does not apply:
   * the link is not something an author wrote and `<NoteCard>` hid, it is
   * something we wrote and the card restates.
   */
  href?: string | null;
  /**
   * Two destinations, not one. The show name and the episode title are
   * different places, exactly as they are in the one-line label this card
   * replaces — collapsing them onto a single handler would quietly delete the
   * only route to the show from a note about one of its episodes.
   *
   * They collapse to one only when there IS one: with no `episode`, every
   * control on the card opens the show, because the show is all we resolved.
   */
  onOpenShow: () => void;
  onOpenEpisode?: () => void;
}) {
  const host = href ? hostOf(href) : null;
  // ONE test, resolved once into the record and the handler together, so the
  // two cannot disagree: an item with no guid is not openable and not
  // favoritable, and `<NoteCard>` already declines to build a handler for one.
  // Read apart, a later edit gets a card headlined with an episode whose OPEN
  // goes to the show, which reads as a broken link rather than missing data.
  const openable = episode?.guid && onOpenEpisode ? { item: episode, open: onOpenEpisode } : null;
  const item = openable?.item ?? null;
  const openItem = openable?.open ?? onOpenShow;
  // The same "resolve it once" rule one line down. <FavEpisodeHeart> returns
  // null without an item guid AND a feed guid, and the heart is now the only
  // thing in the action row — so asking separately gives an empty box with
  // `pb-2.5` of padding under a show-only card, which reads as a control that
  // failed to draw. This mirrors the heart's own guard exactly; if that guard
  // changes, this moves with it.
  const favoritable = !!item?.guid && !!(item.podcastGuid || podcast.podcastGuid);

  return (
    <div className="mt-2 border border-line rounded bg-ink/40 overflow-hidden">
      {/* THE BODY IS THE TAP TARGET, and it is deliberately a plain `div`.
          `role="button"` + `tabIndex` would need a key handler to actually be
          one (see <Player>'s note on the same trade) and would nest the buttons
          below inside a button role. It does not need to be focusable, because
          the headline under it is a real <button> carrying this same handler —
          the tap area is an ADDITION to that control, never a replacement, so a
          keyboard reaches everything it always did. Same shape as
          <EpisodeList>'s row, whose inner controls stop propagation rather than
          the row giving up its handler.

          `openItem`, not `onOpenEpisode`: with no item resolved every control
          on this card opens the SHOW, and the tap area is not the exception. */}
      <div
        className="flex gap-3 p-2.5 cursor-pointer transition hover:bg-bone/5"
        onClick={openItem}
      >
        {/* Always both URLs — PI mirrors RSS <image> as `image` and
            <itunes:image> as `artwork` and they routinely disagree. The
            episode's own art wins when it has any, which for a music feed is
            the track cover rather than the album's. */}
        <PodcastCover
          image={item?.image || podcast.image}
          artwork={podcast.artwork}
          title={item?.title ?? podcast.title}
          seed={item?.guid ?? podcast.podcastGuid ?? String(podcast.id)}
          className="w-16 h-16 sm:w-20 sm:h-20 object-cover border border-bone/20 flex-shrink-0"
          lowPriority
        />
        <div className="min-w-0 flex-1">
          {/* `min-h-[24px]` is WCAG 2.5.8 and it is here because this control
              failed it. At `text-[10px]` the line box is 15px, so the button
              looked finished and was 9px short — the violation a review cannot
              see, because nothing about the rendering is wrong. Measured at
              390px under CDP device emulation; a narrow window would have
              reported the desktop layout cropped and told us nothing.

              With no item the show has moved DOWN into the headline, so this
              slot carries the show's author instead — as text, never a button:
              an author is not a destination this app can open, and a control
              that goes nowhere is worse than no control. */}
          {item ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenShow(); }}
              className="flex items-center min-h-[24px] text-left text-[10px] tracking-wider uppercase text-muted hover:text-bolt max-w-full"
              title={podcast.title}
            >
              <span className="truncate">{podcast.title}</span>
            </button>
          ) : podcast.author ? (
            <div
              className="flex items-center min-h-[24px] text-[10px] tracking-wider uppercase text-muted max-w-full"
              title={podcast.author}
            >
              <span className="truncate">{podcast.author}</span>
            </div>
          ) : null}
          {/* Kept a real button even though the area around it now carries the
              same handler: that is what makes this reachable by keyboard.
              `stopPropagation` so one press is one navigation. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); openItem(); }}
            className="block text-left font-display text-sm text-bone hover:text-bolt leading-snug line-clamp-2"
            title={item?.title ?? podcast.title}
          >
            {item?.title ?? podcast.title}
          </button>
          {/* THIS ROW IS NO LONGER OPTIONAL, because the outbound link lives in
              it now. With no item it carries the link alone; the date and the
              duration are what drop, not the box. Gating the whole row on
              `item` — which is what it did while the link was a button below —
              would delete the link from exactly the card that needs it most:
              the show-only variant exists because PI could not name the item,
              and the author's page is then the only place the reader can go. */}
          {/* Rendered when it has something to say, which is not the same as
              "when there is an item": the outbound link lives here, so gating
              on `item` deletes it from the show-only variant. With neither — a
              show-only card on a note we published ourselves — there is no row,
              because `mt-0.5` around nothing is still vertical space. */}
          {item?.datePublished || item?.duration || href ? (
          <div className="text-[11px] text-muted mt-0.5 flex items-center gap-1.5 flex-wrap">
            {item?.datePublished ? <span>{fmtDate(item.datePublished)}</span> : null}
            {item?.duration ? (
              <>
                {item.datePublished ? <span aria-hidden>·</span> : null}
                <span>{fmtDuration(item.duration)}</span>
              </>
            ) : null}
            {/* NO `·` before this one, unlike the pair above. The row wraps at
                390px and a separator is its own flex item, so the dot stayed
                behind on the date line while the link went to the next —
                trailing punctuation pointing at nothing. `ml-1` buys the
                spacing the dot was there for, in a way a wrap cannot strand,
                and it is also the right amount when the link is alone. */}
            {/* A FOOTNOTE, NOT AN ACTION. It was a .btn-ghost the same size and
                weight as our own control, which is a lot of a card spent
                pointing at another app. It is still here, and deleting it is
                not the tidier version: <NoteCard> takes the author's raw URL
                OUT of the note's text when this card unfurls (`removeUrl`), on
                the grounds that the card restates it. Remove this and the link
                the author wrote is gone from their note, with nothing on screen
                recording that they wrote one.

                `min-h-[24px]` is WCAG 2.5.8 and it is not decoration: the
                exemption is for a link set inside a sentence, and this is a
                standalone one. At `text-[11px]` the line box is ~16px, the same
                shortfall the show line above was fixed for.

                `stopPropagation` because the tap area around it navigates:
                without it one press opens the third-party tab AND moves this
                app underneath it. */}
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center min-h-[24px] ml-1 hover:text-bone hover:underline underline-offset-2"
                title={href}
              >
                {host} ↗
              </a>
            ) : null}
          </div>
          ) : null}
        </div>
      </div>

      {/* One control, so no flex row and nothing to wrap. `size="md"` is the
          variant dimensioned to .btn-ghost; 'sm' is the LIST-ROW chip, which
          drops the word FAVORITE below sm: and would leave this card's only
          action as a bare glyph. With no item there is no episode favorite to
          offer — only a SHOW favorite, which is a different subject and belongs
          to the show page — so the row goes rather than emptying. The heart
          stops propagation itself, and it also sits OUTSIDE the tap area above
          rather than relying on that. */}
      {favoritable && item ? (
        <div className="px-2.5 pb-2.5">
          <FavEpisodeHeart episode={item} podcast={podcast} size="md" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The link's host, for the outbound button's label — "fountain.fm ↗" rather
 * than a second copy of the full URL, which is the thing this card exists to
 * get out of the note body. `www.` goes because it is never the part a reader
 * is identifying the destination by.
 */
function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return 'open';
  }
}
