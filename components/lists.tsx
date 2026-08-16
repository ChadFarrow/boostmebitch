'use client';

// Barrel for the list panels.
//
// This file used to BE all of them — 1173 lines holding four exported
// components, fifteen private helpers and two hooks. It is now a re-export
// surface only, deliberately: `components/home-page.tsx` is the single consumer
// of the four list components and several surfaces import the fav hearts from
// here, so keeping the barrel means the split cost zero call-site edits and the
// diff stays a pure move.
//
// The hearts live in ./fav-heart, NOT in any of the files below, and are
// re-exported here for the same reason they were moved out originally: several
// surfaces render them (lists, fullscreen player, podroll, episode detail), and
// having podroll import from lists while lists imports <Podroll> was a module
// cycle.

export { FavEpisodeHeart, FavEpisodeRowHeart, FavHeart } from './fav-heart';

export { PodcastResults } from './lists/podcast-results';
export { FavoritesList, FavoriteEpisodesList } from './lists/favorites';
export { EpisodeList } from './lists/episode-list';
