// A stand-in for the site's own Lightning address, which note stamps are paid
// to, for `e2e:sitestamp`. It answers the three requests `lib/stamp-address.ts`
// makes, in the shapes hello@getalby.com answered them on 2026-11-17:
//
//   GET /.well-known/lnurlp/<name>
//        → { status: 'OK', tag: 'payRequest', callback, minSendable, maxSendable, metadata, commentAllowed }
//   GET /lnurlp/<name>/callback?amount=<msat>[&comment=…]
//        → { status: 'OK', pr, verify, routes: [], successAction }
//   GET /lnurlp/<name>/verify/<id>
//        → { status: 'OK', settled, preimage, pr }  ·  404 { status: 'ERROR', reason: 'Not found' }
//
// Nothing here moves money. An invoice is "paid" when the test says so
// (`markPaid`), which is what a wallet stand-in calls when the page pays.
//
// `mode` turns on the failures the e2e drives:
//   mint: 'ok' | 'fail' (an ERROR answer) | 'hang' (never answers)
//         | 'overcharge' (an invoice for twice the asked amount)
//         | 'noverify' (no LUD-21 verify link)
//   lookup: 'ok' | 'hang'

import http from 'node:http';
import { randomBytes } from 'node:crypto';

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const bech32ish = (n) => Array.from(randomBytes(n), (b) => BECH32[b % 32]).join('');

export function createFakeStampAddress({ port = 0, name = 'stamp' }) {
  const byId = new Map();
  const byBolt11 = new Map();
  const minted = [];
  const lookups = [];
  const mode = { mint: 'ok', lookup: 'ok' };
  const hung = new Set();
  const sockets = new Set();
  let origin = '';

  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, origin);
    if (req.method !== 'GET') return send(405, { status: 'ERROR', reason: 'GET only' });

    if (url.pathname === `/.well-known/lnurlp/${name}`) {
      return send(200, {
        status: 'OK', tag: 'payRequest', commentAllowed: 255,
        callback: `${origin}/lnurlp/${name}/callback`,
        metadata: JSON.stringify([['text/identifier', `${name}@127.0.0.1`], ['text/plain', 'e2e note stamps']]),
        minSendable: 1000, maxSendable: 10_000_000_000,
      });
    }

    if (url.pathname === `/lnurlp/${name}/callback`) {
      if (mode.mint === 'hang') { hung.add(res); return undefined; }
      if (mode.mint === 'fail') return send(200, { status: 'ERROR', reason: 'e2e: the node is offline' });
      const msat = Number(url.searchParams.get('amount'));
      if (!Number.isInteger(msat) || msat < 1000) return send(200, { status: 'ERROR', reason: 'amount out of range' });
      const sats = (mode.mint === 'overcharge' ? 2 : 1) * Math.round(msat / 1000);
      const id = bech32ish(24);
      const bolt11 = `lnbc${sats * 10}n1p${bech32ish(180)}`;
      const invoice = { id, bolt11, amount: sats * 1000, comment: url.searchParams.get('comment'), paid: false, preimage: randomBytes(32).toString('hex') };
      const verify = `${origin}/lnurlp/${name}/verify/${id}`;
      byId.set(id, invoice);
      byBolt11.set(bolt11, invoice);
      minted.push({ bolt11, amount: invoice.amount, comment: invoice.comment, verify });
      return send(200, {
        status: 'OK', pr: bolt11, routes: [],
        successAction: { tag: 'message', message: 'Thanks, sats received!' },
        ...(mode.mint === 'noverify' ? {} : { verify }),
      });
    }

    const m = new RegExp(`^/lnurlp/${name}/verify/([a-z0-9]+)$`).exec(url.pathname);
    if (m) {
      lookups.push(m[1]);
      if (mode.lookup === 'hang') { hung.add(res); return undefined; }
      const inv = byId.get(m[1]);
      if (!inv) return send(404, { status: 'ERROR', reason: 'Not found' });
      return send(200, { status: 'OK', settled: inv.paid, preimage: inv.paid ? inv.preimage : null, pr: inv.bolt11 });
    }
    return send(404, { status: 'ERROR', reason: 'Not found' });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      origin = `http://127.0.0.1:${p}`;
      resolve(p);
    });
  });

  return {
    ready,
    /** The value the server's SITE_STAMP_LNADDRESS must hold. */
    get address() { return `${name}@127.0.0.1:${server.address()?.port ?? port}`; },
    minted,
    lookups,
    mode,
    /** The page "paid" this invoice. False when the fake never minted it. */
    markPaid(bolt11) {
      const inv = byBolt11.get(bolt11);
      if (!inv) return false;
      inv.paid = true;
      return true;
    },
    reset() {
      mode.mint = 'ok';
      mode.lookup = 'ok';
      for (const r of hung) r.destroy();
      hung.clear();
    },
    close() {
      for (const r of hung) r.destroy();
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
