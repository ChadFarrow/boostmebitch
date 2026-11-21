/**
 * The shows that get an IRC chat beside their live stream, and the gateway
 * switch (docs/irc.md).
 *
 * AN OPT-IN LIST, NOT "EVERY FEED WITH A CHAT TAG". Chad, 2026-11-21: "if I'm
 * using my own IRC, I don't know if I want to use this for every show." The
 * chat goes through his gateway, so a show is on it because he chose it. The
 * feed's `<podcast:chat>` is not read: every show here has its channel in this
 * list already, and MMO names its channel only in a non-spec attribute.
 *
 * Only shows with a `<podcast:liveItem>`: without one the app cannot tell when
 * the show is live ("this is meant to be a live chat"). That is why Nick the
 * Rat Radio (`#SewerChat`) is not here.
 *
 * Keyed by the feed's `podcastGuid`, lower case. Every channel is on
 * `irc.zeronode.net`; a ZeroNode LIST showed each one on 2026-11-21, and none
 * needs an account to join or talk. A new show is one line here.
 *
 * AN IMPORT-FREE LEAF: `check:irc` loads it under plain Node.
 */
export const IRC_CHAT_SHOWS: Readonly<Record<string, { title: string; channel: string }>> = {
  'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f': { title: 'Homegrown Hits', channel: '#HomegrownHits' },
  '917393e3-1b1e-5cef-ace4-edaa54e1f810': { title: 'Podcasting 2.0', channel: '#Podcasting20' },
  'e0ac9365-689c-5043-8804-15b9dfcc545a': { title: 'Behind the SchƎmƎs', channel: '#greenroom' },
  '31740861-81e8-5dda-8801-a2abb2634271': { title: 'MMO', channel: '#MMO' },
  '7c6f7875-2b73-491e-b32c-e2c8d6e91d53': { title: 'Chad and Reeds', channel: '#candr' },
  'd5e73072-64a2-56a3-9dcd-4a00bfe561d5': { title: 'Lightning Thrashes', channel: '#SirLibre' },
  'c1959795-28f1-502d-ad3e-70abf5a034a9': { title: 'the v4vmusic Show', channel: '#v4vmusicShow' },
  '45b899bb-cbef-57b5-ab14-04aaf49e3ac3': { title: "RevDoc's Revival", channel: '#VoidZero' },
  'c42a0900-c20e-59a2-a13b-c23b5c04e11f': { title: 'Hyper SpaceOut', channel: '#HyperSpaceOut' },
  '2d418249-453a-5714-8abc-5b657570b641': { title: 'Bowl After Bowl', channel: '#BowlAfterBowl' },
  '41aace28-8679-5ef1-9958-75cf76c2b5f0': { title: 'Into The Doerfel-Verse', channel: '#DoerfelVerse' },
  '89bf141a-f4cf-575c-b09a-75dbce16332c': { title: 'Accidentally Interesting', channel: '#OffTopic' },
};

/** The show's channel, or null when the show is not on the list. */
export function ircChannelFor(podcastGuid: string | null | undefined): string | null {
  if (!podcastGuid) return null;
  return IRC_CHAT_SHOWS[podcastGuid.toLowerCase()]?.channel ?? null;
}

/**
 * Whether `NEXT_PUBLIC_IRC_GATEWAY_URL` names a gateway the panel may open.
 * `wss:` anywhere; plain `ws:` only to this machine (the e2e's fake server),
 * because a listener's messages must not cross the internet unencrypted.
 * Anything else — unset included — means no chat on any show.
 */
export function ircGatewayOk(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (!u.hostname) return false;
  if (u.protocol === 'wss:') return true;
  return u.protocol === 'ws:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
}
