// Temporary Split Kit channel capture — logs every remoteValue with a timestamp,
// what parseLiveBlock makes of it, and the bucket key the engine would derive.
// Not part of the repo; delete after use.
import { io } from 'socket.io-client';
import { parseLiveBlock } from './lib/v4v/live-block.ts';
import { trackBucket } from './lib/v4v/stream-ledger.ts';

const URI = process.argv[2];
const MINS = Number(process.argv[3] || 60);
const stamp = () => new Date().toISOString().slice(11, 19);

console.log(`[${stamp()}] connecting: ${URI}`);
const s = io(URI, { transports: ['websocket', 'polling'], reconnectionDelayMax: 30_000 });

s.on('connect', () => console.log(`[${stamp()}] CONNECTED id=${s.id}`));
s.on('connect_error', (e) => console.log(`[${stamp()}] connect_error: ${e?.message ?? e}`));
s.on('disconnect', (r) => console.log(`[${stamp()}] disconnected: ${r}`));

let n = 0;
let lastKey = null;
s.onAny((event, ...args) => {
  if (event !== 'remoteValue') return;
  n += 1;
  const b = parseLiveBlock(args[0]);
  if (!b) {
    if (lastKey !== '(default)') console.log(`[${stamp()}] #${n} => default block / no payee`);
    lastKey = '(default)';
    return;
  }
  const split = b.feedGuid ? { remoteItem: { feedGuid: b.feedGuid, itemGuid: b.itemGuid } } : {};
  const key = trackBucket(split, `sk:${b.blockGuid ?? 'nohash'}`);
  if (key === lastKey) return;          // heartbeat of the same block
  lastKey = key;
  console.log(`\n[${stamp()}] #${n} BLOCK CHANGE`);
  console.log(JSON.stringify({
    title: b.title,
    type: b.type,
    blockGuid: b.blockGuid,
    bucketKey: key,
    recipients: b.value.recipients.map((r) => `${r.type} ${r.split} ${r.address.slice(0, 12)}…`),
  }, null, 2));
});

setTimeout(() => { console.log(`\n[${stamp()}] window closed after ${MINS}m`); s.disconnect(); process.exit(0); }, MINS * 60_000);
