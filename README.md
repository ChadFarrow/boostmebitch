# Boost Me Bitch / Boost Me Buddy playlists

Every playlist that listeners made on Boost Me Bitch or Boost Me Buddy, test
playlists included. This branch holds only these files. A GitHub Action
(`.github/workflows/playlist-archive.yml` on `main`) copies them from the
live site when a playlist is published, edited or deleted, and every 15 minutes.

- `playlists/<id>.xml` is the playlist's Podcasting 2.0 feed (`musicL`), exactly
  as the site serves it. Each song is a `<podcast:remoteItem>` that names the
  song's own feed. The playlist takes no payment: a boost pays the song's artist.
- `playlists/index.json` lists every copy: title, `podcast:guid`, feed address,
  song count and the time it last changed.

To use a playlist in a podcast app, subscribe to its `feedUrl`. To use one as a
test playlist, read the `.xml` file here. A deleted playlist leaves this branch;
its old copy stays in the history.
