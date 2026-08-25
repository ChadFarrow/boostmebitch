// A minimal NIP-01 relay, in-process, for exercising the indexer wiring.
//
// CLAUDE.md's note about check:readtrust applies here too: the arithmetic and
// the predicates can be pinned pure, but "does a subscription actually deliver
// an event into the database" needs a relay to talk to. Relays on the public
// internet are the wrong thing to test against - they are slow, they rate
// limit, and they cannot be made to replay a deletion on command.
//
// Implements only what the indexer uses: REQ with kinds / authors / #tag
// filters and `until`+`limit` paging, EVENT, EOSE, CLOSE.
//
// It tracks live subscription ids per connection, which is not decoration: a
// client routes an incoming EVENT by the subscription id it names, and drops
// one it does not recognise. A mock that pushes under an invented id looks like
// a relay that delivers nothing.

import { WebSocketServer } from 'ws';

export async function startMockRelay(events = []) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const store = [...events];
  // ws -> Map<subId, filters[]>
  const subs = new Map();
  let delivered = 0;

  // `port: 0` means the OS picks one, and it is only knowable once the server
  // is listening. Await that here rather than making every caller remember to.
  await new Promise((resolve) => wss.once('listening', resolve));

  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('close', () => subs.delete(ws));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const [type, subId, ...filters] = msg;
      if (type === 'CLOSE') { subs.get(ws)?.delete(subId); return; }
      if (type !== 'REQ') return;

      subs.get(ws)?.set(subId, filters);
      for (const filter of filters) {
        const matched = store
          .filter((e) => matches(e, filter))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit ?? 500);
        for (const e of matched) {
          ws.send(JSON.stringify(['EVENT', subId, e]));
          delivered++;
        }
      }
      ws.send(JSON.stringify(['EOSE', subId]));
    });
  });

  return {
    url: () => `ws://127.0.0.1:${wss.address().port}`,
    /** Publish to every live subscription whose filter matches, the way a relay
     *  pushes a new event to the clients that asked for it. */
    push(event) {
      store.push(event);
      for (const [ws, bySub] of subs) {
        if (ws.readyState !== ws.OPEN) continue;
        for (const [subId, filters] of bySub) {
          if (!filters.some((f) => matches(event, f))) continue;
          ws.send(JSON.stringify(['EVENT', subId, event]));
          delivered++;
        }
      }
    },
    /** Push under EVERY live subscription regardless of its filter - a relay
     *  answering a question nobody asked. Used to prove the ingest kind check
     *  is a rule and not just a restatement of the subscription filter. */
    pushUnsolicited(event) {
      store.push(event);
      for (const [ws, bySub] of subs) {
        if (ws.readyState !== ws.OPEN) continue;
        for (const subId of bySub.keys()) {
          ws.send(JSON.stringify(['EVENT', subId, event]));
          delivered++;
        }
      }
    },
    delivered: () => delivered,
    close: () => new Promise((r) => wss.close(r)),
  };
}

function matches(event, filter) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (typeof filter.until === 'number' && event.created_at > filter.until) return false;
  if (typeof filter.since === 'number' && event.created_at < filter.since) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue;
    const name = key.slice(1);
    if (!event.tags.some((t) => t[0] === name && values.includes(t[1]))) return false;
  }
  return true;
}
